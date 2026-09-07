import type { ChatReply, ChatRequest } from "./chat-contract";
import { productCategory } from "./chat-intent";
import { requestedQuantity } from "./chat-turn";
import { visionImageKind } from "./image-comparison";
import type { RasterImageKind } from "./image-evidence";

/** Recognition is useful even when no exact catalogue product was verified. */
export function recognizedPhotoReply(input: ChatRequest, vision: ChatReply, raster: RasterImageKind): ChatReply | null {
  if (raster !== "product-like" || visionImageKind(vision.message) !== "product") return null;
  // Only a positive identification at the start of the pixel description counts.
  // Later mentions may describe rejected guesses, packaging, or alternatives.
  const identification = vision.message
    .replace(/^\s*IMAGE[_\s-]*KIND\s*[:=]\s*PRODUCT\s*/i, "")
    .split(/[.!?\n]/)[0].trim();
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
