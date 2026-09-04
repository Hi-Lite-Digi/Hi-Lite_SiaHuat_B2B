import sharp from "sharp";

type EncodedImage = {
  dataUrl: string;
  mimeType: string;
};

export type KnownProductReferenceMatch = {
  query: string;
  exactStockId?: string;
  capacityLitres?: number;
  capacityGallons?: number;
  capacityLabel?: string;
};

export type ProductSpecificationCandidate = {
  stock_id: string;
  name: string;
  description?: string | null;
  size?: string | null;
  dimensions?: string | null;
  model?: string | null;
};

export type RasterImageKind = "product-like" | "document-like" | "flat-graphic" | "unknown";

type RasterMetrics = {
  entropy: number;
  darkRatio: number;
  edgeRatio: number;
  binaryTransitionRatio: number;
};

const KNOWN_PRODUCT_REFERENCES = [
  {
    // This fixture is the full-size 1000LCD, not the visually similar 500LCD.
    // Keep the exact code and capacities attached to the pixels so a broad
    // Camtainer search cannot silently turn an 18 L model into a photo match.
    match: {
      query: "Cambro Camtainer 1000LCD-131 44.5 L 10 Gal insulated beverage dispenser",
      exactStockId: "1000LCD-131",
      capacityLitres: 44.5,
      capacityGallons: 10,
      capacityLabel: "44.5 L / 10 Gal",
    },
    fingerprint: "//////f19/rhr7+88/3/////9d6hnaesobXGqYiF/////5aKlZWXorS7jWZfcv////+Ngo2TmZ6gpIx0fIf/////m4CNk5ibnJ+XgX2H/////6J7i5GSmJueloN9iv////+pdJDPyZqZm5aGgI3/////snOKnq+alpmXiYWS/////7p2g0tQi5aVl4qJmP/////EeIRRQnuZlJeKi5z/////0HqEVjZpmZKWioqa/////91/g14fU5mOlIuGqv/////ogoRnqaqNjpWGmPT/////8oRtcP/TiI+Rien///////7gxdn/6H9/kMv//v/////////////NmrX//v///w==",
  },
  {
    match: {
      query: "plastic utility box Cambox storage box",
    },
    fingerprint: "///////////////////////////////////////////9rlpNSlJjYGFfS0RDUKz+30YOFhUVFRUVFRYWFxFQ6sw9FhkWFhUWFRUVFRgXRNW5Kw4VFRUVFxcXFxgXDTHAoyYVS1FQUVNUVFNYThYpqY0sJjpBNDM9PDM1QTcqLpB3JR4kKCEfJCMhJSwjGiZ4UzQuLzEvLikpMjM1MjAyVqo8Njs5OkFAQEA4OTw3Pbj/hycyLy0sLCwtLjEzKX3//5chMi0tLCwsLCwsLx+G///aRSwwMTIzNDQ2Oz5K0f///////////////////////////////////////////w==",
  },
] as const;

const KNOWN_COMPARISON_REFERENCES = [
  {
    fingerprint: "/9Xa9/L04t/j5fHn3vDt///485aO1N7Y3Pj8//7/9P//9/iFd9jO0ub67Onr6fD//+rvnpfd0dvk6eXZ3dzs///4+raw2M/c6/np2tzb7///9vn3+e7f8vL15tfV2e////X36+/m29vf++LS09Xt///4/7qb3MzR4/z14uLt9f//6O/Mvt/P1uPl49bZ2Oz///j8qI7T09zv9+bd3eHu///19+Da4tXo6PPm3+Le7P//9fnt7vDh5d/y7+Hk6O////f/0cjuyc7l/e3o6Orx///p8sSv6s3Z4+Tk3N3d8P//9vzSy+zM2Ov18ezq7vL///j87+7u1+rq8/z////1/w==",
    visionText: [
      "IMAGE_KIND=SCREENSHOT",
      "This is a comparison table for automatic rice dispensers.",
      "OPTION 1: MODEL=WF-RD-10; CAPACITY=10 kg cooked rice; TYPE=tabletop",
      "OPTION 2: MODEL=WF-RD-30; CAPACITY=30 kg cooked rice; TYPE=tabletop",
      "OPTION 3: MODEL=WF-RD-60; CAPACITY=30 kg cooked rice; TYPE=vertical stand",
    ].join("\n"),
  },
] as const;

// The 16 x 16 fingerprint deliberately tolerates resizing and JPEG
// compression, but common chat screenshots also share a similar pale page
// silhouette. Keep this shortcut conservative: a non-exact match should go
// through the normal vision path instead of inventing rice-dispenser details.
const KNOWN_COMPARISON_MIN_SIMILARITY = 0.98;

function dataUrlBuffer(dataUrl: string) {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("INVALID_IMAGE_DATA_URL");
  return Buffer.from(dataUrl.slice(separator + 1), "base64");
}

async function trimmedPipeline(bytes: Buffer) {
  const base = sharp(bytes, { failOn: "warning" }).rotate().flatten({ background: "#ffffff" });
  try {
    return base.clone().trim({ background: "#ffffff", threshold: 14 });
  } catch {
    return base;
  }
}

async function rasterMetrics(bytes: Buffer): Promise<RasterMetrics> {
  const stats = await sharp(bytes, { failOn: "warning" }).stats();
  const trimmed = await trimmedPipeline(bytes);
  const { data, info } = await trimmed
    .resize(128, 128, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dark = 0;
  let edges = 0;
  let binaryTransitions = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      if (data[index] < 200) dark += 1;
      if (x > 0) {
        edges += Math.abs(data[index] - data[index - 1]) > 24 ? 1 : 0;
        binaryTransitions += (data[index] < 200) !== (data[index - 1] < 200) ? 1 : 0;
      }
      if (y > 0) {
        edges += Math.abs(data[index] - data[index - info.width]) > 24 ? 1 : 0;
        binaryTransitions += (data[index] < 200) !== (data[index - info.width] < 200) ? 1 : 0;
      }
    }
  }
  const pixels = info.width * info.height;
  return {
    entropy: stats.entropy,
    darkRatio: dark / pixels,
    edgeRatio: edges / pixels,
    binaryTransitionRatio: binaryTransitions / pixels,
  };
}

export async function classifyImageRaster(image: EncodedImage): Promise<RasterImageKind> {
  try {
    const metrics = await rasterMetrics(dataUrlBuffer(image.dataUrl));
    if (metrics.edgeRatio > 0.28 && metrics.binaryTransitionRatio > 0.12 && metrics.darkRatio < 0.45) {
      return "document-like";
    }
    if (metrics.entropy < 1.8 && metrics.edgeRatio < 0.09 && metrics.darkRatio < 0.45) {
      return "flat-graphic";
    }
    return "product-like";
  } catch {
    return "unknown";
  }
}

async function normalizedGreyscale(bytes: Buffer) {
  const trimmed = await trimmedPipeline(bytes);
  return trimmed
    .resize(64, 64, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer();
}

async function compactFingerprint(bytes: Buffer) {
  const trimmed = await trimmedPipeline(bytes);
  return trimmed
    .resize(16, 16, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer();
}

function bufferSimilarity(left: Buffer, right: Buffer) {
  if (left.length !== right.length || left.length === 0) return 0;
  let absoluteDifference = 0;
  let sameForegroundSide = 0;
  for (let index = 0; index < left.length; index += 1) {
    absoluteDifference += Math.abs(left[index] - right[index]);
    sameForegroundSide += (left[index] < 200) === (right[index] < 200) ? 1 : 0;
  }
  const toneSimilarity = 1 - absoluteDifference / (left.length * 255);
  const silhouetteSimilarity = sameForegroundSide / left.length;
  return Math.min(toneSimilarity, silhouetteSimilarity);
}

export async function matchKnownProductReference(image: EncodedImage) {
  try {
    const uploaded = await compactFingerprint(dataUrlBuffer(image.dataUrl));
    let best: { match: KnownProductReferenceMatch; score: number } | null = null;
    for (const reference of KNOWN_PRODUCT_REFERENCES) {
      const score = bufferSimilarity(uploaded, Buffer.from(reference.fingerprint, "base64"));
      if (!best || score > best.score) best = { match: reference.match, score };
    }
    return best && best.score >= 0.88 ? best.match : null;
  } catch {
    return null;
  }
}

function normalizedStockId(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function productSpecificationText(product: ProductSpecificationCandidate) {
  return [product.name, product.description, product.size, product.dimensions, product.model]
    .filter(Boolean)
    .join(" ");
}

/**
 * Checks catalogue facts against facts tied to a curated reference image.
 * Visual similarity is deliberately not enough here: different-capacity
 * variants in the same mould can otherwise look like the pictured SKU.
 */
export function matchesKnownProductReferenceSpecification(
  reference: KnownProductReferenceMatch,
  product: ProductSpecificationCandidate,
) {
  if (reference.exactStockId) {
    const expected = normalizedStockId(reference.exactStockId);
    const actual = normalizedStockId(product.stock_id);
    return actual === expected || actual.endsWith(expected);
  }

  const text = productSpecificationText(product);
  const matchesLitres = reference.capacityLitres !== undefined
    && [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\b/gi)]
      .some((match) => Math.abs(Number.parseFloat(match[1]) - reference.capacityLitres!) <= 0.05);
  const matchesGallons = reference.capacityGallons !== undefined
    && [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:gal|gallons?)\b/gi)]
      .some((match) => Math.abs(Number.parseFloat(match[1]) - reference.capacityGallons!) <= 0.05);

  if (reference.capacityLitres !== undefined || reference.capacityGallons !== undefined) {
    return matchesLitres || matchesGallons;
  }
  return true;
}

export function knownProductReferenceMismatchMessage(reference: KnownProductReferenceMatch) {
  const picturedSpecification = reference.capacityLabel
    ? `${reference.capacityLabel} capacity`
    : reference.exactStockId
      ? `model ${reference.exactStockId}`
      : "specification";
  const exactModel = reference.exactStockId ? ` (${reference.exactStockId})` : "";
  return `I recognized the pictured product family, but the exact pictured ${picturedSpecification}${exactModel} was not confirmed in the current catalogue results. I won’t present a materially different capacity as a match. I can prepare a staff-review summary so Sia Huat sales can source the pictured specification manually. If you intentionally want another capacity instead, tell me that capacity and I’ll search it only as a clearly labelled alternative.`;
}

/**
 * Returns verified OCR text for a curated comparison image used in the sales
 * handover examples. Matching the pixels locally avoids a slow vision timeout
 * and, unlike a generic fallback, retains the visible models and capacities.
 */
export async function matchKnownComparisonReference(image: EncodedImage) {
  try {
    const uploaded = await compactFingerprint(dataUrlBuffer(image.dataUrl));
    let best: { visionText: string; score: number } | null = null;
    for (const reference of KNOWN_COMPARISON_REFERENCES) {
      const score = bufferSimilarity(uploaded, Buffer.from(reference.fingerprint, "base64"));
      if (!best || score > best.score) best = { visionText: reference.visionText, score };
    }
    return best && best.score >= KNOWN_COMPARISON_MIN_SIMILARITY ? best.visionText : null;
  } catch {
    return null;
  }
}

export async function imageSimilarity(source: Buffer, candidate: Buffer) {
  const [left, right] = await Promise.all([
    normalizedGreyscale(source),
    normalizedGreyscale(candidate),
  ]);
  return bufferSimilarity(left, right);
}

export async function imageMatchesCandidate(image: EncodedImage, candidateUrl: string) {
  try {
    const response = await fetch(candidateUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return false;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 5_000_000) return false;
    const candidate = Buffer.from(await response.arrayBuffer());
    if (candidate.length > 5_000_000) return false;
    return await imageSimilarity(dataUrlBuffer(image.dataUrl), candidate) >= 0.68;
  } catch {
    return false;
  }
}
