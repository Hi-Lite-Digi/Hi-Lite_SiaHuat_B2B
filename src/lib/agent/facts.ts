// src/lib/agent/facts.ts
import "server-only";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import {
  findAvailableCatalogueAlternatives,
  findCatalogueAttributes,
  findCatalogueProductBySourceUrl,
  findProductForStockCheck,
  searchCatalogueByCategory,
  searchCatalogueDirect,
} from "@/lib/catalogue";
import { lookupCatalogueImage, type CatalogueImageLookup } from "@/lib/catalogue-image-library";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "@/lib/siahuat-product";

export type CatalogueProduct = Product & { source_url: string };

/** A category's products (within any budget), how many match in all, and whether the category has products at any price. */
export type CategoryResult = { products: Product[]; total: number; exists: boolean };

/** Everything the agent may learn about products. Injected so tests run offline. */
export type FactDeps = {
  searchDirect(query: string, limit: number): Promise<Product[]>;
  searchCategory(words: string, limit: number, maxPrice?: number | null): Promise<CategoryResult>;
  findByCode(stockId: string): Promise<CatalogueProduct | null>;
  findBySourceUrl(url: string): Promise<CatalogueProduct | null>;
  findAlternatives(stockId: string, minQty: number, exclude: ReadonlySet<string>): Promise<Product[]>;
  fetchLive(url: string, timeoutMs: number): Promise<ScrapedSiaHuatProduct>;
  lookupImage(image: ImageAttachment): Promise<CatalogueImageLookup | null>;
  /** The catalogue's spec fields for these item codes, keyed by code. */
  findDetails(codes: string[]): Promise<Map<string, Record<string, string>>>;
};

/** details: the catalogue's spec fields (storeDetails); undefined until looked up this turn, null when there are none. */
export type CheckedProduct = { product: Product; verified: boolean; details?: Record<string, string> | null };

export const LIVE_CHECK_TIMEOUT_MS = 5_000;

/** Settles with `late` when the work has not finished within ms (the work itself keeps running). */
export function withTimeout<T, L>(work: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late), Math.max(1, ms)); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

const RETRY_DELAY_MS = 300;

/** Runs the work again once, after a short pause, when it fails the first time. */
export async function retryOnce<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return work();
  }
}

export function defaultFactDeps(): FactDeps {
  return {
    searchDirect: searchCatalogueDirect,
    searchCategory: searchCatalogueByCategory,
    findByCode: findProductForStockCheck,
    findBySourceUrl: findCatalogueProductBySourceUrl,
    findAlternatives: (stockId, minQty, exclude) => findAvailableCatalogueAlternatives(stockId, 30, minQty, exclude),
    fetchLive: fetchSiaHuatProduct,
    lookupImage: lookupCatalogueImage,
    findDetails: findCatalogueAttributes,
  };
}

/** One turn's lookups: the same item code or store page is fetched once, whichever step asks. Keys are exact (catalogue lookups are case-sensitive). Failures are not kept. */
export function turnDeps(deps: FactDeps): FactDeps {
  const codes = new Map<string, Promise<CatalogueProduct | null>>();
  const pages = new Map<string, Promise<ScrapedSiaHuatProduct>>();
  const once = <T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>) => {
    let hit = map.get(key);
    if (!hit) {
      hit = run();
      map.set(key, hit);
      hit.catch(() => map.delete(key));
    }
    return hit;
  };
  return {
    ...deps,
    findByCode: (code) => once(codes, code, () => deps.findByCode(code)),
    fetchLive: (url, ms) => once(pages, url, () => deps.fetchLive(url, ms)),
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

const DETAIL_FIELDS = ["Country of Brand Origin", "Material", "Colour", "Capacity", "Series", "Shape", "Model", "Electrical Specifications/ Requirement", "Warranty", "Microwaveable", "NSF"];

/** The spec fields worth citing. "N"/"No" is the catalogue's blank (Microwaveable N on 19,208 products), never a fact. */
export function storeDetails(attributes?: Record<string, unknown> | null) {
  const kept = DETAIL_FIELDS.flatMap((label): [string, string][] => {
    const value = String(attributes?.[label] ?? "").trim();
    return value && !/^(?:n|no|-|n\/a)$/i.test(value) && value.length <= 120 ? [[label, value]] : [];
  });
  return kept.length ? Object.fromEntries(kept) : undefined;
}

export const DESCRIPTION_CHARS = 2_000; // the longest catalogue description is 1,965 characters

// Claude copies names and sizes into its reply; a raw " there would end the JSON message string early.
const inchMarks = (text: string | null | undefined) => text?.replace(/"/g, "″") ?? null;

/** Compact product facts for tool results. An unverified price is left out so it is never quoted. */
export function productFact({ product, verified, details }: CheckedProduct, shownBefore = false) {
  return {
    stock_id: product.stock_id,
    name: inchMarks(product.name)!,
    brand: product.brand ?? null,
    size: inchMarks(product.size ?? product.dimensions),
    dimensions: inchMarks(product.dimensions),
    category: [product.category, product.subcategory, product.third_category].filter(Boolean).join(" > ") || null,
    description: product.description?.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS) || null,
    details: details ? Object.fromEntries(Object.entries(details).map(([label, value]) => [label, inchMarks(value)])) : null,
    price_ex_gst: verified ? product.list_price : null,
    uom: product.uom_id,
    stock: product.stock_status ?? "unknown",
    available_quantity: product.available_quantity ?? null,
    price_and_stock_verified_live: verified,
    shown_before: shownBefore,
    link: product.source_url ?? null,
  };
}
