// Gift vouchers and discount codes, against a fake Square (and a fake email service).
import assert from "node:assert/strict";

process.env.SQUARE_ACCESS_TOKEN = "test";
process.env.SQUARE_LOCATION_ID = "LOC";
process.env.RESEND_API_KEY = "re_test";

const { londonDate } = await import("../api/_square.js");
const V = await import("../api/_vouchers.js");
const { priceFor } = await import("../api/_rules.js");

// Next Thursday at least 3 days away, 1pm UK
const day = new Date(Date.now() + 3 * 86400e3);
while (day.getUTCDay() !== 4) day.setUTCDate(day.getUTCDate() + 1);
day.setUTCHours(13, 0, 0, 0);
const SLOT = day.toISOString().replace(".000", "");
const today = londonDate(new Date());
const future = londonDate(new Date(Date.now() + 100 * 86400e3));

const SERVICES = [
  { id: "I1", name: "Reiki", v: "V_REIKI", amount: 4000 },
  { id: "I2", name: "Distance Reiki", v: "V_DIST", amount: 4000 },
  { id: "I3", name: "Online tarot reading", v: "V_OT", amount: 3000 },
];

function voucherOrder(code, { variation = "V_REIKI", service = "Reiki", expires = future, redeemed, state = "OPEN", due = 0, from = "purchase", id = "VO_" + code } = {}) {
  return {
    id, version: 3, state, location_id: "LOC", customer_id: "C_BUYER",
    net_amount_due_money: { amount: due, currency: "GBP" },
    fulfillments: [{ uid: "F1", type: "PICKUP", state: "PROPOSED" }],
    metadata: { voucher_code: code, variation_id: variation, service, expires, recipient_name: "Jo Bloggs", recipient_email: "jo@example.com", buyer_email: "sam@example.com", from, ...(redeemed ? { redeemed_booking: redeemed } : {}) },
  };
}

function fake({ orders = [], bookingFails = false, discounts = [] } = {}) {
  const calls = [], emails = [], created = [], updates = [];
  globalThis.fetch = async (url, opts = {}) => {
    const m = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    const bad = (status, code) => new Response(JSON.stringify({ errors: [{ code, detail: code }] }), { status });
    if (url.startsWith("https://api.resend.com")) { emails.push(body); return ok({ id: "em_1" }); }
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
    calls.push(`${m} ${path}`);
    if (path === "/v2/bookings/team-member-booking-profiles") return ok({ team_member_booking_profiles: [{ team_member_id: "EMMA", is_bookable: true }] });
    if (path === "/v2/catalog/list") {
      if (url.includes("DISCOUNT")) return ok({ objects: discounts });
      return ok({ objects: SERVICES.map((s) => ({ id: s.id, item_data: { name: s.name, product_type: "APPOINTMENTS_SERVICE", variations: [{ id: s.v, version: 1, item_variation_data: { service_duration: 3600000, price_money: { amount: s.amount, currency: "GBP" } } }] } })) });
    }
    if (path === "/v2/bookings/availability/search") return ok({ availabilities: [{ start_at: SLOT, appointment_segments: [{ duration_minutes: 60, team_member_id: "EMMA", service_variation_id: body.query.filter.segment_filters[0].service_variation_id, service_variation_version: 1 }] }] });
    if (path === "/v2/customers/search") return ok({});
    if (path === "/v2/customers") return ok({ customer: { id: "C1" } });
    if (path === "/v2/orders/search") {
      assert.deepEqual(body.query.filter.source_filter.source_names, ["Website gift voucher"]);
      return ok({ orders: [...orders, ...created] });
    }
    if (path === "/v2/orders" && m === "POST") {
      const o = { id: "NEW" + created.length, version: 1, state: "OPEN", location_id: "LOC", ...body.order, net_amount_due_money: { amount: 0, currency: "GBP" },
        total_money: { amount: body.order.line_items[0].base_price_money.amount, currency: "GBP" }, fulfillments: [{ uid: "FN", ...body.order.fulfillments[0] }] };
      created.push(o);
      return ok({ order: o });
    }
    if (path.startsWith("/v2/orders/") && m === "PUT") {
      updates.push(body);
      const id = path.split("/").pop();
      const o = [...orders, ...created].find((x) => x.id === id);
      if (body.order.version !== undefined && o && body.order.version !== o.version) return bad(400, "VERSION_MISMATCH");
      Object.assign(o.metadata, body.order.metadata || {});
      o.version += 1;
      if (body.order.state) o.state = body.order.state;
      return ok({ order: o });
    }
    if (path === "/v2/payments") { calls.push(`PAY ${body.amount_money.amount}`); return ok({ payment: { id: "P1", status: "APPROVED", receipt_url: "https://r" } }); }
    if (path === "/v2/payments/P1/complete") return ok({ payment: { id: "P1", receipt_url: "https://r" } });
    if (path === "/v2/payments/P1/cancel") return ok({});
    if (path === "/v2/bookings" && m === "POST") {
      if (bookingFails) return bad(400, "BAD_REQUEST");
      calls.push(`NOTE ${body.booking.customer_note || ""}`);
      return ok({ booking: { id: "B1", version: 0 } });
    }
    throw new Error(`Unexpected ${m} ${path}`);
  };
  return { calls, emails, created, updates };
}

async function call(file, body) {
  const mod = await import(`../api/${file}.js?${Math.random()}`);
  let status, out;
  const res = { setHeader() {}, set statusCode(s) { status = s; }, get statusCode() { return status; }, end(s) { out = JSON.parse(s); } };
  await mod.default({ method: "POST", body }, res);
  return { status, out };
}

// ---- Codes ----
assert.match(V.newCode(), /^HSE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
assert.equal(V.normaliseCode(" hse abcd efgh "), "HSE-ABCD-EFGH");
assert.equal(V.normaliseCode("welcome10"), "WELCOME10");
const exp = V.expiryFrom(new Date("2026-11-18T12:00:00Z"));
assert.equal(exp, "2027-05-17", "180 days after 18 Nov 2026");
console.log("✓ unique codes like HSE-ABCD-EFGH, typed any way; expiry 180 days after purchase");

// ---- Buying a voucher ----
let f = fake();
let r = await call("voucher-buy", { sourceId: "cnon:ok", idempotencyKey: "123e4567-e89b-12d3-a456-426614174000", variationId: "V_DIST", buyerName: "Sam Smith", buyerEmail: "sam@example.com", forSelf: false, recipientName: "Jo Bloggs", recipientEmail: "jo@example.com", message: "Happy birthday!" });
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.match(r.out.code, /^HSE-/);
const o = f.created[0];
assert.equal(o.source.name, "Website gift voucher");
assert.equal(o.metadata.voucher_code, r.out.code);
assert.equal(o.metadata.expires, V.expiryFrom(new Date()));
assert.equal(o.metadata.variation_id, "V_DIST");
assert.ok(Object.keys(o.metadata).length <= 8, "room left for the two redemption fields (Square allows 10)");
assert.ok(f.calls.includes("PAY 4000"), "charged the full Square price");
assert.equal(f.emails.length, 2, "voucher to recipient + confirmation to buyer");
assert.deepEqual(f.emails[0].to, ["jo@example.com"]);
assert.deepEqual(f.emails[0].bcc, ["holisticsolutionswithemma@gmail.com"], "Emma gets a copy");
assert.ok(f.emails[0].html.includes(r.out.code) && f.emails[0].html.includes("Happy birthday!"));
assert.deepEqual(f.emails[1].to, ["sam@example.com"]);
console.log("✓ buying a voucher: Square order + payment, code emailed to recipient, buyer confirmed, Emma copied");

// ---- Checking codes ----
const discounts = [
  { type: "DISCOUNT", id: "D1", discount_data: { name: "WELCOME10", discount_type: "FIXED_PERCENTAGE", percentage: "10.0" } },
  { type: "DISCOUNT", id: "D2", discount_data: { name: "FIVEOFF", discount_type: "FIXED_AMOUNT", amount_money: { amount: 500, currency: "GBP" } } },
  { type: "DISCOUNT", id: "D3", discount_data: { name: "Staff discount", discount_type: "FIXED_PERCENTAGE", percentage: "50" } },
];
const orders = [
  voucherOrder("HSE-GOOD-AAAA"),
  voucherOrder("HSE-USED-AAAA", { redeemed: "B0", state: "COMPLETED" }),
  voucherOrder("HSE-OLDV-AAAA", { expires: "2026-01-01" }),
  voucherOrder("HSE-TARO-AAAA", { variation: "V_OT", service: "Online tarot reading" }),
  voucherOrder("HSE-UNPD-AAAA", { due: 4000 }),
];
const base = priceFor({ name: "Reiki", amount: 4000 }).amount;
const chk = (code, variationId = "V_REIKI") => { fake({ orders: orders.map((x) => structuredClone(x)), discounts }); return call("check-code", { code, variationId }); };
r = await chk("hse-good-aaaa"); assert.equal(r.status, 200); assert.equal(r.out.amount, 0); assert.equal(r.out.kind, "voucher");
r = await chk("HSE-USED-AAAA"); assert.equal(r.status, 400); assert.match(r.out.error, /already been used/);
r = await chk("HSE-OLDV-AAAA"); assert.match(r.out.error, /expired/);
r = await chk("HSE-TARO-AAAA"); assert.match(r.out.error, /for Online tarot reading/);
r = await chk("HSE-UNPD-AAAA"); assert.match(r.out.error, /can't find/);
r = await chk("HSE-NOPE-NOPE"); assert.match(r.out.error, /can't find/);
r = await chk("welcome10"); assert.equal(r.out.amount, base - Math.round(base / 10)); assert.equal(r.out.kind, "discount");
r = await chk("FIVEOFF"); assert.equal(r.out.amount, base - 500);
r = await chk("Staff discount"); assert.equal(r.status, 400, "only single-word capital names are website codes");
console.log("✓ codes checked: valid, used, expired, wrong treatment, unpaid, unknown; % and £ discounts from Square");

// ---- Booking with a voucher: no card, voucher marked used ----
const input = { sourceId: "", idempotencyKey: "223e4567-e89b-12d3-a456-426614174000", variationId: "V_REIKI", startAt: SLOT, givenName: "Jo", familyName: "Bloggs", email: "jo@example.com", phone: "07700 900123", note: "", code: "HSE-GOOD-AAAA" };
let vo = [structuredClone(orders[0])];
f = fake({ orders: vo });
r = await call("book", input);
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.equal(r.out.amount, 0);
assert.ok(!f.calls.some((c) => c.startsWith("PAY")), "no card payment");
assert.equal(vo[0].metadata.redeemed_booking, "B1");
assert.ok(f.updates.at(-1).order.fulfillments?.[0]?.state === "COMPLETED" || f.updates.length >= 2);
assert.ok(f.calls.some((c) => c.startsWith("NOTE ") && c.includes("HSE-GOOD-AAAA")), "booking note says it was paid by voucher");
r = await call("book", { ...input, idempotencyKey: "323e4567-e89b-12d3-a456-426614174000" });
assert.equal(r.status, 400); assert.match(r.out.error, /already been used/);
console.log("✓ booking with a voucher: no charge, voucher used up, can't be used twice");

// Booking fails → voucher released for next time
vo = [structuredClone(orders[0])];
f = fake({ orders: vo, bookingFails: true });
r = await call("book", input);
assert.equal(r.status, 409);
assert.equal(vo[0].metadata.redeemed_booking, "released");
assert.equal(V.voucherState(vo[0]), "active");
console.log("✓ if the booking fails, the voucher is released and still works");

// Two people at once: the second is refused by Square's version check
vo = [structuredClone(orders[0])];
f = fake({ orders: vo });
const stale = structuredClone(vo[0]);
await V.markVoucher(vo[0], "pending:" + Date.now(), { key: "k1" });
await assert.rejects(V.markVoucher(stale, "pending:" + Date.now(), { key: "k2" }));
console.log("✓ the same voucher can't be reserved twice at the same moment");

// ---- Booking with a discount code ----
f = fake({ discounts });
r = await call("book", { ...input, sourceId: "cnon:ok", code: "WELCOME10", idempotencyKey: "423e4567-e89b-12d3-a456-426614174000" });
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.ok(f.calls.includes(`PAY ${base - Math.round(base / 10)}`));
console.log("✓ discount code reduces the card payment");

// Missing card when something is still to pay
f = fake({ discounts });
r = await call("book", { ...input, sourceId: "", code: "", idempotencyKey: "523e4567-e89b-12d3-a456-426614174000" });
assert.equal(r.status, 400);
console.log("✓ no card details means no booking when there's something to pay");

// ---- Cancelling a voucher booking: new code, emailed once ----
vo = [voucherOrder("HSE-USED-BBBB", { redeemed: "B9", state: "COMPLETED" })];
f = fake({ orders: vo });
let out = await V.reissueVoucherForBooking({ id: "B9", customer_id: "C1" });
assert.ok(out.reissued);
assert.equal(f.created[0].metadata.expires, future, "same expiry as the original");
assert.equal(f.created[0].metadata.from, "B9");
assert.equal(f.created[0].line_items[0].base_price_money.amount, 0);
assert.equal(f.emails.length, 1);
assert.match(f.emails[0].subject, /new code/);
out = await V.reissueVoucherForBooking({ id: "B9", customer_id: "C1" });
assert.ok(out.already);
assert.equal(f.emails.length, 1, "not emailed twice");
assert.equal(await V.reissueVoucherForBooking({ id: "B_CARD", customer_id: "C1" }), null, "card bookings aren't affected");
console.log("✓ cancelled voucher booking gets one replacement code with the same expiry");
