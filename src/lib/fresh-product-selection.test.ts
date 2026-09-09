import assert from "node:assert/strict";
import test from "node:test";
import { selectFreshCatalogueProduct } from "./fresh-product-selection";
import type { ChatReply } from "./chat-contract";

const draft: ChatReply = { stage: "clarify", message: "Available sets", selectedProduct: null, suggestions: [], products: [
  { stock_id: "G100", name: "Sambonet Cutlery Set, 24 Pieces, Mirror PVD Gold, 100", status: "Active", list_price: 200, uom_id: "SET", available_quantity: 1 },
  { stock_id: "GTASTE", name: "Sambonet Cutlery Set, 24 Pieces, Mirror PVD Gold, Taste", status: "Active", list_price: 210, uom_id: "SET", available_quantity: 1 },
] };
test("a collection name selects the unique catalogue product without prior cards", () => {
  assert.equal(selectFreshCatalogueProduct("give me the Gold,100", draft).selectedProduct?.stock_id, "G100");
  assert.equal(selectFreshCatalogueProduct("give me the Gold", draft).selectedProduct, null);
  assert.equal(selectFreshCatalogueProduct("Do not choose the Gold,100", draft).selectedProduct, null);
  assert.equal(selectFreshCatalogueProduct("give me the Gold,100", { ...draft, products: draft.products.map(p => ({ ...p, available_quantity: 0 })) }).selectedProduct, null);
});
