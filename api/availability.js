// GET /api/availability?service=<variationId>
// Returns free start times for the next 3 weeks, grouped by London date.
// Same-day appointments are left out: those are booked by phone.
import { getBusiness, searchAvailability, londonDate, londonTime, send } from "./_square.js";

const DAYS_AHEAD = 21;
// Which weekdays each kind of service can be booked online (0 = Sunday).
// Online tarot is Tuesdays only; in-person treatments are Wednesday to Friday.
const ONLINE_DAYS = [2];
const IN_PERSON_DAYS = [3, 4, 5];
const weekday = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const variationId = url.searchParams.get("service");
    const { locationId, services } = await getBusiness();
    const service = services.find((s) => s.variationId === variationId);
    if (!service) return send(res, 404, { error: "That treatment isn't available to book online." });

    const now = new Date();
    const today = londonDate(now);
    const startAt = new Date(now.getTime() + 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + DAYS_AHEAD * 86400e3).toISOString();

    const slots = await searchAvailability({ service, locationId, startAt, endAt });
    const days = {};
    const seen = new Set();
    for (const a of slots) {
      const date = londonDate(a.start_at);
      if (date === today || seen.has(a.start_at)) continue;
      if (!(/online/i.test(service.name) ? ONLINE_DAYS : IN_PERSON_DAYS).includes(weekday(date))) continue;
      seen.add(a.start_at);
      (days[date] ||= []).push({ startAt: a.start_at, label: londonTime(a.start_at) });
    }
    for (const d of Object.values(days)) d.sort((x, y) => x.startAt.localeCompare(y.startAt));
    send(res, 200, { days });
  } catch (err) {
    console.error(err);
    send(res, 503, { error: "We couldn't load available times. Please try again, or call 0114 470 4565." });
  }
}
