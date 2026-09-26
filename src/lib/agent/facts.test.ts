// src/lib/agent/facts.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { liveCheck, productFact, storeProductUrl } from "./facts";
import { fakeDeps, product } from "./testing";

test("a live check overwrites price and stock from the store page", async () => {
  const torch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 30 });
  const checked = await liveCheck(torch, fakeDeps([torch], { "970S": { price_ex_gst: 31.31, available_quantity: 115 } }));
  assert.equal(checked.verified, true);
  assert.equal(checked.product.list_price, 31.31);
  assert.equal(checked.product.available_quantity, 115);
});

test("a failed or mismatched live check leaves the product unverified", async () => {
  const torch = product({ stock_id: "970S" });
  const failed = await liveCheck(torch, fakeDeps([torch], { "970S": "fail" }));
  assert.equal(failed.verified, false);
  assert.equal(failed.product.stock_status, "unknown");
  assert.equal(failed.product.in_stock, null);
  assert.equal(failed.product.available_quantity, null);
  const mismatch = await liveCheck(torch, fakeDeps([torch], { "970S": { stock_id: "OTHER" } }));
  assert.equal(mismatch.verified, false);
});

test("store links are normalised; other text is not a link", () => {
  assert.equal(storeProductUrl("see http://store.siahuat.com/product/10921358890?x=1"), "https://store.siahuat.com/product/10921358890");
  assert.equal(storeProductUrl("store.siahuat.com/product/abc"), null);
});

test("product facts flag verification and earlier display", () => {
  const fact = productFact({ product: product({ stock_id: "A" }), verified: true }, true);
  assert.equal(fact.price_and_stock_verified_live, true);
  assert.equal(fact.shown_before, true);
});
