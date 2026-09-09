import type { ChatReply } from "./chat-contract";
import { requestedDisplayedProductIndex } from "./chat-turn";

/** A named selection can resolve against fresh catalogue results even if the previous wording hid the cards. */
export function selectFreshCatalogueProduct(message: string, draft: ChatReply): ChatReply {
  if (draft.selectedProduct || !["clarify", "discover"].includes(draft.stage)
    || !/^\s*(?:give\s+me|take|choose|select|i(?:['’]ll|\s+will)?\s+take)\b/i.test(message)) return draft;
  const index = requestedDisplayedProductIndex(message, draft.products);
  if (index === null) return draft;
  const product = draft.products[index];
  if (product.stock_status === "out_of_stock" || product.available_quantity === 0) return draft;
  return { ...draft, stage: "clarify", selectedProduct: product, products: [product],
    message: `Just to confirm, do you want ${product.name}?`, suggestions: ["Yes, this is it", "Choose another item"] };
}
