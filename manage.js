/* Manage booking page: find, cancel or move an appointment. */
const PHONE = "0114 470 4565";
const panel = document.getElementById("panel");
const title = document.getElementById("title");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayParts = (iso) => { const [y, m, d] = iso.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d, 12)); return { dow: DAYS[dt.getUTCDay()], d, mon: MON[m - 1] }; };

const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { data });
  return data;
};
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let token = new URLSearchParams(location.search).get("t");
let booking = null;

/* ---------- Find by email + mobile ---------- */
function showFind(message = "") {
  title.textContent = "Find your booking";
  panel.innerHTML = `
    <p class="muted" style="margin-bottom:1rem">Enter the email and mobile number you booked with.</p>
    <form class="form" id="find" novalidate>
      <label>Email<input id="email" type="email" autocomplete="email" required></label>
      <label>Mobile number<input id="phone" type="tel" autocomplete="tel" required></label>
      <p class="err full" id="err">${esc(message)}</p>
      <div class="panel-foot full" style="margin-top:0"><span class="muted">Booked by phone? Call ${PHONE}.</span><button class="btn" type="submit">Find my booking</button></div>
    </form>
    <div class="found" id="found"></div>`;
  panel.querySelector("#find").onsubmit = async (e) => {
    e.preventDefault();
    const err = panel.querySelector("#err"), btn = e.submitter || panel.querySelector("button[type=submit]");
    err.textContent = ""; btn.disabled = true;
    try {
      const { bookings } = await post("/api/find-booking", { email: panel.querySelector("#email").value, phone: panel.querySelector("#phone").value });
      panel.querySelector("#found").innerHTML = `<h3 style="margin-top:1rem">Your upcoming appointments</h3>` + bookings.map((b, i) => `
        <button class="choice" data-i="${i}"><span><b>${esc(b.service)}</b><br><span class="muted">${esc(b.when)}</span></span><span class="muted">Manage →</span></button>`).join("");
      panel.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => {
        token = bookings[+b.dataset.i].token;
        history.replaceState(null, "", `/manage?t=${encodeURIComponent(token)}`);
        load();
      });
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  };
}

/* ---------- Booking view ---------- */
async function load() {
  panel.innerHTML = `<p class="muted">Loading your booking…</p>`;
  try {
    ({ booking } = await api(`/api/manage?t=${encodeURIComponent(token)}`));
    showBooking();
  } catch (ex) { showFind(ex.message); }
}

function showBooking(flash = "") {
  const b = booking;
  title.textContent = b.service;
  const status = b.cancelled ? `<span class="pill off">Cancelled</span>` : b.past ? `<span class="pill off">Past</span>` : `<span class="pill">Booked</span>`;
  let note = "";
  if (!b.cancelled && !b.past) {
    note = b.refundOnCancel
      ? `<p class="note good">You can cancel for a <b>full refund</b>${b.price ? ` of ${esc(b.price)}` : ""}, or move to another time, until 24 hours before your appointment.</p>`
      : `<p class="note warn">Your appointment is less than 24 hours away. Cancelling now won't be refunded, and to move it please call ${PHONE}.</p>`;
  }
  panel.innerHTML = `
    ${flash ? `<p class="note good" style="margin-bottom:1rem">${esc(flash)}</p>` : ""}
    <div class="bk">
      <dl style="margin:0;display:grid;gap:.4rem">
        <div class="bk-row"><dt>Treatment</dt><dd>${esc(b.service)}</dd></div>
        <div class="bk-row"><dt>When</dt><dd>${esc(b.when)}</dd></div>
        <div class="bk-row"><dt>Where</dt><dd>${/online/i.test(b.service) ? "Video call on Facebook Messenger" : "341 Middlewood Road, S6 1TH"}</dd></div>
        <div class="bk-row"><dt>Status</dt><dd>${status}</dd></div>
      </dl>
      ${note}
      <div class="actions">
        ${b.canReschedule ? `<button class="btn" id="move">Move to another time</button>` : ""}
        ${b.canCancel ? `<button class="btn ghost" id="cancel">Cancel appointment</button>` : ""}
        ${b.cancelled ? `<a class="btn" href="/#book">Book again</a>` : ""}
      </div>
      <div id="sub"></div>
    </div>`;
  panel.querySelector("#move")?.addEventListener("click", showMove);
  panel.querySelector("#cancel")?.addEventListener("click", confirmCancel);
}

/* ---------- Cancel ---------- */
function confirmCancel() {
  const b = booking, sub = panel.querySelector("#sub");
  sub.innerHTML = `<div class="confirm-box">
    <p><b>Cancel your ${esc(b.service)} on ${esc(b.when)}?</b><br>
    ${b.refundOnCancel ? `You'll get a full refund${b.price ? ` of ${esc(b.price)}` : ""} to your card.` : "This won't be refunded, as it's less than 24 hours away."}</p>
    <p class="err" id="err" role="alert"></p>
    <div class="actions"><button class="btn" id="yes">Yes, cancel it</button><button class="btn ghost" id="no">Keep my appointment</button></div></div>`;
  sub.querySelector("#no").onclick = () => (sub.innerHTML = "");
  sub.querySelector("#yes").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "Cancelling…";
    try {
      const r = await post("/api/manage", { t: token, action: "cancel" });
      booking = { ...booking, cancelled: true, canCancel: false, canReschedule: false, refundOnCancel: false, status: "CANCELLED_BY_CUSTOMER" };
      showBooking(r.message);
    } catch (ex) {
      sub.querySelector("#err").textContent = ex.message;
      e.target.disabled = false; e.target.textContent = "Yes, cancel it";
    }
  };
}

/* ---------- Move ---------- */
async function showMove() {
  const b = booking, sub = panel.querySelector("#sub");
  sub.innerHTML = `<p class="muted">Finding free times…</p>`;
  let days;
  try { ({ days } = await api(`/api/availability?service=${encodeURIComponent(b.variationId)}`)); }
  catch (ex) { sub.innerHTML = `<p class="err">${esc(ex.message)}</p>`; return; }
  for (const d of Object.keys(days)) { days[d] = days[d].filter((t) => t.startAt !== b.startAt); if (!days[d].length) delete days[d]; }
  const dates = Object.keys(days);
  if (!dates.length) { sub.innerHTML = `<p class="note warn">There are no other free times online in the next three weeks. Please call ${PHONE}.</p>`; return; }
  let day = dates[0], slot = null;
  const draw = () => {
    sub.innerHTML = `<div class="confirm-box">
      <p><b>Choose a new time</b></p>
      <div class="days" role="group" aria-label="Date">${dates.map((d) => { const p = dayParts(d); return `<button class="day" data-day="${d}" aria-pressed="${d === day}"><small>${p.dow}</small><b>${p.d}</b><small>${p.mon}</small></button>`; }).join("")}</div>
      <div class="times" role="group" aria-label="Time" style="margin-top:0">${days[day].map((t) => `<button class="time" data-t="${t.startAt}" aria-pressed="${slot?.startAt === t.startAt}">${t.label}</button>`).join("")}</div>
      <p class="err" id="err" role="alert"></p>
      <div class="actions"><button class="btn" id="save" ${slot ? "" : "disabled"}>Move my appointment</button><button class="btn ghost" id="no">Keep current time</button></div></div>`;
    sub.querySelectorAll("[data-day]").forEach((x) => x.onclick = () => { day = x.dataset.day; slot = null; draw(); });
    sub.querySelectorAll("[data-t]").forEach((x) => x.onclick = () => { slot = days[day].find((t) => t.startAt === x.dataset.t); draw(); });
    sub.querySelector("#no").onclick = () => (sub.innerHTML = "");
    sub.querySelector("#save").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Moving…";
      try {
        const r = await post("/api/manage", { t: token, action: "reschedule", startAt: slot.startAt });
        ({ booking } = await api(`/api/manage?t=${encodeURIComponent(token)}`));
        showBooking(r.message);
      } catch (ex) {
        sub.querySelector("#err").textContent = ex.message;
        e.target.disabled = false; e.target.textContent = "Move my appointment";
      }
    };
  };
  draw();
}

token ? load() : showFind();
