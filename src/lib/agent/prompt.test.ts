// src/lib/agent/prompt.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { catalogueRanges } from "@/lib/catalogue-ranges";
import { replyStyleIssues } from "@/lib/reply-style";
import { SALES_CONTACT } from "./contact";
import { withGstCents } from "./enquiry";
import { CLAIRE_AGENT_PROMPT, renderRanges } from "./prompt";

test("Claire's agent prompt carries the sales voice and the hard rules", () => {
  assert.match(CLAIRE_AGENT_PROMPT, /SIA HUAT SALES VOICE/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never take a quantity from an option number/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never say staff have been notified/);
  assert.match(CLAIRE_AGENT_PROMPT, /customer's own words/);
});

test("asked to list the enquiry, Claire lists its lines and the total; asked only for the total, she gives the total", () => {
  // r4 c09-persona idx 14-15: asked twice to list it, she gave the count and total (3 of 3 right in the P5 replays after).
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- When asked what's in the enquiry or to list it, list each line briefly (quantity and short name) and the total, from the Current enquiry context. When they ask only for the total, give the total."));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("so don't list them"));
});

test("Claire quotes the enquiry totals from the context, unless it lists unchecked lines", () => {
  // Not while it lists unchecked lines: those totals leave them out (the unchecked note says not to quote a total).
  assert.ok(CLAIRE_AGENT_PROMPT.includes("that a tool did not return in this turn; the totals in the Current enquiry context count, so quote them without a tool call, unless it lists unchecked lines."));
});

test("asked for an amount with GST, Claire gives code's estimate and never works one out herself", () => {
  // Owner decision 2: exam 4, 18 of the 19 chats that asked about GST were refused. The own-figure wording cut MONEY repairs on
  // r4 c09-stress idx 13 from 2 of 3 to 0 of 4; the last clause keeps "There's an unchecked line" from the customer.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- GST:")) ?? "";
  assert.ok(line.startsWith("- GST: prices, line totals and the enquiry total are before GST; 9% GST is added at checkout. Asked for an amount with GST, give the system's estimate straight away"));
  for (const words of ["grandTotalWithGst", "gstOnTotal", "price_with_gst", "never write it back", "Never work out a GST amount yourself", "without mentioning checks or unchecked lines"]) {
    assert.ok(line.includes(words), words);
  }
  // The example's figures are code's own for a neutral $50.00 total.
  assert.ok(line.includes(`'About $${(withGstCents(50) / 100).toFixed(2)} with GST (GST $${((withGstCents(50) - 5000) / 100).toFixed(2)}); the checkout or Sia Huat's quote shows the exact amount.'`));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /Don't work out an amount with GST yourself/);
});

test("the update_enquiry errors Claude must explain are named in the prompt, clearing and the pick check's included", () => {
  for (const code of ["OUT_OF_STOCK", "OVER_STOCK", "STOCK_UNVERIFIED", "PACK_SIZE_UNKNOWN", "QTY_NOT_STATED", "UNIT_MISMATCH", "CLEAR_NOT_REQUESTED", "REMOVE_REFUSED", "SWAP_NOT_DONE",
    "PICKED_OTHER", "QTY_NOT_FOR_ITEM", "NOT_PICKED", "PICK_UNCLEAR", "PICK_UNCONFIRMED", "PICK_UNCHECKED"]) {
    assert.ok(CLAIRE_AGENT_PROMPT.includes(code), code);
  }
  // The word-rule gate's code is gone with the gate.
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /PRODUCT_NOT_CHOSEN/);
});

test("Claire never claims an item isn't carried, nothing fits a budget or a list is complete unless a search this turn backs it", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Never say an item isn't carried, that nothing fits a budget, or that a list is complete ('that's all', 'full range', 'only two sizes') unless a search in this same turn backs it: for 'we don't have it', at least two different searches (different words, including the broader product type or a category) and none fit; for a budget, a category search with max_price that returned complete true; for 'that's all', a search that returned complete true. This doesn't apply to things Sia Huat doesn't sell at all (food, cars): just say what Sia Huat supplies. Otherwise say what you found and that there may be more (don't quote how many), and offer to narrow down. When the customer says 'show me all/more', pass the category and show options you haven't shown."));
  // exam 3: "(total_found)" led to 11 replies quoting a match count.
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /\(total_found\)/);
});

test("equipment named in words the catalogue may not use gets the closest products and one question, or sales (r6 area N)", () => {
  // Owner's chat, 2026-09-30: "if it searches and cannot find something similar to a prata pan, it can apologise and ask for more
  // description." In the area-N runs 4-5 of 10 first replies to such names had no card and a bare "I couldn't find it".
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- Equipment the customer names in words the catalogue may not use")) ?? "";
  // Only when no result has their name: the catalogue lists 'Thai Style Claypot', 'Takoyaki Plate' and 'U-SHAPE NOODLE STRAINER',
  // and the guard lets a one-word "we don't list anything called 'claypot'" through (review of D11).
  for (const words of ["not food, which Sia Huat doesn't sell", "the item's usual English name", "Don't search their words again",
    "search once more with other words for the job", "if a result has their name for it, show it; if none does, say plainly we don't list anything called '<their exact words>'",
    "closest products that do the same job as cards with a one-line reason each drawn from the tool facts", "one short question about one thing", "set show_contact true",
    "source it", "Never reply with only 'I couldn't find it'", "show them now"]) {
    assert.ok(line.includes(words), words);
  }
});

test("Claire searches with the customer's words and size before saying there is no substitute", () => {
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.includes("use find_alternatives")) ?? "";
  assert.ok(line.includes("If find_alternatives returns nothing close, search with the product type and size in the customer's words (e.g. 'stock pot 12L') before saying there is no substitute. Check size and capacity against what the customer needs."));
});

test("Claire describes stock as the tools found it, keeps fitting products when the customer narrows, and sends unlisted items to sales", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't leave out a product from the tool results that fits just because it was shown before"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("'not checked' never means out of stock"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Not in our catalogue (you ran at least two different searches"));
});

test("Claire only states product facts the tools gave for that product, and works out no fits or throughputs herself", () => {
  // exam 4: another plate's '220°C', the MX1200's drinks a day for the MX1000, '12″ vs 25cm is close' (s01-B), pans per shelf.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Only state a product's material, features, use, capacity, size, compatibility or origin if it appears in that product's own tool facts (name, category, size, dimensions, description, details). Never carry a spec over from a similar product, and never work out a throughput (drinks a day), place settings, pans per shelf or whether one item fits another yourself; if the facts don't say, say Sia Huat sales can confirm and share the product link. Never say one size is close to, fits in, or is longer than another unless both sizes are in the facts and the comparison holds in one unit (1in = 2.54cm). Read the whole description before saying a product lacks something."));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("If it isn't there, say you can't confirm it and share the product link."));
});

test("Claire's wording on rankings, stock per item code, origin, series, earlier cards and cheaper asks (exam 4, P4-F5)", () => {
  const lineWith = (start: string) => CLAIRE_AGENT_PROMPT.split("\n").find((line) => line.startsWith(start)) ?? "";
  assert.ok(lineWith("- 'The cheapest', 'the biggest', 'the only'").endsWith(" Price-order words ('the cheapest', 'the most budget', 'next up in price') and summaries of the range by brand, origin or material are whole-range claims too. Stock is per item code: one colour or size being out of stock says nothing about its brand or its other colours; name an out-of-stock product by its item code."));
  assert.ok(lineWith("- details are the store's own fields.").endsWith(" A customer asking for <country> knives or <country>-made items wants brands from there: search the product type and check 'Country of Brand Origin' in each result's details; never say we have no <country> brand when a tool result this turn shows one."));
  assert.ok(lineWith("- Extras and matches:").endsWith(" To find matching pieces, search the series by its brand and series name."));
  assert.ok(lineWith("- Cards:").includes("Describe stock only as each product's stock field and available_quantity say, for that item code; give the current figure and don't guess why it differs from an earlier one; 'not checked' never means out of stock."));
  assert.ok(lineWith("- The [cards shown: …] notes").endsWith(" 'the other one' or a feature of an earlier card is about cards already shown: get_product those cards and check their facts before searching for new products."));
  assert.ok(lineWith("- Nearest match:").endsWith(" When they say a price is too high or ask for cheaper, search the category with max_price below the price they turned down."));
  // No exam answers written into the prompt, no Gastronorm fit rule (owner question 10), and no "say it was your mistake". The
  // generated range list names the catalogue's own sections ("Gastronorm/steam pans"), so only the written rules are checked.
  const rules = CLAIRE_AGENT_PROMPT.replace(renderRanges(catalogueRanges), "");
  for (const words of ["Global", "Diwali", "Gastronorm", "your mistake"]) assert.ok(!rules.includes(words), words);
});

test("Claire keeps to the facts on extras, sizes, matches, superlatives and the nearest match (exam 3)", () => {
  // exam 3: "comes with removable whisks", a 10in strainer called 8in, "the cheapest" of a partial list, an unrelated "matching"
  // bowl, 12QT never searched as 12L, and alternatives picked for stock rather than closeness.
  for (const words of [
    "never say the product comes with them", "Copy sizes exactly", "same series only when", "is never an origin",
    "use them only with complete true", "of the ones I found", "never say we only carry some of them", "covers more than its available_quantity",
    "not the most stocked or the cheapest", "exact match first, whatever the brand", "search '12L'", "exclude_brands",
    "For 'not <brand or country>', search the category with exclude_brands.",
  ]) {
    assert.ok(CLAIRE_AGENT_PROMPT.includes(words), words);
  }
});

test("Claire reads the store's details and category the way the catalogue means them, with no brand hard-coded", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("'Country of Brand Origin' is where the brand comes from"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't call it porcelain"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Use the category to tell what a product is for"));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /Atlantic Chef|Giesser|Kikumori/);
});

test("Claire knows product cards have no photos, and what to do when a store page has none", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Product cards show text only (name, code, price, stock, link) — no photos. If the customer wants to see a product, give its store link (the page has photos). If they say the page opens but has no photo, say that store page has no photo, describe the product from the tool facts and offer Sia Huat sales for photos (show_contact true). 'Got photo?' / 'can see picture?' means the customer wants to see a photo, not that they sent one. Tapping a card chooses it."));
});

test("Claire's wording on links, pushback, searches, threats, orders she can't see and a website they can't use (exam 4, P5)", () => {
  const lineWith = (start: string) => CLAIRE_AGENT_PROMPT.split("\n").find((line) => line.startsWith(start)) ?? "";
  // r4 c08-stress idx 4-5: a link that didn't open got "search the code on the store".
  assert.ok(lineWith("- Links:").endsWith(" give the item code and offer Sia Huat sales for photos (show_contact true) or a similar product. Don't tell them to search the store for it."));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("they can search it on the store"));
  assert.ok(lineWith("- Don't repeat cards").endsWith(" Never repeat the same question or the same cards after the customer pushes back ('these are not sets', 'then u still ask?'); change approach instead: recommend one from what they've told you, or say plainly what we don't have and offer Sia Huat sales. Ask a narrowing question (size, slots, budget) once; if they don't answer it or say either is fine, recommend one instead of asking again."));
  assert.ok(lineWith("- Don't restate the enquiry").endsWith(" Don't narrate your searches ('I ran two searches', 'I checked again'): say what you found."));
  // r4 c05-A idx 8 (police): 3 of 3 right in the P5 replays, against 0 of 2 before.
  assert.ok(lineWith("- The customer is annoyed").endsWith(" If they say you never said sorry, apologise. Never scold ('let's keep it civil'), never argue with what they said about you ('I'm not broken', 'no wrongdoing here'), and never answer a complaint with 'No worries'. A threat (police, a complaint, a bad review): one short apology and Sia Huat sales (show_contact true), and nothing else that turn (no joke, no defence, no cards) unless the same message asks a question: then answer just that question too. In any reply, never laugh or joke ('ha', 'haha'), and don't open with filler ('Fair enough', 'Fair point', 'Good question', 'To be upfront', 'I get that, but')."));
  // r4 s07-A idx 1-3: 'Any update on this order?' and 'please send invoice' (3 of 3 right in the P5 replays, against 0 of 2).
  assert.ok(lineWith("- Existing orders").endsWith(" If they seem to think this chat placed an order or sent their enquiry to Sia Huat ('any update on this order?', 'send the invoice'), say plainly once that nothing from this chat has reached Sia Huat yet: it stays an enquiry until they send the PDF to Sia Huat sales or contact them."));
  // r4 c04-stress idx 13 ('or must go down') and c08-stress idx 11-13 ('i cant even open ur website').
  assert.ok(lineWith("- Buying online:").endsWith(" and don't state delivery, collection, payment or account terms, not even whether they need to come down: when they ask about one, say Sia Huat sales can confirm it. Offer to keep building the enquiry here. If they say they can't open or use the website, don't point them to the store or checkout again: they can send the enquiry PDF (or just contact) Sia Huat sales to order (show_contact true)."));
});

test("Claire adds a product the customer picked from any card in the chat, without a confirm step or a demand to tap", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Any card shown earlier in this chat counts"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("never say a check or system is involved"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't ask them to confirm first"));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("otherwise show it as a card first"));
});

test("after a pick-check refusal Claire stops retrying and does what its code says, never mentioning the check", () => {
  // exam 3, c08-persona T8 and c11-stress T7: the refused add was retried, then asked about without its card.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- update_enquiry checks each add")) ?? "";
  assert.ok(line.startsWith("- update_enquiry checks each add, change and removal against the chat. PICKED_OTHER: the customer picked that product instead: send the same change for it, with picked.quantity."));
  assert.ok(line.includes("NOT_PICKED: they haven't asked for it: answer what they said, don't add it and don't ask them to confirm it."));
  assert.ok(line.includes("PICK_UNCLEAR: attach the fitting cards and ask which one, naming them (X or Y?)."));
  assert.ok(line.includes("ask one short question naming the product with its code ('Is it the <name> <code>?') with its card; a yes or a tap then adds it."));
  assert.ok(line.endsWith("Don't call update_enquiry again for a refused product this turn, and never say a check or system is involved."));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("show the likely cards and ask which one"));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("if its picked list names the product they mean"));
});

test("Claire removes only a line the customer asked to take off, and sends a swap as an add plus a remove", () => {
  // r4 c09-persona idx 11: the old line came off while the new one was refused.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- Changes (")) ?? "";
  assert.ok(line.includes("go through update_enquiry. Remove only a line the customer asked to take off. A swap is an add of the new item plus a remove of the old one in the same response; the old line comes off only after the new one is on. Report its result truthfully."));
  assert.ok(line.includes("CLEAR_NOT_REQUESTED, REMOVE_REFUSED, SWAP_NOT_DONE)"));
});

test("Claire asks how many only after a pick, and answers a which-one question before letting them pick", () => {
  // exam 3: replies ending in a how-many question went from 40 to 73, 49 of them before any pick (c09-stress T1, c04-stress T3).
  assert.ok(CLAIRE_AGENT_PROMPT.includes("If they picked it but haven't typed how many"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("attach only the card you recommend"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("never answer a question with only a how-many question"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't ask them to confirm first"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never take a quantity from an option number"));
});

test("a number given only as a condition for a discount isn't an order, but a take or a quote with a number still is (owner, 2 Oct)", () => {
  // "If i get 3, can i get a better price?" added 3 ice shavers ($9,238.08); "4 x 5.69 how much la" and "quote me 50" stay picks.
  const choosing = CLAIRE_AGENT_PROMPT.split("\n").find((line) => line.startsWith("- Choosing:")) ?? "";
  assert.ok(choosing.includes("A number given only as a condition for a discount or a better price"));
  assert.ok(choosing.includes("is not an order: don't call update_enquiry; say discounts and bulk prices are quoted by Sia Huat sales (show_contact true), never promise or guess one, and ask if they want the N on their enquiry for that quote; a yes adds it."));
  assert.ok(choosing.includes("is still a pick"));
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
  assert.ok(CLAIRE_AGENT_PROMPT.includes("card_ids (0-6 item codes from tool results in this turn, or of cards already shown in this chat)"));
});

test("Claire attaches an earlier card only when it's needed, not again for an item she just changed", () => {
  // exam 3: re-shown cards rose from 170 to 472, and 61 of 87 add confirmations re-sent the card.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Don't attach an earlier card just because your message mentions it"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("already seen (shown_before true) for the item you changed"));
  // exam 4: a how-many question re-attached a card shown twice; the pick check reads the chat, so the card isn't needed.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("To ask how many of a product, name it; don't attach its card again."));
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("ask about one product (whether it's the one they mean, or how many)"));
});

test("Claire only reports enquiry changes that happened, never promises them, and paces a list", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Only say something was added, changed or removed after update_enquiry succeeded in this turn"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- A list of items: say how many there are and handle up to six this turn"));
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /keep the rest in mind/);
});

test("Claire looks up to six list items up in one response and points a long list to sales once", () => {
  // exam 3, s01-B T0: an 8-item list ran 2-3 tool rounds and got a stand-in reply. r8 M03, M09: a list of six got only the first three.
  const line = CLAIRE_AGENT_PROMPT.split("\n").find((item) => item.startsWith("- A list of items:")) ?? "";
  assert.ok(line.includes("handle up to six this turn: look them all up in your first response (one search_catalogue call each)"));
  assert.ok(line.includes("with no second round of searches"));
  assert.ok(line.includes("A list of item codes (up to 12): one get_product call each, all in your first response"));
  // The owner's round-4 default: the sales pointer stays at more than three.
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
  // exam 3, c06-stress T4: the customer's "2 dollar" was echoed, then rewritten by the money check.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("calls a product by its price ('the 2 dollar one'), don't repeat their figure"));
});

test("Claire points to sales once, stops asking for a photo that doesn't arrive, and answers whether they can buy online", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Say this once"));
  // Only repeats are limited: the first request for a person or clear frustration still gets the PDF.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("After that, mention the PDF again only when"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("If it still doesn't arrive, stop asking for the photo"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("- Buying online: answer the question directly"));
});

test("Claire says plainly she is an AI, apologises before answering a complaint, and doesn't repeat herself (exam 3)", () => {
  // exam 3: 0 of 6 bot questions got a plain answer (c02), 'let's keep it civil' and 'Haha' to annoyed customers (c02-B,
  // c01-stress), the enquiry restated in reply after reply (c09-persona), and one get_product per round.
  for (const words of [
    "automated sales assistant (an AI)", "- Asked if you're a bot, an AI or a real person: answer that first",
    "start with one short, plain apology", "Never scold ('let's keep it civil')", "after any apology, set show_contact true",
    "Don't restate the enquiry (its items or total)", "several get_product calls at once are fine",
    "unless they give new details", "name it in a few words; don't restate the enquiry",
  ]) {
    assert.ok(CLAIRE_AGENT_PROMPT.includes(words), words);
  }
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("add one short pointer to the next step"));
});

test("Claire only gives store links from the tools or the chat, and handles a link that doesn't open", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("never build one from an item code"));
  assert.ok(CLAIRE_AGENT_PROMPT.includes("don't send that link again and don't blame their browser or network"));
});

test("asked for a new chat, Claire points to the New chat button and clears the enquiry only when asked", () => {
  // Reset check (2026-10-01): typed "reset" only got "Your enquiry is already empty", and typed "new chat" was ignored.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("say in a few words that the New chat button at the top starts a fresh one. Clear the enquiry (update_enquiry) only when they asked to clear it, start over or reset; 'new chat' alone isn't that."));
});

test("the catalogue's ranges render one line per range, each section with its types in brackets", () => {
  const ranges = renderRanges([
    ["Furniture & Banquet Equipment", [["Hotel Equipment", ["Q-posts"]], ["Tables", ["Folding tables", "Lazy susans"]]]],
    ["Books", [["Guides", []]]],
  ]);
  assert.equal(ranges, "- Furniture & Banquet Equipment: Hotel Equipment (Q-posts); Tables (Folding tables, Lazy susans)\n- Books: Guides");
});

test("Claire is given every range the catalogue lists and never denies a whole one (owner, 2 Oct: furniture)", () => {
  // "How about furniture" got "We don't carry dining tables or chairs here", and a queue stand was "not that exact one",
  // while the store lists Furniture & Banquet Equipment with Q-posts.
  // Each assert.ok has a message: a failing one without it hung the runner while it built its own.
  assert.ok(catalogueRanges.length > 0, "no ranges");
  for (const [range] of catalogueRanges) assert.ok(CLAIRE_AGENT_PROMPT.includes(`\n- ${range}: `), range);
  assert.ok(CLAIRE_AGENT_PROMPT.includes(`\n\nSIA HUAT'S CATALOGUE RANGES (range: section (types); ...)\n${renderRanges(catalogueRanges)}\n\nHOW YOU WORK\n`), "range list");
  const lines = CLAIRE_AGENT_PROMPT.split("\n");
  assert.ok(lines[0].endsWith("Sia Huat supplies kitchen, tableware, bar, buffet and F&B equipment, and the other ranges listed below, to restaurants, cafes, hotels and home cooks in Singapore."), lines[0]);
  const rule = lines[lines.findIndex((line) => line.startsWith("- Broad request (")) + 1];
  assert.ok(rule.startsWith("- A request for a whole range or section in SIA HUAT'S CATALOGUE RANGES, or in other words for one ('furniture', 'uniforms', 'housekeeping stuff'): "), rule);
  assert.ok(rule.includes("never say we don't carry it, even when a search with the customer's words misses it"), rule);
  assert.ok(rule.includes("Say in one line what it covers, naming a few types from the list, and ask which type they need (up to 3 type names as chips); show products once they choose."), rule);
  assert.ok(rule.includes("(a queue stand is a Q-post) is a specific request: search with that type as category."), rule);
});

test("shown she was wrong about what we carry, Claire says they're right in one line and, for a whole range, names its sections and asks (owner, 2 Oct)", () => {
  // Shown the store's Furniture & Banquet page, Claire said "Sorry about that" and pushed folding-table cards; called misleading,
  // she only pointed to sales.
  const lines = CLAIRE_AGENT_PROMPT.split("\n");
  const at = lines.findIndex((line) => line.startsWith("- Shown you were wrong about equipment we carry"));
  assert.ok(at > 0, "no line for being shown wrong");
  assert.ok(lines[at - 1].startsWith("- The customer is annoyed"), lines[at - 1]);
  for (const words of [
    "check it this turn (match_photo for a photo, get_product for a link, else a search)",
    "'You're right, sorry: we do carry <it>.'",
    "don't defend the earlier answer or add what we don't carry unless they asked for it",
    "For a whole range (or a photo of a range page), name its sections from SIA HUAT'S CATALOGUE RANGES in one sentence and ask which they need, with no cards until they say; for a type or item, answer as usual.",
    "if you were wrong, give the corrected answer",
  ]) assert.ok(lines[at].includes(words), words);
  // The line points at the range list, so both must be in the prompt.
  assert.ok(CLAIRE_AGENT_PROMPT.includes("SIA HUAT'S CATALOGUE RANGES ("), "range list heading");
  assert.ok(!CLAIRE_AGENT_PROMPT.includes("no 'but we don't carry"), "no ban on true facts");
  assert.deepEqual(replyStyleIssues({ message: "You're right, sorry: we do carry <it>.", products: [], selectedProduct: null }), []);
});
