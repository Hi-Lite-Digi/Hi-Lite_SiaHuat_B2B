// src/lib/agent/facts.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { liveCheck, productFact, retryOnce, searchSlots, storeDetails, storeProductUrl, turnDeps } from "./facts";
import { fakeDeps, product } from "./testing";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("searchSlots runs at most `limit` searches at once", async () => {
  const slot = searchSlots(2);
  let running = 0;
  let peak = 0;
  const job = (value: number) => slot(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await pause(20);
    running -= 1;
    return value;
  });
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(job)), [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test("a rejected search frees its slot for the next one waiting", async () => {
  const slot = searchSlots(1, 100);
  const failing = slot(async () => { await pause(10); throw new Error("SEARCH_500"); });
  const next = slot(async () => "next");
  await assert.rejects(failing, /SEARCH_500/);
  assert.equal(await next, "next");
});

test("a search that can't start within maxWaitMs gives up with SEARCH_BUSY and never runs", async () => {
  const slot = searchSlots(1, 50);
  const busy = slot(() => pause(200));
  let ran = false;
  await assert.rejects(slot(async () => { ran = true; }), /SEARCH_BUSY/);
  await busy;
  assert.equal(ran, false);
  assert.equal(await slot(async () => "free again"), "free again");
});

test("retryOnce still retries a failed call once", async () => {
  let tries = 0;
  assert.equal(await retryOnce(async () => { tries += 1; if (tries === 1) throw new Error("DOWN"); return "ok"; }), "ok");
  assert.equal(tries, 2);
  tries = 0;
  await assert.rejects(retryOnce(async () => { tries += 1; throw new Error("DOWN"); }), /DOWN/);
  assert.equal(tries, 2);
});

test("retryOnce doesn't retry SEARCH_BUSY: the search already waited its turn", async () => {
  let tries = 0;
  await assert.rejects(retryOnce(async () => { tries += 1; throw new Error("SEARCH_BUSY"); }), /SEARCH_BUSY/);
  assert.equal(tries, 1);
});

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

test("a live check always hands the store fetch a whole number of milliseconds", async () => {
  // exam 3: a time left from performance.now() made AbortSignal.timeout throw, so 101 re-shown cards went out TBC.
  const torch = product({ stock_id: "970S" });
  const deps = fakeDeps([torch]);
  const { fetchLive } = deps;
  const seen: number[] = [];
  deps.fetchLive = async (url, ms) => { seen.push(ms); return fetchLive(url, ms); };
  assert.equal((await liveCheck(torch, deps, 1860.86)).verified, true);
  assert.equal((await liveCheck(torch, deps, 0.2)).verified, true);
  assert.deepEqual(seen, [1860, 1]);
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

test("product facts carry the dimensions and the whole description", () => {
  const description = `Heavy duty   stainless steel.\n\nDishwasher safe. ${"x".repeat(470)} The whisk attachment whips cream.`;
  const fact = productFact({ product: product({ stock_id: "A", dimensions: "W38xD55xH170cm", description }), verified: true });
  assert.equal(fact.dimensions, "W38xD55xH170cm");
  assert.ok(fact.description?.startsWith("Heavy duty stainless steel. Dishwasher safe. xxx"));
  assert.ok(fact.description?.endsWith("The whisk attachment whips cream."));
  const long = productFact({ product: product({ stock_id: "L", description: "y".repeat(2_500) }), verified: true });
  assert.equal(long.description?.length, 2_000);
  assert.equal(productFact({ product: product({ stock_id: "B" }), verified: true }).description, null);
});

test("product facts carry the catalogue category path", () => {
  const strainer = product({ stock_id: "JS08", category: "Bar Supplies", subcategory: "Bar accessories", third_category: "Cocktail and liquor accessories" });
  assert.equal(productFact({ product: strainer, verified: true }).category, "Bar Supplies > Bar accessories > Cocktail and liquor accessories");
  assert.equal(productFact({ product: product({ stock_id: "B" }), verified: true }).category, null);
});

test("store details keep real fields and drop the catalogue's blanks", () => {
  assert.deepEqual(storeDetails({
    NSF: "N", Microwaveable: "N", Warranty: "No", "Country of Brand Origin": "TAIWAN", Material: "STAINLESS STEEL",
    Description: "The chef's knife is made from German steel.", Brand: "UB-0292", "Measurement Range": "1 YEAR WARRANTY",
  }), { "Country of Brand Origin": "TAIWAN", Material: "STAINLESS STEEL" });
  assert.deepEqual(storeDetails({ Microwaveable: "Y" }), { Microwaveable: "Y" });
  assert.equal(storeDetails({}), undefined);
});

test("product facts carry the details they were given, else null", () => {
  const item = product({ stock_id: "A" });
  assert.deepEqual(productFact({ product: item, verified: false, details: { Material: "GLASS" } }).details, { Material: "GLASS" });
  assert.equal(productFact({ product: item, verified: true }).details, null);
});

test("inch marks in names and sizes are shown as ″, so Claude never copies a raw double quote", () => {
  const fact = productFact({ product: product({ stock_id: "A", name: `CCK Iron Frying Wok H/Duty 18"`, size: `18"` }), verified: true, details: { Shape: `18" ROUND` } });
  assert.equal(fact.name, "CCK Iron Frying Wok H/Duty 18″");
  assert.equal(fact.size, "18″");
  assert.deepEqual(fact.details, { Shape: "18″ ROUND" });
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
