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

test("product facts carry the dimensions and a trimmed description to cite", () => {
  const description = `Heavy duty   stainless steel.\n\nDishwasher safe. ${"x".repeat(400)}`;
  const fact = productFact({ product: product({ stock_id: "A", dimensions: "W38xD55xH170cm", description }), verified: true });
  assert.equal(fact.dimensions, "W38xD55xH170cm");
  assert.equal(fact.description?.length, 300);
  assert.ok(fact.description?.startsWith("Heavy duty stainless steel. Dishwasher safe. xxx"));
  assert.equal(productFact({ product: product({ stock_id: "B" }), verified: true }).description, null);
});

test("inch marks in names and sizes are shown as ″, so Claude never copies a raw double quote", () => {
  const fact = productFact({ product: product({ stock_id: "A", name: `CCK Iron Frying Wok H/Duty 18"`, size: `18"` }), verified: true });
  assert.equal(fact.name, "CCK Iron Frying Wok H/Duty 18″");
  assert.equal(fact.size, "18″");
  assert.ok(Object.values(fact).every((value) => typeof value !== "string" || !value.includes(`"`)));
});

test("an unverified product carries no price, so Claude cannot quote it", () => {
  const item = product({ stock_id: "A", list_price: 12 });
  assert.equal(productFact({ product: item, verified: false }).price_ex_gst, null);
  assert.equal(productFact({ product: item, verified: true }).price_ex_gst, 12);
});
