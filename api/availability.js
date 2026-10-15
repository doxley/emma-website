// GET /api/availability?service=<variationId>
// Free start times grouped by London date, filtered by each service's rules (see _rules.js).
// Same-day appointments are left out: those are booked by phone.
import { getBusiness, searchAvailability, londonDate, londonTime, send } from "./_square.js";
import { allowedStart, searchWindow, kindOf } from "./_rules.js";

const CHUNK_MS = 28 * 86400e3; // Square limits each availability search to about a month

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const variationId = url.searchParams.get("service");
    const { locationId, services } = await getBusiness();
    const service = services.find((s) => s.variationId === variationId);
    if (!service) return send(res, 404, { error: "That isn't available to book online." });

    const now = new Date();
    const { start, end } = searchWindow(service, now);
    const days = {};
    if (start < end) {
      const slots = [];
      for (let t = start.getTime(); t < end.getTime(); t += CHUNK_MS) {
        const chunkEnd = Math.min(t + CHUNK_MS, end.getTime());
        slots.push(...(await searchAvailability({
          service, locationId, startAt: new Date(t).toISOString(), endAt: new Date(chunkEnd).toISOString(),
        })));
      }
      const training = kindOf(service.name) === "training";
      const seen = new Set();
      for (const a of slots) {
        if (seen.has(a.start_at) || !allowedStart(service, a.start_at, now)) continue;
        seen.add(a.start_at);
        const label = training
          ? `${londonTime(a.start_at)}–${londonTime(Date.parse(a.start_at) + service.minutes * 60000)}`
          : londonTime(a.start_at);
        (days[londonDate(a.start_at)] ||= []).push({ startAt: a.start_at, label });
      }
      for (const d of Object.values(days)) d.sort((x, y) => x.startAt.localeCompare(y.startAt));
    }
    send(res, 200, { days });
  } catch (err) {
    console.error(err);
    send(res, 503, { error: "We couldn't load available times. Please try again, or call 0114 470 4565." });
  }
}
