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

export const productWords = /\b(knife|knives|chef|cutlery|fork|spoon|scoop|plate|bowl|glass|glassware|cup|mug|pan|pot|cookware|tableware|barware|buffet|catering|kitchen|serving|rice|tray|trolley|coffee|bean|tea|shoe|shoes|shows|footwear|sku|product|item|brand|price|cost|stock|available|availability|quantity|qty|quote|order|buy|cart)\b/i;
export const skuPattern = /\b[a-z0-9]+(?:[-/][a-z0-9]+)+\b/i;

export const productCategories = [
  { pattern: /\b(knife|knives|cleaver|boning knife|paring knife)\b/i, label: "knife" },
  { pattern: /\b(pan|pans|skillet)\b/i, label: "pan" },
  { pattern: /\b(glass|glassware|tumbler)\b/i, label: "glassware" },
  { pattern: /\b(plate|plates|tableware)\b/i, label: "tableware" },
  { pattern: /\b(coffee|coffee beans)\b/i, label: "coffee product" },
  { pattern: /\b(shoe|shoes|shows|footwear)\b/i, label: "shoe" },
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
  const customerMessages = [...userHistory, message];
  if (!customerMessages.some((content) => productCategory(content) === "shoe")) return message;

  const size = extractExplicitShoeSize(customerMessages);
  const style = extractShoeStyle(customerMessages);
  return ["shoe", style ?? "work", size].filter(Boolean).join(" ");
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
    } else if (active.length === 0) {
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
