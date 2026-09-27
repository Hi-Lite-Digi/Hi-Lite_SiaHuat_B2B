// src/lib/agent/facts.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { liveCheck, productFact, storeProductUrl, turnDeps } from "./facts";
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

test("turnDeps fetches each page and item code once per turn", async () => {
  const torch = product({ stock_id: "970S" });
  const deps = fakeDeps([torch]);
  const turn = turnDeps(deps);
  await Promise.all([turn.findByCode("970S"), turn.findByCode("970S")]);
  const found = (await turn.findByCode("970S"))!;
  await Promise.all([liveCheck(found, turn), liveCheck(found, turn)]);
  assert.equal((await liveCheck(found, turn)).verified, true);
  assert.deepEqual(deps.calls, ["code:970S", "live:970S"]);
});

test("a failed fetch is not remembered", async () => {
  const torch = product({ stock_id: "970S" });
  const deps = fakeDeps([torch]);
  const { fetchLive, findByCode } = deps;
  let pageTries = 0;
  let codeTries = 0;
  deps.fetchLive = async (url, ms) => { pageTries += 1; if (pageTries === 1) throw new Error("LIVE_DOWN"); return fetchLive(url, ms); };
  deps.findByCode = async (code) => { codeTries += 1; if (codeTries === 1) throw new Error("DB_DOWN"); return findByCode(code); };
  const turn = turnDeps(deps);
  assert.equal((await liveCheck(torch, turn)).verified, false);
  assert.equal((await liveCheck(torch, turn)).verified, true);
  await assert.rejects(turn.findByCode("970S"));
  assert.equal((await turn.findByCode("970S"))?.stock_id, "970S");
  assert.deepEqual([pageTries, codeTries], [2, 2]);
});

test("keys are exact: a lower-case miss does not hide the real code", async () => {
  const tong = product({ stock_id: "UT16HR" });
  const deps = fakeDeps([tong]);
  deps.findByCode = async (code) => (code === "UT16HR" ? tong : null); // the catalogue lookup is case-sensitive
  const turn = turnDeps(deps);
  assert.equal(await turn.findByCode("ut16hr"), null);
  assert.equal((await turn.findByCode("UT16HR"))?.stock_id, "UT16HR");
});
