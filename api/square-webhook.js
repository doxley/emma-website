// POST /api/square-webhook — Square tells us when a booking changes.
// Catches cancellations made OUTSIDE the website (Square's reminder link, or Emma in her dashboard)
// and applies the same refund rules:
//   - client cancels more than 24h before -> full refund
//   - Emma cancels                        -> full refund
//   - client cancels within 24h / no-show -> nothing
// Uses a Web-standard handler so we can read the raw body to check Square's signature.
import crypto from "node:crypto";
import { refundBooking, NOTICE_MS } from "./_manage.js";

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export function validSignature({ body, signature, url, key }) {
  if (!key || !signature) return false;
  const expected = crypto.createHmac("sha256", key).update(url + body).digest("base64");
  const a = Buffer.from(signature), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleEvent(event) {
  if (event?.type !== "booking.updated") return { ignored: "type" };
  const booking = event.data?.object?.booking;
  if (!booking) return { ignored: "no booking" };

  if (booking.status === "CANCELLED_BY_SELLER") {
    const r = await refundBooking(booking, "Appointment cancelled by Holistic Solutions with Emma");
    return { action: "seller-cancel", refunded: r.refunded };
  }
  if (booking.status === "CANCELLED_BY_CUSTOMER") {
    const cancelledAt = Date.parse(booking.updated_at || event.created_at || new Date().toISOString());
    if (Date.parse(booking.start_at) - cancelledAt > NOTICE_MS) {
      const r = await refundBooking(booking, "Cancelled more than 24 hours before the appointment");
      return { action: "customer-cancel", refunded: r.refunded };
    }
    return { action: "customer-cancel-late", refunded: 0 };
  }
  return { ignored: booking.status };
}

export async function POST(request) {
  const body = await request.text();
  const u = new URL(request.url);
  const url = `https://${request.headers.get("x-forwarded-host") || u.host}${u.pathname}`;
  const ok = validSignature({
    body, url,
    signature: request.headers.get("x-square-hmacsha256-signature"),
    key: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  });
  if (!ok) return json(401, { error: "Bad signature" });
  try {
    const result = await handleEvent(JSON.parse(body));
    console.log("webhook", JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    console.error("Webhook handling failed", err);
    return json(500, { error: "failed" }); // Square retries, and refunds are idempotent
  }
}

export function GET() {
  return json(200, { ok: true });
}
