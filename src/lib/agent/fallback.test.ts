// src/lib/agent/fallback.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CheckedProduct } from "./facts";
import { askedItem, buildFallbackReply } from "./fallback";
import { fakeDeps, product } from "./testing";

const torch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S" });
const griddle = product({ stock_id: "PA10313", name: "ELECTRIC GRIDDLE", third_category: "Griddles" });
const gnPans = ["1165EBK", "13100EBK", "13100EIV"].map((code) => product({ stock_id: code, name: "MELAMINE GN PAN", third_category: "Gastronorm pans" }));
const brokenBowl = product({ stock_id: "TB44810619J", name: "Royal Bali Celadon Broken Tall Bowl L17.5xW16xH17cm", third_category: "Bowls" });
const colander = product({ stock_id: "COL-30", name: "STAINLESS STEEL COLANDER 30CM", third_category: "Colanders" });
const tongs = product({ stock_id: "TONG-12", name: "STAINLESS STEEL TONGS 12IN", third_category: "Tongs" });
const blender = product({ stock_id: "BL-2L", name: "COMMERCIAL BLENDER 2L", third_category: "Blenders" });
const plates = product({ stock_id: "PL-27", name: "FINE DINING PLATES 27CM", third_category: "Plates" });
const checked = (...items: ReturnType<typeof product>[]) => new Map<string, CheckedProduct>(items.map((item) => [item.stock_id, { product: item, verified: true }]));
/** The real search ranks rows by any word: "prata pan" brought back three melamine GN pans (owner, 2026-09-30). */
function rankedDeps(catalogue: ReturnType<typeof product>[]) {
  const deps = fakeDeps(catalogue);
  deps.searchDirect = async (query) => {
    deps.calls.push(`search:${query}`);
    const asked = query.toLowerCase().split(/\s+/);
    return catalogue.filter((item) => item.name.toLowerCase().split(/\s+/).some((word) => asked.includes(word)));
  };
  return deps;
}
const SALES = "Sia Huat sales can also help (details below).";

test("the backup reply still shows matching live-checked products, with the sales contact block", async () => {
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps: fakeDeps([torch]) });
  assert.equal(reply.provider, "fallback");
  assert.equal(reply.showContact, true);
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.equal(reply.message, "Here's what I found for 'blow torch'. Want one of these, or something more specific?");
});

test("the backup reply never shows a product whose store listing was removed (r8 R01)", async () => {
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps: fakeDeps([torch], { "970S": "gone" }) });
  assert.deepEqual(reply.cards, []);
});

test("the backup reply retries a failed search once", async () => {
  const deps = fakeDeps([torch]);
  const search = deps.searchDirect;
  let attempts = 0;
  deps.searchDirect = async (query, limit) => {
    attempts += 1;
    if (attempts === 1) throw new Error("timeout");
    return search(query, limit);
  };
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps });
  assert.equal(attempts, 2);
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

test("the backup reply does not search on a no-need or cancel message, or a very short one", async () => {
  const glove = product({ stock_id: "GL1", name: "NITRILE GLOVE NO NEED HERE STILL HAVE" });
  for (const searchText of ["glove no need, here still have", "nvm", "不用了", "ok"]) {
    const deps = fakeDeps([glove]);
    const reply = await buildFallbackReply({ searchText, lines: [], deps });
    assert.deepEqual(deps.calls, [], searchText);
    assert.deepEqual(reply.cards, [], searchText);
  }
});

test("a search outage gets a short line with a next step, never 'trouble'", async () => {
  const deps = fakeDeps([torch]);
  deps.searchDirect = async () => { throw new Error("down"); };
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps });
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, `Sorry, I couldn't answer that one just now. Could you send it again, with a bit more detail if you can? ${SALES}`);
});

test("a pasted list's backup reply searches its first item and asks for the others", async () => {
  // exam 3, s01-B T0: the backup reply searched the list's first 80 characters and showed a can opener and pot lids.
  const list = "pls quote: 1) kitchen blow torch 2) gas cans 3) pot lids 4) ladles";
  const deps = fakeDeps([torch]);
  const reply = await buildFallbackReply({ searchText: list, lines: [], deps });
  assert.equal(deps.calls[0], "search:kitchen blow torch");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.equal(reply.message, "Here's what I found for your first item, 'kitchen blow torch'. Could you send the others again, a few at a time?");
  const none = await buildFallbackReply({ searchText: list, lines: [], deps: fakeDeps([]) });
  assert.deepEqual(none.cards, []);
  assert.equal(none.message, `Sorry, I couldn't go through your list just now. Could you send it again, a few items at a time? ${SALES}`);
});

test("labels with nothing between them don't make the backup reply search for nothing", async () => {
  const deps = fakeDeps([torch]);
  await buildFallbackReply({ searchText: "1) 2) kitchen blow torch", lines: [], deps });
  assert.equal(deps.calls[0], "search:kitchen blow torch");
});

test("owner 2026-09-30: 'prata pan maybe' shows no melamine GN pans and asks for more detail", async () => {
  const deps = rankedDeps([griddle, ...gnPans]);
  const reply = await buildFallbackReply({ searchText: "prata pan maybe", lines: [], deps, seen: checked(griddle) });
  assert.deepEqual(reply.cards, []);
  assert.match(reply.message, /^Sorry, I don't have a clear match to show you yet\./);
  assert.doesNotMatch(reply.message, /trouble/);
  assert.equal(reply.showContact, true);
});

test("cards this turn already found and checked are shown without another search", async () => {
  const deps = fakeDeps([torch]);
  const reply = await buildFallbackReply({ searchText: "hi got blow torch?", lines: [], deps, seen: checked(griddle, torch) });
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.deepEqual(deps.calls, []);
});

test("a card must fit the kind of product asked for: 'You are broken' is not a Celadon Broken Tall Bowl", async () => {
  const reply = await buildFallbackReply({ searchText: "You are broken.", lines: [], deps: rankedDeps([brokenBowl]) });
  assert.deepEqual(reply.cards, []);
  assert.match(reply.message, /^Sorry, I couldn't answer that one just now\./);
});

test("a follow-up, a no, a GST ask or an enquiry change gets the short line and no search", async () => {
  // exam 4, c03-A T10 "Are there others?" got "Sorry, I'm having trouble replying properly right now." and then "You are broken."
  for (const searchText of ["Are there others?", "No, this is taiwanese knife", "is the 26.60 with gst?", "change the blow torch to 3", "aiyo all same same"]) {
    const deps = rankedDeps([torch]);
    const reply = await buildFallbackReply({ searchText, lines: [], deps });
    assert.deepEqual(deps.calls, [], searchText);
    assert.match(reply.message, /^Sorry, I couldn't answer that one just now\. Could you send it again/, searchText);
  }
});

test("a word no product kind uses is never named back", async () => {
  const reply = await buildFallbackReply({ searchText: "sohai", lines: [], deps: rankedDeps([torch]) });
  assert.match(reply.message, /^Sorry, I couldn't answer that one just now\./);
});

test("a change this turn made is said from the enquiry, and a thank-you is answered", async () => {
  const line = { item: "KITCHEN BLOW TORCH 970S", code: "970S", pricePerItem: 10, quantity: 2, total: 20, uom: "PC" };
  const shop = fakeDeps([torch]);
  const added = await buildFallbackReply({ searchText: "2 blow torch", lines: [line], deps: shop, changes: [{ action: "add", code: "970S" }] });
  assert.equal(added.message, "Done: 2 PC KITCHEN BLOW TORCH 970S (970S) is on your enquiry. Anything else?");
  assert.deepEqual(added.cards, []);
  assert.deepEqual(shop.calls, []); // no cards go with the Done line, so none are searched for
  assert.equal(added.showContact, false);
  const removed = await buildFallbackReply({ searchText: "remove the torch", lines: [], deps: fakeDeps([torch]), changes: [{ action: "remove", code: "970S" }], seen: checked(torch) });
  assert.equal(removed.message, "Done: KITCHEN BLOW TORCH 970S is off your enquiry. Anything else?");
  const thanks = await buildFallbackReply({ searchText: "Thank you", lines: [], deps: fakeDeps([torch]), thanks: true });
  assert.equal(thanks.message, "You're welcome! Anything else I can help with?");
});

test("the customer's item words drop filler and quantities", () => {
  assert.deepEqual(askedItem("prata pan maybe"), { label: "prata pan", naming: ["prata", "pan"] });
  assert.deepEqual(askedItem("hi got blender ah"), { label: "blender", naming: ["blender"] });
  assert.deepEqual(askedItem("need 2 commercial blenders pls"), { label: "commercial blenders", naming: ["blender"] });
  assert.deepEqual(askedItem("need damascus chef knife 3pcs"), { label: "damascus chef knife", naming: ["damascus", "chef", "knife"] });
  // A size typed with a space keeps its number, and chat words ("I'll", "recommendations", "for my shop") name nothing (review D5+D6).
  assert.deepEqual(askedItem("frying pan 24 cm"), { label: "frying pan 24cm", naming: ["frying", "pan", "24cm"] });
  assert.deepEqual(askedItem("I'll need a crepe pan").naming, ["crepe", "pan"]);
  assert.deepEqual(askedItem("I want some recommendations for plates").naming, ["plate"]);
  assert.deepEqual(askedItem("ok. got wok? need 4 for zichar").naming, ["wok"]);
  assert.deepEqual(askedItem("got cordless 3 in 1 blender").naming, ["cordless", "blender"]); // "3 in 1" is no 3-inch size
});

test("'stock' and 'delivery' name products too: 'stock pot' is no chilli pot, and 'got stock?' is still shop talk (review D5+D6)", async () => {
  const stockPot = product({ stock_id: "SP-30", name: "Stainless Steel Stock Pot", third_category: "Stock pots" });
  const chilliPot = product({ stock_id: "K197", name: "PLC CHILLI POT", third_category: "Condiment pots" });
  const canvasBag = product({ stock_id: "30351", name: "ROUND CANVAS BAG", third_category: "Bags" });
  for (const searchText of ["stock pot", "got stock pot?"]) {
    const reply = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([stockPot, chilliPot]) });
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["SP-30"], searchText);
  }
  const zipperBags = product({ stock_id: "922.68", name: "VACUUM ZIPPER BAGS", third_category: "Bags" });
  // "got delivery bag?" asks for a delivery bag, which no bag card is (review D5+D6 recheck).
  for (const searchText of ["delivery bag", "got delivery bag?", "any delivery bags?"]) {
    const bag = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([canvasBag, zipperBags]) });
    assert.deepEqual(bag.cards, [], searchText);
  }
  for (const searchText of ["blow torch got stock?", "blow torch in stock?", "blow torch can delivery?"]) {
    const reply = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([torch]) });
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"], searchText);
  }
  const deps = rankedDeps([torch, canvasBag]);
  const delivery = await buildFallbackReply({ searchText: "Got delivery?", lines: [], deps });
  assert.deepEqual(deps.calls, []);
  assert.deepEqual(delivery.cards, []);
});

test("a size typed with a space, or a word about the shop, still finds the item (review D5+D6)", async () => {
  const crepe = product({ stock_id: "CR-24", name: "Crepe Pan Ø24cm", third_category: "Crepe pans" });
  for (const searchText of ["24 cm crepe pan", "crepe pan for my shop pls", "I'll need a crepe pan"]) {
    const reply = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([crepe]) });
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["CR-24"], searchText);
  }
});

test("a brand word counts only when the whole brand is typed: 'chef knife' is no Atlantic Chef oyster opener (review D5+D6)", async () => {
  const oyster = product({ stock_id: "9100G15", name: "Atlantic Chef Oyster Opener/Knife", brand: "ATLANTIC CHEF", third_category: "Oyster knives" });
  const chefKnife = product({ stock_id: "1201F05", name: "Atlantic Chef Chef Knife 21cm", brand: "ATLANTIC CHEF", third_category: "Chef knives" });
  const reply = await buildFallbackReply({ searchText: "chef knife", lines: [], deps: rankedDeps([oyster, chefKnife]) });
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["1201F05"]);
  const branded = await buildFallbackReply({ searchText: "atlantic chef knife", lines: [], deps: rankedDeps([oyster]) });
  assert.deepEqual(branded.cards.map((card) => card.stock_id), ["9100G15"]);
});

test("a message about Claire is no product ask: 'you are a tool' shows no leaf tool (review D5+D6)", async () => {
  const leafTool = product({ stock_id: "CH3", name: "STAINLESS STEEL LEAF TOOL", third_category: "Garnishing tools" });
  for (const searchText of ["you are a tool", "you're a tool", "u r a tool", "you so stupid"]) {
    const deps = rankedDeps([leafTool]);
    const reply = await buildFallbackReply({ searchText, lines: [], deps });
    assert.deepEqual(deps.calls, [], searchText);
    assert.deepEqual(reply.cards, [], searchText);
    assert.doesNotMatch(reply.message, /tool/i, searchText);
  }
  // A thank-you before a product question is no talk about Claire (review D5+D6 recheck).
  const crepe = product({ stock_id: "CR-24", name: "Crepe Pan Ø24cm", third_category: "Crepe pans" });
  for (const searchText of ["thank you so much! got crepe pan?", "thank u so much, got crepe pan?", "thx u so much, got crepe pan?", "tq u so much got crepe pan"]) {
    const reply = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([crepe]) });
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["CR-24"], searchText);
  }
});

test("an item asked for in other words never gets 'couldn't find', and an insult is never named back (r6 skeptic a)", async () => {
  const cases: Array<[string, ReturnType<typeof product>]> = [["Colander/strainer", colander], ["need tongs for cooking, stainless one", tongs], ["stupid blender", blender]];
  for (const [searchText, item] of cases) {
    const reply = await buildFallbackReply({ searchText, lines: [], deps: rankedDeps([colander, tongs, blender]), seen: checked(item) });
    assert.doesNotMatch(reply.message, /couldn['’]t find/i, searchText);
    assert.doesNotMatch(reply.message, /stupid/i, searchText);
    assert.doesNotMatch(reply.message, /trouble/i, searchText);
  }
});

test("'want' is not a no: a wanted item is searched, 'dont want' and 'didn't add' are not (r6 skeptic b)", async () => {
  for (const searchText of ["I want to get fine dining plates", "i want cooking tongs"]) {
    const deps = rankedDeps([plates, tongs]);
    await buildFallbackReply({ searchText, lines: [], deps });
    assert.notDeepEqual(deps.calls, [], searchText);
  }
  for (const searchText of ["i dont want serving tongs", "didn't add"]) {
    const deps = rankedDeps([plates, tongs]);
    await buildFallbackReply({ searchText, lines: [], deps });
    assert.deepEqual(deps.calls, [], searchText);
  }
});

test("'or not' asks about the item before it; 'added or not' and a GST ask search nothing (r6 skeptic c)", async () => {
  for (const searchText of ["hi got blow torch or not?", "blow torch or not ah?"]) {
    const deps = rankedDeps([torch]);
    const reply = await buildFallbackReply({ searchText, lines: [], deps, seen: checked(torch) });
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"], searchText);
    assert.deepEqual(deps.calls, [], searchText);
  }
  for (const searchText of ["added or not", "got gst inside or not"]) {
    const quiet = rankedDeps([torch]);
    const none = await buildFallbackReply({ searchText, lines: [], deps: quiet });
    assert.deepEqual(quiet.calls, [], searchText);
    assert.deepEqual(none.cards, [], searchText);
  }
});

test("a describing word the cards needn't carry is never named back (r6 skeptic d)", async () => {
  const reply = await buildFallbackReply({ searchText: "cheap blender", lines: [], deps: rankedDeps([blender]) });
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["BL-2L"]);
  assert.equal(reply.message, "Here's what I found. Want one of these, or something more specific?");
});

test("a card tap or a photo gets its own next step (r6 skeptic f)", async () => {
  const tap = await buildFallbackReply({ searchText: null, lines: [], deps: fakeDeps([torch]), event: "tap" });
  assert.equal(tap.message, `Sorry, I couldn't open that one just now. Could you tap it again? ${SALES}`);
  assert.equal(tap.showContact, true);
  const photo = await buildFallbackReply({ searchText: null, lines: [], deps: fakeDeps([torch]), event: "photo" });
  assert.equal(photo.message, `Sorry, I couldn't check your photo just now. Could you send it again, or tell me what the item is? ${SALES}`);
});
