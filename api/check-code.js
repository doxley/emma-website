// POST /api/check-code { code, variationId } — checks a gift voucher or discount code for a treatment.
// Returns the new price so the payment step can show it. /api/book checks the code again before charging.
import { getBusiness, send, readJson } from "./_square.js";
import { priceFor } from "./_rules.js";
import { priceWithCode } from "./_vouchers.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Invalid request." }); }
  try {
    const { locationId, services } = await getBusiness();
    const service = services.find((s) => s.variationId === body.variationId);
    if (!service) return send(res, 400, { error: "Please choose a treatment first." });
    const base = priceFor(service).amount;
    const r = await priceWithCode({ service, base, code: body.code, locationId });
    if (r.error) return send(res, 400, { error: r.error });
    if (!r.kind) return send(res, 400, { error: "Please enter a code." });
    return send(res, 200, {
      code: r.code, kind: r.kind, label: r.label, amount: r.amount, saving: r.saving, was: base, currency: service.currency,
      expires: r.voucher?.metadata?.expires || null,
    });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "We couldn't check that code just now. Please try again or call 0114 470 4565." });
  }
}
