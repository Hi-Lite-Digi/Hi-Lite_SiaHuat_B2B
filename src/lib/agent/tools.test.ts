// src/lib/agent/tools.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CheckedProduct } from "./facts";
import { agentTools, runTool, type TurnContext } from "./tools";
import { fakeDeps, product } from "./testing";

const blowtorch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31 });
const mastrad = product({ stock_id: "F46700", name: "Mastrad Cooking Torch", list_price: 40 });
const safico = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", list_price: 23.36 });

function context(deps = fakeDeps([blowtorch, mastrad, safico]), overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    deps, seen: new Map<string, CheckedProduct>(), lines: [], uncheckedCodes: [], customerTexts: [], clearTexts: [], image: null, shownIds: new Set(),
    tappedId: null, previousCards: [], ...overrides,
  };
}

test("five tools are declared", () => {
  assert.deepEqual(agentTools.map((tool) => tool.name), ["search_catalogue", "get_product", "find_alternatives", "match_photo", "update_enquiry"]);
});

test("search merges queries, live-checks results and remembers them", async () => {
  const ctx = context(undefined, { shownIds: new Set(["F46700"]) });
  const outcome = await runTool("search_catalogue", { queries: ["blow torch", "torch"] }, ctx);
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string; price_and_stock_verified_live: boolean; shown_before: boolean }> };
  assert.equal(outcome.isError, false);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["970S", "F46700", "BTS-8026D"]);
  assert.ok(body.products.every((item) => item.price_and_stock_verified_live));
  assert.equal(body.products.find((item) => item.stock_id === "F46700")?.shown_before, true);
  assert.deepEqual([...ctx.seen.keys()].sort(), ["970S", "BTS-8026D", "F46700"]);
});

test("search honours exclusions and budget", async () => {
  const outcome = await runTool("search_catalogue", { queries: ["torch"], exclude_ids: ["970S"], max_price: 35 }, context());
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string }> };
  assert.deepEqual(body.products.map((item) => item.stock_id), ["BTS-8026D"]);
});

test("search results past the first 6 carry no stock figures", async () => {
  const torches = Array.from({ length: 8 }, (_, index) => product({ stock_id: `T${index + 1}`, name: `TORCH ${index + 1}` }));
  const ctx = context(fakeDeps(torches));
  const outcome = await runTool("search_catalogue", { queries: ["torch"] }, ctx);
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string; stock: string; available_quantity: number | null; price_and_stock_verified_live: boolean }> };
  assert.equal(body.products.length, 8);
  assert.ok(body.products.slice(0, 6).every((item) => item.price_and_stock_verified_live && item.available_quantity === 50));
  for (const item of body.products.slice(6)) {
    assert.deepEqual([item.stock, item.available_quantity, item.price_and_stock_verified_live], ["unknown", null, false]);
    const remembered = ctx.seen.get(item.stock_id)?.product;
    assert.deepEqual([remembered?.in_stock, remembered?.available_quantity], [null, null]);
  }
});

test("search outage is reported as a tool error", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const deps = fakeDeps([blowtorch]);
  deps.searchDirect = async () => { throw new Error("down"); };
  const outcome = await runTool("search_catalogue", { queries: ["torch"] }, context(deps));
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /SEARCH_UNAVAILABLE/);
});

test("a search outage logs error codes only", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const deps = fakeDeps([blowtorch]);
  deps.searchDirect = async () => { throw new Error("SUPABASE_SEARCH_500"); };
  await runTool("search_catalogue", { queries: ["torch"] }, context(deps));
  deps.searchDirect = async (query) => { throw new Error(`no rows for ${query}`); };
  await runTool("search_catalogue", { queries: ["blow torch"] }, context(deps));
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [
    ["[api/agent] search unavailable", { errors: ["SUPABASE_SEARCH_500"] }],
    ["[api/agent] search unavailable", { errors: ["Error"] }],
  ]);
});

test("an unexpected tool error logs the tool and an error code only", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const deps = fakeDeps([blowtorch]);
  deps.findByCode = async (stockId) => { throw new Error(`lookup broke on ${stockId}`); };
  const outcome = await runTool("get_product", { stock_id: "970S" }, context(deps));
  assert.match(outcome.content, /TOOL_FAILED/);
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [["[api/agent] tool failed", { tool: "get_product", error: "Error" }]]);
});

test("a category's products are merged in after the query results, without duplicates", async () => {
  const kitchenTongs = product({ stock_id: "TG1", name: "SALAD TONGS 30CM", subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers" });
  const clamp = product({ stock_id: "TG2", name: "BBQ GRILL CLAMP", subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers" });
  const servingTongs = product({ stock_id: "TG3", name: "BUFFET SERVING TONGS", subcategory: "Serving utensils", third_category: "Serving tongs" });
  const ctx = context(fakeDeps([kitchenTongs, clamp, servingTongs]));
  const outcome = await runTool("search_catalogue", { queries: ["tongs"], category: "kitchen tongs" }, ctx);
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string; price_and_stock_verified_live: boolean }>; total_found: number; more_available: boolean };
  assert.deepEqual(body.products.map((item) => item.stock_id), ["TG1", "TG3", "TG2"]);
  assert.ok(body.products.every((item) => item.price_and_stock_verified_live));
  assert.deepEqual([body.total_found, body.more_available], [3, false]);
  assert.ok(ctx.seen.has("TG2"));
});

test("a search that hits a query's row limit says more are available", async () => {
  const torches = Array.from({ length: 10 }, (_, index) => product({ stock_id: `T${index + 1}`, name: `TORCH ${index + 1}` }));
  const outcome = await runTool("search_catalogue", { queries: ["torch"] }, context(fakeDeps(torches)));
  const body = JSON.parse(outcome.content) as { products: unknown[]; total_found: number; more_available: boolean };
  assert.deepEqual([body.products.length, body.total_found, body.more_available], [10, 10, true]);
});

test("a query that keeps failing does not sink the other queries", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  const search = deps.searchDirect;
  deps.searchDirect = async (query, limit) => {
    if (query === "gas torch") throw new Error("slow");
    return search(query, limit);
  };
  const outcome = await runTool("search_catalogue", { queries: ["blow torch", "gas torch", "cooking torch"] }, context(deps));
  assert.equal(outcome.isError, false);
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string }> };
  assert.deepEqual(body.products.map((item) => item.stock_id), ["970S", "F46700"]);
});

test("a query that fails once is retried and its results are used", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  const search = deps.searchDirect;
  let attempts = 0;
  deps.searchDirect = async (query, limit) => {
    attempts += 1;
    if (attempts === 1) throw new Error("timeout");
    return search(query, limit);
  };
  const outcome = await runTool("search_catalogue", { queries: ["safico"] }, context(deps));
  assert.equal(outcome.isError, false);
  assert.equal(attempts, 2);
  assert.deepEqual((JSON.parse(outcome.content) as { products: Array<{ stock_id: string }> }).products.map((item) => item.stock_id), ["BTS-8026D"]);
});

test("search is unavailable only when every query failed after its retry", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const deps = fakeDeps([blowtorch]);
  const attempts = new Map<string, number>();
  deps.searchDirect = async (query) => {
    attempts.set(query, (attempts.get(query) ?? 0) + 1);
    throw new Error("down");
  };
  const outcome = await runTool("search_catalogue", { queries: ["torch", "blow torch"] }, context(deps));
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /SEARCH_UNAVAILABLE/);
  assert.deepEqual(Object.fromEntries(attempts), { torch: 2, "blow torch": 2 });
});

test("find_alternatives retries once before reporting the search as unavailable", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  const find = deps.findAlternatives;
  let attempts = 0;
  deps.findAlternatives = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error("timeout");
    return find(...args);
  };
  assert.deepEqual(await alternativeIds(deps, 1), ["F46700", "BTS-8026D"]);
  deps.findAlternatives = async () => { attempts += 1; throw new Error("down"); };
  attempts = 0;
  const outcome = await runTool("find_alternatives", { stock_id: "970S" }, context(deps));
  assert.match(outcome.content, /SEARCH_UNAVAILABLE/);
  assert.equal(attempts, 2);
});

test("get_product resolves a pasted store link", async () => {
  const ctx = context();
  const outcome = await runTool("get_product", { url: `look ${safico.source_url}` }, ctx);
  assert.match(outcome.content, /BTS-8026D/);
  assert.ok(ctx.seen.has("BTS-8026D"));
});

async function alternativeIds(deps: ReturnType<typeof fakeDeps>, minQty: number) {
  const outcome = await runTool("find_alternatives", { stock_id: "970S", min_qty: minQty }, context(deps));
  return (JSON.parse(outcome.content) as { products: Array<{ stock_id: string }> }).products.map((item) => item.stock_id);
}

test("alternatives are live-checked, in stock and exclude the source", async () => {
  assert.deepEqual(await alternativeIds(fakeDeps([blowtorch, mastrad, safico]), 1), ["F46700", "BTS-8026D"]);
});

test("alternatives drop products that are out of stock or fail the live check", async () => {
  const outOfStock = fakeDeps([blowtorch, mastrad, safico], { "BTS-8026D": { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 } });
  assert.deepEqual(await alternativeIds(outOfStock, 1), ["F46700"]);
  const liveDown = fakeDeps([blowtorch, mastrad, safico], { "BTS-8026D": "fail" });
  assert.deepEqual(await alternativeIds(liveDown, 1), ["F46700"]);
});

test("alternatives drop products with less stock than the customer needs", async () => {
  const short = fakeDeps([blowtorch, mastrad, safico], { "BTS-8026D": { available_quantity: 5 } });
  assert.deepEqual(await alternativeIds(short, 10), ["F46700"]);
});

test("match_photo needs a photo in this turn", async () => {
  const outcome = await runTool("match_photo", {}, context());
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /NO_PHOTO/);
});

test("update_enquiry changes the turn's enquiry", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], tappedId: "BTS-8026D" });
  const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
  assert.equal(outcome.isError, false);
  assert.equal(ctx.lines[0].quantity, 2);
  assert.ok(ctx.seen.has("BTS-8026D"));
});

test("a line that could not be re-checked can be removed or cleared, but not changed", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], clearTexts: ["clear it all"], uncheckedCodes: ["BTS-8026D", "F46700"] });
  const changed = await runTool("update_enquiry", { action: "add", stock_id: "bts-8026d", quantity: 2 }, ctx);
  assert.match(changed.content, /STOCK_UNVERIFIED/);
  const removed = await runTool("update_enquiry", { action: "remove", stock_id: "BTS-8026D" }, ctx);
  assert.equal(removed.isError, false);
  assert.deepEqual(ctx.uncheckedCodes, ["F46700"]);
  const cleared = await runTool("update_enquiry", { action: "clear" }, ctx);
  assert.equal(cleared.isError, false);
  assert.deepEqual(ctx.uncheckedCodes, []);
});

test("while a line is unchecked, update_enquiry results tell Claude not to quote a total or item count", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["F46700"], tappedId: "BTS-8026D" });
  const added = JSON.parse((await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx)).content) as { unchecked?: string };
  assert.match(added.unchecked ?? "", /Unchecked lines \(kept by the customer, not in these lines or totals\): F46700\./);
  assert.match(added.unchecked ?? "", /Don't quote an enquiry total or item count/);
  const removed = JSON.parse((await runTool("update_enquiry", { action: "remove", stock_id: "F46700" }, ctx)).content) as { unchecked?: string };
  assert.equal(removed.unchecked, undefined);
});

const addSafico = (overrides: Partial<TurnContext>, action: "add" | "set" = "add") => runTool("update_enquiry", { action, stock_id: "BTS-8026D", quantity: 2 }, context(undefined, overrides));
const twoCards = [{ code: "970S", name: blowtorch.name }, { code: "BTS-8026D", name: safico.name }];

test("a product whose card the customer tapped this turn can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["2 please"], tappedId: "bts-8026d", previousCards: twoCards })).isError, false);
});

test("a product already on the enquiry can have its quantity changed", async () => {
  const lines = [{ item: safico.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 1, total: 23.36, uom: "PC" }];
  const outcome = await addSafico({ customerTexts: ["make it 2"], lines, previousCards: twoCards }, "set");
  assert.equal(outcome.isError, false);
});

test("a product whose item code the customer typed can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["2 pcs of bts-8026d"], previousCards: twoCards })).isError, false);
});

test("the only product card in Claire's previous reply can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["ok 2"], previousCards: [{ code: "BTS-8026D", name: safico.name }] })).isError, false);
});

test("a product named by a word no other card in the previous reply shares can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["the safico one, 2 pcs"], previousCards: twoCards })).isError, false);
});

test("a named product that wasn't a card in the previous reply is refused", async () => {
  // First message: the search finds several torches and nothing has been shown yet, so none of them was chosen.
  const ctx = context(undefined, { customerTexts: ["I need 2 blow torches"] });
  await runTool("search_catalogue", { queries: ["torch"] }, ctx);
  const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
  assert.match(outcome.content, /PRODUCT_NOT_CHOSEN/);
  assert.match((await addSafico({ customerTexts: ["I need 2 safico torches"] })).content, /PRODUCT_NOT_CHOSEN/);
});

test("a product the customer didn't pick out of several is refused", async () => {
  for (const text of ["ok 2", "2 torches"]) {
    const ctx = context(undefined, { customerTexts: [text], previousCards: twoCards });
    const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
    assert.equal(outcome.isError, true, text);
    assert.match(outcome.content, /PRODUCT_NOT_CHOSEN/, text);
    assert.deepEqual(ctx.lines, [], text);
  }
});

test("a PRODUCT_NOT_CHOSEN refusal tells Claude to show the product as a card first", async () => {
  const outcome = await addSafico({ customerTexts: ["2 torches"], previousCards: twoCards });
  assert.deepEqual(JSON.parse(outcome.content), { error: "PRODUCT_NOT_CHOSEN", note: "Show this product as a card and let the customer tap it or say which one first." });
});

test("clearing checks the texts that may ask for it, which include a tapped chip", async () => {
  const refused = await runTool("update_enquiry", { action: "clear" }, context(undefined, { customerTexts: ["blow torch"], clearTexts: ["blow torch"] }));
  assert.match(refused.content, /CLEAR_NOT_REQUESTED/);
  const cleared = await runTool("update_enquiry", { action: "clear" }, context(undefined, { customerTexts: ["blow torch"], clearTexts: ["Start over", "blow torch"] }));
  assert.equal(cleared.isError, false);
});

test("a query with the ″ inch sign Claude copied from the facts still matches a catalogue name with a raw double quote", async () => {
  const wok = product({ stock_id: "WOK18", name: `WOK 18"` });
  const outcome = await runTool("search_catalogue", { queries: ["wok 18″"] }, context(fakeDeps([wok])));
  assert.deepEqual((JSON.parse(outcome.content) as { products: Array<{ stock_id: string }> }).products.map((item) => item.stock_id), ["WOK18"]);
});

test("a one-character search such as 刀 is accepted", async () => {
  const outcome = await runTool("search_catalogue", { queries: ["刀"] }, context());
  assert.equal(outcome.isError, false);
});

test("invalid input is rejected without running the tool", async () => {
  const outcome = await runTool("search_catalogue", { queries: [] }, context());
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /INVALID_INPUT/);
});
