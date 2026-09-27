// src/lib/agent/prompt.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { replyStyleIssues } from "@/lib/reply-style";
import { SALES_CONTACT } from "./contact";
import { CLAIRE_AGENT_PROMPT } from "./prompt";

test("Claire's agent prompt carries the sales voice and the hard rules", () => {
  assert.match(CLAIRE_AGENT_PROMPT, /SIA HUAT SALES VOICE/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never take a quantity from an option number/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never say staff have been notified/);
  assert.match(CLAIRE_AGENT_PROMPT, /customer's own words/);
});

test("Claire summarises the enquiry in one line instead of listing it", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("When asked what's in the enquiry, give a one-line summary (item count and total from the context); the enquiry bar shows the lines, so don't list them."));
});

test("the update_enquiry errors Claude must explain are named in the prompt, clearing included", () => {
  for (const code of ["OUT_OF_STOCK", "OVER_STOCK", "STOCK_UNVERIFIED", "PACK_SIZE_UNKNOWN", "QTY_NOT_STATED", "UNIT_MISMATCH", "CLEAR_NOT_REQUESTED", "PRODUCT_NOT_CHOSEN"]) {
    assert.ok(CLAIRE_AGENT_PROMPT.includes(code), code);
  }
});

test("Claire never claims an item isn't carried, nothing fits a budget or a list is complete unless a search this turn backs it", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Never say an item isn't carried, that nothing fits a budget, or that a list is complete ('that's all', 'full range', 'only two sizes') unless a search in this same turn backs it: for 'we don't have it', at least two different searches (different words, including the broader product type or a category) and none fit; for a budget, a category search with max_price that returned complete true; for 'that's all', a search that returned complete true. This doesn't apply to things Sia Huat doesn't sell at all (food, cars): just say what Sia Huat supplies. Otherwise say what you found and that there may be more (total_found), and offer to narrow down. When the customer says 'show me all/more', pass the category and show options you haven't shown."));
});

test("Claire searches with the customer's words and size before saying there is no substitute", () => {
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.includes("use find_alternatives")) ?? "";
  assert.ok(line.includes("If find_alternatives returns nothing close, search with the product type and size in the customer's words (e.g. 'stock pot 12L') before saying there is no substitute. Check size and capacity against what the customer needs."));
});

test("Claire describes stock as the tools found it, keeps fitting products when the customer narrows, and sends unlisted items to sales", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't leave out a product from the tool results that fits just because it was shown before"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("'unknown' means not checked"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Not in our catalogue (you ran at least two different searches"));
});

test("Claire only states product facts the tools gave", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Only state a product's material, features, use, capacity, size, compatibility or origin if it appears in the tool facts (name, category, size, dimensions, description, details). If it isn't there, say you can't confirm it and share the product link. Read the whole description before saying a product lacks something."));
});

test("Claire reads the store's details and category the way the catalogue means them, with no brand hard-coded", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("'Country of Brand Origin' is where the brand comes from"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't call it porcelain"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Use the category to tell what a product is for"));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /Atlantic Chef|Giesser|Kikumori/);
});

test("Claire knows product cards have no photos", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Product cards show text only (name, code, price, stock, link) — no photos. If the customer wants to see a product, give its store link (the page has photos). 'Got photo?' / 'can see picture?' means the customer wants to see a photo, not that they sent one. Tapping a card chooses it."));
});

test("Claire adds a product the customer picked from any card in the chat, without a confirm step or a demand to tap", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Any card shown earlier in this chat counts"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never say the system needs a tap"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't ask them to confirm first"));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("otherwise show it as a card first"));
});

test("the old engine's one-item-at-a-time queue rule is not in the agent prompt", () => {
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /the app works through them one at a time/);
});

test("the example replies in the Choosing rule pass the reply style guard", () => {
  const choosing = CLAIRE_AGENT_PROMPT.split("\n").find((line) => line.startsWith("- Choosing:")) ?? "";
  const examples = [...choosing.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(examples.length > 0);
  for (const message of examples) {
    assert.deepEqual(replyStyleIssues({ message, products: [], selectedProduct: null }), [], message);
  }
});

test("the shared voice's example name is not in the agent prompt", () => {
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /\bMei\b/);
  assert.ok(CLAIRE_AGENT_PROMPT.includes("greet them by it once; never call them by a name they haven't typed in this chat."));
});

test("Claire never says an enquiry reserves or holds stock", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("that stock is reserved or held"));
});

test("Claire never types a raw double quote, which would cut her reply off", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never type the double-quote character"));
});

test("Claire gives only Sia Huat's sales contact, never another phone number or email", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("When asked for a phone number or email, give exactly these and set show_contact true. Never give any other phone number, email or address."));
  assert.ok(CLAIRE_AGENT_PROMPT.includes(SALES_CONTACT.phone));
  assert.ok(CLAIRE_AGENT_PROMPT.includes(SALES_CONTACT.email));
});

test("Claire uses the prices in the cards notes only to tell which product the customer means", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Use those prices only to recognise which product the customer means"));
});

test("Claire attaches a card she mentions or asks the customer to tap, and never promises to pull it up later", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("any card shown earlier in this chat can be attached again"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("card_ids (0-5 item codes from tool results in this turn, or of cards already shown in this chat)"));
});

test("Claire only reports enquiry changes that happened, never promises them, and paces a list", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Only say something was added, changed or removed after update_enquiry succeeded in this turn"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- A list of items: say how many there are, handle up to three this turn"));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /keep the rest in mind/);
});
