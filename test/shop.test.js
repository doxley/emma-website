// Shop: products from Square categories, postage by biggest item, stock checks, prices from Square only.
import assert from "node:assert/strict";
process.env.SQUARE_ACCESS_TOKEN = "test";
process.env.SQUARE_LOCATION_ID = "LOC";

function fake({ stock = { V_AME: 5, V_GEO: 1 }, payFails = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const path = url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
    const m = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ m, path, body });
    const ok = (d) => new Response(JSON.stringify(d), { status: 200 });
    if (path === "/v2/bookings/team-member-booking-profiles") return ok({});
    if (path === "/v2/catalog/list") return ok({ objects: [
      { type: "CATEGORY", id: "C_SHOP", category_data: { name: "Online shop" } },
      { type: "CATEGORY", id: "C_LB", category_data: { name: "Letterbox" } },
      { type: "CATEGORY", id: "C_HV", category_data: { name: "Heavy parcel" } },
      { type: "IMAGE", id: "IMG1", image_data: { url: "https://img/ame.jpg" } },
      { type: "ITEM", id: "AME", item_data: { name: "Amethyst tumble stone", categories: [{ id: "C_SHOP" }, { id: "C_LB" }], image_ids: ["IMG1"],
        variations: [{ id: "V_AME", item_variation_data: { name: "Regular", price_money: { amount: 450, currency: "GBP" }, track_inventory: true } }] } },
      { type: "ITEM", id: "GEO", item_data: { name: "Amethyst geode", categories: [{ id: "C_SHOP" }, { id: "C_HV" }],
        variations: [{ id: "V_GEO", item_variation_data: { price_money: { amount: 6500, currency: "GBP" }, track_inventory: true } }] } },
      { type: "ITEM", id: "CANDLE", item_data: { name: "Sage candle", categories: [{ id: "C_SHOP" }],
        variations: [{ id: "V_CAN", item_variation_data: { price_money: { amount: 1200, currency: "GBP" } } }] } },
      { type: "ITEM", id: "TILL", item_data: { name: "Tarot via Email", variations: [{ id: "V_TILL", item_variation_data: { price_money: { amount: 3000, currency: "GBP" } } }] } },
    ] });
    if (path === "/v2/inventory/counts/batch-retrieve") return ok({ counts: Object.entries(stock).map(([id, q]) => ({ catalog_object_id: id, quantity: String(q), state: "IN_STOCK" })) });
    if (path === "/v2/customers/search") return ok({});
    if (path === "/v2/customers") return ok({ customer: { id: "CUST" } });
    if (path === "/v2/orders" && m === "POST") {
      const total = body.order.line_items.reduce((s, l) => s + (l.base_price_money ? l.base_price_money.amount : { V_AME: 450, V_GEO: 6500, V_CAN: 1200 }[l.catalog_object_id]) * Number(l.quantity), 0);
      return ok({ order: { id: "ORD1", version: 1, total_money: { amount: total, currency: "GBP" } } });
    }
    if (path === "/v2/orders/ORD1" && m === "PUT") return ok({ order: { id: "ORD1", state: "CANCELED" } });
    if (path === "/v2/payments") return payFails
      ? new Response(JSON.stringify({ errors: [{ code: "CARD_DECLINED" }] }), { status: 402 })
      : ok({ payment: { id: "PAY1", receipt_url: "https://r" } });
    throw new Error(`Unexpected ${m} ${path}`);
  };
  return calls;
}
const fresh = (p) => import(`../api/${p}?${Math.random()}`);
async function order(body) {
  const mod = await fresh("order.js");
  let status, out;
  const res = { setHeader() {}, set statusCode(s) { status = s; }, get statusCode() { return status; }, end(s) { out = JSON.parse(s); } };
  await mod.default({ method: "POST", body }, res);
  return { status, out };
}
const base = { sourceId: "cnon:ok-token", idempotencyKey: "123e4567-e89b-12d3-a456-426614174000", givenName: "Test", familyName: "Client", email: "t@example.com", phone: "07700 900123",
  address: { line1: "1 Test Street", city: "Sheffield", postcode: "S6 1TH" } };

// Product listing
fake();
const { getShop, postageFor } = await fresh("_shop.js");
const { products } = await getShop({ fresh: true });
assert.deepEqual(products.map((p) => p.name), ["Amethyst geode", "Amethyst tumble stone", "Sage candle"]);
assert.equal(products.find((p) => p.id === "AME").size, "letterbox");
assert.equal(products.find((p) => p.id === "CANDLE").size, "small", "no postage category = small parcel");
assert.equal(products.find((p) => p.id === "AME").images[0], "https://img/ame.jpg");
console.log("✓ shows only items in “Online shop”, with photos and postage sizes");

assert.equal(postageFor(["letterbox"]).pence, 325);
assert.equal(postageFor(["letterbox", "small"]).pence, 395);
assert.equal(postageFor(["small", "heavy", "letterbox"]).pence, 795);
console.log("✓ postage = biggest item in the basket, charged once");

// Posted order: letterbox + candle -> small parcel £3.95
let calls = fake();
let r = await order({ ...base, fulfilment: "post", items: [{ variationId: "V_AME", qty: 2 }, { variationId: "V_CAN", qty: 1 }] });
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.equal(r.out.total, 450 * 2 + 1200 + 395);
let o = calls.find((c) => c.path === "/v2/orders").body.order;
assert.equal(o.fulfillments[0].type, "SHIPMENT");
assert.equal(o.fulfillments[0].shipment_details.recipient.address.postal_code, "S6 1TH");
assert.ok(o.line_items.some((l) => /Postage – Small parcel/.test(l.name || "")));
const pay = calls.find((c) => c.path === "/v2/payments").body;
assert.equal(pay.order_id, "ORD1");
assert.equal(pay.amount_money.amount, 2495);
console.log("✓ posted order: items + one postage charge, paid against a Square order");

// Collection: no postage
calls = fake();
r = await order({ ...base, fulfilment: "collect", address: {}, items: [{ variationId: "V_GEO", qty: 1 }] });
assert.equal(r.status, 200, JSON.stringify(r.out));
assert.equal(r.out.total, 6500);
o = calls.find((c) => c.path === "/v2/orders").body.order;
assert.equal(o.fulfillments[0].type, "PICKUP");
assert.ok(!o.line_items.some((l) => l.name));
console.log("✓ collection: free, marked for pickup");

// Prices from Square, not the browser
calls = fake();
r = await order({ ...base, fulfilment: "collect", items: [{ variationId: "V_CAN", qty: 1, amount: 1 }] });
assert.equal(r.out.total, 1200);
console.log("✓ prices always come from Square");

// Stock
calls = fake();
r = await order({ ...base, fulfilment: "post", items: [{ variationId: "V_GEO", qty: 2 }] });
assert.equal(r.status, 409);
assert.ok(!calls.some((c) => c.path === "/v2/payments"));
calls = fake({ stock: { V_AME: 0, V_GEO: 1 } });
r = await order({ ...base, fulfilment: "post", items: [{ variationId: "V_AME", qty: 1 }] });
assert.equal(r.status, 409);
console.log("✓ can't buy more than is in stock, or sold-out items");

// Not a shop item
calls = fake();
r = await order({ ...base, fulfilment: "collect", items: [{ variationId: "V_TILL", qty: 1 }] });
assert.equal(r.status, 409);
console.log("✓ items outside “Online shop” can't be bought");

// Bad postcode
calls = fake();
r = await order({ ...base, fulfilment: "post", address: { line1: "1 St", city: "X", postcode: "NOPE" }, items: [{ variationId: "V_CAN", qty: 1 }] });
assert.equal(r.status, 400);
console.log("✓ posted orders need a full UK address");

// Card declined -> order cancelled, no charge
calls = fake({ payFails: true });
r = await order({ ...base, fulfilment: "post", items: [{ variationId: "V_CAN", qty: 1 }] });
assert.equal(r.status, 402);
assert.equal(calls.find((c) => c.path === "/v2/orders/ORD1" && c.m === "PUT").body.order.state, "CANCELED");
console.log("✓ declined card: unpaid order is cancelled");
