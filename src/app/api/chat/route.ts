import { NextResponse } from "next/server";
import { chatRequestSchema, type ChatReply, type ChatRequest, type Product } from "@/lib/chat-contract";
import { sendChatToN8n } from "@/lib/n8n-client";
import {
  detectProductUseCase,
  findChefPantsCatalogue,
  findCatalogueProductByCode,
  findProductForStockCheck,
  matchesRequestedBrand,
  matchesProductUseCase,
  prioritizeBrand,
  requestedBrandLabel,
  searchCatalogue,
} from "@/lib/catalogue";
import { normalizeClaireMessage } from "@/lib/claire-voice";
import { getFastChatReply, isCatalogueRequest } from "@/lib/fast-chat";
import { catalogueHistoryWithClarification, catalogueMessageWithContext } from "@/lib/chat-intent";
import { parseRequestedQuantity, requestedDisplayedProductIndex, requestedQuantity, requestsAnotherOption } from "@/lib/chat-turn";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "@/lib/siahuat-product";

export const runtime = "nodejs";

const sessionQueues = new Map<string, Promise<void>>();
const CUSTOMER_REPLY_DEADLINE_MS = 27_000;
const EARLY_LIVE_CHECK_TIMEOUT_MS = 5_000;

function prefersChinese(input: Pick<ChatRequest, "message" | "history">) {
  if (/\p{Script=Han}/u.test(input.message)) return true;
  const recentUserMessages = input.history.filter((item) => item.role === "user").slice(-3);
  return recentUserMessages.length > 0 && /\p{Script=Han}/u.test(recentUserMessages.at(-1)?.content ?? "");
}

function chineseCustomerMessage<T extends { message: string; products?: Product[]; selectedProduct?: Product | null }>(reply: T) {
  if (/\p{Script=Han}/u.test(reply.message)) return reply.message;
  const products = reply.products ?? [];
  if (/couldn't find an exact .*water dispenser/i.test(reply.message)) {
    return products.length > 0
      ? "抱歉，目录里没有完全符合要求的饮水机。以下是目前最接近的供水或热水设备："
      : "抱歉，目录里没有完全符合要求的饮水机，目前也找不到接近的替代商品。";
  }
  if (reply.selectedProduct) return "我找到了这件商品。请确认是否是您要的商品。";
  if (products.length === 1) return "这是最接近您需求的商品：";
  if (products.length > 1) return `我找到了 ${products.length} 个相关选项：`;
  return "我可以帮您。请再告诉我商品类型、尺寸、品牌或用途，我会继续查询。";
}

function chineseSuggestion(suggestion: string) {
  const translations: Record<string, string> = {
    "Find a product": "查找商品",
    "Browse products": "浏览商品",
    "Search again": "重新查询",
    "Choose another item": "选择其他商品",
    "No, thank you": "不用了，谢谢",
    "Continue for staff review": "交由人员确认",
  };
  return translations[suggestion] ?? suggestion;
}

function customerReply<T extends { message: string; suggestions?: string[]; products?: Product[]; selectedProduct?: Product | null }>(reply: T, input: Pick<ChatRequest, "message" | "history">): T {
  const useChinese = prefersChinese(input);
  const operationalFailure = /^(?:load failed|fetch (?:is )?aborted|failed to fetch|network(?: request)? failed|aborterror|timeout(?:error)?|internal server error)\.?$/i.test(reply.message.trim());
  const rememberedRequest = catalogueMessageWithContext(
    input.message,
    catalogueHistoryWithClarification(input.message, input.history),
  );
  const safeMessage = operationalFailure
    ? useChinese
      ? `刚才的查询没有完成。我还记得您要找的是 ${rememberedRequest}。请再发送最后一个要求，我会继续。`
      : `That lookup didn’t finish, but I still have your ${rememberedRequest} request. Send the last detail once more and I’ll continue.`
    : reply.message;
  return {
    ...reply,
    message: useChinese ? chineseCustomerMessage({ ...reply, message: safeMessage }) : normalizeClaireMessage(safeMessage),
    ...(reply.suggestions
      ? { suggestions: reply.suggestions
          .filter((suggestion) => !/\bsku\b/i.test(suggestion))
          .map((suggestion) => useChinese ? chineseSuggestion(suggestion) : suggestion) }
      : {}),
  };
}

async function addLiveCatalogueState(reply: ChatReply): Promise<ChatReply> {
  try {
    const products = [
      ...reply.products,
      ...(reply.selectedProduct ? [reply.selectedProduct] : []),
    ];
    type GroundedLiveProduct = {
      catalogueProduct: Product & { source_url: string };
      live: ScrapedSiaHuatProduct | null;
    };
    const liveEntries: Array<readonly [string, GroundedLiveProduct | null]> = await Promise.all(
        [...new Set(products.map((product) => product.stock_id))].map(async (stockId) => {
          const catalogueProduct = await findProductForStockCheck(stockId);
          if (!catalogueProduct) return [stockId, null] as const;

          try {
            const live = await fetchSiaHuatProduct(catalogueProduct.source_url, EARLY_LIVE_CHECK_TIMEOUT_MS);
            if (live.stock_id.toLowerCase() !== stockId.toLowerCase()) {
              throw new Error("LIVE_ITEM_CODE_MISMATCH");
            }
            return [stockId, { catalogueProduct, live }] as const;
          } catch (error) {
            console.error("[api/chat] early live stock check failed", { stockId, error });
            return [stockId, { catalogueProduct, live: null }] as const;
          }
        }),
    );
    const liveProducts = new Map<string, GroundedLiveProduct | null>(liveEntries);
    const enrich = (product: Product): Product => {
      const grounded = liveProducts.get(product.stock_id);
      if (!grounded) return product;
      const { catalogueProduct, live } = grounded;
      return {
        ...product,
        ...catalogueProduct,
        ...(live ? {
          source_url: live.source_url,
          list_price: live.price_ex_gst,
          in_stock: live.in_stock,
          available_quantity: live.available_quantity,
          stock_status: live.stock_status,
          last_scraped_at: live.last_scraped_at,
        } : {}),
      };
    };

    return {
      ...reply,
      products: reply.products.map(enrich),
      selectedProduct: reply.selectedProduct ? enrich(reply.selectedProduct) : null,
    };
  } catch (error) {
    console.error("[api/chat] catalogue live-state enrichment failed", error);
    return reply;
  }
}

function keepExactCodeMatches(reply: ChatReply, message: string): ChatReply {
  const normalizedMessage = message.toUpperCase();
  const exactMatches = reply.products.filter((product) =>
    normalizedMessage.includes(product.stock_id.toUpperCase()),
  );
  return exactMatches.length > 0 ? { ...reply, products: exactMatches } : reply;
}

async function prioritizeRequestedUseCase(reply: ChatReply, message: string): Promise<ChatReply> {
  const useCase = detectProductUseCase(message);
  if (!useCase) return { ...reply, products: prioritizeBrand(message, reply.products) };

  const knownProducts = [
    ...reply.products,
    ...(reply.selectedProduct ? [reply.selectedProduct] : []),
  ];
  const requestedBrand = requestedBrandLabel(message, knownProducts);
  const matchingProducts = prioritizeBrand(
    message,
    reply.products.filter((product) => matchesProductUseCase(product, useCase)),
  );
  const matchingSelection = reply.selectedProduct && matchesProductUseCase(reply.selectedProduct, useCase)
    ? reply.selectedProduct
    : null;
  const exactProducts = requestedBrand
    ? matchingProducts.filter((product) => matchesRequestedBrand(message, product))
    : matchingProducts;
  const exactSelection = requestedBrand && matchingSelection && !matchesRequestedBrand(message, matchingSelection)
    ? null
    : matchingSelection;

  if (exactProducts.length > 0 || exactSelection) {
    return {
      ...reply,
      products: exactProducts,
      selectedProduct: exactSelection,
    };
  }

  try {
    const catalogueMatches = prioritizeBrand(
      message,
      (await searchCatalogue(useCase.search)).filter((product) => matchesProductUseCase(product, useCase)),
    );
    const exactCatalogueMatches = requestedBrand
      ? catalogueMatches.filter((product) => matchesRequestedBrand(message, product))
      : catalogueMatches;
    if (exactCatalogueMatches.length > 0) {
      return {
        ...reply,
        message: `Here are the closest ${requestedBrand ? `${requestedBrand} ` : ""}${useCase.label} options:`,
        stage: "clarify",
        products: exactCatalogueMatches,
        selectedProduct: null,
        suggestions: [],
      };
    }
    if (catalogueMatches.length > 0) {
      return {
        ...reply,
        message: requestedBrand
          ? `${requestedBrand} doesn't have the ${useCase.label} you asked for. These other brands do:`
          : `Here are the ${useCase.label} options I found:`,
        stage: "clarify",
        products: catalogueMatches,
        selectedProduct: null,
        suggestions: [],
      };
    }
  } catch (error) {
    console.error("[api/chat] use-case catalogue search failed", { useCase: useCase.key, error });
  }

  return {
    ...reply,
    message: requestedBrand
      ? `The ${requestedBrand} ${useCase.label} you asked for isn't available, and I couldn't find another ${useCase.label} in the Sia Huat catalogue. Would you like to try a related pan style?`
      : `I couldn't find a ${useCase.label} in the Sia Huat catalogue. Would you like to try a related pan style?`,
    stage: "clarify",
    products: [],
    selectedProduct: null,
    suggestions: ["Try another brand", "Show frying pans"],
  };
}

function alternativeSearchTerms(product: Product) {
  const broadName = product.name
    .replace(/\b\d+(?:\.\d+)?\s*(?:mm|cm|inch|inches|in)\b/gi, " ")
    .replace(/\b(?:L|W|H)\s*\d+(?:\.\d+)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [...new Set([
    product.subcategory,
    product.third_category,
    product.category,
    broadName,
  ].filter((term): term is string => Boolean(term?.trim())))];
}

function productFamily(product: Product) {
  const text = [
    product.name,
    product.category,
    product.subcategory,
    product.third_category,
    product.description,
  ].filter(Boolean).join(" ").toLowerCase();
  const families = [
    { name: "chef-pants", pattern: /\b(?:chef\s+)?(?:pants|trousers)\b/ },
    { name: "coffee-grinder", pattern: /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/ },
    { name: "knife", pattern: /\b(?:knife|knives|cleaver|yanagi|yanagiba|slicer)\b/ },
    { name: "cutlery-set", pattern: /\b(?:cutlery|flatware)\s+sets?\b/ },
    { name: "utility-box", pattern: /\b(?:utility|storage|dish|bus|cutlery)\s+(?:box|boxes|bin|bins)\b|\bcambox\b/ },
    { name: "plate", pattern: /\b(?:plate|plates|platter|platters)\b/ },
    { name: "food-pan", pattern: /\b(?:melamine\s+)?gn\s+pan\b|\bgastronorm\s+pan\b|\bfood\s+pan\b/ },
    { name: "cookware-set", pattern: /\bcookware\s+set\b|\bset\b.*\b(?:pan|pot|skillet)s?\b/ },
    { name: "wok", pattern: /\bwoks?\b/ },
    { name: "pan", pattern: /\b(?:pan|pans|skillet|skillets)\b/ },
    { name: "stockpot", pattern: /\b(?:stockpot|stockpots|stock\s+pots?)\b/ },
    { name: "pot", pattern: /\b(?:pot|pots|stockpot|saucepot)\b/ },
    { name: "glass", pattern: /\b(?:glass|glasses|glassware|goblet|tumbler)\b/ },
    { name: "bowl", pattern: /\b(?:bowl|bowls)\b/ },
    { name: "cup", pattern: /\b(?:cup|cups|mug|mugs)\b/ },
    { name: "shoe", pattern: /\b(?:shoe|shoes|footwear)\b/ },
    { name: "water-dispenser", pattern: /\bwater\s+(?:dispenser|urn|boiler)\b|\b(?:electric|thermal)\s+airpot\b|\bdrinking\s+fountain\b/ },
    { name: "machine", pattern: /\b(?:machine|machines|appliance|appliances)\b/ },
  ];
  return families.find((family) => family.pattern.test(text))?.name ?? null;
}

function exactCodeCandidates(message: string) {
  const hasExplicitCodeCue = /\b(?:code|item\s+code|product\s+code|sku)\s*[:#-]?\s*[a-z0-9]/i.test(message);
  const isStandaloneNumericCode = /^\s*\d{4,}\s*$/.test(message);
  return [...new Set(
    message.toUpperCase().match(/\b(?=[A-Z0-9./-]*\d)[A-Z0-9]+(?:[./-][A-Z0-9]+)*\b/g) ?? [],
  )].filter((candidate) =>
    candidate.length >= 3
    && candidate.length <= 50
    && !/^\d+(?:\.\d+)?-?(?:CM|MM|IN|INCH)$/.test(candidate)
    && (!/^\d+(?:\.\d+)?$/.test(candidate) || hasExplicitCodeCue || isStandaloneNumericCode)
  ).slice(0, 5);
}

function isConcreteCatalogueRequest(message: string) {
  return /\b(?:chef|cleaver|boning|paring|bread|yanagi|sashimi|frying|fryng|saucepan|omele+t+e?|grill)\b/i.test(message)
    || /\b(?:spoon|spoons|serving\s+spoon|ladle|ladles|fork|forks|cutlery)\b/i.test(message)
    || /\b(?:plate|plates|platter|platters|tableware)\b/i.test(message)
    || /\b(?:strainer|strainers|skimmer|skimmers|colander|colanders)\b/i.test(message)
    || /\b(?:commercial\s+)?blenders?\b/i.test(message)
    || /\b(?:coffee\s+beans?|wine\s+glass(?:es)?|glassware)\b/i.test(message)
    || /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i.test(message)
    || /\b(?:stockpot|stockpots|stock\s+pots?)\b/i.test(message)
    || /\bwoks?\b/i.test(message)
    || /\b(?:shoe|shoes|shows|footwear)\b/i.test(message)
    || /\b(?:chef\s+)?(?:pants|trousers)\b/i.test(message)
    || /\b(?:water\s+)?(?:dispenser|urn|boiler|airpot)\b/i.test(message)
    || /\b(?:red|yellow|blue|black|white|green|silver)\b/i.test(message)
    || /\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|in)\b/i.test(message)
    || /\b(?:che+f+f?|knfie|kinife|knive|anot)\b/i.test(message)
    || exactCodeCandidates(message).length > 0;
}

function matchesExplicitProductCategory(message: string, product: Product) {
  const productText = [product.name, product.description, product.category, product.subcategory, product.third_category]
    .filter(Boolean)
    .join(" ");
  if (/\bblenders?\b/i.test(message)) return /\bblenders?\b/i.test(productText);
  if (/\bwoks?\b/i.test(message)) return /\bwoks?\b/i.test(productText);
  if (/\b(?:noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i.test(message)
    && /\b(?:strainer|skimmer|colander|sieve)\b/i.test(message)) {
    return /\b(?:strainer|skimmer|colander|sieve)\b/i.test(productText)
      && !/\b(?:bar|cocktail|liquor|julep|hawthorne)\b/i.test(productText);
  }
  if (/\b(?:strainer|skimmer|colander)s?\b/i.test(message)) return /\b(?:strainer|skimmer|colander)s?\b/i.test(productText);
  if (/\b(?:cutlery|flatware)\s+sets?\b/i.test(message)) return productFamily(product) === "cutlery-set";
  if (/\b(?:plate|plates|platter|platters|tableware)\b/i.test(message)) {
    return /\b(?:plate|plates|platter|platters)\b/i.test(productText)
      && !/\b(?:induction\s+plate|heat\s+tamer|machine\s+plate|plate\s+(?:holder|stand|rack|cover)|(?:holder|stand|rack)\s+(?:for\s+)?(?:[\w/-]+\s+){0,4}plates?|plate\s+accessor(?:y|ies))\b/i.test(productText);
  }
  return true;
}

function enforceExplicitProductCategory(reply: ChatReply, message: string): ChatReply {
  if (isExactCodeRequest(message, reply.products)) return reply;
  const products = reply.products.filter((product) => matchesExplicitProductCategory(message, product));
  const selectedProduct = reply.selectedProduct && matchesExplicitProductCategory(message, reply.selectedProduct)
    ? reply.selectedProduct
    : null;
  const customerMessage = products.length > 0 && /^Here are \d+ different\b/i.test(reply.message)
    ? reply.message.replace(/^Here are \d+ different\b/i, `Here are ${products.length} different`)
    : reply.message;
  return { ...reply, message: customerMessage, products, selectedProduct };
}

function isDirectCatalogueAvailabilityRequest(message: string) {
  return /\b(?:do|does)\s+(?:you|u|sia\s+huat|you\s+guys)\s+(?:sell|have|carry|stock)\b/i.test(message)
    || /\b(?:can|could)\s+i\s+(?:get|buy|order)\b/i.test(message)
    || /\b(?:have|got)\s+any\b/i.test(message);
}

function normalizedApparelSize(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized === "XXL") return "2XL";
  if (normalized === "XXXL") return "3XL";
  return /^(?:XS|S|M|L|XL|2XL|3XL)$/.test(normalized) ? normalized : null;
}

function apparelSize(product: Product) {
  const namedSize = product.name.match(/(?:,|\()\s*(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\)?\s*$/i)?.[1];
  return normalizedApparelSize(namedSize ?? product.size);
}

function requestedApparelSize(message: string) {
  const labelled = message.match(/\bsize(?:\s*[:#-]\s*|\s+)(XS|S|M|L|XL|XXL|XXXL|2XL|3XL|\d{2,3})\b/i)?.[1]
    ?? message.match(/\bsize(\d{2,3})\b/i)?.[1];
  const standalone = message.match(/\b(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/i)?.[1];
  const raw = labelled ?? standalone;
  if (!raw) return null;
  return /^\d+$/.test(raw) ? raw : normalizedApparelSize(raw);
}

function pantsContext(input: ChatRequest) {
  const contextText = [
    input.message,
    ...input.history.map((item) => item.content),
    input.context?.activeProduct?.name,
    input.context?.activeProduct?.third_category,
  ].filter(Boolean).join("\n");
  return /\b(?:chef\s+)?(?:pants|trousers)\b/i.test(contextText);
}

function isPantsSizingTurn(input: ChatRequest) {
  if (!pantsContext(input)) return false;
  return /\b(?:size|sizes|sizing|other\s+options?|another\s+option|what\s+do\s+you\s+carry|available)\b/i.test(input.message)
    || Boolean(requestedApparelSize(input.message));
}

function pantsDisplayOptions(products: Product[]) {
  const available = products.filter((product) => product.stock_status !== "out_of_stock" && product.available_quantity !== 0);
  const selected: Product[] = [];
  const seenSizes = new Set<string>();
  for (const product of available) {
    const size = apparelSize(product);
    if (!size || seenSizes.has(size)) continue;
    selected.push(product);
    seenSizes.add(size);
    if (selected.length >= 3) break;
  }
  return selected;
}

async function groundedPantsSizingReply(input: ChatRequest): Promise<ChatReply | null> {
  if (!isPantsSizingTurn(input)) return null;
  const products = await findChefPantsCatalogue();
  const requestedSize = requestedApparelSize(input.message);
  const exactMatches = requestedSize && !/^\d+$/.test(requestedSize)
    ? products.filter((product) => apparelSize(product) === requestedSize)
    : [];
  const sizeOrder = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];
  const availableSizes = [...new Set(
    products
      .filter((product) => product.stock_status !== "out_of_stock" && product.available_quantity !== 0)
      .map(apparelSize)
      .filter((size): size is string => Boolean(size)),
  )].sort((left, right) => sizeOrder.indexOf(left) - sizeOrder.indexOf(right));

  if (exactMatches.length > 0) {
    return {
      message: `Yes, size ${requestedSize} is listed. Here are the matching chef pants:`,
      stage: "clarify",
      products: exactMatches.slice(0, 3),
      selectedProduct: null,
      suggestions: [],
    };
  }

  const displayProducts = pantsDisplayOptions(products);
  return {
    message: requestedSize
      ? `I couldn't find chef pants listed as size ${requestedSize}. The available catalogue sizes are ${availableSizes.join(", ")}. Which size would you like?`
      : `For chef pants, the available catalogue sizes are ${availableSizes.join(", ")}. Which size would you like?`,
    stage: "clarify",
    products: displayProducts,
    selectedProduct: null,
    suggestions: availableSizes.slice(0, 5).map((size) => `Size ${size}`),
  };
}

function requestedCatalogueItem(message: string) {
  const cleaned = message
    .replace(/\b(?:hi|hello|hey)\b[,.!\s]*/gi, " ")
    .replace(/\b(?:do|does)\s+(?:you|u|sia\s+huat|you\s+guys)\s+(?:sell|have|carry|stock)\b/gi, " ")
    .replace(/\b(?:can|could)\s+i\s+(?:get|buy|order)\b/gi, " ")
    .replace(/\b(?:have|got)\s+any\b/gi, " ")
    .replace(/\b(?:please|pls|for me|here|in stock|available)\b/gi, " ")
    .replace(/\b(?:bananna|bannana)\b/gi, "banana")
    .replace(/[?.!,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "that item";
}

const catalogueTokenStopWords = new Set([
  "a", "an", "and", "any", "buy", "can", "carry", "could", "do", "does", "for", "get",
  "guys", "have", "hello", "hey", "hi", "i", "in", "is", "like", "looking", "me", "need",
  "of", "order", "please", "sell", "selling", "some", "stock", "the", "to", "u", "want", "you",
  "unit", "units", "piece", "pieces", "pc", "pcs", "pair", "pairs", "set", "sets",
]);

function catalogueToken(value: string) {
  if (value === "knives") return "knife";
  if (value === "leaves") return "leaf";
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && value.length > 4 && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function catalogueTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(?:bananna|bannana)\b/g, "banana")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(catalogueToken)
    .filter((token) => token.length >= 2 && !catalogueTokenStopWords.has(token) && !/^\d+$/.test(token));
}

function matchesDirectCatalogueRequest(message: string, product: Product) {
  if (/\bbanana\s+(?:leaf|leaves|peels?)\b/i.test(message)
    && !/\bplates?\b/i.test(message)
    && /\bplates?\b/i.test(product.name)) {
    return false;
  }
  const requestedTokens = [...new Set(catalogueTokens(requestedCatalogueItem(message)))];
  if (requestedTokens.length === 0) return false;
  const productTokens = new Set(catalogueTokens([
    product.name,
    product.brand,
    product.brand_id,
    product.description,
    product.category,
    product.subcategory,
    product.third_category,
  ].filter(Boolean).join(" ")));
  return requestedTokens.every((token) => productTokens.has(token));
}

function relatedUseCase(message: string) {
  if (/\b(?:compost|composting|food\s+waste|discard(?:ing)?\s+food|dispose\s+of\s+food)\b/i.test(message)) {
    return {
      label: "handling food waste",
      searches: ["food waste caddy", "food waste bin"],
      productPattern: /\b(?:food\s+waste|waste\s+caddy|waste\s+bin)\b/i,
    };
  }
  return null;
}

async function unavailableCatalogueReply(message: string): Promise<ChatReply> {
  const requestedItem = requestedCatalogueItem(message);
  const useCase = relatedUseCase(message);
  if (!useCase) {
    return {
      message: `Sorry, we don't carry ${requestedItem}. We specialise in commercial kitchen and F&B supplies.`,
      stage: "clarify",
      products: [],
      selectedProduct: null,
      suggestions: [],
    };
  }

  const resultSets = await Promise.all(useCase.searches.map(async (search) => {
    try {
      return await searchCatalogue(search, { resultLimit: 20, outputLimit: 10 });
    } catch (error) {
      console.error("[api/chat] related use-case search failed", { search, error });
      return [];
    }
  }));
  const alternatives = [...new Map(
    resultSets
      .flat()
      .filter((product) => useCase.productPattern.test([
        product.name,
        product.description,
        product.category,
        product.subcategory,
        product.third_category,
      ].filter(Boolean).join(" ")))
      .map((product) => [product.stock_id, product]),
  ).values()].slice(0, 3);

  return {
    message: alternatives.length > 0
      ? `Sorry, we don't carry ${requestedItem}. If you're looking for ${useCase.label}, these are the closest relevant products we do carry:`
      : `Sorry, we don't carry ${requestedItem}, and I couldn't find a relevant alternative for ${useCase.label}.`,
    stage: "clarify",
    products: alternatives,
    selectedProduct: null,
    suggestions: [],
  };
}

function isWaterDispenserRequest(message: string) {
  return /\bwater\s+(?:dispenser|urn|boiler)\b|\b(?:electric|thermal)\s+airpot\b/i.test(message);
}

function waterProductText(product: Product) {
  return [product.name, product.description, product.category, product.subcategory, product.third_category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isWaterDispensingProduct(product: Product) {
  return /\bwater\s+(?:dispenser|urn|boiler)\b|\b(?:electric|thermal)\s+airpot\b|\bdrinking\s+fountain\b/i
    .test(waterProductText(product));
}

function litresFromText(value: string) {
  const match = value.match(/\b(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\b/i);
  return match ? Number.parseFloat(match[1]) : null;
}

function isStockpotRequest(message: string) {
  return /\b(?:stockpot|stockpots|stock\s+pots?)\b/i.test(message);
}

function isStockpotProduct(product: Product) {
  return /\b(?:stockpot|stockpots|stock\s+pots?)\b/i.test([
    product.name,
    product.description,
    product.category,
    product.subcategory,
    product.third_category,
  ].filter(Boolean).join(" "));
}

async function groundedStockpotReply(message: string): Promise<ChatReply> {
  const stockpots = (await searchCatalogue("stockpot", { resultLimit: 40, outputLimit: 40 }))
    .filter(isStockpotProduct);
  const requestedCapacity = litresFromText(message);
  const exactProducts = requestedCapacity === null
    ? stockpots
    : stockpots.filter((product) => litresFromText([
        product.name,
        product.description,
        product.size,
        product.dimensions,
      ].filter(Boolean).join(" ")) === requestedCapacity);
  if (exactProducts.length > 0) {
    return {
      message: exactProducts.length === 1 ? "This is the closest match:" : "Here are the matching stockpots:",
      stage: "clarify",
      products: exactProducts.slice(0, 3),
      selectedProduct: null,
      suggestions: [],
    };
  }

  const nearbyProducts = stockpots.slice(0, 3);
  const capacityLabel = message.match(/\b\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\b/i)?.[0]?.replace(/\s+/g, "");
  const requestedLabel = capacityLabel ? `${capacityLabel} stockpot` : "stockpot";
  return {
    message: nearbyProducts.length > 0
      ? `I couldn't find an exact ${requestedLabel}. These are other stockpot sizes we carry:`
      : `I couldn't find an exact ${requestedLabel}, and there isn't another stockpot in the catalogue right now.`,
    stage: "clarify",
    products: nearbyProducts,
    selectedProduct: null,
    suggestions: nearbyProducts.length > 0 ? [] : ["Browse products"],
  };
}

function matchesWaterDispenserRequirements(product: Product, message: string) {
  if (!isWaterDispensingProduct(product)) return false;
  const candidate = waterProductText(product);
  const requestedCapacity = litresFromText(message);
  const productCapacity = litresFromText(candidate);
  if (requestedCapacity !== null && productCapacity !== requestedCapacity) return false;
  if (/\bfree[ -]?standing\b/i.test(message) && !/\bfree[ -]?standing|floor[ -]?standing\b/i.test(candidate)) return false;
  if (/\bhot\b[\s\S]*\bcold\b|\bcold\b[\s\S]*\bhot\b/i.test(message)
    && !(/\bhot\b/i.test(candidate) && /\bcold\b/i.test(candidate))) return false;
  return true;
}

function waterDispenserRequestLabel(message: string) {
  const capacity = message.match(/\b\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\b/i)?.[0]?.replace(/\s+/g, "") ?? null;
  const placement = /\bfree[ -]?standing\b/i.test(message) ? "freestanding" : /\bcounter[ -]?top\b/i.test(message) ? "countertop" : null;
  const temperature = /\bhot\b[\s\S]*\bcold\b|\bcold\b[\s\S]*\bhot\b/i.test(message) ? "hot-and-cold" : null;
  return [capacity, placement, temperature, "water dispenser"].filter(Boolean).join(" ");
}

async function groundedWaterDispenserReply(message: string): Promise<ChatReply> {
  const exactProducts = await searchCatalogue(message, { resultLimit: 30, outputLimit: 20 });
  const exactMatches = exactProducts.filter((product) => matchesWaterDispenserRequirements(product, message));
  if (exactMatches.length > 0) {
    return {
      message: exactMatches.length === 1 ? "This is the closest match:" : "Here are the matching water dispensers:",
      stage: "clarify",
      products: exactMatches.slice(0, 3),
      selectedProduct: null,
      suggestions: [],
    };
  }

  const searchTerms = ["water dispenser", "water urn", "electric airpot", "drinking fountain"];
  const resultSets = await Promise.all(searchTerms.map(async (term) => {
    try {
      return await searchCatalogue(term, { resultLimit: 30, outputLimit: 30 });
    } catch (error) {
      console.error("[api/chat] nearby water-dispenser search failed", { term, error });
      return [];
    }
  }));
  const requestedCapacity = litresFromText(message);
  const alternatives = [...new Map(
    resultSets.flat().filter(isWaterDispensingProduct).map((product) => [product.stock_id, product]),
  ).values()].sort((left, right) => {
    const score = (product: Product) => {
      const text = waterProductText(product);
      const capacity = litresFromText(text);
      const capacityScore = requestedCapacity !== null && capacity !== null
        ? Math.max(0, 50 - Math.abs(requestedCapacity - capacity) * 15)
        : 0;
      return capacityScore
        + (/\bwater\s+dispenser\b/i.test(text) ? 60 : 0)
        + (/\bwater\s+urn\b/i.test(text) ? 35 : 0)
        + (/\bairpot\b/i.test(text) ? 25 : 0)
        + (product.stock_status === "in_stock" ? 20 : 0);
    };
    return score(right) - score(left);
  }).slice(0, 3);

  return {
    message: alternatives.length > 0
      ? `I couldn't find an exact ${waterDispenserRequestLabel(message)}. These are the closest water-dispensing options we have instead:`
      : `I couldn't find an exact ${waterDispenserRequestLabel(message)}, and there isn't a close water-dispensing alternative in the catalogue right now.`,
    stage: "clarify",
    products: alternatives,
    selectedProduct: null,
    suggestions: alternatives.length > 0 ? [] : ["Browse products"],
  };
}

async function groundedCatalogueReply(
  message: string,
  options: { authoritative?: boolean } = {},
): Promise<ChatReply | null> {
  for (const code of exactCodeCandidates(message)) {
    const exactProduct = await findCatalogueProductByCode(code);
    if (exactProduct) {
      return {
        message: `Found it. Code: ${exactProduct.stock_id}.`,
        stage: "clarify",
        products: [exactProduct],
        selectedProduct: null,
        suggestions: [],
      };
    }
  }

  if (isWaterDispenserRequest(message)) return groundedWaterDispenserReply(message);
  if (isStockpotRequest(message)) return groundedStockpotReply(message);

  if (!isConcreteCatalogueRequest(message) && !options.authoritative) return null;
  const maximumPrice = (() => {
    const value = message.match(/(?:below|under|less\s+than|up\s+to|budget(?:\s+of)?)\s*\$?\s*(\d+(?:\.\d+)?)/i)?.[1];
    return value ? Number.parseFloat(value) : null;
  })();
  const searchMessage = message
    .replace(/(?:below|under|less\s+than|up\s+to|budget(?:\s+of)?)\s*\$?\s*\d+(?:\.\d+)?/gi, " ")
    .replace(/\b\d+\s+(?:outlets?|drinks?(?:\s+per\s+(?:day|hour))?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const searchedProducts = await searchCatalogue(searchMessage || message, { resultLimit: 30, outputLimit: 20 });
  const products = searchedProducts.filter((product) => matchesExplicitProductCategory(message, product));
  const relevantProducts = options.authoritative
    ? products.filter((product) => matchesDirectCatalogueRequest(message, product))
    : products;
  const priceEligibleProducts = maximumPrice === null
    ? relevantProducts
    : relevantProducts.filter((product) => Number(product.list_price) <= maximumPrice);
  const minimumQuantity = requestedQuantity(message);
  const quantityEligibleProducts = minimumQuantity === null
    ? priceEligibleProducts
    : priceEligibleProducts.filter((product) =>
        product.stock_status === "in_stock"
        && typeof product.available_quantity === "number"
        && product.available_quantity >= minimumQuantity,
      );
  const displayProducts = diversifyProducts(quantityEligibleProducts);
  if (displayProducts.length === 0) {
    if (/\bdamascus\b/i.test(message)) {
      const ordinaryChefKnives = (await searchCatalogue("chef knife", { resultLimit: 30, outputLimit: 20 }))
        .filter((product) => /\bchef(?:'s|s)?\s+knife\b/i.test([
          product.name,
          product.description,
          product.category,
          product.subcategory,
          product.third_category,
        ].filter(Boolean).join(" ")))
        .filter((product) => minimumQuantity === null || (
          product.stock_status === "in_stock"
          && typeof product.available_quantity === "number"
          && product.available_quantity >= minimumQuantity
        ))
        .slice(0, 3);
      return {
        message: ordinaryChefKnives.length > 0
          ? minimumQuantity === null
            ? "I couldn't find a confirmed Damascus chef knife. These are non-Damascus chef knives we carry instead:"
            : `I couldn't find a confirmed Damascus chef knife with at least ${minimumQuantity} PC available. These non-Damascus chef knives do meet the quantity:`
          : minimumQuantity === null
            ? "I couldn't find a confirmed Damascus chef knife in the catalogue."
            : `I couldn't find a confirmed Damascus chef knife with at least ${minimumQuantity} PC available.`,
        stage: "clarify",
        products: ordinaryChefKnives,
        selectedProduct: null,
        suggestions: ordinaryChefKnives.length > 0 ? [] : ["Try another knife type"],
      };
    }
    if (minimumQuantity !== null && relevantProducts.length > 0) {
      return {
        message: `I found matching items, but I couldn't confirm one with at least ${minimumQuantity} units available. Would you like a smaller quantity or another option?`,
        stage: "clarify",
        products: [],
        selectedProduct: null,
        suggestions: ["Try a smaller quantity", "Choose another item"],
      };
    }
    if (maximumPrice !== null && relevantProducts.length > 0) {
      return {
        message: `I found matching items, but none are listed at or below $${maximumPrice.toFixed(2)}. Would you like the closest-priced options instead?`,
        stage: "clarify",
        products: [],
        selectedProduct: null,
        suggestions: ["Show closest-priced options", "Change budget"],
      };
    }
    return options.authoritative ? unavailableCatalogueReply(message) : null;
  }
  const resultType = /\b(?:shoe|shoes|shows|footwear)\b/i.test(message) ? "shoe " : "";
  return {
    message: displayProducts.length === 1
      ? "This looks like the closest match:"
      : `Here are ${displayProducts.length} ${resultType}options:`,
    stage: "clarify",
    products: displayProducts,
    selectedProduct: null,
    suggestions: [],
  };
}

async function inSessionOrder<T>(sessionId: string, task: () => Promise<T>) {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  sessionQueues.set(sessionId, tail);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
  }
}

function isSameProductType(source: Product, candidate: Product) {
  const sourceFamily = productFamily(source);
  if (sourceFamily) return productFamily(candidate) === sourceFamily;

  const sourceCategory = source.category?.trim().toLowerCase();
  const candidateCategory = candidate.category?.trim().toLowerCase();
  return !sourceCategory || !candidateCategory || sourceCategory === candidateCategory;
}

function productLineSignature(product: Product) {
  return product.name
    .toLowerCase()
    .replace(/\b(?:euro|us)\s+size\s+\d+(?:\s*\/\s*\d+)?\b/gi, " ")
    .replace(/\bsize\s+\d+(?:\s*\/\s*\d+)?\b/gi, " ")
    .replace(/[øø]\s*\d+(?:\.\d+)?(?:\s*[x×]\s*[a-z]?\d+(?:\.\d+)?)*(?:\s*(?:mm|cm|m|l))?/gi, " ")
    .replace(/\b(?:l|w|h)\s*\d+(?:\.\d+)?(?:\s*(?:mm|cm|m))?\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:mm|cm|inch|inches|in|litre|litres|liter|liters|l|ml)\b/gi, " ")
    .replace(/\b(?:red|yellow|blue|black|white|green|silver|grey|gray|orange|brown|pink|purple)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedBrand(product: Product) {
  return (product.brand ?? product.brand_id ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function diversifyProducts(products: Product[], limit = 3) {
  const uniqueProducts = [...new Map(products.map((product) => [product.stock_id, product])).values()];
  const selected: Product[] = [];
  const seenLines = new Set<string>();
  const seenBrands = new Set<string>();

  const addProduct = (product: Product, requireNewBrand: boolean) => {
    const line = productLineSignature(product) || product.stock_id.toLowerCase();
    const brand = normalizedBrand(product);
    if (seenLines.has(line) || (requireNewBrand && brand && seenBrands.has(brand))) return;
    selected.push(product);
    seenLines.add(line);
    if (brand) seenBrands.add(brand);
  };

  for (const product of uniqueProducts) {
    if (selected.length >= limit) break;
    addProduct(product, true);
  }
  for (const product of uniqueProducts) {
    if (selected.length >= limit) break;
    addProduct(product, false);
  }

  return selected;
}

function deduplicateReplyProducts(reply: ChatReply): ChatReply {
  const products = [...new Map(
    reply.products.map((product) => [product.stock_id.trim().toLowerCase(), product]),
  ).values()];
  return products.length === reply.products.length ? reply : { ...reply, products };
}

function meetsRequestedQuantity(product: Product, quantity: number | null) {
  if (quantity === null) return product.stock_status === "in_stock";
  return product.stock_status === "in_stock"
    && typeof product.available_quantity === "number"
    && product.available_quantity >= quantity;
}

function matchesRequestedDimensions(message: string, product: Product) {
  const requested = message.match(/\b(\d+(?:\.\d+)?)[\s-]*(cm|mm|inch|inches|in)\b/i);
  if (!requested) return true;
  const requestedValue = Number.parseFloat(requested[1]);
  const requestedCm = /^mm$/i.test(requested[2])
    ? requestedValue / 10
    : /^(?:inch|inches|in)$/i.test(requested[2])
      ? requestedValue * 2.54
      : requestedValue;
  const productText = [product.name, product.size, product.dimensions, product.description].filter(Boolean).join(" ");
  const measurements = [...productText.matchAll(/\b(\d+(?:\.\d+)?)\s*(cm|mm|inch|inches|in|\")/gi)]
    .map((match) => {
      const value = Number.parseFloat(match[1]);
      if (/^mm$/i.test(match[2])) return value / 10;
      if (/^(?:inch|inches|in|")$/i.test(match[2])) return value * 2.54;
      return value;
    });
  return measurements.some((measurement) => Math.abs(measurement - requestedCm) <= 1.1);
}

function enforceRequestedDimensions(reply: ChatReply, message: string): ChatReply {
  if (!/\b\d+(?:\.\d+)?[\s-]*(?:cm|mm|inch|inches|in)\b/i.test(message)) return reply;
  const products = reply.products.filter((product) => matchesRequestedDimensions(message, product));
  const selectedProduct = reply.selectedProduct && matchesRequestedDimensions(message, reply.selectedProduct)
    ? reply.selectedProduct
    : null;
  return products.length > 0 || selectedProduct ? { ...reply, products, selectedProduct } : reply;
}

function enforceRequestedQuantityOptions(reply: ChatReply, message: string): ChatReply {
  const quantity = requestedQuantity(message);
  if (quantity === null || isExactCodeRequest(message, reply.products)) return reply;

  const products = reply.products.filter((product) => meetsRequestedQuantity(product, quantity)).slice(0, 3);
  const selectedProduct = reply.selectedProduct && meetsRequestedQuantity(reply.selectedProduct, quantity)
    ? reply.selectedProduct
    : null;
  const uom = products[0]?.uom_id ?? selectedProduct?.uom_id ?? "units";
  const alreadyDisclosesAlternative = /\bnon-Damascus\b/i.test(reply.message);
  return {
    ...reply,
    message: products.length > 0 || selectedProduct
      ? alreadyDisclosesAlternative
        ? reply.message
        : `These matching options have at least ${quantity} ${uom} available:`
      : `I couldn't confirm a matching item with at least ${quantity} ${uom} available. Would you like a smaller quantity?`,
    stage: "clarify",
    products,
    selectedProduct,
    suggestions: products.length > 0 || selectedProduct ? [] : ["Try a smaller quantity", "Choose another item"],
  };
}

function isExactCodeRequest(message: string, products: Product[]) {
  const request = message.toUpperCase();
  return products.some((product) => request.includes(product.stock_id.toUpperCase()));
}

function taxonomySimilarity(source: Product, candidate: Product) {
  const equal = (left?: string | null, right?: string | null) =>
    Boolean(left?.trim() && right?.trim() && left.trim().toLowerCase() === right.trim().toLowerCase());
  return (equal(source.third_category, candidate.third_category) ? 4 : 0)
    + (equal(source.subcategory, candidate.subcategory) ? 2 : 0)
    + (equal(source.category, candidate.category) ? 1 : 0);
}

function diverseOptionMessage(message: string, anchor: Product, count: number) {
  const useCase = detectProductUseCase(message)?.label;
  const catalogueType = anchor.third_category?.trim().toLowerCase();
  const productType = useCase ?? catalogueType ?? productFamily(anchor) ?? "product";
  const pluralType = count === 1 || productType.endsWith("s") ? productType : `${productType}s`;
  return `Here are ${count} different ${pluralType}:`;
}

async function addDiverseProductOptions(reply: ChatReply, message: string): Promise<ChatReply> {
  if (reply.selectedProduct || reply.products.length <= 1 || isExactCodeRequest(message, reply.products)) {
    return reply;
  }

  if (isWaterDispenserRequest(message)) return { ...reply, products: reply.products.slice(0, 3) };

  if (/\b(?:shoe|shoes|footwear)\b/i.test(message) && /\b(?:euro|uk|us)\s*(?:size\s*)?\d/i.test(message)) {
    return { ...reply, products: diversifyProducts(reply.products) };
  }

  const anchor = reply.products[0];
  const sameTypeProducts = reply.products.filter((product) => isSameProductType(anchor, product));
  const initialSelection = diversifyProducts(sameTypeProducts);
  if (initialSelection.length >= 3) return { ...reply, products: initialSelection };

  const candidates = new Map(sameTypeProducts.map((product) => [product.stock_id, product]));
  const searchTerms = [...new Set([
    message,
    anchor.third_category,
    anchor.subcategory,
    anchor.category,
    anchor.name,
  ].filter((term): term is string => Boolean(term?.trim())))];

  for (const term of searchTerms) {
    try {
      const results = await searchCatalogue(term, { resultLimit: 30, outputLimit: 30 });
      for (const product of results) {
        if (isSameProductType(anchor, product)) candidates.set(product.stock_id, product);
      }
      if (diversifyProducts([...candidates.values()]).length >= 3) break;
    } catch (error) {
      console.error("[api/chat] diverse catalogue search failed", { term, error });
    }
  }

  const taxonomyAnchor = [...candidates.values()].find((product) => product.third_category?.trim()) ?? anchor;
  const rankedCandidates = [...candidates.values()].filter((product) => product.stock_id !== anchor.stock_id).sort(
    (left, right) => taxonomySimilarity(taxonomyAnchor, right) - taxonomySimilarity(taxonomyAnchor, left),
  );
  const products = diversifyProducts([candidates.get(anchor.stock_id) ?? anchor, ...rankedCandidates]);
  return {
    ...reply,
    message: products.length > initialSelection.length
      ? diverseOptionMessage(message, anchor, products.length)
      : reply.message,
    products,
  };
}

async function addAvailableAlternatives(reply: ChatReply, message: string): Promise<ChatReply> {
  const minimumQuantity = requestedQuantity(message);
  const unavailable = reply.selectedProduct?.stock_status === "out_of_stock"
    ? reply.selectedProduct
    : reply.products.find((product) => product.stock_status === "out_of_stock");
  if (!unavailable) return reply;

  const existingAvailable = reply.products.filter(
      (product) => product.stock_id !== unavailable.stock_id
      && meetsRequestedQuantity(product, minimumQuantity)
      && matchesRequestedDimensions(message, product)
      && isSameProductType(unavailable, product),
  );
  if (existingAvailable.length >= 3) return reply;

  const candidates = new Map<string, Product>();
  for (const term of [message, ...alternativeSearchTerms(unavailable)]) {
    try {
      const results = await searchCatalogue(term);
      for (const product of results) {
        if (product.stock_id !== unavailable.stock_id && isSameProductType(unavailable, product)) {
          if (!meetsRequestedQuantity(product, minimumQuantity)) continue;
          if (!matchesRequestedDimensions(message, product)) continue;
          candidates.set(product.stock_id, product);
        }
      }
      if (candidates.size >= 5) break;
    } catch (error) {
      console.error("[api/chat] alternative catalogue search failed", { term, error });
    }
  }

  if (candidates.size === 0) return reply;

  const enriched = await addLiveCatalogueState({
    ...reply,
    products: [...reply.products, ...candidates.values()],
  });
  const availableAlternatives = diversifyProducts(
    enriched.products.filter(
      (product) => product.stock_id !== unavailable.stock_id
        && meetsRequestedQuantity(product, minimumQuantity)
        && matchesRequestedDimensions(message, product)
        && isSameProductType(unavailable, product),
    ),
  );

  return availableAlternatives.length > 0
    ? { ...enriched, products: [unavailable, ...availableAlternatives.slice(0, 3)] }
    : reply;
}

function explainUnavailableProducts(reply: ChatReply): ChatReply {
  if (reply.selectedProduct?.stock_status === "out_of_stock") {
    const product = reply.selectedProduct;
    const available = reply.products.filter(
      (item) => item.stock_id !== product.stock_id
        && item.stock_status === "in_stock"
        && isSameProductType(product, item),
    ).slice(0, 3);
    return {
      ...reply,
      message: available.length > 0
        ? `${product.name} (code: ${product.stock_id}) is out of stock right now. ${available.length === 1 ? "This option is" : "These options are"} available instead:`
        : `${product.name} (code: ${product.stock_id}) is out of stock right now. I couldn't confirm another available option yet. Want me to search again?`,
      stage: "clarify",
      products: available.length > 0 ? available : [product],
      selectedProduct: null,
      suggestions: available.length > 0 ? [] : ["Search again", "Choose another item"],
    };
  }

  if (/couldn't find an exact .*water dispenser/i.test(reply.message)) {
    const available = reply.products.filter((product) => product.stock_status !== "out_of_stock").slice(0, 3);
    return {
      ...reply,
      message: available.length > 0
        ? reply.message
        : `${reply.message} The closest matches are currently out of stock.`,
      products: available.length > 0 ? available : reply.products.slice(0, 3),
      suggestions: available.length > 0 ? [] : ["Browse products"],
    };
  }

  const unavailable = reply.products.filter((product) => product.stock_status === "out_of_stock");
  if (unavailable.length === 0) return reply;

  const available = reply.products.filter((product) =>
    product.stock_status === "in_stock"
    && unavailable.some((unavailableProduct) => isSameProductType(unavailableProduct, product)),
  );
  if (reply.products.length === 1) {
    const product = unavailable[0];
    return {
      ...reply,
      message: `${product.name} (code: ${product.stock_id}) is out of stock right now. Want another option?`,
      stage: "clarify",
      suggestions: ["Choose another item", "Search again"],
    };
  }

  const unavailableLabel = unavailable.length === 1
    ? `${unavailable[0].name} (code: ${unavailable[0].stock_id})`
    : unavailable.map((product) => `${product.name} (code: ${product.stock_id})`).join("; ");
  return {
    ...reply,
    message: available.length > 0
      ? `${unavailableLabel} ${unavailable.length === 1 ? "is" : "are"} out of stock right now. ${available.length === 1 ? "This matching option is" : "These matching options are"} available instead:`
      : `${unavailableLabel} ${unavailable.length === 1 ? "is" : "are"} out of stock right now. I couldn't confirm another matching option yet. Want me to search again?`,
    stage: "clarify",
    products: available.length > 0 ? available.slice(0, 3) : unavailable.slice(0, 3),
    suggestions: available.length > 0 ? [] : ["Search again", "Choose another item"],
  };
}

function enforceLiveCheckoutGate(reply: ChatReply): ChatReply {
  if (reply.stage !== "quantity" && reply.stage !== "complete" && reply.stage !== "submitted") {
    return reply;
  }

  return {
    ...reply,
    message: reply.products.length > 0 || reply.selectedProduct
      ? "Pick the exact item first. I’ll check its live stock next."
      : "Pick an exact catalogue item first, then I can check its live stock.",
    stage: "clarify",
    suggestions: reply.products.length > 0 || reply.selectedProduct ? [] : ["Search again", "Browse products"],
  };
}

function quickFallback(input: ChatRequest, groundedReply: ChatReply | null): ChatReply {
  if (groundedReply) {
    return {
      ...groundedReply,
      message: groundedReply.products.length === 1
        ? "This is the closest match. Pick it and I’ll check the live stock."
        : "Here are the closest matches. Pick one and I’ll check the live stock.",
      stage: "clarify",
    };
  }

  if (input.image) {
    return {
      message: "Can help 👍 What item is this? Just tell me roughly, like shoe or pan.",
      stage: "clarify",
      products: [],
      selectedProduct: null,
      suggestions: ["Footwear", "Cookware", "Equipment", "Send another photo"],
    };
  }

  const userHistory = catalogueHistoryWithClarification(input.message, input.history);
  const rememberedRequest = catalogueMessageWithContext(input.message, userHistory);
  const hasRememberedProduct = rememberedRequest.toLowerCase() !== input.message.trim().toLowerCase()
    || /\b(?:knife|blender|strainer|skimmer|plate|tableware|pan|pot|glass|shoe|pants|grinder|dispenser)\b/i.test(rememberedRequest);

  return {
    message: hasRememberedProduct
      ? `I still have your ${rememberedRequest} request. I couldn’t complete that lookup just now, so please send the last detail once more and I’ll continue from there.`
      : isCatalogueRequest(input.message)
        ? "I couldn’t complete that product lookup just now. Please send the item name once more and I’ll retry."
        : "I missed that. What product are you looking for?",
    stage: "clarify",
    products: [],
    selectedProduct: null,
    suggestions: ["Find a product", "Browse products"],
  };
}

async function buildBrainReply(input: ChatRequest, rememberGrounded: (reply: ChatReply) => void) {
  const userHistory = catalogueHistoryWithClarification(input.message, input.history);
  const rememberedCatalogueMessage = catalogueMessageWithContext(input.message, userHistory);
  const originalQuantity = requestedQuantity(input.message);
  const catalogueMessage = originalQuantity !== null && requestedQuantity(rememberedCatalogueMessage) === null
    ? `${rememberedCatalogueMessage} ${originalQuantity} units`
    : rememberedCatalogueMessage;
  let n8nError: unknown = null;
  const workflowMessage = prefersChinese(input)
    ? `${catalogueMessage}\n\n请全程使用简体中文回复客户。商品名称、品牌和商品代码可以保留原文。`
    : catalogueMessage;
  const pantsSizingReply = !input.image
    ? await groundedPantsSizingReply(input).catch((error) => {
        console.error("[api/chat] pants sizing lookup failed", { message: input.message, error });
        return null;
      })
    : null;
  if (pantsSizingReply) {
    rememberGrounded(pantsSizingReply);
    const liveReply = await addLiveCatalogueState(pantsSizingReply);
    return deduplicateReplyProducts(explainUnavailableProducts(liveReply));
  }
  const mustGroundCatalogueAnswer = isDirectCatalogueAvailabilityRequest(input.message)
    || /\b(?:damascus|japan|japanese|woks?)\b/i.test(catalogueMessage);
  const authoritativeGroundedReply = !input.image && mustGroundCatalogueAnswer
    ? await groundedCatalogueReply(catalogueMessage, { authoritative: true }).catch((error) => {
        console.error("[api/chat] authoritative catalogue check failed", { message: catalogueMessage, error });
        return null;
      })
    : null;

  if (authoritativeGroundedReply) {
    rememberGrounded(authoritativeGroundedReply);
    if (/^Sorry, we don't carry\b/i.test(authoritativeGroundedReply.message)) {
      const liveReply = await addLiveCatalogueState(authoritativeGroundedReply);
      const availableProducts = liveReply.products
        .filter((product) => product.stock_status !== "out_of_stock")
        .slice(0, 3);
      return deduplicateReplyProducts({
        ...liveReply,
        message: liveReply.products.length > 0 && availableProducts.length === 0
          ? `${liveReply.message} The related options I found are currently out of stock.`
          : liveReply.message,
        products: availableProducts.length > 0 ? availableProducts : liveReply.products.slice(0, 3),
      });
    }
    const prioritizedReply = await prioritizeRequestedUseCase(authoritativeGroundedReply, catalogueMessage);
    const dimensionReply = enforceRequestedDimensions(prioritizedReply, catalogueMessage);
    const liveReply = await addLiveCatalogueState(dimensionReply);
    return deduplicateReplyProducts(
      enforceLiveCheckoutGate(explainUnavailableProducts(
        enforceRequestedQuantityOptions(liveReply, catalogueMessage),
      )),
    );
  }

  const n8nReplyPromise = sendChatToN8n(
    workflowMessage === input.message ? input : { ...input, message: workflowMessage },
  ).catch((error) => {
    n8nError = error;
    console.error("[api/chat] n8n reply failed", error);
    return null;
  });
  const groundedReply = input.image
    ? null
    : await groundedCatalogueReply(catalogueMessage).catch((error) => {
        console.error("[api/chat] grounded catalogue search failed", { message: catalogueMessage, error });
        return null;
      });

  if (groundedReply) rememberGrounded(groundedReply);
  const n8nReply = groundedReply ? null : await n8nReplyPromise;
  if (!groundedReply && !n8nReply) {
    if (n8nError instanceof Error && n8nError.message === "N8N_NOT_CONFIGURED") throw n8nError;
    return quickFallback(input, null);
  }

  const brainReply = groundedReply ?? n8nReply;
  if (!brainReply) return quickFallback(input, groundedReply);
  const exactReply = keepExactCodeMatches(brainReply, input.message);
  const groundedOrN8n = groundedReply ?? {
    ...exactReply,
    stage: exactReply.products.length === 0 && isCatalogueRequest(input.message)
      ? "clarify" as const
      : exactReply.stage,
  };
  const prioritizedReply = await prioritizeRequestedUseCase(groundedOrN8n, catalogueMessage);
  const diverseReply = enforceRequestedDimensions(
    enforceExplicitProductCategory(
      await addDiverseProductOptions(prioritizedReply, catalogueMessage),
      catalogueMessage,
    ),
    catalogueMessage,
  );
  const liveReply = await addLiveCatalogueState(diverseReply);
  const alternativesReply = await addAvailableAlternatives(liveReply, catalogueMessage);
  const quantityReadyReply = enforceRequestedQuantityOptions(alternativesReply, catalogueMessage);
  return deduplicateReplyProducts(
    enforceLiveCheckoutGate(explainUnavailableProducts(quantityReadyReply)),
  );
}

async function processChat(input: ChatRequest) {
  const startedAt = performance.now();
  const quantity = parseRequestedQuantity(input.message);
  if (quantity.kind === "invalid") {
    const reply: ChatReply = {
      message: quantity.reason === "fractional"
        ? "Please use a whole-number quantity, for example 2 or 3."
        : "Please enter a quantity from 1 to 100,000.",
      stage: input.context?.activeProduct ? "quantity" : "clarify",
      products: [],
      selectedProduct: input.context?.activeProduct ?? null,
      suggestions: input.context?.activeProduct ? ["1", "6", "12", "24"] : [],
    };
    return NextResponse.json(customerReply(reply, input));
  }

  const displayedProducts = input.context?.displayedProducts ?? [];
  const displayedProductIndex = requestsAnotherOption(input.message)
    ? null
    : requestedDisplayedProductIndex(input.message, displayedProducts);
  if (displayedProductIndex !== null) {
    const selectedProduct = displayedProducts[displayedProductIndex];
    const reply: ChatReply = {
      message: quantity.kind === "valid"
        ? `Just to confirm—do you want ${quantity.value} ${selectedProduct.uom_id} of ${selectedProduct.name}?`
        : `Just to confirm, do you want ${selectedProduct.name}?`,
      stage: "clarify",
      products: [selectedProduct],
      selectedProduct,
      suggestions: [],
    };
    return NextResponse.json(customerReply(reply, input));
  }

  const hasUnresolvedReference = quantity.kind === "valid"
    && /\b(?:this|that|these|those|them|it)\b/i.test(input.message)
    && !isConcreteCatalogueRequest(input.message)
    && !input.context?.activeProduct;
  if (hasUnresolvedReference) {
    const reply: ChatReply = {
      message: `Which item would you like ${quantity.value} of? Send the item name or choose one from the previous options.`,
      stage: "clarify",
      products: [],
      selectedProduct: null,
      suggestions: ["Find a product", "Browse products"],
    };
    return NextResponse.json(customerReply(reply, input));
  }

  const fastReply = input.brain === "n8n" ? null : getFastChatReply(input);
  if (fastReply) {
    console.log("[api/chat] fast deterministic reply", {
      durationMs: Math.round(performance.now() - startedAt),
      stage: fastReply.stage,
    });
    return NextResponse.json(customerReply(fastReply, input));
  }

  let safeGroundedReply: ChatReply | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      buildBrainReply(input, (grounded) => { safeGroundedReply = grounded; }),
      new Promise<ChatReply>((resolve) => {
        deadlineTimer = setTimeout(() => {
          console.warn("[api/chat] customer reply deadline reached", {
            durationMs: Math.round(performance.now() - startedAt),
            hasGroundedFallback: Boolean(safeGroundedReply),
          });
          resolve(quickFallback(input, safeGroundedReply));
        }, CUSTOMER_REPLY_DEADLINE_MS);
      }),
    ]);
    console.log("[api/chat] n8n brain reply", {
      durationMs: Math.round(performance.now() - startedAt),
      productCount: reply.products.length,
      stage: reply.stage,
    });
    return NextResponse.json(customerReply(reply, input));
  } catch (error) {
    console.error("Chat failed", error);
    if (error instanceof Error && error.message === "N8N_NOT_CONFIGURED") {
      return NextResponse.json(
        { error: "The conversational assistant is not configured yet." },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "The assistant could not answer right now. Please try again." },
      { status: 502 },
    );
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "The request body must be valid JSON." },
      { status: 400 },
    );
  }

  const input = chatRequestSchema.safeParse(body);

  if (!input.success) {
    return NextResponse.json(
      { error: "Please enter a valid product request." },
      { status: 400 },
    );
  }

  return inSessionOrder(input.data.sessionId, () => processChat(input.data));
}
