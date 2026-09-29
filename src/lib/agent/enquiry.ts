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
  | "PACK_SIZE_UNKNOWN" | "INVALID_QTY" | "NOT_FOUND" | "MISSING_FIELDS" | "CLEAR_NOT_REQUESTED" | "ALREADY_ON_ENQUIRY";
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
const sizeOrPartWords = String.raw`tiers?|levels?|layers?|decks?|burners?|doors?|outlets?|branch(?:es)?|shops?|stores?|pax|ppl|people|persons?|slots?|steps?|qt|quarts?|l|litres?|liters?|ml|oz|cm|mm|m|inch(?:es)?|kg|g|gm|w|watts?|v|volts?|st|nd|rd|th|dollars?|bucks|sgd|cents?`;
// A number right before one of these is a size, a count of parts or people, a price, a pack size or an ordinal
// ("3-tier", "4 ppl", "5 dollar", "48pcs/ctn", "2nd", "2号"), or not a count at all ("20+", "1 more time", "3 times", "26 too long", 16", "4 or 6 slot").
const notQuantityAfter = String.raw`(?![-\s]*(?:${sizeOrPartWords})\b|[-\s]*%|\s*pcs?\s*(?:\/|per\b)|\s*[号款]|\+|(?:\s+more)?\s+times?\b|\s+too\b|\s*(?:"|″|”|'')(?!\w)|\s*(?:or|to)\s*\d+[-\s]*(?:${sizeOrPartWords})\b)`;
// "one" as a quantity: at the start (also after "ok"/"yes"), after a buying word, before a count word, or "one each / one of each";
// never "that one", "one of them", "one of those" opening the text, or "one more thing / one question / one sec".
const oneAsQuantity = /^\s*(?:(?:ok(?:ay)?|yes|ya|yah)\b[\s,.!]*(?:(?:la|lah|lor)\b[\s,.!]*)?)?one\b(?!\s+of\b(?!\s+each))(?!(?:\s+more)?\s+(?:thing|question|qn|q|sec|moment)s?\b)|\b(?:just|only|want|need|take|buy|add|order|get|give\s+me|gimme|also|and)\s+one\b(?!\s+of\s+(?:them|it)\b)(?!(?:\s+more)?\s+(?:thing|question|qn|q|sec|moment)s?\b)|\bone\s+(?:each|of\s+each)\b|\bone\s*(?:pcs?|pieces?|units?|sets?|boxe?s?|ctns?|cartons?|pkts?|packets?|packs?)\b/i;
// The chat box is a single-line input, so a pasted list arrives as "… 1) pot 2) lid": a label starts the text or follows a space.
const listLabel = /(?<=^|\s)(\d{1,2})[ \t]*[).][ \t]+(?=\S)/g;

/** The labels of a pasted list ("1) pot 2) lid"), counting up from 1; a quantity in between ("1) pot x 5. 2) lid") is skipped, not taken as a label. */
function listLabels(text: string) {
  const labels: RegExpExecArray[] = [];
  for (const match of text.matchAll(listLabel)) {
    if (Number(match[1]) === labels.length + 1) labels.push(match);
  }
  return labels;
}

/** Numbers that are never quantities: list labels ("1) pot 2) lid", counting up from 1), "the 2 again / the 2 of them", "3-in-1" / "3 in 1". */
function withoutNonQuantities(text: string) {
  const labels = listLabels(text);
  // A lone "ok 2." or "2. also 1 of the 6 slot" is a quantity, not a list.
  const unlabelled = labels.length >= 2
    ? labels.reduceRight((rest, match) => rest.slice(0, match.index) + rest.slice(match.index + match[0].length), text)
    : text;
  return unlabelled.replace(/\bthe\s+\d+\s+(?:again|of them|cards?|ones?)\b/gi, " ").replace(/\b\d+\s*-?\s*in\s*-?\s*1\b/gi, " ");
}

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
 * Numbers joined to a code or a fraction ("218455-20", "BTS-8026", "1/2 GN") do not count either, nor list labels,
 * "3-in-1", prices ("5 dollar"), head counts ("4 ppl"), "20+", "1 more time" and inch sizes (16").
 * The word "one" counts only when said as a quantity ("just one", "one pc"), not as a pronoun ("the blue one").
 */
export function quantityStated(quantity: number, customerTexts: string[]) {
  const digits = new RegExp(`(?<![\\w.\\-/])(?:x\\s*)?(?<!\\$\\s*)${labelBefore}${quantity}(?![-/]\\d)${notQuantityAfter}(?:\\s*(?:x|pcs?|pieces?|units?|sets?|nos?|ctns?|cartons?|pkts?|packets?|packs?|boxe?s?))?(?!\\w|\\.[^\\s.])`, "i");
  const word = numberWords[quantity];
  const wordQuantity = quantity === 1 ? oneAsQuantity : word !== undefined ? new RegExp(`\\b${word}\\b`, "i") : null;
  const chinese = chineseNumerals(quantity);
  const chineseQuantity = chinese.length
    ? new RegExp(`(?<![一二两三四五六七八九十百千万零第]|选项|型号)(?:${chinese.join("|")})(?=[个件只把套箱包盒台支张条打瓶罐双]|\\s*$)`)
    : null;
  return customerTexts.map(withoutNonQuantities).some((text) => digits.test(text)
    || (wordQuantity !== null && wordQuantity.test(text))
    || (chineseQuantity !== null && chineseQuantity.test(text)));
}

/** True when the customer's texts state any quantity (a digit, a number word or a Chinese numeral used as a count). */
export function statesAnyQuantity(customerTexts: string[]) {
  const numbers = new Set([...customerTexts.join(" ").matchAll(/\d+/g)].map((match) => Number(match[0])).filter((n) => n > 0 && n <= 100_000));
  for (let n = 1; n <= 100; n += 1) numbers.add(n);
  return [...numbers].some((n) => quantityStated(n, customerTexts));
}

// "same qty" only (owner question 4): "same as before" often means the product, not the number. Either apostrophe: phone
// keyboards type "don’t".
const sameQuantity = /(?<!\b(?:not|no|dun|don['’]?t|diff\w*)\s+(?:the\s+)?)\bsame\s+(?:qty|quantity|amount|number|no\.?|pcs|units?)\b/i;

/**
 * "same qty" while switching items (owner question 4): the earlier text holding the only quantity the customer typed in their
 * newest four texts (newest first, this one included), so update_enquiry may use that number; null when they typed none or more
 * than one (exam 3, c09-stress T7: the 20 was typed two messages before, outside the two-text window).
 */
export function sameQuantityText(currentText: string | null, typedTexts: string[]) {
  if (!currentText || !sameQuantity.test(currentText)) return null;
  const newest = typedTexts.slice(0, 4);
  const typed = [...new Set(newest.flatMap((text) => text.match(/\d+/g) ?? []).map(Number))].filter((n) => quantityStated(n, newest));
  return typed.length === 1 ? newest.find((text) => quantityStated(typed[0], [text])) ?? null : null;
}

/** The items in a pasted list: labels counting up from 1 ("1) pot 2) lid"), or bullet lines. */
export function listItemCount(text: string) {
  return Math.max(listLabels(text).length, text.split(/\n/).filter((line) => /^\s*[-•*]\s+\S/.test(line)).length);
}

/** The first labelled item of a pasted list ("1) pot 2) lid" gives "pot"), or null for fewer than two labels. */
export function firstListItem(text: string) {
  const [first, second] = listLabels(text);
  return second ? text.slice(first.index + first[0].length, second.index).trim() : null;
}

const packWords = { carton: String.raw`(?:ctns?|cartons?)\b|箱`, packet: String.raw`(?:pkts?|packets?|packs?)\b|包` };

/** This number written as digits ("2", "x2"), as a word ("two") or in Chinese ("二", "两"), followed by a carton or packet word. */
function packedNumber(quantity: number, unit: keyof typeof packWords, flags: string) {
  const forms = [String.raw`(?<![\w.\-/])(?:x\s*)?${quantity}(?![-/]\d)`];
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

// A request to clear, not "not clear leh", "don’t clear it", "no need to clear", "is the picture clear" or "clear glass jar": no
// negation up to "no need to" before it (either apostrophe: phone keyboards type ’), and "clear" before what it clears ("all",
// "this", "the whole list", "out everything"), or bare only at the start or after pls/can (u)/just/ok/help/to.
const clearRequest = /(?<!\b(?:not|don['’]?t|dont|dun|no|never)\s+(?:\w+\s+)?(?:to\s+)?)(?:\bclear\s+(?:(?:out|up|off)\s+)?(?:all|everything|it|them|this|that|these|those|my|the\s+(?:(?:whole|entire)\s+)?(?:enquiry|list|cart|lot|order|quote|items?|basket|thing)|enquiry|list|cart|order|quote)\b|(?:^\s*|\b(?:pls|please|can|just|ok|okay|help|to)\s+(?:(?:u|you)\s+)?)clear\b(?=\s*(?:$|[.!?,]|(?:la|lah|lor|pls|please)\b))|\b(?:start over|reset|remove all|delete all|cancel all|cancel everything)\b)|清空|全部取消|重新开始/i;

export async function applyEnquiryAction(
  lines: EnquiryReceiptLine[],
  action: EnquiryAction,
  customerTexts: string[],
  deps: FactDeps,
  options: { currentText?: string | null } = {},
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
  // A number from an earlier message may already have been added; adding it again would double the line.
  const alreadyOnEnquiry = lines.some((line) => line.code.toLowerCase() === code.toLowerCase());
  if (action.action === "add" && alreadyOnEnquiry && !(options.currentText && quantityStated(action.quantity, [options.currentText]))) {
    return { ok: false, error: "ALREADY_ON_ENQUIRY", notice: "This item is already on the enquiry. Use set with the new total, or add only a number the customer typed in this message." };
  }
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

/** Checks against the live store are limited so one big enquiry cannot flood store.siahuat.com. */
const VERIFY_CONCURRENCY = 6;

/** Like Promise.all over items.map(run), but with at most `limit` runs in flight. Keeps the input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
 * lookup or live check fails or times out, or whose live page shows no quantity, is never
 * removed: its code is returned in `unchecked` and the browser keeps its own copy of that line.
 */
export async function verifyEnquiry(echo: EnquiryEcho[], deps: FactDeps, timeoutMs = LIVE_CHECK_TIMEOUT_MS) {
  const notes: string[] = [];
  const unchecked: string[] = [];
  const products = new Map<string, CheckedProduct>();
  const checkedLines = await mapWithLimit(combinedEcho(echo), VERIFY_CONCURRENCY, async ({ stockId, quantity }) => {
    const catalogueProduct = await withTimeout(deps.findByCode(stockId).catch(() => "unchecked" as const), timeoutMs, "unchecked" as const);
    // An unchecked line gets no note: the context lists it as still on the enquiry, and a note under "Enquiry changes since last
    // turn" read as a removal (exam 3, c08-stress T12).
    if (catalogueProduct === "unchecked") {
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
    // A page that shows no quantity is not a reason to drop the customer's line: it stays, unchecked (the old "could not be kept"
    // deleted it for good).
    unchecked.push(stockId);
    return null;
  });
  return { lines: checkedLines.filter((line): line is EnquiryReceiptLine => line !== null), notes, products, unchecked };
}
