// src/lib/agent/tools.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { QTY_NOTICE, applyEnquiryAction, enquiryTotals, quantityStated, soldByDozen, totalsWithGst, typedQuantities, unitStated, withGstCents } from "./enquiry";
import { houseCode, liveCheck, productFact, retryOnce, storeDetails, storeProductUrl, withTimeout, type CategoryResult, type CheckedProduct, type FactDeps } from "./facts";
import { codePattern, same } from "./picks";
import { decidePick, type PickCheckCache, type PickProposal } from "./verify";

/** One change update_enquiry made to the enquiry. */
export type EnquiryChange = { action: "add" | "set" | "remove" | "clear"; code: string | null };
/**
 * One search_catalogue call: what backs a reply's "that's our range", "nothing cheaper" or "we don't have it". A find_alternatives
 * run is recorded too (alternativesFor, with no queries): it backs "no close substitute".
 */
export type SearchRecord = { queries: string[]; category: string | null; categoryFound: boolean; maxPrice: number | null; complete: boolean; alternativesFor?: string };

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
  /** This turn's searches, for the checks on the reply's claims about the range. */
  searches: SearchRecord[];
  /**
   * Codes update_enquiry refused this turn as not picked (NOT_PICKED, PICK_UNCLEAR and its candidates, PICK_UNCONFIRMED,
   * PICK_UNCHECKED, PICKED_OTHER): the reply's question about them needs their cards.
   */
  refused: string[];
  /** The card the customer tapped this turn: the tap is the pick. */
  tapped: string | null;
  /** The AI pick double-check: one per code, action and number this turn. */
  checkPick: PickCheckCache;
  /** match_photo's products this turn: "direct" is the exact product in the photo, the rest look alike. */
  photoMatches: Map<string, "direct" | "look-alike">;
  /** Lines whose removal update_enquiry refused this turn (REMOVE_REFUSED, SWAP_NOT_DONE): they stay on the enquiry. */
  kept: string[];
  /** Codes whose add or set failed this turn and hasn't gone through since: a removal of another line waits on them, like a swap's. */
  failedAdds: string[];
  /** A pick-check refusal this turn that no retry can change (REMOVE_REFUSED, or no number typed for the item): no nudge back to the tools. */
  finalRefusal: boolean;
  /** The update_enquiry calls refused this turn, as refusalKey gives them. */
  refusedKeys: Set<string>;
  /** Adds and sets a tap this turn picked with no check. */
  pickFast: number;
  /** The customer's last two typed texts ask about GST: the totals and product facts Claude sees then carry code's estimate with GST. */
  gstAsked?: boolean;
  /**
   * The work deadline cut this turn's tool round, and the answer was told the updates still running didn't finish: they change
   * nothing when they land (r6 review: an add whose pick verdict came after the cut still went onto the enquiry).
   */
  closed?: boolean;
  /** search_catalogue calls in this tool round: they share READS_PER_ROUND live reads; more than LIST_SEARCHES is a list's round. */
  roundSearches?: number;
  /** Item codes (exact) whose store listing came back gone this turn: never a card, link or fact (r8 R01). */
  gone: Set<string>;
};

export const agentTools: Anthropic.Tool[] = [
  {
    name: "search_catalogue",
    description: "Search Sia Huat's catalogue. Pass 1-3 short queries in the customer's own words (e.g. 'blow torch', 'kitchen torch'); never rename their item into a category label. Returns up to 10 products; each one's price and stock are checked live on the store (price_and_stock_verified_live). total_found counts the matches; more_available true means there are more matches than the list shows. complete true means every product in the category is listed; only then may you say that is all. With a category, brands lists brands among the rows this search read (there may be others): don't say we only carry some brands when brands lists others.",
    input_schema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "1-3 short search phrases" },
        category: { type: "string", description: "Optional catalogue category for the product type, e.g. 'kitchen tongs', 'GN pan trolleys', 'blenders', 'step stools', 'table-setting sets', or a range or section name from SIA HUAT'S CATALOGUE RANGES ('Furniture & Banquet Equipment', 'Chef & Crew Wear'). Up to 200 of its products are searched, max_price applied first. complete true means every product in it is listed. The customer's own words still rank first. If category_found is false, use a name from categories." },
        max_price: { type: "number", description: "Optional budget ceiling per unit, SGD ex GST" },
        exclude_ids: { type: "array", items: { type: "string" }, description: "Item codes the customer rejected" },
        exclude_brands: { type: "array", items: { type: "string" }, description: "Brands the customer ruled out, or every brand of a country they don't want (details 'Country of Brand Origin')" },
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
    description: "Add, set, remove or clear lines on the customer's enquiry. 'add' increases an existing line; 'set' replaces its quantity. quantity must be a number the customer typed for this item. unit 'carton' or 'packet' converts using the product's own pack size. stock_id must be a product the customer picked. A separate check reads the chat to confirm the pick (or that they asked to remove the line) and the number they typed for this item. For a swap, send the add of the new item and the remove of the old one in the same response.",
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
  exclude_brands: z.array(z.string().trim().min(1).max(60)).max(20).nullish(),
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
// A round's searches share about this many live reads, at least 5 each (6 searches at once read 30): from the function in iad1,
// 30 at once ran the last past the 5 s limit and went out "Price to be confirmed" (r8 R02, R09); 20 (R08) didn't.
const READS_PER_ROUND = 20;
const MIN_RESULTS_PER_SEARCH = 5; // R02's glove 08-00840 was 5th, behind dead catalogue rows
// A list's six searches of 2-3 queries each ran 13-18 catalogue calls, 4 at a time, past the 35 s work deadline (r8 M03 at six items):
// in a round of more searches than this, each search makes two catalogue calls at most.
const LIST_SEARCHES = 3;
const NO_CATEGORY: CategoryResult = { products: [], total: 0, exists: false };
const DETAILS_TIMEOUT_MS = 1_500;
const BUDGET_NOTE = "Nothing within max_price among the top matches for these words; they are all above it. Try the customer's own shorter words (one key word) with max_price, or a category from categories, before saying there is nothing cheaper.";
// A bare error read as a broken system: "Sorry, I'm having trouble searching our catalogue right now" in all 8 replayed outage turns
// (r6, real model), each after 2-3 search retries (about 10 s). An earlier wording of this note gave "Sorry, I couldn't check that
// just now...", about 5 s; this wording (no sizes, brands or products of its own) is not yet measured.
const SEARCH_UNAVAILABLE_NOTE = "The catalogue didn't answer this time, so nothing was found or ruled out. Don't say you're having trouble, that anything is down or broken, or that we don't have it. In a few words say you couldn't check that just now and ask them to send it again, and if it helps, what it's for or the size, without suggesting sizes, brands or products yourself; set show_contact true so Sia Huat sales can help meanwhile.";
const NO_MATCH_NOTE = "No catalogue matches for these words. Try other words the customer might mean, or ask one question.";
// Removed listings ranked first filled a search's reads (a list round's 5 for "grey cut resistant glove", r8 Batch 1 review): never
// "no matches", which reads as "we don't carry it".
const REMOVED_MATCHES_NOTE = "The top catalogue matches for these words are store listings that have been removed, so none can be shown. Don't say we don't carry it: search again with other or shorter words the customer might mean, or ask one question.";
// 15 of the 131 removed pages have their code live on a new page: "couldn't confirm", never "not sold". Read as a passing failure, it
// was looked up again in R03 (r8 tier 3), so the note says a second look gives the same.
const LISTING_GONE_NOTE = "This item code's store listing has been removed, so it can't be confirmed here right now. Looking it up again this turn gives this same result: don't call get_product for it again. Don't name or describe a product for it, show its card or give its link. Say plainly you couldn't confirm that code on the store just now and set show_contact true so Sia Huat sales can check it; if the customer said what it is, offer to search for it.";
// Words that don't say which product is meant; a plural "s" is dropped so "tongs" also matches "TONG".
const STOP_WORDS = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "on", "inch"]);
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
/** A category's words as the catalogue's category filter reads them. */
const categoryTerms = (words: string) => words.toLowerCase().split(/[\s/'’]+/).map((word) => word.replace(/[^\p{L}\p{N}-]/gu, "")).filter(Boolean);
// "8.0oz" and "8oz" are one size (exam 3, s01-A T0). A size word is a number joined to its unit; "2 in 1" is not a size. Names say
// "S/S" where customers say "stainless steel" (exam 4, s01-B idx 0: "S/S ONE-PC LADLE 6.0oz").
const sizeText = (text: string) => text.toLowerCase().replace(/\bs\/s\b/g, "stainless steel").replace(/(\d)\.0(?!\d)/g, "$1");
const SIZE_WORD = /^\d+(?:oz|qt|l|ltr|litre|ml|cm|mm|in|inch)$/;
// A size word is a whole number: "6oz" is not inside "16oz" or "1/2oz", and "1.5L" gives no "5l" (exam 3: s01-A T0 asked for 6oz,
// c12-stress for 7cm and 7.5cm). A size after another unit and a slash ("16oz/500ml", '12"/30cm') is still that size.
const sizeIn = (text: string, word: string) => new RegExp(String.raw`(?<!\d)(?<!\d[./])${word}`).test(text);
// Colour words don't make a different product (exam 3, c01-A T9: one range's red and blue handles filled the top 10).
const COLOUR_WORDS = /\b(?:black|white|red|blue|green|yellow|brown|violet|purple|orange|pink|gr[ae]y|cream|beige|ivory|handle|hdle)\b/g;
const variantKey = (item: Product) => `${item.name.toLowerCase().replace(COLOUR_WORDS, " ").replace(/[^\p{L}\p{N}.]+/gu, " ").trim()}|${item.size ?? item.dimensions ?? ""}|${item.list_price}`;
const BRAND_SHARE = 4;

/**
 * Rank order, but on a first pass one colour variant per product and at most BRAND_SHARE per brand the queries don't name. Once
 * an item is skipped, only items naming at least as many query words may take its place, so category filler never outranks a
 * real match; the rest fill in after.
 */
function varied(items: Product[], limit: number, queries: string[], phrases: string[][]) {
  const words = [...new Set(phrases.flat())];
  const hits = (item: Product) => words.filter((word) => sizeText(item.name).includes(word)).length;
  // Whole words only: short brands (AG, IR, AKI) sit inside "bag", "stir" and "baking".
  const named = (brand: string) => queries.some((query) => codePattern(brand).test(query));
  const first: Product[] = [];
  const keys = new Set<string>();
  const perBrand = new Map<string, number>();
  let floor = 0;
  for (const item of items) {
    if (first.length >= limit) break;
    const brand = houseCode(item.brand ?? "") ? "" : (item.brand ?? "").toLowerCase();
    const count = perBrand.get(brand) ?? 0;
    const itemHits = hits(item);
    if (itemHits < floor) continue;
    if (keys.has(variantKey(item)) || (brand && !named(brand) && count >= BRAND_SHARE)) {
      floor = Math.max(floor, itemHits);
      continue;
    }
    first.push(item);
    keys.add(variantKey(item));
    perBrand.set(brand, count + 1);
  }
  return [...first, ...items.filter((item) => !first.includes(item))].slice(0, limit);
}

/** Brands among a category search's rows, most first; house codes aren't brands. Names only: the counts are rows, not stock. */
const brandNames = (items: Product[]) => [...items.reduce((counts, item) => (item.brand && !houseCode(item.brand) ? counts.set(item.brand, (counts.get(item.brand) ?? 0) + 1) : counts), new Map<string, number>())]
  .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([brand]) => brand);

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
  // A listing the store removed is never kept: no card, link or price can come from it (r8 R01: 04-00820's dead chiller page).
  if (checked.gone) {
    ctx.gone.add(checked.product.stock_id);
    return checked;
  }
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
  const fact = productFact(keepBest(ctx, checked), ctx.shownIds.has(checked.product.stock_id));
  // One product's price with GST ("46.70 is with GST?"), from a live-checked price only (owner question 4).
  return ctx.gstAsked && fact.price_ex_gst !== null ? { ...fact, price_with_gst: withGstCents(fact.price_ex_gst) / 100 } : fact;
}

async function searchCatalogueTool(asked: z.infer<typeof searchInput>, ctx: TurnContext) {
  const listRound = (ctx.roundSearches ?? 0) > LIST_SEARCHES;
  const input = listRound ? { ...asked, queries: asked.queries.slice(0, asked.category ? 1 : 2) } : asked;
  const category = input.category;
  // One slow or failed search must not sink the others: each is retried once and the ones that succeed are used.
  const [settled, [categoryOutcome]] = await Promise.all([
    Promise.allSettled(input.queries.map((query) => retryOnce(() => ctx.deps.searchDirect(query, QUERY_ROWS)))),
    Promise.allSettled(category ? [retryOnce(() => ctx.deps.searchCategory(category, CATEGORY_ROWS, input.max_price))] : []),
  ]);
  const outcomes = [...settled, ...(categoryOutcome ? [categoryOutcome] : [])];
  if (outcomes.every((result) => result.status === "rejected")) {
    console.warn("[api/agent] search unavailable", { errors: outcomes.flatMap((result) => (result.status === "rejected" ? [errorCode(result.reason)] : [])) });
    return fail("SEARCH_UNAVAILABLE", { note: SEARCH_UNAVAILABLE_NOTE });
  }
  const queryLists = settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  const scope = categoryOutcome?.status === "fulfilled" ? categoryOutcome.value : NO_CATEGORY;
  const excluded = new Set((input.exclude_ids ?? []).map((id) => id.toLowerCase()));
  // exam 3, c03-stress T6-T9: "dun wan taiwan" had no way to leave a brand out.
  const excludedBrands = new Set((input.exclude_brands ?? []).map((brand) => brand.toLowerCase()));
  const merged: Product[] = [];
  const ids = new Set<string>();
  // A listing found removed this turn is no match either: its read isn't spent again (the turn's memo keeps no failed read).
  const ruledOutItem = (item: Product) => excluded.has(item.stock_id.toLowerCase()) || excludedBrands.has((item.brand ?? "").toLowerCase()) || ctx.gone.has(item.stock_id);
  const add = (item: Product) => {
    if (ids.has(item.stock_id) || ruledOutItem(item)) return;
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
    && [item.category, item.third_category, item.subcategory].some((field) => terms.every((term) => (field ?? "").toLowerCase().includes(term)));
  const phrases = input.queries.map((query) => sizeText(query).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2 && !STOP_WORDS.has(word)).map(stem));
  const literal = (item: Product) => phrases.some((words) => words.length >= 2 && words.every((word) => sizeText(item.name).includes(word)));
  if (!category) {
    // A row naming every word of a query first: "rice dispenser" beside "rice bin" had its one exact row 9th (exam 4, s03-B idx 1).
    byRank(literal);
    byRank(() => true);
  } else {
    const nameHits = (item: Product) => new Set(phrases.flat().filter((word) => sizeText(item.name).includes(word))).size;
    const scopeByHits = [...scope.products].sort((a, b) => nameHits(b) - nameHits(a));
    const sizedPhrases = phrases.filter((words, index) => words.some((word) => SIZE_WORD.test(word) && sizeIn(sizeText(input.queries[index]), word)));
    // Sizes of one unit are choices ("ladle 4oz 6oz 8oz": any will do, exam 4, s01-B idx 0); sizes in different units describe one
    // product ("stock pot 40cm 50l"), so each must match.
    const sizedLiteral = (item: Product) => sizedPhrases.some((words) => {
      const name = sizeText(item.name);
      const sizes = words.filter((word) => SIZE_WORD.test(word));
      const choices = new Set(sizes.map((word) => word.replace(/^\d+/, ""))).size === 1;
      return words.every((word) => SIZE_WORD.test(word) || name.includes(word))
        && (choices ? sizes.some((word) => sizeIn(name, word)) : sizes.every((word) => sizeIn(name, word)));
    });
    if (sizedPhrases.length) {
      // 0. rows naming the customer's exact size with every word of its query ("ladle 8oz" showed the 8oz ladle 10th or not at all)
      scopeByHits.filter(sizedLiteral).forEach(add);
      byRank(sizedLiteral);
    }
    byRank(inScope); // 1. query hits inside the category
    scopeByHits.filter(literal).forEach(add); // 2. category rows naming every word of a 2+ word query
    byRank(literal); // 3. other query hits naming every word of a 2+ word query
    scopeByHits.forEach(add); // 4. the rest of the category, most stocked first
    byRank(() => true); // 5. the rest of the query hits
  }
  const shared = Math.floor(READS_PER_ROUND / Math.max(1, ctx.roundSearches ?? 1));
  const top = varied(merged, Math.max(MIN_RESULTS_PER_SEARCH, Math.min(RESULTS_PER_SEARCH, shared)), input.queries, phrases);
  const topIds = new Set(top.map((item) => item.stock_id));
  // Only a category read in full, with every product in it listed (or rejected), backs "that's all". A brand the customer ruled
  // out still exists, so exclude_brands doesn't count as covered: "that's all" would be false.
  const complete = scope.exists && scope.total <= CATEGORY_ROWS
    && scope.products.every((item) => excluded.has(item.stock_id.toLowerCase()) || ctx.gone.has(item.stock_id) || topIds.has(item.stock_id));
  // The ruled-out brand's rows aren't matches, so more_available doesn't count them.
  const ruledOut = scope.products.filter((item) => excludedBrands.has((item.brand ?? "").toLowerCase())).length;
  const totalFound = scope.exists ? scope.total - ruledOut + merged.filter((item) => !inScope(item)).length : merged.length;
  // Hits that only max_price removed are still matches, above the budget: "No catalogue matches" read as nothing cheaper (exam 4,
  // c06-stress idx 2-3), so the note says so and categories come from them. Ruled-out hits are no matches at any price.
  const overBudget = merged.length || !input.max_price ? [] : queryLists.flat().filter((item) => !ruledOutItem(item) && item.list_price > (input.max_price ?? Infinity));
  const leafCounts = new Map<string, number>();
  for (const item of overBudget.length ? overBudget : merged) if (item.third_category) leafCounts.set(item.third_category, (leafCounts.get(item.third_category) ?? 0) + 1);
  const categories = [...leafCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
  const categoryNote = !category ? null
    : categoryOutcome?.status === "rejected" ? "Category search failed."
    : !scope.exists ? `No catalogue category matches '${category}'.${categories.length ? ` Categories among these results: ${categories.join(", ")}.` : ""}`
    : null;
  const read = (items: Product[]) => Promise.all([
    Promise.all(items.map((item) => liveCheck(item, ctx.deps))),
    lookupDetails(ctx, items.map((item) => item.stock_id)),
  ]);
  const [first, firstDetails] = await read(top);
  // A removed listing doesn't keep its place: the next rows are read once in place of the removed ones (r8 Batch 1 review: 3 of 5
  // reads of "grey cut resistant glove" were removed listings, and live gloves ranked below them were never shown).
  const removedCount = first.filter((item) => item.gone).length;
  const next = removedCount ? varied(merged.filter((item) => !topIds.has(item.stock_id)), removedCount, input.queries, phrases) : [];
  const [more, moreDetails] = await read(next);
  const checked = [...first, ...more];
  const details = new Map([...firstDetails, ...moreDetails]);
  for (const item of checked) if (item.gone) ctx.gone.add(item.product.stock_id);
  // A search that returned its full row limit may have more matches than it could return.
  const moreAvailable = !complete && (totalFound > checked.length || queryLists.some((list) => list.length >= QUERY_ROWS));
  // Matches left out as removed listings, found by this search or earlier this turn.
  const removed = [...queryLists.flat(), ...scope.products].some((item) => ctx.gone.has(item.stock_id));
  // Recorded once its results are ready, not before its live checks (the slow part): a search the deadline cut while they ran backed
  // "that's all" and "we don't carry" in an answer that was told it didn't finish (r6 review).
  ctx.searches.push({ queries: input.queries, category: category ?? null, categoryFound: scope.exists, maxPrice: input.max_price ?? null, complete });
  const affordable = checked.filter((item) => !item.gone && (!input.max_price || item.product.list_price <= input.max_price));
  return ok({
    products: affordable.map((item) => remember(ctx, withDetails(item, details))),
    total_found: totalFound,
    // With no products returned it would contradict the no-match note.
    more_available: moreAvailable && (affordable.length > 0 || removed),
    complete,
    // exam 3, c01-A T9-T11: from a top 10 of two brands Claude said all our chef knives were those two.
    ...(scope.exists ? { brands: brandNames(merged) } : {}),
    ...(category ? { category_found: scope.exists } : {}),
    categories,
    ...(categoryNote ? { category_note: categoryNote } : {}),
    ...(affordable.length ? {} : { note: overBudget.length ? BUDGET_NOTE : removed ? REMOVED_MATCHES_NOTE : NO_MATCH_NOTE }),
  });
}

async function getProductTool(input: z.infer<typeof productInput>, ctx: TurnContext) {
  const url = input.url ? storeProductUrl(input.url) : null;
  if (!url && !input.stock_id) return fail("MISSING_FIELDS");
  // A code whose listing came back gone this turn gives the same result again, with no read (r8 R03: 04-00820 was looked up twice).
  if (!url && ctx.gone.has(input.stock_id!)) return fail("LISTING_GONE", { stock_id: input.stock_id, note: LISTING_GONE_NOTE });
  const found = await retryOnce(() => (url ? ctx.deps.findBySourceUrl(url) : ctx.deps.findByCode(input.stock_id!)));
  if (!found) return fail("NOT_FOUND");
  const [checked, details] = await Promise.all([liveCheck(found, ctx.deps), lookupDetails(ctx, [found.stock_id])]);
  if (checked.gone) {
    ctx.gone.add(found.stock_id);
    return fail("LISTING_GONE", { stock_id: found.stock_id, note: LISTING_GONE_NOTE });
  }
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
const seriesName = (name: string) => name.split(/[,(]|\s\d|\s[Øø]/)[0].replace(/\s+/g, " ").trim();
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
    return fail("SEARCH_UNAVAILABLE", { note: SEARCH_UNAVAILABLE_NOTE });
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
  // A removed source is recorded like get_product's, so a card Claude gives it is dropped in code, not repaired (r8 R01).
  if (checkedSource?.gone) ctx.gone.add(checkedSource.product.stock_id);
  const sourceFact = checkedSource && !checkedSource.gone ? { source: remember(ctx, withDetails(checkedSource, details)) } : {};
  const available = checked
    .filter((item) => item.verified && item.product.stock_status === "in_stock" && (item.product.available_quantity ?? 0) >= minQty)
    .slice(0, 3);
  const unchecked = checked.length > 0 && !checked.some((item) => item.verified);
  // A look that could check stock backs "no close substitute" (exam 4, s03-B idx 1: repaired as unbacked after this had run).
  if (!unchecked) ctx.searches.push({ queries: [], category: null, categoryFound: false, maxPrice: null, complete: false, alternativesFor: input.stock_id });
  if (!available.length) {
    return ok({ ...sourceFact, products: [], note: unchecked ? ALTERNATIVES_UNCHECKED : NO_CLOSE_ALTERNATIVE });
  }
  return ok({ ...sourceFact, products: available.map((item) => remember(ctx, withDetails(item, details))) });
}

const NO_PHOTO_MATCH = { kind: "none", products: [], note: "No catalogue photo match. Describe what you see and search by product type." };

async function matchPhotoTool(ctx: TurnContext) {
  if (!ctx.image) return fail("NO_PHOTO");
  const result = await ctx.deps.lookupImage(ctx.image);
  if (!result) return ok(NO_PHOTO_MATCH);
  const matches = result.products.slice(0, 5);
  // The pick check reads "2 of this" against the photo's matches (the eval's chat view showed the photo too).
  for (const item of matches) ctx.photoMatches.set(item.stock_id, result.kind === "direct" ? "direct" : "look-alike");
  const [checked, details] = await Promise.all([
    Promise.all(matches.map((item) => liveCheck(item, ctx.deps))),
    lookupDetails(ctx, matches.map((item) => item.stock_id)),
  ]);
  const live = checked.filter((item) => !item.gone);
  if (!live.length) return ok(NO_PHOTO_MATCH);
  return ok({ kind: result.kind, exact_product: result.kind === "direct", products: live.map((item) => remember(ctx, withDetails(item, details))) });
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

/**
 * The enquiry totals Claude sees: with code's estimate with GST only after a GST question, and never while a line is unchecked
 * (these totals leave it out, so the estimate would be for part of the enquiry).
 */
export const totalsForClaude = (ctx: TurnContext) => (ctx.gstAsked && !ctx.uncheckedCodes.length ? totalsWithGst(ctx.lines) : enquiryTotals(ctx.lines));

function enquiryState(ctx: TurnContext) {
  return { lines: ctx.lines, totals: totalsForClaude(ctx), unchecked: uncheckedNote(ctx.uncheckedCodes) };
}

const REFUSED_LOOKUP_MS = 2_000; // like an earlier card's check: the question about it shouldn't wait longer

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
    if (checked.gone) {
      ctx.gone.add(checked.product.stock_id);
      return null;
    }
    return remember(ctx, withDetails(checked, details));
  })(), REFUSED_LOOKUP_MS, null);
}

type EnquiryInput = z.infer<typeof enquiryInput>;

/** An update_enquiry call's code as Claude sent it, trimmed and lower-cased; "" when there is none. */
export const updateCode = (input: { stock_id?: unknown }) => (typeof input.stock_id === "string" ? input.stock_id.trim().toLowerCase() : "");
/** An update_enquiry call as the loop's stop rules compare them: its code, action and Claude's number. */
export const refusalKey = (input: { action?: unknown; stock_id?: unknown; quantity?: unknown }) =>
  `${updateCode(input)}|${String(input.action)}|${typeof input.quantity === "number" ? input.quantity : 0}`;

/** A tap this turn is the pick; with two or more typed numbers the check still binds the number to it. */
const tapPicks = (code: string, ctx: TurnContext) => ctx.tapped !== null && same(ctx.tapped, code) && typedQuantities(ctx.customerTexts).length <= 1;

/**
 * What the pick check is asked about, or null when there is nothing to check: a tap this turn picks its card, a code the
 * catalogue doesn't have (or a removal of a line that isn't on the enquiry) fails as NOT_FOUND, and clear has its own rule.
 * Claude's number goes in only when the code rule says the customer typed it. There is no pass for a typed code or a line
 * already on the enquiry: "the other outlet might need 6 more" (r3 c11-persona idx 9) was a question.
 */
export async function pickProposal(input: EnquiryInput, ctx: TurnContext): Promise<PickProposal | null> {
  const code = input.stock_id?.trim();
  if (!code || input.action === "clear") return null;
  const seen = [...ctx.seen.values()].find(({ product }) => same(product.stock_id, code))?.product;
  if (input.action === "remove") {
    const line = ctx.lines.find((item) => same(item.code, code));
    if (!line && !ctx.uncheckedCodes.some((item) => same(item, code))) return null;
    return {
      code: line?.code ?? seen?.stock_id ?? code, name: line?.item ?? seen?.name ?? code, price: line?.pricePerItem ?? seen?.list_price ?? null,
      uom: line?.uom ?? seen?.uom_id.trim() ?? "", action: "remove", quantity: null, requested: null, unit: "uom",
    };
  }
  // A line that couldn't be re-checked can't be changed (STOCK_UNVERIFIED), so the round's early start makes no call for it.
  if (tapPicks(code, ctx) || ctx.uncheckedCodes.some((item) => same(item, code))) return null;
  // A lookup that fails is still checked, by the code alone: a flaky catalogue must not skip the check.
  const found = await ctx.deps.findByCode(code).catch(() => undefined);
  if (found === null) return null;
  const product = seen ?? found;
  const quantity = input.quantity ?? null;
  const unit = input.unit ?? "uom";
  const typed = quantity !== null && quantityStated(quantity, ctx.customerTexts) && unitStated(quantity, unit, ctx.customerTexts);
  return {
    code: product?.stock_id ?? code, name: product?.name ?? code, price: product?.list_price ?? null, uom: product?.uom_id.trim() ?? "",
    action: input.action, quantity: typed ? quantity : null, requested: quantity, unit,
  };
}

/** Starts the check for an update_enquiry call without waiting for it, so a round's checks run side by side (the cache shares them). */
export async function startPickCheck(input: unknown, ctx: TurnContext) {
  const parsed = enquiryInput.safeParse(input);
  const p = parsed.success ? await pickProposal(parsed.data, ctx) : null;
  if (p) void ctx.checkPick(p);
}

// The refusals whose product the reply may ask about with its card.
const NOT_PICKED_ERRORS = new Set(["NOT_PICKED", "PICK_UNCLEAR", "PICK_UNCONFIRMED", "PICK_UNCHECKED", "PICKED_OTHER"]);
// By the refused action: "add it" after a refused set made another line of 1 into 4 while the reply said 3 (r3 c09-persona idx 9).
const PICKED_OTHER_NOTE = {
  add: "The customer picked this other product instead: add it with picked.quantity if that is set; otherwise ask how many.",
  set: "The customer picked this other product instead: set it to picked.quantity if that is set; otherwise ask how many.",
};
const QTY_NOT_FOR_ITEM_NOTE = "The customer typed typed_quantity for this item: use that number.";
const NOT_PICKED_NOTE = "The customer hasn't asked for this product. Don't add it or ask them to confirm it; answer what they said. Never say it was added; if they clearly asked for it, say in a few words it isn't on the enquiry yet.";
const PICK_UNCLEAR_NOTE = "Two or more products fit their words: attach these cards and ask which one, naming them (X or Y?).";
const PICK_ASK_NOTE = "Ask one short question naming this product with its code (Is it the <name> <code>?), with its card. Don't call update_enquiry for it again this turn.";
const REMOVE_REFUSED_NOTE = "The customer hasn't clearly asked to take this line off, so it stays on the enquiry. Don't remove it; answer what they said, and don't tell them they never asked.";
// A check that timed out (or had no time left) says nothing about what the customer asked.
const REMOVE_UNCHECKED_NOTE = "The removal couldn't be confirmed just now, so the line stays on the enquiry: say it's still on, and that they can ask again to take it off.";

/**
 * update_enquiry's pick check (owner decision 1: it replaces the word rule): null when the change may go ahead, else the refusal
 * for Claude. A check that fails or runs out of time refuses (PICK_UNCHECKED, or REMOVE_REFUSED for a removal), so nothing is added
 * or removed unchecked.
 */
async function pickRefusal(input: EnquiryInput, ctx: TurnContext): Promise<ToolOutcome | null> {
  const p = await pickProposal(input, ctx);
  if (!p) {
    if ((input.action === "add" || input.action === "set") && input.stock_id && tapPicks(input.stock_id, ctx)) ctx.pickFast += 1;
    return null;
  }
  const verdict = await ctx.checkPick(p);
  // In the proposed item's own unit: a 48 for "4 dozen" of an item sold by the dozen isn't the number typed for it. Another
  // product's unit isn't known here, so its number is read both ways.
  const mode = verdict.verdict === "different" ? "both" : soldByDozen(p.uom) ? "dozens" : "pieces";
  const outcome = decidePick(verdict, p, (quantity) => quantityStated(quantity, ctx.customerTexts, mode));
  if (outcome.ok) return null;
  ctx.refusedKeys.add(refusalKey(input));
  if (outcome.error === "REMOVE_REFUSED" || outcome.error === "QTY_NOT_STATED") ctx.finalRefusal = true;
  if (NOT_PICKED_ERRORS.has(outcome.error)) {
    for (const code of [p.code, ...(outcome.candidates ?? [])]) if (!ctx.refused.some((item) => same(item, code))) ctx.refused.push(code);
  }
  switch (outcome.error) {
    case "PICKED_OTHER": return fail(outcome.error, { picked: outcome.other, product: await refusedProduct(outcome.other!.code, ctx), note: PICKED_OTHER_NOTE[input.action === "set" ? "set" : "add"] });
    case "QTY_NOT_FOR_ITEM": return fail(outcome.error, { typed_quantity: outcome.typedQuantity, note: QTY_NOT_FOR_ITEM_NOTE });
    case "QTY_NOT_STATED": return fail(outcome.error, { notice: QTY_NOTICE });
    case "NOT_PICKED": return fail(outcome.error, { note: NOT_PICKED_NOTE });
    case "PICK_UNCLEAR": {
      const candidates = await Promise.all((outcome.candidates ?? []).map((code) => refusedProduct(code, ctx)));
      return fail(outcome.error, { candidates: candidates.filter((item) => item !== null), note: PICK_UNCLEAR_NOTE });
    }
    case "REMOVE_REFUSED": return fail(outcome.error, { note: verdict.verdict === "error" ? REMOVE_UNCHECKED_NOTE : REMOVE_REFUSED_NOTE, ...(outcome.other ? { meant: outcome.other.code } : {}) });
    default: return fail(outcome.error, { product: await refusedProduct(p.code, ctx), note: PICK_ASK_NOTE }); // PICK_UNCONFIRMED, PICK_UNCHECKED
  }
}

// A swap ("change to the 16.5 one", "instead", "replace", 换) takes the old line off only once the new item is on: r4 c09-persona
// idx 11 lost the old line while the new one was refused. An explicit "remove / take out / cancel" still goes through (owner question 7).
// A failed add or set of another item this turn holds a removal whatever the words: a chip "Switch to the 16.5cm" or a "yes" to
// "Want to switch?" has no swap words, and a swap can come with an add of something else that went through.
const swapRequest = /\b(?:change|switch|swap)\b(?:[^.!?]|(?<=\d)\.(?=\d))*\bto\b|\binstead\b|\breplace\b|换/i;
const explicitRemove = /\b(?:remove|delete|cancel|drop|take\s+(?:out|off|away)|forget|skip|exclude|scratch|get\s+rid)\b|不要|取消|删|去掉|拿掉|不用/i;
const SWAP_NOTE = "Nothing was removed: the old line comes off only once the new item is on the enquiry. Add the new item first (the same response is fine), then remove the old one. If the new item can't be added, say the old one is still on the enquiry and what you still need.";

async function enquiryTool(input: EnquiryInput, ctx: TurnContext) {
  const outcome = await changeEnquiry(input, ctx);
  if ((input.action === "add" || input.action === "set") && input.stock_id) {
    const code = input.stock_id;
    ctx.failedAdds = ctx.failedAdds.filter((item) => !same(item, code));
    // ALREADY_ON_ENQUIRY is no failure here: the item is on.
    if (outcome.isError && outcome.error !== "ALREADY_ON_ENQUIRY") ctx.failedAdds.push(code);
  }
  return outcome;
}

async function changeEnquiry(input: EnquiryInput, ctx: TurnContext) {
  const code = input.stock_id?.toLowerCase();
  if (input.action === "remove" && input.stock_id) {
    const text = ctx.currentText ?? "";
    const onEnquiry = [...ctx.lines.map((line) => line.code), ...ctx.uncheckedCodes].some((item) => same(item, input.stock_id!));
    const newItemOn = ctx.changes.some((change) => (change.action === "add" || change.action === "set") && change.code !== null && change.code.toLowerCase() !== code);
    const failedOther = ctx.failedAdds.some((item) => !same(item, input.stock_id!));
    if (onEnquiry && !explicitRemove.test(text) && (failedOther || (swapRequest.test(text) && !newItemOn))) {
      ctx.kept.push(input.stock_id);
      ctx.refusedKeys.add(refusalKey(input));
      return fail("SWAP_NOT_DONE", { note: SWAP_NOTE });
    }
    // Before the unchecked-line branch, so a line the browser keeps is only removed when the customer asked.
    const refusal = await pickRefusal(input, ctx);
    if (refusal) {
      ctx.kept.push(input.stock_id);
      return refusal;
    }
  }
  // A line that could not be re-checked stays as the browser has it: it can be removed or cleared, not changed.
  if (input.action !== "clear" && ctx.uncheckedCodes.some((item) => item.toLowerCase() === code)) {
    // exam 3, c08-stress T12: a bare STOCK_UNVERIFIED led to retries, then a claim the line was removed.
    if (input.action !== "remove") return fail("STOCK_UNVERIFIED", { note: "This line is still on the customer's enquiry but couldn't be re-checked just now; don't change it this turn." });
    if (ctx.closed) return fail("NOT_FINISHED");
    ctx.uncheckedCodes = ctx.uncheckedCodes.filter((item) => item.toLowerCase() !== code);
    ctx.changes.push({ action: "remove", code: input.stock_id ?? null });
    return ok(enquiryState(ctx));
  }
  if ((input.action === "add" || input.action === "set") && input.stock_id) {
    // A refused remove, then an add of the same code, made a line of 4 into 10.
    if (input.action === "add" && ctx.kept.some((item) => same(item, input.stock_id!)) && ctx.lines.some((line) => same(line.code, input.stock_id!))) {
      return fail("ALREADY_ON_ENQUIRY", { notice: "This line is still on the enquiry: use set with the new total." });
    }
    const refusal = await pickRefusal(input, ctx);
    if (refusal) return refusal;
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
  if (ctx.closed) return fail("NOT_FINISHED");
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
