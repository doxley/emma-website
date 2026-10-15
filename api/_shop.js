// Online shop: products come from Emma's Square item library.
//
// How Emma controls the shop from Square (Items → Item library):
//   - Put an item in the category  "Online shop"  to show it on the website.
//   - Optionally also put it in ONE postage category: "Letterbox", "Small parcel", "Large parcel" or "Heavy parcel".
//     Items without one are treated as "Small parcel".
//   - Price, photos, description, options (variations) and stock all come from Square.
import { sq, getBusiness } from "./_square.js";

export const SHOP_CATEGORY = "online shop";

// Postage (Evri, ParcelShop drop-off). Rates cover Evri + packaging + Square's 1.4% on the postage. Never free.
// The checkout charges the biggest size in the basket, once.
export const POSTAGE = {
  letterbox: { label: "Letterbox", pence: 325, rank: 1 },
  small: { label: "Small parcel", pence: 395, rank: 2 },
  large: { label: "Large parcel", pence: 575, rank: 3 },
  heavy: { label: "Heavy parcel", pence: 795, rank: 4 },
};
const SIZE_BY_CATEGORY = { "letterbox": "letterbox", "small parcel": "small", "large parcel": "large", "heavy parcel": "heavy" };

export function postageFor(sizes) {
  let best = null;
  for (const s of sizes) {
    const p = POSTAGE[s] || POSTAGE.small;
    if (!best || p.rank > best.rank) best = { ...p, size: POSTAGE[s] ? s : "small" };
  }
  return best;
}

let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

export async function getShop({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const { locationId } = await getBusiness();

  const objects = [];
  let cursor;
  do {
    const q = new URLSearchParams({ types: "ITEM,IMAGE,CATEGORY" });
    if (cursor) q.set("cursor", cursor);
    const page = await sq(`/v2/catalog/list?${q}`);
    objects.push(...(page.objects || []));
    cursor = page.cursor;
  } while (cursor);

  const categories = new Map(objects.filter((o) => o.type === "CATEGORY").map((o) => [o.id, (o.category_data?.name || "").trim().toLowerCase()]));
  const images = new Map(objects.filter((o) => o.type === "IMAGE").map((o) => [o.id, o.image_data?.url]));
  const shopCat = [...categories].find(([, n]) => n === SHOP_CATEGORY)?.[0];

  const products = [];
  if (shopCat) {
    for (const o of objects) {
      if (o.type !== "ITEM" || o.is_deleted) continue;
      const it = o.item_data || {};
      if (it.is_archived || it.product_type === "APPOINTMENTS_SERVICE") continue;
      if (it.present_at_all_locations === false && !(o.present_at_location_ids || []).includes(locationId)) continue;
      if ((o.absent_at_location_ids || []).includes(locationId)) continue;
      const catIds = [...(it.categories || []).map((c) => c.id), it.category_id].filter(Boolean);
      if (!catIds.includes(shopCat)) continue;
      const size = catIds.map((id) => SIZE_BY_CATEGORY[categories.get(id)]).find(Boolean) || "small";
      const variations = (it.variations || [])
        .filter((v) => !v.is_deleted && v.item_variation_data?.price_money)
        .map((v) => {
          const vd = v.item_variation_data;
          const ov = (vd.location_overrides || []).find((x) => x.location_id === locationId) || {};
          return {
            id: v.id,
            name: vd.name || "",
            amount: Number(vd.price_money.amount),
            currency: vd.price_money.currency,
            tracked: Boolean(ov.track_inventory ?? vd.track_inventory),
            soldOut: Boolean(ov.sold_out),
            stock: null,
          };
        });
      if (!variations.length) continue;
      products.push({
        id: o.id,
        name: it.name,
        description: (it.description_plaintext || it.description || "").trim(),
        images: (it.image_ids || []).map((id) => images.get(id)).filter(Boolean),
        size,
        variations,
      });
    }
  }

  // Stock levels (only for variations Emma tracks stock on)
  const tracked = products.flatMap((p) => p.variations.filter((v) => v.tracked).map((v) => v.id));
  if (tracked.length) {
    try {
      const counts = new Map();
      for (let i = 0; i < tracked.length; i += 100) {
        const { counts: c = [] } = await sq("/v2/inventory/counts/batch-retrieve", {
          method: "POST",
          body: { catalog_object_ids: tracked.slice(i, i + 100), location_ids: [locationId], states: ["IN_STOCK"] },
        });
        for (const x of c) counts.set(x.catalog_object_id, (counts.get(x.catalog_object_id) || 0) + Number(x.quantity));
      }
      for (const p of products) for (const v of p.variations) if (v.tracked) v.stock = Math.max(0, Math.floor(counts.get(v.id) || 0));
    } catch (err) {
      console.error("Stock levels unavailable", err.message);
    }
  }
  for (const p of products) for (const v of p.variations) v.available = !v.soldOut && (v.stock === null || v.stock > 0);

  products.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), data: { products, locationId } };
  return cache.data;
}

export function publicProduct(p) {
  return {
    id: p.id, name: p.name, description: p.description, images: p.images, size: p.size,
    postage: POSTAGE[p.size].label,
    variations: p.variations.map(({ id, name, amount, currency, available, stock }) => ({
      id, name, amount, currency, available, lowStock: stock !== null && stock > 0 && stock <= 3 ? stock : null, stock,
    })),
  };
}
