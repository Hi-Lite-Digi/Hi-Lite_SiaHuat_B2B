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

export const productWords = /\b(knife|knives|chef|damascus|sharpener|sharpeners|sharpening|whetstone|honing|cutlery|utensil|utensils|spatula|spatulas|turner|turners|whisk|whisks|peeler|peelers|tong|tongs|fork|spoon|scoop|strainer|skimmer|colander|plate|bowl|glass|glassware|cup|mug|pan|wok|woks|lid|cover|pot|pots|stockpot|stockpots|cookware|tableware|barware|buffet|catering|kitchen|serving|rice|tray|trolley|blender|blenders|coffee|bean|grinder|grinders|tea|shoe|shoes|shows|footwear|pants|trousers|uniform|apparel|dispenser|urn|boiler|airpot|sku|product|item|brand|price|cost|stock|available|availability|quantity|qty|quote|order|buy|cart)\b/i;
export const skuPattern = /\b[a-z0-9]+(?:[-/][a-z0-9]+)+\b/i;

export const productCategories = [
  { pattern: /\b(?:knife\s+)?(?:sharpeners?|sharpening\s+(?:stone|steel)|whetstone|honing\s+steel)\b/i, label: "knife sharpener" },
  { pattern: /\b(knife|knives|cleaver|boning knife|paring knife)\b|砍骨刀|菜刀|刀/u, label: "knife" },
  { pattern: /\bserving\s+spoons?\b/i, label: "serving spoon" },
  { pattern: /\b(cutlery|flatware)(?:\s+sets?)?\b|\bspoons?\b[\s\S]*\bforks?\b|\bforks?\b[\s\S]*\bspoons?\b/i, label: "cutlery set" },
  { pattern: /\b(?:kitchen\s+)?utensils?\b|\b(?:spatulas?|turners?|whisks?|peelers?|tongs?)\b/i, label: "utensil" },
  { pattern: /\bwok\s+(?:lid|cover)s?\b|\b(?:lid|cover)s?\s+(?:for\s+)?(?:a\s+)?wok\b/i, label: "wok lid" },
  { pattern: /\b(wok|woks)\b/i, label: "wok" },
  { pattern: /\b(pan|pans|skillet)\b/i, label: "pan" },
  { pattern: /\b(stockpot|stockpots|stock\s+pot|stock\s+pots)\b/i, label: "stockpot" },
  { pattern: /\b(pot|pots)\b/i, label: "pot" },
  { pattern: /\b(glass|glassware|tumbler)\b/i, label: "glassware" },
  { pattern: /\b(plate|plates|tableware)\b/i, label: "tableware" },
  { pattern: /\b(strainers?|strainners?|straners?|skimmers?|colanders?)\b/i, label: "strainer" },
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
    || /\b(?:strainners?|straners?|noodal|noodel)\b/i.test(message)
    || /[刀锅鍋盘盤碗杯勺叉]/u.test(message)
    || skuPattern.test(message)
    || /^(i want|i need|i'm looking for|im looking for|looking for|do you sell|do u sell|do you have|do u have|can i get|got any|find me|show me)\b/.test(simple);
}

export function productCategory(message: string) {
  const matches = productCategories.filter((category) => category.pattern.test(message));
  if (matches.length > 1 && /\b(?:forget|never\s*mind|instead|switch|change|replace)\b/i.test(message)) {
    return matches.at(-1)?.label ?? null;
  }
  return matches[0]?.label ?? null;
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

  // Only the assistant turn immediately before the customer's follow-up may
  // supply clarification context. Searching farther back can revive a stale
  // product after the customer has already switched enquiries (for example,
  // an old knife question overriding the current wok search).
  const latestTurn = history.at(-1);
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

  if (activeCategory === "utensil") {
    const specificType = [...customerMessages].reverse()
      .map((content) => content.match(/\b(?:spatula|turner|whisk|peeler|tongs?|ladle)s?\b/i)?.[0])
      .find(Boolean);
    return specificType ?? "kitchen utensil";
  }

  if (activeCategory === "wok lid") {
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    return [size, "wok lid"].filter(Boolean).join(" ");
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
    const foodDraining = /\b(noodles?|noodal|noodel|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i.test(joinedMessages);
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
      if (/\b(?:sorry|actually|make\s+that|change(?:\s+it)?\s+to|no[,.\s]+wait|forget|instead|switch|never\s*mind)\b/i.test(message)) {
        const colour = [...message.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[0] ?? null;
        const size = [...message.matchAll(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/gi)].at(-1)?.[0] ?? null;
        return [colour, size, "plate tableware"].filter(Boolean).join(" ");
      }
      return message;
    }
    const fineDining = /\b(fine\s+dining)\b/i.test(joinedMessages) ? "fine dining" : null;
    const commercial = /\b(commercial|restaurant)\b/i.test(joinedMessages) ? "commercial" : null;
    const colour = joinedMessages.match(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/i)?.[0] ?? null;
    const size = [...customerMessages].reverse().map((content) => content.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i)?.[0]).find(Boolean) ?? null;
    return [fineDining, commercial, colour, size, "plate tableware"].filter(Boolean).join(" ");
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
    const latestCleaverIndex = customerMessages.findLastIndex((content) => /\bcleavers?\b/i.test(content) || /砍骨刀|中式[^。,.!?]*刀/u.test(content));
    const latestChefIndex = customerMessages.findLastIndex((content) => /\bchef(?:'s)?\s+knif|chef\s+knives\b/i.test(content));
    const cleaver = latestCleaverIndex >= 0 && latestCleaverIndex >= latestChefIndex ? "cleaver" : null;
    const chef = latestChefIndex >= 0 && latestChefIndex >= latestCleaverIndex ? "chef" : null;
    const originSource = latestOriginIndex >= 0 ? customerMessages[latestOriginIndex] : "";
    const origin = /\b(?:japan|japanese)\b/i.test(originSource)
      ? "japanese"
      : /\b(?:taiwan|taiwanese)\b/i.test(originSource)
        ? "taiwanese"
        : null;
    const size = [...customerMessages].reverse()
      .map((content) => content.match(/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i)?.[0])
      .find(Boolean) ?? null;
    return [damascus, origin, cleaver ?? chef, cleaver ? null : "knife", size].filter(Boolean).join(" ");
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
    // "Steel pan" is commonly used for cookware in customer chat. Unless the
    // customer explicitly asks for a GN/food pan, keep the request in the
    // frying-pan family so a storage/steam-table pan is never substituted.
    const resolvedPanType = panType ?? (material ? "frying pan" : "pan");
    return [material, colour, size, resolvedPanType].filter(Boolean).join(" ");
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
    let categories = productCategories
      .filter((category) => category.pattern.test(content))
      .map((category) => category.label);
    if (categories[0] === "knife sharpener" || categories[0] === "wok lid") {
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

export function createFastReply(message: string, suggestions: string[]): FastReply {
  return {
    message: normalizeClaireMessage(message),
    stage: "discover",
    products: [],
    selectedProduct: null,
    suggestions,
  };
}
