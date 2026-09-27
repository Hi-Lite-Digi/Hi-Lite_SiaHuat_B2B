// src/lib/agent/testing.ts
import type { Product } from "@/lib/chat-contract";
import type { CatalogueImageLookup } from "@/lib/catalogue-image-library";
import type { ScrapedSiaHuatProduct } from "@/lib/siahuat-product";
import type { CatalogueProduct, FactDeps } from "./facts";

/** A catalogue row with a unique numeric store URL derived from its code. */
export function product(overrides: Partial<Product> & { stock_id: string }): CatalogueProduct {
  const numericId = 1000 + [...overrides.stock_id].reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 1), 0);
  return {
    name: `Product ${overrides.stock_id}`,
    status: "Active",
    list_price: 10,
    uom_id: "PC",
    stock_status: "in_stock",
    in_stock: true,
    available_quantity: 50,
    ...overrides,
    source_url: overrides.source_url ?? `https://store.siahuat.com/product/${numericId}`,
  };
}

export type LiveOverride = Partial<Pick<ScrapedSiaHuatProduct, "price_ex_gst" | "in_stock" | "available_quantity" | "stock_status" | "stock_id">> | "fail";

export function fakeDeps(
  catalogue: CatalogueProduct[],
  live: Record<string, LiveOverride> = {},
  image: CatalogueImageLookup | null = null,
  details: Record<string, Record<string, string>> = {},
): FactDeps & { calls: string[] } {
  const calls: string[] = [];
  const byUrl = (url: string) => catalogue.find((item) => item.source_url === url);
  return {
    calls,
    async searchDirect(query) {
      calls.push(`search:${query}`);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return catalogue.filter((item) => words.every((word) => item.name.toLowerCase().includes(word)));
    },
    async searchCategory(query, limit, maxPrice) {
      calls.push(`category:${query}`);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const inField = (field: string | null | undefined) => words.every((word) => (field ?? "").toLowerCase().includes(word));
      const all = catalogue.filter((item) => inField(item.third_category) || inField(item.subcategory));
      const priced = maxPrice == null ? all : all.filter((item) => item.list_price <= maxPrice);
      return { products: priced.slice(0, limit), total: priced.length, exists: all.length > 0 };
    },
    async findByCode(stockId) {
      calls.push(`code:${stockId}`);
      return catalogue.find((item) => item.stock_id.toLowerCase() === stockId.toLowerCase()) ?? null;
    },
    async findBySourceUrl(url) {
      calls.push(`url:${url}`);
      return byUrl(url) ?? null;
    },
    async findAlternatives(stockId, _minQty, exclude) {
      calls.push(`alternatives:${stockId}`);
      return catalogue.filter((item) => item.stock_id !== stockId && !exclude.has(item.stock_id));
    },
    async fetchLive(url) {
      const item = byUrl(url);
      if (!item) throw new Error("NOT_FOUND");
      const override = live[item.stock_id];
      if (override === "fail") throw new Error("LIVE_DOWN");
      calls.push(`live:${item.stock_id}`);
      return {
        stock_id: item.stock_id, source_stock_id: null, source_product_id: "1", name: item.name, source_url: url,
        image_url: null, description: null, size: null, dimensions: null, brand: null, model: null,
        price_ex_gst: item.list_price, in_stock: true, available_quantity: item.available_quantity ?? 50,
        stock_status: "in_stock", category: null, subcategory: null, third_category: null, uom_id: item.uom_id,
        attributes: {}, last_scraped_at: "2026-09-26T06:00:00.000Z",
        ...override,
      };
    },
    async lookupImage() {
      return image;
    },
    async findDetails(codes) {
      calls.push(`details:${codes.join(",")}`);
      return new Map(codes.filter((code) => details[code]).map((code): [string, Record<string, string>] => [code, details[code]]));
    },
  };
}
