// GET /api/shop — products for the Crystals & Gifts shop, plus postage rates.
import { send } from "./_square.js";
import { getShop, publicProduct, POSTAGE } from "./_shop.js";

export default async function handler(req, res) {
  try {
    const { products } = await getShop();
    send(res, 200, {
      products: products.map(publicProduct),
      postage: Object.entries(POSTAGE).map(([size, p]) => ({ size, label: p.label, amount: p.pence })),
    });
  } catch (err) {
    console.error(err);
    send(res, 503, { error: "The shop is unavailable right now. Please try again later." });
  }
}
