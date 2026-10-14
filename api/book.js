// POST /api/book
// Body: { sourceId, idempotencyKey, variationId, startAt, givenName, familyName, email, phone, note }
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

  if (!sourceId || !/^[\w-]{8,36}$/.test(key)) return send(res, 400, { error: "Payment details are missing. Please try again." });
  if (!givenName || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: "Please add your name and a valid email address." });
  if (Number.isNaN(Date.parse(startAt))) return send(res, 400, { error: "Please choose a time." });

  let paymentId = null;
  try {
    const { locationId, services } = await getBusiness();
    const service = services.find((s) => s.variationId === body.variationId);
    if (!service) return send(res, 400, { error: "That treatment isn't available to book online." });

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
    const [yy, mm, dd] = londonDate(start).split("-").map(Number);
    const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
    if (!(/online/i.test(service.name) ? [2] : [3, 4, 5]).includes(dow)) return send(res, 409, { error: "That treatment isn't available on that day. Please choose another time.", code: "SLOT_TAKEN" });
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

    // 3. Authorise payment (price always comes from Square's catalog, never the browser)
    const when = `${londonLong(start)}, ${londonTime(start)}`;
    const payment = await sq("/v2/payments", {
      method: "POST",
      body: {
        idempotency_key: `${key}-pay`,
        source_id: sourceId,
        amount_money: { amount: service.amount, currency: service.currency },
        autocomplete: false,
        location_id: locationId,
        customer_id: customerId,
        buyer_email_address: email,
        note: `${service.name} – ${when}`.slice(0, 500),
      },
    });
    paymentId = payment.payment.id;

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
            customer_note: note || undefined,
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
      await sq(`/v2/payments/${paymentId}/cancel`, { method: "POST" }).catch((e) => console.error("Cancel failed", e));
      paymentId = null;
      if (err.status === 409 || err.code === "BAD_REQUEST" || err.code === "CONFLICT") {
        return send(res, 409, { error: "Sorry, that time has just been taken. You haven't been charged. Please choose another time.", code: "SLOT_TAKEN" });
      }
      throw err;
    }

    // 5. Take the money
    let receiptUrl = null;
    try {
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
      service: service.name,
      when,
      amount: service.amount,
      currency: service.currency,
      email,
      receiptUrl,
    });
  } catch (err) {
    console.error(err);
    if (paymentId) await sq(`/v2/payments/${paymentId}/cancel`, { method: "POST" }).catch(() => {});
    if (err instanceof SquareError) {
      const cardCodes = ["CARD_DECLINED", "CVV_FAILURE", "ADDRESS_VERIFICATION_FAILURE", "INVALID_EXPIRATION", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS", "CARD_DECLINED_VERIFICATION_REQUIRED", "INVALID_CARD"];
      if (cardCodes.includes(err.code)) {
        return send(res, 402, { error: "Your card was declined. Please check the details or try another card. You haven't been charged." });
      }
    }
    return send(res, 500, { error: "Something went wrong and the booking wasn't made. You haven't been charged. Please try again or call 0114 470 4565." });
  }
}
