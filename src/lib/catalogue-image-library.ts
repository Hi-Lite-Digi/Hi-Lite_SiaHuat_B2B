import "server-only";
import { z } from "zod";
import { findCatalogueProductByCode } from "./catalogue";
import type { ChatReply, ImageAttachment, Product } from "./chat-contract";
import { productCategory } from "./chat-intent";
import { matchesShakerRequest } from "./catalogue-query";
import {
  catalogueImageFingerprint, catalogueFingerprintSimilarity, classifyCatalogueImageMatches,
  IMAGE_FINGERPRINT_VERSION, type ScoredCatalogueImage,
} from "./catalogue-image-fingerprint";

const rowSchema = z.object({
  source_image_url: z.string().url(), content_sha256: z.string(), pixel_sha256: z.string(),
  descriptor: z.string().max(20_000), aspect_ratio: z.number().positive(),
  products: z.array(z.object({ stock_id: z.string(), name: z.string() })).nullable(),
});

export type CatalogueImageLookup = {
  kind: "direct" | "ambiguous" | "candidates";
  matches: ScoredCatalogueImage[];
  products: Product[];
  totalProducts: number;
};

/** Read-only full-catalogue lookup. Any outage retains the existing vision route. */
export async function lookupCatalogueImage(image: ImageAttachment): Promise<CatalogueImageLookup | null> {
  if (process.env.CATALOGUE_IMAGE_LOOKUP_ENABLED === "false") return null;
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) return null;
  const started = performance.now();
  try {
    const fingerprint = await catalogueImageFingerprint(Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64"));
    if (!fingerprint.searchable) return null;
    const response = await fetch(`${base}/rest/v1/rpc/match_catalogue_images`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(2_000),
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ query_fingerprint: JSON.stringify(fingerprint.vector), query_content_hash: fingerprint.contentHash,
        query_pixel_hash: fingerprint.pixelHash, query_version: IMAGE_FINGERPRINT_VERSION, result_limit: 24 }),
    });
    if (!response.ok) throw new Error(`IMAGE_LIBRARY_HTTP_${response.status}`);
    const rows = rowSchema.array().parse(await response.json());
    const scored: ScoredCatalogueImage[] = rows.map(row => ({
      sourceImageUrl: row.source_image_url,
      score: catalogueFingerprintSimilarity(fingerprint, { descriptor: row.descriptor, aspectRatio: row.aspect_ratio }),
      exact: row.content_sha256 === fingerprint.contentHash || row.pixel_sha256 === fingerprint.pixelHash,
      stockIds: (row.products ?? []).map(product => product.stock_id),
    }));
    const result = classifyCatalogueImageMatches(scored);
    if (result.kind === "none") {
      console.info("[image-library] no match", { elapsedMs: Math.round(performance.now() - started), bestScore: Math.max(0, ...scored.map(row => row.score)) });
      return null;
    }
    const ids = [...new Set(result.matches.flatMap(match => match.stockIds))];
    // A reused generic catalogue photo can represent dozens of variants.
    // Preserve that ambiguity instead of promoting the first three as exact.
    const resolved = await Promise.all(ids.slice(0, 5).map(id => findCatalogueProductByCode(id)));
    const products = resolved.filter((product): product is NonNullable<typeof product> => Boolean(product
      && (product.status === "Active" || product.status === "New")
      && result.matches.some(match => match.sourceImageUrl === product.image_url && match.stockIds.includes(product.stock_id))));
    if (!products.length) return null;
    console.info("[image-library] match", { kind: result.kind, score: result.matches[0].score,
      totalProducts: ids.length, codes: products.map(product => product.stock_id), elapsedMs: Math.round(performance.now() - started) });
    return { ...result, products, totalProducts: ids.length };
  } catch (error) {
    console.warn("[image-library] fallback to vision", { reason: error instanceof Error ? error.message : "lookup failed" });
    return null;
  }
}

export function directCatalogueImageReply(result: CatalogueImageLookup, chinese = false): ChatReply | null {
  if (result.kind === "candidates") return null;
  const imageMatch = { source: "catalogue_image_library" as const, kind: result.kind, score: result.matches[0].score };
  if (result.totalProducts > 3) return {
    message: chinese ? "这张目录图片被多个商品型号共用。请告诉我您需要的商品代码或尺寸。"
      : "This catalogue photo is shared by several product variants. What product code or size do you need?",
    products: [], selectedProduct: null, stage: "clarify", suggestions: [], imageMatch,
  };
  const single = result.kind === "direct" && result.products.length === 1;
  return {
    message: single
      ? chinese ? `我在司合发目录中找到了这张图片对应的商品：${result.products[0].name}（${result.products[0].stock_id}）。是您要的这件吗？`
        : `I found this photo in Sia Huat’s catalogue: ${result.products[0].name} (${result.products[0].stock_id}). Is this the item you mean?`
      : chinese ? "以下目录商品共用相同或几乎相同的图片。您需要哪个型号或尺寸？"
        : "These catalogue items use the same or nearly identical photo. Which model or size do you need?",
    products: result.products.slice(0, 3), selectedProduct: null, stage: "clarify",
    suggestions: single ? [chinese ? "是的，就是这件商品。" : "Yes, this is the item."] : [], imageMatch,
  };
}

/** Vision must independently support the family before a merely similar image is offered. */
export function visionValidatedLibraryReply(result: CatalogueImageLookup | null, category: string | null | undefined, description: string): ChatReply | null {
  if (!result || result.kind !== "candidates" || !category) return null;
  const family = productCategory(category);
  if (!family) return null;
  const products = result.products.filter(product => productCategory(product.name) === family
    && (family !== "shaker" || matchesShakerRequest(description, product.name))).slice(0, 3);
  if (!products.length) return null;
  return { message: "These are visually similar catalogue options. The exact model in the photo is not confirmed. Which item would you like to check?",
    products, selectedProduct: null, stage: "clarify", suggestions: [] };
}
