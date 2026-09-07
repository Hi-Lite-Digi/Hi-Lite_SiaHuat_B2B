import assert from "node:assert/strict";
import test from "node:test";
import { isGroundedAnswer, quickQuantityChoices, quickReplyLabel, withQuickReplies } from "./quick-replies";
import { requestsStaffReview } from "./chat-turn";
import type { ChatReply } from "./chat-contract";

const empty: ChatReply = { message: "", stage: "clarify", products: [], selectedProduct: null, suggestions: [] };

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

test("quantity shortcuts respect known stock and remain distinct from product options", () => {
  assert.deepEqual(quickQuantityChoices(1), ["1", "Choose another item"]);
  assert.deepEqual(quickQuantityChoices(0), ["Choose another item"]);
  assert.deepEqual(quickQuantityChoices(85), ["1", "6", "12"]);
  const product = { stock_id: "P1", name: "Plate", status: "Active", list_price: 10, uom_id: "PC" };
  assert.equal(quickReplyLabel("1", [product]), "Choose option 1");
  assert.equal(quickReplyLabel("1", [], "PC"), "1 PC");
});
