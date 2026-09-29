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

test("after a PRODUCT_NOT_CHOSEN refusal Claire stops retrying and asks one question naming the product, with its card", () => {
  // exam 3, c08-persona T8 and c11-stress T7: the refused add was retried, then asked about without its card.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't call it again for that product this turn"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("rather than asking them to tap or type the code"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("(\"Is it the <name> <code>?\")"));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("show the likely cards and ask which one"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never say the system needs a tap"));
});

test("Claire asks how many only after a pick, and answers a which-one question before letting them pick", () => {
  // exam 3: replies ending in a how-many question went from 40 to 73, 49 of them before any pick (c09-stress T1, c04-stress T3).
  assert.ok(CLAIRE_AGENT_PROMPT.includes("If they picked it but haven't typed how many"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("attach only the card you recommend"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("never answer a question with only a how-many question"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't ask them to confirm first"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never take a quantity from an option number"));
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

test("Claire attaches an earlier card only when it's needed, not again for an item she just changed", () => {
  // exam 3: re-shown cards rose from 170 to 472, and 61 of 87 add confirmations re-sent the card.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't attach an earlier card just because your message mentions it"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("already seen (shown_before true) for the item you changed"));
});

test("Claire only reports enquiry changes that happened, never promises them, and paces a list", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Only say something was added, changed or removed after update_enquiry succeeded in this turn"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- A list of items: say how many there are and handle only the first three this turn"));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /keep the rest in mind/);
});

test("Claire looks a list's first three items up in one response and points a long list to sales once", () => {
  // exam 3, s01-B T0: an 8-item list ran 2-3 tool rounds and got a stand-in reply.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- A list of items:")) ?? "";
  assert.ok(line.includes("look all three up in your first response (one search_catalogue call each)"));
  assert.ok(line.includes("with no second round of searches"));
  assert.ok(line.includes("In your first reply to a list of more than three items, also say once that they can send the list straight to Sia Huat sales for a formal quote (show_contact true)."));
  assert.ok(line.includes("In later turns, answer the customer's new message first"));
});

test("Claire never calls update_enquiry to check price or stock, or without a number the customer typed", () => {
  // exam 3, c09-stress T7: three update_enquiry rounds that only the customer's number could unblock.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- Changes (")) ?? "";
  assert.ok(line.endsWith("update_enquiry only changes the enquiry: never call it to check price or stock, or to note a pick without a number the customer typed; its result already has the line price and total."));
});

test("Claire asks for all her searches at once and doesn't echo the customer's budget figure", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("into one search_catalogue call"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("within your budget"));
});

test("Claire points to sales once, stops asking for a photo that doesn't arrive, and answers whether they can buy online", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Say this once"));
  // Only repeats are limited: the first request for a person or clear frustration still gets the PDF.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("After that, mention the PDF again only when"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("If it still doesn't arrive, stop asking for the photo"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Buying online: answer the question directly"));
});

test("Claire only gives store links from the tools or the chat, and handles a link that doesn't open", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("never build one from an item code"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't send that link again and don't blame their browser or network"));
});
