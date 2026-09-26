// src/lib/agent/enquiry.ts
import "server-only";
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
  | "QTY_NOT_STATED" | "UNIT_MISMATCH" | "OUT_OF_STOCK" | "OVER_STOCK" | "STOCK_UNVERIFIED"
  | "PACK_SIZE_UNKNOWN" | "INVALID_QTY" | "NOT_FOUND" | "MISSING_FIELDS" | "CLEAR_NOT_REQUESTED";
export type EnquiryResult =
  | { ok: true; lines: EnquiryReceiptLine[]; notice: string; product?: CheckedProduct }
  | { ok: false; error: EnquiryError; available?: number | null; notice?: string; product?: CheckedProduct };

export function enquiryTotals(lines: EnquiryReceiptLine[]) {
  const totals = enquiryReceiptTotals(lines);
  return { ...totals, grandTotal: Math.round(totals.grandTotal * 100) / 100 };
}

const numberWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
// A number right after one of these is a label, not a quantity ("option 2", "size 2", "#2", "第2个", "选项2", "型号2").
const labelBefore = String.raw`(?<!(?:\b(?:option|opt|choice|item|no\.?|number|size|model|type|tier|level|layer|deck|burner|door|outlet|branch|table|page|step)|#|第|选项|型号)\s*)`;
// A number right before one of these is a size, a count of parts, a pack size or an ordinal ("3-tier", "4 outlets", "48pcs/ctn", "2nd", "2号", "2款").
const notQuantityAfter = String.raw`(?![-\s]*(?:tiers?|levels?|layers?|decks?|burners?|doors?|outlets?|branch(?:es)?|shops?|stores?|pax|people|persons?|slots?|steps?|qt|quarts?|l|litres?|liters?|ml|oz|cm|mm|m|inch(?:es)?|kg|g|gm|w|watts?|v|volts?|st|nd|rd|th)\b|[-\s]*%|\s*pcs?\s*(?:\/|per\b)|\s*[号款])`;

const chineseDigits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** How 1-99 is written in Chinese: 2 → 二/两, 12 → 十二, 20 → 二十, 25 → 二十五. */
function chineseNumerals(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return [];
  if (quantity === 2) return ["二", "两"];
  const tens = Math.floor(quantity / 10);
  if (tens === 0) return [chineseDigits[quantity]];
  return [`${tens === 1 ? "" : chineseDigits[tens]}十${chineseDigits[quantity % 10]}`];
}

/**
 * True when one of the customer's recent typed messages contains this number
 * as a quantity-like token. Numbers inside codes, sizes ("H5cm", "12 QT", "24 cm"),
 * prices ("$23", "S$ 23"), option/model numbers, tiers, burners and outlet counts do not count.
 * Chinese numerals count only before a measure word (两个, 五箱) or at the end of the text,
 * and never as an ordinal or an option/model number (第二个, 选项二, 型号二).
 * Known gap: the pronoun "one" ("the blue one") still counts as quantity 1.
 */
export function quantityStated(quantity: number, customerTexts: string[]) {
  const digits = new RegExp(`(?<![\\w.])(?:x\\s*)?(?<!\\$\\s*)${labelBefore}${quantity}${notQuantityAfter}(?:\\s*(?:x|pcs?|pieces?|units?|sets?|nos?|ctns?|cartons?|pkts?|packets?|packs?|boxe?s?))?(?![\\w.])`, "i");
  const word = numberWords[quantity];
  const chinese = chineseNumerals(quantity);
  const chineseQuantity = chinese.length
    ? new RegExp(`(?<![一二两三四五六七八九十百千万零第]|选项|型号)(?:${chinese.join("|")})(?=[个件只把套箱包盒台支张条打瓶罐双]|\\s*$)`)
    : null;
  return customerTexts.some((text) => digits.test(text)
    || (word !== undefined && new RegExp(`\\b${word}\\b`, "i").test(text))
    || (chineseQuantity !== null && chineseQuantity.test(text)));
}

const packWords = { carton: String.raw`(?:ctns?|cartons?)\b|箱`, packet: String.raw`(?:pkts?|packets?|packs?)\b|包` };

/** This number written as digits ("2", "x2"), as a word ("two") or in Chinese ("二", "两"), followed by a carton or packet word. */
function packedNumber(quantity: number, unit: keyof typeof packWords, flags: string) {
  const forms = [String.raw`(?<![\w.])(?:x\s*)?${quantity}`];
  if (numberWords[quantity]) forms.push(String.raw`\b${numberWords[quantity]}`);
  const chinese = chineseNumerals(quantity);
  if (chinese.length) forms.push(`(?<![一二两三四五六七八九十百千万零第]|选项|型号)(?:${chinese.join("|")})`);
  return new RegExp(`(?:${forms.join("|")})\\s*(?:${packWords[unit]})`, flags);
}

/**
 * True when the customer typed this quantity in this unit: cartons and packets need the number followed by a
 * carton or packet word; the product's own unit needs at least one mention of the number that isn't followed by one.
 */
export function unitStated(quantity: number, unit: "uom" | "carton" | "packet", customerTexts: string[]) {
  if (unit !== "uom") return customerTexts.some((text) => packedNumber(quantity, unit, "i").test(text));
  const loose = customerTexts.map((text) => text.replace(packedNumber(quantity, "carton", "gi"), " ").replace(packedNumber(quantity, "packet", "gi"), " "));
  return quantityStated(quantity, loose);
}

const clearRequest = /\b(?:clear|start over|reset|remove all|delete all|cancel all|cancel everything)\b|清空|全部取消|重新开始/i;

export async function applyEnquiryAction(
  lines: EnquiryReceiptLine[],
  action: EnquiryAction,
  customerTexts: string[],
  deps: FactDeps,
): Promise<EnquiryResult> {
  if (action.action === "clear") {
    // The whole enquiry is only wiped when the customer asked for it (typed, or a chip they tapped).
    if (!customerTexts.some((text) => clearRequest.test(text))) return { ok: false, error: "CLEAR_NOT_REQUESTED" };
    return { ok: true, lines: [], notice: "" };
  }
  if (!action.stock_id) return { ok: false, error: "MISSING_FIELDS" };
  const code = action.stock_id.trim();
  if (action.action === "remove") {
    const kept = lines.filter((line) => line.code.toLowerCase() !== code.toLowerCase());
    if (kept.length === lines.length) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, lines: kept, notice: "" };
  }
  if (!action.quantity) return { ok: false, error: "MISSING_FIELDS" };
  if (!quantityStated(action.quantity, customerTexts)) return { ok: false, error: "QTY_NOT_STATED" };
  if (!unitStated(action.quantity, action.unit ?? "uom", customerTexts)) return { ok: false, error: "UNIT_MISMATCH" };
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
 * Each line's catalogue lookup and live check are bounded by timeoutMs. A line whose
 * lookup or live check fails or times out is never removed: its code is returned in
 * `unchecked` and the browser keeps its own copy of that line.
 */
export async function verifyEnquiry(echo: EnquiryEcho[], deps: FactDeps, timeoutMs = LIVE_CHECK_TIMEOUT_MS) {
  const notes: string[] = [];
  const unchecked: string[] = [];
  const products = new Map<string, CheckedProduct>();
  const checkedLines = await Promise.all(combinedEcho(echo).map(async ({ stockId, quantity }) => {
    const catalogueProduct = await withTimeout(deps.findByCode(stockId).catch(() => "unchecked" as const), timeoutMs, "unchecked" as const);
    if (catalogueProduct === "unchecked") {
      notes.push(`${stockId} could not be checked just now; it stays on the enquiry as the customer had it, but is left out of the current lines and totals.`);
      unchecked.push(stockId);
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
      notes.push(`${label} could not be re-checked live just now; it stays on the enquiry as the customer had it, but is left out of the current lines and totals.`);
      unchecked.push(stockId);
      return null;
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
  return { lines: checkedLines.filter((line): line is EnquiryReceiptLine => line !== null), notes, products, unchecked };
}
