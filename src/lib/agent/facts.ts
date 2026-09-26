// src/lib/agent/facts.ts
import "server-only";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import {
  findAvailableCatalogueAlternatives,
  findCatalogueProductBySourceUrl,
  findProductForStockCheck,
  searchCatalogueDirect,
} from "@/lib/catalogue";
import { lookupCatalogueImage, type CatalogueImageLookup } from "@/lib/catalogue-image-library";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "@/lib/siahuat-product";

export type CatalogueProduct = Product & { source_url: string };

/** Everything the agent may learn about products. Injected so tests run offline. */
export type FactDeps = {
  searchDirect(query: string, limit: number): Promise<Product[]>;
  findByCode(stockId: string): Promise<CatalogueProduct | null>;
  findBySourceUrl(url: string): Promise<CatalogueProduct | null>;
  findAlternatives(stockId: string, minQty: number, exclude: ReadonlySet<string>): Promise<Product[]>;
  fetchLive(url: string, timeoutMs: number): Promise<ScrapedSiaHuatProduct>;
  lookupImage(image: ImageAttachment): Promise<CatalogueImageLookup | null>;
};

export type CheckedProduct = { product: Product; verified: boolean };

export const LIVE_CHECK_TIMEOUT_MS = 5_000;

export function defaultFactDeps(): FactDeps {
  return {
    searchDirect: searchCatalogueDirect,
    findByCode: findProductForStockCheck,
    findBySourceUrl: findCatalogueProductBySourceUrl,
    findAlternatives: (stockId, minQty, exclude) => findAvailableCatalogueAlternatives(stockId, 12, minQty, exclude),
    fetchLive: fetchSiaHuatProduct,
    lookupImage: lookupCatalogueImage,
  };
}

/** Overwrites price and stock from the live store page. Any failure leaves the product unverified. */
export async function liveCheck(product: Product, deps: FactDeps, timeoutMs = LIVE_CHECK_TIMEOUT_MS): Promise<CheckedProduct> {
  const unverified: CheckedProduct = { product: { ...product, stock_status: "unknown", in_stock: null, available_quantity: null }, verified: false };
  if (!product.source_url) return unverified;
  try {
    const live = await deps.fetchLive(product.source_url, timeoutMs);
    if (live.stock_id.toLowerCase() !== product.stock_id.toLowerCase()) return unverified;
    return {
      verified: true,
      product: {
        ...product,
        source_url: live.source_url,
        list_price: live.price_ex_gst,
        in_stock: live.in_stock,
        available_quantity: live.available_quantity,
        stock_status: live.stock_status,
        last_scraped_at: live.last_scraped_at,
      },
    };
  } catch {
    return unverified;
  }
}

const storeLinkPattern = /(?:https?:\/\/)?store\.siahuat\.com\/product\/(\d+)/i;

export function storeProductUrl(text: string): string | null {
  const id = text.match(storeLinkPattern)?.[1];
  return id ? `https://store.siahuat.com/product/${id}` : null;
}

/** Compact product facts for tool results. */
export function productFact({ product, verified }: CheckedProduct, shownBefore = false) {
  return {
    stock_id: product.stock_id,
    name: product.name,
    brand: product.brand ?? null,
    size: product.size ?? product.dimensions ?? null,
    price_ex_gst: product.list_price,
    uom: product.uom_id,
    stock: product.stock_status ?? "unknown",
    available_quantity: product.available_quantity ?? null,
    price_and_stock_verified_live: verified,
    shown_before: shownBefore,
    link: product.source_url ?? null,
  };
}
