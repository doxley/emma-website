/* Gift vouchers: choose a treatment, say who it's for, pay with Square. The code is emailed straight away. */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (p, cur = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, minimumFractionDigits: p % 100 ? 2 : 0 }).format(p / 100);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Order and wording of the vouchers on offer. Prices come from Square.
const KINDS = [
  { key: "reiki", match: (n) => /reiki/i.test(n) && !/distance/i.test(n), label: "Reiki", sub: "In person · 60 minutes" },
  { key: "distance-reiki", match: (n) => /distance/i.test(n), label: "Distance Reiki", sub: "From home · 60 minutes" },
  { key: "reflexology", match: (n) => /reflex/i.test(n), label: "Reflexology", sub: "In person · 60 minutes" },
  { key: "tarot", match: (n) => /tarot/i.test(n) && !/online|training/i.test(n), label: "Tarot reading", sub: "In person · 60 minutes" },
  { key: "online-tarot", match: (n) => /online/i.test(n) && /tarot/i.test(n), label: "Online tarot reading", sub: "Video call · 60 minutes" },
];

const st = { config: null, vouchers: [], pick: null, card: null, payments: null };

async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || "Something went wrong. Please try again."); e.data = data; throw e; }
  return data;
}

function renderList() {
  const box = $("vlist");
  if (!st.vouchers.length) { box.innerHTML = `<p class="muted">Vouchers can't be bought online right now. Please call 0114 470 4565.</p>`; return; }
  box.innerHTML = st.vouchers.map((v, i) => `<button type="button" class="choice" aria-pressed="${st.pick === v}" data-i="${i}">
    <span><b>${esc(v.label)} voucher</b><br><span class="muted">${esc(v.sub)}</span></span>
    <span class="price" style="font-size:1.3rem">${money(v.service.amount, v.service.currency)}</span></button>`).join("");
  box.querySelectorAll("button").forEach((b) => b.onclick = () => { st.pick = st.vouchers[+b.dataset.i]; renderList(); renderSummary(); });
}

function renderSummary() {
  const v = st.pick, pay = $("pay");
  $("vsum").innerHTML = v
    ? `<div><dt>Voucher</dt><dd>One ${esc(v.label)}</dd></div><div><dt>Valid for</dt><dd>180 days from today</dd></div><div class="total"><dt>To pay</dt><dd>${money(v.service.amount, v.service.currency)}</dd></div>`
    : `<div><dt>Voucher</dt><dd class="muted">Choose one above</dd></div>`;
  pay.textContent = v ? `Pay ${money(v.service.amount, v.service.currency)}` : "Pay";
}

function whoChanged() {
  const self = document.querySelector('input[name="who"]:checked').value === "self";
  $("giftFields").hidden = self;
  $("bnote").textContent = self ? "We'll email your voucher here straight away." : "We'll send you a confirmation and a copy of the code.";
}

async function mountCard() {
  const sc = document.createElement("script");
  sc.src = st.config.env === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
  await new Promise((ok, fail) => { sc.onload = ok; sc.onerror = fail; document.head.appendChild(sc); });
  st.payments = window.Square.payments(st.config.appId, st.config.locationId);
  st.card = await st.payments.card();
  $("card-container").innerHTML = "";
  await st.card.attach("#card-container");
  $("pay").disabled = false;
}

async function submit(e) {
  e.preventDefault();
  const err = $("err"), pay = $("pay");
  err.textContent = "";
  const self = document.querySelector('input[name="who"]:checked').value === "self";
  const d = {
    buyerName: $("bname").value.trim(), buyerEmail: $("bemail").value.trim(),
    recipientName: $("rname").value.trim(), recipientEmail: $("remail").value.trim(), message: $("msg").value.trim(),
  };
  const missing = [];
  if (!st.pick) missing.push("a voucher");
  if (!self && !d.recipientName) missing.push("their name");
  if (!self && !isEmail(d.recipientEmail)) missing.push("their email");
  if (!d.buyerName) missing.push("your name");
  if (!isEmail(d.buyerEmail)) missing.push("your email");
  if (missing.length) { err.textContent = `Please add ${missing.join(", ")}.`; return; }
  if (!$("agree").checked) { err.textContent = "Please tick to agree to the voucher terms."; return; }

  pay.disabled = true; const label = pay.textContent; pay.textContent = "Processing…";
  try {
    const v = st.pick.service;
    const tok = await st.card.tokenize({
      amount: (v.amount / 100).toFixed(2), currencyCode: v.currency, intent: "CHARGE", customerInitiated: true, sellerKeyedIn: false,
      billingContact: { givenName: d.buyerName.split(" ")[0], familyName: d.buyerName.split(" ").slice(1).join(" "), email: d.buyerEmail, countryCode: "GB" },
    });
    if (tok.status !== "OK") throw new Error(tok.errors?.[0]?.message || "Please check your card details.");
    st.key ||= crypto.randomUUID();
    const r = await api("/api/voucher-buy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: tok.token, idempotencyKey: st.key, variationId: v.variationId, forSelf: self, ...d }),
    });
    st.key = null;
    try { await st.card.destroy(); } catch {}
    $("vform").hidden = true;
    const done = $("vdone");
    done.hidden = false;
    done.innerHTML = `<div class="done-box"><div class="tick"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h3 style="margin:0">Thank you, ${esc(d.buyerName.split(" ")[0])}</h3>
      <p class="muted" style="max-width:34em">${r.emailed
        ? (r.forSelf ? `Your ${esc(r.service)} voucher is on its way to ${esc(r.recipientEmail)}.` : `The ${esc(r.service)} voucher is on its way to ${esc(r.recipientEmail)}, and we've sent you a confirmation.`)
        : `Your voucher is ready. We couldn't email it automatically just now, so please keep the code below safe. Emma will also send it on.`}</p>
      <p class="vcode">${esc(r.code)}</p>
      <p class="muted">For one ${esc(r.service)} · valid until ${esc(r.expiresText)}</p>
      ${r.receiptUrl ? `<a class="btn ghost" href="${esc(r.receiptUrl)}" target="_blank" rel="noopener">View receipt</a>` : ""}</div>`;
    done.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e2) {
    err.textContent = e2.message;
    pay.disabled = false; pay.textContent = label;
  }
}

(async function boot() {
  document.querySelectorAll('input[name="who"]').forEach((r) => r.onchange = whoChanged);
  whoChanged();
  $("vform").onsubmit = submit;
  try {
    st.config = await api("/api/config");
    const services = st.config.services.filter((s) => !/training|workshop|course/i.test(s.name));
    // Vouchers are sold at the normal price (offers don't apply to vouchers).
    st.vouchers = KINDS.map((k) => { const s = services.find((x) => k.match(x.name)); return s && { ...k, service: { ...s, amount: s.wasAmount || s.amount } }; }).filter(Boolean);
    const want = new URLSearchParams(location.search).get("v");
    st.pick = st.vouchers.find((v) => v.key === want) || null;
    renderList(); renderSummary();
  } catch (e) {
    console.error(e);
    $("vlist").innerHTML = `<p class="muted">Vouchers can't be bought online right now. Please call 0114 470 4565.</p>`;
    $("card-container").innerHTML = "";
    return;
  }
  try { await mountCard(); }
  catch (e) { console.error(e); $("card-container").innerHTML = `<p class="err">The card form couldn't load. Please refresh the page, or call 0114 470 4565.</p>`; }
})();
