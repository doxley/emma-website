// Checks the booking order of operations against a fake Square API: no charge without a booking.
import assert from "node:assert/strict";

process.env.SQUARE_ACCESS_TOKEN = "test";
process.env.SQUARE_LOCATION_ID = "LOC";

// Next Thursday (an in-person day), at least 2 days away, 1pm UK.
const day = new Date(Date.now() + 2 * 86400e3);
while (day.getUTCDay() !== 4) day.setUTCDate(day.getUTCDate() + 1);
day.setUTCHours(12, 0, 0, 0);
const SLOT = day.toISOString().replace(".000", "");
const { promoActive } = await import("../api/_rules.js");
const EXPECTED_AMOUNT = promoActive() ? 2500 : 4000; // the test service is an in-person £40 treatment

function fakeSquare({ bookingFails = false, cardDeclined = false, slotFree = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${opts.method || "GET"} ${path}`);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200 });
    const bad = (status, code) => new Response(JSON.stringify({ errors: [{ code, detail: code }] }), { status });
    switch (path) {
      case "/v2/bookings/team-member-booking-profiles": return ok({ team_member_booking_profiles: [{ team_member_id: "EMMA", is_bookable: true }] });
      case "/v2/catalog/list": return ok({ objects: [{ id: "I1", item_data: { name: "Reiki", product_type: "APPOINTMENTS_SERVICE", variations: [{ id: "V1", version: 7, item_variation_data: { name: "60 min", service_duration: 3600000, price_money: { amount: 4000, currency: "GBP" } } }] } }] });
      case "/v2/bookings/availability/search": return ok({ availabilities: slotFree ? [{ start_at: SLOT, appointment_segments: [{ duration_minutes: 60, team_member_id: "EMMA", service_variation_id: "V1", service_variation_version: 7 }] }] : [] });
      case "/v2/customers/search": return ok({});
      case "/v2/customers": return ok({ customer: { id: "C1" } });
      case "/v2/payments":
        if (cardDeclined) return bad(402, "CARD_DECLINED");
        assert.equal(body.amount_money.amount, EXPECTED_AMOUNT, "price comes from catalog (launch offer applied when active)");
        assert.equal(body.autocomplete, false, "card is only authorised first");
        return ok({ payment: { id: "P1", status: "APPROVED" } });
      case "/v2/bookings":
        if (bookingFails) return bad(400, "BAD_REQUEST");
        return ok({ booking: { id: "B1", version: 0 } });
      case "/v2/payments/P1/complete": return ok({ payment: { id: "P1", receipt_url: "https://r" } });
      case "/v2/payments/P1/cancel": return ok({ payment: { id: "P1", status: "CANCELED" } });
      default: throw new Error("Unexpected call " + path);
    }
  };
  return calls;
}

async function call(body) {
  const mod = await import(`../api/book.js?${Math.random()}`); // fresh module → fresh cache
  let status, out;
  const res = { setHeader() {}, set statusCode(s) { status = s; }, get statusCode() { return status; }, end(s) { out = JSON.parse(s); } };
  await mod.default({ method: "POST", body }, res);
  return { status, out };
}

const input = { sourceId: "cnon:card-nonce-ok", idempotencyKey: "123e4567-e89b-12d3-a456-426614174000", variationId: "V1", startAt: SLOT, givenName: "Test", familyName: "Client", email: "test@example.com", phone: "07700 900123", note: "" };

// 1. Happy path
let calls = fakeSquare();
let r = await call(input);
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.equal(r.out.bookingId, "B1");
assert.ok(calls.indexOf("POST /v2/payments") < calls.indexOf("POST /v2/bookings"));
assert.ok(calls.includes("POST /v2/payments/P1/complete"));
console.log("✓ books and charges");

// 2. Booking fails after card authorised → hold released, no charge
calls = fakeSquare({ bookingFails: true });
r = await call(input);
assert.equal(r.status, 409);
assert.ok(calls.includes("POST /v2/payments/P1/cancel"));
assert.ok(!calls.includes("POST /v2/payments/P1/complete"));
console.log("✓ releases the card hold if the booking fails");

// 3. Card declined → no booking
calls = fakeSquare({ cardDeclined: true });
r = await call(input);
assert.equal(r.status, 402);
assert.ok(!calls.includes("POST /v2/bookings"));
console.log("✓ declined card makes no booking");

// 4. Slot gone before paying → no charge attempted
calls = fakeSquare({ slotFree: false });
r = await call(input);
assert.equal(r.status, 409);
assert.ok(!calls.includes("POST /v2/payments"));
console.log("✓ taken slot is caught before the card is touched");
