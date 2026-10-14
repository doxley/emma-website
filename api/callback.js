// GET /api/callback — Square redirects here after Emma approves access.
// Shows the refresh token ONCE so it can be saved as the SQUARE_REFRESH_TOKEN setting in Vercel.
import { BASE, SQUARE_VERSION } from "./_square.js";

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#2a1f2d}
code{display:block;word-break:break-all;background:#efe5f1;padding:12px;border-radius:8px;user-select:all}</style>
<h1>${title}</h1>${body}`;

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const cookieState = /(?:^|;\s*)sq_state=([a-f0-9]+)/.exec(req.headers.cookie || "")?.[1];
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (url.searchParams.get("error")) {
    return res.end(page("Square connection cancelled", "<p>No changes were made. You can start again from the setup link.</p>"));
  }
  if (!cookieState || cookieState !== url.searchParams.get("state")) {
    res.statusCode = 400;
    return res.end(page("Link expired", "<p>Please start again from the setup link.</p>"));
  }

  const r = await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      code: url.searchParams.get("code"),
      grant_type: "authorization_code",
    }),
  });
  const data = await r.json();
  res.setHeader("Set-Cookie", "sq_state=; Path=/api; Max-Age=0");
  if (!r.ok || !data.refresh_token) {
    res.statusCode = 502;
    return res.end(page("Square didn't connect", `<p>${(data.errors?.[0]?.detail || "Unknown error").replace(/</g, "&lt;")}</p>`));
  }
  res.end(page("Square is connected",
    `<p>Copy this value into Vercel → Project → Settings → Environment Variables as <b>SQUARE_REFRESH_TOKEN</b>, then redeploy.</p>
     <code>${data.refresh_token}</code>
     <p>Keep it private. It won't be shown again; if it's lost, run the setup link again.</p>`));
}
