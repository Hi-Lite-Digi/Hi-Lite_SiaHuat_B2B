import { createHash } from "node:crypto";
import sharp from "sharp";

export const IMAGE_FINGERPRINT_VERSION = "raster-v1";
export const IMAGE_CANDIDATE_THRESHOLD = 0.8;
// Similarity is not a probability. Only near-identical pixels can bypass vision.
export const IMAGE_DIRECT_THRESHOLD = 0.985;
export const IMAGE_DISTINCT_MARGIN = 0.025;
const SIDE = 64;

export type CatalogueImageFingerprint = {
  contentHash: string;
  pixelHash: string;
  descriptor: string;
  vector: number[];
  aspectRatio: number;
  searchable: boolean;
};

export async function catalogueImageFingerprint(bytes: Buffer): Promise<CatalogueImageFingerprint> {
  if (bytes.length > 5_000_000) throw new Error("IMAGE_TOO_LARGE");
  const decoded = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" })
    .rotate().flatten({ background: "#ffffff" }).toColourspace("srgb")
    .png().toBuffer({ resolveWithObject: true });
  const inset = Math.min(3, Math.round(Math.min(decoded.info.width, decoded.info.height) * 0.005));
  const unframed = inset > 0
    ? await sharp(decoded.data).extract({ left: inset, top: inset, width: decoded.info.width - inset * 2, height: decoded.info.height - inset * 2 }).png().toBuffer()
    : decoded.data;
  let cropped;
  try {
    cropped = await sharp(unframed).trim({ background: "#ffffff", threshold: 14 }).png().toBuffer({ resolveWithObject: true });
  } catch {
    cropped = await sharp(unframed).png().toBuffer({ resolveWithObject: true });
  }
  const pixels = await sharp(cropped.data).resize(SIDE, SIDE, { fit: "contain", background: "#ffffff" }).removeAlpha().raw().toBuffer();
  const coarse = await sharp(pixels, { raw: { width: SIDE, height: SIDE, channels: 3 } })
    .resize(16, 16).greyscale().raw().toBuffer();
  const stats = await sharp(cropped.data).stats();
  return {
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    pixelHash: createHash("sha256").update(pixels).digest("hex"),
    descriptor: pixels.toString("base64"),
    vector: [...coarse].map(value => value / 255),
    aspectRatio: cropped.info.width / cropped.info.height,
    searchable: Math.min(decoded.info.width, decoded.info.height) >= 40
      && stats.entropy >= 1.5 && stats.channels.some(channel => channel.stdev >= 15),
  };
}

/** Compare foreground, colour, shape and proportions; blank margins cannot dominate. */
export function catalogueFingerprintSimilarity(
  left: Pick<CatalogueImageFingerprint, "descriptor" | "aspectRatio">,
  right: Pick<CatalogueImageFingerprint, "descriptor" | "aspectRatio">,
) {
  const a = Buffer.from(left.descriptor, "base64");
  const b = Buffer.from(right.descriptor, "base64");
  if (a.length !== SIDE * SIDE * 3 || b.length !== a.length) return 0;
  let difference = 0;
  let union = 0;
  let intersection = 0;
  for (let i = 0; i < a.length; i += 3) {
    const foregroundA = Math.min(a[i], a[i + 1], a[i + 2]) < 235;
    const foregroundB = Math.min(b[i], b[i + 1], b[i + 2]) < 235;
    if (!foregroundA && !foregroundB) continue;
    union += 1;
    if (foregroundA && foregroundB) intersection += 1;
    difference += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
  }
  if (union < 20 || left.aspectRatio <= 0 || right.aspectRatio <= 0) return 0;
  const colour = 1 - difference / (union * 255);
  const shape = intersection / union;
  const proportions = Math.min(left.aspectRatio, right.aspectRatio) / Math.max(left.aspectRatio, right.aspectRatio);
  return Math.max(0, Math.min(1, colour * 0.65 + shape * 0.25 + proportions * 0.1));
}

export type ScoredCatalogueImage = { sourceImageUrl: string; score: number; exact: boolean; stockIds: string[] };

export function classifyCatalogueImageMatches(matches: ScoredCatalogueImage[]) {
  const ranked = matches.filter(match => match.stockIds.length && (match.exact || match.score >= IMAGE_CANDIDATE_THRESHOLD))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  if (!ranked.length) return { kind: "none" as const, matches: [] as ScoredCatalogueImage[] };
  const best = ranked[0];
  const nearIdentical = ranked.filter(match => match.exact || match.score >= IMAGE_DIRECT_THRESHOLD);
  const identities = new Set(nearIdentical.flatMap(match => match.stockIds));
  if ((best.exact || best.score >= IMAGE_DIRECT_THRESHOLD) && identities.size > 1) {
    return { kind: "ambiguous" as const, matches: nearIdentical };
  }
  const runnerUp = ranked.find(match => match.stockIds.some(id => !best.stockIds.includes(id)));
  const distinctive = best.exact || !runnerUp || best.score - runnerUp.score >= IMAGE_DISTINCT_MARGIN;
  if ((best.exact || best.score >= IMAGE_DIRECT_THRESHOLD) && distinctive && best.stockIds.length === 1) {
    return { kind: "direct" as const, matches: [best] };
  }
  return { kind: "candidates" as const, matches: ranked.slice(0, 5) };
}
