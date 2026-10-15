// TEMPORARY: relays photos from Emma's old Etsy shop so they can be copied into Square.
// Only Emma's own Etsy shop images (shop 62026033) are allowed. Remove once products are moved.
export default async function handler(req, res) {
  const u = new URL(req.url, "http://x").searchParams.get("u") || "";
  if (!/^https:\/\/i\.etsystatic\.com\/62026033\/r\/il\/[\w/.-]+\.jpg$/.test(u)) {
    res.statusCode = 400; return res.end("Not allowed");
  }
  const r = await fetch(u);
  if (!r.ok) { res.statusCode = 502; return res.end("Fetch failed"); }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(Buffer.from(await r.arrayBuffer()));
}
