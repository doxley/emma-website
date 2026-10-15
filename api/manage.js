// /api/manage — look at, cancel or move a booking.
//   GET  /api/manage?t=<token>                         -> booking details and what the client can do
//   POST /api/manage { t, action: "cancel" }            -> cancel; full refund if more than 24h before
//   POST /api/manage { t, action: "reschedule", startAt } -> move to another free time (only if more than 24h before)
import { getBusiness, searchAvailability, sq, send, readJson, londonDate, londonLong, londonTime } from "./_square.js";
import { verifyToken, getBooking, describe, refundBooking, qualifiesForRefund, isCancelled, PHONE } from "./_manage.js";

import { allowedStart } from "./_rules.js";
const money = (p, cur = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(p / 100).replace(/\.00$/, "");

async function load(token) {
  const id = verifyToken(token);
  if (!id) return { error: [404, "This link isn't valid. Please use the link from your booking, or find your booking by email."] };
  const booking = await getBooking(id).catch(() => null);
  if (!booking) return { error: [404, "We couldn't find that booking."] };
  const { services } = await getBusiness();
  const svc = services.find((s) => s.variationId === booking.appointment_segments?.[0]?.service_variation_id);
  return { booking, svc, info: describe(booking, svc?.name || "Appointment") };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const t = new URL(req.url, "http://x").searchParams.get("t");
      const r = await load(t);
      if (r.error) return send(res, r.error[0], { error: r.error[1] });
      return send(res, 200, { booking: { ...r.info, price: r.svc ? money(r.svc.amount, r.svc.currency) : null } });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST" });

    const body = await readJson(req);
    const r = await load(body.t);
    if (r.error) return send(res, r.error[0], { error: r.error[1] });
    const { booking, svc, info } = r;

    if (isCancelled(booking)) return send(res, 409, { error: "This booking has already been cancelled." });
    if (info.past) return send(res, 409, { error: `This appointment has already passed. Please call ${PHONE} if you need help.` });

    // ----- Cancel -----
    if (body.action === "cancel") {
      const refund = qualifiesForRefund(booking); // decided at the moment of cancelling
      await sq(`/v2/bookings/${booking.id}/cancel`, {
        method: "POST",
        body: { idempotency_key: `cancel-${booking.id}`.slice(0, 45), booking_version: booking.version },
      });
      let refunded = 0, currency = "GBP", refundError = false;
      if (refund) {
        try {
          const out = await refundBooking(booking, "Cancelled online more than 24 hours before the appointment");
          refunded = out.refunded; currency = out.currency || currency;
        } catch (err) {
          console.error("Refund failed", err);
          refundError = true;
        }
      }
      return send(res, 200, {
        cancelled: true,
        refunded,
        refundText: refunded ? money(refunded, currency) : null,
        message: refunded
          ? `Your appointment is cancelled and ${money(refunded, currency)} is on its way back to your card. Refunds usually arrive within 5 to 10 working days.`
          : refundError
            ? `Your appointment is cancelled. Your refund couldn't be processed automatically, so Emma will refund you by hand. Call ${PHONE} if you have any questions.`
            : refund
              ? "Your appointment is cancelled. There was no online payment to refund."
              : "Your appointment is cancelled. As it was less than 24 hours away, it isn't refunded.",
      });
    }

    // ----- Reschedule -----
    if (body.action === "reschedule") {
      if (!qualifiesForRefund(booking)) {
        return send(res, 409, { error: `Appointments can only be moved online up to 24 hours before. Please call ${PHONE}.` });
      }
      if (!svc) return send(res, 409, { error: `Please call ${PHONE} to move this appointment.` });
      const start = new Date(String(body.startAt || ""));
      if (Number.isNaN(start.getTime())) return send(res, 400, { error: "Please choose a new time." });
      const date = londonDate(start);
      if (date === londonDate(new Date())) return send(res, 409, { error: `For appointments today, please call ${PHONE}.` });
      if (!allowedStart(svc, start)) {
        return send(res, 409, { error: "That time isn't available to book online. Please choose another." });
      }
      const { locationId } = await getBusiness();
      const slots = await searchAvailability({
        service: svc, locationId,
        startAt: new Date(start.getTime() - 12 * 3600e3).toISOString(),
        endAt: new Date(start.getTime() + 12 * 3600e3).toISOString(),
      });
      const slot = slots.find((a) => Date.parse(a.start_at) === start.getTime());
      if (!slot) return send(res, 409, { error: "Sorry, that time has just been taken. Please choose another.", code: "SLOT_TAKEN" });
      const seg = slot.appointment_segments?.[0] || {};
      const old = booking.appointment_segments?.[0] || {};
      const { booking: updated } = await sq(`/v2/bookings/${booking.id}`, {
        method: "PUT",
        body: {
          idempotency_key: `move-${booking.id}-${start.getTime()}`.slice(0, 45),
          booking: {
            version: booking.version,
            start_at: slot.start_at,
            appointment_segments: [{
              duration_minutes: seg.duration_minutes || old.duration_minutes || svc.minutes,
              service_variation_id: svc.variationId,
              service_variation_version: seg.service_variation_version || old.service_variation_version || svc.version,
              team_member_id: seg.team_member_id || old.team_member_id,
            }],
          },
        },
      });
      return send(res, 200, {
        moved: true,
        when: `${londonLong(updated.start_at)}, ${londonTime(updated.start_at)}`,
        message: `Done. Your ${svc.name} is now on ${londonLong(updated.start_at)} at ${londonTime(updated.start_at)}.`,
      });
    }

    return send(res, 400, { error: "Unknown action." });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: `Something went wrong and nothing was changed. Please try again or call ${PHONE}.` });
  }
}
