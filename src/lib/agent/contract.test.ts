// src/lib/agent/contract.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import { CHIP_PREFIX, HISTORY_ENTRY_CHARS, MAX_MESSAGE_CHARS, NO_CAPTION, PHOTO_PREFIX, TAP_PREFIX, agentReplySchema, agentRequestSchema, cardsNote, cardsToPick, historyFor, nextEnquiry, parseCardsNote, tappedCode, withoutCardsNote, type ChatBubble } from "./contract";
import { product } from "./testing";

test("a card tap is a product choice, never text", () => {
  const parsed = agentRequestSchema.parse({ sessionId: "session-1234", event: { type: "select_product", stockId: "BTS-8026D" } });
  assert.equal(parsed.event.type, "select_product");
  assert.deepEqual(parsed.history, []);
  assert.deepEqual(parsed.enquiry, []);
  assert.deepEqual(parsed.shownProductIds, []);
});

test("request limits are enforced", () => {
  const ok = (value: unknown) => agentRequestSchema.safeParse(value).success;
  assert.equal(ok({ sessionId: "short", event: { type: "text", text: "hi" } }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "x".repeat(MAX_MESSAGE_CHARS + 1) } }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: [{ stockId: "A", quantity: 0 }] }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: [{ stockId: "A", quantity: 2 }] }), true);
});

test("a long pasted brief goes through whole, as text or a photo's caption, and stays whole in the history (r8 F7)", () => {
  // Stress test F7 (3 Oct): a 616-character brief was cut at 500 and lost its last clause, the S$10 budget.
  const budget = "CRITICAL REQUIREMENT: no items over S$10 each.";
  const brief = `${"I am sourcing tableware for a busy restaurant. ".repeat(50).slice(0, MAX_MESSAGE_CHARS - budget.length)}${budget}`;
  assert.equal(brief.length, 2_000);
  const parse = (event: unknown, history: unknown[] = []) => agentRequestSchema.safeParse({ sessionId: "session-1234", event, history }).success;
  const image = { dataUrl: "data:image/png;base64,AA", mimeType: "image/png", name: "plate.png" };
  assert.equal(parse({ type: "text", text: brief }), true);
  assert.equal(parse({ type: "text", text: `${brief}x` }), false);
  assert.equal(parse({ type: "image", image, caption: brief }), true);
  assert.equal(parse({ type: "image", image, caption: `${brief}x` }), false);
  const history = historyFor([{ role: "user", text: brief, imageUrl: image.dataUrl }, { role: "assistant", text: "Here are some plates." }]);
  assert.equal(history[0].content, `${PHOTO_PREFIX} ${brief}`);
  assert.equal(parse({ type: "text", text: "and bowls" }, history), true);
});

test("an enquiry echo may carry up to 60 lines", () => {
  const echo = (count: number) => Array.from({ length: count }, (_, index) => ({ stockId: `A${index}`, quantity: 1 }));
  const ok = (count: number) => agentRequestSchema.safeParse({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: echo(count) }).success;
  assert.equal(ok(60), true);
  assert.equal(ok(61), false);
});

test("reply schema accepts the server's reply shape", () => {
  const reply = agentReplySchema.parse({
    message: "Noted.", cards: [], chips: [], showContact: false, provider: "anthropic",
    enquiry: { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } },
  });
  assert.equal(reply.provider, "anthropic");
});

test("the browser keeps its own copy of lines the server could not re-check", () => {
  const torch = { item: "TORCH", code: "970S", pricePerItem: 31.31, quantity: 2, total: 62.62, uom: "PC" };
  const pan = { item: "PAN", code: "PAN-1", pricePerItem: 10.1, quantity: 1, total: 10.1, uom: "PC" };
  const current = { lines: [torch, pan], totals: { lineCount: 2, quantitiesByUom: [{ uom: "PC", quantity: 3 }], grandTotal: 72.72 } };
  const reply = { lines: [{ ...pan, pricePerItem: 10.2, total: 10.2 }], totals: { lineCount: 1, quantitiesByUom: [{ uom: "PC", quantity: 1 }], grandTotal: 10.2 }, unchecked: ["970s"] };
  assert.deepEqual(nextEnquiry(current, reply), {
    lines: [{ ...pan, pricePerItem: 10.2, total: 10.2 }, torch],
    totals: { lineCount: 2, quantitiesByUom: [{ uom: "PC", quantity: 3 }], grandTotal: 72.82 },
  });
  const checked = { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } };
  assert.equal(nextEnquiry(current, checked), checked);
});

test("sales contact is a real Singapore number and a Sia Huat email, never a placeholder (r8 F2)", () => {
  assert.match(SALES_CONTACT.phone, /^\+65 [3689]\d{3} \d{4}$/);
  assert.doesNotMatch(SALES_CONTACT.email, /[[\]]/);
  assert.match(SALES_CONTACT.email, /^[\w.+-]+@siahuat\.com(?:\.sg)?$/);
});

const torch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31, source_url: "https://store.siahuat.com/product/1234" });
const uncheckedCard = product({ stock_id: "X", stock_status: "unknown", source_url: "https://store.siahuat.com/product/99" });

test("the cards note carries each checked card's price and link, and leaves an unchecked price out", () => {
  assert.equal(cardsNote([torch, uncheckedCard]), "\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <https://store.siahuat.com/product/1234>; X Product X <https://store.siahuat.com/product/99>]");
  assert.equal(cardsNote([]), "");
});

test("the note reads back as the same cards", () => {
  const noLink = { ...product({ stock_id: "PAN-1", name: "FRY PAN", list_price: 5 }), source_url: null };
  const content = `Hi.${cardsNote([torch, uncheckedCard, noLink])}`;
  assert.deepEqual(parseCardsNote(content), [
    { code: "970S", name: "KITCHEN BLOW TORCH 970S", price: 31.31, link: "https://store.siahuat.com/product/1234" },
    { code: "X", name: "Product X", price: null, link: "https://store.siahuat.com/product/99" },
    { code: "PAN-1", name: "FRY PAN", price: 5, link: null },
  ]);
  assert.equal(withoutCardsNote(content), "Hi.");
  assert.deepEqual(parseCardsNote("Hi."), []);
});

test("older notes without prices or links still read", () => {
  assert.deepEqual(parseCardsNote("Two options.\n[cards shown: 970S KITCHEN BLOW TORCH 970S; BTS-8026D]"), [
    { code: "970S", name: "KITCHEN BLOW TORCH 970S", price: null, link: null },
    { code: "BTS-8026D", name: "", price: null, link: null },
  ]);
});

test("a note listing more cards than a reply can show is read as its first 5", () => {
  const note = `[cards shown: ${Array.from({ length: 8 }, (_, i) => `C${i} Card ${i}`).join("; ")}]`;
  assert.deepEqual(parseCardsNote(note).map((card) => card.code), ["C0", "C1", "C2", "C3", "C4"]);
});

test("a name with a semicolon or a leading bracket survives", () => {
  const sock = product({ stock_id: "CS-4", name: '(26-01688) COFFEE SOCK; 4"', list_price: 2.5, source_url: "https://store.siahuat.com/product/77" });
  assert.deepEqual(parseCardsNote(`Here.${cardsNote([sock, torch])}`), [
    { code: "CS-4", name: '(26-01688) COFFEE SOCK, 4"', price: 2.5, link: "https://store.siahuat.com/product/77" },
    { code: "970S", name: "KITCHEN BLOW TORCH 970S", price: 31.31, link: "https://store.siahuat.com/product/1234" },
  ]);
});

test("'Tap a product' shows only while a card isn't on the enquiry yet", () => {
  // exam 3: "Tap a product to choose it." sat under "Got it: 2 ... added" with only that card (judged templated, c12-stress T5).
  const ut09l = product({ stock_id: "UT09L" });
  const other = product({ stock_id: "2564L" });
  assert.equal(cardsToPick([ut09l], [{ code: "UT09L" }]), false);
  assert.equal(cardsToPick([ut09l, other], [{ code: "ut09l" }]), true);
  assert.equal(cardsToPick([], []), false);
});

test("a card tap's history entry gives its item code", () => {
  assert.equal(tappedCode("[tap] Picked: Cassette Gas Torch (Safico) (code BTS-8026D)"), "BTS-8026D");
  assert.equal(tappedCode("[tap] Picked: Blow Torch (code 970S)  "), "970S");
  assert.equal(tappedCode("[tap] Picked: Blow Torch"), null);
});

test("the history the browser sends: the last 30 bubbles, each marked and capped, with the cards note kept", () => {
  const earlier = Array.from({ length: 23 }, (_, index): ChatBubble => ({ role: "user", text: `earlier ${index}` }));
  const bubbles: ChatBubble[] = [
    { role: "user", text: "too old 1" },
    { role: "user", text: "too old 2" },
    ...earlier,
    { role: "assistant", text: "Hi, I'm Claire from Sia Huat. What are you looking for today?" },
    { role: "user", text: "Picked: KITCHEN BLOW TORCH 970S (code 970S)", tap: true },
    { role: "user", text: "Folding tables", chip: true },
    { role: "user", text: "Bro then what is this", imageUrl: "data:image/png;base64,AA" },
    { role: "user", text: "", imageUrl: "data:image/png;base64,AA" },
    { role: "assistant", text: "x".repeat(HISTORY_ENTRY_CHARS + 100), cards: [torch] },
    { role: "assistant", text: "" },
  ];
  const note = cardsNote([torch]);
  assert.deepEqual(historyFor(bubbles), [
    ...earlier.map((bubble) => ({ role: "user", content: bubble.text })),
    { role: "assistant", content: "Hi, I'm Claire from Sia Huat. What are you looking for today?" },
    { role: "user", content: `${TAP_PREFIX} Picked: KITCHEN BLOW TORCH 970S (code 970S)` },
    { role: "user", content: `${CHIP_PREFIX} Folding tables` },
    { role: "user", content: `${PHOTO_PREFIX} Bro then what is this` },
    { role: "user", content: `${PHOTO_PREFIX} ${NO_CAPTION}` },
    { role: "assistant", content: `${"x".repeat(HISTORY_ENTRY_CHARS - note.length)}${note}` },
  ]);
});

test("a failed photo's line reads as a plain statement in the history", () => {
  // Owner, 2 Oct: after a photo got lost Claire read her own "Sorry, my reply didn't come through" and said she never got one.
  assert.deepEqual(historyFor([
    { role: "user", text: "Bro then what is this", imageUrl: "data:image/png;base64,AA" },
    { role: "assistant", text: "Sorry, that photo didn't come through. Could you send it again? Sia Huat sales can also help (details below).", historyText: "That photo didn't come through on my side." },
  ]), [
    { role: "user", content: `${PHOTO_PREFIX} Bro then what is this` },
    { role: "assistant", content: "That photo didn't come through on my side." },
  ]);
});
