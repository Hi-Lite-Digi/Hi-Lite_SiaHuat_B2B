import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "./chat-contract";
import {
  declinesUnavailableItem,
  hasUnavailableProductContext,
  requestedQuantity,
  requestsAnotherOption,
  shouldStartFreshAdditionalItem,
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
