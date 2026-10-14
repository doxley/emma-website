// GET /api/config — public settings the booking page needs: Square app/location IDs and the bookable services.
import { getBusiness, send, env } from "./_square.js";

export default async function handler(req, res) {
  try {
    const { locationId, services } = await getBusiness();
    send(res, 200, {
      env,
      appId: process.env.SQUARE_APP_ID,
      locationId,
      services: services.map(({ variationId, name, baseName, description, minutes, amount, currency }) => ({
        variationId, name, baseName, description, minutes, amount, currency,
      })),
    });
  } catch (err) {
    console.error(err);
    send(res, 503, { error: "Online booking is unavailable right now." });
  }
}
