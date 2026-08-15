import { z } from "zod";
import { findProductForStockCheck } from "@/lib/catalogue";
import { fetchSiaHuatProduct } from "@/lib/siahuat-product";

export const runtime = "nodejs";

const requestSchema = z.object({ stockId: z.string().trim().min(1).max(100) });

export async function POST(request: Request) {
  const input = requestSchema.safeParse(await request.json());
  if (!input.success) return Response.json({ error: "Invalid item code." }, { status: 400 });

  try {
    const catalogueProduct = await findProductForStockCheck(input.data.stockId);
    if (!catalogueProduct) return Response.json({ error: "Product not found." }, { status: 404 });

    const live = await fetchSiaHuatProduct(catalogueProduct.source_url);
    if (live.stock_id.toLowerCase() !== catalogueProduct.stock_id.toLowerCase()) {
      throw new Error("LIVE_ITEM_CODE_MISMATCH");
    }

    return Response.json({
      stockId: live.stock_id,
      inStock: live.in_stock,
      availableQuantity: live.available_quantity,
      stockStatus: live.stock_status,
      priceExGst: live.price_ex_gst,
      checkedAt: live.last_scraped_at,
      sourceUrl: live.source_url,
    });
  } catch (error) {
    console.error("Live Sia Huat stock check failed", error);
    return Response.json({ error: "Live website stock could not be checked right now." }, { status: 502 });
  }
}
