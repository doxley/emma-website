// Checks the cancellation / refund / reschedule rules against a fake Square API.
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SQUARE_ACCESS_TOKEN = "test";
process.env.SQUARE_LOCATION_ID = "LOC";
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "whkey";

const H = 3600e3;
// A start time on a Thursday, at least `minHours` away, 1pm UK.
function thursdayAtLeast(minHours) {
  const d = new Date(Date.now() + minHours * H);
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(12, 0, 0, 0);
  if (d.getTime() - Date.now() < minHours * H) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

function fake({ startAt, status = "ACCEPTED", refunded = 0, freeSlot }) {
  const calls = [];
  const created = new Date(Date.now() - 2 * 86400e3).toISOString();
  const booking = {
    id: "BOOK1", version: 3, status, start_at: startAt, created_at: created, location_id: "LOC", customer_id: "C1",
    appointment_segments: [{ service_variation_id: "V1", service_variation_version: 7, team_member_id: "EMMA", duration_minutes: 60 }],
  };
  globalThis.fetch = async (url, opts = {}) => {
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
    const body = opts.body ? JSON.parse(opts.body) : null;
    const m = opts.method || "GET";
    calls.push({ m, path, body });
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    if (path === "/v2/bookings/team-member-booking-profiles") return ok({ team_member_booking_profiles: [{ team_member_id: "EMMA" }] });
    if (path === "/v2/catalog/list") return ok({ objects: [{ id: "I1", item_data: { name: "Reiki", product_type: "APPOINTMENTS_SERVICE", variations: [{ id: "V1", version: 7, item_variation_data: { service_duration: 3600000, price_money: { amount: 4000, currency: "GBP" } } }] } }] });
    if (path === "/v2/bookings/BOOK1" && m === "GET") return ok({ booking });
    if (path === "/v2/bookings/BOOK1/cancel") return ok({ booking: { ...booking, status: "CANCELLED_BY_CUSTOMER" } });
    if (path === "/v2/bookings/BOOK1" && m === "PUT") return ok({ booking: { ...booking, start_at: body.booking.start_at } });
    if (path === "/v2/payments") return ok({ payments: [
      { id: "OTHER", customer_id: "C2", status: "COMPLETED", created_at: created, amount_money: { amount: 4000, currency: "GBP" } },
      { id: "P1", customer_id: "C1", status: "COMPLETED", created_at: new Date(Date.parse(created) - 5000).toISOString(), amount_money: { amount: 4000, currency: "GBP" }, refunded_money: { amount: refunded, currency: "GBP" } },
    ] });
    if (path === "/v2/refunds") return ok({ refund: { id: "R1", status: "PENDING" } });
    if (path === "/v2/bookings/availability/search") return ok({ availabilities: freeSlot ? [{ start_at: freeSlot, appointment_segments: [{ team_member_id: "EMMA", service_variation_version: 7, duration_minutes: 60 }] }] : [] });
    throw new Error(`Unexpected ${m} ${path}`);
  };
  return calls;
}

const fresh = (p) => import(`../api/${p}?${Math.random()}`);
async function manage(method, body, query = "") {
  const mod = await fresh("manage.js");
  let status, out;
  const res = { setHeader() {}, set statusCode(s) { status = s; }, get statusCode() { return status; }, end(s) { out = JSON.parse(s); } };
  await mod.default({ method, body, url: `/api/manage${query}` }, res);
  return { status, out };
}
const { signBooking, verifyToken } = await fresh("_manage.js");
const t = signBooking("BOOK1");

// Tokens
assert.equal(verifyToken(t), "BOOK1");
assert.equal(verifyToken("BOOK1.forged0000000000000000"), null);
assert.equal(verifyToken("BOOK2." + t.split(".")[1]), null);
console.log("✓ manage links can't be forged or reused for another booking");

// 1. Cancel 3 days ahead -> full refund of the right payment
let calls = fake({ startAt: thursdayAtLeast(72).toISOString() });
let r = await manage("POST", { t, action: "cancel" });
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.equal(r.out.refunded, 4000);
const refund = calls.find((c) => c.path === "/v2/refunds");
assert.equal(refund.body.payment_id, "P1", "refunds this customer's payment, not someone else's");
assert.equal(refund.body.amount_money.amount, 4000);
console.log("✓ cancel more than 24h before: full refund");

// 2. Cancel 10 hours ahead -> cancelled, no refund
calls = fake({ startAt: new Date(Date.now() + 10 * H).toISOString() });
r = await manage("POST", { t, action: "cancel" });
assert.equal(r.status, 200);
assert.equal(r.out.refunded, 0);
assert.ok(calls.some((c) => c.path === "/v2/bookings/BOOK1/cancel"));
assert.ok(!calls.some((c) => c.path === "/v2/refunds"));
console.log("✓ cancel within 24h: cancelled, no refund");

// 3. Already part-refunded -> refunds only the rest
calls = fake({ startAt: thursdayAtLeast(72).toISOString(), refunded: 1000 });
r = await manage("POST", { t, action: "cancel" });
assert.equal(calls.find((c) => c.path === "/v2/refunds").body.amount_money.amount, 3000);
console.log("✓ never refunds more than was paid");

// 4. Reschedule 3 days ahead to a free Thursday slot
const start = thursdayAtLeast(72);
const newSlot = new Date(start.getTime() + 7 * 86400e3 + H).toISOString().replace(".000", "");
calls = fake({ startAt: start.toISOString(), freeSlot: newSlot });
r = await manage("POST", { t, action: "reschedule", startAt: newSlot });
assert.equal(r.status, 200, JSON.stringify(r.out));
const put = calls.find((c) => c.m === "PUT");
assert.equal(put.body.booking.start_at, newSlot);
assert.equal(put.body.booking.version, 3);
assert.ok(!calls.some((c) => c.path === "/v2/refunds"));
console.log("✓ move more than 24h before: booking moved, no money changes");

// 5. Reschedule within 24h -> refused
calls = fake({ startAt: new Date(Date.now() + 10 * H).toISOString(), freeSlot: newSlot });
r = await manage("POST", { t, action: "reschedule", startAt: newSlot });
assert.equal(r.status, 409);
assert.ok(!calls.some((c) => c.m === "PUT"));
console.log("✓ move within 24h: refused, asked to call");

// 6. Already cancelled -> nothing happens
calls = fake({ startAt: thursdayAtLeast(72).toISOString(), status: "CANCELLED_BY_CUSTOMER" });
r = await manage("POST", { t, action: "cancel" });
assert.equal(r.status, 409);
assert.ok(!calls.some((c) => c.path === "/v2/refunds"));
console.log("✓ can't cancel (or refund) twice");

// ---------- Webhook ----------
const wh = await fresh("square-webhook.js");
const event = (booking) => ({ type: "booking.updated", created_at: new Date().toISOString(), data: { object: { booking } } });
const base = { id: "BOOK1", created_at: new Date(Date.now() - 2 * 86400e3).toISOString(), location_id: "LOC", customer_id: "C1" };

calls = fake({ startAt: thursdayAtLeast(72).toISOString() });
let w = await wh.handleEvent(event({ ...base, status: "CANCELLED_BY_CUSTOMER", start_at: thursdayAtLeast(72).toISOString(), updated_at: new Date().toISOString() }));
assert.equal(w.refunded, 4000);
console.log("✓ cancelled via Square's link more than 24h before: refunded");

calls = fake({ startAt: new Date(Date.now() + 5 * H).toISOString() });
w = await wh.handleEvent(event({ ...base, status: "CANCELLED_BY_CUSTOMER", start_at: new Date(Date.now() + 5 * H).toISOString(), updated_at: new Date().toISOString() }));
assert.equal(w.refunded, 0);
assert.ok(!calls.some((c) => c.path === "/v2/refunds"));
console.log("✓ cancelled via Square's link within 24h: not refunded");

calls = fake({ startAt: new Date(Date.now() + 5 * H).toISOString() });
w = await wh.handleEvent(event({ ...base, status: "CANCELLED_BY_SELLER", start_at: new Date(Date.now() + 5 * H).toISOString() }));
assert.equal(w.refunded, 4000);
console.log("✓ Emma cancels: client refunded in full");

calls = fake({ startAt: new Date(Date.now() - 2 * H).toISOString() });
w = await wh.handleEvent(event({ ...base, status: "NO_SHOW", start_at: new Date(Date.now() - 2 * H).toISOString() }));
assert.ok(!calls.some((c) => c.path === "/v2/refunds"));
console.log("✓ no-show: not refunded");

// Signature check
const raw = JSON.stringify(event({ ...base, status: "NO_SHOW", start_at: base.created_at }));
const url = "https://holisticsolutionswithemma.vercel.app/api/square-webhook";
const sig = crypto.createHmac("sha256", "whkey").update(url + raw).digest("base64");
let resp = await wh.POST(new Request(url, { method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": sig } }));
assert.equal(resp.status, 200);
resp = await wh.POST(new Request(url, { method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": "nope" } }));
assert.equal(resp.status, 401);
console.log("✓ webhook rejects messages that didn't come from Square");
