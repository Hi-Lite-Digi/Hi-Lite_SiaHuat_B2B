import assert from "node:assert/strict";
import test from "node:test";
import { catalogueHistoryWithClarification, catalogueMessageWithContext, isCatalogueRequest, namesCatalogueNoun } from "./chat-intent";

const fishQuestion = "Fish? Do you mean a fish-shaped mould or plate, or something else like a fish knife or scaler";
const queryAfter = (question: string, answer: string, earlier = ["im looking for fish"]) => {
  const history = [
    ...earlier.map((content) => ({ role: "user" as const, content })),
    { role: "assistant" as const, content: question },
  ];
  return catalogueMessageWithContext(answer, catalogueHistoryWithClarification(answer, history));
};
const keepsClaireQuestion = (question: string, answer: string, earlier = ["im looking for fish"]) => {
  const history = [
    ...earlier.map((content) => ({ role: "user" as const, content })),
    { role: "assistant" as const, content: question },
  ];
  return catalogueHistoryWithClarification(answer, history).includes(question);
};

test("live 26 Sep: answering 'scaler' to a plate/knife/scaler question searches for scalers, not plates", () => {
  for (const answer of ["scaler maybe", "fish scaler", "fish scalers lah"]) {
    const query = queryAfter(fishQuestion, answer);
    assert.match(query, /scaler/, answer);
    assert.doesNotMatch(query, /plate|tableware|knife/, answer);
  }
});

test("the customer's product word wins whichever product Claire listed first, offered or not", () => {
  for (const question of [
    "Fish—are you after a fish plate/platter, a fish poacher, or something like a fish spatula or scaler?",
    "Fish—are you after a fish plate/tray, a fish knife, or fish poacher? Sia Huat carries kitchen and F&B equipment, not seafood itself.",
    "Fish gear—got it. What kind are you after: a scaler, a poacher, or a serving platter?",
  ]) {
    const query = queryAfter(question, "scaler");
    assert.match(query, /scaler/, question);
    assert.doesNotMatch(query, /plate|tableware|knife|spatula|utensil/, question);
  }
});

test("attribute and choice answers still keep the product from Claire's question", () => {
  assert.match(queryAfter("Is this knife stainless or carbon steel?", "stainless", []), /knife/);
  assert.match(queryAfter("What size wok do you need?", "32cm", ["hi"]), /wok/);
  assert.match(queryAfter("For the wok, do you prefer carbon steel or cast iron?", "cast iron", ["hi, need something for my zi char stall"]), /wok/);
  for (const answer of ["both", "either one", "the second one", "large", "porcelain"]) {
    assert.equal(keepsClaireQuestion(fishQuestion, answer), true, answer);
  }
});

test("catalogue category nouns recognise products the hand-written word list missed", () => {
  for (const message of ["scaler maybe", "fish scalers", "got step stool?", "need a mandoline", "got zester"]) {
    assert.equal(namesCatalogueNoun(message), true, message);
    assert.equal(isCatalogueRequest(message), true, message);
  }
});

test("everyday chat and attribute words are not catalogue nouns", () => {
  for (const message of [
    "i need help", "i want to order", "can you call me", "happy chinese new year", "i love you", "so cold today",
    "thanks for the service", "all set", "ok thanks", "cast iron", "large", "both", "the second one", "take care",
    "what is your price range", "talk to an agent", "the rest is fine",
  ]) {
    assert.equal(namesCatalogueNoun(message), false, message);
  }
});

test("purpose and add-on answers keep the product Claire named in her question", () => {
  const cases: Array<[string, string]> = [
    ["A large stockpot would suit that. What will you mostly cook in it — soup, curry or rice?", "soup"],
    ["That looks like a stockpot. What will you mainly use it for?", "for soup"],
    ["A commercial blender would help. What will you mainly blend — fruit, ice or sauces?", "mostly ice"],
    ["A frying pan would help. Is it mainly for eggs, or a bigger one for stir-fry?", "eggs"],
    ["Tongs would do that. Are they for the grill or for serving at the buffet?", "for the grill"],
    ["Is the strainer for noodles or for oil?", "oil"],
    ["That looks like a Chinese cleaver. What will you mainly cut with it—vegetables or bones?", "vegetables"],
    ["What size wok do you need?", "with a stand"],
  ];
  for (const [question, answer] of cases) {
    assert.equal(keepsClaireQuestion(question, answer, ["hi"]), true, `${answer} after: ${question}`);
    assert.equal(namesCatalogueNoun(answer), false, answer);
  }
});

test("website complaints and small talk that share a word with a product stay out of product search", () => {
  for (const message of [
    "the display is blank", "is your server down", "on a scale of 1 to 10 how good are you", "i saw your ad on facebook",
    "can you help me book a table for 2", "nvm the board", "i run a food truck", "which carrier do you use",
  ]) {
    assert.equal(namesCatalogueNoun(message), false, message);
  }
});
