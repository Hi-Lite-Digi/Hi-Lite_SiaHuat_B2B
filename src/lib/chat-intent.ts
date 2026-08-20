import type { HistoryItem } from "@/lib/chat-contract";
import { normalizeClaireMessage } from "@/lib/claire-voice";

export type FastChatInput = {
  sessionId: string;
  message: string;
  history: HistoryItem[];
};

export type FastReply = {
  message: string;
  stage: "discover";
  products: [];
  selectedProduct: null;
  suggestions: string[];
};

export const productWords = /\b(knife|knives|chef|damascus|cutlery|fork|spoon|scoop|strainer|skimmer|colander|plate|bowl|glass|glassware|cup|mug|pan|wok|woks|pot|pots|stockpot|stockpots|cookware|tableware|barware|buffet|catering|kitchen|serving|rice|tray|trolley|blender|blenders|coffee|bean|grinder|grinders|tea|shoe|shoes|shows|footwear|pants|trousers|uniform|apparel|dispenser|urn|boiler|airpot|sku|product|item|brand|price|cost|stock|available|availability|quantity|qty|quote|order|buy|cart)\b/i;
export const skuPattern = /\b[a-z0-9]+(?:[-/][a-z0-9]+)+\b/i;

export const productCategories = [
  { pattern: /\b(knife|knives|cleaver|boning knife|paring knife)\b/i, label: "knife" },
  { pattern: /\b(cutlery|flatware)(?:\s+sets?)?\b/i, label: "cutlery set" },
  { pattern: /\b(wok|woks)\b/i, label: "wok" },
  { pattern: /\b(pan|pans|skillet)\b/i, label: "pan" },
  { pattern: /\b(stockpot|stockpots|stock\s+pot|stock\s+pots)\b/i, label: "stockpot" },
  { pattern: /\b(pot|pots)\b/i, label: "pot" },
  { pattern: /\b(glass|glassware|tumbler)\b/i, label: "glassware" },
  { pattern: /\b(plate|plates|tableware)\b/i, label: "tableware" },
  { pattern: /\b(strainer|strainers|skimmer|skimmers|colander|colanders)\b/i, label: "strainer" },
  { pattern: /\b(blender|blenders|blending machine)\b/i, label: "blender" },
  { pattern: /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i, label: "coffee grinder" },
  { pattern: /\bcoffee(?:\s+beans?)?\b(?!\s*grinders?)/i, label: "coffee product" },
  { pattern: /\b(shoe|shoes|shows|footwear)\b/i, label: "shoe" },
  { pattern: /\b(?:chef\s+)?(?:pants|trousers)\b/i, label: "chef pants" },
  { pattern: /\b(?:water\s+)?(?:dispenser|urn|boiler|airpot)\b/i, label: "water dispenser" },
] as const;

export function simplifyMessage(message: string) {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCatalogueRequest(message: string) {
  const simple = message
    .toLowerCase()
    .replace(/[^a-z0-9'\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return productWords.test(message)
    || skuPattern.test(message)
    || /^(i want|i need|i'm looking for|im looking for|looking for|do you sell|do u sell|do you have|do u have|can i get|got any|find me|show me)\b/.test(simple);
}

export function productCategory(message: string) {
  return productCategories.find((category) => category.pattern.test(message))?.label ?? null;
}

const assistantClarificationPattern = /\?|\b(?:acceptable|would (?:that|this|it) work|do you prefer|which (?:one|type|size|material)|what (?:kind|type|size|material)|is (?:that|this|it) (?:okay|ok|fine))\b/i;

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

  if (productCategory(message) || isCatalogueRequest(message) || words.length > 16) {
    return userHistory;
  }

  const latestClarification = [...history].reverse().find((item) =>
    item.role === "assistant"
    && productCategory(item.content) !== null
    && assistantClarificationPattern.test(item.content),
  );

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

export function catalogueMessageWithContext(message: string, userHistory: string[]) {
  const previousCategory = rememberedActiveCategories(userHistory).at(-1) ?? null;
  const currentCategory = productCategory(message);
  const activeCategory = currentCategory ?? previousCategory;
  // A plainly stated new product starts a fresh catalogue search. Earlier
  // constraints from the previous item must not leak into it.
  const customerMessages = currentCategory && previousCategory && currentCategory !== previousCategory
    ? [message]
    : [...userHistory, message];
  const joinedMessages = customerMessages.join(" ");

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
    const foodDraining = /\b(noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i.test(joinedMessages);
    const materialSource = [...customerMessages].reverse().find((content) =>
      /\b(?:stainless(?: steel)?|plastic|bamboo)\b/i.test(content),
    ) ?? "";
    const materials = [
      /\bstainless(?: steel)?\b/i.test(materialSource) ? "stainless steel" : null,
      /\bplastic\b/i.test(materialSource) ? "plastic" : null,
      /\bbamboo\b/i.test(materialSource) ? "bamboo" : null,
    ].filter(Boolean).join(" ");
    return [handheld, mesh, materials || null, foodDraining ? "noodle strainer colander" : "strainer skimmer"].filter(Boolean).join(" ");
  }

  if (activeCategory === "tableware") {
    if (productCategory(message) === "tableware" && /\b(?:plate|plates|platter|platters)\b/i.test(message)) {
      return message;
    }
    const fineDining = /\b(fine\s+dining)\b/i.test(joinedMessages) ? "fine dining" : null;
    const commercial = /\b(commercial|restaurant)\b/i.test(joinedMessages) ? "commercial" : null;
    const colour = joinedMessages.match(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/i)?.[0] ?? null;
    const size = [...customerMessages].reverse().map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i)?.[0]).find(Boolean) ?? null;
    return [fineDining, commercial, colour, size, "plate tableware"].filter(Boolean).join(" ");
  }

  if (activeCategory === "knife") {
    const changesOrigin = /\b(?:japan|japanese|taiwan|taiwanese)\b/i.test(message);
    const damascus = /\bdamascus\b/i.test(message)
      || (!changesOrigin && /\bdamascus\b/i.test(joinedMessages))
      ? "damascus"
      : null;
    const chef = /\bchef(?:'s)?\s+knif|chef\s+knives\b/i.test(joinedMessages) ? "chef" : null;
    const origin = /\b(?:japan|japanese)\b/i.test(joinedMessages)
      ? "japanese"
      : /\b(?:taiwan|taiwanese)\b/i.test(joinedMessages)
        ? "taiwanese"
        : null;
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    return [damascus, origin, chef, "knife", size].filter(Boolean).join(" ");
  }

  if (activeCategory === "wok") {
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    const material = joinedMessages.match(/\b(?:carbon\s+steel|stainless\s+steel|cast\s+iron|aluminium|aluminum)\b/i)?.[0] ?? null;
    return [material, size, "wok"].filter(Boolean).join(" ");
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
    const categories = productCategories
      .filter((category) => category.pattern.test(content))
      .map((category) => category.label);

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

export function createFastReply(message: string, suggestions: string[]): FastReply {
  return {
    message: normalizeClaireMessage(message),
    stage: "discover",
    products: [],
    selectedProduct: null,
    suggestions,
  };
}
