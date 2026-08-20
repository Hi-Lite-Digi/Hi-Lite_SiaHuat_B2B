import type { Product } from "@/lib/chat-contract";

export function requestedProductIndex(message: string, productCount: number) {
  const numbered = message.trim().match(/^(\d+)$/)?.[1]
    ?? message.match(/\b(?:option|choice|item|number|no\.?)\s*#?\s*(\d+)\b/i)?.[1]
    ?? message.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:option|choice|item)\b/i)?.[1];
  if (numbered) {
    const index = Number.parseInt(numbered, 10) - 1;
    return index >= 0 && index < productCount ? index : null;
  }

  const ordinal = message.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|last|top|bottom)(?:\s+one)?\b/i)?.[1].toLowerCase();
  if (!ordinal) return null;
  const indexes: Record<string, number> = {
    first: 0, "1st": 0, top: 0,
    second: 1, "2nd": 1,
    third: 2, "3rd": 2,
    fourth: 3, "4th": 3,
    last: productCount - 1, bottom: productCount - 1,
  };
  const index = indexes[ordinal];
  return index >= 0 && index < productCount ? index : null;
}

const DISPLAY_REFERENCE_FILLER = new Set([
  "a", "an", "and", "can", "choose", "could", "for", "get", "give", "have", "i", "id",
  "item", "me", "of", "one", "option", "order", "please", "product", "select", "take", "that",
  "the", "this", "to", "want", "with", "would",
]);

const GENERIC_PRODUCT_REFERENCE = new Set([
  "item", "product", "option", "knife", "knives", "pan", "pans", "wok", "woks",
  "plate", "plates", "glass", "glassware", "shoe", "shoes", "spoon", "spoons",
  "fork", "forks", "strainer", "strainers", "pot", "pots", "grinder", "grinders",
]);

function referenceTokens(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !DISPLAY_REFERENCE_FILLER.has(token));
}

function productReferenceText(product: Product) {
  return [
    product.stock_id,
    product.name,
    product.brand,
    product.model,
    product.size,
    product.dimensions,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

/**
 * Resolves a customer's follow-up against the options that were just displayed.
 * A descriptive match must contain a token that distinguishes one displayed
 * product from the others, so a generic phrase such as "the knife" does not
 * silently select an arbitrary knife.
 */
export function requestedDisplayedProductIndex(message: string, products: Product[]) {
  const numbered = requestedProductIndex(message, products.length);
  if (numbered !== null) return numbered;
  if (referencesSingleDisplayedProduct(message, products.length)) return 0;
  if (products.length === 0) return null;

  const normalizedMessage = message.toLocaleLowerCase();
  const exactCodeMatches = products
    .map((product, index) => ({ index, code: product.stock_id.toLocaleLowerCase() }))
    .filter(({ code }) => code.length > 0 && normalizedMessage.includes(code));
  if (exactCodeMatches.length === 1) return exactCodeMatches[0].index;

  const messageTokens = [...new Set(referenceTokens(message))];
  if (messageTokens.length === 0) return null;
  const productTexts = products.map(productReferenceText);
  const productTokenSets = productTexts.map((value) => new Set(referenceTokens(value)));
  const tokenFrequency = new Map<string, number>();
  for (const token of messageTokens) {
    tokenFrequency.set(token, productTokenSets.filter((tokens) => tokens.has(token)).length);
  }

  const scores = products.map((product, index) => {
    const text = productTexts[index];
    const tokens = productTokenSets[index];
    const distinctive = messageTokens.filter((token) =>
      tokens.has(token)
      && tokenFrequency.get(token) === 1
      && !GENERIC_PRODUCT_REFERENCE.has(token),
    );
    const allMatches = messageTokens.filter((token) => tokens.has(token));
    const phraseBonus = messageTokens.length >= 2 && text.includes(messageTokens.join(" ")) ? 20 : 0;
    return {
      index,
      distinctiveCount: distinctive.length,
      score: phraseBonus
        + distinctive.reduce((total, token) => total + Math.min(token.length, 12), 0)
        + allMatches.length,
    };
  }).filter((candidate) => candidate.distinctiveCount > 0);

  if (scores.length === 0) return null;
  scores.sort((left, right) => right.score - left.score);
  if (scores.length > 1 && scores[0].score === scores[1].score) return null;
  return scores[0].index;
}

export function referencesSingleDisplayedProduct(message: string, productCount: number) {
  if (productCount !== 1) return false;

  const referencesProduct = /\b(?:this|that)(?:\s+(?:one|item|product))?\b|\b(?:it|the one)\b/i.test(message);
  const hasSelectionIntent = /\b(?:want|need|take|choose|select|buy|order|get|give|have|confirm)\b/i.test(message);
  return referencesProduct && (hasSelectionIntent || requestedQuantity(message) !== null);
}

export function confirmsDisplayedProduct(message: string) {
  const positive = /^(?:yes|yup|yeah|correct|confirm|this is it)\b/i.test(message.trim())
    || /^(?:是|对|正确|确认|就是这个|就是这件)(?:的|商品)?[。.!\s]*$/u.test(message.trim());
  const negative = /\b(?:no|not|wrong|another|other|different|instead)\b/i.test(message)
    || /(?:不是|不对|其他|另外)/u.test(message);
  return positive && !negative;
}

export function requestsAnotherOption(message: string) {
  const normalized = message.trim();
  return /\b(?:another|different|other)\s+(?:item|option|product|one)\b/i.test(normalized)
    || /^(?:(?:i don'?t know[, ]*)?(?:(?:can|could|would) you\s+)?)?(?:recommend|recommend something|share (?:a )?few|show (?:me )?(?:a )?few|show (?:me )?(?:some )?options?|are there (?:any )?others?|got (?:any )?others?)\??$/i.test(normalized)
    || /\b(?:show|give|find|see|look at|want|prefer)(?:\s+me)?\s+(?:something|anything)\s+(?:else|different)\b/i.test(normalized)
    || /(?:选择|查看|显示|找)(?:另一个|其他|别的)(?:商品|产品|选项)?/u.test(normalized);
}

export type QuantityParseResult =
  | { kind: "none" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; reason: "fractional" | "range" };

type QuantityCandidate = { index: number; raw: string };

function collectQuantityCandidates(message: string, pattern: RegExp, group = 1) {
  const candidates: QuantityCandidate[] = [];
  for (const match of message.matchAll(pattern)) {
    const raw = match[group];
    if (!raw) continue;
    const index = (match.index ?? 0) + match[0].lastIndexOf(raw);
    const suffix = message.slice(index + raw.length);
    if (/^\s*(?:cm|mm|inches?|inch|litres?|liters?|ml|kg|g)\b/i.test(suffix)) continue;
    candidates.push({ index, raw });
  }
  return candidates;
}

export function parseRequestedQuantity(message: string): QuantityParseResult {
  const candidates = [
    ...collectQuantityCandidates(
      message,
      /\b(?:actually\s+)?(?:make\s+it|change(?:\s+the)?\s+quantity(?:\s+to)?|quantity(?:\s+to)?|change\s+to)\s*(-?\d+(?:\.\d+)?)/gi,
    ),
    ...collectQuantityCandidates(message, /(-?\d+(?:\.\d+)?)\s*(?:pieces?|pcs?|units?|sets?|pairs?)\w*\b/gi),
    ...collectQuantityCandidates(message, /(-?\d+(?:\.\d+)?)\s*(?:个|件|只|套|把|双|份)/gu),
    ...collectQuantityCandidates(message, /\b(-?\d+(?:\.\d+)?)\s+(?:of\s+)?(?:this|that|it|these|those|them)\b/gi),
    ...collectQuantityCandidates(
      message,
      /\b(?:get|want|need|order|buy|take|have|give(?:\s+me)?|qty|quantity(?:\s+of)?)(?:\s+(?:no\.?|number))?\s*(-?\d+(?:\.\d+)?)/gi,
    ),
  ];

  for (const match of message.matchAll(/\bnegative\s+(\d+(?:\.\d+)?)/gi)) {
    candidates.push({ index: match.index ?? 0, raw: `-${match[1]}` });
  }

  if (candidates.length === 0) return { kind: "none" };
  const latest = candidates.sort((left, right) => left.index - right.index).at(-1);
  if (!latest) return { kind: "none" };
  const quantity = Number(latest.raw);
  if (!Number.isInteger(quantity)) return { kind: "invalid", reason: "fractional" };
  if (quantity < 1 || quantity > 100_000) return { kind: "invalid", reason: "range" };
  return { kind: "valid", value: quantity };
}

export function requestedQuantity(message: string) {
  const parsed = parseRequestedQuantity(message);
  return parsed.kind === "valid" ? parsed.value : null;
}
