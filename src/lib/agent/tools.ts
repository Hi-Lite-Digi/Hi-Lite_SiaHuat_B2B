// src/lib/agent/tools.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { applyEnquiryAction, enquiryTotals } from "./enquiry";
import { liveCheck, productFact, retryOnce, storeDetails, storeProductUrl, withTimeout, type CategoryResult, type CheckedProduct, type FactDeps } from "./facts";
import { customerChose, pickedCodes, type PickEvidence } from "./picks";

/** One change update_enquiry made to the enquiry. */
export type EnquiryChange = { action: "add" | "set" | "remove" | "clear"; code: string | null };
/** One search_catalogue call: what backs a reply's "that's our range", "nothing cheaper" or "we don't have it". */
export type SearchRecord = { queries: string[]; category: string | null; categoryFound: boolean; maxPrice: number | null; complete: boolean };

/** Mutable state for one customer turn. */
export type TurnContext = {
  deps: FactDeps;
  seen: Map<string, CheckedProduct>;
  lines: EnquiryReceiptLine[];
  /** The enquiry changes that succeeded this turn: the reply may only say these happened. */
  changes: EnquiryChange[];
  /** Enquiry codes that could not be re-checked this turn: the browser keeps its own copy of those lines. */
  uncheckedCodes: string[];
  /** The customer's recent typed texts: the only place a quantity can come from. */
  customerTexts: string[];
  /** What the customer typed in this message (not a chip or tap), used to stop a stale number being added twice. */
  currentText?: string | null;
  /** Texts that may ask to clear the enquiry: the typed texts plus a chip tapped this turn. */
  clearTexts: string[];
  image: ImageAttachment | null;
  shownIds: ReadonlySet<string>;
  /** The taps, texts and cards in the chat that show which products the customer picked. */
  picks: PickEvidence;
  /** This turn's searches, for the checks on the reply's claims about the range. */
  searches: SearchRecord[];
  /** Codes update_enquiry refused this turn as not picked (PRODUCT_NOT_CHOSEN): the reply's question about them needs their cards. */
  refused?: string[];
};

export const agentTools: Anthropic.Tool[] = [
  {
    name: "search_catalogue",
    description: "Search Sia Huat's catalogue. Pass 1-3 short queries in the customer's own words (e.g. 'blow torch', 'kitchen torch'); never rename their item into a category label. Returns up to 10 products; each one's price and stock are checked live on the store (price_and_stock_verified_live). total_found counts the matches; more_available true means there are more matches than the list shows. complete true means every product in the category is listed; only then may you say that is all.",
    input_schema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "1-3 short search phrases" },
        category: { type: "string", description: "Optional catalogue category for the product type, e.g. 'kitchen tongs', 'GN pan trolleys', 'blenders', 'step stools', 'table-setting sets'. Up to 200 of its products are searched, max_price applied first. complete true means every product in it is listed. The customer's own words still rank first. If category_found is false, use a name from categories." },
        max_price: { type: "number", description: "Optional budget ceiling per unit, SGD ex GST" },
        exclude_ids: { type: "array", items: { type: "string" }, description: "Item codes the customer rejected" },
      },
      required: ["queries"],
    },
  },
  {
    name: "get_product",
    description: "Look up one product by its item code, or by a store.siahuat.com/product/<id> link the customer pasted. Price and stock are checked live. A search result already carries the same live-checked facts: don't call get_product for an item a search returned in this turn with price_and_stock_verified_live true.",
    input_schema: {
      type: "object",
      properties: {
        stock_id: { type: "string", description: "Item code, e.g. BTS-8026D" },
        url: { type: "string", description: "A store.siahuat.com/product link" },
      },
    },
  },
  {
    name: "find_alternatives",
    description: "Find up to 3 in-stock products (live-checked, at least min_qty) closest to an item: same kind first, then the nearest price; other sizes of the same series included. They are similar, not the same: check the feature the customer needs in each one's facts.",
    input_schema: {
      type: "object",
      properties: {
        stock_id: { type: "string" },
        min_qty: { type: "integer", description: "Quantity the customer needs; defaults to 1" },
      },
      required: ["stock_id"],
    },
  },
  {
    name: "match_photo",
    description: "Match the photo the customer sent in this turn against catalogue photos. Only kind 'direct' means it is that exact product; 'ambiguous' and 'candidates' are look-alikes.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "update_enquiry",
    description: "Add, set, remove or clear lines on the customer's enquiry. 'add' increases an existing line; 'set' replaces its quantity. quantity must be a number the customer typed for this item. unit 'carton' or 'packet' converts using the product's own pack size. stock_id must be a product the customer picked (a tap, its code, its name, size or price, or a yes to the only card you showed).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "set", "remove", "clear"] },
        stock_id: { type: "string" },
        quantity: { type: "integer" },
        unit: { type: "string", enum: ["uom", "carton", "packet"] },
      },
      required: ["action"],
    },
  },
];

const searchInput = z.object({
  queries: z.preprocess(
    // Claude has sent its list as one string (blow torch", "safico): split it back into phrases.
    (value) => (typeof value === "string" ? value.split(/"\s*,\s*"/).map((query) => query.replace(/^"|"$/g, "")) : value),
    // A ″ copied from the product facts still has to match catalogue names such as 18".
    z.array(z.string().trim().min(1).max(80).transform((q) => q.replace(/[″“”]/g, '"'))).min(1).max(3),
  ),
  category: z.string().trim().min(1).max(80).nullish(),
  max_price: z.number().positive().nullish(),
  exclude_ids: z.array(z.string()).max(50).nullish(),
});
const productInput = z.object({ stock_id: z.string().trim().min(1).max(100).nullish(), url: z.string().max(300).nullish() });
const alternativesInput = z.object({ stock_id: z.string().trim().min(1).max(100), min_qty: z.number().int().positive().max(100_000).nullish() });
const enquiryInput = z.object({
  action: z.enum(["add", "set", "remove", "clear"]),
  stock_id: z.string().trim().min(1).max(100).nullish(),
  quantity: z.number().int().positive().max(100_000).nullish(),
  unit: z.enum(["uom", "carton", "packet"]).nullish(),
});

/** Rows asked of each search query and of the category search. */
const QUERY_ROWS = 10;
const CATEGORY_ROWS = 200;
const RESULTS_PER_SEARCH = 10; // all are live-checked: unchecked rows showed "price to be confirmed" and were called out of stock
const NO_CATEGORY: CategoryResult = { products: [], total: 0, exists: false };
const DETAILS_TIMEOUT_MS = 1_500;
// Words that don't say which product is meant; a plural "s" is dropped so "tongs" also matches "TONG".
const STOP_WORDS = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "on", "inch"]);
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
/** A category's words as the catalogue's category filter reads them. */
const categoryTerms = (words: string) => words.toLowerCase().split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}-]/gu, "")).filter(Boolean);

/** A tool's result for Claude; error is its code, which the loop reads to decide whether another tool round can help. */
export type ToolOutcome = { content: string; isError: boolean; error?: string };
const ok = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const fail = (error: string, detail: Record<string, unknown> = {}): ToolOutcome => ({ content: JSON.stringify({ error, ...detail }), isError: true, error });
/** An error as a log code: its message when that is already a code (SUPABASE_SEARCH_500), else its name. Error text can echo customer words. */
export const errorCode = (error: unknown) => (error instanceof Error ? (/^[A-Z0-9_]{3,60}$/.test(error.message) ? error.message : error.name) : "unknown");

/**
 * Stores a checked product and returns the one kept: a failed or skipped check never replaces a live-checked one.
 * Details are catalogue data, not price or stock, so whichever copy has them keeps them.
 */
export function keepBest(ctx: TurnContext, checked: CheckedProduct) {
  const known = ctx.seen.get(checked.product.stock_id);
  const best = known?.verified && !checked.verified ? known : checked;
  const other = best === checked ? known : checked;
  const kept = !best.details && other?.details ? { ...best, details: other.details } : best;
  ctx.seen.set(checked.product.stock_id, kept);
  return kept;
}

type Details = Map<string, Record<string, string>>;

/** The catalogue's spec fields for these codes in one lookup, skipping codes this turn already has them for. A failed or slow lookup finds none. */
export function lookupDetails(ctx: TurnContext, codes: string[], limitMs = DETAILS_TIMEOUT_MS): Promise<Details> {
  const missing = [...new Set(codes)].filter((code) => ctx.seen.get(code)?.details === undefined);
  const none: Details = new Map();
  if (!missing.length) return Promise.resolve(none);
  return withTimeout(ctx.deps.findDetails(missing).catch(() => none), Math.min(DETAILS_TIMEOUT_MS, limitMs), none);
}

/** The checked product with its looked-up details (null when there are none); keepBest keeps details already known this turn. */
export const withDetails = (checked: CheckedProduct, found: Details): CheckedProduct => ({ ...checked, details: storeDetails(found.get(checked.product.stock_id)) ?? null });

function remember(ctx: TurnContext, checked: CheckedProduct) {
  return productFact(keepBest(ctx, checked), ctx.shownIds.has(checked.product.stock_id));
}

async function searchCatalogueTool(input: z.infer<typeof searchInput>, ctx: TurnContext) {
  const category = input.category;
  // One slow or failed search must not sink the others: each is retried once and the ones that succeed are used.
  const [settled, [categoryOutcome]] = await Promise.all([
    Promise.allSettled(input.queries.map((query) => retryOnce(() => ctx.deps.searchDirect(query, QUERY_ROWS)))),
    Promise.allSettled(category ? [retryOnce(() => ctx.deps.searchCategory(category, CATEGORY_ROWS, input.max_price))] : []),
  ]);
  const outcomes = [...settled, ...(categoryOutcome ? [categoryOutcome] : [])];
  if (outcomes.every((result) => result.status === "rejected")) {
    console.warn("[api/agent] search unavailable", { errors: outcomes.flatMap((result) => (result.status === "rejected" ? [errorCode(result.reason)] : [])) });
    return fail("SEARCH_UNAVAILABLE");
  }
  const queryLists = settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  const scope = categoryOutcome?.status === "fulfilled" ? categoryOutcome.value : NO_CATEGORY;
  const excluded = new Set((input.exclude_ids ?? []).map((id) => id.toLowerCase()));
  const merged: Product[] = [];
  const ids = new Set<string>();
  const add = (item: Product) => {
    if (ids.has(item.stock_id) || excluded.has(item.stock_id.toLowerCase())) return;
    if (input.max_price && item.list_price > input.max_price) return;
    ids.add(item.stock_id);
    merged.push(item);
  };
  /** Query hits that pass `keep`, taken rank by rank across the queries. */
  const byRank = (keep: (item: Product) => boolean) => {
    for (let rank = 0; rank < QUERY_ROWS; rank += 1) {
      for (const list of queryLists) if (list[rank] && keep(list[rank])) add(list[rank]);
    }
  };
  const terms = categoryTerms(category ?? "");
  const inScope = (item: Product) => scope.exists
    && [item.third_category, item.subcategory].some((field) => terms.every((term) => (field ?? "").toLowerCase().includes(term)));
  if (!category) {
    byRank(() => true);
  } else {
    const phrases = input.queries.map((query) => query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2 && !STOP_WORDS.has(word)).map(stem));
    const literal = (item: Product) => phrases.some((words) => words.length >= 2 && words.every((word) => item.name.toLowerCase().includes(word)));
    const nameHits = (item: Product) => new Set(phrases.flat().filter((word) => item.name.toLowerCase().includes(word))).size;
    const scopeByHits = [...scope.products].sort((a, b) => nameHits(b) - nameHits(a));
    byRank(inScope); // 1. query hits inside the category
    scopeByHits.filter(literal).forEach(add); // 2. category rows naming every word of a 2+ word query
    byRank(literal); // 3. other query hits naming every word of a 2+ word query
    scopeByHits.forEach(add); // 4. the rest of the category, most stocked first
    byRank(() => true); // 5. the rest of the query hits
  }
  const top = merged.slice(0, RESULTS_PER_SEARCH);
  const topIds = new Set(top.map((item) => item.stock_id));
  // Only a category read in full, with every product in it listed (or rejected), backs "that's all".
  const complete = scope.exists && scope.total <= CATEGORY_ROWS
    && scope.products.every((item) => excluded.has(item.stock_id.toLowerCase()) || topIds.has(item.stock_id));
  const totalFound = scope.exists ? scope.total + merged.filter((item) => !inScope(item)).length : merged.length;
  // A search that returned its full row limit may have more matches than it could return.
  const moreAvailable = !complete && (totalFound > top.length || queryLists.some((list) => list.length >= QUERY_ROWS));
  ctx.searches.push({ queries: input.queries, category: category ?? null, categoryFound: scope.exists, maxPrice: input.max_price ?? null, complete });
  const leafCounts = new Map<string, number>();
  for (const item of merged) if (item.third_category) leafCounts.set(item.third_category, (leafCounts.get(item.third_category) ?? 0) + 1);
  const categories = [...leafCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
  const categoryNote = !category ? null
    : categoryOutcome?.status === "rejected" ? "Category search failed."
    : !scope.exists ? `No catalogue category matches '${category}'.${categories.length ? ` Categories among these results: ${categories.join(", ")}.` : ""}`
    : null;
  const [checked, details] = await Promise.all([
    Promise.all(top.map((item) => liveCheck(item, ctx.deps))),
    lookupDetails(ctx, top.map((item) => item.stock_id)),
  ]);
  const affordable = checked.filter((item) => !input.max_price || item.product.list_price <= input.max_price);
  return ok({
    products: affordable.map((item) => remember(ctx, withDetails(item, details))),
    total_found: totalFound,
    more_available: moreAvailable,
    complete,
    ...(category ? { category_found: scope.exists } : {}),
    categories,
    ...(categoryNote ? { category_note: categoryNote } : {}),
    ...(affordable.length ? {} : { note: "No catalogue matches for these words. Try other words the customer might mean, or ask one question." }),
  });
}

async function getProductTool(input: z.infer<typeof productInput>, ctx: TurnContext) {
  const url = input.url ? storeProductUrl(input.url) : null;
  if (!url && !input.stock_id) return fail("MISSING_FIELDS");
  const found = await retryOnce(() => (url ? ctx.deps.findBySourceUrl(url) : ctx.deps.findByCode(input.stock_id!)));
  if (!found) return fail("NOT_FOUND");
  const [checked, details] = await Promise.all([liveCheck(found, ctx.deps), lookupDetails(ctx, [found.stock_id])]);
  return ok({ product: remember(ctx, withDetails(checked, details)) });
}

// Name words that say nothing about what a product is: materials, colours, warranty and spec text many products share, and
// unit words ("gal" made a salad spinner a whisk mixer's alternative: exam 3, c07-persona T7).
const GENERIC = new Set(["the", "and", "for", "per", "pcs", "set", "new", "top", "stainless", "steel", "with", "without", "black", "white", "grey", "gray", "blue", "red", "green", "silver", "size", "piece", "pieces", "year", "warranty", "domestic", "function", "speed", "come", "free", "pulse", "heat", "resistant", "use", "pro", "rpm", "plug", "phase", "gal", "ltr", "litre", "liter", "capacity"]);
const letterWords = (text: string): string[] => text.toLowerCase().match(/\p{L}{3,}/gu) ?? [];
// Whole brand words only: "Panasonic" must not hide "pan". "pans" matches "pan".
const kindWords = (item: Product) => new Set(letterWords(item.name)
  .filter((word) => !GENERIC.has(word) && !letterWords(item.brand ?? "").includes(word)).map(stem));
/** How many of b's words a shares, counting a 4+ letter word that sits inside the other's ("torch" in "blowtorch"). */
const sharedWords = (a: Set<string>, b: Set<string>) => [...b].filter((word) => [...a].some((own) => own === word
  || (Math.min(own.length, word.length) >= 4 && (own.includes(word) || word.includes(own))))).length;
/** A product's series: its name before the first comma, bracket, size or number ("Patra Rim Plate 18cm, …" -> "Patra Rim Plate"). */
export const seriesName = (name: string) => name.split(/[,(]|\s\d|\s[Øø]/)[0].replace(/\s+/g, " ").trim();
/** How far apart two prices are, as a ratio: a proxy for size and grade. */
const priceGap = (item: Product, source: Product) => Math.abs(Math.log(Math.max(item.list_price, 0.01) / Math.max(source.list_price, 0.01)));
// "Cover For #4010 Pot" fits another product; it is no substitute for the pot.
const ACCESSORY = /\b(?:cover|lid)\s+for\b|\bfor\s+#/i;
const NO_CLOSE_ALTERNATIVE = "No close in-stock match in the same range. Check size and capacity against what the customer needs; search with the customer's words and size (e.g. 'stock pot 12L') before saying there is no substitute.";
const ALTERNATIVES_UNCHECKED = "Stock couldn't be checked live right now, so no alternative can be offered. Don't say there is no substitute; say you couldn't check stock just now.";

async function alternativesTool(input: z.infer<typeof alternativesInput>, ctx: TurnContext) {
  const minQty = input.min_qty ?? 1;
  let candidates: Product[];
  let source: Product | null;
  let siblings: Product[];
  const exclude = new Set([...ctx.shownIds, input.stock_id]);
  try {
    const sourceLookup = ctx.deps.findByCode(input.stock_id).catch(() => null);
    // 1,405 active products have no leaf category, so the catalogue finds no siblings for them (exam 3, c05-persona T12: Patra):
    // search the series by name alongside the catalogue query.
    const siblingsLookup = sourceLookup.then((found) => (found && seriesName(found.name).split(" ").length >= 2
      ? ctx.deps.searchDirect(seriesName(found.name), 10).catch(() => [])
      : []));
    [candidates, source, siblings] = await Promise.all([
      retryOnce(() => ctx.deps.findAlternatives(input.stock_id, minQty, exclude)),
      sourceLookup,
      siblingsLookup,
    ]);
  } catch (error) {
    console.warn("[api/agent] search unavailable", { errors: [errorCode(error)] });
    return fail("SEARCH_UNAVAILABLE");
  }
  // Only products of the same kind (exam 2, s10-A: bowls and a gas cartridge offered for a torch).
  if (source) {
    const series = seriesName(source.name).toLowerCase();
    const uom = source.uom_id.trim().toLowerCase();
    const pooled = new Set(candidates.map((item) => item.stock_id));
    for (const item of siblings) {
      // Other sizes of the same series only, in stock with enough (exam 3 check: a name search offered refuse bins for a step stool
      // and a mop for a toaster, and out-of-stock rows used up the live checks).
      if (item.stock_id === source.stock_id || pooled.has(item.stock_id) || exclude.has(item.stock_id) || item.uom_id.trim().toLowerCase() !== uom) continue;
      if (seriesName(item.name).toLowerCase() !== series || item.stock_status !== "in_stock" || (item.available_quantity ?? 0) < minQty) continue;
      candidates.push(item);
      pooled.add(item.stock_id);
    }
    const own = kindWords(source);
    const leaf = source.third_category;
    const sameLeaf = (item: Product) => Number(Boolean(leaf) && item.third_category === leaf);
    const accessoryOk = ACCESSORY.test(source.name);
    const shared = new Map(candidates.map((item) => [item.stock_id, sharedWords(own, kindWords(item))]));
    // Same leaf, then more kind words, then the nearest price as a proxy for size and grade; stale stock no longer orders it
    // (exam 3, c07-persona T7: the most stocked mixers crowded out the closest ones).
    candidates = candidates
      .filter((item) => shared.get(item.stock_id)! > 0 && (accessoryOk || !ACCESSORY.test(item.name)))
      .sort((a, b) => sameLeaf(b) - sameLeaf(a) || shared.get(b.stock_id)! - shared.get(a.stock_id)! || priceGap(a, source) - priceGap(b, source));
  }
  // The source is checked too, so the reply's "X is out of stock" is judged against its live stock (the memo avoids a refetch).
  const checking = candidates.slice(0, 8);
  const [checkedSource, checked, details] = await Promise.all([
    source && liveCheck(source, ctx.deps),
    Promise.all(checking.map((item) => liveCheck(item, ctx.deps))),
    lookupDetails(ctx, [...(source ? [source] : []), ...checking].map((item) => item.stock_id)),
  ]);
  const sourceFact = checkedSource ? { source: remember(ctx, withDetails(checkedSource, details)) } : {};
  const available = checked
    .filter((item) => item.verified && item.product.stock_status === "in_stock" && (item.product.available_quantity ?? 0) >= minQty)
    .slice(0, 3);
  if (!available.length) {
    return ok({ ...sourceFact, products: [], note: checked.length && !checked.some((item) => item.verified) ? ALTERNATIVES_UNCHECKED : NO_CLOSE_ALTERNATIVE });
  }
  return ok({ ...sourceFact, products: available.map((item) => remember(ctx, withDetails(item, details))) });
}

async function matchPhotoTool(ctx: TurnContext) {
  if (!ctx.image) return fail("NO_PHOTO");
  const result = await ctx.deps.lookupImage(ctx.image);
  if (!result) return ok({ kind: "none", products: [], note: "No catalogue photo match. Describe what you see and search by product type." });
  const matches = result.products.slice(0, 5);
  const [checked, details] = await Promise.all([
    Promise.all(matches.map((item) => liveCheck(item, ctx.deps))),
    lookupDetails(ctx, matches.map((item) => item.stock_id)),
  ]);
  return ok({ kind: result.kind, exact_product: result.kind === "direct", products: checked.map((item) => remember(ctx, withDetails(item, details))) });
}

/**
 * While some lines could not be re-checked, the lines and totals Claude sees are not what the enquiry bar shows
 * (the browser adds those lines back), so Claude must not quote a total or an item count, or say those lines are gone.
 */
export function uncheckedNote(codes: string[]) {
  return codes.length
    ? `Unchecked lines (kept by the customer, not in these lines or totals): ${codes.join(", ")}. Don't quote an enquiry total or item count; the enquiry bar shows the full enquiry. They are still on the customer's enquiry: never say they were removed or are missing.`
    : undefined;
}

function enquiryState(ctx: TurnContext) {
  return { lines: ctx.lines, totals: enquiryTotals(ctx.lines), unchecked: uncheckedNote(ctx.uncheckedCodes) };
}

const REFUSED_LOOKUP_MS = 2_000; // like an earlier card's check: the question about it shouldn't wait longer
const NOT_CHOSEN_NOTE = "The customer's words don't show they picked this product. Don't call update_enquiry for this code again this turn; if picked lists a product, that one may be added. Otherwise ask one short question naming this product with its code ('Is it the <name> <code>?') with its card attached, or if two or three fit, attach them and ask which one. A yes or a tap then adds it.";

/**
 * The refused product's live facts, so the question about it can give its price and carry its card; null when slow or not found
 * (exam 3, c08-persona T8: the refused product wasn't looked up, so the question's price and card were lost).
 */
function refusedProduct(code: string, ctx: TurnContext) {
  const until = performance.now() + REFUSED_LOOKUP_MS;
  return withTimeout((async () => {
    const found = await ctx.deps.findByCode(code).catch(() => null);
    if (!found) return null;
    // Only the time left in the cap, so the live check doesn't run on after the tool has answered.
    const left = until - performance.now();
    const [checked, details] = await Promise.all([liveCheck(found, ctx.deps, left), lookupDetails(ctx, [found.stock_id], left)]);
    return remember(ctx, withDetails(checked, details));
  })(), REFUSED_LOOKUP_MS, null);
}

async function enquiryTool(input: z.infer<typeof enquiryInput>, ctx: TurnContext) {
  // A line that could not be re-checked stays as the browser has it: it can be removed or cleared, not changed.
  const code = input.stock_id?.toLowerCase();
  if (input.action !== "clear" && ctx.uncheckedCodes.some((item) => item.toLowerCase() === code)) {
    // exam 3, c08-stress T12: a bare STOCK_UNVERIFIED led to retries, then a claim the line was removed.
    if (input.action !== "remove") return fail("STOCK_UNVERIFIED", { note: "This line is still on the customer's enquiry but couldn't be re-checked just now; don't change it this turn." });
    ctx.uncheckedCodes = ctx.uncheckedCodes.filter((item) => item.toLowerCase() !== code);
    ctx.changes.push({ action: "remove", code: input.stock_id ?? null });
    return ok(enquiryState(ctx));
  }
  const lineCodes = ctx.lines.map((line) => line.code);
  if ((input.action === "add" || input.action === "set") && input.stock_id && !customerChose(input.stock_id, input.quantity ?? null, ctx.picks, lineCodes)) {
    (ctx.refused ??= []).push(input.stock_id);
    return fail("PRODUCT_NOT_CHOSEN", { note: NOT_CHOSEN_NOTE, product: await refusedProduct(input.stock_id, ctx), picked: pickedCodes(ctx.picks, lineCodes) });
  }
  // The typed number lets a second add through (it guards against an earlier message's number); within one turn it would double the line.
  if (input.action === "add" && ctx.changes.some((change) => (change.action === "add" || change.action === "set") && change.code?.toLowerCase() === code)) {
    return fail("ALREADY_ON_ENQUIRY", { notice: "Already added in this turn; use set only if the customer typed a new total." });
  }
  const result = await applyEnquiryAction(ctx.lines, {
    action: input.action,
    stock_id: input.stock_id ?? undefined,
    quantity: input.quantity ?? undefined,
    unit: input.unit ?? undefined,
  }, input.action === "clear" ? ctx.clearTexts : ctx.customerTexts, ctx.deps, { currentText: ctx.currentText });
  if (result.product) remember(ctx, result.product);
  if (!result.ok) return fail(result.error, { available: result.available ?? undefined, notice: result.notice || undefined });
  ctx.lines = result.lines;
  ctx.changes.push({ action: input.action, code: result.product?.product.stock_id ?? input.stock_id ?? null });
  if (input.action === "clear") ctx.uncheckedCodes = [];
  return ok({ ...enquiryState(ctx), notice: result.notice || undefined });
}

export async function runTool(name: string, rawInput: unknown, ctx: TurnContext): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "search_catalogue": return await searchCatalogueTool(searchInput.parse(rawInput), ctx);
      case "get_product": return await getProductTool(productInput.parse(rawInput), ctx);
      case "find_alternatives": return await alternativesTool(alternativesInput.parse(rawInput), ctx);
      case "match_photo": return await matchPhotoTool(ctx);
      case "update_enquiry": return await enquiryTool(enquiryInput.parse(rawInput), ctx);
      default: return fail("UNKNOWN_TOOL");
    }
  } catch (error) {
    if (error instanceof z.ZodError) return fail("INVALID_INPUT", { issues: error.issues.map((issue) => issue.message) });
    console.warn("[api/agent] tool failed", { tool: name, error: errorCode(error) });
    return fail("TOOL_FAILED");
  }
}
