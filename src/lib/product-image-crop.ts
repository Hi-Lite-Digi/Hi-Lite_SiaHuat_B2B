import sharp from "sharp";
import type { ImageAttachment } from "./chat-contract";
import type { ProductImageBounds } from "./image-recognition";

/** Keep coordinates in the pixels actually sent to Claude, before API resizing. */
export async function prepareVisionPhoto(image: ImageAttachment) {
  const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64");
  if (bytes.length > 5_000_000) throw new Error("IMAGE_TOO_LARGE");
  const pipeline = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" }).rotate();
  const decoded = await pipeline.png().toBuffer({ resolveWithObject: true });
  // Below the standard tier's edge and patch budgets, even after 28px padding.
  const scale = Math.min(1, 1400 / Math.max(decoded.info.width, decoded.info.height), Math.sqrt(1_000_000 / (decoded.info.width * decoded.info.height)));
  const width = Math.max(1, Math.floor(decoded.info.width * scale));
  const height = Math.max(1, Math.floor(decoded.info.height * scale));
  const data = scale === 1 ? decoded.data : await sharp(decoded.data).resize(width, height).png().toBuffer();
  return { width, height, image: { mimeType: "image/png" as const, name: "photo.png", dataUrl: `data:image/png;base64,${data.toString("base64")}` } };
}

export function normalizeProductBounds(bounds: ProductImageBounds | null | undefined, width: number, height: number): ProductImageBounds | null {
  if (!bounds || width <= 0 || height <= 0) return null;
  return { left: bounds.left / width * 1000, top: bounds.top / height * 1000, right: bounds.right / width * 1000, bottom: bounds.bottom / height * 1000 };
}

/** Vision locates the photo; the existing pixel matcher still verifies identity. */
export async function cropProductPhoto(image: ImageAttachment, bounds: ProductImageBounds | null | undefined): Promise<ImageAttachment | null> {
  if (!bounds || !Object.values(bounds).every(value => Number.isFinite(value) && value >= 0 && value <= 1000)) return null;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  // Ignore tiny labels, inverted coordinates and boxes that add no useful crop.
  if (width < 50 || height < 50 || width * height < 10_000 || width * height > 950_000) return null;
  try {
    const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(",") + 1), "base64");
    if (bytes.length > 5_000_000) return null;
    const decoded = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate().flatten({ background: "#ffffff" }).png().toBuffer({ resolveWithObject: true });
    const left = Math.floor(bounds.left / 1000 * decoded.info.width);
    const top = Math.floor(bounds.top / 1000 * decoded.info.height);
    const right = Math.ceil(bounds.right / 1000 * decoded.info.width);
    const bottom = Math.ceil(bounds.bottom / 1000 * decoded.info.height);
    if (right - left < 48 || bottom - top < 48) return null;
    const region = await sharp(decoded.data).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
    // A located photo can still include a pale rounded website/chat frame.
    // Remove that margin before comparison, without changing library references.
    let cropped = region;
    try {
      const trimmed = await sharp(region).trim({ background: "#ffffff", threshold: 35 }).png().toBuffer({ resolveWithObject: true });
      if (Math.min(trimmed.info.width, trimmed.info.height) >= 48) cropped = trimmed.data;
    } catch { /* Keep the located region when no pale margin can be trimmed. */ }
    if (cropped.length > 5_000_000) return null;
    return { dataUrl: `data:image/png;base64,${cropped.toString("base64")}`, mimeType: "image/png", name: "product-photo.png" };
  } catch {
    return null;
  }
}
