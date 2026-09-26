// src/lib/agent/tools.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { applyEnquiryAction, enquiryTotals } from "./enquiry";
import { liveCheck, productFact, storeProductUrl, type CheckedProduct, type FactDeps } from "./facts";

/** Mutable state for one customer turn. */
export type TurnContext = {
  deps: FactDeps;
  seen: Map<string, CheckedProduct>;
  lines: EnquiryReceiptLine[];
  customerTexts: string[];
  image: ImageAttachment | null;
  shownIds: ReadonlySet<string>;
};

export const agentTools: Anthropic.Tool[] = [
  {
    name: "search_catalogue",
    description: "Search Sia Huat's catalogue. Pass 1-3 short queries in the customer's own words (e.g. 'blow torch', 'kitchen torch'); never rename their item into a category label. Returns up to 10 products; price and stock of the first 6 are checked live on the store (price_and_stock_verified_live).",
    input_schema: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "1-3 short search phrases" },
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
  queries: z.array(z.string().trim().min(2).max(80)).min(1).max(3),
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

export type ToolOutcome = { content: string; isError: boolean };
const ok = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const fail = (error: string, detail: Record<string, unknown> = {}): ToolOutcome => ({ content: JSON.stringify({ error, ...detail }), isError: true });

function remember(ctx: TurnContext, checked: CheckedProduct) {
  ctx.seen.set(checked.product.stock_id, checked);
  return productFact(checked, ctx.shownIds.has(checked.product.stock_id));
}

async function searchCatalogueTool(input: z.infer<typeof searchInput>, ctx: TurnContext) {
  let results: Product[][];
  try {
    results = await Promise.all(input.queries.map((query) => ctx.deps.searchDirect(query, 10)));
  } catch {
    return fail("SEARCH_UNAVAILABLE");
  }
  const excluded = new Set((input.exclude_ids ?? []).map((id) => id.toLowerCase()));
  const merged: Product[] = [];
  const ids = new Set<string>();
  for (let rank = 0; rank < 10; rank += 1) {
    for (const list of results) {
      const item = list[rank];
      if (!item || ids.has(item.stock_id) || excluded.has(item.stock_id.toLowerCase())) continue;
      if (input.max_price && item.list_price > input.max_price) continue;
      ids.add(item.stock_id);
      merged.push(item);
    }
  }
  const top = merged.slice(0, 10);
  const checked = await Promise.all(top.map((item, index) => (index < 6
    ? liveCheck(item, ctx.deps)
    : Promise.resolve<CheckedProduct>({ product: { ...item, stock_status: "unknown" }, verified: false }))));
  const affordable = checked.filter((item) => !input.max_price || item.product.list_price <= input.max_price);
  return ok({
    products: affordable.map((item) => remember(ctx, item)),
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
    candidates = await ctx.deps.findAlternatives(input.stock_id, minQty, new Set([...ctx.shownIds, input.stock_id]));
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

async function enquiryTool(input: z.infer<typeof enquiryInput>, ctx: TurnContext) {
  const result = await applyEnquiryAction(ctx.lines, {
    action: input.action,
    stock_id: input.stock_id ?? undefined,
    quantity: input.quantity ?? undefined,
    unit: input.unit ?? undefined,
  }, ctx.customerTexts, ctx.deps);
  if (result.product) remember(ctx, result.product);
  if (!result.ok) return fail(result.error, { available: result.available ?? undefined, notice: result.notice || undefined });
  ctx.lines = result.lines;
  return ok({ lines: result.lines, totals: enquiryTotals(result.lines), notice: result.notice || undefined });
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
