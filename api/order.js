// POST /api/order — pay for a shop basket.
// Body: { sourceId, idempotencyKey, items: [{ variationId, qty }], fulfilment: "collect" | "post",
//         givenName, familyName, email, phone, address: { line1, line2, city, postcode }, note }
//
// Prices, stock and postage are worked out here from Square — never trusted from the browser.
// Creates a Square order (so stock goes down and it shows in Emma's Orders), then takes payment for it.
import { sq, send, readJson, ukPhoneToE164, SquareError } from "./_square.js";
import { getShop, postageFor } from "./_shop.js";

const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const fmt = (p) => `£${(p / 100).toFixed(2)}`;

async function findOrCreateCustomer({ key, givenName, familyName, email, phone, address }) {
  const found = await sq("/v2/customers/search", {
    method: "POST",
    body: { query: { filter: { email_address: { exact: email } } }, limit: 1 },
  });
  if (found.customers?.length) return found.customers[0].id;
  const created = await sq("/v2/customers", {
    method: "POST",
    body: {
      idempotency_key: `${key}-cust`,
      given_name: givenName, family_name: familyName || undefined,
      email_address: email, phone_number: phone || undefined,
      address: address || undefined,
      note: "Created by online shop",
    },
  });
  return created.customer.id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Invalid request." }); }

  const key = clean(body.idempotencyKey, 36);
  const sourceId = clean(body.sourceId, 500);
  const givenName = clean(body.givenName, 60), familyName = clean(body.familyName, 60);
  const email = clean(body.email, 120).toLowerCase();
  const phone = ukPhoneToE164(body.phone);
  const post = body.fulfilment === "post";
  const a = body.address || {};
  const address = post ? {
    address_line_1: clean(a.line1, 120), address_line_2: clean(a.line2, 120) || undefined,
    locality: clean(a.city, 60), postal_code: clean(a.postcode, 10).toUpperCase(), country: "GB",
  } : null;

  if (!sourceId || !/^[\w-]{8,36}$/.test(key)) return send(res, 400, { error: "Payment details are missing. Please try again." });
  if (!givenName || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: "Please add your name and a valid email address." });
  if (!phone) return send(res, 400, { error: "Please add a UK mobile number so Emma can contact you about your order." });
  if (post && (!address.address_line_1 || !address.locality || !UK_POSTCODE.test(address.postal_code))) {
    return send(res, 400, { error: "Please add your full UK delivery address, including postcode." });
  }

  // Basket: merge duplicates, check quantities
  const wanted = new Map();
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 50) : []) {
    const id = clean(it.variationId, 64), qty = Math.floor(Number(it.qty));
    if (!id || !(qty > 0 && qty <= 20)) continue;
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  if (!wanted.size) return send(res, 400, { error: "Your basket is empty." });

  let orderId = null, orderVersion = null, locId = null;
  try {
    const { products, locationId } = await getShop({ fresh: true });
    locId = locationId;
    const byVar = new Map(products.flatMap((p) => p.variations.map((v) => [v.id, { p, v }])));
    const lines = [], sizes = [], problems = [];
    for (const [id, qty] of wanted) {
      const hit = byVar.get(id);
      if (!hit) { problems.push("One item in your basket is no longer available."); continue; }
      const { p, v } = hit;
      const label = v.name && p.variations.length > 1 ? `${p.name} (${v.name})` : p.name;
      if (!v.available) problems.push(`${label} has just sold out.`);
      else if (v.stock !== null && qty > v.stock) problems.push(`Only ${v.stock} of ${label} left.`);
      lines.push({ catalog_object_id: id, quantity: String(qty) });
      sizes.push(p.size);
    }
    if (problems.length) return send(res, 409, { error: problems.join(" ") + " Please update your basket.", code: "STOCK" });

    const postage = post ? postageFor(sizes) : null;
    if (postage) lines.push({ name: `Postage – ${postage.label} (Evri)`, quantity: "1", base_price_money: { amount: postage.pence, currency: "GBP" } });

    const displayName = `${givenName} ${familyName}`.trim();
    const customerId = await findOrCreateCustomer({ key, givenName, familyName, email, phone, address });
    const recipient = { display_name: displayName, email_address: email, phone_number: phone, ...(address ? { address } : {}) };

    const { order } = await sq("/v2/orders", {
      method: "POST",
      body: {
        idempotency_key: `${key}-order`,
        order: {
          location_id: locationId,
          customer_id: customerId,
          reference_id: "website-shop",
          line_items: lines,
          fulfillments: [post
            ? { type: "SHIPMENT", state: "PROPOSED", shipment_details: { recipient, carrier: "Evri", shipping_note: clean(body.note, 300) || undefined } }
            : { type: "PICKUP", state: "PROPOSED", pickup_details: { recipient, schedule_type: "ASAP", note: clean(body.note, 300) || "Collect from 341 Middlewood Road" } }],
        },
      },
    });
    orderId = order.id; orderVersion = order.version;
    const total = order.total_money;

    const { payment } = await sq("/v2/payments", {
      method: "POST",
      body: {
        idempotency_key: `${key}-pay`,
        source_id: sourceId,
        amount_money: total,
        order_id: order.id,
        location_id: locationId,
        customer_id: customerId,
        buyer_email_address: email,
        autocomplete: true,
        note: `Online shop – ${post ? "post" : "collect"}`,
        ...(address ? { shipping_address: address } : {}),
      },
    });

    return send(res, 200, {
      orderId: order.id,
      total: total.amount,
      totalText: fmt(total.amount),
      postage: postage ? { label: postage.label, amount: postage.pence } : null,
      fulfilment: post ? "post" : "collect",
      email,
      receiptUrl: payment.receipt_url || null,
    });
  } catch (err) {
    console.error(err);
    if (orderId) {
      // Payment didn't go through: cancel the unpaid order so it doesn't sit in Emma's Orders list.
      await sq(`/v2/orders/${orderId}`, {
        method: "PUT",
        body: { idempotency_key: `${key}-cancel`, order: { location_id: locId, version: orderVersion, state: "CANCELED" } },
      }).catch((e) => console.error("Could not cancel order", e.message));
    }
    if (err instanceof SquareError) {
      const declined = ["CARD_DECLINED", "CVV_FAILURE", "ADDRESS_VERIFICATION_FAILURE", "INVALID_EXPIRATION", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS", "CARD_DECLINED_VERIFICATION_REQUIRED", "INVALID_CARD"];
      if (declined.includes(err.code)) return send(res, 402, { error: "Your card was declined. Please check the details or try another card. You haven't been charged." });
      if (err.status === 401 || err.code === "INSUFFICIENT_SCOPES") return send(res, 503, { error: "The shop checkout isn't switched on yet. Please call 0114 470 4565 to order." });
    }
    return send(res, 500, { error: "Something went wrong and your order wasn't placed. You haven't been charged. Please try again or call 0114 470 4565." });
  }
}
