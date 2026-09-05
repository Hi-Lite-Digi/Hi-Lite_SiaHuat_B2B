import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationPdfText,
  enquiryReceiptTotals,
  isConversationUiAction,
  latestEnquiryReceiptLines,
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

test("uses the latest complete set of confirmed lines for the PDF receipt", () => {
  const pot = { item: "Stock pot", code: "POT-1", pricePerItem: 10, quantity: 3, total: 30, uom: "PC" };
  const ladle = { item: "Ladle", code: "LADLE-1", pricePerItem: 4.5, quantity: 2, total: 9, uom: "PC" };
  const messages = [
    { quoteSummary: pot, quoteSummaries: [pot] },
    {},
    { quoteSummary: ladle, quoteSummaries: [pot, ladle] },
    {},
  ];

  assert.deepEqual(latestEnquiryReceiptLines(messages), [pot, ladle]);
});

test("calculates receipt line count, quantities by unit, and grand total", () => {
  const totals = enquiryReceiptTotals([
    { item: "Stock pot", code: "POT-1", pricePerItem: 10, quantity: 3, total: 30, uom: "pc" },
    { item: "Ladle", code: "LADLE-1", pricePerItem: 4.5, quantity: 2, total: 9, uom: "PC" },
    { item: "Gas cartridges", code: "GAS-1", pricePerItem: 20, quantity: 1, total: 20, uom: "CTN" },
  ]);

  assert.deepEqual(totals, {
    lineCount: 3,
    quantitiesByUom: [{ uom: "PC", quantity: 5 }, { uom: "CTN", quantity: 1 }],
    grandTotal: 59,
  });
});
