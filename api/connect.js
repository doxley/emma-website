// GET /api/connect?key=<SETUP_KEY>
// One-time owner step: sends Emma to Square to approve the website's access to her account.
import crypto from "node:crypto";
import { BASE, OAUTH_SCOPES } from "./_square.js";

export default function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (!process.env.SETUP_KEY || url.searchParams.get("key") !== process.env.SETUP_KEY) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `sq_state=${state}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=900`);
  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: OAUTH_SCOPES.join(" "),
    session: "false",
    state,
  });
  res.statusCode = 302;
  res.setHeader("Location", `${BASE}/oauth2/authorize?${params}`);
  res.end();
}
