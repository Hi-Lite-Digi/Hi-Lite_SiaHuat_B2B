import type { ChatStage, HistoryItem, ImageAttachment, Product } from "@/lib/chat-contract";
import { normalizeClaireMessage } from "@/lib/claire-voice";
import { resolveRiceDispenserModels } from "@/lib/image-comparison";

export type FastChatInput = {
  sessionId: string;
  message: string;
  history: HistoryItem[];
  image?: ImageAttachment;
  context?: {
    stage?: ChatStage;
    activeProduct?: Product | null;
    quantity?: number | null;
    displayedProducts?: Product[];
  };
};

export type FastReply = {
  message: string;
  stage: ChatStage;
  products: [];
  selectedProduct: null;
  suggestions: string[];
};

export const productWords = /\b(knife|knives|chef|damascus|sharpener|sharpeners|sharpening|whetstone|honing|cutlery|utensil|utensils|spatula|spatulas|turner|turners|whisk|whisks|peeler|peelers|tong|tongs|fork|forks|spoon|spoons|scoop|scoops|strainer|strainers|skimmer|skimmers|colander|colanders|box|boxes|bin|bins|cambox|storage|plate|plates|bowl|bowls|glass|glasses|glassware|shot|shots|cup|cups|mug|mugs|pan|pans|wok|woks|lid|lids|cover|covers|pot|pots|stockpot|stockpots|cookware|tableware|dinnerware|dining|barware|buffet|catering|kitchen|serving|rice|tray|trays|trolley|trolleys|blender|blenders|toaster|toasters|toaser|toasers|ladder|ladders|stool|stools|cartridge|cartridges|gas|sponge|sponges|towel|towels|glove|gloves|coffee|bean|beans|grinder|grinders|tea|shoe|shoes|shows|footwear|pants|trousers|uniform|apparel|dispenser|dispencer|urn|boiler|airpot|sku|product|products|item|items|brand|price|cost|stock|available|availability|quantity|qty|quote|quotation|order|buy|cart)\b/i;
export const skuPattern = /\b[a-z0-9]+(?:[-/][a-z0-9]+)+\b/i;

/**
 * Corrects a deliberately small set of high-confidence product-request typos.
 * This is used only for intent/search parsing; the customer's original words
 * remain unchanged in the visible conversation and exported summary.
 */
export function normalizeCommonProductTypos(message: string) {
  return message
    .replace(/\b(?:ned|nead|nedd)\b/gi, "need")
    .replace(/\b(?:blak|balck|blakc)\b/gi, "black")
    .replace(/\b(?:dinnr|dinr)\b/gi, "dinner")
    .replace(/\bmeggemi\b/gi, "maggi mee")
    .replace(/\b(?:maggie|magy)\b/gi, "maggi")
    .replace(/\b(?:noodal|noodel)\b/gi, "noodle")
    .replace(/\b(?:pltes|paltes)\b/gi, "plates")
    .replace(/\b(?:plte|palte)\b/gi, "plate");
}

/** Prevent ordinary basket/plant/coffee language from becoming cookware-fit intent. */
export function hasUnrelatedPotOrBasketMeaning(message: string) {
  return /\b(?:plant|flower|garden|coffee)\s+pots?\b|\bpot\s+stickers?\b|\b(?:storage|bread|fruit|shopping|fryer|deep[ -]?fryer|wire|dish|laundry|waste|serving|display|gift|knife|filter|bamboo|cutlery|dishwasher|plant|flower|garden)\s+baskets?\b|\bbaskets?\s+(?:of|for)\s+(?:the\s+)?(?:bread|fruit|shopping|deep[ -]?fryers?|fryers?|knives|cutlery|dishes|storage|display|gifts?)\b|\bbaskets?\s+to\s+(?:store|hold|carry|display)\b/i.test(message);
}

/**
 * Recognises colloquial requests where a pot is only a fit reference and the
 * customer wants the insert/basket/strainer, not another pot. "Basket" stays
 * deliberately guarded by the pot + ownership + fit wording so ordinary bread
 * or storage baskets never become strainers.
 */
export function isExistingPotStrainerRequest(message: string) {
  const normalized = normalizeCommonProductTypos(message);
  if (hasUnrelatedPotOrBasketMeaning(normalized)) return false;
  const mentionsPot = /\b(?:stock\s*)?pots?\b/i.test(normalized);
  const mentionsInsert = /\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(normalized);
  const fitOnly = /\b(?:fit(?:s|ted|ting)?|inside|inner|(?:only|just)\s+(?:(?:need|want|buy|order)\s+)?(?:a\s+)?(?:strainer|colander|basket|insert)|(?:strainer|colander|basket|insert)\s+only)\b/i.test(normalized);
  const requestsInsert = /\b(?:need(?:s)?|want|buy|order|get|find|looking(?:\s+for)?)\b[^.!?;]{0,40}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(normalized)
    || /\b(?:strainers?|colanders?|baskets?|inserts?)\b[^.!?;]{0,30}\bfor\s+(?:my|our|the\s+existing|the\s+current)\b/i.test(normalized);
  const explicitlyDoesNotOwnPot = /\b(?:do\s+not|don['’]?t|dont|not|no\s+longer)\s+(?:have|got|own)\s+(?:a|the|any|my)?\s*(?:stock\s*)?pots?\b/i.test(normalized);
  const explicitlyNeedsPotOnly = /\b(?:only|just)\s+(?:need|want|buy|order|get)\s+(?:(?:a|the|one)\s+)?(?:new|another|replacement)?\s*(?:stock\s*)?pots?\b/i.test(normalized);
  const rejectsAnotherPot = /\b(?:(?:do\s+not|don['’]?t|dont|no\s+need(?:\s+to)?)\s+(?:need|want|buy|order|get)?\s*(?:(?:a|the|one)\s+)?(?:new|another|replacement)?\s*(?:stock\s*)?pots?|no\s+(?:more\s+|new\s+|another\s+)?(?:stock\s*)?pots?|no\s+(?:stock\s*)?pots?\s+needed)\b/i.test(normalized);
  // Remove a negated acquisition clause before looking for a positive pot
  // request. Otherwise “don't want another pot” is mistaken for “want pot”.
  const positiveRequestScan = normalized.replace(
    /\b(?:(?:do\s+not|don['’]?t|dont|no\s+need(?:\s+to)?)\s+(?:need|want|buy|order|get)?\s*(?:(?:a|the|one)\s+)?(?:new|another|replacement)?\s*(?:stock\s*)?pots?|no\s+(?:more\s+|new\s+|another\s+)?(?:stock\s*)?pots?|no\s+(?:stock\s*)?pots?\s+needed)\b/gi,
    " ",
  );
  const explicitlyRequestsPot = /\b(?:need|want|buy|order|get)\s+(?:(?:a|the|one)\s+)?(?:new|another|replacement)?\s*(?:stock\s*)?pots?\b/i.test(positiveRequestScan);
  if (explicitlyDoesNotOwnPot || explicitlyNeedsPotOnly || explicitlyRequestsPot) return false;
  const ownsPot = /\b(?:i|we)\s+(?:already|alr|currently)?\s*(?:have|got|own)\s+(?:a|an|the|this|that|one|my|our)?\s*(?:\d+(?:\.\d+)?\s*qt\s+)?(?:old\s+|existing\s+|current\s+)?(?:stock\s*)?pots?\b/i.test(normalized)
    || /^\s*(?:already|alr|currently)\s+(?:have|got|own)\b[^.!?;]{0,36}\bpots?\b/i.test(normalized)
    || /\b(?:my|our)\s+(?:(?:old|existing|current)\s+)?(?:\d+(?:\.\d+)?\s*qt\s+)?(?:stock\s*)?pots?\b/i.test(normalized)
    || /\b(?:the\s+)?(?:existing|current)\s+(?:\d+(?:\.\d+)?\s*qt\s+)?(?:stock\s*)?pots?\b/i.test(normalized)
    || /\bpots?\b[^.!?]{0,16}\b(?:already|alr)\b/i.test(normalized)
    || /\bpots?\b[^.!?;]{0,28}\b(?:i|we)\s+(?:already|alr|currently)?\s*(?:have|got|own)\b/i.test(normalized)
    // Common Singapore chat shorthand: "no pot I have, need strainer" means
    // "no new pot; I have one already". Either way, never infer a pair sale.
    || /\bno\s+(?:new\s+)?pots?\s*[,.;-]?\s*i\s+(?:have|got|own)\b/i.test(normalized)
    || rejectsAnotherPot;
  const bareInsertRequest = /\b(?:strainers?|colanders?|baskets?|inserts?)\s*(?:please|pls|\?)\s*$/i.test(normalized)
    || /\b(?:already|alr)\b[^.!?;]{0,35}\bpots?\b[^.!?;]{0,35}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(normalized)
    || /\bpots?\b[^.!?;]{0,20}\b(?:already|alr)\b[^.!?;]{0,35}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(normalized);
  return mentionsPot && mentionsInsert && ownsPot && (fitOnly || requestsInsert || bareInsertRequest);
}

export type PotFitMeasurements = {
  innerDiameter: string | null;
  usableDepth: string | null;
};

function normalizedDimension(value: string, unit: string) {
  const normalizedUnit = /^in(?:ch|ches)?$/i.test(unit) ? "in" : unit.toLowerCase();
  return `${value} ${normalizedUnit}`;
}

/** Extract labelled pot-fit measurements, inheriting a shared unit in chat. */
export function extractPotFitMeasurements(message: string): PotFitMeasurements {
  const unit = "(cm|mm|inches?|inch|in)";
  const before = (labels: string) => new RegExp(`\\b(?:${labels})\\s*(?:is|[:=-])?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}?`, "i");
  const after = (labels: string) => new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${unit}?\\s*(?:${labels})\\b`, "i");
  const find = (labels: string) => {
    const direct = message.match(before(labels));
    if (direct) return { value: direct[1], unit: direct[2] ?? null };
    const reversed = message.match(after(labels));
    return reversed ? { value: reversed[1], unit: reversed[2] ?? null } : null;
  };
  const diameter = find("inside|inner(?:[ -]?rim)?(?:\\s+diameter)?|diameter");
  const depth = find("usable\\s+depth|depth|deep");
  const sharedUnit = diameter?.unit ?? depth?.unit ?? null;
  return {
    innerDiameter: diameter && (diameter.unit || sharedUnit)
      ? normalizedDimension(diameter.value, diameter.unit ?? sharedUnit!)
      : null,
    usableDepth: depth && (depth.unit || sharedUnit)
      ? normalizedDimension(depth.value, depth.unit ?? sharedUnit!)
      : null,
  };
}

export const productCategories = [
  { pattern: /\b(?:knife\s+)?(?:sharpeners?|sharpening\s+(?:stone|steel)|whetstone|honing\s+steel)\b/i, label: "knife sharpener" },
  { pattern: /\b(knife|knives|cleaver|boning knife|paring knife)\b|砍骨刀|菜刀|刀/iu, label: "knife" },
  { pattern: /\bserving\s+spoons?\b/i, label: "serving spoon" },
  { pattern: /\b(cutlery|flatware)(?:\s+sets?)?\b|\bspoons?\b[\s\S]*\bforks?\b|\bforks?\b[\s\S]*\bspoons?\b/i, label: "cutlery set" },
  { pattern: /\b(?:full|complete)\s+(?:home\s+)?(?:dining|dinnerware|tableware)?\s*sets?\b|\b(?:dining|dinnerware|tableware)\s+sets?\b|\bsets?\s+for\s+dining\b/i, label: "dining set" },
  { pattern: /\b(?:kitchen\s+)?utensils?\b|\b(?:spatulas?|turners?|whisks?|peelers?|tongs?)\b/i, label: "utensil" },
  { pattern: /\bladles?\b/i, label: "utensil" },
  { pattern: /\bwok\s+(?:lid|cover)s?\b|\b(?:lid|cover)s?\s+(?:for\s+)?(?:a\s+)?wok\b/i, label: "wok lid" },
  { pattern: /\b(?:replacement\s+)?(?:lid|lids|cover|covers)\b/i, label: "lid" },
  { pattern: /\b(wok|woks)\b/i, label: "wok" },
  { pattern: /\b(?:tray|rack|gn|gastronorm|multi[ -]?level)[ -]*trolleys?\b|\btrolleys?\b/i, label: "trolley" },
  { pattern: /\b(pan|pans|skillet)\b/i, label: "pan" },
  { pattern: /\b(stockpot|stockpots|stock\s+pot|stock\s+pots)\b/i, label: "stockpot" },
  { pattern: /\b(?:plant|flower|garden)\s+pots?\b/i, label: "plant pot" },
  { pattern: /\b(?:storage|bread|fruit|shopping|fryer|deep[ -]?fryer|wire|dish|laundry|waste|serving|display|gift|knife|filter|bamboo|cutlery|dishwasher|plant|flower|garden)\s+baskets?\b|\bbaskets?\s+(?:of|for)\s+(?:the\s+)?(?:bread|fruit|shopping|deep[ -]?fryers?|fryers?|knives|cutlery|dishes|storage|display|gifts?)\b|\bbaskets?\s+to\s+(?:store|hold|carry|display)\b/i, label: "basket" },
  { pattern: /\b(pot|pots)\b/i, label: "pot" },
  { pattern: /\bshot\s+glass(?:es)?\b/i, label: "shot glass" },
  { pattern: /\b(glass|glasses|glassware|tumbler|tumblers)\b/i, label: "glassware" },
  { pattern: /\b(plate|plates|tableware)\b/i, label: "tableware" },
  { pattern: /\b(strainers?|strainners?|straners?|skimmers?|colanders?)\b/i, label: "strainer" },
  { pattern: /\b(?:utility|storage|dish|bus|cutlery|rectangular|multi[ -]?purpose)\s+(?:box|boxes|bin|bins)\b|\bcambox\b/i, label: "utility box" },
  { pattern: /\b(blender|blenders|blending machine)\b/i, label: "blender" },
  { pattern: /\b(?:toasters?|toasers?|ya\s+kun)\b|^(?=[\s\S]*\b(?:4|6|four|six)\s*[ -]?slots?\b)(?=[\s\S]*\b(?:pop[ -]?up|(?:not|non[ -]?)\s*(?:a\s+)?conve(?:yor|yr)|(?:no|not|without)\s+(?:a\s+)?belt(?:\s+type)?)\b)[\s\S]*$/i, label: "toaster" },
  { pattern: /\b(?:step\s+)?(?:ladders?|stools?)\b/i, label: "ladder" },
  { pattern: /\b(?:cassette\s+)?gas\s+torch(?:\s+burners?)?\b|\btorch\s+(?:burners?|heads?|attachments?)\b|\bburner\s+(?:heads?|attachments?)\b(?=[^.!?]{0,32}\b(?:gas|butane|cartridges?|cans?)\b)|^(?=[\s\S]*\bburner\s+(?:heads?|attachments?)\b)(?=[\s\S]*\b(?:not|no|without|don['’]?t(?:\s+(?:need|want))?|dont(?:\s+(?:need|want))?)\b[\s\S]{0,40}\b(?:gas\s+)?(?:cans?|canisters?|cartridges?)\b)[\s\S]*$|\bmetal\s+torch\s+burner\s+attachments?\b|\biwatani?\b[\s,/-]*(?:gas\s+)?torch(?:\s+burners?)?\b|\b(?:gas\s+)?torch\s+burners?\b[\s,/-]*iwatani?\b/i, label: "gas torch burner" },
  { pattern: /\b(?:butane\s+|gas\s+)?cartridges?\b/i, label: "gas cartridge" },
  { pattern: /\b(?:scrub\s+)?sponges?\b/i, label: "cleaning sponge" },
  { pattern: /\b(?:kitchen\s+|paper\s+)?towels?\b/i, label: "paper towel" },
  { pattern: /\bgloves?\b/i, label: "glove" },
  { pattern: /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i, label: "coffee grinder" },
  { pattern: /\bcoffee(?:\s+beans?)?\b(?!\s*grinders?)/i, label: "coffee product" },
  { pattern: /\b(shoe|shoes|shows|footwear)\b/i, label: "shoe" },
  { pattern: /\b(?:chef\s+)?(?:pants|trousers)\b/i, label: "chef pants" },
  { pattern: /\b(?:camtainer|insulated\s+beverage\s+(?:dispenser|server)|(?:beverage|drink|tea)\s+(?:dispenser|server))s?\b/i, label: "beverage dispenser" },
  { pattern: /\brice\s+disp(?:ens|enc)ers?\b|\bWF[\s_-]*RD[\s_-]*\d{1,3}\b/i, label: "rice dispenser" },
  { pattern: /\b(?:water\s+(?:dispenser|urn|boiler)|(?:electric|thermal)\s+airpot|drinking\s+fountain)\b/i, label: "water dispenser" },
] as const;

export function isCookedNoodleDrainingIntent(message: string) {
  const normalized = normalizeCommonProductTypos(message).toLowerCase();
  const hasNoodleFood = /\b(?:noodles?|maggi|mee|pasta)\b/.test(normalized);
  if (!hasNoodleFood) return false;

  const directlyDrains = /\b(?:drain|draining|strain|straining)\b/.test(normalized);
  const removesLiquid = /\b(?:water|liquid|broth|soup)\b/.test(normalized)
    && /\b(?:throw|pour|remove|discard|empty|get\s+rid|take|separate)\b/.test(normalized);
  const afterCooking = /\b(?:after|once|when)\s+(?:i\s+|we\s+)?(?:cook|boil|cooked|boiled)\b/.test(normalized)
    && /\b(?:water|liquid|drain|strain|pour|throw|remove|discard|empty)\b/.test(normalized);
  return directlyDrains || removesLiquid || afterCooking;
}

export function isAmbiguousNoodleDryingRequest(message: string) {
  const normalized = normalizeCommonProductTypos(message).toLowerCase();
  return /\b(?:dry|drying)\b/.test(normalized)
    && /\b(?:noodles?|maggi|mee|pasta)\b/.test(normalized)
    && !isCookedNoodleDrainingIntent(normalized);
}

export function isTradePriceQuestion(message: string) {
  return /\b(?:trade|wholesale|account|contract)\s+(?:price|pricing|rate)\b|\bprice\s+for\s+(?:trade|wholesale|account)\b|\bhow\s+much(?:\s+is\s+(?:it|this|that))?\s+for\s+(?:us|me|our\s+(?:company|business|account))\b|\b(?:our|my)\s+(?:price|rate)\b/i.test(message);
}

export function isExactStockQuestion(message: string) {
  const count = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const selectionNumber = "(?:\\d+|one|two|three|four|first|second|third|fourth|last|1st|2nd|3rd|4th)";
  const selection = `(?:(?:\\s+of\\s+|,\\s*)(?:(?:the\\s+)?(?:first|second|third|fourth|last|1st|2nd|3rd|4th)(?:\\s+(?:one|option|choice|item))?|(?:option|choice|item|number|no\\.?)\\s*#?\\s*${selectionNumber}))?`;
  return /\b(?:how\s+(?:many|much)\s+(?:stock|stocks?|pieces?|pcs?|units?)|(?:exact|actual|current|available|live)\s+(?:stock|stocks?|quantity|qty)|(?:stock|stocks?)\s+(?:balance|level|count|quantity|qty|left|available)|(?:available|remaining)\s+(?:stock|quantity|qty|pieces?|pcs?|units?)|(?:quantity|qty)\s+(?:available|left|in\s+stock))\b/i.test(message)
    || new RegExp(`\\b(?:got|have)\\s+(?:at\\s+least\\s+)?${count}\\s*(?:pieces?|pcs?|units?)?${selection}\\s*(?:or\\s+not|available|in\\s+stock|left|on\\s+hand|stock)\\b`, "i").test(message)
    || new RegExp(`\\b(?:do\\s+(?:you|u)\\s+)?(?:got|have)\\s+(?:at\\s+least\\s+)?${count}\\s*(?:pieces?|pcs?|units?)?${selection}\\s*\\?\\s*$`, "i").test(message)
    || new RegExp(`\\b${count}\\s*(?:pieces?|pcs?|units?)?\\s*(?:available|left|in\\s+stock|on\\s+hand)\\b`, "i").test(message)
    || new RegExp(`\\benough\\s+for\\s+${count}\\b`, "i").test(message)
    || new RegExp(`\\bcan\\s+(?:(?:you|u)\\s+)?(?:supply|provide)\\s+(?:at\\s+least\\s+)?${count}\\s*(?:pieces?|pcs?|units?)?\\b`, "i").test(message)
    || new RegExp(`\\b(?:option|choice|item|number|no\\.?)\\s*#?\\s*${selectionNumber}\\s+(?:got|have|has)?\\s*${count}\\s*(?:pieces?|pcs?|units?)?\\s*(?:available|left|in\\s+stock|on\\s+hand|or\\s+not)?\\s*\\?`, "i").test(message);
}

export function simplifyMessage(message: string) {
  return normalizeCommonProductTypos(message)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCatalogueRequest(message: string) {
  const normalizedMessage = normalizeCommonProductTypos(message);
  const simple = normalizedMessage
    .toLowerCase()
    .replace(/[^a-z0-9'\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return productWords.test(normalizedMessage)
    || /\b(?:strainners?|straners?|noodal|noodel)\b/i.test(normalizedMessage)
    || productCategory(normalizedMessage) !== null
    || /\b(?:che+f+f?|knfie|kinife|knive)\b/i.test(normalizedMessage)
    || /[刀锅鍋盘盤碗杯勺叉]/u.test(normalizedMessage)
    || skuPattern.test(normalizedMessage)
    || /^\d{4,}$/.test(simple)
    || /^(i want|i need|i'm looking for|im looking for|looking for|do you sell|do u sell|do you guys sell|do u guys sell|do you have|do u have|can i get|got any|find me|show me)\b/.test(simple);
}

export function productCategory(message: string) {
  const normalizedMessage = normalizeCommonProductTypos(message);
  if (/^\s*pot\s+(?:inner(?:[ -]?rim)?\s+)?(?:diameter|measurements?|dimensions?|brand\s*\/\s*model|brand|model)\s*:/i.test(normalizedMessage)) {
    return null;
  }
  if (/\b(?:strainers?|colanders?|baskets?|inserts?)\b[^.!?;]{0,50}\bfor\b[^.!?;]{0,35}\b(?:stock\s*)?pots?\b/i.test(normalizedMessage)) return "strainer";
  if (/\b(?:lids?|covers?)\b[^.!?;]{0,65}\b(?:notch|slot|cut[ -]?out)\b[^.!?;]{0,40}\b(?:for\s+)?(?:a\s+)?ladle\b/i.test(normalizedMessage)) return "lid";
  if (isExistingPotStrainerRequest(normalizedMessage)) return "strainer";
  if (isCookedNoodleDrainingIntent(normalizedMessage)) return "strainer";
  const matches = productCategories.filter((category) => category.pattern.test(normalizedMessage));
  if (matches.length > 1 && /\b(?:forget|never\s*mind|instead|switch|change|replace)\b/i.test(normalizedMessage)) {
    return matches.at(-1)?.label ?? null;
  }
  return matches[0]?.label ?? null;
}

/**
 * Returns the category the customer is positively asking for when a sentence
 * also rejects an old item (for example, "not this pan, need toaster").
 * This keeps a negated displayed card from winning merely because its noun
 * appears earlier in the sentence.
 */
export function requestedProductCategory(message: string) {
  const normalized = normalizeCommonProductTypos(message);
  if (/\b(?:strainers?|colanders?|baskets?|inserts?)\b[^.!?;]{0,50}\bfor\b[^.!?;]{0,35}\b(?:stock\s*)?pots?\b/i.test(normalized)) return "strainer";
  if (/\b(?:lids?|covers?)\b[^.!?;]{0,65}\b(?:notch|slot|cut[ -]?out)\b[^.!?;]{0,40}\b(?:for\s+)?(?:a\s+)?ladle\b/i.test(normalized)) return "lid";
  const rejectedProduct = "(?:gas\\s+)?cartridges?|(?:frying\\s+)?pans?|(?:stock\\s*)?pots?|strainers?|colanders?|baskets?|inserts?|toasters?|kn(?:ife|ives)|lids?|covers?|blenders?|trolleys?|ladders?|shoes?|glasses?|plates?|woks?";
  const affirmative = normalized
    .replace(new RegExp(`(?:[,;.]\\s*)?\\b(?:(?:do\\s+not|don['’]?t|dont|no\\s+longer)\\s+(?:want|need|take|choose|select|buy|order|get)|wrong|not|no|without|instead\\s+of|rather\\s+than|never\\s*mind)\\s+(?:this\\s+|that\\s+|the\\s+|a\\s+|an\\s+|any\\s+)?(?:(?!(?:need|want|find|show|buy|order|get|give|add|but)\\b)[a-z0-9]+(?:[./-][a-z0-9]+)*\\s+){0,4}?(?:${rejectedProduct})\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  const cues = [...affirmative.matchAll(/\b(?:need(?:s)?|want|looking(?:\s+for)?|find|show|buy|order|get|give(?:\s+me)?|add|prefer|switch(?:ing)?\s+to|change(?:\s+it)?\s+to|replace(?:\s+it)?\s+with|but)\b/gi)];
  let sawNegatedCue = false;

  for (const cue of cues.reverse()) {
    const index = cue.index ?? 0;
    const before = affirmative.slice(Math.max(0, index - 18), index);
    if (/\b(?:do\s+not|don['’]?t|dont|no\s+longer|not)\s*$/i.test(before)) {
      sawNegatedCue = true;
      continue;
    }
    const category = productCategory(affirmative.slice(index + cue[0].length));
    if (category) return category;
  }

  if (/\bburner\s+(?:heads?|attachments?)\b/i.test(affirmative)) return "gas torch burner";
  if (sawNegatedCue && /\b(?:do\s+not|don['’]?t|dont|no\s+longer|not)\b/i.test(normalized)) return null;
  return productCategory(affirmative) ?? productCategory(normalized);
}

/**
 * Detects a customer explicitly rejecting the product currently in focus.
 * Attribute negation such as "not too large" is deliberately excluded: the
 * negative word must point to the item itself or immediately name a product.
 */
export function rejectsCurrentProductReference(message: string) {
  const normalized = normalizeCommonProductTypos(message);
  const product = "(?:gas\\s+)?cartridges?|(?:frying\\s+)?pans?|(?:stock\\s*)?pots?|strainers?|colanders?|baskets?|inserts?|toasters?|kn(?:ife|ives)|lids?|covers?|blenders?|trolleys?|ladders?|shoes?|glasses?|plates?|woks?";
  const rejectsPronoun = /\b(?:(?:do\s+not|don['’]?t|dont|no\s+longer)\s+(?:want|need|take|choose|select|buy|order|get)\s+|(?:not|wrong|never\s*mind|forget)\s+)(?:this|that|it|the\s+one)\b/i.test(normalized);
  const rejectsNamedProduct = new RegExp(`\\b(?:(?:do\\s+not|don['’]?t|dont|no\\s+longer)\\s+(?:want|need|take|choose|select|buy|order|get)|not|no|wrong|without|instead\\s+of|rather\\s+than|never\\s*mind|forget)\\s+(?:this\\s+|that\\s+|the\\s+|a\\s+|an\\s+|any\\s+)?(?:[a-z0-9]+(?:[./-][a-z0-9]+)*\\s+){0,4}?(?:${product})\\b`, "i").test(normalized);
  const rejectsProductCode = /\b(?:not|wrong|instead\s+of|rather\s+than|never\s*mind|forget)\s+(?:code\s*[:#-]?\s*)?(?=[a-z0-9./-]*\d)[a-z0-9]+(?:[./-][a-z0-9]+)+\b/i.test(normalized);
  return rejectsPronoun || rejectsNamedProduct || rejectsProductCode;
}

/**
 * Pulls an explicitly named knife brand from natural customer phrasing while
 * ignoring colour, style, quantity and conversational filler around it.
 */
export function explicitKnifeBrand(message: string) {
  const knifeMatch = /\bkn(?:ife|ives)\b/i.exec(message);
  if (!knifeMatch) return null;
  const words = (message.slice(0, knifeMatch.index).match(/[a-z][a-z0-9&'-]*/gi) ?? []).slice(-8);
  const trailingModifiers = new Set([
    "black", "blue", "boning", "bread", "brown", "chef", "damascus", "green", "grey", "gray",
    "japan", "japanese", "oyster", "paring", "plastic", "red", "silver", "stainless", "steel",
    "taiwan", "taiwanese", "white", "yellow",
  ]);
  while (words.length > 0 && trailingModifiers.has(words.at(-1)!.toLowerCase())) words.pop();
  const generic = new Set([
    "a", "an", "and", "any", "buy", "chef", "do", "five", "for", "give", "got", "have",
    "i", "in", "is", "me", "need", "of", "one", "order", "please", "show", "some", "the",
    "this", "to", "want", "with", "you", "your", "bottom", "choice", "confirm", "does", "exact",
    "above", "below", "current", "displayed", "existing", "first", "fourth", "item", "last", "model",
    "my", "new", "no", "number", "old", "option", "our", "previous", "same", "second", "selected",
    "shown", "stock", "third", "top",
  ]);
  const candidate = words.at(-1) ?? null;
  return candidate && !generic.has(candidate.toLowerCase()) && !/^\d/.test(candidate) ? candidate : null;
}

const assistantClarificationPattern = /\?|\b(?:acceptable|choose(?:\s+\d+\s+or\s+\d+)?|would (?:that|this|it) work|do you prefer|which (?:one|type|size|material)|what (?:kind|type|size|material)|is (?:that|this|it) (?:okay|ok|fine))\b/i;

/**
 * Keeps a short customer follow-up attached to Claire's latest catalogue
 * clarification. This is intentionally limited to the most recent assistant
 * question so older product cards cannot introduce unrelated categories.
 */
export function catalogueHistoryWithClarification(message: string, history: HistoryItem[]) {
  const userHistory = history
    .filter((item) => item.role === "user")
    .map((item) => item.content);
  const words = simplifyMessage(message).split(" ").filter(Boolean);
  const latestTurn = history.at(-1);
  const currentCategory = requestedProductCategory(message);
  const latestAssistantCategory = latestTurn?.role === "assistant"
    ? productCategory(latestTurn.content)
    : null;
  const hasNumberedComparisonReference = /\b(?:item|option|model|row)\s*#?\s*\d+\b/i.test(message);
  // Customers commonly add natural buying or quantity words around a choice
  // ("I want item 2, need 2"). Keep that choice attached to the immediately
  // preceding comparison, while a newly named product category still starts a
  // fresh search instead of reviving unrelated assistant context.
  const isNumberedComparisonSelection = hasNumberedComparisonReference
    && (currentCategory === null || currentCategory === latestAssistantCategory);

  if (!isNumberedComparisonSelection
    && (currentCategory || isCatalogueRequest(message) || words.length > 16)) {
    return userHistory;
  }

  // Only the assistant turn immediately before the customer's follow-up may
  // supply clarification context. Searching farther back can revive a stale
  // product after the customer has already switched enquiries (for example,
  // an old knife question overriding the current wok search).
  const latestClarification = latestTurn?.role === "assistant"
    && productCategory(latestTurn.content) !== null
    && assistantClarificationPattern.test(latestTurn.content)
    ? latestTurn
    : null;

  return latestClarification
    ? [...userHistory, latestClarification.content]
    : userHistory;
}

const explicitShoeSizePattern = /\b(?:(?:eu|euro|uk|us)\s*(?:size\s*)?\d{1,2}(?:\.5)?|size\s*\d{1,2}(?:\.5)?)\b/i;
const shoeStylePattern = /\b(slip[ -]?on|lace[ -]?up|loafer|sneaker|work shoe|safety shoe|show both|both styles?)\b/i;

export function extractExplicitShoeSize(messages: string[]) {
  for (const content of [...messages].reverse()) {
    const size = content.match(explicitShoeSizePattern)?.[0];
    if (size) return size.replace(/\s+/g, " ").toUpperCase();
  }
  return null;
}

export function extractShoeStyle(messages: string[]) {
  for (const content of [...messages].reverse()) {
    const style = content.match(shoeStylePattern)?.[0]?.toLowerCase();
    if (!style) continue;
    if (/^slip/.test(style)) return "slip-on";
    if (/^lace/.test(style)) return "lace-up";
    if (/show both|both styles?/.test(style)) return "work";
    return style;
  }
  return null;
}

function excludedBrandConstraint(messages: string[]) {
  let excludedBrand: string | null = null;

  for (const content of messages) {
    const labelled = content.match(/\b(?:not|except|excluding|exclude|avoid|anything\s+but)\s+(?:the\s+)?([a-z0-9&'-]+(?:\s+[a-z0-9&'-]+){0,3})\s+brand\b/i)?.[1];
    if (labelled) {
      excludedBrand = labelled.trim();
      continue;
    }

    // Unlabelled brand exclusions are common in chat ("not Atlantic Chef").
    // Limit this form to title-cased multi-word names so phrases such as
    // "not conveyor" or "not red handle" are never mistaken for brands.
    const titleCased = content.match(/\b(?:not|except|excluding|exclude|avoid|anything\s+but)\s+(?:the\s+)?([A-Z][A-Za-z0-9&'-]+(?:\s+[A-Z][A-Za-z0-9&'-]+)+)/)?.[1];
    if (titleCased) {
      excludedBrand = titleCased.trim();
      continue;
    }

    // A customer can explicitly change their mind after excluding a brand.
    // Keep the exclusion for vague follow-ups, but clear it when they name the
    // same brand again with an affirmative buying cue (for example, "I need
    // that exact Atlantic Chef knife").
    if (excludedBrand) {
      const normalizedContent = content.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normalizedBrand = excludedBrand.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const reinstatesBrand = /\b(?:exact|same|want|need|show|choose|buy|use|include|allow|okay|ok|fine|go\s+with|back\s+to)\b/i.test(content);
      if (normalizedBrand && normalizedContent.includes(normalizedBrand) && reinstatesBrand) {
        excludedBrand = null;
      }
    }
  }

  return excludedBrand;
}

export function catalogueMessageWithContext(message: string, userHistory: string[]) {
  message = normalizeCommonProductTypos(message);
  userHistory = userHistory.map(normalizeCommonProductTypos);
  const previousCategory = rememberedActiveCategories(userHistory).at(-1) ?? null;
  const currentCategory = requestedProductCategory(message);
  const activeCategory = currentCategory ?? previousCategory;
  // A plainly stated new product starts a fresh catalogue search. Earlier
  // constraints from the previous item must not leak into it.
  const customerMessages = currentCategory && previousCategory && currentCategory !== previousCategory
    ? [message]
    : [...userHistory, message];
  const joinedMessages = customerMessages.join(" ");

  if (activeCategory === "knife sharpener") {
    const kind = /\b(?:whetstone|sharpening\s+stone)\b/i.test(joinedMessages)
      ? "knife sharpening stone"
      : /\b(?:honing\s+steel|sharpening\s+steel)\b/i.test(joinedMessages)
        ? "knife sharpening steel"
        : "knife sharpener";
    return kind;
  }

  if (activeCategory === "serving spoon") {
    return "serving spoon";
  }

  if (activeCategory === "cutlery set") {
    const material = /\bstainless(?:\s+steel)?\b/i.test(joinedMessages) ? "stainless steel" : null;
    return [material, "cutlery set"].filter(Boolean).join(" ");
  }

  if (activeCategory === "dining set") {
    const pax = [...customerMessages].reverse()
      .map((content) => content.match(/\b(\d+)\s*(?:pax|persons?|people)\b/i)?.[1])
      .find(Boolean) ?? null;
    return [pax ? `${pax} person` : null, "complete dining set"].filter(Boolean).join(" ");
  }

  if (activeCategory === "utensil") {
    const latestUtensilMessage = [...customerMessages].reverse()
      .find((content) => /\b(?:spatula|turner|whisk|peeler|tongs?|ladle)s?\b/i.test(content)) ?? joinedMessages;
    if (/\btongs?\b/i.test(latestUtensilMessage)) {
      const tongType = /\bsteak\b/i.test(latestUtensilMessage)
        ? "steak tong"
        : /\bcooking\b/i.test(latestUtensilMessage)
          ? "cooking tongs"
          : /\bserving\b/i.test(latestUtensilMessage)
            ? "serving tongs"
            : "tongs";
      const material = /\bstainless(?:\s+steel)?\b/i.test(joinedMessages) ? "stainless steel" : null;
      const size = latestUtensilMessage.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in|\")/i)?.[0] ?? null;
      return [material, size, tongType].filter(Boolean).join(" ");
    }
    if (/\bwhisks?\b/i.test(latestUtensilMessage)) {
      const powered = /\b(?:electric|cordless|powered|not\s+manual)\b/i.test(latestUtensilMessage);
      const threeInOne = /\b(?:3[ -]?in[ -]?1|three[ -]?in[ -]?one)\b/i.test(latestUtensilMessage);
      const blender = /\bblenders?\b/i.test(latestUtensilMessage);
      return [powered ? (/\bcordless\b/i.test(latestUtensilMessage) ? "cordless" : "electric") : null, threeInOne ? "3-in-1" : null, blender ? "blender" : null, "whisk"].filter(Boolean).join(" ");
    }
    if (/\bladles?\b/i.test(latestUtensilMessage)) {
      const material = /\bstainless(?:\s+steel)?\b/i.test(joinedMessages) ? "stainless steel" : null;
      const capacities = [...latestUtensilMessage.matchAll(/\b\d+(?:\.\d+)?\s*oz\b/gi)].map((match) => match[0]);
      const length = latestUtensilMessage.match(/\b\d+(?:\.\d+)?\s*(?:inch|inches|in|\")\b/i)?.[0]?.replace(/\"/g, " inch") ?? null;
      return [material, ...capacities, length, "ladle"].filter(Boolean).join(" ");
    }
    const specificType = latestUtensilMessage.match(/\b(?:spatula|turner|peeler)s?\b/i)?.[0];
    return specificType ?? "kitchen utensil";
  }

  if (activeCategory === "wok lid") {
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    return [size, "wok lid"].filter(Boolean).join(" ");
  }

  if (activeCategory === "lid") {
    const source = [...customerMessages].reverse().find((content) => /\b(?:lids?|covers?)\b/i.test(content)) ?? message;
    const fraction = source.match(/\b1\s*\/\s*(?:2|4)\b/)?.[0]?.replace(/\s+/g, "") ?? null;
    const material = /\b(?:s\/s|stainless(?:\s+steel)?)\b/i.test(source) ? "stainless steel" : null;
    const slotted = /\b(?:notch|slot|cut[ -]?out)\b/i.test(source) ? "slotted" : null;
    return [material, fraction, slotted, fraction ? "GN food pan lid" : "replacement lid"].filter(Boolean).join(" ");
  }

  if (activeCategory === "blender") {
    const commercial = /\b(commercial|restaurant|juice\s+shop|outlets?|high[ -]?volume|heavy[ -]?duty)\b/i.test(joinedMessages);
    const useCase = /\b(juice|smoothie|frozen\s+drink|beverage)\b/i.test(joinedMessages)
      ? "juice smoothie"
      : null;
    const budget = [...customerMessages].reverse()
      .map((content) => content.match(/(?:below|under|less\s+than|up\s+to|budget(?:\s+of)?)\s*\$?\s*(\d+(?:\.\d+)?)/i)?.[1])
      .find(Boolean);
    return [commercial ? "commercial blender" : "blender", useCase, budget ? `under $${budget}` : null].filter(Boolean).join(" ");
  }

  if (activeCategory === "strainer") {
    const handheld = /\b(hand[ -]?held|skimmer)\b/i.test(joinedMessages) ? "handheld" : null;
    const mesh = /\b(fine[ -]?mesh|fine mesh)\b/i.test(joinedMessages) ? "fine mesh" : null;
    const existingPotInsert = customerMessages.some(isExistingPotStrainerRequest)
      || /\b(?:strainer|colander|basket|insert)\s+only\b|\bonly\s+(?:need|want|buy|order)\b[^.!?]{0,28}\b(?:strainer|colander|basket|insert)\b/i.test(joinedMessages);
    const foodDraining = existingPotInsert
      || /\b(noodles?|noodal|noodel|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i.test(joinedMessages);
    const materialSource = [...customerMessages].reverse().find((content) =>
      /\b(?:stainless(?: steel)?|plastic|bamboo)\b/i.test(content),
    ) ?? "";
    const materials = [
      /\bstainless(?: steel)?\b/i.test(materialSource) ? "stainless steel" : null,
      /\bplastic\b/i.test(materialSource) ? "plastic" : null,
      /\bbamboo\b/i.test(materialSource) ? "bamboo" : null,
    ].filter(Boolean).join(" ");
    const compatibilitySource = [...customerMessages].reverse().find((content) => {
      const dimensions = extractPotFitMeasurements(content);
      return dimensions.innerDiameter !== null
        || dimensions.usableDepth !== null
        || /\bpot\s+(?:brand\s*\/\s*model|brand|model)\s*:/i.test(content);
    }) ?? "";
    const potMeasurements = extractPotFitMeasurements(compatibilitySource);
    const measurements = [potMeasurements.innerDiameter, potMeasurements.usableDepth]
      .filter(Boolean)
      .join(" x ");
    const potModel = compatibilitySource.match(/\bpot\s+(?:brand\s*\/\s*model|brand|model)\s*:\s*([a-z0-9][a-z0-9 ./_-]{1,40})/i)?.[1]?.trim() ?? null;
    return [
      handheld,
      mesh,
      materials || null,
      foodDraining ? "noodle strainer colander" : "strainer skimmer",
      measurements ? `for pot ${measurements}` : null,
      potModel ? `pot model ${potModel}` : null,
    ].filter(Boolean).join(" ");
  }

  if (activeCategory === "tableware") {
    if (/\bbanana\s+leaf\s+plates?\b/i.test(joinedMessages)) return "banana leaf plate";
    if (productCategory(message) === "tableware" && /\b(?:plate|plates|platter|platters)\b/i.test(message)) {
      if (/\b(?:sorry|actually|make\s+that|change(?:\s+it)?\s+to|no[,.\s]+wait|forget|instead|switch|never\s*mind)\b/i.test(message)) {
        const colour = [...message.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[0] ?? null;
        const size = [...message.matchAll(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/gi)].at(-1)?.[0] ?? null;
        const shape = [...message.matchAll(/\b(round|square|rectangular|rectangle|oval)\b/gi)].at(-1)?.[0] ?? null;
        const purpose = /\bdinner\b/i.test(message) ? "dinner" : null;
        return [colour, size, shape, purpose, "plate tableware"].filter(Boolean).join(" ");
      }
    }
    const fineDining = /\b(fine\s+dining)\b/i.test(joinedMessages) ? "fine dining" : null;
    const commercial = /\b(commercial|restaurant)\b/i.test(joinedMessages) ? "commercial" : null;
    const colourSource = [...customerMessages].reverse().find((content) =>
      /\b(?:red|yellow|blue|black|white|green|silver|grey|gray|brown)\b|\bdark\s+colou?r\b|\b(?:any|no\s+preference\s+for)\s+colou?r\b/i.test(content),
    ) ?? "";
    const colour = /\b(?:any|no\s+preference\s+for)\s+colou?r\b/i.test(colourSource)
      ? null
      : /\bdark\s+colou?r\b/i.test(colourSource)
        ? "dark colour"
        : [...colourSource.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[0] ?? null;
    const sizeSource = [...customerMessages].reverse().find((content) =>
      /\b(?:any\s+size|no\s+size\s+preference)\b|\b\d+(?:\.\d+)?\s*(?:-|to|through)\s*\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b|\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i.test(content),
    ) ?? "";
    const size = /\b(?:any\s+size|no\s+size\s+preference)\b/i.test(sizeSource)
      ? null
      : sizeSource.match(/\b\d+(?:\.\d+)?\s*(?:-|to|through)\s*\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i)?.[0]
        ?? sizeSource.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i)?.[0]
        ?? null;
    const shape = [...customerMessages].reverse()
      .map((content) => [...content.matchAll(/\b(round|square|rectangular|rectangle|oval)\b/gi)].at(-1)?.[0])
      .find(Boolean) ?? null;
    const purpose = /\bdinner\b/i.test(joinedMessages) ? "dinner" : null;
    return [fineDining, commercial, colour, size, shape, purpose, "plate tableware"].filter(Boolean).join(" ");
  }

  if (activeCategory === "trolley") {
    return /\b(?:gn|gastronorm|1\/2\s*gn|tray)\b/i.test(joinedMessages)
      ? "GN tray trolley"
      : "commercial trolley";
  }

  if (activeCategory === "toaster") {
    const latestSlotRequest = [...customerMessages].reverse()
      .find((content) => /\b(?:(?:\d+|four|six)\s+or\s+(?:\d+|four|six)|(?:\d+|four|six))\s*[ -]?slots?\b/i.test(content)) ?? "";
    const slotNumber = (value: string | undefined) => value
      ? ({ four: "4", six: "6" }[value.toLowerCase()] ?? value)
      : null;
    const slotChoice = latestSlotRequest.match(/\b(\d+|four|six)\s+or\s+(\d+|four|six)\s*[ -]?slots?\b/i);
    const latestSlotCount = slotNumber(latestSlotRequest.match(/\b(\d+|four|six)\s*[ -]?slots?\b/i)?.[1]);
    const slotRequirement = slotChoice
      ? `${slotNumber(slotChoice[1])} or ${slotNumber(slotChoice[2])} slot`
      : latestSlotCount
        ? `${latestSlotCount}-slot`
        : null;
    const isPopUp = /\b(?:non[ -]?conveyor|not\s+(?:a\s+)?conveyor|no\s+conveyor(?:\s+type)?|without\s+(?:a\s+)?conveyor|(?:no|not|without)\s+(?:a\s+)?belt(?:\s+type)?|belt\s+type\s+(?:no|not)|don['’]?t\s+want\s+(?:a\s+)?(?:conveyor|convertor)|do\s+not\s+want\s+(?:a\s+)?(?:conveyor|convertor)|ya\s+kun|pop[ -]?up|(?:\d+|four|six)(?:\s+or\s+(?:\d+|four|six))?\s*slots?)\b/i.test(joinedMessages);
    return [slotRequirement, isPopUp ? "commercial pop-up toaster" : "commercial toaster"]
      .filter(Boolean)
      .join(" ");
  }

  if (activeCategory === "beverage dispenser") {
    const brand = /\bcambro\b/i.test(joinedMessages) ? "Cambro" : null;
    const insulated = /\binsulated\b/i.test(joinedMessages) ? "insulated" : null;
    const colour = [...customerMessages].reverse()
      .map((content) => content.match(/\b(?:black|white|grey|gray|brown|blue|red|green)\b/i)?.[0])
      .find(Boolean) ?? null;
    const capacity = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\b/i)?.[0])
      .find(Boolean) ?? null;
    return [brand, insulated, colour, capacity, "beverage dispenser Camtainer"].filter(Boolean).join(" ");
  }

  if (activeCategory === "utility box") {
    const latestMatching = (pattern: RegExp) => [...customerMessages].reverse()
      .map((content) => content.match(pattern)?.[0])
      .find(Boolean) ?? null;
    const colour = latestMatching(/\b(?:black|white|grey|gray|brown|blue|red)\b/i);
    const shape = latestMatching(/\b(?:rectangular|rectangle|square)\b/i);
    const material = latestMatching(/\b(?:plastic|polyethylene)\b/i);
    const dimensions = latestMatching(/\b\d+(?:\.\d+)?\s*(?:x|by|×)\s*\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i);
    return [colour, shape, material, "utility box Cambox storage box", dimensions].filter(Boolean).join(" ");
  }

  if (activeCategory === "ladder") {
    const steps = joinedMessages.match(/\b(\d+)\s*[ -]?steps?\b/i)?.[1] ?? null;
    const loadCapacity = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:lb|lbs|pounds?|kg)\b/i)?.[0])
      .find(Boolean) ?? null;
    const colour = [...customerMessages].reverse()
      .map((content) => content.match(/\b(?:grey|gray|black|white|blue|red|silver)\b/i)?.[0])
      .find(Boolean) ?? null;
    const reference = /\bCOSCO\b/i.test(joinedMessages)
      ? `COSCO${joinedMessages.match(/\b11839[A-Z0-9-]*\b/i)?.[0] ? ` ${joinedMessages.match(/\b11839[A-Z0-9-]*\b/i)?.[0]}` : ""}`
      : null;
    const handrail = /\b(?:safety\s+)?handrail\b/i.test(joinedMessages) ? "safety handrail" : null;
    const material = /\b(?:not|no|don['’]?t|do\s+not|must\s+not)\b[^.!?]{0,45}\b(?:all\s+)?(?:aluminium|aluminum|alum)\b/i.test(joinedMessages)
      ? "not all aluminium"
      : null;
    return [
      steps ? `${steps} step` : null,
      /\bfolding\b/i.test(joinedMessages) ? "folding" : null,
      handrail,
      loadCapacity,
      colour,
      reference,
      material,
      "stool ladder",
    ].filter(Boolean).join(" ");
  }

  if (activeCategory === "shot glass") {
    return [/\bpolycarbonate\b/i.test(joinedMessages) ? "polycarbonate" : null, "shot glass"].filter(Boolean).join(" ");
  }

  if (activeCategory === "gas torch burner") {
    const latestBrand = [...customerMessages].reverse()
      .map((content) => content.match(/\b(?:iwatani?|safico(?:\s+pro)?)\b/i)?.[0])
      .find(Boolean) ?? null;
    const normalizedBrand = latestBrand && /\biwatani?\b/i.test(latestBrand) ? "Iwatani" : latestBrand;
    return [normalizedBrand, "gas torch burner"].filter(Boolean).join(" ");
  }
  if (activeCategory === "gas cartridge") return "gas cartridge";
  if (activeCategory === "cleaning sponge") return "scrub sponge";
  if (activeCategory === "paper towel") return "kitchen paper towel";
  if (activeCategory === "glove") return "glove";
  if (activeCategory === "rice dispenser") {
    const models = resolveRiceDispenserModels(message, userHistory);
    return [...models, "rice dispenser"].join(" ");
  }

  if (activeCategory === "knife") {
    const latestDamascusIndex = customerMessages.findLastIndex((content) => /\bdamascus\b/i.test(content));
    const latestOriginIndex = customerMessages.findLastIndex((content) => /\b(?:japan|japanese|taiwan|taiwanese)\b/i.test(content));
    // A later origin refinement replaces an earlier Damascus requirement. This
    // prevents a short follow-up such as "show a few" from reviving a stale
    // constraint that the customer already changed.
    const damascus = latestDamascusIndex >= 0 && latestDamascusIndex >= latestOriginIndex
      ? "damascus"
      : null;
    const latestKnifeType = [
      { index: customerMessages.findLastIndex((content) => /\bcleavers?\b/i.test(content) || /砍骨刀|中式[^。,.!?]*刀/u.test(content)), label: "cleaver" },
      { index: customerMessages.findLastIndex((content) => /\bchef(?:'s)?\s+knif|chef\s+knives\b/i.test(content)), label: "chef knife" },
      { index: customerMessages.findLastIndex((content) => /\bbread\s+kn(?:ife|ives)\b/i.test(content)), label: "bread knife" },
      { index: customerMessages.findLastIndex((content) => /\bboning\s+kn(?:ife|ives)\b/i.test(content)), label: "boning knife" },
      { index: customerMessages.findLastIndex((content) => /\bparing\s+kn(?:ife|ives)\b/i.test(content)), label: "paring knife" },
      { index: customerMessages.findLastIndex((content) => /\boyster\s+kn(?:ife|ives)\b/i.test(content)), label: "oyster knife" },
    ].filter((candidate) => candidate.index >= 0).sort((left, right) => right.index - left.index)[0]?.label ?? "knife";
    const originSource = latestOriginIndex >= 0 ? customerMessages[latestOriginIndex] : "";
    const origin = /\b(?:japan|japanese)\b/i.test(originSource)
      ? "japanese"
      : /\b(?:taiwan|taiwanese)\b/i.test(originSource)
        ? "taiwanese"
        : null;
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    const colourSource = [...customerMessages].reverse().find((content) =>
      /\b(?:red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/i.test(content),
    ) ?? "";
    const colour = [...colourSource.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[0] ?? null;
    const excludedBrand = excludedBrandConstraint(customerMessages);
    const handleMaterial = [...customerMessages].reverse().some((content) => /\bplastic\s+handles?\b/i.test(content))
      ? "plastic handle"
      : null;
    return [
      damascus,
      origin,
      latestKnifeType,
      size,
      colour ? `${colour} handle` : null,
      handleMaterial,
      excludedBrand ? `excluding brand ${excludedBrand}` : null,
    ].filter(Boolean).join(" ");
  }

  if (activeCategory === "wok") {
    const latestSizeIndex = customerMessages.findLastIndex((content) => /\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i.test(content));
    const latestSizeSource = latestSizeIndex >= 0 ? customerMessages[latestSizeIndex] : "";
    const removesLatestSize = latestSizeIndex >= 0
      && /\b(?:forget|ignore|remove|without|no longer|don'?t need|do not need)\b/i.test(latestSizeSource);
    const size = removesLatestSize
      ? null
      : latestSizeSource.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0] ?? null;
    const materialSource = [...customerMessages].reverse().find((content) =>
      /\b(?:carbon\s+steel|stainless\s+steel|cast\s+iron|iron|aluminium|aluminum)\b/i.test(content),
    ) ?? "";
    const materials = [
      /\bcarbon\s+steel\b/i.test(materialSource) ? "carbon steel" : null,
      /\bcast\s+iron\b/i.test(materialSource) ? "cast iron" : null,
      /\biron\b/i.test(materialSource) && !/\bcast\s+iron\b/i.test(materialSource) ? "iron" : null,
      /\bstainless\s+steel\b/i.test(materialSource) ? "stainless steel" : null,
      /\baluminium|aluminum\b/i.test(materialSource) ? "aluminium" : null,
    ].filter(Boolean).join(" or ");
    const closest = size && /\b(?:around|about|approximately|approx|closest|near(?:est)?)\b/i.test(latestSizeSource)
      ? "closest size"
      : null;
    return [materials || null, size, closest, "wok"].filter(Boolean).join(" ");
  }

  if (activeCategory === "pan") {
    const latestPanTypeIndex = customerMessages.findLastIndex((content) =>
      /\b(?:fry(?:ing)?\s*pan|skillet|omele+t+e?\s*pan|crepe\s*pan|pancake\s*pan|grill\s*pan|sauce\s*pan|saucepan|gn\s*pan|gastronorm\s*pan|food\s*pan)\b/i.test(content),
    );
    const panTypeSource = latestPanTypeIndex >= 0 ? customerMessages[latestPanTypeIndex] : "";
    const panType = /\b(?:gn\s*pan|gastronorm\s*pan|food\s*pan)\b/i.test(panTypeSource)
      ? "GN food pan"
      : /\b(?:omele+t+e?)\s*pan\b/i.test(panTypeSource)
        ? "omelette pan"
        : /\bcrepe\s*pan\b/i.test(panTypeSource)
          ? "crepe pan"
          : /\bpancake\s*pan\b/i.test(panTypeSource)
            ? "pancake pan"
            : /\bgrill\s*pan\b/i.test(panTypeSource)
              ? "grill pan"
              : /\b(?:sauce\s*pan|saucepan)\b/i.test(panTypeSource)
                ? "saucepan"
                : /\b(?:fry(?:ing)?\s*pan|skillet)\b/i.test(panTypeSource)
                  ? "frying pan"
                  : null;
    const materialSource = [...customerMessages].reverse().find((content) =>
      /\b(?:stainless(?:\s+steel)?|black\s+steel|carbon\s+steel|cast\s+iron|iron|aluminium|aluminum|non[ -]?stick|steel)\b/i.test(content),
    ) ?? "";
    const material = /\bblack\s+steel\b/i.test(materialSource)
      ? "black steel"
      : /\bcarbon\s+steel\b/i.test(materialSource)
        ? "carbon steel"
        : /\bcast\s+iron\b/i.test(materialSource)
          ? "cast iron"
          : /\baluminium|aluminum\b/i.test(materialSource)
            ? "aluminium"
            : /\bnon[ -]?stick\b/i.test(materialSource)
              ? "non-stick"
              : /\bstainless(?:\s+steel)?\b|\bsteel\b/i.test(materialSource)
                ? "stainless steel"
                : null;
    const latestSizeIndex = customerMessages.findLastIndex((content) =>
      /\b(?:any\s+size|no\s+size\s+preference)\b|\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i.test(content),
    );
    const latestSizeSource = latestSizeIndex >= 0 ? customerMessages[latestSizeIndex] : "";
    const size = /\b(?:any\s+size|no\s+size\s+preference)\b/i.test(latestSizeSource)
      ? null
      : latestSizeSource.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0] ?? null;
    const colour = [...customerMessages].reverse()
      .map((content) => [...content.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[0])
      .find(Boolean) ?? null;
    const foodPanSource = [...customerMessages].reverse().find((content) =>
      /\b(?:gn|gastronorm|food)\s*pan\b/i.test(content)
      || (/\b1\s*\/\s*(?:2|4)\b/.test(content) && /\bpans?\b/i.test(content) && /\bdeep\b/i.test(content)),
    ) ?? "";
    const foodPanFraction = foodPanSource.match(/\b1\s*\/\s*(?:2|4)\b/)?.[0]?.replace(/\s+/g, "") ?? null;
    const foodPanDepth = foodPanSource.match(/\b\d+(?:\.\d+)?\s*(?:inch|inches|in|\")\s*deep\b/i)?.[0]?.replace(/\"/g, " inch") ?? null;
    const isGnFoodPan = Boolean(foodPanSource);
    // "Steel pan" is commonly used for cookware in customer chat. Unless the
    // customer explicitly asks for a GN/food pan, keep the request in the
    // frying-pan family so a storage/steam-table pan is never substituted.
    const resolvedPanType = isGnFoodPan ? "GN food pan" : panType ?? (material ? "frying pan" : "pan");
    return [material, colour, foodPanFraction, foodPanDepth, isGnFoodPan ? null : size, resolvedPanType].filter(Boolean).join(" ");
  }

  if (activeCategory === "chef pants") {
    return /\b(?:pants|trousers)\b/i.test(message) ? message : `chef pants ${message}`;
  }
  if (activeCategory === "shoe") {
    const size = extractExplicitShoeSize(customerMessages);
    const style = extractShoeStyle(customerMessages);
    return ["shoe", style ?? "work", size].filter(Boolean).join(" ");
  }

  if (activeCategory === "water dispenser") {
    let capacity: string | null = null;
    let placement: string | null = null;
    let temperature: string | null = null;

    for (const content of customerMessages) {
      capacity = content.match(/\b\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\b/i)?.[0] ?? capacity;
      if (/\b(?:free[ -]?standing|floor[ -]?standing)\b/i.test(content)) placement = "freestanding";
      if (/\bcounter[ -]?top\b/i.test(content)) placement = "countertop";
      if (/\bhot\b[\s\S]*\bcold\b|\bcold\b[\s\S]*\bhot\b|\bhot\s*[/&+]\s*cold\b/i.test(content)) {
        temperature = "hot cold";
      } else if (/\broom[ -]?temperature\b/i.test(content)) {
        temperature = "room temperature";
      }
    }

    return ["water dispenser", capacity, placement, temperature].filter(Boolean).join(" ");
  }

  if (activeCategory === "pot" && /\b\d+(?:\.\d+)?\s*(?:qt|quarts?)\b/i.test(joinedMessages)) {
    const capacity = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:qt|quarts?)\b/i)?.[0])
      .find(Boolean) ?? null;
    const material = /\bstainless(?:\s+steel)?\b/i.test(joinedMessages) ? "stainless steel" : null;
    return [material, capacity, "stockpot"].filter(Boolean).join(" ");
  }

  if (activeCategory === "coffee grinder") {
    const quantity = customerMessages
      .map((content) => content.match(/\b(\d+)\s*(?:pieces?|pcs?|units?)?\s*(?:coffee\s+)?grinders?\b/i)?.[1])
      .filter(Boolean)
      .at(-1);
    return ["coffee grinder", quantity ? `${quantity} pieces` : null, message].filter(Boolean).join(" ");
  }

  if (customerMessages.some((content) => /\b(?:stockpot|stockpots|stock\s+pots?)\b/i.test(content))) {
    const capacity = customerMessages
      .map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\b/i)?.[0])
      .filter(Boolean)
      .at(-1);
    return ["stockpot", capacity, message].filter(Boolean).join(" ");
  }

  if (productCategory(message)) return message;

  const isProductRefinement = /\b(?:no\s+preference|any\s+material|red|yellow|blue|black|white|green|silver|grey|gray|brown|round|square|oval|dinner|side|salad|dessert|ceramic|porcelain|melamine|plastic|stainless|small|medium|large|cheap|cheapest|budget|below|under|commercial|restaurant|fine\s+dining|hand[ -]?held|fine[ -]?mesh)\b|\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|in|pieces?|pcs?)?\b/i.test(message);
  if (!isProductRefinement) return message;

  const rememberedCategory = rememberedActiveCategories(userHistory).at(-1);
  const catalogueTerm = rememberedCategory === "tableware"
    ? "plate"
    : rememberedCategory === "coffee product"
      ? "coffee"
      : rememberedCategory;
  return catalogueTerm ? `${catalogueTerm} ${message}` : message;
}

export function rememberedPurpose(messages: string[]) {
  const isChickenTask = (message: string) =>
    /\b(chicken|poultry)\b/i.test(message)
    && /\b(cut|cutting|chop|chopping|prepare|preparing)\b/i.test(message);

  return messages.some(isChickenTask) ? "cutting chicken" : null;
}

/**
 * Replays category mentions so "switch" replaces the active item while
 * "also" or "both" adds another item. This keeps current state separate from
 * the customer's original purpose without requiring browser-side persistence.
 */
export function rememberedActiveCategories(messages: string[]) {
  let active: string[] = [];

  for (const content of messages) {
    let categories = productCategories
      .filter((category) => category.pattern.test(content))
      .map((category) => category.label);
    const positivelyRequested = requestedProductCategory(content);
    if (positivelyRequested
      && /\b(?:not|wrong|instead|rather\s+than|meant|switch|change|replace|but)\b/i.test(content)) {
      categories = [positivelyRequested];
    }
    if (categories.length === 0) {
      const inferredCategory = productCategory(content);
      if (inferredCategory) categories = [inferredCategory];
    }
    if (["knife sharpener", "wok lid", "shot glass", "stockpot", "rice dispenser", "trolley"].includes(categories[0] ?? "")) {
      categories = [categories[0]];
    }

    if (categories.length === 0) continue;
    if (/\b(switch|change|replace|instead|only)\b/i.test(content)) {
      active = [categories.at(-1)!];
    } else if (/\b(add|also|too|as well|both)\b/i.test(content)) {
      active = [...new Set([...active, ...categories])];
    } else {
      // A new unqualified product request replaces the prior active search.
      // The original request is still available from the full history, but it
      // must not control the next catalogue lookup.
      active = [...new Set(categories)];
    }
  }

  return active;
}

export function createFastReply(message: string, suggestions: string[], stage: ChatStage = "discover"): FastReply {
  return {
    message: normalizeClaireMessage(message),
    stage,
    products: [],
    selectedProduct: null,
    suggestions,
  };
}
