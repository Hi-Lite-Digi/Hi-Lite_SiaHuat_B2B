import assert from "node:assert/strict";
import test from "node:test";
import { confirmationMessage, enquirySummaryMessage, stockLimitMessage, stockUnconfirmedMessage, suggestionLabel } from "./enquiry-copy";
import { requestsStaffReview } from "./chat-turn";
import { replyStyleIssues } from "./reply-style";

test("confirmation and stock messages stay short, ask one question and retain exact quantities", () => {
  for (const language of ["en", "zh"] as const) {
    for (const message of [confirmationMessage(2, "PC", language), stockLimitMessage(18, 17, "PC", language), stockLimitMessage(1, 0, "SET", language), stockUnconfirmedMessage(2, "PC", language)]) {
      assert.deepEqual(replyStyleIssues({ message, products: [], selectedProduct: null }), []);
      assert.ok(message.length < 180);
      assert.equal((message.match(/[?？]/g) ?? []).length, 1);
    }
  }
  assert.match(stockLimitMessage(18, 17, "PC", "en"), /17 PC[\s\S]*18 PC/);
  assert.doesNotMatch(stockLimitMessage(1, 0, "SET", "en"), /smaller|0 SET/);
});

test("compact enquiry copy keeps codes, quantities, unit prices and accurate totals", () => {
  const lines = [
    { item: "Knife", code: "K-1", quantity: 2, pricePerItem: 44.5, total: 89, uom: "PC" },
    { item: "Glass", code: "G-1", quantity: 3, pricePerItem: 20.09, total: 60.27, uom: "PC" },
  ];
  const message = enquirySummaryMessage(lines);
  assert.match(message, /2 PC × \$44.50 = \$89.00/);
  assert.match(message, /3 PC × \$20.09 = \$60.27/);
  assert.match(message, /K-1/);
  assert.match(message, /G-1/);
  assert.match(message, /149.27.*ex GST/);
  const completed = enquirySummaryMessage(lines, true);
  assert.match(completed, /Nothing has been ordered yet/);
  assert.doesNotMatch(completed, /[?？]/);
});

test("friendly sales-summary buttons still activate the supported manual workflow", () => {
  for (const label of ["Prepare staff review summary", "准备人工审核摘要"]) {
    assert.equal(requestsStaffReview(suggestionLabel(label)), true);
  }
});

test("quality checks catch references to missing cards and repeated phrases", () => {
  for (const message of ["These two came up in smaller sizes. Would that work?", "Gold instead of black\ninstead of black: would that work?", "What size? What material?", "Would a different colour or a smaller size work?", "Noted. Kindly select a product."]) {
    assert.ok(replyStyleIssues({ message, products: [], selectedProduct: null }).length > 0, message);
  }
});
