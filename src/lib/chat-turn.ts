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
  "plate", "plates", "glass", "glasses", "glassware", "shoe", "shoes", "spoon", "spoons",
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
    || /^(?:(?:是|对|正确)(?:的)?(?:[，,、]\s*)?)?(?:就是这个|就是这件(?:商品)?|这个|这件商品)[。.!\s]*$/u.test(message.trim())
    || /^(?:是|对|正确|确认)(?:的|商品)?[。.!\s]*$/u.test(message.trim());
  const negative = /\b(?:no|not|wrong|another|other|different|instead)\b/i.test(message)
    || /(?:不是|不对|其他|另外)/u.test(message);
  return positive && !negative;
}

export function confirmsOrderRequest(message: string) {
  const normalized = message.trim();
  return /^(?:(?:ok(?:ay|ie)?|yes|yup|yeah|sure)[,\s-]*)?(?:confirm(?:ed)?(?:\s+(?:the\s+)?(?:order|order request|enquiry))?|place the enquiry|submit(?:\s+the)?\s+enquiry(?:\s+now)?|send the enquiry|submit for review)(?:[.!\s]*)$/i.test(normalized)
    || /^(?:好的?[，,、\s]*)?(?:确认|确认订单询价|提交审核)[。.！!\s]*$/u.test(normalized);
}

const PRODUCT_NOUN = /\b(?:apron|blender|bowl|cartridge|cartridges|chair|cleaver|coffee|colander|container|cookware|cup|cutlery|dispenser|fork|gas|glass|glasses|glassware|glove|gloves|grinder|knife|knives|ladder|ladle|machine|mug|pan|pants|plate|plates|pot|rack|shoe|shoes|shot|sponge|sponges|spoon|stool|stove|strainer|table|tableware|toaster|towel|towels|tray|trolley|uniform|wok)\b/i;
const PRODUCT_CODE_REFERENCE = /\b(?:code\s*[:#-]?\s*)?[A-Z0-9]{2,}(?:-[A-Z0-9.-]+)+\b/i;

/**
 * Detects a new product request while an existing order line is being
 * reviewed. References such as "give me 5 of this" deliberately do not match,
 * because they update the selected product instead of starting a new search.
 */
export function requestsAdditionalProduct(message: string) {
  const normalized = message.trim();
  if (/^(?:add another item|start another enquiry|new item|next item|添加其他商品|再加一件商品|开始新的询价)$/iu.test(normalized)) return true;
  if (!PRODUCT_NOUN.test(normalized) && !PRODUCT_CODE_REFERENCE.test(normalized)) return false;
  if (/\b(?:this|that|it|same one)\b/i.test(normalized) && !/\b(?:also|too|another|add)\b/i.test(normalized)) return false;
  return /\b(?:add|also|another|too|as well|i (?:also )?(?:want|need)|we (?:also )?(?:want|need)|get me|give me)\b/i.test(normalized)
    || /(?:还要|也要|再加|另外要|加上)/u.test(normalized);
}

export function isGenericAddAnotherItem(message: string) {
  return /^(?:add another item|start another enquiry|new item|next item|添加其他商品|再加一件商品|开始新的询价)$/iu.test(message.trim());
}

/**
 * Retains later product clauses from a natural multi-item enquiry so the UI
 * can continue with them after the first line has been live-stock checked.
 */
export function splitMultipleProductRequest(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  const numberedMarkers = [...compact.matchAll(/(?:^|[,;]\s*|\s+)(\d{1,2})\s*[).:-]\s*/g)];
  const numberedClauses = numberedMarkers.length >= 2
    ? numberedMarkers.map((marker, index) => {
        const start = (marker.index ?? 0) + marker[0].length;
        const end = numberedMarkers[index + 1]?.index ?? compact.length;
        return compact.slice(start, end);
      })
    : [];
  const clauses = (numberedClauses.length > 0
    ? numberedClauses
    : compact.split(/\s+(?:and|plus|as well as)\s+|\s*[;,]\s*(?=(?:i\s+)?(?:need|want|add|\d+\s*(?:packets?|packs?|cartons?|ctns?|pieces?|pcs?|units?|sets?|pairs?)))/i))
    .map((clause) => clause
      .replace(/^(?:and|plus|as well as)\s+/i, "")
      .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
      .trim())
    .filter(Boolean);
  const productClauses = clauses.filter((clause) => PRODUCT_NOUN.test(clause) || PRODUCT_CODE_REFERENCE.test(clause));
  return productClauses.length >= 2
    ? productClauses.map((clause) => /^i\s+(?:need|want)\b/i.test(clause) ? clause : `I need ${clause}`)
    : [];
}

/**
 * Keeps a bare attribute correction in the catalogue-search path instead of
 * treating it as a request to select whichever displayed card happens to
 * share one token. Explicit choices such as "take the black one" still use
 * the displayed-product resolver.
 */
export function isProductRefinementOnly(message: string) {
  const refinement = /\b(?:actually|instead|make\s+that|change(?:\s+it)?\s+to|red|yellow|blue|black|white|green|silver|grey|gray|brown|round|square|rectangular|rectangle|oval|dinner|side|salad|dessert|ceramic|porcelain|melamine|plastic|stainless|commercial|restaurant|fine\s+dining)\b|\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i.test(message);
  if (!refinement) return false;

  const explicitSelection = /\b(?:take|choose|select|pick|order|buy|give\s+me|go\s+with)\b|\b(?:this|that|the)\s+(?:one|item|product|option)\b|\b(?:option|choice|item|number|no\.?)\s*#?\s*\d+\b|\b(?:first|1st|second|2nd|third|3rd|fourth|4th|last|top|bottom)(?:\s+one)?\b/i.test(message);
  return !explicitSelection;
}

export function requestsAnotherOption(message: string) {
  const normalized = message.trim();
  return /\b(?:another|different|other)\s+(?:item|option|product|one)\b/i.test(normalized)
    || /\b(?:show|share|give|find)\b[\s\S]{0,40}\b(?:more|different|other)\b(?:[\s\S]{0,20}\b(?:options?|ones?|items?|products?)\b)?/i.test(normalized)
    || /^(?:(?:i don'?t know[, ]*)?(?:(?:can|could|would) you\s+)?)?(?:recommend|recommend something|share (?:a )?few(?:\s+more)?(?:\s+(?:options?|items?|products?))?|show (?:me )?(?:a )?few(?:\s+more)?(?:\s+(?:options?|items?|products?))?|show (?:me )?(?:some )?(?:more )?options?|are there (?:any )?(?:more |other )?(?:options?|items?|products?|ones?)|got (?:any )?(?:more |other )?(?:options?|items?|products?|ones?))\??$/i.test(normalized)
    || /\b(?:show|give|find|see|look at|want|prefer)(?:\s+me)?\s+(?:something|anything)\s+(?:else|different)\b/i.test(normalized)
    || /(?:选择|查看|显示|找)(?:另一个|其他|别的)(?:商品|产品|选项)?/u.test(normalized);
}

export function asksForRecommendation(message: string) {
  return /^(?:(?:can|could|would) you\s+)?(?:recommend(?: one)?(?: for me)?|which (?:one|option) (?:do you |would you )?recommend|which (?:one|option) would you (?:personally\s+)?(?:pick|choose)|pick (?:one|the best one)(?: for me)?|choose (?:one|the best one) for me)\??$/i.test(message.trim());
}

export type QuantityParseResult =
  | { kind: "none" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; reason: "fractional" | "range" };

type QuantityCandidate = { index: number; raw: string };

const wordQuantities: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const chineseQuantityDigits: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function parseChineseQuantity(value: string) {
  if (value === "十") return 10;
  const [tens, ones] = value.split("十");
  if (ones !== undefined) {
    return (tens ? chineseQuantityDigits[tens] ?? 0 : 1) * 10 + (ones ? chineseQuantityDigits[ones] ?? 0 : 0);
  }
  return chineseQuantityDigits[value] ?? null;
}

function collectQuantityCandidates(message: string, pattern: RegExp, group = 1) {
  const candidates: QuantityCandidate[] = [];
  for (const match of message.matchAll(pattern)) {
    const raw = match[group];
    if (!raw) continue;
    const index = (match.index ?? 0) + match[0].lastIndexOf(raw);
    if (/\/\s*$/.test(message.slice(0, index))) continue;
    const suffix = message.slice(index + raw.length);
    if (/^\s*-?\s*steps?\b/i.test(suffix)) continue;
    if (/^\s*(?:cm|mm|inches?|inch|litres?|liters?|ml|kg|g)\b/i.test(suffix)) continue;
    if (/^\s*[x×]\s*\d/i.test(suffix)) continue;
    candidates.push({ index, raw });
  }
  return candidates;
}

export function parseRequestedQuantity(message: string): QuantityParseResult {
  const candidates = [
    ...collectQuantityCandidates(
      message,
      /\b(?:actually\s+)?(?:make\s+(?:it|that)|change(?:\s+the)?\s+quantity(?:\s+to)?|quantity(?:\s+to)?|change\s+to)\s*(-?\d+(?:\.\d+)?)/gi,
    ),
    ...collectQuantityCandidates(
      message,
      /(?<![\w.])(-?\d+(?:\.\d+)?)\s+(?:(?:\w[\w'-]*)\s+){0,3}(?:knives?|glasses?|plates?|bowls?|cups?|mugs?|pans?|woks?|pots?|grinders?|blenders?|strainers?|shoes?|spoons?|forks?|cartridges?|sponges?|towels?|gloves?|toasters?|ladders?|stools?|trolleys?)\b/gi,
    ),
    ...collectQuantityCandidates(message, /(?<![\w.])(-?\d+(?:\.\d+)?)\s*(?:pieces?|pcs?|units?|sets?|pairs?|packets?|packs?|cartons?|ctns?)\w*\b/gi),
    ...collectQuantityCandidates(message, /(-?\d+(?:\.\d+)?)\s*(?:个|件|只|套|把|双|份)/gu),
    ...collectQuantityCandidates(message, /\b(-?\d+(?:\.\d+)?)\s+(?:of\s+)?(?:this|that|it|these|those|them)\b/gi),
    ...collectQuantityCandidates(
      message,
      /\b(?:get|want|need|order|buy|take|have|give(?:\s+me)?|qty|quantity(?:\s+of)?)(?:\s+(?:no\.?|number))?\s*(-?\d+(?:\.\d+)?)/gi,
    ),
  ];

  for (const match of message.matchAll(/\b(a|one|two|three|four|five|six|half)?\s*dozen\b/gi)) {
    const amount = match[1]?.toLowerCase();
    const quantity = amount === "half" ? 6 : amount && amount !== "a" ? (wordQuantities[amount] ?? 1) * 12 : 12;
    candidates.push({ index: match.index ?? 0, raw: String(quantity) });
  }

  for (const match of message.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:pieces?|pcs?|units?|sets?|pairs?)\b/gi)) {
    const quantity = wordQuantities[match[1].toLowerCase()];
    if (quantity) candidates.push({ index: match.index ?? 0, raw: String(quantity) });
  }

  for (const match of message.matchAll(/([零〇一二两三四五六七八九十]+)\s*(?:个|件|只|套|把|双|份)/gu)) {
    const quantity = parseChineseQuantity(match[1]);
    if (quantity !== null) candidates.push({ index: match.index ?? 0, raw: String(quantity) });
  }

  for (const match of message.matchAll(/\bnegative\s+(\d+(?:\.\d+)?)/gi)) {
    const index = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
    candidates.push({ index, raw: `-${match[1]}` });
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
