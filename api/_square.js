// Shared Square helpers for the Vercel functions.
// Talks to Square's REST API directly with fetch (Node 18+), so there are no SDK dependencies to keep updated.

const ENV = process.env.SQUARE_ENV === "production" ? "production" : "sandbox";
export const BASE = ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
export const SQUARE_VERSION = "2025-04-16";
export const TZ = "Europe/London";
export const env = ENV;

// Scopes for a buyer-level booking integration. These deliberately leave out
// APPOINTMENTS_ALL_* so bookings work on Square's free Appointments plan.
export const OAUTH_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "PAYMENTS_WRITE",
  "PAYMENTS_READ",
  "APPOINTMENTS_READ",
  "APPOINTMENTS_WRITE",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
];

let cachedToken = null; // { token, expiresAt }

// Access token: OAuth refresh token (preferred, works on the free plan) or a plain access token.
export async function getAccessToken() {
  const refresh = process.env.SQUARE_REFRESH_TOKEN;
  if (refresh) {
    if (cachedToken && cachedToken.expiresAt - Date.now() > 5 * 60 * 1000) return cachedToken.token;
    const res = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
      body: JSON.stringify({
        client_id: process.env.SQUARE_APP_ID,
        client_secret: process.env.SQUARE_APP_SECRET,
        grant_type: "refresh_token",
        refresh_token: refresh,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new SquareError("Could not refresh the Square connection", data, 500);
    cachedToken = { token: data.access_token, expiresAt: Date.parse(data.expires_at) || Date.now() + 3600e3 };
    return cachedToken.token;
  }
  if (process.env.SQUARE_ACCESS_TOKEN) return process.env.SQUARE_ACCESS_TOKEN;
  throw new SquareError("Square is not connected yet", {}, 503);
}

export class SquareError extends Error {
  constructor(message, body = {}, status = 502) {
    super(message);
    this.body = body;
    this.status = status;
    this.code = body?.errors?.[0]?.code;
  }
}

export async function sq(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data?.errors?.map((e) => `${e.code}: ${e.detail}`).join("; ");
    console.error(`Square ${method} ${path} failed (${res.status}): ${detail}`);
    throw new SquareError(detail || `Square request failed (${res.status})`, data, res.status);
  }
  return data;
}

// ---------- Business data (cached per warm function instance) ----------
let cache = { at: 0, data: null };
const CACHE_MS = 5 * 60 * 1000;

export async function getBusiness() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  // Location
  let locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) {
    const { locations = [] } = await sq("/v2/locations");
    const active = locations.find((l) => l.status === "ACTIVE") || locations[0];
    if (!active) throw new SquareError("No Square location found", {}, 500);
    locationId = active.id;
  }

  // Bookable team member (Emma)
  const { team_member_booking_profiles: profiles = [] } = await sq(
    "/v2/bookings/team-member-booking-profiles?bookable_only=true&limit=10"
  );
  const teamMemberIds = profiles.filter((p) => p.is_bookable !== false).map((p) => p.team_member_id);

  // Bookable services from the catalog
  const services = [];
  let cursor;
  do {
    const q = new URLSearchParams({ types: "ITEM" });
    if (cursor) q.set("cursor", cursor);
    const page = await sq(`/v2/catalog/list?${q}`);
    for (const obj of page.objects || []) {
      const item = obj.item_data;
      if (!item || obj.is_deleted || item.product_type !== "APPOINTMENTS_SERVICE") continue;
      if (item.present_at_all_locations === false && !(obj.present_at_location_ids || []).includes(locationId)) continue;
      for (const v of item.variations || []) {
        const vd = v.item_variation_data || {};
        if (vd.available_for_booking === false || !vd.price_money) continue;
        // Skip Square's sample service, voucher items and anything without a real duration.
        if (!vd.service_duration || /example|voucher/i.test(item.name)) continue;
        services.push({
          variationId: v.id,
          version: v.version,
          name: item.variations.length > 1 ? `${item.name} – ${vd.name}` : item.name,
          baseName: item.name,
          description: item.description || "",
          minutes: Math.round((vd.service_duration || 3600000) / 60000),
          amount: Number(vd.price_money.amount),
          currency: vd.price_money.currency,
          teamMemberIds: vd.team_member_ids?.length ? vd.team_member_ids : teamMemberIds,
        });
      }
    }
    cursor = page.cursor;
  } while (cursor);

  cache = { at: Date.now(), data: { locationId, teamMemberIds, services } };
  return cache.data;
}

// ---------- Time helpers ----------
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const londonDate = (d) => dateFmt.format(new Date(d)); // YYYY-MM-DD

const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
export const londonTime = (d) => timeFmt.format(new Date(d)).replace(":00", "").replace(" ", "");

const longFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
export const londonLong = (d) => longFmt.format(new Date(d));

export async function searchAvailability({ service, locationId, startAt, endAt }) {
  const { availabilities = [] } = await sq("/v2/bookings/availability/search", {
    method: "POST",
    body: {
      query: {
        filter: {
          start_at_range: { start_at: startAt, end_at: endAt },
          location_id: locationId,
          segment_filters: [
            {
              service_variation_id: service.variationId,
              ...(service.teamMemberIds.length ? { team_member_id_filter: { any: service.teamMemberIds } } : {}),
            },
          ],
        },
      },
    },
  });
  return availabilities;
}

// ---------- Request helpers ----------
export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function ukPhoneToE164(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  if (/^0\d{10}$/.test(digits)) return "+44" + digits.slice(1);
  if (/^44\d{10}$/.test(digits)) return "+" + digits;
  return null;
}
