// src/lib/agent/tools.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "@/lib/chat-contract";
import { cardsNote } from "./contract";
import { turnDeps, type CheckedProduct } from "./facts";
import { pickEvidence } from "./picks";
import { agentTools, runTool, type TurnContext } from "./tools";
import { fakeDeps, product } from "./testing";

const blowtorch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31 });
const mastrad = product({ stock_id: "F46700", name: "Mastrad Cooking Torch", list_price: 40 });
const safico = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", list_price: 23.36 });

function context(deps = fakeDeps([blowtorch, mastrad, safico]), overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    deps, seen: new Map<string, CheckedProduct>(), lines: [], changes: [], uncheckedCodes: [], customerTexts: [], clearTexts: [], image: null, shownIds: new Set(),
    picks: { taps: [], texts: [], replies: [] }, searches: [], ...overrides,
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

const torches = (count: number) => Array.from({ length: count }, (_, index) => product({ stock_id: `T${index + 1}`, name: `TORCH ${index + 1}` }));
type FactBody = { stock_id: string; price_ex_gst: number | null; stock: string; available_quantity: number | null; price_and_stock_verified_live: boolean };

test("every search result is live-checked", async () => {
  const deps = fakeDeps(torches(10));
  const body = JSON.parse((await runTool("search_catalogue", { queries: ["torch"] }, context(deps))).content) as { products: FactBody[] };
  assert.equal(body.products.length, 10);
  assert.ok(body.products.every((item) => item.price_and_stock_verified_live && item.available_quantity === 50));
  assert.equal(deps.calls.filter((call) => call.startsWith("live:")).length, 10);
  assert.match(agentTools[0].description ?? "", /Returns up to 10 products; each one's price and stock are checked live on the store \(price_and_stock_verified_live\)\./);
});

test("a failed live check leaves that one result unverified, with no price or stock", async () => {
  const ctx = context(fakeDeps(torches(4), { T3: "fail" }));
  const body = JSON.parse((await runTool("search_catalogue", { queries: ["torch"] }, ctx)).content) as { products: FactBody[] };
  const failed = body.products.find((item) => item.stock_id === "T3")!;
  assert.deepEqual([failed.price_ex_gst, failed.stock, failed.available_quantity, failed.price_and_stock_verified_live], [null, "unknown", null, false]);
  assert.ok(body.products.filter((item) => item.stock_id !== "T3").every((item) => item.price_and_stock_verified_live));
  const remembered = ctx.seen.get("T3")?.product;
  assert.deepEqual([remembered?.in_stock, remembered?.available_quantity], [null, null]);
});

test("keepBest never turns a live-checked product back into an unchecked one", async () => {
  const torch = product({ stock_id: "T7", name: "TORCH 7", list_price: 12 });
  const seen = new Map<string, CheckedProduct>([["T7", { product: { ...torch, list_price: 12.5 }, verified: true }]]);
  const ctx = context(fakeDeps([torch], { T7: "fail" }), { seen });
  const body = JSON.parse((await runTool("get_product", { stock_id: "T7" }, ctx)).content) as { product: FactBody };
  assert.deepEqual([ctx.seen.get("T7")?.verified, ctx.seen.get("T7")?.product.list_price], [true, 12.5]);
  assert.deepEqual([body.product.price_and_stock_verified_live, body.product.price_ex_gst], [true, 12.5]);
});

test("a product live-checked earlier in the turn is not fetched again", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  const ctx = context(undefined, { deps: turnDeps(deps) });
  await runTool("search_catalogue", { queries: ["blow torch"] }, ctx);
  await runTool("search_catalogue", { queries: ["kitchen blow torch"] }, ctx);
  assert.deepEqual(deps.calls.filter((call) => call.startsWith("live:")), ["live:970S"]);
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

test("a category's products are merged with the query results, without duplicates", async () => {
  const kitchenTongs = product({ stock_id: "TG1", name: "SALAD TONGS 30CM", subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers" });
  const clamp = product({ stock_id: "TG2", name: "BBQ GRILL CLAMP", subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers" });
  const servingTongs = product({ stock_id: "TG3", name: "BUFFET SERVING TONGS", subcategory: "Serving utensils", third_category: "Serving tongs" });
  const ctx = context(fakeDeps([kitchenTongs, clamp, servingTongs]));
  const outcome = await runTool("search_catalogue", { queries: ["tongs"], category: "kitchen tongs" }, ctx);
  const body = JSON.parse(outcome.content) as { products: Array<{ stock_id: string; price_and_stock_verified_live: boolean }>; total_found: number; more_available: boolean; complete: boolean };
  assert.deepEqual(body.products.map((item) => item.stock_id), ["TG1", "TG2", "TG3"]);
  assert.ok(body.products.every((item) => item.price_and_stock_verified_live));
  assert.deepEqual([body.total_found, body.more_available, body.complete], [3, false, true]);
  assert.ok(ctx.seen.has("TG2"));
});

type SearchBody = {
  products: Array<{ stock_id: string }>; total_found: number; more_available: boolean; complete: boolean;
  category_found?: boolean; categories: string[]; category_note?: string;
};
const searchBody = async (input: unknown, deps: ReturnType<typeof fakeDeps>) => JSON.parse((await runTool("search_catalogue", input, context(deps))).content) as SearchBody;
const tongs = (count: number, overrides: Partial<Product> = {}) => Array.from({ length: count }, (_, index) => product({
  stock_id: `TONG${index + 1}`, name: `COOKING TONGS ${index + 1}`, subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers", ...overrides,
}));

test("a category search puts in-category query hits and category products ahead of off-category hits", async () => {
  const torch = product({ stock_id: "CT1", name: "COOKING TORCH", subcategory: "Kitchen tools", third_category: "Gas lighters" });
  const thermometer = product({ stock_id: "CT2", name: "COOKING THERMOMETER", subcategory: "Kitchen tools", third_category: "Thermometers" });
  const body = await searchBody({ queries: ["cooking tongs", "cooking"], category: "kitchen tongs" }, fakeDeps([torch, thermometer, ...tongs(12)]));
  assert.equal(body.products.length, 10);
  assert.ok(body.products.every((item) => item.stock_id.startsWith("TONG")));
});

test("max_price is applied to the whole category before the 10-row cut", async () => {
  const cheap = product({ stock_id: "ZZ", name: "ZZ TONG", list_price: 5, subcategory: "Cooking utensils", third_category: "Kitchen tongs and tweezers" });
  const body = await searchBody({ queries: ["tongs"], category: "kitchen tongs", max_price: 10 }, fakeDeps([...tongs(15, { list_price: 30 }), cheap]));
  assert.deepEqual(body.products.map((item) => item.stock_id), ["ZZ"]);
  assert.deepEqual([body.total_found, body.complete], [1, true]);
});

test("complete is true only when every product in the category is listed", async () => {
  const small = await searchBody({ queries: ["utility tong"], category: "kitchen tongs" }, fakeDeps(tongs(4)));
  assert.deepEqual([small.products.length, small.complete, small.more_available], [4, true, false]);
  const large = await searchBody({ queries: ["utility tong"], category: "kitchen tongs" }, fakeDeps(tongs(12)));
  assert.deepEqual([large.products.length, large.complete, large.more_available, large.total_found], [10, false, true, 12]);
});

test("excluded products count as covered", async () => {
  const body = await searchBody({ queries: ["utility tong"], category: "kitchen tongs", exclude_ids: ["tong11"] }, fakeDeps(tongs(11)));
  assert.deepEqual([body.products.length, body.complete, body.more_available], [10, true, false]);
});

test("each search is recorded for the claim checks", async () => {
  const ctx = context(fakeDeps(tongs(4)));
  await runTool("search_catalogue", { queries: ["utility tong", "tongs"], category: "kitchen tongs", max_price: 20 }, ctx);
  await runTool("search_catalogue", { queries: ["torch"] }, ctx);
  assert.deepEqual(ctx.searches, [
    { queries: ["utility tong", "tongs"], category: "kitchen tongs", categoryFound: true, maxPrice: 20, complete: true },
    { queries: ["torch"], category: null, categoryFound: false, maxPrice: null, complete: false },
  ]);
});

test("a query hit named with every word of the query stays ahead of a near-miss category", async () => {
  const makers = Array.from({ length: 12 }, (_, index) => product({
    stock_id: `CM${index + 1}`, name: `COFFEE MAKER ${index + 1}`, subcategory: "Beverage equipment", third_category: "Coffee machines and grinders",
  }));
  const bag = product({ stock_id: "BAG4", name: "COFFEE BAG 4 INCH", subcategory: "Beverage supplies", third_category: "Hot drinks and specialty items" });
  const body = await searchBody({ queries: ["coffee bag"], category: "coffee" }, fakeDeps([...makers, bag]));
  assert.equal(body.products[0].stock_id, "BAG4");
});

test("a category that matches nothing is reported with the categories of the results", async () => {
  const torches = [
    product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", subcategory: "Kitchen tools", third_category: "Gas lighters" }),
    product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER", subcategory: "Kitchen tools", third_category: "Gas lighters" }),
    product({ stock_id: "KT1", name: "KITCHEN TORCH LIGHTER", subcategory: "Kitchen tools", third_category: "Kitchen gadgets" }),
  ];
  const body = await searchBody({ queries: ["torch"], category: "hand mixers" }, fakeDeps(torches));
  assert.equal(body.category_found, false);
  assert.equal(body.categories[0], "Gas lighters");
  assert.equal(body.category_note, "No catalogue category matches 'hand mixers'. Categories among these results: Gas lighters, Kitchen gadgets.");
  const plain = await searchBody({ queries: ["torch"] }, fakeDeps(torches));
  assert.equal(plain.category_found, undefined);
});

test("a failed category search is reported and the query results are still used", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  deps.searchCategory = async () => { throw new Error("down"); };
  const body = await searchBody({ queries: ["blow torch"], category: "gas lighters" }, deps);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["970S"]);
  assert.equal(body.category_note, "Category search failed.");
});

test("the tool description no longer suggests a category that matches nothing, and queries take 1-3 phrases", () => {
  const search = agentTools.find((tool) => tool.name === "search_catalogue")!;
  const properties = search.input_schema.properties as Record<string, { description?: string; minItems?: number; maxItems?: number }>;
  assert.doesNotMatch(properties.category.description ?? "", /hand mixers/);
  assert.deepEqual([properties.queries.minItems, properties.queries.maxItems], [1, 3]);
  assert.match(search.description ?? "", /complete true means every product in the category is listed; only then may you say that is all\./);
});

test("queries sent as one string are accepted", async () => {
  const one = await searchBody({ queries: "blow torch" }, fakeDeps([blowtorch, mastrad, safico]));
  assert.deepEqual(one.products.map((item) => item.stock_id), ["970S"]);
  // Claude once sent its list as a single string: "blow torch\", \"safico".
  const joined = await searchBody({ queries: `blow torch", "safico` }, fakeDeps([blowtorch, mastrad, safico]));
  assert.deepEqual(joined.products.map((item) => item.stock_id), ["970S", "BTS-8026D"]);
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

type AlternativesBody = { products: Array<{ stock_id: string }>; note?: string };
const alternativesFor = async (stockId: string, catalogue: ReturnType<typeof product>[]) => JSON.parse(
  (await runTool("find_alternatives", { stock_id: stockId }, context(fakeDeps(catalogue)))).content,
) as AlternativesBody;

test("find_alternatives keeps candidates that share a name word, same leaf category first", async () => {
  const body = await alternativesFor("F46700", [
    product({ stock_id: "F46700", name: "MASTRAD COOKING TORCH", brand: "MASTRAD", third_category: "Gas lighters" }),
    product({ stock_id: "BOWL", name: "S/S MAR BOWL", third_category: "Bowls", available_quantity: 2000 }),
    product({ stock_id: "BLOWTORCH", name: "KITCHEN BLOWTORCH", third_category: "Kitchen tools" }),
    product({ stock_id: "CARTRIDGE", name: "GAS CARTRIDGE", third_category: "Gas lighters" }),
    product({ stock_id: "BURNER", name: "CASSETTE GAS TORCH BURNER", third_category: "Gas lighters" }),
  ]);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["BURNER", "BLOWTORCH"]);
});

test("alternatives with only generic words in common are dropped", async () => {
  const body = await alternativesFor("HB1", [
    product({ stock_id: "HB1", name: "CORDLESS HAND BLENDER 1 YEAR WARRANTY" }),
    product({ stock_id: "FAN", name: "STAND FAN 1 YEAR WARRANTY" }),
    product({ stock_id: "STICK", name: "STICK BLENDER" }),
  ]);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["STICK"]);
});

test("find_alternatives returns nothing rather than unrelated products", async () => {
  const body = await alternativesFor("4020", [
    product({ stock_id: "4020", name: "BAIN MARIE POT 12QT" }),
    product({ stock_id: "FP24", name: "FRYING PAN 24CM" }),
    product({ stock_id: "FP28", name: "FRYING PAN 28CM" }),
  ]);
  assert.deepEqual(body.products, []);
  assert.equal(body.note, "No close in-stock match in the same range. Check size and capacity against what the customer needs; search with the customer's words and size (e.g. 'stock pot 12L') before saying there is no substitute.");
});

test("match_photo needs a photo in this turn", async () => {
  const outcome = await runTool("match_photo", {}, context());
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /NO_PHOTO/);
});

const twoCardsReply = { role: "assistant" as const, content: `Two options.${cardsNote([blowtorch, safico])}` };
/** What the customer did this turn after Claire showed the torch and the Safico: a tap, or a typed text. */
const tappedAfterTwo = (code: string) => pickEvidence([twoCardsReply], { type: "select_product", stockId: code });
const typedAfter = (history: Parameters<typeof pickEvidence>[0], text: string) => pickEvidence(history, { type: "text", text });

test("update_enquiry changes the turn's enquiry", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], picks: tappedAfterTwo("BTS-8026D") });
  const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
  assert.equal(outcome.isError, false);
  assert.equal(ctx.lines[0].quantity, 2);
  assert.ok(ctx.seen.has("BTS-8026D"));
});

test("a successful update is recorded in ctx.changes; a refused one is not", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], picks: tappedAfterTwo("BTS-8026D") });
  assert.match((await runTool("update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }, ctx)).content, /PRODUCT_NOT_CHOSEN/);
  assert.deepEqual(ctx.changes, []);
  await runTool("update_enquiry", { action: "add", stock_id: "bts-8026d", quantity: 2 }, ctx);
  assert.deepEqual(ctx.changes, [{ action: "add", code: "BTS-8026D" }]); // the catalogue's spelling
});

test("removing a line that could not be re-checked is recorded as a change", async () => {
  const ctx = context(undefined, { uncheckedCodes: ["F46700"] });
  await runTool("update_enquiry", { action: "remove", stock_id: "F46700" }, ctx);
  assert.deepEqual(ctx.changes, [{ action: "remove", code: "F46700" }]);
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
  const ctx = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["F46700"], picks: tappedAfterTwo("BTS-8026D") });
  const added = JSON.parse((await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx)).content) as { unchecked?: string };
  assert.match(added.unchecked ?? "", /Unchecked lines \(kept by the customer, not in these lines or totals\): F46700\./);
  assert.match(added.unchecked ?? "", /Don't quote an enquiry total or item count/);
  const removed = JSON.parse((await runTool("update_enquiry", { action: "remove", stock_id: "F46700" }, ctx)).content) as { unchecked?: string };
  assert.equal(removed.unchecked, undefined);
});

const addSafico = (overrides: Partial<TurnContext>, action: "add" | "set" = "add") => runTool("update_enquiry", { action, stock_id: "BTS-8026D", quantity: 2 }, context(undefined, overrides));

test("a product whose card the customer tapped this turn can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["2 please"], picks: tappedAfterTwo("bts-8026d") })).isError, false);
});

test("a product already on the enquiry can have its quantity changed", async () => {
  const lines = [{ item: safico.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 1, total: 23.36, uom: "PC" }];
  const outcome = await addSafico({ customerTexts: ["make it 2"], lines, picks: typedAfter([twoCardsReply], "make it 2") }, "set");
  assert.equal(outcome.isError, false);
});

test("a product whose item code the customer typed can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["2 pcs of bts-8026d"], picks: typedAfter([twoCardsReply], "2 pcs of bts-8026d") })).isError, false);
});

test("a yes to the only product card in Claire's previous reply adds it", async () => {
  const oneCard = { role: "assistant" as const, content: `This one runs on gas.${cardsNote([safico])}` };
  assert.equal((await addSafico({ customerTexts: ["ok 2"], picks: typedAfter([oneCard], "ok 2") })).isError, false);
});

test("a product named by a word no other card in the previous reply shares can be added", async () => {
  assert.equal((await addSafico({ customerTexts: ["the safico one, 2 pcs"], picks: typedAfter([twoCardsReply], "the safico one, 2 pcs") })).isError, false);
});

test("a product named before it was shown as a card is refused", async () => {
  // First message: the search finds several torches and nothing has been shown yet, so none of them was chosen.
  const ctx = context(undefined, { customerTexts: ["I need 2 blow torches"], picks: typedAfter([], "I need 2 blow torches") });
  await runTool("search_catalogue", { queries: ["torch"] }, ctx);
  const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
  assert.match(outcome.content, /PRODUCT_NOT_CHOSEN/);
  assert.match((await addSafico({ customerTexts: ["I need 2 safico torches"], picks: typedAfter([], "I need 2 safico torches") })).content, /PRODUCT_NOT_CHOSEN/);
});

test("a product the customer didn't pick out of several is refused", async () => {
  for (const text of ["ok 2", "2 torches"]) {
    const ctx = context(undefined, { customerTexts: [text], picks: typedAfter([twoCardsReply], text) });
    const outcome = await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx);
    assert.equal(outcome.isError, true, text);
    assert.match(outcome.content, /PRODUCT_NOT_CHOSEN/, text);
    assert.deepEqual(ctx.lines, [], text);
  }
});

test("a PRODUCT_NOT_CHOSEN refusal tells Claude what to do and which products the customer did pick", async () => {
  const history = [twoCardsReply, { role: "user" as const, content: "[tap] Picked: KITCHEN BLOW TORCH 970S (code 970S)" }, { role: "assistant" as const, content: "How many do you need?" }];
  const outcome = await addSafico({ customerTexts: ["2 torches"], picks: typedAfter(history, "2 torches") });
  const body = JSON.parse(outcome.content) as { error: string; note: string; picked: string[] };
  assert.deepEqual(Object.keys(body), ["error", "note", "picked"]);
  assert.equal(body.error, "PRODUCT_NOT_CHOSEN");
  assert.deepEqual(body.picked, ["970S"]);
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
