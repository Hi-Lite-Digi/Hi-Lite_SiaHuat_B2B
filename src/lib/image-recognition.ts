import type { ChatReply, ChatRequest } from "./chat-contract";
import { productCategory } from "./chat-intent";
import { requestedQuantity } from "./chat-turn";
import { visionImageKind } from "./image-comparison";
import type { RasterImageKind } from "./image-evidence";

export type ImageInspection = ChatReply & { imageCategory?: string | null };

/** Recognition is useful even when no exact catalogue product was verified. */
export function recognizedPhotoReply(input: ChatRequest, vision: ImageInspection, raster: RasterImageKind): ChatReply | null {
  if (raster !== "product-like" || visionImageKind(vision.message) !== "product") return null;
  // The type is separate from prose about unreadable brands/models. A clear
  // knife remains identifiable even when that sentence says its label is not.
  const identification = vision.imageCategory?.trim();
  if (!identification) return null;
  if (/\b(?:not|no|unreadable|unclear|unknown|unable|cannot|can['’]?t|could|might|maybe|possibly|perhaps)\b/i.test(identification)) return null;
  const category = productCategory(identification);
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
