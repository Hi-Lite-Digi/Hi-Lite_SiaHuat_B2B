// src/lib/agent/guards.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CheckedProduct } from "./facts";
import { allowedCents, customerMessage, removeAmounts, reviewAnswer, unverifiedAmounts } from "./guards";
import { product } from "./testing";

const seen = new Map<string, CheckedProduct>([
  ["BTS-8026D", { product: product({ stock_id: "BTS-8026D", list_price: 23.36 }), verified: true }],
  ["OLD", { product: product({ stock_id: "OLD", list_price: 99 }), verified: false }],
]);
const lines = [{ item: "Torch", code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
const allowed = allowedCents(seen, lines, 46.72);

test("cards must come from this turn's tool results", () => {
  const review = reviewAnswer({ message: "Here you go.", card_ids: ["BTS-8026D", "FAKE"], chips: [], show_contact: false }, seen, allowed);
  assert.deepEqual(review.cards.map((card) => card.stock_id), ["BTS-8026D"]);
  assert.match(review.issues.join(" "), /not found: FAKE/);
});

test("only live-checked prices and enquiry totals may appear as amounts", () => {
  assert.deepEqual(unverifiedAmounts("Noted: 2 torches, $46.72 ($23.36 each).", allowed), []);
  assert.deepEqual(unverifiedAmounts("That one is $99 and delivery is $15.", allowed), ["$99", "$15"]);
  assert.equal(removeAmounts("It's $99 now.", ["$99"]), "It's the listed price now.");
});

test("chips are short and never bare numbers", () => {
  const review = reviewAnswer({ message: "How many do you need?", card_ids: [], chips: ["2"], show_contact: false }, seen, allowed);
  assert.match(review.issues.join(" "), /never bare numbers/);
});

test("a clean answer has no issues", () => {
  const review = reviewAnswer({ message: "The Safico one is lighter. Want that one?", card_ids: ["BTS-8026D"], chips: ["Yes", "Show others"], show_contact: false }, seen, allowed);
  assert.deepEqual(review.issues, []);
});

test("staff-contact claims are removed from the customer message", () => {
  assert.doesNotMatch(customerMessage("I've notified our sales team. They will call you soon."), /will call you/);
});
