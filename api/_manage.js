// Shared logic for managing a booking after it's made: cancel (with the 24-hour refund rule) and reschedule.
//
// Policy (Emma's rules):
//   - Cancelled more than 24 hours before the start time  -> full refund, automatically.
//   - Cancelled within 24 hours, or a no-show             -> no refund.
//   - Moving to another time is allowed up to 24 hours before; after that, clients call.
//   - If Emma cancels an appointment herself              -> full refund, automatically.
import crypto from "node:crypto";
import { sq, londonLong, londonTime, londonDate } from "./_square.js";

export const NOTICE_MS = 24 * 3600 * 1000;
export const PHONE = "0114 470 4565";

// ---------- Signed manage links ----------
// A manage link carries the booking ID plus an HMAC so nobody can guess another client's link.
function linkKey() {
  const secret = process.env.SQUARE_APP_SECRET || process.env.SQUARE_ACCESS_TOKEN || "";
  if (!secret) throw new Error("No server secret available for signing links");
  return crypto.createHmac("sha256", secret).update("emma-manage-link-v1").digest();
}
export function signBooking(bookingId) {
  const mac = crypto.createHmac("sha256", linkKey()).update(bookingId).digest("base64url").slice(0, 22);
  return `${bookingId}.${mac}`;
}
export function verifyToken(token) {
  const [id, mac] = String(token || "").split(".");
  if (!id || !mac || !/^[\w-]{3,64}$/.test(id)) return null;
  const expected = signBooking(id).split(".")[1];
  const a = Buffer.from(mac), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

// ---------- Square lookups ----------
export async function getBooking(id) {
  const { booking } = await sq(`/v2/bookings/${encodeURIComponent(id)}`);
  return booking;
}

// The website takes payment a few seconds before it creates the booking, for the same customer.
// Find that payment by looking at this customer's payments around the booking's creation time.
export async function findPaymentForBooking(booking) {
  if (!booking?.customer_id || !booking.created_at) return null;
  const created = Date.parse(booking.created_at);
  const q = new URLSearchParams({
    begin_time: new Date(created - 15 * 60 * 1000).toISOString(),
    end_time: new Date(created + 5 * 60 * 1000).toISOString(),
    location_id: booking.location_id,
    sort_order: "DESC",
  });
  const { payments = [] } = await sq(`/v2/payments?${q}`);
  const matches = payments
    .filter((p) => p.customer_id === booking.customer_id && ["COMPLETED", "APPROVED"].includes(p.status))
    .filter((p) => Date.parse(p.created_at) <= created + 60 * 1000)
    .sort((a, b) => Math.abs(created - Date.parse(a.created_at)) - Math.abs(created - Date.parse(b.created_at)));
  return matches[0] || null;
}

export function refundableAmount(payment) {
  if (!payment) return 0;
  const paid = Number(payment.amount_money?.amount || 0);
  const refunded = Number(payment.refunded_money?.amount || 0);
  return Math.max(0, paid - refunded);
}

// Full refund of whatever hasn't already been refunded. Safe to call twice: Square de-duplicates on the key.
export async function refundBooking(booking, reason) {
  const payment = await findPaymentForBooking(booking);
  const amount = refundableAmount(payment);
  if (!payment || amount <= 0) return { refunded: 0, payment };
  const { refund } = await sq("/v2/refunds", {
    method: "POST",
    body: {
      idempotency_key: `refund-${booking.id}`.slice(0, 45),
      payment_id: payment.id,
      amount_money: { amount, currency: payment.amount_money.currency },
      reason: reason.slice(0, 192),
    },
  });
  return { refunded: amount, currency: payment.amount_money.currency, refund, payment };
}

// ---------- Rules ----------
export const isCancelled = (b) => /^CANCELLED|DECLINED/.test(b.status || "");
export const msUntil = (b, now = Date.now()) => Date.parse(b.start_at) - now;
export const qualifiesForRefund = (b, at = Date.now()) => msUntil(b, at) > NOTICE_MS;

export function describe(booking, serviceName) {
  const now = Date.now();
  const past = msUntil(booking, now) <= 0;
  const cancelled = isCancelled(booking);
  const early = qualifiesForRefund(booking, now);
  return {
    id: booking.id,
    service: serviceName,
    startAt: booking.start_at,
    when: `${londonLong(booking.start_at)}, ${londonTime(booking.start_at)}`,
    date: londonDate(booking.start_at),
    status: booking.status,
    cancelled,
    past,
    canCancel: !cancelled && !past,
    refundOnCancel: !cancelled && early,
    canReschedule: !cancelled && early,
    variationId: booking.appointment_segments?.[0]?.service_variation_id,
  };
}

export function samePhone(a, b) {
  const tail = (x) => String(x || "").replace(/\D/g, "").slice(-10);
  return tail(a).length === 10 && tail(a) === tail(b);
}
