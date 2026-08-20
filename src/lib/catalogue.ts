import "server-only";
import { z } from "zod";
import { productSchema, type Product } from "@/lib/chat-contract";

const productSearchSchema = productSchema.extend({ score: z.coerce.number() });

const catalogueProductSchema = productSchema.extend({ source_url: z.string().url() });

const productSelect = [
  "stock_id",
  "name",
  "brand_id",
  "status",
  "list_price",
  "uom_id",
  "source_url",
  "image_url",
  "description",
  "size",
  "dimensions",
  "brand",
  "model",
  "in_stock",
  "available_quantity",
  "stock_status",
  "category",
  "subcategory",
  "third_category",
  "last_scraped_at",
].join(",");

const productUseCases = [
  {
    key: "food-strainer",
    label: "food or noodle strainer",
    search: "noodle strainer colander",
    request: /\b(?:noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b[\s\S]*\b(?:strainer|skimmer|colander|sieve)\b|\b(?:strainer|skimmer|colander|sieve)\b[\s\S]*\b(?:noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i,
    candidate: /^(?![\s\S]*\b(?:bar|cocktail|liquor|julep|hawthorne)\b)[\s\S]*\b(?:colander|sieve|noodle\s+strainer|mesh\s+(?:skimmer|strainer)|(?:food|kitchen)\s+strainer)\b/i,
  },
  { key: "omelette-pan", label: "omelette pan", search: "omelette pan", request: /\bomele+t+e?\b/i, candidate: /\bomele+t+e?\b/i },
  { key: "crepe-pan", label: "crepe pan", search: "crepe pan", request: /\bcrepes?\b/i, candidate: /\bcrepes?\b/i },
  { key: "pancake-pan", label: "pancake pan", search: "pancake pan", request: /\bpancakes?\b/i, candidate: /\bpancakes?\b/i },
  { key: "frying-pan", label: "frying pan", search: "frying pan", request: /\b(?:fry|frying)\s*pan\b/i, candidate: /\b(?:fry|frying)\s*pan\b|\bfrypan\b|\bskillet\b/i },
  { key: "grill-pan", label: "grill pan", search: "grill pan", request: /\bgrill\s*pan\b/i, candidate: /\bgrill\s*pan\b/i },
  { key: "saucepan", label: "saucepan", search: "saucepan", request: /\bsauce\s*pan\b|\bsaucepan\b/i, candidate: /\bsauce\s*pan\b|\bsaucepan\b/i },
] as const;

export function detectProductUseCase(message: string) {
  return productUseCases.find((useCase) => useCase.request.test(message)) ?? null;
}

function searchableProductText(product: Product) {
  return [
    product.name,
    product.description,
    product.category,
    product.subcategory,
    product.third_category,
  ].filter(Boolean).join(" ");
}

export function matchesProductUseCase(product: Product, useCase: NonNullable<ReturnType<typeof detectProductUseCase>>) {
  return useCase.candidate.test(searchableProductText(product));
}

function looseToken(value: string) {
  return value.toLowerCase().replace(/([a-z0-9])\1+/g, "$1").replace(/[^a-z0-9]/g, "");
}

function brandPreferenceScore(message: string, product: Product) {
  const request = looseToken(message);
  const brandTokens = [product.brand, product.brand_id]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/[^a-z0-9]+/i))
    .map(looseToken)
    .filter((value) => value.length >= 3);
  return brandTokens.some((brand) => request.includes(brand)) ? 1 : 0;
}

export function matchesRequestedBrand(message: string, product: Product) {
  return brandPreferenceScore(message, product) > 0;
}

export function requestedBrandLabel(message: string, products: Product[]) {
  const matchedProduct = products.find((product) => matchesRequestedBrand(message, product));
  const catalogueBrand = matchedProduct?.brand ?? matchedProduct?.brand_id;
  if (catalogueBrand) return catalogueBrand.trim();

  const explicitBrand = message.match(/\b([a-z][a-z0-9-]{2,})\s+brand\b/i)?.[1];
  if (!explicitBrand) return null;
  const normalized = looseToken(explicitBrand);
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : null;
}

export function prioritizeBrand(message: string, products: Product[]) {
  return [...products].sort((a, b) => brandPreferenceScore(message, b) - brandPreferenceScore(message, a));
}

export function normalizeCatalogueQuery(message: string) {
  const ukToEuro: Record<string, string> = {
    "3": "36", "3.5": "37", "4": "37", "4.5": "38", "5": "38", "5.5": "39",
    "6": "39", "6.5": "40", "7": "41", "7.5": "41", "8": "42", "8.5": "42",
    "9": "43", "9.5": "44", "10": "44", "10.5": "45", "11": "45", "12": "46",
  };
  const corrected = message
    .replace(/\bche+f+f?\b/gi, "chef")
    .replace(/\b(?:knfie|kinife|knive)\b/gi, "knife")
    .replace(/\b(?:fryng|fryin)\b/gi, "frying")
    .replace(/\bshows\b/gi, "shoes")
    .replace(/\b(?:bananna|bannana)\b/gi, "banana")
    .replace(/\buk\s*(?:size\s*)?(\d{1,2}(?:\.5)?)\b/gi, (match, size: string) => ukToEuro[size] ? `Euro Size ${ukToEuro[size]}` : match)
    .replace(/\banot\b/gi, " ");
  const cleaned = corrected
    .replace(/\b(hey|hi|hello|sure|wait|tell me|i am|i'm|im|i|we are|we're|can you|could you|please|do you|do u|does sia huat|would you|you guys|sia huat|guys|you|your|u)\b/gi, " ")
    .replace(/\b(need|want|looking for|look for|search for|search|find me|find|show me|show|have|sell|selling|carry|stock|price|pricing|cost|how much|add|also|while|there|too|a|an|some|the|and|or|if)\b/gi, " ")
    .replace(/[^a-z0-9'\-/\s]/gi, " ")
    .replace(/\b(?:no\s+preference|any\s+material)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bknives\b/gi, "knife")
    .replace(/\bgrinders\b/gi, "grinder")
    .replace(/^\d+\s+(?=[a-z])/i, "");

  if (/\bpan\b/i.test(cleaned)) {
    const kind = detectProductUseCase(cleaned)?.search ?? cleaned.match(/\b(non[ -]?stick|frying|sauce|grill)\b/i)?.[0] ?? "";
    const colour = cleaned.match(/\b(red|yellow|blue|black|white|green|silver)\b/i)?.[0] ?? "";
    const size = cleaned.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|in)\b/i)?.[0] ?? "";
    return `${colour} ${size} ${kind}${kind.toLowerCase().endsWith("pan") ? "" : " pan"}`.replace(/\s+/g, " ").trim();
  }

  return cleaned;
}

function matchesExplicitConstraints(query: string, product: Product) {
  const requested = query.toLowerCase();
  const candidate = searchableProductText(product).toLowerCase();
  const productName = product.name.toLowerCase();
  const requiredCategories = [
    { requested: /\bchef\b.*\bknife\b|\bknife\b.*\bchef\b/, candidate: /\bchef(?:'s|s)?\s+knife\b/ },
    { requested: /\bcleaver\b/, candidate: /\bcleaver\b/ },
    { requested: /\bboning\b/, candidate: /\bboning\b/ },
    { requested: /\bparing\b/, candidate: /\bparing\b/ },
    { requested: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/, candidate: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/ },
    { requested: /\bdamascus\b/, candidate: /\bdamascus\b/ },
    { requested: /\bknife\b/, candidate: /\bknife|cleaver\b/ },
    { requested: /\bwoks?\b/, candidate: /\bwoks?\b/ },
    { requested: /\bpan\b/, candidate: /\bpan\b/ },
    { requested: /\b(?:plate|plates)\b/, candidate: /\b(?:plate|plates|platter|platters)\b/ },
    { requested: /\b(?:bowl|bowls)\b/, candidate: /\b(?:bowl|bowls)\b/ },
    { requested: /\b(?:cup|cups|mug|mugs)\b/, candidate: /\b(?:cup|cups|mug|mugs)\b/ },
    { requested: /\bwine\b.*\bglass/, candidate: /\bwine glass\b/ },
    { requested: /\bcoffee\b.*\bbeans?\b/, candidate: /\bcoffee beans\b/ },
    { requested: /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/, candidate: /\bgrinders?\b/ },
    { requested: /\b(?:stockpot|stockpots|stock\s+pots?)\b/, candidate: /\b(?:stockpot|stockpots|stock\s+pots?)\b/ },
    { requested: /\bhelmets?\b/, candidate: /\bhelmets?\b/ },
    { requested: /\b(?:electrical|electric|power)\s+(?:cable|wire)s?\b/, candidate: /\b(?:cable|wire)s?\b/ },
    { requested: /\bsafety\s+vests?\b/, candidate: /\bvests?\b/ },
    { requested: /\bsafety\s+boots?\b/, candidate: /\bboots?\b/ },
    { requested: /\b(?:shoe|shoes|footwear)\b/, candidate: /\b(?:shoe|shoes|footwear)\b/ },
    { requested: /\b(?:pants|trousers)\b/, candidate: /\b(?:pants|trousers)\b/ },
  ];

  if (requiredCategories.some((rule) => rule.requested.test(requested) && !rule.candidate.test(candidate))) return false;
  const requestedUseCase = detectProductUseCase(query);
  if (requestedUseCase && !matchesProductUseCase(product, requestedUseCase)) return false;
  if (/\bknife\b/.test(requested) && /\b(bag|holder|guard|sharpener|sharpening|block|cover|case|screw|spare|machine|thermomix|mixing)\b/.test(productName)) return false;
  if (/\b(?:japan|japanese)\b/.test(requested) && !/\b(?:japan|japanese)\b/.test(candidate)) return false;

  const requestedColour = requested.match(/\b(red|yellow|blue|black|white|green|silver)\b/)?.[1];
  if (requestedColour && !new RegExp(`\\b${requestedColour}\\b`).test(candidate)) return false;

  const requestedMetricSize = requested.match(/\b(\d+(?:\.\d+)?)\s*(cm|mm)\b/);
  if (requestedMetricSize) {
    const [, size, unit] = requestedMetricSize;
    const metricPattern = unit === "cm"
      ? new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*cm|(?=\\s*[x×]))`, "i")
      : new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*mm|(?=\\s*[x×]))`, "i");
    if (!metricPattern.test(candidate)) return false;
  }

  const requestedCapacity = requested.match(/\b(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\b/);
  if (requestedCapacity) {
    const capacity = requestedCapacity[1];
    const capacityPattern = new RegExp(`\\b${capacity}(?:\\.0+)?\\s*(?:l|litres?|liters?)\\b`, "i");
    if (!capacityPattern.test(candidate)) return false;
  }

  const requestedInchSize = requested.match(/\b(\d+(?:\.\d+)?)\s*-?\s*(?:inch|in)\b/);
  if (requestedInchSize) {
    const inches = Number.parseFloat(requestedInchSize[1]);
    const directInches = new RegExp(`\\b${requestedInchSize[1]}\\s*-?\\s*(?:inch|in|\")`, "i");
    const centimetres = inches * 2.54;
    const equivalentCm = [...new Set([
      Math.floor(centimetres),
      Math.round(centimetres),
      Math.ceil(centimetres),
    ])].some((size) => new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*cm|(?=\\s*[x×]))`, "i").test(candidate));
    if (!directInches.test(candidate) && !equivalentCm) return false;
  }

  const requestedShoeSize = requested.match(/\b(euro|us)\s+size\s+(\d{1,2}(?:\.5)?)\b/);
  if (requestedShoeSize) {
    const [, sizingSystem, size] = requestedShoeSize;
    if (!new RegExp(`\\b${sizingSystem}\\s+size\\s+${size}\\b`, "i").test(candidate)) return false;
  }

  if (/\bslip[ -]?on\b/.test(requested) && !/\bslip\b/.test(candidate)) return false;
  if (/\blace[ -]?up\b/.test(requested) && !/\blace\b/.test(candidate)) return false;

  return true;
}

export async function searchCatalogue(
  message: string,
  options: { resultLimit?: number; outputLimit?: number } = {},
) {
  const query = normalizeCatalogueQuery(message);
  if (query.length < 2) return [];

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const response = await fetch(`${url}/rest/v1/rpc/search_products`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ search_query: query, result_limit: options.resultLimit ?? 8 }),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });

  if (!response.ok) throw new Error(`SUPABASE_SEARCH_${response.status}`);

  const products = productSearchSchema.array().parse(await response.json());

  const eligible = prioritizeBrand(
    message,
    products.filter((product) => (product.status === "Active" || product.status === "New") && matchesExplicitConstraints(query, product)),
  );
  if (/\b(cheap|cheapest|lowest price|budget)\b/i.test(message)) {
    eligible.sort((a, b) => brandPreferenceScore(message, b) - brandPreferenceScore(message, a) || a.list_price - b.list_price);
  }
  return eligible.slice(0, options.outputLimit ?? 5);
}

export async function findProductForStockCheck(stockId: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const query = new URLSearchParams({
    stock_id: `eq.${stockId}`,
    select: productSelect,
    limit: "1",
  });
  const response = await fetch(`${url}/rest/v1/products?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_PRODUCT_${response.status}`);
  return catalogueProductSchema.array().parse(await response.json())[0] ?? null;
}

export async function findChefPantsCatalogue() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const query = new URLSearchParams({
    select: productSelect,
    or: "(name.ilike.*pants*,third_category.ilike.*pants*)",
    status: "in.(Active,New)",
    order: "name.asc",
    limit: "100",
  });
  const response = await fetch(`${url}/rest/v1/products?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_CHEF_PANTS_${response.status}`);
  return catalogueProductSchema.array().parse(await response.json());
}

function productVariantFamily(name: string) {
  return name
    .replace(/,?\s*(?:euro|us|uk)\s+size\s+\d+(?:\.5)?/gi, "")
    .replace(/,?\s*size\s+\d+(?:\.5)?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function broadProductTypePattern(product: Product) {
  const text = searchableProductText(product);
  const patterns = [
    /\b(?:chef\s+)?(?:pants|trousers)\b/i,
    /\b(?:shoe|shoes|footwear|boot|boots)\b/i,
    /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i,
    /\b(?:fry|frying|omelette|crepe|grill|sauce)?\s*pan\b/i,
    /\b(?:knife|knives|cleaver)\b/i,
    /\b(?:plate|plates|platter|platters)\b/i,
    /\b(?:bowl|bowls)\b/i,
    /\b(?:glass|glasses|glassware)\b/i,
    /\b(?:cup|cups|mug|mugs)\b/i,
    /\b(?:tray|trays)\b/i,
    /\b(?:pot|pots)\b/i,
  ];
  return patterns.find((pattern) => pattern.test(text)) ?? null;
}

function broadProductTypeSearch(product: Product) {
  const text = searchableProductText(product);
  if (/\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i.test(text)) return "coffee grinder";
  if (/\b(?:chef\s+)?(?:pants|trousers)\b/i.test(text)) return "chef pants";
  if (/\b(?:shoe|shoes|footwear|boot|boots)\b/i.test(text)) return "work shoes";
  if (/\b(?:fry|frying|omelette|crepe|grill|sauce)?\s*pan\b/i.test(text)) return "pan";
  if (/\b(?:knife|knives|cleaver)\b/i.test(text)) return "knife";
  if (/\b(?:pot|pots|stockpot|stockpots)\b/i.test(text)) return "pot";
  return null;
}

export async function findAvailableCatalogueAlternatives(
  stockId: string,
  limit = 3,
  minimumQuantity = 1,
) {
  const source = await findProductForStockCheck(stockId);
  if (!source) return [];

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const typePattern = broadProductTypePattern(source);
  const scopes = [
    ["third_category", source.third_category],
    ["subcategory", source.subcategory],
  ] as const;
  const candidates = new Map<string, Product>();

  for (const [field, value] of scopes) {
    if (!value?.trim()) continue;
    const query = new URLSearchParams({
      select: productSelect,
      [field]: `eq.${value}`,
      status: "in.(Active,New)",
      stock_status: "eq.in_stock",
      available_quantity: `gte.${minimumQuantity}`,
      limit: "80",
    });
    const response = await fetch(`${url}/rest/v1/products?${query}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`SUPABASE_ALTERNATIVES_${response.status}`);
    for (const product of catalogueProductSchema.array().parse(await response.json())) {
      if (product.stock_id === source.stock_id
        || product.available_quantity === null
        || product.available_quantity === undefined
        || product.available_quantity < minimumQuantity) continue;
      if (typePattern && !typePattern.test(searchableProductText(product))) continue;
      candidates.set(product.stock_id, product);
    }
  }

  const broadSearch = broadProductTypeSearch(source);
  if (broadSearch && candidates.size < limit) {
    const broadMatches = await searchCatalogue(broadSearch, { resultLimit: 80, outputLimit: 80 });
    for (const product of broadMatches) {
      if (product.stock_id === source.stock_id
        || product.stock_status !== "in_stock"
        || product.available_quantity === null
        || product.available_quantity === undefined
        || product.available_quantity < minimumQuantity) continue;
      if (typePattern && !typePattern.test(searchableProductText(product))) continue;
      candidates.set(product.stock_id, product);
    }
  }

  const requestedEuroSize = source.name.match(/\beuro\s+size\s+(\d+(?:\.5)?)\b/i)?.[1];
  const sourceFamily = productVariantFamily(source.name);
  const ranked = [...candidates.values()].sort((left, right) => {
    const exactSizeScore = (product: Product) => requestedEuroSize && new RegExp(`\\beuro\\s+size\\s+${requestedEuroSize}\\b`, "i").test(product.name) ? 1 : 0;
    return exactSizeScore(right) - exactSizeScore(left)
      || Number(right.available_quantity ?? 0) - Number(left.available_quantity ?? 0);
  });

  const selected: Product[] = [];
  const seenFamilies = new Set([sourceFamily]);
  for (const product of ranked) {
    const family = productVariantFamily(product.name);
    if (seenFamilies.has(family)) continue;
    selected.push(product);
    seenFamilies.add(family);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function findCatalogueProductByCode(stockId: string) {
  return findProductForStockCheck(stockId.trim());
}
