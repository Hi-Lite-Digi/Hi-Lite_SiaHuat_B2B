import sharp from "sharp";

type EncodedImage = {
  dataUrl: string;
  mimeType: string;
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
    query: "Cambro Camtainer insulated beverage dispenser",
    fingerprint: "//////f19/rhr7+88/3/////9d6hnaesobXGqYiF/////5aKlZWXorS7jWZfcv////+Ngo2TmZ6gpIx0fIf/////m4CNk5ibnJ+XgX2H/////6J7i5GSmJueloN9iv////+pdJDPyZqZm5aGgI3/////snOKnq+alpmXiYWS/////7p2g0tQi5aVl4qJmP/////EeIRRQnuZlJeKi5z/////0HqEVjZpmZKWioqa/////91/g14fU5mOlIuGqv/////ogoRnqaqNjpWGmPT/////8oRtcP/TiI+Rien///////7gxdn/6H9/kMv//v/////////////NmrX//v///w==",
  },
  {
    query: "plastic utility box Cambox storage box",
    fingerprint: "///////////////////////////////////////////9rlpNSlJjYGFfS0RDUKz+30YOFhUVFRUVFRYWFxFQ6sw9FhkWFhUWFRUVFRgXRNW5Kw4VFRUVFxcXFxgXDTHAoyYVS1FQUVNUVFNYThYpqY0sJjpBNDM9PDM1QTcqLpB3JR4kKCEfJCMhJSwjGiZ4UzQuLzEvLikpMjM1MjAyVqo8Njs5OkFAQEA4OTw3Pbj/hycyLy0sLCwtLjEzKX3//5chMi0tLCwsLCwsLx+G///aRSwwMTIzNDQ2Oz5K0f///////////////////////////////////////////w==",
  },
] as const;

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
    let best: { query: string; score: number } | null = null;
    for (const reference of KNOWN_PRODUCT_REFERENCES) {
      const score = bufferSimilarity(uploaded, Buffer.from(reference.fingerprint, "base64"));
      if (!best || score > best.score) best = { query: reference.query, score };
    }
    return best && best.score >= 0.88 ? best.query : null;
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
