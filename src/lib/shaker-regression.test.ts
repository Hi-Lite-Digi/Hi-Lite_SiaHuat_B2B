import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem } from "./chat-contract";
import { photoCatalogueQuery } from "./photo-catalogue-query";
import { catalogueHistoryWithClarification, catalogueMessageWithContext } from "./chat-intent";
import { answersNoPreference } from "./catalogue-followup";
import { matchesShakerRequest } from "./catalogue-query";
import { getFastChatReply } from "./fast-chat";
import { requestedQuantity } from "./chat-turn";

const history: HistoryItem[] = [
  {role: "user", content: "what is this item ?"},
  {role: "assistant", content: "That photo looks like a copper/rose-gold cocktail shaker with a domed cap and built-in strainer. Would you like a cocktail shaker, or something else like a colander?"},
  {role: "user", content: "You have it in stock ?"},
  {role: "assistant", content: "I can't confirm stock on that exact shaker since I couldn't match it to a specific catalogue item. If you'd like, tell me what you're after—like a cocktail shaker in a certain size or finish—and I'll check what we've got."},
];
const preference = "Got it, 16oz. I couldn't pull up a matching cocktail shaker in that size just now. Do you have a preferred finish, like copper or stainless steel, so I can narrow it down?";

test("a shaker's built-in strainer does not change the search to colanders", () => {
  const description = "IMAGE_KIND=PRODUCT\nA copper/rose-gold cocktail shaker, Cobbler-style, with a domed cap, built-in strainer and tapered body.";
  assert.equal(photoCatalogueQuery(description, "cocktail shaker"), "copper cobbler cocktail shaker");
  assert.equal(photoCatalogueQuery(description), "copper cobbler cocktail shaker");
  assert.equal(photoCatalogueQuery("A food strainer next to a shaker", "food strainer"), "food strainer skimmer colander");
  assert.equal(photoCatalogueQuery("Knife blades inside an electric coffee grinder", "coffee grinder"), "coffee grinder");
});

test("a photo's size and stock follow-ups retain its category without adopting suggested finishes", () => {
  const query = catalogueMessageWithContext("like the picture, 16oz", catalogueHistoryWithClarification("like the picture, 16oz", history));
  assert.match(query, /cocktail shaker/);
  assert.match(query, /16oz/);
  assert.doesNotMatch(query, /colander|copper|stainless/);
  const continued: HistoryItem[] = [...history, {role:"user",content:"like the picture, 16oz"}, {role:"assistant",content:preference}];
  const anyFinish = catalogueMessageWithContext("no", catalogueHistoryWithClarification("no", continued));
  assert.match(anyFinish, /cocktail shaker/);
  assert.match(anyFinish, /16oz/);
  assert.doesNotMatch(anyFinish, /copper|stainless/);
  assert.equal(getFastChatReply({sessionId:"shaker-test",message:"no",history:continued}), null);
  assert.match(getFastChatReply({sessionId:"shaker-test",message:"cancel",history:continued})!.message, /cancelled/);
});

test("no preference differs from rejecting a product or cancelling, and fresh enquiries stay fresh", () => {
  assert.equal(answersNoPreference("no", preference), true);
  assert.equal(answersNoPreference("cancel", preference), false);
  assert.equal(answersNoPreference("no", "Would you like to buy this copper shaker?"), false);
  assert.equal(answersNoPreference("no", "Do you prefer copper or stainless steel?"), false);
  const query = catalogueMessageWithContext("I want a wok", catalogueHistoryWithClarification("I want a wok", history));
  assert.doesNotMatch(query, /shaker|16oz|copper/);
  const switched: HistoryItem[] = [...history, {role:"user",content:"I need a wok"}, {role:"assistant",content:"What size wok?"}];
  assert.doesNotMatch(catalogueMessageWithContext("30cm", catalogueHistoryWithClarification("30cm", switched)), /shaker/);
});

test("16oz copper shakers exclude other capacities and finishes, including plausible lookalikes", () => {
  const request = "16oz copper cocktail shaker";
  assert.equal(matchesShakerRequest(request, "3PC COCKTAIL SHAKERS 16oz, COPPER PLATED, DELUX"), true);
  assert.equal(matchesShakerRequest(request, "2PC COCKTAIL SHAKER 20oz, COPPER PLATED"), false);
  assert.equal(matchesShakerRequest(request, "3PC COCKTAIL SHAKER 16oz S/S"), false);
  assert.equal(matchesShakerRequest("16oz cocktail shaker", "3PC COCKTAIL SHAKER S/S 0.48L"), true);
  assert.equal(matchesShakerRequest("16oz cocktail shaker", "COCKTAIL SHAKER 700ml"), false);
  assert.equal(matchesShakerRequest("16oz cocktail shaker", "COCKTAIL SHAKER 20oz / 480ml"), false);
  assert.equal(matchesShakerRequest("cobbler cocktail shaker", "3PC COCKTAIL SHAKER 16oz"), true);
  assert.equal(matchesShakerRequest("cobbler cocktail shaker", "2PC COCKTAIL SHAKER 20oz"), false);
  const changed = catalogueMessageWithContext("actually 20oz instead", ["16oz copper cocktail shaker"]);
  assert.equal(matchesShakerRequest(changed, "2PC COCKTAIL SHAKER 20oz, COPPER PLATED"), true);
  assert.equal(matchesShakerRequest(changed, "3PC COCKTAIL SHAKER 16oz, COPPER PLATED"), false);
  assert.equal(matchesShakerRequest("cocktail shaker, not copper", "S/S COCKTAIL SHAKER 16oz"), true);
  assert.equal(matchesShakerRequest("cocktail shaker, not copper", "COPPER COCKTAIL SHAKER 16oz"), false);
});

test("a natural quantity reduction after exceeding stock remains a number", () => {
  assert.equal(requestedQuantity("Actually just 2 please"), 2);
  assert.equal(requestedQuantity("just two please"), 2);
  assert.equal(requestedQuantity("actually 16oz please"), null);
  assert.equal(requestedQuantity("just 20cm"), null);
});
