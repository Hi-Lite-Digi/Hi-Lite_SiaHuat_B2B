import "server-only";
import { z } from "zod";
import { productSchema, type Product } from "@/lib/chat-contract";

const productSearchSchema = productSchema.extend({ score: z.coerce.number() });

const stockCheckProductSchema = z.object({
  stock_id: z.string(),
  source_url: z.string().url(),
});

const productUseCases = [
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
  const cleaned = message
    .replace(/\b(hey|hi|hello|sure|wait|tell me|i am|i'm|im|i|we are|we're|can you|could you|please|do you|do u|would you|you|your)\b/gi, " ")
    .replace(/\b(need|want|looking for|look for|search for|search|find me|find|show me|show|have|sell|selling|carry|stock|price|pricing|cost|how much|add|also|while|there|too|a|an|some|the|and|or|if)\b/gi, " ")
    .replace(/[^a-z0-9'\-/\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bknives\b/gi, "knife");

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
  const requiredCategories = [
    { requested: /\bchef\b.*\bknife\b|\bknife\b.*\bchef\b/, candidate: /\bchef(?:'s|s)?\s+knife\b/ },
    { requested: /\bcleaver\b/, candidate: /\bcleaver\b/ },
    { requested: /\bboning\b/, candidate: /\bboning\b/ },
    { requested: /\bparing\b/, candidate: /\bparing\b/ },
    { requested: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/, candidate: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/ },
    { requested: /\bknife\b/, candidate: /\bknife|cleaver\b/ },
    { requested: /\bpan\b/, candidate: /\bpan\b/ },
    { requested: /\bwine\b.*\bglass/, candidate: /\bwine glass\b/ },
    { requested: /\bcoffee\b.*\bbeans?\b/, candidate: /\bcoffee beans\b/ },
    { requested: /\bhelmets?\b/, candidate: /\bhelmets?\b/ },
    { requested: /\b(?:electrical|electric|power)\s+(?:cable|wire)s?\b/, candidate: /\b(?:cable|wire)s?\b/ },
    { requested: /\bsafety\s+vests?\b/, candidate: /\bvests?\b/ },
    { requested: /\bsafety\s+boots?\b/, candidate: /\bboots?\b/ },
  ];

  if (requiredCategories.some((rule) => rule.requested.test(requested) && !rule.candidate.test(candidate))) return false;
  const requestedUseCase = detectProductUseCase(query);
  if (requestedUseCase && !matchesProductUseCase(product, requestedUseCase)) return false;
  if (/\bknife\b/.test(requested) && /\b(bag|holder|guard|sharpener|sharpening|block|cover|case|screw|spare|machine|thermomix|mixing)\b/.test(candidate)) return false;

  const requestedColour = requested.match(/\b(red|yellow|blue|black|white|green|silver)\b/)?.[1];
  if (requestedColour && !new RegExp(`\\b${requestedColour}\\b`).test(candidate)) return false;

  const requestedMetricSize = requested.match(/\b(\d+(?:\.\d+)?)\s*(cm|mm)\b/);
  if (requestedMetricSize && !new RegExp(`\\b${requestedMetricSize[1]}\\s*${requestedMetricSize[2]}\\b`, "i").test(candidate)) return false;

  const requestedInchSize = requested.match(/\b(\d+(?:\.\d+)?)\s*-?\s*(?:inch|in)\b/);
  if (requestedInchSize && !new RegExp(`\\b${requestedInchSize[1]}\\s*-?\\s*(?:inch|in|\")`, "i").test(candidate)) return false;

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
    select: "stock_id,source_url",
    limit: "1",
  });
  const response = await fetch(`${url}/rest/v1/products?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_PRODUCT_${response.status}`);
  return stockCheckProductSchema.array().parse(await response.json())[0] ?? null;
}
