// src/lib/agent/enquiry.ts
import "server-only";
import type { Product } from "@/lib/chat-contract";
import { enquiryReceiptTotals, type EnquiryReceiptLine } from "@/lib/conversation-export";
import { checkedEnquiryLine, mergedEnquiryQuantity } from "@/lib/enquiry-order";
import { resolveProductQuantity } from "@/lib/enquiry-quantity";
import { LIVE_CHECK_TIMEOUT_MS, liveCheck, withTimeout, type CheckedProduct, type FactDeps } from "./facts";

export type EnquiryEcho = { stockId: string; quantity: number };
export type EnquiryAction = {
  action: "add" | "set" | "remove" | "clear";
  stock_id?: string;
  quantity?: number;
  unit?: "uom" | "carton" | "packet";
};
export type EnquiryError =
  | "QTY_NOT_STATED" | "OUT_OF_STOCK" | "OVER_STOCK" | "STOCK_UNVERIFIED"
  | "PACK_SIZE_UNKNOWN" | "INVALID_QTY" | "NOT_FOUND" | "MISSING_FIELDS";
export type EnquiryResult =
  | { ok: true; lines: EnquiryReceiptLine[]; notice: string; product?: CheckedProduct }
  | { ok: false; error: EnquiryError; available?: number | null; notice?: string; product?: CheckedProduct };

export function enquiryTotals(lines: EnquiryReceiptLine[]) {
  const totals = enquiryReceiptTotals(lines);
  return { ...totals, grandTotal: Math.round(totals.grandTotal * 100) / 100 };
}

const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/**
 * True when one of the customer's recent typed messages contains this number
 * as a quantity-like token. Numbers inside codes, sizes ("H5cm", "12 QT", "24 cm")
 * and prices ("$23", "S$ 23") do not count.
 * Known gap: the pronoun "one" ("the blue one") still counts as quantity 1.
 */
export function quantityStated(quantity: number, customerTexts: string[]) {
  const digits = new RegExp(`(?<![\\w.])(?:x\\s*)?(?<!\\$\\s*)${quantity}(?!\\s*(?:cm|mm|m|l|litres?|ml|qt|inch(?:es)?|kg|g|gm|oz)\\b|\\s*%)(?:\\s*(?:x|pcs?|pieces?|units?|sets?|nos?|ctns?|cartons?|pkts?|packets?|packs?|boxe?s?))?(?![\\w.])`, "i");
  const word = numberWords[quantity];
  return customerTexts.some((text) => digits.test(text) || (word !== undefined && new RegExp(`\\b${word}\\b`, "i").test(text)));
}

export async function applyEnquiryAction(
  lines: EnquiryReceiptLine[],
  action: EnquiryAction,
  customerTexts: string[],
  deps: FactDeps,
): Promise<EnquiryResult> {
  if (action.action === "clear") return { ok: true, lines: [], notice: "" };
  if (!action.stock_id) return { ok: false, error: "MISSING_FIELDS" };
  const code = action.stock_id.trim();
  if (action.action === "remove") {
    const kept = lines.filter((line) => line.code.toLowerCase() !== code.toLowerCase());
    if (kept.length === lines.length) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, lines: kept, notice: "" };
  }
  if (!action.quantity) return { ok: false, error: "MISSING_FIELDS" };
  if (!quantityStated(action.quantity, customerTexts)) return { ok: false, error: "QTY_NOT_STATED" };
  const catalogueProduct = await deps.findByCode(code).catch(() => null);
  if (!catalogueProduct) return { ok: false, error: "NOT_FOUND" };
  const checked = await liveCheck(catalogueProduct, deps);
  if (!checked.verified) return { ok: false, error: "STOCK_UNVERIFIED", product: checked };
  const unit = action.unit === "carton" || action.unit === "packet" ? action.unit : null;
  const resolved = resolveProductQuantity(action.quantity, unit, checked.product);
  if (resolved.quantity === null) return { ok: false, error: "PACK_SIZE_UNKNOWN", notice: resolved.notice, product: checked };
  const { product } = checked;
  if (product.stock_status === "out_of_stock" || product.available_quantity === 0) return { ok: false, error: "OUT_OF_STOCK", product: checked };
  const available = product.available_quantity;
  if (typeof available !== "number") return { ok: false, error: "STOCK_UNVERIFIED", product: checked };
  const total = mergedEnquiryQuantity(lines, product.stock_id, resolved.quantity, action.action === "add");
  if (total > available) return { ok: false, error: "OVER_STOCK", available, product: checked };
  const line = checkedEnquiryLine(total, product);
  if (!line) return { ok: false, error: "INVALID_QTY", product: checked };
  const existing = lines.find((item) => item.code.toLowerCase() === product.stock_id.toLowerCase());
  const next = existing ? lines.map((item) => (item === existing ? line : item)) : [...lines, line];
  return { ok: true, lines: next, notice: resolved.notice, product: checked };
}

function lineFromSnapshot(quantity: number, product: Product): EnquiryReceiptLine {
  return {
    item: product.name, code: product.stock_id, pricePerItem: product.list_price, quantity,
    total: Math.round(product.list_price * 100) * quantity / 100, uom: product.uom_id, sourceUrl: product.source_url,
  };
}

/** The echo comes from the browser: duplicate codes (any case) are added together into one line. */
function combinedEcho(echo: EnquiryEcho[]) {
  const combined = new Map<string, EnquiryEcho>();
  for (const { stockId, quantity } of echo) {
    const key = stockId.toLowerCase();
    const existing = combined.get(key);
    combined.set(key, existing ? { stockId: existing.stockId, quantity: existing.quantity + quantity } : { stockId, quantity });
  }
  return [...combined.values()];
}

/**
 * Re-checks the customer's echoed enquiry against the catalogue and the live store.
 * Each line's catalogue lookup and live check are bounded by timeoutMs.
 */
export async function verifyEnquiry(echo: EnquiryEcho[], deps: FactDeps, timeoutMs = LIVE_CHECK_TIMEOUT_MS) {
  const notes: string[] = [];
  const products = new Map<string, CheckedProduct>();
  const checkedLines = await Promise.all(combinedEcho(echo).map(async ({ stockId, quantity }) => {
    const catalogueProduct = await withTimeout(deps.findByCode(stockId).catch(() => null), timeoutMs, "timeout" as const);
    if (catalogueProduct === "timeout") {
      notes.push(`${stockId} could not be checked just now and was taken off the enquiry; it can be added again.`);
      return null;
    }
    if (!catalogueProduct) {
      notes.push(`${stockId} is no longer in the catalogue and was removed.`);
      return null;
    }
    const result = await liveCheck(catalogueProduct, deps, timeoutMs);
    products.set(result.product.stock_id, result);
    const label = `${result.product.name} (${result.product.stock_id})`;
    if (!result.verified) {
      notes.push(`${label} could not be re-checked live just now; its last known price is kept.`);
      return lineFromSnapshot(quantity, catalogueProduct);
    }
    const line = checkedEnquiryLine(quantity, result.product);
    if (line) return line;
    const available = result.product.available_quantity;
    if (result.product.stock_status === "out_of_stock" || available === 0) {
      notes.push(`${label} is now out of stock and was removed.`);
      return null;
    }
    if (typeof available === "number" && available < quantity) {
      notes.push(`Only ${available} ${result.product.uom_id} of ${label} are available now; the line was reduced from ${quantity}.`);
      return checkedEnquiryLine(available, result.product);
    }
    notes.push(`${label} could not be kept on the enquiry.`);
    return null;
  }));
  return { lines: checkedLines.filter((line): line is EnquiryReceiptLine => line !== null), notes, products };
}
