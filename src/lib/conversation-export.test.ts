import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationPdfText,
  enquiryReceiptTotals,
  isConversationUiAction,
  latestEnquiryReceiptLines,
  needsUnicodePdfRendering,
  receiptPdfText,
  wrapMeasuredText,
} from "./conversation-export";

test("keeps Chinese customer and assistant text in the PDF export source", () => {
  const text = conversationPdfText("*客户要求：*\n需要两个自动饭机。\n请人工确认库存。");

  assert.equal(text, "客户要求:\n需要两个自动饭机。\n请人工确认库存。");
  assert.equal(needsUnicodePdfRendering(text), true);
});

test("keeps catalogue symbols Helvetica can draw, so those messages are real text (r8 F4)", () => {
  const name = "Arcoroc Granity Tempered Shot Glass, 45ml-1½oz, Storplus™, Exoglass®, Ø20.3 × H1.9cm, 80 °C, •1 YEAR WARRANTY•, café, €0, 8M³/H";

  assert.equal(conversationPdfText(name), name);
  assert.equal(needsUnicodePdfRendering(conversationPdfText(name)), false);
});

test("drops emoji, with a full stop where one stood between sentences (r8 F4)", () => {
  const wave = String.fromCodePoint(0x1f44b);
  const mic = String.fromCodePoint(0x1f3a4);
  const thumbsUp = String.fromCodePoint(0x1f44d);
  const toneThumbsUp = String.fromCodePoint(0x1f44d, 0x1f3fd);
  const heart = String.fromCodePoint(0x2764, 0xfe0f);
  const check = String.fromCodePoint(0x2714, 0xfe0f);

  assert.equal(
    conversationPdfText(`Hi, I'm Claire from Sia Huat ${wave} What are you looking for today? You can send me a photo too.`),
    "Hi, I'm Claire from Sia Huat. What are you looking for today? You can send me a photo too.",
  );
  assert.equal(conversationPdfText(`${mic} Anything for a café? ${toneThumbsUp} ${heart}`), "Anything for a café?");
  assert.equal(needsUnicodePdfRendering(conversationPdfText(`Got it ${thumbsUp} Anything else? ${check}`)), false);
});

test("gives a character Helvetica lacks a form it has, else leaves it for the picture path", () => {
  const zeroWidthSpace = String.fromCodePoint(0x200b);

  assert.equal(
    conversationPdfText(`60-240℃, Aburiya Ⅱ, -40˚C, a 7″ plate, Set${zeroWidthSpace} 13cm`),
    "60-240°C, Aburiya II, -40°C, a 7\" plate, Set 13cm",
  );
  assert.equal(needsUnicodePdfRendering(conversationPdfText("≤ 2 kg")), true);
});

test("receipt text never garbles: what Helvetica can't draw becomes ?", () => {
  const c1Control = String.fromCodePoint(0x99);

  assert.equal(receiptPdfText(`PC STORPLUS${c1Control} FOOD STORAGE BOX`), "PC STORPLUS FOOD STORAGE BOX");
  assert.equal(receiptPdfText("Round Platter Ø10½xW1⅜”"), "Round Platter Ø10½xW1?\"");
  assert.equal(needsUnicodePdfRendering(receiptPdfText("客户 order")), false);
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
