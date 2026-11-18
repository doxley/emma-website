// POST /api/book
// Body: { sourceId, idempotencyKey, variationId, startAt, givenName, familyName, email, phone, note, code }
//
// `code` is an optional gift voucher (HSE-XXXX-XXXX) or discount code. A voucher covers the whole
// treatment, so no card is needed: the voucher is reserved before booking and released if booking fails.
//
// Order of operations keeps the client from being charged without an appointment:
//   1. check the slot is still free
//   2. find or create the customer in Square
//   3. AUTHORISE the card (autocomplete: false) — money is held, not taken
//   4. create the booking in Emma's Square Appointments calendar
//   5. COMPLETE the payment; if the booking failed, CANCEL the hold instead
import {
  getBusiness, searchAvailability, sq, send, readJson, ukPhoneToE164, londonLong, londonTime, londonDate, SquareError,
} from "./_square.js";
import { signBooking } from "./_manage.js";
import { allowedStart, priceFor } from "./_rules.js";
import { priceWithCode, markVoucher } from "./_vouchers.js";

const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Invalid request." }); }

  const sourceId = clean(body.sourceId, 500);
  const key = clean(body.idempotencyKey, 36);
  const givenName = clean(body.givenName, 60);
  const familyName = clean(body.familyName, 60);
  const email = clean(body.email, 120).toLowerCase();
  const phone = ukPhoneToE164(body.phone);
  const note = clean(body.note, 1000);
  const startAt = clean(body.startAt, 40);

  if (!/^[\w-]{8,36}$/.test(key)) return send(res, 400, { error: "Something went wrong. Please refresh the page and try again." });
  if (!givenName || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: "Please add your name and a valid email address." });
  if (Number.isNaN(Date.parse(startAt))) return send(res, 400, { error: "Please choose a time." });

  let paymentId = null, voucher = null;
  try {
    const { locationId, services } = await getBusiness();
    const service = services.find((s) => s.variationId === body.variationId);
    if (!service) return send(res, 400, { error: "That treatment isn't available to book online." });
    const base = priceFor(service);
    const coded = await priceWithCode({ service, base: base.amount, code: body.code, locationId });
    if (coded.error) return send(res, 400, { error: coded.error, code: "BAD_CODE" });
    const price = { amount: coded.amount, currency: base.currency || service.currency };
    if (price.amount > 0 && !sourceId) return send(res, 400, { error: "Payment details are missing. Please try again." });

    // 1. Slot still free?
    const start = new Date(startAt);
    const slots = await searchAvailability({
      service, locationId,
      startAt: new Date(start.getTime() - 12 * 3600e3).toISOString(),
      endAt: new Date(start.getTime() + 12 * 3600e3).toISOString(),
    });
    const slot = slots.find((a) => Date.parse(a.start_at) === start.getTime());
    if (!slot) return send(res, 409, { error: "Sorry, that time has just been taken. Please choose another.", code: "SLOT_TAKEN" });
    if (londonDate(start) === londonDate(new Date())) return send(res, 409, { error: "For appointments today, please call 0114 470 4565." });
    if (!allowedStart(service, slot.start_at)) return send(res, 409, { error: "That time isn't available to book online. Please choose another.", code: "SLOT_TAKEN" });
    const segment = slot.appointment_segments?.[0] || {};

    // 2. Customer
    let customerId;
    const found = await sq("/v2/customers/search", {
      method: "POST",
      body: { query: { filter: { email_address: { exact: email } } }, limit: 1 },
    });
    if (found.customers?.length) {
      customerId = found.customers[0].id;
    } else {
      const created = await sq("/v2/customers", {
        method: "POST",
        body: {
          idempotency_key: `${key}-cust`,
          given_name: givenName,
          family_name: familyName || undefined,
          email_address: email,
          phone_number: phone || undefined,
          note: "Created by online booking",
        },
      });
      customerId = created.customer.id;
    }

    // 3. Authorise payment (price always comes from Square's catalog, never the browser),
    //    or reserve the gift voucher so nobody else can use it at the same moment.
    const when = `${londonLong(start)}, ${londonTime(start)}`;
    if (coded.kind === "voucher") {
      try {
        voucher = await markVoucher(coded.voucher, `pending:${Date.now()}`, { key: `${key}-vres` });
      } catch {
        return send(res, 409, { error: "That voucher has just been used. Please check your code.", code: "BAD_CODE" });
      }
    }
    const codeNote = coded.kind === "voucher" ? `Paid with gift voucher ${coded.code}` : coded.kind === "discount" ? `Discount code ${coded.code} (−£${(coded.saving / 100).toFixed(2)})` : "";
    const payment = price.amount <= 0 ? null : await sq("/v2/payments", {
      method: "POST",
      body: {
        idempotency_key: `${key}-pay`,
        source_id: sourceId,
        amount_money: { amount: price.amount, currency: price.currency },
        autocomplete: false,
        location_id: locationId,
        customer_id: customerId,
        buyer_email_address: email,
        note: `${service.name} – ${when}${codeNote ? ` – ${codeNote}` : ""}`.slice(0, 500),
      },
    });
    paymentId = payment?.payment.id || null;

    // 4. Booking
    let booking;
    try {
      const made = await sq("/v2/bookings", {
        method: "POST",
        body: {
          idempotency_key: `${key}-book`,
          booking: {
            start_at: slot.start_at,
            location_id: locationId,
            customer_id: customerId,
            customer_note: [note, codeNote].filter(Boolean).join("\n\n").slice(0, 4096) || undefined,
            appointment_segments: [
              {
                duration_minutes: segment.duration_minutes || service.minutes,
                service_variation_id: service.variationId,
                service_variation_version: segment.service_variation_version || service.version,
                team_member_id: segment.team_member_id || service.teamMemberIds[0],
              },
            ],
          },
        },
      });
      booking = made.booking;
    } catch (err) {
      if (paymentId) await sq(`/v2/payments/${paymentId}/cancel`, { method: "POST" }).catch((e) => console.error("Cancel failed", e));
      paymentId = null;
      if (voucher) { await markVoucher(voucher, "released", { key: `${key}-vrel` }).catch((e) => console.error("Voucher release failed", e)); voucher = null; }
      if (err.status === 409 || err.code === "BAD_REQUEST" || err.code === "CONFLICT") {
        return send(res, 409, { error: "Sorry, that time has just been taken. You haven't been charged. Please choose another time.", code: "SLOT_TAKEN" });
      }
      throw err;
    }

    // 5. Take the money (or mark the voucher as used)
    let receiptUrl = null;
    if (voucher) {
      await markVoucher(voucher, booking.id, { complete: true, key: `${key}-vuse` }).catch((e) => console.error("Voucher mark-used failed (booking stands)", e));
      voucher = null;
    }
    if (paymentId) try {
      const done = await sq(`/v2/payments/${paymentId}/complete`, { method: "POST", body: {} });
      receiptUrl = done.payment?.receipt_url || null;
    } catch (err) {
      // Booking exists but payment couldn't be captured: undo both so nothing is left half-done.
      await sq(`/v2/bookings/${booking.id}/cancel`, { method: "POST", body: { booking_version: booking.version } }).catch(() => {});
      await sq(`/v2/payments/${paymentId}/cancel`, { method: "POST" }).catch(() => {});
      return send(res, 402, { error: "Your payment couldn't be completed, so the booking wasn't made. You haven't been charged." });
    }

    return send(res, 200, {
      bookingId: booking.id,
      manageToken: signBooking(booking.id),
      service: service.name,
      when,
      amount: price.amount,
      currency: service.currency,
      codeKind: coded.kind,
      codeLabel: coded.label || null,
      email,
      receiptUrl,
    });
  } catch (err) {
    console.error(err);
    if (paymentId) await sq(`/v2/payments/${paymentId}/cancel`, { method: "POST" }).catch(() => {});
    if (voucher) await markVoucher(voucher, "released", { key: `${body.idempotencyKey}-vrel2` }).catch(() => {});
    if (err instanceof SquareError) {
      const cardCodes = ["CARD_DECLINED", "CVV_FAILURE", "ADDRESS_VERIFICATION_FAILURE", "INVALID_EXPIRATION", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS", "CARD_DECLINED_VERIFICATION_REQUIRED", "INVALID_CARD"];
      if (cardCodes.includes(err.code)) {
        return send(res, 402, { error: "Your card was declined. Please check the details or try another card. You haven't been charged." });
      }
    }
    return send(res, 500, { error: "Something went wrong and the booking wasn't made. You haven't been charged. Please try again or call 0114 470 4565." });
  }
}
