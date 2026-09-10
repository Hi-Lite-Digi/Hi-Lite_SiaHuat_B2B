import type { ChatReply, ChatRequest } from "./chat-contract";
import { productCategory } from "./chat-intent";
import { requestedQuantity } from "./chat-turn";
import { visionImageKind } from "./image-comparison";
import type { RasterImageKind } from "./image-evidence";

/** Bounds use 0..1000 coordinates after converting the vision model's pixels. */
export type ProductImageBounds = { left: number; top: number; right: number; bottom: number };
export type ImageInspection = ChatReply & { imageCategory?: string | null; imageBounds?: ProductImageBounds | null };

/** A search taxonomy is not a limit on what vision can identify. */
export function recognizedImageCategory(vision: ImageInspection): string | null {
  if (visionImageKind(vision.message) !== "product") return null;
  const identification = vision.imageCategory?.trim();
  if (!identification || /\b(?:not|no|unreadable|unclear|unknown|unidentified|unable|cannot|can['’]?t|could|might|maybe|possibly|perhaps)\b/i.test(identification)) return null;
  if (identification.length > 80 || !/^[a-z][a-z0-9 '\u2019()/-]*$/i.test(identification)) return null;
  return productCategory(identification) ?? identification.replace(/^(?:an?|the)\s+/i, "").toLowerCase();
}

/** Recognition is useful even when no exact catalogue product was verified. */
export function recognizedPhotoReply(input: ChatRequest, vision: ImageInspection, raster: RasterImageKind): ChatReply | null {
  if (raster !== "product-like" || visionImageKind(vision.message) !== "product") return null;
  // The type is separate from prose about unreadable brands/models. A clear
  // knife remains identifiable even when that sentence says its label is not.
  const category = recognizedImageCategory(vision);
  if (!category) return null;
  const quantity = requestedQuantity(input.message) ?? input.context?.quantity ?? null;
  const quantityCopy = quantity === null ? "" : ` I've kept your requested quantity of ${quantity}.`;
  return {
    message: `I can see a ${category} in your photo, but I couldn't confirm the exact model in the catalogue.${quantityCopy}\n\nWould a similar ${category} work for you?`,
    stage: "clarify",
    products: [],
    selectedProduct: null,
    suggestions: [`Find a similar ${category}`, "Only the exact model"],
  };
}
