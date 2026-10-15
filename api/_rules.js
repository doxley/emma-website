// When each kind of service can be booked online. One place, used by availability, booking and rescheduling.
//
// All services share Emma's single Square diary, so any booking automatically blocks overlapping
// times for every other service (e.g. online tarot and tarot training on Tuesdays block each other).
import { londonDate, TZ } from "./_square.js";

const hhmmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
export const londonHHMM = (d) => hhmmFmt.format(new Date(d));
export const weekdayOf = (isoDate) => { const [y, m, d] = isoDate.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export const RULES = {
  // One-to-one tarot training: Tuesdays, 1–4pm or 5–8pm, 3 Nov to 22 Dec 2026.
  training: { days: [2], starts: ["13:00", "17:00"], from: "2026-11-03", to: "2026-12-22" },
  // Online tarot: Tuesdays, any free hour.
  online: { days: [2] },
  // In-person treatments: Wednesday to Friday.
  inPerson: { days: [3, 4, 5] },
};

export function kindOf(serviceName = "") {
  if (/training|workshop|course/i.test(serviceName)) return "training";
  if (/online/i.test(serviceName)) return "online";
  return "inPerson";
}
export const ruleFor = (service) => RULES[kindOf(service?.name)];

// Is this start time allowed for this service? (Square still decides whether it's free.)
export function allowedStart(service, startAt, now = new Date()) {
  const r = ruleFor(service);
  const date = londonDate(startAt);
  if (date <= londonDate(now)) return false; // nothing same-day online
  if (!r.days.includes(weekdayOf(date))) return false;
  if (r.from && date < r.from) return false;
  if (r.to && date > r.to) return false;
  if (r.starts && !r.starts.includes(londonHHMM(startAt))) return false;
  return true;
}

// How far ahead to look for free times.
export function searchWindow(service, now = new Date()) {
  const r = ruleFor(service);
  const start = new Date(now.getTime() + 60 * 1000);
  let end = new Date(now.getTime() + 21 * 86400e3);
  if (r.to) {
    end = new Date(`${r.to}T23:59:00Z`);
    const from = r.from ? new Date(`${r.from}T00:00:00Z`) : start;
    return { start: from > start ? from : start, end };
  }
  return { start, end };
}

// Website launch offer: in-person treatments £25 (usually £40) for bookings made up to and including 30 Oct 2026.
// It switches itself off at midnight UK time at the end of 30 October. The date decides by when the
// booking is MADE, not the appointment date.
export const PROMO = { kind: "inPerson", amount: 2500, lastDay: "2026-10-30", label: "Website launch offer" };

export function promoActive(now = new Date()) {
  return londonDate(now) <= PROMO.lastDay;
}

// The price to charge right now. Never lower than the promo, never higher than Square's price.
export function priceFor(service, now = new Date()) {
  const base = service.amount;
  if (promoActive(now) && kindOf(service.name) === PROMO.kind && base > PROMO.amount) {
    return { amount: PROMO.amount, wasAmount: base, currency: service.currency };
  }
  return { amount: base, wasAmount: null, currency: service.currency };
}
