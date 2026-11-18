// POST /api/voucher-buy — buy a gift voucher for one treatment.
// Body: { sourceId, idempotencyKey, variationId, buyerName, buyerEmail, forSelf, recipientName, recipientEmail, message }
// Creates the voucher order in Square, pays for it, then emails the code. The price always comes from Square.
import { getBusiness, sq, send, readJson, SquareError } from "./_square.js";
import { kindOf } from "./_rules.js";
import { newCode, expiryFrom, createVoucherOrder, emailVoucher, prettyDate } from "./_vouchers.js";

const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Invalid request." }); }

  const sourceId = clean(body.sourceId, 500);
  const key = clean(body.idempotencyKey, 36);
  const buyerName = clean(body.buyerName, 80);
  const buyerEmail = clean(body.buyerEmail, 120).toLowerCase();
  const forSelf = !!body.forSelf;
  const recipientName = forSelf ? buyerName : clean(body.recipientName, 80);
  const recipientEmail = forSelf ? buyerEmail : clean(body.recipientEmail, 120).toLowerCase();
  const message = forSelf ? "" : clean(body.message, 500);

  if (!sourceId || !/^[\w-]{8,36}$/.test(key)) return send(res, 400, { error: "Payment details are missing. Please try again." });
  if (!buyerName || !isEmail(buyerEmail)) return send(res, 400, { error: "Please add your name and a valid email address." });
  if (!recipientName || !isEmail(recipientEmail)) return send(res, 400, { error: "Please add the recipient's name and a valid email address." });

  let order = null, locId = null;
  try {
    const { locationId, services } = await getBusiness();
    locId = locationId;
    const service = services.find((s) => s.variationId === body.variationId && kindOf(s.name) !== "training");
    if (!service) return send(res, 400, { error: "That voucher isn't available. Please choose another." });

    // Buyer as a Square customer, so Emma can see who bought it
    let customerId;
    const found = await sq("/v2/customers/search", { method: "POST", body: { query: { filter: { email_address: { exact: buyerEmail } } }, limit: 1 } });
    if (found.customers?.length) customerId = found.customers[0].id;
    else {
      const [given, ...rest] = buyerName.split(/\s+/);
      const created = await sq("/v2/customers", { method: "POST", body: { idempotency_key: `${key}-cust`, given_name: given, family_name: rest.join(" ") || undefined, email_address: buyerEmail, note: "Bought a gift voucher online" } });
      customerId = created.customer.id;
    }

    const code = newCode();
    const expires = expiryFrom(new Date());
    order = await createVoucherOrder({ key, locationId, customerId, service, amount: service.amount, code, expires, recipientName, recipientEmail, buyerEmail, from: "purchase" });

    const { payment } = await sq("/v2/payments", {
      method: "POST",
      body: {
        idempotency_key: `${key}-pay`,
        source_id: sourceId,
        amount_money: order.total_money,
        order_id: order.id,
        location_id: locationId,
        customer_id: customerId,
        buyer_email_address: buyerEmail,
        autocomplete: true,
        note: `Gift voucher ${order.metadata?.voucher_code || code} – ${service.name}`.slice(0, 500),
      },
    });

    const paid = { ...order, metadata: order.metadata || {} };
    let emailed = false;
    try { emailed = await emailVoucher({ order: paid, fromName: forSelf ? "" : buyerName, buyerName, message }); }
    catch (e) { console.error("Voucher email failed", e); }

    return send(res, 200, {
      code: paid.metadata.voucher_code,
      service: service.name,
      amount: order.total_money.amount,
      expires: paid.metadata.expires,
      expiresText: prettyDate(paid.metadata.expires),
      recipientEmail,
      forSelf,
      emailed,
      receiptUrl: payment?.receipt_url || null,
    });
  } catch (err) {
    console.error(err);
    if (order?.id) {
      await sq(`/v2/orders/${order.id}`, {
        method: "PUT",
        body: { idempotency_key: `${key}-cancel`, order: { location_id: locId, version: order.version, state: "CANCELED" } },
      }).catch((e) => console.error("Could not cancel voucher order", e.message));
    }
    if (err instanceof SquareError) {
      const declined = ["CARD_DECLINED", "CVV_FAILURE", "ADDRESS_VERIFICATION_FAILURE", "INVALID_EXPIRATION", "GENERIC_DECLINE", "INSUFFICIENT_FUNDS", "CARD_DECLINED_VERIFICATION_REQUIRED", "INVALID_CARD"];
      if (declined.includes(err.code)) return send(res, 402, { error: "Your card was declined. Please check the details or try another card. You haven't been charged." });
    }
    return send(res, 500, { error: "Something went wrong and the voucher wasn't bought. You haven't been charged. Please try again or call 0114 470 4565." });
  }
}
