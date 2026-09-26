// src/lib/agent/tools.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { applyEnquiryAction, enquiryTotals } from "./enquiry";
import { liveCheck, productFact, retryOnce, storeProductUrl, type CheckedProduct, type FactDeps } from "./facts";

/** A product card as noted in the chat history: "[cards shown: CODE name; …]". */
export type ShownCard = { code: string; name: string };

/** Mutable state for one customer turn. */
export type TurnContext = {
  deps: FactDeps;
  seen: Map<string, CheckedProduct>;
  lines: EnquiryReceiptLine[];
  /** Enquiry codes that could not be re-checked this turn: the browser keeps its own copy of those lines. */
  uncheckedCodes: string[];
  /** The customer's recent typed texts: the only place a quantity can come from. */
  customerTexts: string[];
  /** Texts that may ask to clear the enquiry: the typed texts plus a chip tapped this turn. */
  clearTexts: string[];
  image: ImageAttachment | null;
  shownIds: ReadonlySet<string>;
  /** The product card the customer tapped this turn, if any. */
  tappedId: string | null;
  /** The product cards in Claire's previous reply. */
  previousCards: ShownCard[];
};

export const agentTools: Anthropic.Tool[] = [
  {
    name: "search_catalogue",
    description: "Search Sia Huat's catalogue. Pass 1-3 short queries in the customer's own words (e.g. 'blow torch', 'kitchen torch'); never rename their item into a category label. Returns up to 10 products; price and stock of the first 6 are checked live on the store (price_and_stock_verified_live). total_found counts the matches; more_available true means there are more matches than the list shows.",
    input_schema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "1-3 short search phrases" },
        category: { type: "string", description: "Optional catalogue category for the product type, e.g. 'kitchen tongs', 'GN pan trolleys', 'hand mixers'. Its products are added after the query results." },
        max_price: { type: "number", description: "Optional budget ceiling per unit, SGD ex GST" },
        exclude_ids: { type: "array", items: { type: "string" }, description: "Item codes the customer rejected" },
      },
      required: ["queries"],
    },
  },
  {
    name: "get_product",
    description: "Look up one product by its item code, or by a store.siahuat.com/product/<id> link the customer pasted. Price and stock are checked live.",
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
    description: "Find up to 3 similar products that are in stock right now (live-checked), for an item that is out of stock or short.",
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
    description: "Add, set, remove or clear lines on the customer's enquiry. 'add' increases an existing line; 'set' replaces its quantity. quantity must be a number the customer typed for this item. unit 'carton' or 'packet' converts using the product's own pack size.",
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
  queries: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
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
const CATEGORY_ROWS = 20;

export type ToolOutcome = { content: string; isError: boolean };
const ok = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const fail = (error: string, detail: Record<string, unknown> = {}): ToolOutcome => ({ content: JSON.stringify({ error, ...detail }), isError: true });

function remember(ctx: TurnContext, checked: CheckedProduct) {
  ctx.seen.set(checked.product.stock_id, checked);
  return productFact(checked, ctx.shownIds.has(checked.product.stock_id));
}

async function searchCatalogueTool(input: z.infer<typeof searchInput>, ctx: TurnContext) {
  const category = input.category;
  // One slow or failed search must not sink the others: each is retried once and the ones that succeed are used.
  const settled = await Promise.allSettled([
    ...input.queries.map((query) => retryOnce(() => ctx.deps.searchDirect(query, QUERY_ROWS))),
    ...(category ? [retryOnce(() => ctx.deps.searchCategory(category, CATEGORY_ROWS))] : []),
  ]);
  if (settled.every((result) => result.status === "rejected")) return fail("SEARCH_UNAVAILABLE");
  const lists = settled.map((result) => (result.status === "fulfilled" ? result.value : []));
  const queryLists = lists.slice(0, input.queries.length);
  const categoryList = lists[input.queries.length] ?? [];
  const excluded = new Set((input.exclude_ids ?? []).map((id) => id.toLowerCase()));
  const merged: Product[] = [];
  const ids = new Set<string>();
  const add = (item: Product | undefined) => {
    if (!item || ids.has(item.stock_id) || excluded.has(item.stock_id.toLowerCase())) return;
    if (input.max_price && item.list_price > input.max_price) return;
    ids.add(item.stock_id);
    merged.push(item);
  };
  for (let rank = 0; rank < QUERY_ROWS; rank += 1) {
    for (const list of queryLists) add(list[rank]);
  }
  for (const item of categoryList) add(item);
  const top = merged.slice(0, 10);
  // A search that returned its full row limit may have more matches than it could return.
  const moreAvailable = queryLists.some((list) => list.length >= QUERY_ROWS) || categoryList.length >= CATEGORY_ROWS || merged.length > top.length;
  const checked = await Promise.all(top.map((item, index) => (index < 6
    ? liveCheck(item, ctx.deps)
    : Promise.resolve<CheckedProduct>({ product: { ...item, stock_status: "unknown", in_stock: null, available_quantity: null }, verified: false }))));
  const affordable = checked.filter((item) => !input.max_price || item.product.list_price <= input.max_price);
  return ok({
    products: affordable.map((item) => remember(ctx, item)),
    total_found: merged.length,
    more_available: moreAvailable,
    ...(affordable.length ? {} : { note: "No catalogue matches for these words. Try other words the customer might mean, or ask one question." }),
  });
}

async function getProductTool(input: z.infer<typeof productInput>, ctx: TurnContext) {
  const url = input.url ? storeProductUrl(input.url) : null;
  if (!url && !input.stock_id) return fail("MISSING_FIELDS");
  const found = url ? await ctx.deps.findBySourceUrl(url) : await ctx.deps.findByCode(input.stock_id!);
  if (!found) return fail("NOT_FOUND");
  return ok({ product: remember(ctx, await liveCheck(found, ctx.deps)) });
}

async function alternativesTool(input: z.infer<typeof alternativesInput>, ctx: TurnContext) {
  const minQty = input.min_qty ?? 1;
  let candidates: Product[];
  try {
    candidates = await retryOnce(() => ctx.deps.findAlternatives(input.stock_id, minQty, new Set([...ctx.shownIds, input.stock_id])));
  } catch {
    return fail("SEARCH_UNAVAILABLE");
  }
  const checked = await Promise.all(candidates.slice(0, 8).map((item) => liveCheck(item, ctx.deps)));
  const available = checked
    .filter((item) => item.verified && item.product.stock_status === "in_stock" && (item.product.available_quantity ?? 0) >= minQty)
    .slice(0, 3);
  return ok({ products: available.map((item) => remember(ctx, item)) });
}

async function matchPhotoTool(ctx: TurnContext) {
  if (!ctx.image) return fail("NO_PHOTO");
  const result = await ctx.deps.lookupImage(ctx.image);
  if (!result) return ok({ kind: "none", products: [], note: "No catalogue photo match. Describe what you see and search by product type." });
  const checked = await Promise.all(result.products.slice(0, 5).map((item) => liveCheck(item, ctx.deps)));
  return ok({ kind: result.kind, exact_product: result.kind === "direct", products: checked.map((item) => remember(ctx, item)) });
}

/**
 * While some lines could not be re-checked, the lines and totals Claude sees are not what the enquiry bar shows
 * (the browser adds those lines back), so Claude must not quote a total or an item count.
 */
export function uncheckedNote(codes: string[]) {
  return codes.length
    ? `Unchecked lines (kept by the customer, not in these lines or totals): ${codes.join(", ")}. Don't quote an enquiry total or item count; the enquiry bar shows the full enquiry.`
    : undefined;
}

function enquiryState(ctx: TurnContext) {
  return { lines: ctx.lines, totals: enquiryTotals(ctx.lines), unchecked: uncheckedNote(ctx.uncheckedCodes) };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when the customer picked this product: they tapped its card this turn, it is already on the enquiry,
 * they typed its item code, it was the only card in Claire's previous reply, or it was a card in that reply
 * and they typed a word of its name (4+ letters) that none of the other cards in that reply share.
 */
function customerChose(stockId: string, ctx: TurnContext) {
  const same = (code: string) => code.toLowerCase() === stockId.toLowerCase();
  if (ctx.tappedId && same(ctx.tappedId)) return true;
  if (ctx.lines.some((line) => same(line.code))) return true;
  const typedCode = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(stockId)}(?![\\p{L}\\p{N}])`, "iu");
  if (ctx.customerTexts.some((text) => typedCode.test(text))) return true;
  if (ctx.previousCards.length === 1 && same(ctx.previousCards[0].code)) return true;
  const name = ctx.previousCards.find((card) => same(card.code))?.name;
  if (!name) return false;
  const otherNames = ctx.previousCards.filter((card) => !same(card.code)).map((card) => card.name.toLowerCase());
  const words = name.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
  return words.some((word) => !otherNames.some((other) => other.includes(word))
    && ctx.customerTexts.some((text) => new RegExp(`(?<!\\p{L})${word}`, "iu").test(text)));
}

async function enquiryTool(input: z.infer<typeof enquiryInput>, ctx: TurnContext) {
  // A line that could not be re-checked stays as the browser has it: it can be removed or cleared, not changed.
  const code = input.stock_id?.toLowerCase();
  if (input.action !== "clear" && ctx.uncheckedCodes.some((item) => item.toLowerCase() === code)) {
    if (input.action !== "remove") return fail("STOCK_UNVERIFIED");
    ctx.uncheckedCodes = ctx.uncheckedCodes.filter((item) => item.toLowerCase() !== code);
    return ok(enquiryState(ctx));
  }
  if ((input.action === "add" || input.action === "set") && input.stock_id && !customerChose(input.stock_id, ctx)) {
    return fail("PRODUCT_NOT_CHOSEN");
  }
  const result = await applyEnquiryAction(ctx.lines, {
    action: input.action,
    stock_id: input.stock_id ?? undefined,
    quantity: input.quantity ?? undefined,
    unit: input.unit ?? undefined,
  }, input.action === "clear" ? ctx.clearTexts : ctx.customerTexts, ctx.deps);
  if (result.product) remember(ctx, result.product);
  if (!result.ok) return fail(result.error, { available: result.available ?? undefined, notice: result.notice || undefined });
  ctx.lines = result.lines;
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
    return fail("TOOL_FAILED");
  }
}
