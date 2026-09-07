import assert from "node:assert/strict";
import test from "node:test";
import { catalogueHistoryWithClarification, catalogueMessageWithContext, rememberedActiveCategories } from "./chat-intent";
import { confirmsOrderRequest, isProductRefinementOnly, requestedDisplayedProductIndex, requestedQuantity } from "./chat-turn";
import { getFastChatReply } from "./fast-chat";
import { matchesProductRequirements, requirementLookupQuery } from "./product-requirements";
import { normalizeCatalogueQuery } from "./catalogue";

test("PDF 1–2: cooking refinements and the original tong typo preserve purpose", () => {
  assert.match(catalogueMessageWithContext("any one that's more suitable for cooking?", ["show me stainless steel tongs"]), /stainless steel cooking tongs/);
  assert.match(catalogueMessageWithContext("looking for cooking stainless steel tongsw", []), /cooking tongs/);
  const history = catalogueHistoryWithClarification("any one that's more suitable for cooking?", [
    {role:"user",content:"show me stainless steel tongs"},
    {role:"assistant",content:"The 18cm serving tongs are compact. What will you serve?"},
  ]);
  assert.doesNotMatch(catalogueMessageWithContext("any one that's more suitable for cooking?",history), /18cm/);
});
test("PDF 2: an exact displayed steak-tong name is a choice, not a refinement", () => {
  const products = [{stock_id: "ST-15", name: 'Stainless Steel Steak Tong 15"', status: "Active", list_price: 9, uom_id: "PC"}];
  assert.equal(isProductRefinementOnly(products[0].name, products), false);
  assert.equal(requestedDisplayedProductIndex(products[0].name, products), 0);
  assert.equal(isProductRefinementOnly("I want cooking tongs, not serving tongs", products), true);
});

test("live checkout: inch wording retrieves the steak-tong family and an explicit code replaces stale search context", () => {
  const request = "2 stainless steel steak tongs, 15 inch";
  const contextual = catalogueMessageWithContext(request, ["Kenwood HMP30.A0-WH hand mixer", "Add another item"]);
  assert.match(contextual, /15 inch steak tong/);
  assert.equal(requirementLookupQuery(normalizeCatalogueQuery(contextual)), "steak tong");
  assert.equal(catalogueMessageWithContext("Use item code ST-15 instead", [request]), "Use item code ST-15 instead");
  assert.doesNotMatch(catalogueMessageWithContext("Do not use item code ST-15", [request]), /^Do not use item code/);
});
test("PDF 6: rejecting Taiwanese knives does not become a request for Taiwan origin", () => {
  const history = ["I need a damascus chef knife. 3 pcs", "Have a japanese made knife?", "No, this is taiwanese knife"];
  const query = catalogueMessageWithContext("Are there others?", history);
  assert.match(query, /japanese made/);
  assert.doesNotMatch(query, /damascus|taiwan/i);
  assert.equal(matchesProductRequirements(query, {name:"Atlantic Chef Japanese Chef Knife",description:"Made using German steel."}), false);
  assert.equal(matchesProductRequirements(query, {name:"Chef Knife",description:"Made in Japan."}), true);
});
test("PDF 7 and 11: fine mesh excludes coarse strainers and searches a useful term", () => {
  const query = catalogueMessageWithContext("Handheld skimmer (fine mesh)", ["Colander/strainer"]);
  assert.equal(requirementLookupQuery(query), "fine mesh");
  assert.equal(matchesProductRequirements(query, {name:"Chinese Strainer",description:"Coarse basket"}), false);
  assert.equal(matchesProductRequirements(query, {name:"S/S Fine Mesh Skimmer Ø15cm"}), true);
});
test("PDF 8: Gold,100 is a collection; it supplies no order quantity", () => {
  assert.equal(requestedQuantity("give me the Gold,100"), null);
  assert.equal(requestedQuantity("give me 2 sets of Gold,100"), 2);
  assert.equal(requestedQuantity("I have 8 outlets"), null);
  assert.equal(requestedQuantity("maybe about 200 drinks per day"), null);
});
test("PDF 9: forged premium handle remains a requirement", () => {
  const query = catalogueMessageWithContext("show me chef knives with forged premium handle", []);
  assert.match(query, /forged premium handle/);
  assert.equal(matchesProductRequirements(query, {name:"Chef Knife, Red Handle"}), false);
  assert.equal(matchesProductRequirements(query, {name:"Chef Knife 15cm with Forged Premium Handle"}), true);
});
test("PDF 15–16: human quantity sentences and misspelled confirmation work", () => {
  assert.equal(requestedQuantity("could i have 20 pieces"), 20);
  assert.equal(requestedQuantity("wait i want 11"), 11);
  assert.equal(requestedQuantity("Okie i will take one"), 1);
  assert.equal(confirmsOrderRequest("ok comfirm"), true);
});
test("PDF 16: sashimi and misspelled yanagiba survive a short handedness answer", () => {
  assert.equal(isProductRefinementOnly("I need it for like sashimi-style slicing"), true);
  const query = catalogueMessageWithContext("a right handed one", ["Hi i want a knife", "I need it for like sashimi-style slicing", "I want a traditional style-bevel yangiba."]);
  assert.match(query, /sashimi knife.*yanagiba/);
  assert.equal(requirementLookupQuery(query), "sashimi knife");
  assert.equal(matchesProductRequirements(query, {name:"Sashimi Plate With Stand"}), false);
  assert.equal(matchesProductRequirements(query, {name:"Chef Knife 15cm"}), false);
  assert.equal(matchesProductRequirements(query, {name:"Kikumori Yanagiba Sashimi Knife 27cm"}), true);
});
test("PDF 18: slots without a count and OR slot counts exclude conveyor toasters", () => {
  assert.match(catalogueMessageWithContext("Slots toaster", []), /pop-up toaster/);
  const query = catalogueMessageWithContext("No conveyor type 4 or 6 slots toaster", []);
  assert.equal(requestedQuantity(query), null);
  const normalized = normalizeCatalogueQuery(query);
  assert.equal(requirementLookupQuery(normalized), "toaster");
  assert.equal(matchesProductRequirements(normalized, {name:"Waring 4-Slots Toaster"}), true);
  assert.equal(matchesProductRequirements(normalized, {name:"6-Slot Toaster"}), true);
  assert.equal(matchesProductRequirements(normalized, {name:"2-Slot Toaster"}), false);
  assert.equal(matchesProductRequirements(normalized, {name:"Conveyor Toaster"}), false);
});
test("PDF 19: cordless 3-in-1 means a complete blender/whisk/chopper, not a spare whisk", () => {
  const query = catalogueMessageWithContext("no. how about cordless 3-in-1 blender, whisk product", ["electric whisk for home use"]);
  assert.equal(requirementLookupQuery(query), "cordless");
  assert.equal(matchesProductRequirements(query, {name:"ACCS Whisk for mixer"}), false);
  assert.equal(matchesProductRequirements(query, {name:"Cordless Hand Blender With Whisk & Mini Chopper"}), true);
  assert.equal(matchesProductRequirements("electric whisk for home", {name:"Dynamic Hand Mixer",description:"A stick blender with titanium-plated blades for whipped cream."}), false);
  assert.doesNotMatch(normalizeCatalogueQuery("cordless 3-in-1 blender whisk"), /\b3-in\b/);
});
test("PDF 12: never mind ends the old search instead of repeating the rejected knives", () => {
  const history = [{role:"user" as const,content:"I need a damascus chef knife"}];
  assert.equal(getFastChatReply({sessionId:"history-cancel",message:"Ok nvm..",history})?.products.length, 0);
  assert.deepEqual(rememberedActiveCategories([history[0].content,"Ok nvm.."]), []);
  assert.equal(getFastChatReply({sessionId:"history-switch",message:"Switch to tableware",history:[{role:"user",content:"I want to get fine dining plates"}]}), null);
  const produce = getFastChatReply({sessionId:"history-produce",message:"Fresh",history:[
    {role:"user",content:"fine dining plates"}, {role:"user",content:"Nvm now i want to buy mangoes"},
  ]});
  assert.match(produce?.message ?? "", /don’t carry fresh fruit/);
  assert.equal(produce?.products.length, 0);
});
test("PDF 10 and 19: human requests and missing listing photos get honest next steps", () => {
  const handoff = getFastChatReply({sessionId:"history-human",message:"can i speak to someone",history:[]});
  assert.match(handoff?.message ?? "", /can’t connect/);
  const photo = getFastChatReply({sessionId:"history-photo",message:"the listing doesnt have a picture also",history:[{role:"user",content:"electric whisk"}]});
  assert.match(photo?.message ?? "", /can't verify/);
  assert.doesNotMatch(photo?.message ?? "", /official photos|can't send/i);
});
