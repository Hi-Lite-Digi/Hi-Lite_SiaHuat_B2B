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

/**
 * details: the catalogue's spec fields (storeDetails); undefined until looked up this turn, null when there are none.
 * gone: the store page no longer shows this item code (removed, or now another item): never a card, link or fact (r8 R01).
 */
export type CheckedProduct = { product: Product; verified: boolean; details?: Record<string, string> | null; gone?: boolean };

export const LIVE_CHECK_TIMEOUT_MS = 5_000;

/** Settles with `late` when the work has not finished within ms (the work itself keeps running). */
export function withTimeout<T, L>(work: Promise<T>, ms: number, late: L): Promise<T | L> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<L>((resolve) => { timer = setTimeout(() => resolve(late), Math.max(1, ms)); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

const RETRY_DELAY_MS = 300;

/** Runs the work again once, after a short pause, when it fails the first time. The pause varies so retries don't land together. */
export async function retryOnce<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // A busy search already waited its turn in the queue: joining it again would double the wait.
    if (error instanceof Error && error.message === "SEARCH_BUSY") throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS + Math.floor(Math.random() * 400)));
    return work();
  }
}

const SEARCH_CONCURRENCY = 4; // search_products fails for everyone past about 8 at once

/** At most `limit` catalogue searches run at once in this server process. A search that can't start within maxWaitMs gives up with SEARCH_BUSY without running. */
export function searchSlots(limit: number, maxWaitMs = 3_000) {
  let active = 0;
  const waiting: Array<{ start: () => void }> = [];
  // A finished search hands its slot straight to the next one waiting.
  const release = () => {
    const next = waiting.shift();
    if (next) next.start();
    else active -= 1;
  };
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = () => work().finally(release);
    if (active < limit) {
      active += 1;
      return run();
    }
    return new Promise<T>((resolve, reject) => {
      const entry = { start: () => { clearTimeout(timer); run().then(resolve, reject); } };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(entry), 1);
        reject(new Error("SEARCH_BUSY"));
      }, maxWaitMs);
      waiting.push(entry);
    });
  };
}

// Module scope: defaultFactDeps runs per request, and the limit must cover every request in this process.
const searchSlot = searchSlots(SEARCH_CONCURRENCY);

export function defaultFactDeps(): FactDeps {
  return {
    searchDirect: (query, limit) => searchSlot(() => searchCatalogueDirect(query, limit)),
    searchCategory: (words, limit, maxPrice) => searchSlot(() => searchCatalogueByCategory(words, limit, maxPrice)),
    findByCode: findProductForStockCheck,
    findBySourceUrl: findCatalogueProductBySourceUrl,
    // Its broad fallback runs search_products too. The agent ranks the pool itself, so it needs every candidate, not the 30 with
    // the most 13-Aug stock (exam 3, c07-persona T7).
    findAlternatives: (stockId, minQty, exclude) => searchSlot(() => findAvailableCatalogueAlternatives(stockId, 200, minQty, exclude)),
    fetchLive: fetchSiaHuatProduct,
    lookupImage: lookupCatalogueImage,
    findDetails: findCatalogueAttributes,
  };
}

/**
 * One turn's lookups: the same item code or store page is fetched once, whichever step asks. Keys are exact (catalogue lookups
 * are case-sensitive). Failures are not kept. The turn's searches wait here for a slot first, so a turn never has more of its
 * own searches in the shared queue than it has slots: only other chats' searches can make them give up with SEARCH_BUSY.
 */
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
  // The turn deadline bounds this wait, not the timer.
  const turnSearch = searchSlots(SEARCH_CONCURRENCY, 30_000);
  return {
    ...deps,
    searchDirect: (query, limit) => turnSearch(() => deps.searchDirect(query, limit)),
    searchCategory: (words, limit, maxPrice) => turnSearch(() => deps.searchCategory(words, limit, maxPrice)),
    findAlternatives: (stockId, minQty, exclude) => turnSearch(() => deps.findAlternatives(stockId, minQty, exclude)),
    findByCode: (code) => once(codes, code, () => deps.findByCode(code)),
    fetchLive: (url, ms) => once(pages, url, () => deps.fetchLive(url, ms)),
  };
}

/** Overwrites price and stock from the live store page. Any failure leaves the product unverified; a removed listing also marks it gone. */
export async function liveCheck(product: Product, deps: FactDeps, timeoutMs = LIVE_CHECK_TIMEOUT_MS): Promise<CheckedProduct> {
  const unverified: CheckedProduct = { product: { ...product, stock_status: "unknown", in_stock: null, available_quantity: null }, verified: false };
  if (!product.source_url) return unverified;
  try {
    // AbortSignal.timeout throws on a fraction of a millisecond, and a time left from performance.now() always has one.
    const live = await deps.fetchLive(product.source_url, Math.max(1, Math.floor(timeoutMs)));
    if (live.stock_id.toLowerCase() !== product.stock_id.toLowerCase()) return { ...unverified, gone: true };
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
  } catch (error) {
    // A removed listing answers 200 with Next's not-found page (siahuat-product.ts): gone. A timeout or parse error stays unverified.
    return error instanceof Error && error.message.startsWith("PAGE_GONE") ? { ...unverified, gone: true } : unverified;
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

const DESCRIPTION_CHARS = 2_000; // the longest catalogue description is 1,965 characters

// Claude copies names and sizes into its reply; a raw " there would end the JSON message string early.
const inchMarks = (text: string | null | undefined) => text?.replace(/"/g, "″") ?? null;

/** House codes (UB-0231, UB-06MS, UB1201) are not brands (exam 4, c10-A idx 0-2: "the UB-0292 Utility Tong"). */
export const houseCode = (brand: string) => /^UB-?\d/i.test(brand);

// A volume, or a count of them, which may mean the total or each one: "2x7L" against 14L (CED-002), "4 x 2.5l" against 10L (Nemox),
// "2 X 12 LITRES" against the name's 12L (Santos 34-2). A model code's digits are none ("MK-768L", "FX20L": an x counts only after
// a number), and "1,000ml" is 1L; a comma before a volume is no code ("H17cm,1000ml" against a store field cut to "000ml").
const VOLUME = /(?:(?<![\d.])(\d+)\s*[x×]\s*|(?<![\p{L}\d.-]))(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(ml|l|ltr|litres?|liters?)\b/giu;
const volumes = (text: string) => [...text.matchAll(VOLUME)].flatMap((match) => {
  const litres = Number(match[2].replace(/,/g, "")) / (match[3].toLowerCase() === "ml" ? 1000 : 1);
  return (match[1] ? [litres, litres * Number(match[1])] : [litres]).map((value) => ({ text: match[0], litres: value }));
});
/**
 * The store's Capacity, or a note not to quote it when no volume in the name is within 8% of it: 38 of 4,633 products, Santos 66 among them
 * (1.4L in the name, 2.4L in the field: exam 4, c02-A idx 5 and 9, c07-B idx 2). Either side can be the wrong one (N4533/L's name
 * says 12L for a 1.2L pot), so the field is kept, marked unclear.
 */
function capacityFact(name: string, capacity: string) {
  const named = volumes(name);
  const stored = volumes(capacity);
  const agree = stored.some((own) => named.some((other) => Math.abs(own.litres - other.litres) <= 0.08 * Math.max(own.litres, other.litres)));
  return named.length && stored.length && !agree ? `unclear: name says ${[...new Set(named.map((volume) => volume.text))].join(", ")}, store field says ${capacity}; don't quote either` : capacity;
}

/** Compact product facts for tool results. An unverified price is left out so it is never quoted. */
export function productFact({ product, verified, details }: CheckedProduct, shownBefore = false) {
  return {
    stock_id: product.stock_id,
    name: inchMarks(product.name)!,
    brand: product.brand && !houseCode(product.brand) ? product.brand : null,
    size: inchMarks(product.size ?? product.dimensions),
    dimensions: inchMarks(product.dimensions),
    category: [product.category, product.subcategory, product.third_category].filter(Boolean).join(" > ") || null,
    description: product.description?.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS) || null,
    details: details ? Object.fromEntries(Object.entries(details).map(([label, value]) => [label, inchMarks(label === "Capacity" ? capacityFact(product.name, value) : value)])) : null,
    price_ex_gst: verified ? product.list_price : null,
    uom: product.uom_id,
    // Plain words: the raw in_stock / out_of_stock leaked into replies (exam 3: 2 replies). The guards read stock_status.
    stock: ({ in_stock: "in stock", out_of_stock: "out of stock" } as Record<string, string>)[product.stock_status ?? ""] ?? "not checked",
    available_quantity: product.available_quantity ?? null,
    price_and_stock_verified_live: verified,
    shown_before: shownBefore,
    link: product.source_url ?? null,
  };
}
