import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationPdfText,
  isConversationUiAction,
  needsUnicodePdfRendering,
  wrapMeasuredText,
} from "./conversation-export";

test("keeps Chinese customer and assistant text in the PDF export source", () => {
  const text = conversationPdfText("*客户要求：*\n需要两个自动饭机。\n请人工确认库存。");

  assert.equal(text, "客户要求:\n需要两个自动饭机。\n请人工确认库存。");
  assert.equal(needsUnicodePdfRendering(text), true);
});

test("filters confirmation and rejection UI actions from staff requirements", () => {
  const labels = [
    "Yes, this is the item.",
    "Yes, this is it",
    "No, that’s not the item.",
    "No, this isn't it.",
    "No, show me others!",
    "Yes, that's the right item.",
    "是的，就是这件商品。",
    "不是，我要看其他商品。",
  ];

  labels.forEach((label) => assert.equal(isConversationUiAction(label), true, label));
  assert.equal(isConversationUiAction("No red handle; I need a blue one."), false);
});

test("wraps unspaced Chinese text without dropping any characters", () => {
  const source = "自动饭机自动饭机";
  const lines = wrapMeasuredText(source, 4, (value) => Array.from(value).length);

  assert.deepEqual(lines, ["自动饭机", "自动饭机"]);
  assert.equal(lines.join(""), source);
});
