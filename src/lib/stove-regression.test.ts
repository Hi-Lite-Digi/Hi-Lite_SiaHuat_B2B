import assert from "node:assert/strict";
import test from "node:test";
import { productCategory, catalogueMessageWithContext } from "./chat-intent";
import { namesDifferentEnquiryProduct } from "./enquiry-order";
import { recognizedPhotoReply } from "./image-recognition";
import type { Product } from "./chat-contract";
import { requestedPackagingUnit, resolveProductQuantity } from "./enquiry-quantity";
import { mergedEnquiryQuantity, checkedEnquiryLine, quantityEnquiryLine } from "./enquiry-order";
import { splitMultipleProductRequest } from "./chat-turn";
import { getFastChatReply } from "./fast-chat";

const torch: Product = { stock_id: "CB-TC-CKWH", name: "Iwatani Cassette Gas Torch Burner L16cm,White", status: "Active", uom_id: "PC", list_price: 57.71 };
const gas: Product = { stock_id: "GAS", name: "IWATANI GAS CARTRIDGE 250gm/can,3pcs/pkt,48pcs/ctn", status: "Active", uom_id: "PC", list_price: 3.85 };

test("explicit product switches preserve the full request for catalogue matching", () => {
  for (const message of ["I need GAS CARTRIDGE 12 cartons instead.", "Switch to gas cartridges", "Replace that with a CB-AK-1 cooking stove"]) {
    assert.equal(getFastChatReply({ sessionId: "switch-catalogue-test", message,
      history: [{ role: "user", content: "I need 2 gas torch burners" }] }), null, message);
  }
});

test("gas wording distinguishes the cartridge line from the torch line", () => {
  const lines = [torch, gas].map(product => checkedEnquiryLine(12, { ...product, stock_status: "in_stock", available_quantity: 1000 })!);
  assert.equal(quantityEnquiryLine("Make the gas torch burner quantity 2", lines, "GAS")?.code, torch.stock_id);
  assert.equal(quantityEnquiryLine("GAS CARTRIDGE 480 pcs", lines, torch.stock_id)?.code, "GAS");
  assert.equal(splitMultipleProductRequest("Give me GAS CARTRIDGE and GAS TORCH BURNER").length, 2);
});

test("cartridge cartons and packets convert to the catalogue selling unit", () => {
  assert.equal(requestedPackagingUnit("Yes, need GAS 12 cartons"), "carton");
  assert.equal(requestedPackagingUnit("2 packets"), "packet");
  assert.equal(requestedPackagingUnit("480 pcs"), null);
  assert.equal(resolveProductQuantity(12, "carton", gas).quantity, 576);
  assert.equal(resolveProductQuantity(2, "packet", gas).quantity, 6);
  assert.equal(resolveProductQuantity(480, null, gas).quantity, 480);
  assert.equal(resolveProductQuantity(12, "carton", torch).quantity, null);
  assert.equal(resolveProductQuantity(12, "carton", { ...gas, description: "24pcs/ctn" }).quantity, null);
  assert.equal(resolveProductQuantity(100_000, "carton", gas).quantity, null);
  assert.equal(resolveProductQuantity(12, "carton", { ...gas, uom_id: "CTN" }).quantity, 12);
  const extra = resolveProductQuantity(2, "carton", gas).quantity!;
  assert.equal(mergedEnquiryQuantity([{ code: "GAS", item: gas.name, quantity: 48, uom: "PC", pricePerItem: 3.85, total: 184.8 }], "GAS", extra, true), 144);
});

test("PDF stove and cartridge requests start a different product without an add button", () => {
  for (const message of ["GAS CARTRIDGE", "GAS CARTRIDGE 480 pcs", "GAS CARTRIDGE 12 cartons", "Yes, need GAS 12 cartons", "COOKING STOVE", "IWATANI OUTDOOR COOKING STOVE"]) {
    assert.equal(namesDifferentEnquiryProduct(message, [torch]), true, message);
  }
  assert.equal(namesDifferentEnquiryProduct("Make it 12", [torch]), false);
  assert.equal(namesDifferentEnquiryProduct("Add 2 more gas torch burners", [torch]), false);
});

test("stove type and outdoor requirement survive a torch conversation", () => {
  assert.equal(productCategory("portable camping stove"), "cooking stove");
  assert.equal(productCategory("Iwatani portable gas cooker"), "cooking stove");
  assert.equal(productCategory("gas torch burner"), "gas torch burner");
  assert.equal(catalogueMessageWithContext("Outdoor Cooking Stove", ["gas torch burner"]), "outdoor cooking stove");
  assert.equal(catalogueMessageWithContext("Commercial use", ["gas torch burner", "COOKING STOVE"]), "cooking stove");
});

test("a visible stove remains recognised even without a verified exact SKU", () => {
  const reply = recognizedPhotoReply({ sessionId: "stove-photo-test", message: "What product is this?", history: [] }, {
    message: "IMAGE_KIND=PRODUCT\nAn Iwatani portable gas stove with a carrying case. The exact model is unclear.",
    imageCategory: "portable camping stove", products: [], selectedProduct: null, stage: "clarify", suggestions: [],
  }, "product-like");
  assert.ok(reply);
  assert.match(reply.message, /cooking stove/);
  assert.equal(reply.products.length, 0);
});
