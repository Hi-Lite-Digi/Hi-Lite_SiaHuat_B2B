import { NextResponse } from "next/server";
import { chatRequestSchema, type ChatReply, type Product } from "@/lib/chat-contract";
import { sendChatToN8n } from "@/lib/n8n-client";
import {
  detectProductUseCase,
  findProductForStockCheck,
  matchesRequestedBrand,
  matchesProductUseCase,
  prioritizeBrand,
  requestedBrandLabel,
  searchCatalogue,
} from "@/lib/catalogue";
import { normalizeClaireMessage } from "@/lib/claire-voice";
import { getFastChatReply, isCatalogueRequest } from "@/lib/fast-chat";
import { fetchSiaHuatProduct } from "@/lib/siahuat-product";

export const runtime = "nodejs";

function customerReply<T extends { message: string }>(reply: T): T {
  return { ...reply, message: normalizeClaireMessage(reply.message) };
}

async function addLiveCatalogueState(reply: ChatReply): Promise<ChatReply> {
  try {
    const products = [
      ...reply.products,
      ...(reply.selectedProduct ? [reply.selectedProduct] : []),
    ];
    const liveProducts = new Map(
      await Promise.all(
        [...new Set(products.map((product) => product.stock_id))].map(async (stockId) => {
          const catalogueProduct = await findProductForStockCheck(stockId);
          if (!catalogueProduct) return [stockId, null] as const;

          try {
            const live = await fetchSiaHuatProduct(catalogueProduct.source_url);
            if (live.stock_id.toLowerCase() !== stockId.toLowerCase()) {
              throw new Error("LIVE_ITEM_CODE_MISMATCH");
            }
            return [stockId, live] as const;
          } catch (error) {
            console.error("[api/chat] early live stock check failed", { stockId, error });
            return [stockId, null] as const;
          }
        }),
      ),
    );
    const enrich = (product: Product): Product => {
      const live = liveProducts.get(product.stock_id);
      if (!live) return product;
      return {
        ...product,
        source_url: live.source_url,
        list_price: live.price_ex_gst,
        in_stock: live.in_stock,
        available_quantity: live.available_quantity,
        stock_status: live.stock_status,
        last_scraped_at: live.last_scraped_at,
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
        message: `I found ${requestedBrand ? `${requestedBrand} ` : ""}${useCase.label} options in the Sia Huat catalogue. Here are the closest matches:`,
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
          ? `The ${requestedBrand} ${useCase.label} you asked for isn't available in the Sia Huat catalogue. I found these ${useCase.label} options from other brands instead:`
          : `I found these ${useCase.label} options in the Sia Huat catalogue:`,
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
    { name: "plate", pattern: /\b(?:plate|plates|platter|platters)\b/ },
    { name: "food-pan", pattern: /\b(?:melamine\s+)?gn\s+pan\b|\bgastronorm\s+pan\b|\bfood\s+pan\b/ },
    { name: "cookware-set", pattern: /\bcookware\s+set\b|\bset\b.*\b(?:pan|pot|skillet)s?\b/ },
    { name: "pan", pattern: /\b(?:pan|pans|skillet|skillets)\b/ },
    { name: "pot", pattern: /\b(?:pot|pots|stockpot|saucepot)\b/ },
    { name: "glass", pattern: /\b(?:glass|glasses|glassware|goblet|tumbler)\b/ },
    { name: "bowl", pattern: /\b(?:bowl|bowls)\b/ },
    { name: "cup", pattern: /\b(?:cup|cups|mug|mugs)\b/ },
    { name: "machine", pattern: /\b(?:machine|machines|appliance|appliances)\b/ },
  ];
  return families.find((family) => family.pattern.test(text))?.name ?? null;
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
  return `Here are ${count} different ${pluralType} from the Sia Huat catalogue:`;
}

async function addDiverseProductOptions(reply: ChatReply, message: string): Promise<ChatReply> {
  if (reply.selectedProduct || reply.products.length <= 1 || isExactCodeRequest(message, reply.products)) {
    return reply;
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
  const availableAlternatives = enriched.products.filter(
    (product) => product.stock_id !== unavailable.stock_id
      && product.stock_status === "in_stock"
      && isSameProductType(unavailable, product),
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
        ? `${product.name} (code: ${product.stock_id}) is currently out of stock. The live Sia Huat Add to cart check shows Available: 0 ${product.uom_id}. Here ${available.length === 1 ? "is an available alternative" : "are available alternatives"} with live-confirmed stock:`
        : `${product.name} (code: ${product.stock_id}) is currently out of stock. The live Sia Huat Add to cart check shows Available: 0 ${product.uom_id}. I couldn't confirm an in-stock alternative yet. Would you like me to search again?`,
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
      message: `${product.name} (code: ${product.stock_id}) is currently out of stock. The live Sia Huat Add to cart check shows Available: 0 ${product.uom_id}. Would you like another option instead?`,
      stage: "clarify",
      suggestions: ["Choose another item", "Search again"],
    };
  }

  const codes = unavailable.map((product) => product.stock_id).join(", ");
  return {
    ...reply,
    message: available.length > 0
      ? `I checked live stock before showing these results. ${codes} ${unavailable.length === 1 ? "is" : "are"} currently out of stock. Here ${available.length === 1 ? "is an available alternative" : "are available alternatives"} with live-confirmed stock:`
      : `I found matching items, but the live Sia Huat check shows they are currently out of stock. I couldn't confirm an in-stock alternative yet. Would you like me to search again?`,
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
      ? "Please choose the exact item first. I will then confirm it, run a fresh live stock check, and only ask for a quantity after that."
      : "I can't prepare an order until an exact catalogue item is selected and its live stock has been checked. Please search for the item again.",
    stage: "clarify",
    suggestions: reply.products.length > 0 || reply.selectedProduct ? [] : ["Search again", "Search by SKU"],
  };
}

export async function POST(request: Request) {
  const input = chatRequestSchema.safeParse(await request.json());

  if (!input.success) {
    return NextResponse.json(
      { error: "Please enter a valid product request." },
      { status: 400 },
    );
  }

  const startedAt = performance.now();
  const fastReply = input.data.brain === "n8n" || input.data.image || isCatalogueRequest(input.data.message)
    ? null
    : getFastChatReply(input.data);
  if (fastReply) {
    console.log("[api/chat] fast casual reply", {
      durationMs: Math.round(performance.now() - startedAt),
      stage: fastReply.stage,
    });
    return NextResponse.json(customerReply(fastReply));
  }

  try {
    const n8nReply = keepExactCodeMatches(await sendChatToN8n(input.data), input.data.message);
    const prioritizedReply = await prioritizeRequestedUseCase(n8nReply, input.data.message);
    const diverseReply = await addDiverseProductOptions(prioritizedReply, input.data.message);
    const liveReply = await addLiveCatalogueState(diverseReply);
    const reply = enforceLiveCheckoutGate(explainUnavailableProducts(await addAvailableAlternatives(liveReply)));
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
  }
}
