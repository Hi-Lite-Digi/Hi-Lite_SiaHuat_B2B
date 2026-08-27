import { z } from "zod";
import { findAvailableCatalogueAlternatives } from "@/lib/catalogue";
import { fetchSiaHuatProduct } from "@/lib/siahuat-product";

export const runtime = "nodejs";

const requestSchema = z.object({
  stockId: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().int().positive().max(100_000).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const input = requestSchema.safeParse(body);
  if (!input.success) return Response.json({ error: "Invalid item code." }, { status: 400 });

  try {
    const minimumQuantity = input.data.quantity ?? 1;
    const candidates = await findAvailableCatalogueAlternatives(input.data.stockId, 12, minimumQuantity);
    const liveChecks = await Promise.allSettled(
      candidates.map(async (product) => {
        if (!product.source_url) return null;
        const live = await fetchSiaHuatProduct(product.source_url, 8_000);
        if (live.stock_id.toLowerCase() !== product.stock_id.toLowerCase()
          || live.stock_status !== "in_stock"
          || live.available_quantity === null
          || live.available_quantity < minimumQuantity) return null;
        return {
          ...product,
          list_price: live.price_ex_gst,
          in_stock: live.in_stock,
          available_quantity: live.available_quantity,
          stock_status: live.stock_status,
          last_scraped_at: live.last_scraped_at,
        };
      }),
    );
    const products = liveChecks
      .flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : [])
      .sort((left, right) => Number(right.available_quantity ?? 0) - Number(left.available_quantity ?? 0))
      .slice(0, 3);
    return Response.json({ products, minimumQuantity });
  } catch (error) {
    console.error("Catalogue alternative lookup failed", error);
    return Response.json({ error: "Alternative products could not be checked right now." }, { status: 502 });
  }
}
