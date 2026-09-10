import assert from "node:assert/strict";
import test from "node:test";
import { isGroundedAnswer, quickQuantityChoices, quickReplyLabel, withQuickReplies } from "./quick-replies";
import { productForTypedConfirmation, requestsStaffReview } from "./chat-turn";
import type { ChatReply } from "./chat-contract";

const empty: ChatReply = { message: "", stage: "clarify", products: [], selectedProduct: null, suggestions: [] };

test("photo clarification does not offer buttons that merely repeat an input instruction", () => {
  const reply = withQuickReplies({ ...empty, message: "What is the item called?", suggestions: ["Tell me the item name", "Send a clearer photo", "Choose another item"] });
  assert.deepEqual(reply.suggestions, ["Choose another item"]);
});

test("a selected-product confirmation always includes a working affirmative action", () => {
  const product = { stock_id: "G100", name: "Cutlery Gold, 100", status: "Active", list_price: 200, uom_id: "SET" };
  const reply = withQuickReplies({ ...empty, message: "Just to confirm, do you want this cutlery set?", selectedProduct: product, products: [product], suggestions: ["I want a different set"] });
  assert.deepEqual(reply.suggestions, ["Yes, this is it", "Choose another item"]);
});

test("a verified photo always offers confirmation before any product is selected", () => {
  const product = { stock_id: "CSD16C", name: "Copper Cocktail Shaker", status: "Active", list_price: 19.82, uom_id: "PC" };
  const direct = { ...empty, message: "Is that the one you meant?", products: [product], imageMatch: { source: "catalogue_image_library" as const, kind: "direct" as const, score: 1 } };
  assert.deepEqual(withQuickReplies(direct, ["No, not this one"]).suggestions, ["Yes, this is it", "Choose another item"]);
  const chinese = withQuickReplies({ ...direct, message: "是您要的这件商品吗？" });
  assert.equal(productForTypedConfirmation(chinese.suggestions[0], null, [product]), product);
  const ambiguous = { ...direct, message: "Which size do you need?", products: [product, { ...product, stock_id: "CSD24C" }], imageMatch: { ...direct.imageMatch, kind: "ambiguous" as const } };
  assert.deepEqual(withQuickReplies(ambiguous).suggestions, ["1", "2"]);
});

test("the pizza-cutter screenshot's summary offer always has a working action", () => {
  const reply = withQuickReplies({ ...empty, message: "I couldn't find a pizza cutter. Want me to put your requirements together as a summary you can share with sales?" });
  assert.deepEqual(reply.suggestions, ["Prepare sales summary", "Choose another item"]);
  assert.equal(requestsStaffReview(reply.suggestions[0]), true);
  const indirect = withQuickReplies({ ...empty, message: "I can put your specifications into a PDF to share with sales. Want me to do that?" }, ["Yes", "No"]);
  assert.equal(requestsStaffReview(indirect.suggestions[0]), true);
});

test("quick answers match the final question, not earlier product descriptions", () => {
  const text = "The mixer is white and costs $50. Is it for home baking or commercial use?";
  assert.equal(isGroundedAnswer("Home baking", text), true);
  assert.equal(isGroundedAnswer("Commercial use", text), true);
  assert.equal(isGroundedAnswer("White", text), false);
  assert.equal(isGroundedAnswer("50", text), false);
  assert.equal(isGroundedAnswer("Buy now", text), false);
  assert.equal(isGroundedAnswer("Send payment", text), false);
  assert.equal(isGroundedAnswer("A mix of both", "Will you mostly pour reds, or a mix?"), true);
  assert.equal(isGroundedAnswer("I'm open to another colour", "Is black a must, or are you open to another colour?"), true);
  assert.deepEqual(withQuickReplies({ ...empty, message: text }, ["Home baking", "Commercial use"]).suggestions, ["Home baking", "Commercial use"]);
});

test("open questions do not gain yes/no answers and Chinese choices remain usable", () => {
  assert.equal(isGroundedAnswer("Yes", "What size do you need?"), false);
  assert.equal(isGroundedAnswer("Yes, please", "Would a smaller one work?"), true);
  assert.equal(isGroundedAnswer("家用", "您需要家用还是商用？"), true);
  assert.equal(isGroundedAnswer("红色", "您需要家用还是商用？"), false);
});

test("size flexibility buttons answer the size question instead of stale actions", () => {
  const reply = withQuickReplies({ ...empty, message: "Would a smaller size work?", suggestions: ["Prepare sales summary"] });
  assert.deepEqual(reply.suggestions, ["A smaller size is fine", "Keep the original size"]);
});

test("removing products does not resurrect old numbered choices", () => {
  const reply = withQuickReplies({ ...empty, message: "What style would you prefer?" }, [], ["1", "2", "Choose another item"]);
  assert.deepEqual(reply.suggestions, ["Choose another item"]);
});

test("generated stock-check actions cannot replace product selection", () => {
  const message = "This is the cartridge I found; want me to check live stock before adding it to your enquiry?";
  assert.equal(isGroundedAnswer("Yes, check stock", message), false);
  assert.equal(isGroundedAnswer("Check live stock", message), false);
  assert.equal(isGroundedAnswer("Yes", message), false);
  const product = { stock_id: "GAS", name: "Gas cartridge", status: "Active", list_price: 3.85, uom_id: "PC" };
  const reply = withQuickReplies({ ...empty, message, products: [product] }, ["Yes, check stock"], ["1"]);
  assert.deepEqual(reply.suggestions, ["1"]);
});

test("quantity shortcuts respect known stock and remain distinct from product options", () => {
  assert.deepEqual(quickQuantityChoices(1), ["1", "Choose another item"]);
  assert.deepEqual(quickQuantityChoices(0), ["Choose another item"]);
  assert.deepEqual(quickQuantityChoices(85), ["1", "6", "12"]);
  const product = { stock_id: "P1", name: "Plate", status: "Active", list_price: 10, uom_id: "PC" };
  assert.equal(quickReplyLabel("1", [product]), "Choose option 1");
  assert.equal(quickReplyLabel("1", [], "PC"), "1 PC");
});
