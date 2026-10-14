/* Holistic Solutions with Emma — booking flow.
   Services, prices and free times come live from Square; payment uses Square's secure card form. */

// Descriptions shown on the site. Price and duration always come from Square.
const COPY = {
  online: {
    blurb: "A full tarot reading from the comfort of home, on a video or phone call at a time that suits you.",
    points: ["Tuesdays, 12pm to 8pm", "Same depth as an in-person reading", "Ideal if you can't get to Hillsborough"],
    glyph: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><rect x="10" y="6.5" width="4" height="7" rx=".8"/></svg>',
  },
  reiki: {
    blurb: "Gentle hands-on energy healing to ease stress, help you sleep better and leave you feeling lighter.",
    points: ["Fully clothed, lying on a heated couch", "Tailored to what you're carrying right now", "Lovely as a monthly reset"],
    glyph: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3c3 4 3 8 0 11-3-3-3-7 0-11Z"/><path d="M12 14c-4-1-7 0-8 4 4 1 7 0 8-4Zm0 0c4-1 7 0 8 4-4 1-7 0-8-4Z"/></svg>',
  },
  reflexology: {
    blurb: "Pressure on points of the feet that relate to the rest of the body, for circulation, aches and deep relaxation.",
    points: ["Emma explains each step as she goes", "Helpful for tension, swelling and back pain", "Hands can be treated instead of feet"],
    glyph: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 21c-3 0-4-3-4-6s1-7 2-9 3-3 5-2 2 4 1 7-1 4 0 6-1 4-4 4Z"/><circle cx="15" cy="4" r="1"/><circle cx="17.5" cy="6" r=".9"/><circle cx="19" cy="8.6" r=".8"/></svg>',
  },
  tarot: {
    blurb: "A detailed reading with the full 78-card deck for clarity on relationships, work or a change you're facing.",
    points: ["Emma keeps turning cards until the picture is clear", "Supportive through grief and transitions", "Ask about anything, or let the cards lead"],
    glyph: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="3" width="11" height="16" rx="1.5" transform="rotate(-8 10 11)"/><rect x="9" y="5" width="11" height="16" rx="1.5" transform="rotate(8 14 13)"/><path d="M14.5 10.5l.9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3Z"/></svg>',
  },
};
// Shown if Square can't be reached, so the page never looks empty.
const FALLBACK = [
  { name: "Reiki", minutes: 60, amount: 4000, currency: "GBP" },
  { name: "Reflexology", minutes: 60, amount: 4000, currency: "GBP" },
  { name: "Tarot reading", minutes: 60, amount: 4000, currency: "GBP" },
  { name: "Online tarot reading", minutes: 60, amount: 3000, currency: "GBP" },
];
// In-person hours at Middlewood Road. Tuesdays are online tarot only.
const HOURS = { 3: [12, 18], 4: [12, 20], 5: [12, 20] };
const ONLINE_HOURS = { 2: [12, 20] };
const DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PHONE = "0114 470 4565";

const money = (amount, cur = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
const copyFor = (name) => COPY[Object.keys(COPY).find((k) => name.toLowerCase().includes(k.slice(0, 6)))] || { blurb: "", points: [], glyph: COPY.reiki.glyph };
const isOnline = (s) => /online/i.test(s.name);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hm = (m) => { const h = Math.floor(m / 60), mm = m % 60; return (h % 12 || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (h >= 12 ? "pm" : "am"); };
const dayParts = (iso) => { const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d, 12)); return { dow: DAYNAMES[dt.getUTCDay()], d, mon: MON[m - 1] }; };

const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { data, status: r.status });
  return data;
};

/* ---------- Opening status + hours table ---------- */
(function () {
  const now = new Date(), h = HOURS[now.getDay()], mins = now.getHours() * 60 + now.getMinutes();
  const open = h && mins >= h[0] * 60 && mins < h[1] * 60;
  document.getElementById("statusDot").classList.toggle("open", !!open);
  let txt = "";
  if (open) txt = `Open now until ${hm(h[1] * 60)}`;
  else for (let i = 0; i < 8; i++) {
    const x = new Date(now); x.setDate(now.getDate() + i); const hh = HOURS[x.getDay()];
    if (hh && (i > 0 || mins < hh[0] * 60)) { txt = `Closed · opens ${i === 0 ? "today" : i === 1 ? "tomorrow" : DAYNAMES[x.getDay()]} ${hm(hh[0] * 60)}`; break; }
  }
  document.getElementById("statusText").textContent = txt;
  document.getElementById("hours").innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const hh = HOURS[d], oh = ONLINE_HOURS[d];
    const val = hh ? hm(hh[0] * 60) + " – " + hm(hh[1] * 60) : oh ? `Online tarot, ${hm(oh[0] * 60)} – ${hm(oh[1] * 60)}` : "Closed";
    return `<tr class="${d === now.getDay() ? "today" : ""} ${hh || oh ? "" : "closed"}"><td>${DAYNAMES[d]}</td><td>${val}</td></tr>`;
  }).join("");
})();

/* ---------- State ---------- */
const state = { step: 1, config: null, services: FALLBACK, svc: null, days: null, day: null, slot: null, loadErr: null,
  givenName: "", familyName: "", email: "", phone: "", note: "", agree: false, result: null };
const panel = document.getElementById("panel");

function renderServices() {
  document.getElementById("serviceCards").innerHTML = state.services.map((s, i) => {
    const c = copyFor(s.name);
    return `<article class="svc">
      <div class="glyph">${c.glyph}</div>
      <h3>${esc(s.name)}</h3>
      <p>${esc(c.blurb || s.description)}</p>
      <ul>${c.points.map((p) => `<li>${p}</li>`).join("")}</ul>
      <div class="meta">
        <div><div class="price">${money(s.amount, s.currency)}</div><div class="dur">${s.minutes} minutes</div></div>
        <button class="btn" data-book="${i}">Book</button>
      </div></article>`;
  }).join("");
  document.querySelectorAll("[data-book]").forEach((b) => b.onclick = () => {
    if (!state.config) { go(1); return scrollToBook(); }
    pickService(state.services[+b.dataset.book]); scrollToBook();
  });
}
const scrollToBook = () => document.getElementById("book").scrollIntoView();

function setSteps() {
  document.querySelectorAll("#steps li").forEach((li) => {
    const n = +li.dataset.s;
    li.classList.toggle("on", n === state.step);
    li.classList.toggle("done", n < state.step);
  });
}
function go(step) { state.step = step; render(); }

async function pickService(s) {
  if (state.svc !== s) { state.svc = s; state.days = null; state.day = null; state.slot = null; }
  go(2);
  if (!state.days) {
    try {
      const { days } = await api(`/api/availability?service=${encodeURIComponent(s.variationId)}`);
      state.days = days;
      state.day = Object.keys(days)[0] || null;
    } catch (e) { state.loadErr = e.message; }
    render();
  }
}

/* ---------- Steps ---------- */
function render() {
  setSteps();
  const s = state.svc;

  if (state.step === 1) {
    if (!state.config) {
      panel.innerHTML = state.loadErr
        ? `<h3>Booking by phone</h3><p>Online booking isn't available right now. Please call <b>${PHONE}</b> or email holisticsolutionswithemma@gmail.com and Emma will find you a time.</p>`
        : `<h3>Loading treatments…</h3>`;
      return;
    }
    panel.innerHTML = `<h3>Choose a treatment</h3><div class="choices">${state.services.map((x, i) => `
      <button class="choice" aria-pressed="${s === x}" data-i="${i}"><span><b>${esc(x.name)}</b><br><span class="muted">${x.minutes} minutes · ${isOnline(x) ? "online, Tuesdays" : "at Middlewood Road"}</span></span><span class="price" style="font-size:1.3rem">${money(x.amount, x.currency)}</span></button>`).join("")}</div>
      <div class="panel-foot"><span class="muted">Booking for today? Call ${PHONE}.</span></div>`;
    panel.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => pickService(state.services[+b.dataset.i]));
  }

  if (state.step === 2) {
    if (!state.days) {
      panel.innerHTML = state.loadErr
        ? `<h3>${esc(s.name)}</h3><p class="err">${esc(state.loadErr)}</p><div class="panel-foot"><button class="btn ghost" id="back">Back</button></div>`
        : `<h3>${esc(s.name)}: finding free times…</h3>`;
      panel.querySelector("#back")?.addEventListener("click", () => { state.loadErr = null; go(1); });
      return;
    }
    const dates = Object.keys(state.days);
    if (!dates.length) {
      panel.innerHTML = `<h3>${esc(s.name)}</h3><p>There are no free online slots in the next three weeks. Please call <b>${PHONE}</b> and Emma will do her best to fit you in.</p><div class="panel-foot"><button class="btn ghost" id="back">Back</button></div>`;
      panel.querySelector("#back").onclick = () => go(1);
      return;
    }
    panel.innerHTML = `<h3>${esc(s.name)}: pick a date and time</h3>
      <div class="days" role="group" aria-label="Date">${dates.map((d) => { const p = dayParts(d); return `<button class="day" data-day="${d}" aria-pressed="${d === state.day}"><small>${p.dow.slice(0, 3)}</small><b>${p.d}</b><small>${p.mon}</small></button>`; }).join("")}</div>
      <div class="times" role="group" aria-label="Time">${state.days[state.day].map((t) => `<button class="time" data-t="${t.startAt}" aria-pressed="${state.slot?.startAt === t.startAt}">${t.label}</button>`).join("")}</div>
      <div class="panel-foot"><button class="btn ghost" id="back">Back</button><button class="btn" id="next" ${state.slot ? "" : "disabled"}>Continue</button></div>`;
    panel.querySelectorAll("[data-day]").forEach((b) => b.onclick = () => { state.day = b.dataset.day; state.slot = null; render(); });
    panel.querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { state.slot = state.days[state.day].find((t) => t.startAt === b.dataset.t); render(); });
    panel.querySelector("#back").onclick = () => go(1);
    panel.querySelector("#next").onclick = () => go(3);
  }

  if (state.step === 3) {
    panel.innerHTML = `<h3>Your details</h3>
      <form class="form" id="f" novalidate>
        <label>First name<input id="givenName" autocomplete="given-name" value="${esc(state.givenName)}" required></label>
        <label>Last name<input id="familyName" autocomplete="family-name" value="${esc(state.familyName)}"></label>
        <label>Mobile number<input id="phone" type="tel" autocomplete="tel" value="${esc(state.phone)}" required></label>
        <label>Email<input id="email" type="email" autocomplete="email" value="${esc(state.email)}" required></label>
        <label class="full">Anything Emma should know? <span class="muted" style="font-weight:400">(optional)</span><textarea id="note" rows="3" placeholder="Health conditions, pregnancy, or what you'd like to focus on">${esc(state.note)}</textarea></label>
        <label class="check full"><input type="checkbox" id="agree" ${state.agree ? "checked" : ""}> I understand that appointments cancelled with less than 24 hours' notice may not be refunded.</label>
        <p class="err full" id="err"></p>
        <div class="panel-foot full" style="margin-top:0"><button type="button" class="btn ghost" id="back">Back</button><button class="btn" type="submit">Continue to payment</button></div>
      </form>`;
    const save = () => { for (const k of ["givenName", "familyName", "email", "phone", "note"]) state[k] = panel.querySelector("#" + k).value.trim(); state.agree = panel.querySelector("#agree").checked; };
    panel.querySelector("#back").onclick = () => { save(); go(2); };
    panel.querySelector("#f").onsubmit = (e) => {
      e.preventDefault(); save();
      const err = [];
      if (!state.givenName) err.push("your first name");
      if (state.phone.replace(/\D/g, "").length < 10) err.push("a mobile number");
      if (!/^\S+@\S+\.\S+$/.test(state.email)) err.push("a valid email");
      const out = panel.querySelector("#err");
      if (err.length) return out.textContent = "Please add " + err.join(", ") + ".";
      if (!state.agree) return out.textContent = "Please tick the cancellation policy box to continue.";
      go(4);
    };
  }

  if (state.step === 4) {
    const p = dayParts(state.day);
    panel.innerHTML = `<h3>Check and pay</h3>
      <dl class="summary" style="margin:0">
        <div><dt>Treatment</dt><dd>${esc(s.name)} · ${s.minutes} min</dd></div>
        <div><dt>When</dt><dd>${p.dow} ${p.d} ${p.mon}, ${state.slot.label}</dd></div>
        <div><dt>Where</dt><dd>${isOnline(s) ? "Online. Emma will be in touch with call details" : "341 Middlewood Road, S6 1TH"}</dd></div>
        <div><dt>Name</dt><dd>${esc(state.givenName)} ${esc(state.familyName)}</dd></div>
        <div class="total"><dt>To pay</dt><dd>${money(s.amount, s.currency)}</dd></div>
      </dl>
      ${state.config.env === "sandbox" ? `<p class="testnote">Test mode: use card 4111 1111 1111 1111, any future expiry, CVV 111, postcode SW1A 1AA. No real money is taken.</p>` : ""}
      <div id="card-container" class="card-box"><p class="muted">Loading secure card form…</p></div>
      <p class="err" id="err" role="alert"></p>
      <div class="square"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="4"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg>
        <span>Card details go straight to Square and are never stored on this website. Your card is only charged once the appointment is confirmed.</span></div>
      <div class="panel-foot"><button class="btn ghost" id="back">Back</button><button class="btn" id="pay" disabled>Pay ${money(s.amount, s.currency)}</button></div>`;
    panel.querySelector("#back").onclick = () => { destroyCard(); go(3); };
    mountCard();
  }

  if (state.step === 5) {
    document.querySelectorAll("#steps li").forEach((li) => { li.classList.remove("on"); li.classList.add("done"); });
    const r = state.result;
    panel.innerHTML = `<div class="done-box"><div class="tick"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h3 style="margin:0">You're booked in, ${esc(state.givenName)}</h3>
      <p class="muted" style="max-width:32em">${esc(r.service)} on ${esc(r.when)}. You've paid ${money(r.amount, r.currency)}, and a confirmation is on its way to ${esc(r.email)}.</p>
      ${r.receiptUrl ? `<a class="btn ghost" href="${esc(r.receiptUrl)}" target="_blank" rel="noopener">View receipt</a>` : ""}
      <p class="muted" style="font-size:.9rem">Need to change it? Call ${PHONE}.</p></div>`;
  }
}

/* ---------- Square card form ---------- */
let payments = null, card = null, sdkPromise = null;
function loadSdk(envName) {
  sdkPromise ||= new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = envName === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
    sc.onload = ok; sc.onerror = () => { sdkPromise = null; fail(new Error("The secure card form couldn't load.")); };
    document.head.appendChild(sc);
  });
  return sdkPromise;
}
async function destroyCard() { try { await card?.destroy(); } catch {} card = null; }

async function mountCard() {
  const box = panel.querySelector("#card-container"), err = panel.querySelector("#err"), pay = panel.querySelector("#pay");
  try {
    await loadSdk(state.config.env);
    payments ||= window.Square.payments(state.config.appId, state.config.locationId);
    await destroyCard();
    box.innerHTML = "";
    card = await payments.card();
    await card.attach("#card-container");
    pay.disabled = false;
  } catch (e) {
    console.error(e);
    box.innerHTML = "";
    err.textContent = `The card form couldn't load. Please refresh the page, or call ${PHONE} to book.`;
    return;
  }

  pay.onclick = async () => {
    err.textContent = "";
    pay.disabled = true;
    const label = pay.textContent;
    pay.textContent = "Processing…";
    try {
      const s = state.svc;
      const tok = await card.tokenize({
        amount: (s.amount / 100).toFixed(2),
        currencyCode: s.currency,
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: { givenName: state.givenName, familyName: state.familyName, email: state.email, phone: state.phone, countryCode: "GB" },
      });
      if (tok.status !== "OK") throw new Error(tok.errors?.[0]?.message || "Please check your card details.");
      const result = await api("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: tok.token,
          idempotencyKey: crypto.randomUUID(),
          variationId: s.variationId,
          startAt: state.slot.startAt,
          givenName: state.givenName, familyName: state.familyName,
          email: state.email, phone: state.phone, note: state.note,
        }),
      });
      state.result = result;
      await destroyCard();
      go(5);
      loadNextSlots();
    } catch (e) {
      err.textContent = e.message;
      if (e.data?.code === "SLOT_TAKEN") {
        state.days = null; state.slot = null;
        setTimeout(() => { destroyCard(); pickService(state.svc); }, 2500);
      }
      pay.disabled = false;
      pay.textContent = label;
    }
  };
}

/* ---------- Hero: next free slots for the first service ---------- */
async function loadNextSlots() {
  const box = document.getElementById("nextSlots");
  const s = state.services.find((x) => /reiki/i.test(x.name)) || state.services[0];
  document.getElementById("nextTitle").textContent = `${s.name}, ${s.minutes} minutes`;
  if (!s.variationId) { box.innerHTML = `<p class="muted">Call ${PHONE} to book.</p>`; return; }
  try {
    const { days } = await api(`/api/availability?service=${encodeURIComponent(s.variationId)}`);
    const picks = Object.entries(days).slice(0, 3).map(([d, ts]) => [d, ts[0]]);
    if (!picks.length) { box.innerHTML = `<p class="muted">Fully booked online for now. Call ${PHONE}.</p>`; return; }
    box.innerHTML = picks.map(([d, t], i) => { const p = dayParts(d); return `<button class="slotbtn" data-i="${i}"><strong>${p.dow.slice(0, 3)} ${p.d} ${p.mon} · ${t.label}</strong><span>Book →</span></button>`; }).join("");
    box.querySelectorAll("button").forEach((b) => b.onclick = () => {
      const [d, t] = picks[+b.dataset.i];
      Object.assign(state, { svc: s, days, day: d, slot: t });
      go(3); scrollToBook();
    });
  } catch { box.innerHTML = `<p class="muted">Call ${PHONE} to book.</p>`; }
}

/* ---------- Boot ---------- */
renderServices();
render();
api("/api/config").then((cfg) => {
  state.config = cfg;
  if (cfg.services?.length) state.services = cfg.services;
  renderServices(); render(); loadNextSlots();
}).catch((e) => {
  state.loadErr = e.message; render();
  document.getElementById("nextSlots").innerHTML = `<p class="muted">Call ${PHONE} to book.</p>`;
});

/* ---------- Hero card aura ---------- */
(function () {
  const c = document.getElementById("aura"), x = c.getContext("2d");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const col = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const size = () => { c.width = c.offsetWidth * devicePixelRatio; c.height = c.offsetHeight * devicePixelRatio; };
  size(); addEventListener("resize", size);
  let t = 0;
  (function draw() {
    const w = c.width, h = c.height; x.clearRect(0, 0, w, h);
    [[col("--heather-soft"), .85, .15, .55], [col("--moss-soft"), .15, .95, .5]].forEach(([cl, px, py, r], i) => {
      const cx = w * (px + .05 * Math.sin(t / 90 + i * 2)), cy = h * (py + .05 * Math.cos(t / 110 + i));
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * r);
      g.addColorStop(0, cl); g.addColorStop(1, "transparent"); x.fillStyle = g; x.fillRect(0, 0, w, h);
    });
    t++; if (!still) requestAnimationFrame(draw);
  })();
})();
