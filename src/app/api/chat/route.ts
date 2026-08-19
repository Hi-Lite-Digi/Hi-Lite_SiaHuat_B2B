import { NextResponse } from "next/server";
import { chatRequestSchema, type ChatReply, type ChatRequest, type Product } from "@/lib/chat-contract";
import { sendChatToN8n } from "@/lib/n8n-client";
import {
  detectProductUseCase,
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
import { catalogueMessageWithContext } from "@/lib/chat-intent";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "@/lib/siahuat-product";

export const runtime = "nodejs";

const sessionQueues = new Map<string, Promise<void>>();
const CUSTOMER_REPLY_DEADLINE_MS = 27_000;
const EARLY_LIVE_CHECK_TIMEOUT_MS = 5_000;

function customerReply<T extends { message: string; suggestions?: string[] }>(reply: T): T {
  return {
    ...reply,
    message: normalizeClaireMessage(reply.message),
    ...(reply.suggestions
      ? { suggestions: reply.suggestions.filter((suggestion) => !/\bsku\b/i.test(suggestion)) }
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
    { name: "knife", pattern: /\b(?:knife|knives|cleaver|yanagi|yanagiba|slicer)\b/ },
    { name: "utility-box", pattern: /\b(?:utility|storage|dish|bus|cutlery)\s+(?:box|boxes|bin|bins)\b|\bcambox\b/ },
    { name: "plate", pattern: /\b(?:plate|plates|platter|platters)\b/ },
    { name: "food-pan", pattern: /\b(?:melamine\s+)?gn\s+pan\b|\bgastronorm\s+pan\b|\bfood\s+pan\b/ },
    { name: "cookware-set", pattern: /\bcookware\s+set\b|\bset\b.*\b(?:pan|pot|skillet)s?\b/ },
    { name: "pan", pattern: /\b(?:pan|pans|skillet|skillets)\b/ },
    { name: "pot", pattern: /\b(?:pot|pots|stockpot|saucepot)\b/ },
    { name: "glass", pattern: /\b(?:glass|glasses|glassware|goblet|tumbler)\b/ },
    { name: "bowl", pattern: /\b(?:bowl|bowls)\b/ },
    { name: "cup", pattern: /\b(?:cup|cups|mug|mugs)\b/ },
    { name: "shoe", pattern: /\b(?:shoe|shoes|footwear)\b/ },
    { name: "machine", pattern: /\b(?:machine|machines|appliance|appliances)\b/ },
  ];
  return families.find((family) => family.pattern.test(text))?.name ?? null;
}

function exactCodeCandidates(message: string) {
  return [...new Set(
    message.toUpperCase().match(/\b(?=[A-Z0-9./-]*\d)[A-Z0-9]+(?:[./-][A-Z0-9]+)*\b/g) ?? [],
  )].filter((candidate) =>
    candidate.length >= 3
    && candidate.length <= 50
    && !/^\d+(?:\.\d+)?-?(?:CM|MM|IN|INCH)$/.test(candidate),
  ).slice(0, 5);
}

function isConcreteCatalogueRequest(message: string) {
  return /\b(?:chef|cleaver|boning|paring|bread|yanagi|sashimi|frying|fryng|saucepan|omele+t+e?|grill)\b/i.test(message)
    || /\b(?:coffee\s+beans?|wine\s+glass(?:es)?|glassware)\b/i.test(message)
    || /\b(?:shoe|shoes|shows|footwear)\b/i.test(message)
    || /\b(?:red|yellow|blue|black|white|green|silver)\b/i.test(message)
    || /\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|in)\b/i.test(message)
    || /\b(?:che+f+f?|knfie|kinife|knive|anot)\b/i.test(message)
    || exactCodeCandidates(message).length > 0;
}

async function groundedCatalogueReply(message: string): Promise<ChatReply | null> {
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

  if (!isConcreteCatalogueRequest(message)) return null;
  const products = await searchCatalogue(message, { resultLimit: 30, outputLimit: 20 });
  const diverseProducts = diversifyProducts(products);
  if (diverseProducts.length === 0) return null;
  const resultType = /\b(?:shoe|shoes|shows|footwear)\b/i.test(message) ? "shoe " : "";
  return {
    message: diverseProducts.length === 1
      ? "This looks like the closest match:"
      : `Here are ${diverseProducts.length} different ${resultType}options:`,
    stage: "clarify",
    products: diverseProducts,
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

async function addAvailableAlternatives(reply: ChatReply): Promise<ChatReply> {
  const unavailable = reply.selectedProduct?.stock_status === "out_of_stock"
    ? reply.selectedProduct
    : reply.products.find((product) => product.stock_status === "out_of_stock");
  if (!unavailable) return reply;

  const existingAvailable = reply.products.filter(
    (product) => product.stock_id !== unavailable.stock_id
      && product.stock_status === "in_stock"
      && isSameProductType(unavailable, product),
  );
  if (existingAvailable.length >= 3) return reply;

  const candidates = new Map<string, Product>();
  for (const term of alternativeSearchTerms(unavailable)) {
    try {
      const results = await searchCatalogue(term);
      for (const product of results) {
        if (product.stock_id !== unavailable.stock_id && isSameProductType(unavailable, product)) {
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
        && product.stock_status === "in_stock"
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
      (item) => item.stock_id !== product.stock_id && item.stock_status === "in_stock",
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

  const unavailable = reply.products.filter((product) => product.stock_status === "out_of_stock");
  if (unavailable.length === 0) return reply;

  const available = reply.products.filter((product) => product.stock_status === "in_stock");
  if (reply.products.length === 1) {
    const product = unavailable[0];
    return {
      ...reply,
      message: `${product.name} (code: ${product.stock_id}) is out of stock right now. Want another option?`,
      stage: "clarify",
      suggestions: ["Choose another item", "Search again"],
    };
  }

  const codes = unavailable.map((product) => product.stock_id).join(", ");
  return {
    ...reply,
    message: available.length > 0
      ? `${codes} ${unavailable.length === 1 ? "is" : "are"} out of stock right now. ${available.length === 1 ? "This option is" : "These options are"} available instead:`
      : `The matching items are out of stock right now. I couldn't confirm another available option yet. Want me to search again?`,
    stage: "clarify",
    products: available.length > 0 ? available.slice(0, 3) : reply.products,
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

  return {
    message: isCatalogueRequest(input.message)
      ? "Sorry, I couldn’t pull that up. What item or brand are you looking for? I’ll try another way."
      : "Sorry, I missed that. What are you looking for?",
    stage: "clarify",
    products: [],
    selectedProduct: null,
    suggestions: ["Find a product", "Browse products"],
  };
}

async function buildBrainReply(input: ChatRequest, rememberGrounded: (reply: ChatReply) => void) {
  const userHistory = input.history.filter((item) => item.role === "user").map((item) => item.content);
  const catalogueMessage = catalogueMessageWithContext(input.message, userHistory);
  let n8nError: unknown = null;
  const n8nReplyPromise = sendChatToN8n(
    catalogueMessage === input.message ? input : { ...input, message: catalogueMessage },
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
  const diverseReply = await addDiverseProductOptions(prioritizedReply, catalogueMessage);
  const liveReply = await addLiveCatalogueState(diverseReply);
  return deduplicateReplyProducts(
    enforceLiveCheckoutGate(explainUnavailableProducts(await addAvailableAlternatives(liveReply))),
  );
}

async function processChat(input: ChatRequest) {
  const startedAt = performance.now();
  const fastReply = input.brain === "n8n" ? null : getFastChatReply(input);
  if (fastReply) {
    console.log("[api/chat] fast deterministic reply", {
      durationMs: Math.round(performance.now() - startedAt),
      stage: fastReply.stage,
    });
    return NextResponse.json(customerReply(fastReply));
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
    return NextResponse.json(customerReply(reply));
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
  const input = chatRequestSchema.safeParse(await request.json());

  if (!input.success) {
    return NextResponse.json(
      { error: "Please enter a valid product request." },
      { status: 400 },
    );
  }

  return inSessionOrder(input.data.sessionId, () => processChat(input.data));
}
