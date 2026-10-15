/* Crystals & Gifts shop: products from Square, basket, collect or Evri postage, Square card checkout. */
const PHONE = "0114 470 4565";
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (p) => "£" + (p / 100).toFixed(2).replace(/\.00$/, "");
const RANK = { letterbox: 1, small: 2, large: 3, heavy: 4 };

const grid = document.getElementById("products");
const basketEl = document.getElementById("basket");
const countEl = document.getElementById("basketCount");

const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { data });
  return data;
};

let shop = { products: [], postage: [] };
let config = null;
let basket = load();
let step = "basket"; // basket | details | pay | done
let form = { fulfilment: "post", givenName: "", familyName: "", email: "", phone: "", line1: "", line2: "", city: "", postcode: "", note: "" };
let result = null;

function load() { try { return JSON.parse(localStorage.getItem("emma-basket") || "[]"); } catch { return []; } }
function save() { try { localStorage.setItem("emma-basket", JSON.stringify(basket)); } catch {} }

const findVar = (id) => { for (const p of shop.products) { const v = p.variations.find((x) => x.id === id); if (v) return { p, v }; } return null; };
const lineLabel = (p, v) => (p.variations.length > 1 && v.name ? `${p.name} (${v.name})` : p.name);

function totals() {
  let subtotal = 0, size = null;
  for (const b of basket) {
    const hit = findVar(b.id); if (!hit) continue;
    subtotal += hit.v.amount * b.qty;
    if (!size || RANK[hit.p.size] > RANK[size]) size = hit.p.size;
  }
  const rate = shop.postage.find((x) => x.size === size);
  const postage = form.fulfilment === "post" && rate ? rate : null;
  return { subtotal, postage, total: subtotal + (postage ? postage.amount : 0) };
}

/* ---------- Products ---------- */
function renderProducts() {
  if (!shop.products.length) {
    grid.innerHTML = `<div class="shop-empty"><img src="/brand/mark.png" alt="" width="90"><h3>New crystals and gifts are on their way</h3><p class="muted">Pop into Middlewood Road to see what's in, or call ${PHONE}.</p></div>`;
    return;
  }
  grid.innerHTML = shop.products.map((p, i) => {
    const v0 = p.variations.find((v) => v.available) || p.variations[0];
    const anyAvail = p.variations.some((v) => v.available);
    return `<article class="product">
      <div class="ph">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">` : `<img class="ph-mark" src="/brand/mark.png" alt="">`}</div>
      <div class="pbody">
        <h3>${esc(p.name)}</h3>
        ${p.description ? `<p class="muted pdesc">${esc(p.description)}</p>` : ""}
        ${p.variations.length > 1 ? `<label class="sr" for="v${i}">Option</label><select id="v${i}" data-p="${i}">${p.variations.map((v) => `<option value="${v.id}" ${v.available ? "" : "disabled"} ${v.id === v0.id ? "selected" : ""}>${esc(v.name)} – ${money(v.amount)}${v.available ? "" : " (sold out)"}</option>`).join("")}</select>` : ""}
        <div class="pfoot">
          <div><div class="price" id="pr${i}">${money(v0.amount)}</div><div class="stock" id="st${i}">${stockText(v0)}</div></div>
          <button class="btn" data-add="${i}" ${anyAvail ? "" : "disabled"}>${anyAvail ? "Add to basket" : "Sold out"}</button>
        </div>
      </div></article>`;
  }).join("");
  grid.querySelectorAll("select[data-p]").forEach((s) => s.onchange = () => {
    const i = +s.dataset.p, v = shop.products[i].variations.find((x) => x.id === s.value);
    document.getElementById("pr" + i).textContent = money(v.amount);
    document.getElementById("st" + i).textContent = stockText(v);
  });
  grid.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.add, p = shop.products[i];
    const sel = document.getElementById("v" + i);
    const v = sel ? p.variations.find((x) => x.id === sel.value) : p.variations[0];
    if (!v.available) return;
    const line = basket.find((x) => x.id === v.id);
    const max = v.stock ?? 20;
    if (line) line.qty = Math.min(max, line.qty + 1); else basket.push({ id: v.id, qty: 1 });
    save(); step = "basket"; renderBasket();
    b.textContent = "Added ✓"; setTimeout(() => (b.textContent = "Add to basket"), 1200);
    if (matchMedia("(max-width: 900px)").matches) basketEl.scrollIntoView({ behavior: "smooth" });
  });
}
const stockText = (v) => (!v.available ? "Sold out" : v.lowStock ? `Only ${v.lowStock} left` : "In stock");

/* ---------- Basket & checkout ---------- */
function renderBasket() {
  basket = basket.filter((b) => findVar(b.id));
  save();
  countEl.textContent = basket.reduce((n, b) => n + b.qty, 0);
  const t = totals();

  if (step === "done") {
    const r = result;
    basketEl.innerHTML = `<div class="done-box"><div class="tick"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h3 style="margin:0">Thank you, ${esc(form.givenName)}</h3>
      <p class="muted">You've paid ${esc(r.totalText)}. ${r.fulfilment === "post" ? "Emma will post your order by Evri and let you know when it's on its way." : "Emma will let you know when your order is ready to collect from 341 Middlewood Road."}</p>
      ${r.receiptUrl ? `<a class="btn ghost" href="${esc(r.receiptUrl)}" target="_blank" rel="noopener">View receipt</a>` : ""}
      <button class="btn" id="again">Keep shopping</button></div>`;
    basketEl.querySelector("#again").onclick = () => { step = "basket"; renderBasket(); };
    return;
  }

  if (!basket.length) {
    basketEl.innerHTML = `<h3>Your basket</h3><p class="muted">Your basket is empty. Add something lovely from the shop.</p>`;
    return;
  }

  const summary = `
    <ul class="lines">${basket.map((b) => { const { p, v } = findVar(b.id); return `
      <li><span class="lname">${esc(lineLabel(p, v))}</span>
        ${step === "basket" ? `<span class="qty"><button aria-label="One fewer" data-dec="${b.id}">−</button><b>${b.qty}</b><button aria-label="One more" data-inc="${b.id}" ${v.stock !== null && b.qty >= v.stock ? "disabled" : ""}>+</button></span>` : `<span class="muted">× ${b.qty}</span>`}
        <span class="lprice">${money(v.amount * b.qty)}</span></li>`; }).join("")}
    </ul>
    <dl class="sums">
      <div><dt>Items</dt><dd>${money(t.subtotal)}</dd></div>
      <div><dt>${form.fulfilment === "post" ? `Postage (${esc(t.postage?.label || "")}, Evri)` : "Collection"}</dt><dd>${t.postage ? money(t.postage.amount) : "Free"}</dd></div>
      <div class="total"><dt>Total</dt><dd>${money(t.total)}</dd></div>
    </dl>`;

  if (step === "basket") {
    basketEl.innerHTML = `<h3>Your basket</h3>${summary}
      <fieldset class="fulfil"><legend>How would you like it?</legend>
        <label class="radio"><input type="radio" name="ful" value="post" ${form.fulfilment === "post" ? "checked" : ""}> <span><b>Post it to me</b><br><span class="muted">UK delivery by Evri, ${esc(t.postage ? money(t.postage.amount) : "")}</span></span></label>
        <label class="radio"><input type="radio" name="ful" value="collect" ${form.fulfilment === "collect" ? "checked" : ""}> <span><b>I'll collect it</b><br><span class="muted">Free, from 341 Middlewood Road, S6 1TH</span></span></label>
      </fieldset>
      <button class="btn wide" id="go">Checkout</button>`;
    basketEl.querySelectorAll("[data-inc]").forEach((x) => x.onclick = () => { const l = basket.find((b) => b.id === x.dataset.inc); l.qty++; save(); renderBasket(); });
    basketEl.querySelectorAll("[data-dec]").forEach((x) => x.onclick = () => { const l = basket.find((b) => b.id === x.dataset.dec); l.qty--; basket = basket.filter((b) => b.qty > 0); save(); renderBasket(); });
    basketEl.querySelectorAll("input[name=ful]").forEach((x) => x.onchange = () => { form.fulfilment = x.value; renderBasket(); });
    basketEl.querySelector("#go").onclick = () => { step = "details"; renderBasket(); };
    return;
  }

  if (step === "details") {
    const post = form.fulfilment === "post";
    basketEl.innerHTML = `<h3>Your details</h3>
      <form class="form" id="f" novalidate>
        <label>First name<input id="givenName" autocomplete="given-name" value="${esc(form.givenName)}"></label>
        <label>Last name<input id="familyName" autocomplete="family-name" value="${esc(form.familyName)}"></label>
        <label class="full">Email<input id="email" type="email" autocomplete="email" value="${esc(form.email)}"></label>
        <label class="full">Mobile number<input id="phone" type="tel" autocomplete="tel" value="${esc(form.phone)}"></label>
        ${post ? `
        <label class="full">Address<input id="line1" autocomplete="address-line1" value="${esc(form.line1)}"></label>
        <label class="full">Address line 2 <span class="muted" style="font-weight:400">(optional)</span><input id="line2" autocomplete="address-line2" value="${esc(form.line2)}"></label>
        <label>Town or city<input id="city" autocomplete="address-level2" value="${esc(form.city)}"></label>
        <label>Postcode<input id="postcode" autocomplete="postal-code" value="${esc(form.postcode)}"></label>` : ""}
        <label class="full">Note for Emma <span class="muted" style="font-weight:400">(optional)</span><input id="note" value="${esc(form.note)}" placeholder="${post ? "e.g. it's a gift" : "e.g. when you'd like to collect"}"></label>
        <p class="err full" id="err"></p>
        <div class="panel-foot full" style="margin-top:0"><button type="button" class="btn ghost" id="back">Back</button><button class="btn" type="submit">Continue to payment</button></div>
      </form>`;
    const keys = ["givenName", "familyName", "email", "phone", "note", ...(post ? ["line1", "line2", "city", "postcode"] : [])];
    const keep = () => keys.forEach((k) => (form[k] = basketEl.querySelector("#" + k).value.trim()));
    basketEl.querySelector("#back").onclick = () => { keep(); step = "basket"; renderBasket(); };
    basketEl.querySelector("#f").onsubmit = (e) => {
      e.preventDefault(); keep();
      const miss = [];
      if (!form.givenName) miss.push("your first name");
      if (!/^\S+@\S+\.\S+$/.test(form.email)) miss.push("a valid email");
      if (form.phone.replace(/\D/g, "").length < 10) miss.push("a mobile number");
      if (post && (!form.line1 || !form.city)) miss.push("your address");
      if (post && !/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(form.postcode)) miss.push("a UK postcode");
      if (miss.length) return (basketEl.querySelector("#err").textContent = "Please add " + miss.join(", ") + ".");
      step = "pay"; renderBasket();
    };
    return;
  }

  if (step === "pay") {
    basketEl.innerHTML = `<h3>Pay</h3>${summary}
      <p class="muted" style="font-size:.9rem">${form.fulfilment === "post" ? `Posting to ${esc(form.line1)}, ${esc(form.city)} ${esc(form.postcode.toUpperCase())}` : "Collecting from 341 Middlewood Road"}</p>
      <div id="card-container" class="card-box"><p class="muted">Loading secure card form…</p></div>
      <p class="err" id="err" role="alert"></p>
      <div class="panel-foot"><button class="btn ghost" id="back">Back</button><button class="btn" id="pay" disabled>Pay ${money(t.total)}</button></div>`;
    basketEl.querySelector("#back").onclick = () => { destroyCard(); step = "details"; renderBasket(); };
    mountCard(t.total);
  }
}

/* ---------- Square card form ---------- */
let payments = null, card = null, sdk = null;
function loadSdk(envName) {
  sdk ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = envName === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
    s.onload = ok; s.onerror = () => { sdk = null; fail(new Error("Card form failed to load")); };
    document.head.appendChild(s);
  });
  return sdk;
}
async function destroyCard() { try { await card?.destroy(); } catch {} card = null; }

async function mountCard(total) {
  const err = basketEl.querySelector("#err"), pay = basketEl.querySelector("#pay"), box = basketEl.querySelector("#card-container");
  try {
    config ||= await api("/api/config");
    await loadSdk(config.env);
    payments ||= window.Square.payments(config.appId, config.locationId);
    await destroyCard();
    box.innerHTML = "";
    card = await payments.card();
    await card.attach("#card-container");
    pay.disabled = false;
  } catch (e) {
    box.innerHTML = "";
    err.textContent = `The card form couldn't load. Please refresh the page, or call ${PHONE} to order.`;
    return;
  }
  pay.onclick = async () => {
    err.textContent = ""; pay.disabled = true; const label = pay.textContent; pay.textContent = "Processing…";
    try {
      const tok = await card.tokenize({
        amount: (total / 100).toFixed(2), currencyCode: "GBP", intent: "CHARGE", customerInitiated: true, sellerKeyedIn: false,
        billingContact: { givenName: form.givenName, familyName: form.familyName, email: form.email, phone: form.phone, countryCode: "GB",
          ...(form.fulfilment === "post" ? { addressLines: [form.line1, form.line2].filter(Boolean), city: form.city, postalCode: form.postcode } : {}) },
      });
      if (tok.status !== "OK") throw new Error(tok.errors?.[0]?.message || "Please check your card details.");
      result = await api("/api/order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: tok.token, idempotencyKey: crypto.randomUUID(),
          items: basket.map((b) => ({ variationId: b.id, qty: b.qty })),
          fulfilment: form.fulfilment,
          givenName: form.givenName, familyName: form.familyName, email: form.email, phone: form.phone, note: form.note,
          address: { line1: form.line1, line2: form.line2, city: form.city, postcode: form.postcode },
        }),
      });
      await destroyCard();
      basket = []; save(); step = "done"; renderBasket(); refresh();
    } catch (e) {
      err.textContent = e.message;
      if (e.data?.code === "STOCK") { await refresh(); }
      pay.disabled = false; pay.textContent = label;
    }
  };
}

async function refresh() {
  try { shop = await api("/api/shop"); } catch (e) { grid.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  renderProducts(); renderBasket();
}

renderBasket();
refresh();
