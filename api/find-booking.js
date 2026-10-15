// POST /api/find-booking { email, phone }
// For clients without their link: returns their upcoming online bookings, but only when BOTH the email
// and mobile number match the customer record in Square.
import { sq, send, readJson, getBusiness } from "./_square.js";
import { signBooking, describe, samePhone } from "./_manage.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  const notFound = () => send(res, 404, { error: "We couldn't find any upcoming bookings for those details. Check the email and mobile number you booked with, or call 0114 470 4565." });
  try {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "");
    if (!/^\S+@\S+\.\S+$/.test(email) || phone.replace(/\D/g, "").length < 10) {
      return send(res, 400, { error: "Please enter the email and mobile number you booked with." });
    }
    const { customers = [] } = await sq("/v2/customers/search", {
      method: "POST",
      body: { query: { filter: { email_address: { exact: email } } }, limit: 5 },
    });
    const matches = customers.filter((c) => samePhone(c.phone_number, phone));
    if (!matches.length) return notFound();

    const { services, locationId } = await getBusiness();
    const out = [];
    for (const c of matches) {
      const q = new URLSearchParams({ customer_id: c.id, location_id: locationId, start_at_min: new Date().toISOString(), limit: "20" });
      const { bookings = [] } = await sq(`/v2/bookings?${q}`);
      for (const b of bookings) {
        const svc = services.find((s) => s.variationId === b.appointment_segments?.[0]?.service_variation_id);
        const info = describe(b, svc?.name || "Appointment");
        if (!info.cancelled && !info.past) out.push({ ...info, token: signBooking(b.id) });
      }
    }
    if (!out.length) return notFound();
    out.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return send(res, 200, { bookings: out });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "Something went wrong. Please try again or call 0114 470 4565." });
  }
}
