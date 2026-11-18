// Gift vouchers and discount codes.
//
// Vouchers live in Square as orders (source "Website gift voucher"), so Emma sees every voucher in
// Square → Orders and nothing else needs hosting. An unused voucher is an OPEN order with a pickup
// fulfilment; using it completes that fulfilment. The code, treatment and expiry sit in the order's
// metadata. Square's order version number stops the same voucher being used twice at once.
//
// Discount codes are Square discounts (Items → Discounts) whose name is a single word in capitals,
// e.g. WELCOME10. Percentage and fixed-amount discounts both work.
import crypto from "node:crypto";
import { sq, getBusiness, londonDate } from "./_square.js";

export const VOUCHER_SOURCE = "Website gift voucher";
export const VALID_DAYS = 180;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreading

export function newCode() {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `HSE-${pick()}-${pick()}`;
}
// Accepts "hse abcd efgh", "HSEABCDEFGH" etc.
export function normaliseCode(input) {
  const raw = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^HSE[A-Z0-9]{8}$/.test(raw)) return `HSE-${raw.slice(3, 7)}-${raw.slice(7)}`;
  return raw;
}
export const looksLikeVoucher = (code) => /^HSE-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);

export function expiryFrom(date = new Date()) {
  return londonDate(new Date(date.getTime() + VALID_DAYS * 86400e3)); // YYYY-MM-DD, valid to the end of that day
}
export const prettyDate = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

// ---------- Finding vouchers ----------
export async function listVoucherOrders(locationId, states = ["OPEN", "COMPLETED"]) {
  const out = [];
  let cursor;
  do {
    const page = await sq("/v2/orders/search", {
      method: "POST",
      body: {
        location_ids: [locationId],
        cursor,
        limit: 500,
        query: {
          filter: {
            source_filter: { source_names: [VOUCHER_SOURCE] },
            state_filter: { states },
            date_time_filter: { created_at: { start_at: new Date(Date.now() - 400 * 86400e3).toISOString() } },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
        },
      },
    });
    out.push(...(page.orders || []));
    cursor = page.cursor;
  } while (cursor);
  return out;
}

const PENDING_MS = 10 * 60 * 1000;
export function voucherState(order, now = new Date()) {
  const md = order?.metadata || {};
  if (!order || !md.voucher_code || order.state === "CANCELED") return "invalid";
  if (Number(order.net_amount_due_money?.amount || 0) > 0) return "invalid"; // never paid for
  const r = md.redeemed_booking;
  if (r && r !== "released") {
    if (!r.startsWith("pending:")) return "used";
    if (now.getTime() - Number(r.split(":")[1] || 0) < PENDING_MS) return "used"; // someone is booking with it right now
  }
  if (order.state === "COMPLETED") return "used";
  if (londonDate(now) > md.expires) return "expired";
  return "active";
}

export async function findVoucher(code, locationId) {
  const orders = await listVoucherOrders(locationId);
  return orders.find((o) => o.metadata?.voucher_code === code) || null;
}

// ---------- Creating ----------
// Creates the voucher order. Paid vouchers are then paid against it; reissued ones are £0.
export async function createVoucherOrder({ key, locationId, customerId, service, amount, code, expires, recipientName, recipientEmail, buyerEmail, from }) {
  const label = `${service.name} gift voucher`;
  const { order } = await sq("/v2/orders", {
    method: "POST",
    body: {
      idempotency_key: `${key}-voucher`.slice(0, 192),
      order: {
        location_id: locationId,
        customer_id: customerId || undefined,
        reference_id: code,
        source: { name: VOUCHER_SOURCE },
        line_items: [{
          name: label,
          quantity: "1",
          note: `Code ${code} · valid until ${prettyDate(expires)}`,
          base_price_money: { amount, currency: service.currency || "GBP" },
        }],
        fulfillments: [{
          type: "PICKUP",
          state: "PROPOSED",
          pickup_details: {
            schedule_type: "ASAP",
            recipient: { display_name: recipientName.slice(0, 255), email_address: recipientEmail },
            note: `Gift voucher ${code} for one ${service.name}, valid until ${prettyDate(expires)}. Used automatically when booked online. If booked by phone, mark as picked up.`.slice(0, 500),
          },
        }],
        metadata: {
          voucher_code: code,
          variation_id: service.variationId,
          service: service.name.slice(0, 255),
          expires,
          recipient_name: recipientName.slice(0, 255) || "-",
          recipient_email: recipientEmail.slice(0, 255),
          buyer_email: (buyerEmail || recipientEmail).slice(0, 255),
          from: from || "purchase",
        },
      },
    },
  });
  return order;
}

// Marks a voucher as used by a booking. `version` makes it fail if anyone else changed it first.
export async function markVoucher(order, value, { complete = false, key }) {
  const body = {
    idempotency_key: key.slice(0, 192),
    order: {
      location_id: order.location_id,
      version: order.version,
      metadata: { ...order.metadata, redeemed_booking: value, ...(complete ? { redeemed_at: new Date().toISOString() } : {}) },
    },
  };
  const uid = order.fulfillments?.[0]?.uid;
  if (complete && uid) {
    try {
      const out = await sq(`/v2/orders/${order.id}`, { method: "PUT", body: { ...body, order: { ...body.order, fulfillments: [{ uid, state: "COMPLETED" }] } } });
      return out.order;
    } catch (e) {
      console.error("Could not complete voucher fulfilment; recording use in metadata only", e.message);
    }
  }
  const out = await sq(`/v2/orders/${order.id}`, { method: "PUT", body: { ...body, idempotency_key: `${key}-md`.slice(0, 192) } });
  return out.order;
}

// ---------- Discount codes from Square ----------
let discountCache = { at: 0, list: [] };
export async function getDiscounts() {
  if (Date.now() - discountCache.at < 60 * 1000) return discountCache.list;
  const list = [];
  let cursor;
  do {
    const q = new URLSearchParams({ types: "DISCOUNT" });
    if (cursor) q.set("cursor", cursor);
    const page = await sq(`/v2/catalog/list?${q}`);
    for (const o of page.objects || []) {
      const d = o.discount_data;
      if (!d || o.is_deleted) continue;
      const name = String(d.name || "").trim();
      if (!/^[A-Z0-9-]{3,24}$/.test(name)) continue; // only single-word capitals are website codes
      if (d.discount_type === "FIXED_PERCENTAGE" && d.percentage) list.push({ code: name, percent: Number(d.percentage) });
      else if (d.discount_type === "FIXED_AMOUNT" && d.amount_money) list.push({ code: name, pence: Number(d.amount_money.amount) });
    }
    cursor = page.cursor;
  } while (cursor);
  discountCache = { at: Date.now(), list };
  return list;
}

export function applyDiscount(d, amount) {
  const saving = d.percent != null ? Math.round((amount * d.percent) / 100) : Math.min(d.pence, amount);
  return { saving, amount: Math.max(0, amount - saving), label: d.percent != null ? `${+d.percent.toFixed(2)}% off` : `£${(d.pence / 100).toFixed(d.pence % 100 ? 2 : 0)} off` };
}

// Works out what a booking costs with an optional code. Never trusts the browser for prices.
// Returns { amount, code, kind: "voucher"|"discount"|null, voucher, saving, label } or { error }.
export async function priceWithCode({ service, base, code: rawCode, locationId }) {
  const code = normaliseCode(rawCode);
  if (!code) return { amount: base, kind: null };
  if (looksLikeVoucher(code)) {
    const order = await findVoucher(code, locationId);
    const st = voucherState(order);
    if (st === "invalid") return { error: "We can't find that voucher code. Please check it and try again." };
    if (st === "used") return { error: "That voucher has already been used." };
    if (st === "expired") return { error: `That voucher expired on ${prettyDate(order.metadata.expires)}. Please call 0114 470 4565.` };
    if (order.metadata.variation_id !== service.variationId && order.metadata.service !== service.name) {
      return { error: `That voucher is for ${order.metadata.service}. Please choose that treatment to use it.` };
    }
    return { amount: 0, kind: "voucher", code, voucher: order, saving: base, label: `${code} (one ${order.metadata.service})` };
  }
  const d = (await getDiscounts()).find((x) => x.code === code);
  if (!d) return { error: "That code isn't valid." };
  const r = applyDiscount(d, base);
  return { amount: r.amount, kind: "discount", code, saving: r.saving, label: `${code}: ${r.label}` };
}

// ---------- Sending emails (Resend) ----------
export const EMMA_EMAIL = "holisticsolutionswithemma@gmail.com";
const FROM = () => process.env.VOUCHER_FROM || "Holistic Solutions with Emma <vouchers@holisticsolutionswithemma.co.uk>";

export async function sendEmail({ to, subject, html, text, bcc }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error("RESEND_API_KEY not set: email not sent to", to); return false; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM(), to: [to], bcc: bcc ? [bcc] : undefined, reply_to: EMMA_EMAIL, subject, html, text }),
  });
  if (!res.ok) { console.error("Email failed", res.status, await res.text()); return false; }
  return true;
}

const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SITE = "https://www.holisticsolutionswithemma.co.uk";

export function voucherEmail({ recipientName, fromName, message, serviceName, code, expires, reissued = false }) {
  const until = prettyDate(expires);
  const hi = recipientName ? `Hello ${escHtml(recipientName.split(" ")[0])},` : "Hello,";
  const intro = reissued
    ? "Your appointment was cancelled in good time, so here is your gift voucher again with a new code. Your original code no longer works."
    : fromName ? `${escHtml(fromName)} has sent you a gift voucher for a treatment with Emma at Holistic Solutions.` : "Here is your gift voucher for a treatment with Emma at Holistic Solutions.";
  const html = `<!doctype html><html><body style="margin:0;background:#f4eef7;font-family:Arial,Helvetica,sans-serif;color:#2a1433">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4eef7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td align="center" bgcolor="#7a10b0" style="background:#7a10b0;padding:28px 24px">
<img src="${SITE}/brand/mark-light.png" width="80" alt="Holistic Solutions with Emma" style="display:block;border:0;width:80px;height:auto;margin:0 auto 12px">
<div style="font-family:Georgia,serif;font-style:italic;font-size:24px;color:#faf6f0">Holistic Solutions</div>
<div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#e9d6f5;margin-top:4px">with Emma</div></td></tr>
<tr><td style="padding:30px 32px 6px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a10b0;font-weight:bold">Gift voucher</p>
<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-style:italic;font-weight:normal;font-size:28px">One ${escHtml(serviceName)}</h1>
<p style="margin:0 0 12px;font-size:16px;line-height:1.6">${hi}</p>
<p style="margin:0 0 12px;font-size:16px;line-height:1.6">${intro}</p>
${message ? `<p style="margin:0 0 12px;padding:14px 16px;background:#faf6f0;border-left:3px solid #7a10b0;font-style:italic;font-size:16px;line-height:1.6">${escHtml(message).replace(/\n/g, "<br>")}</p>` : ""}
</td></tr>
<tr><td style="padding:8px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3e4fa;border-radius:14px"><tr><td align="center" style="padding:24px 20px">
<p style="margin:0 0 6px;font-size:13px;color:#6c5877">Your voucher code</p>
<p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:30px;letter-spacing:3px;font-weight:bold;color:#2a1433">${code}</p>
<p style="margin:0 0 18px;font-size:14px;color:#2a1433">For one ${escHtml(serviceName)} · valid until <b>${until}</b></p>
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td bgcolor="#7a10b0" style="background:#7a10b0;border-radius:999px">
<a href="${SITE}/#book" style="display:inline-block;padding:13px 28px;font-size:16px;font-weight:bold;color:#fff;text-decoration:none">Book your treatment</a></td></tr></table>
</td></tr></table></td></tr>
<tr><td style="padding:20px 32px 28px;font-size:15px;line-height:1.6">
<p style="margin:0 0 8px"><b>How to use it</b></p>
<p style="margin:0 0 6px">1. Go to holisticsolutionswithemma.co.uk and choose ${escHtml(serviceName)}.</p>
<p style="margin:0 0 6px">2. Pick a date and time and add your details.</p>
<p style="margin:0 0 14px">3. On the payment step, enter your code and press Apply. There's nothing to pay.</p>
<p style="margin:0;font-size:13px;color:#6c5877">Prefer to book by phone? Call Emma on 0114 470 4565 and quote your code. The voucher can be used once, for the treatment shown, and expires on ${until}. <a href="${SITE}/terms#vouchers" style="color:#7a10b0">Voucher terms</a></p>
</td></tr>
<tr><td align="center" bgcolor="#46056a" style="background:#46056a;padding:20px;font-size:13px;line-height:1.6;color:#e9d6f5">
<b style="color:#faf6f0">Holistic Solutions with Emma</b><br>341 Middlewood Road, Hillsborough, Sheffield S6 1TH · 0114 470 4565</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${hi.replace(/<[^>]+>/g, "")}\n\n${intro.replace(/&[a-z#0-9]+;/g, "")}\n${message ? `\n"${message}"\n` : ""}\nYour voucher code: ${code}\nFor: one ${serviceName}\nValid until: ${until}\n\nHow to use it: book at ${SITE}, choose ${serviceName}, and enter your code on the payment step. Or call Emma on 0114 470 4565 and quote your code.\n\nTerms: ${SITE}/terms#vouchers\n\nHolistic Solutions with Emma, 341 Middlewood Road, Hillsborough, Sheffield S6 1TH`;
  return { html, text };
}

// Sends the voucher to the recipient (Emma gets a copy), and a confirmation to the buyer if different.
export async function emailVoucher({ order, fromName, buyerName, message, reissued = false }) {
  const md = order.metadata;
  const { html, text } = voucherEmail({ recipientName: md.recipient_name === "-" ? "" : md.recipient_name, fromName, message, serviceName: md.service, code: md.voucher_code, expires: md.expires, reissued });
  const subject = reissued ? `Your gift voucher for ${md.service} (new code)` : `${fromName ? `${fromName} has sent you` : "Your"} gift voucher for ${md.service}`;
  const sent = await sendEmail({ to: md.recipient_email, subject, html, text, bcc: EMMA_EMAIL });
  if (!reissued && md.buyer_email && md.buyer_email !== md.recipient_email) {
    await sendEmail({
      to: md.buyer_email,
      subject: `Your gift voucher for ${md.service} has been sent`,
      text: `Hello${buyerName ? ` ${buyerName.split(" ")[0]}` : ""},\n\nThank you for buying a gift voucher for ${md.service}. We've emailed it to ${md.recipient_email}.\n\nCode: ${md.voucher_code}\nValid until: ${prettyDate(md.expires)}\n\nIf it doesn't arrive, ask them to check their junk folder, or reply to this email.\n\nEmma\nHolistic Solutions with Emma · 0114 470 4565`,
      html: `<p>Hello${buyerName ? ` ${escHtml(buyerName.split(" ")[0])}` : ""},</p><p>Thank you for buying a gift voucher for <b>${escHtml(md.service)}</b>. We've emailed it to <b>${escHtml(md.recipient_email)}</b>.</p><p>Code: <b style="font-family:monospace;font-size:18px">${md.voucher_code}</b><br>Valid until: ${prettyDate(md.expires)}</p><p>If it doesn't arrive, ask them to check their junk folder, or reply to this email.</p><p>Emma<br>Holistic Solutions with Emma · 0114 470 4565</p>`,
    });
  }
  return sent;
}

// ---------- Cancellations ----------
// A voucher booking cancelled in good time (or by Emma) gets a fresh voucher, same treatment and expiry.
// Safe to call more than once for the same booking: only one replacement is ever made and emailed.
export async function reissueVoucherForBooking(booking) {
  const { locationId, services } = await getBusiness();
  const orders = await listVoucherOrders(locationId);
  const used = orders.find((o) => o.metadata?.redeemed_booking === booking.id);
  if (!used) return null; // not a voucher booking
  if (orders.some((o) => o.metadata?.from === booking.id)) return { already: true };
  const md = used.metadata;
  const service = services.find((s) => s.variationId === md.variation_id) || { name: md.service, variationId: md.variation_id, currency: "GBP" };
  const code = newCode();
  const order = await createVoucherOrder({
    key: `reissue-${booking.id}`, locationId, customerId: booking.customer_id, service, amount: 0, code,
    expires: md.expires, recipientName: md.recipient_name === "-" ? "" : md.recipient_name, recipientEmail: md.recipient_email, buyerEmail: md.buyer_email, from: booking.id,
  });
  if (order.metadata?.voucher_code !== code) return { already: true }; // Square returned the replacement made by an earlier call
  await emailVoucher({ order, reissued: true });
  return { reissued: true, code, email: md.recipient_email };
}
