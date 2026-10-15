// TEMPORARY: lists shop item names and their categories while products are moved from Etsy. Remove afterwards.
import { sq, send } from "./_square.js";

export default async function handler(req, res) {
  try {
    const page = await sq(`/v2/catalog/list?types=ITEM,CATEGORY`);
    const objs = page.objects || [];
    const cats = new Map(objs.filter((o) => o.type === "CATEGORY").map((o) => [o.id, o.category_data?.name]));
    const items = objs.filter((o) => o.type === "ITEM" && o.item_data?.product_type !== "APPOINTMENTS_SERVICE").map((o) => ({
      id: o.id,
      name: o.item_data?.name,
      categories: [...(o.item_data?.categories || []).map((c) => cats.get(c.id)), cats.get(o.item_data?.category_id)].filter(Boolean),
      images: (o.item_data?.image_ids || []).length,
    }));
    send(res, 200, { items });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}
