import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "./chat-contract";
import {
  additionalProductTarget,
  declinesUnavailableItem,
  hasUnavailableProductContext,
  requestedDisplayedProductIndex,
  requestedQuantity,
  requestsAdditionalProduct,
  requestsAnotherOption,
  shouldStartFreshAdditionalItem,
  splitMultipleProductRequest,
} from "./chat-turn";

function product(stockStatus: Product["stock_status"], availableQuantity: number | null): Product {
  return {
    stock_id: "TEST-001",
    name: "Test product",
    status: "ACTIVE",
    list_price: 10,
    uom_id: "PC",
    stock_status: stockStatus,
    available_quantity: availableQuantity,
  };
}

test("recognises natural English and Chinese unavailable-item declines", () => {
  for (const message of [
    "No, thank you",
    "no thnks",
    "dont need it thanks",
    "nvm",
    "Cancel this",
    "Thanks",
    "不用了，谢谢",
    "先不用啦 谢谢你",
    "不需要了",
    "算了",
    "取消询价吧",
  ]) {
    assert.equal(declinesUnavailableItem(message), true, `expected decline: ${message}`);
  }
});

test("does not swallow a refinement or another-product request", () => {
  for (const message of [
    "No thanks, show another one",
    "Thank you, show another rice dispenser",
    "I need 2 rice dispensers",
    "不要小的，给我大一点",
    "不需要这个型号，看看另一个",
  ]) {
    assert.equal(declinesUnavailableItem(message), false, `expected active request: ${message}`);
  }
});

test("detects unavailable recovery from displayed cards without a confirmed product", () => {
  const unavailable = product("out_of_stock", 0);
  const available = product("in_stock", 4);

  assert.equal(hasUnavailableProductContext({ displayedProducts: [unavailable] }), true);
  assert.equal(hasUnavailableProductContext({ rememberedUnavailableProduct: unavailable }), true);
  assert.equal(hasUnavailableProductContext({ confirmedProduct: null, displayedProducts: [available] }), false);
});

test("restarts a failed additional-item search without treating it as an alternative lookup", () => {
  assert.equal(shouldStartFreshAdditionalItem({
    message: "Choose another item",
    additionalItemInProgress: true,
    completedItemCount: 1,
  }), true);
  assert.equal(shouldStartFreshAdditionalItem({
    message: "选择其他商品",
    additionalItemInProgress: true,
    completedItemCount: 2,
  }), true);
  assert.equal(shouldStartFreshAdditionalItem({
    message: "Choose another item",
    additionalItemInProgress: false,
    completedItemCount: 1,
  }), false);
  assert.equal(shouldStartFreshAdditionalItem({
    message: "Choose another item",
    additionalItemInProgress: true,
    completedItemCount: 0,
  }), false);
});

test("retains quantity when common need or plate words are misspelled", () => {
  assert.equal(requestedQuantity("i ned 2 blak dinnr plates"), 2);
  assert.equal(requestedQuantity("2 blak dinnr pltes"), 2);
});

test("recognises human quantities after a product name and before each", () => {
  assert.equal(requestedQuantity("got oyster knife plastic handle? need three"), 3);
  assert.equal(requestedQuantity("three"), 3);
  assert.equal(requestedQuantity("three please"), 3);
  assert.equal(requestedQuantity("need twenty-five"), 25);
  assert.equal(requestedQuantity("twenty five oyster knives"), 25);
  assert.equal(requestedQuantity("need oyster knife twenty five"), 25);
  assert.equal(requestedQuantity("want one hundred"), 100);
  assert.equal(requestedQuantity("a hundred plates"), 100);
  assert.equal(requestedQuantity("also need bread knife 3"), 3);
  assert.equal(requestedQuantity("also need bread knife 3 please"), 3);
  assert.equal(requestedQuantity("also need bread knife, 3 pls"), 3);
  assert.equal(requestedQuantity("also need bread knife x3"), 3);
  assert.equal(requestedQuantity("bread knife also 3"), 3);
  assert.equal(requestedQuantity("also need bread knife 24"), null);
  assert.equal(requestedQuantity("also need bread knife x24"), 24);
  assert.equal(requestedQuantity("can chk item 1 n 2? need two each"), 2);
  assert.equal(requestedQuantity("both 2 each lah"), 2);
  assert.equal(requestedQuantity("2nd one how much for us? got 5 or not"), 5);
  assert.equal(requestedQuantity("2nd one how much for us? got five or not"), 5);
  assert.equal(requestedQuantity("have 5?"), 5);
  assert.equal(requestedQuantity("can you supply five"), 5);
  assert.equal(requestedQuantity("can supply five?"), 5);
  assert.equal(requestedQuantity("five available?"), 5);
  assert.equal(requestedQuantity("got 5 left?"), 5);
  assert.equal(requestedQuantity("have five on hand?"), 5);
  assert.equal(requestedQuantity("got 5 stock?"), 5);
  assert.equal(requestedQuantity("have 5 units left?"), 5);
  assert.equal(requestedQuantity("got five of option 2 or not?"), 5);
  assert.equal(requestedQuantity("do you have five of the second one?"), 5);
  assert.equal(requestedQuantity("do you have five of the second option?"), 5);
  assert.equal(requestedQuantity("got 5 of 2nd option or not?"), 5);
  assert.equal(requestedQuantity("option two have 5?"), 5);
  assert.equal(requestedQuantity("have 5, option 2?"), 5);
  assert.equal(requestedQuantity("enough for five?"), 5);
  assert.equal(requestedQuantity("Do you have 5L pot?"), null);
  assert.equal(requestedQuantity("I have 5 already"), null);
  assert.equal(requestedQuantity("Model 5 in stock?"), null);
  assert.equal(requestedQuantity("size 5 available?"), null);

  assert.equal(requestedQuantity("need chef knife 8 inch"), null);
  assert.equal(requestedQuantity("need ladder 3 steps"), null);
  assert.equal(requestedQuantity("need 4-slot toaster"), null);
  assert.equal(requestedQuantity("need chef knife eight inch"), null);
  assert.equal(requestedQuantity("need ladder three steps"), null);
  assert.equal(requestedQuantity("need four-slot toaster"), null);
  assert.equal(requestedQuantity("option three"), null);
});

test("keeps pot compatibility wording as one browser request", () => {
  for (const message of [
    "I have 12qt pot. don't want another pot, need strainer fits inside",
    "got pot already. do not need new pot, basket only",
    "I already have the strainer; only need the pot it fits inside",
    "can I buy pot + strainer together",
  ]) {
    assert.deepEqual(splitMultipleProductRequest(message), [], message);
  }
  assert.deepEqual(splitMultipleProductRequest("I need a pot and a bread basket"), ["I need a pot", "I need a bread basket"]);
  assert.deepEqual(splitMultipleProductRequest("I have pot and need strainer, also need toaster"), [
    "I have pot and need strainer",
    "I need toaster",
  ]);
  assert.deepEqual(splitMultipleProductRequest("I need a pot and strainer plus a ladle"), [
    "I need a pot and strainer",
    "I need a ladle",
  ]);
  assert.deepEqual(splitMultipleProductRequest("I already have a pot and strainer; need replacement lid"), []);
  assert.deepEqual(splitMultipleProductRequest("I have a pot and basket but need a ladle"), []);
});

test("keeps every numbered item from the real eight-line quote request", () => {
  const request = `Hi Seng Wee, can you send me a quote for the following items:
1) Stainless Steel Pot 12QT,
2) Stainless Steel Strainer for the 12QT Pot,
3) Stainless Steel Ladle 4oz, 6oz, 8oz, length approximate 10inch
4) 1/2 Stainless Steel Pan, 6" Deep
5) 1/4 Stainless Steel Pan, 6" Deep
6) Lid for 1/2 S/S Pan with notch for ladle
7) Lid for 1/4 S/S Pan with notch for ladle
8) Oyster Knife with Plastic Handle`;
  const items = splitMultipleProductRequest(request);
  assert.equal(items.length, 8);
  assert.match(items[0], /Pot 12QT/i);
  assert.match(items[1], /Strainer for the 12QT Pot/i);
  assert.match(items[5], /Lid for 1\/2 S\/S Pan/i);
  assert.match(items[7], /Oyster Knife/i);
});

test("does not select a displayed card that the customer rejected", () => {
  const displayed: Product[] = [{
    stock_id: "PAN-28",
    name: "FRYING PAN 28CM",
    status: "Active",
    list_price: 25,
    uom_id: "PC",
    stock_status: "in_stock",
    available_quantity: 12,
  }];
  assert.equal(requestedDisplayedProductIndex("don't want this pan", displayed), null);
  assert.equal(requestedDisplayedProductIndex("not this pan, need toaster", displayed), null);
  assert.equal(requestedDisplayedProductIndex("not pan", displayed), null);
  assert.equal(requestedDisplayedProductIndex("wrong red pan, need blue pan", displayed), null);
  assert.equal(requestedDisplayedProductIndex("do not want red pan", displayed), null);
  assert.equal(requestedDisplayedProductIndex("not PAN-28, need PAN-24", displayed), null);
  assert.equal(requestedDisplayedProductIndex("not too large, take this pan", displayed), 0);
});

test("understands human option wording without confusing 'too large' with an added item", () => {
  const displayed: Product[] = [
    { ...product("in_stock", 9), stock_id: "A", name: "Option A" },
    { ...product("in_stock", 9), stock_id: "B", name: "Option B" },
  ];
  assert.equal(requestedDisplayedProductIndex("option two have 5?", displayed), 1);
  assert.equal(requestedDisplayedProductIndex("do you have five of the second option?", displayed), 1);
  assert.equal(requestedDisplayedProductIndex("got 5 of 2nd option or not?", displayed), 1);
  assert.equal(requestsAdditionalProduct("not this pan, too large; need toaster"), false);
  assert.equal(requestsAdditionalProduct("keep this pan, I need a toaster too"), true);
});

test("extracts the new product from natural additive wording", () => {
  assert.equal(additionalProductTarget("keep this pan, I need a toaster too"), "a toaster");
  assert.equal(additionalProductTarget("keep this pan; toaster too"), "toaster");
  assert.equal(additionalProductTarget("keep this pan, I need a toaster"), "a toaster");
  assert.equal(additionalProductTarget("keep this pan, I need a toaster as well"), "a toaster");
  assert.equal(additionalProductTarget("keep this knife; we want a toaster"), "a toaster");
  assert.equal(additionalProductTarget("keep this pan, need toaster"), "toaster");
  assert.equal(additionalProductTarget("keep pan; want toaster"), "toaster");
  assert.equal(additionalProductTarget("also need 2 bread knives"), "2 bread knives");
  assert.equal(additionalProductTarget("not this pan, too large"), null);
  assert.equal(requestsAdditionalProduct("keep this pan, I need a toaster"), true);
  assert.equal(requestsAdditionalProduct("keep this pan, I need a toaster as well"), true);
  assert.equal(requestsAdditionalProduct("keep this knife; we want a toaster"), true);
  assert.equal(requestsAdditionalProduct("keep this pan, need toaster"), true);
  assert.equal(requestsAdditionalProduct("keep pan; want toaster"), true);
});

test("recognises natural requests for a different product option", () => {
  for (const message of [
    "another option",
    "Can I see another one?",
    "show me other products",
    "something else please",
    "No thanks, show another one",
    "查看其他商品",
    "不要这个，查看其他商品",
  ]) {
    assert.equal(requestsAnotherOption(message), true, `expected alternative request: ${message}`);
  }
});

test("does not treat declining more options as an alternative request", () => {
  for (const message of [
    "I do not want another option",
    "no more options",
    "No thanks, no more options",
    "not another one",
    "not interested in other options",
    "I do not need to see any more options",
    "不要查看其他商品",
    "不想看其他商品",
    "不需要其他选项",
  ]) {
    assert.equal(requestsAnotherOption(message), false, `expected alternative decline: ${message}`);
  }
});
