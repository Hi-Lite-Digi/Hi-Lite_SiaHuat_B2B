// src/lib/agent/tools.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "@/lib/chat-contract";
import { QTY_NOTICE } from "./enquiry";
import { turnDeps, type CheckedProduct } from "./facts";
import { agentTools, runTool, startPickCheck, type ToolOutcome, type TurnContext } from "./tools";
import { fakeDeps, fakePickCheck, product } from "./testing";
import { pickCheckCache } from "./verify";

const blowtorch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31 });
const mastrad = product({ stock_id: "F46700", name: "Mastrad Cooking Torch", list_price: 40 });
const safico = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", list_price: 23.36 });

function context(deps = fakeDeps([blowtorch, mastrad, safico]), overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    deps, seen: new Map<string, CheckedProduct>(), lines: [], changes: [], uncheckedCodes: [], customerTexts: [], clearTexts: [], image: null, shownIds: new Set(),
    searches: [], refused: [], tapped: null, checkPick: pickCheckCache(fakePickCheck()), photoMatches: new Map(), kept: [], refusedKeys: new Set(), pickFast: 0,
    ...overrides,
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
  // exam 3: the raw token 'in_stock' leaked into 2 replies, so the fact says it in plain words.
  assert.ok(body.products.every((item) => item.stock === "in stock"));
  assert.equal(deps.calls.filter((call) => call.startsWith("live:")).length, 10);
  assert.match(agentTools[0].description ?? "", /checked live/);
  assert.match(agentTools[0].description ?? "", /price_and_stock_verified_live/);
});

test("a failed live check leaves that one result unverified, with no price or stock", async () => {
  const ctx = context(fakeDeps(torches(4), { T3: "fail" }));
  const body = JSON.parse((await runTool("search_catalogue", { queries: ["torch"] }, ctx)).content) as { products: FactBody[] };
  const failed = body.products.find((item) => item.stock_id === "T3")!;
  assert.deepEqual([failed.price_ex_gst, failed.stock, failed.available_quantity, failed.price_and_stock_verified_live], [null, "not checked", null, false]);
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

const specs = { "970S": { "Country of Brand Origin": "JAPAN", Material: "BRASS", Microwaveable: "N" } };
type DetailBody = { stock_id: string; details: Record<string, string> | null; price_and_stock_verified_live: boolean };

test("search results carry the catalogue spec fields, even when the live check fails", async () => {
  const ctx = context(fakeDeps([blowtorch, mastrad, safico], { "970S": "fail" }, null, specs));
  const body = JSON.parse((await runTool("search_catalogue", { queries: ["torch"] }, ctx)).content) as { products: DetailBody[] };
  const torch = body.products.find((item) => item.stock_id === "970S")!;
  assert.equal(torch.price_and_stock_verified_live, false);
  assert.deepEqual(torch.details, { "Country of Brand Origin": "JAPAN", Material: "BRASS" });
  assert.equal(body.products.find((item) => item.stock_id === "F46700")?.details, null);
});

test("a failed spec lookup leaves details null and the search still succeeds", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico], {}, null, specs);
  deps.findDetails = async () => { throw new Error("DB_DOWN"); };
  const outcome = await runTool("search_catalogue", { queries: ["torch"] }, context(deps));
  const body = JSON.parse(outcome.content) as { products: DetailBody[] };
  assert.equal(outcome.isError, false);
  assert.equal(body.products.length, 3);
  assert.ok(body.products.every((item) => item.details === null && item.price_and_stock_verified_live));
});

test("details are fetched in one batch per search", async () => {
  const deps = fakeDeps(torches(10));
  await runTool("search_catalogue", { queries: ["torch"] }, context(deps));
  assert.deepEqual(deps.calls.filter((call) => call.startsWith("details:")), [`details:${torches(10).map((item) => item.stock_id).join(",")}`]);
});

test("details already known this turn are kept and not looked up again", async () => {
  const deps = fakeDeps([blowtorch]);
  const seen = new Map<string, CheckedProduct>([["970S", { product: blowtorch, verified: false, details: { Material: "BRASS" } }]]);
  const body = JSON.parse((await runTool("get_product", { stock_id: "970S" }, context(deps, { seen }))).content) as { product: DetailBody };
  assert.equal(body.product.price_and_stock_verified_live, true);
  assert.deepEqual(body.product.details, { Material: "BRASS" });
  assert.equal(deps.calls.some((call) => call.startsWith("details:")), false);
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
  category_found?: boolean; categories: string[]; category_note?: string; brands?: string[];
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

const idsOf = (body: SearchBody) => body.products.map((item) => item.stock_id);
const knives = () => [
  ...[15, 21, 23, 25, 30].flatMap((cm) => ["Red", "Blue"].map((colour) => product({
    stock_id: `A${cm}${colour[0]}`, name: `Atlantic Chef Chef Knife ${cm}cm, ${colour} Handle`, brand: "ATLANTIC CHEF", list_price: cm, third_category: "Chef knives",
  }))),
  product({ stock_id: "G16", name: "Giesser Chef's Knife 16cm With Wide Blade", brand: "GIESSER", third_category: "Chef knives" }),
  product({ stock_id: "G20", name: "Giesser Chef's Knife 20cm With Wide Blade", brand: "GIESSER", third_category: "Chef knives" }),
];

test("colour variants of one product and one brand don't fill the results (exam 3, c01-A T9)", async () => {
  const body = await searchBody({ queries: ["chef knife"], category: "chef knives" }, fakeDeps(knives()));
  const ids = idsOf(body);
  assert.ok(ids.includes("G16") && ids.includes("G20"), ids.join(","));
  const firstSix = ids.slice(0, 6);
  assert.ok(![15, 21, 23, 25, 30].some((cm) => firstSix.includes(`A${cm}R`) && firstSix.includes(`A${cm}B`)), firstSix.join(","));
  assert.deepEqual(body.brands, ["ATLANTIC CHEF", "GIESSER"]);
});

test("a brand the customer names is not capped", async () => {
  const ids = idsOf(await searchBody({ queries: ["atlantic chef knife"], category: "chef knives" }, fakeDeps(knives())));
  assert.deepEqual(ids.slice(0, 5), ["A15R", "A21R", "A23R", "A25R", "A30R"]);
});

test("a brand cap doesn't swap query matches for category filler", async () => {
  // Real catalogue: 'dinner plate' has 7 dinner plates of one brand in its top 10.
  const dinner = Array.from({ length: 7 }, (_, index) => product({
    stock_id: `D${index}`, name: `Petye Porcelain Round Dinner Plate ${20 + index}cm`, brand: "CERABON by PETYE", list_price: 10 + index, third_category: "Plates and platters",
  }));
  const filler = Array.from({ length: 6 }, (_, index) => product({
    stock_id: `F${index}`, name: `Essentials Round Rim Plate ${15 + index}cm`, brand: "CERABON", list_price: 5 + index, third_category: "Plates and platters", available_quantity: 900,
  }));
  const ids = idsOf(await searchBody({ queries: ["dinner plate"], category: "plates" }, fakeDeps([...dinner, ...filler])));
  assert.deepEqual(ids.slice(0, 7).sort(), dinner.map((item) => item.stock_id).sort(), ids.join(","));
});

test("two sizes with one name are not colour variants", async () => {
  const catalogue = [
    product({ stock_id: "1510", name: "PLASTIC CHOPPING BOARD", brand: "A-STAR", list_price: 10 }),
    product({ stock_id: "1517", name: "PLASTIC CHOPPING BOARD", brand: "A-STAR", list_price: 43.12 }),
    ...Array.from({ length: 10 }, (_, index) => product({ stock_id: `W${index}`, name: `WOODEN CHOPPING BOARD ${10 + index}in`, brand: "UB-0497", list_price: 20 + index })),
  ];
  const deps = fakeDeps(catalogue);
  deps.searchDirect = async () => catalogue;
  assert.deepEqual(idsOf(await searchBody({ queries: ["chopping board"] }, deps)).slice(0, 2), ["1510", "1517"]);
});

test("house codes are not brands: not capped and not listed", async () => {
  const woks = [
    ...Array.from({ length: 6 }, (_, index) => product({ stock_id: `UB${index}`, name: `CARBON STEEL WOK ${30 + index}cm`, brand: "UB-0231", list_price: 20 + index, third_category: "Woks" })),
    product({ stock_id: "YM1", name: "IRON WOK 36cm", brand: "YAMADA", third_category: "Woks" }),
  ];
  const body = await searchBody({ queries: ["wok"], category: "woks" }, fakeDeps(woks));
  assert.deepEqual(idsOf(body), ["UB0", "UB1", "UB2", "UB3", "UB4", "UB5", "YM1"]);
  assert.deepEqual(body.brands, ["YAMADA"]);
  // The catalogue's other house-code spellings.
  const gloves = ["UB-06MS", "UB1201", "YAMADA"].map((brand, index) => product({ stock_id: `GL${index}`, name: `COTTON GLOVES ${index}`, brand, third_category: "Gloves" }));
  assert.deepEqual((await searchBody({ queries: ["gloves"], category: "gloves" }, fakeDeps(gloves))).brands, ["YAMADA"]);
});

test("brands are listed only with a category", async () => {
  assert.equal((await searchBody({ queries: ["chef knife"] }, fakeDeps(knives()))).brands, undefined);
  assert.deepEqual((await searchBody({ queries: ["chef knife"], category: "chef knives" }, fakeDeps(knives()))).brands, ["ATLANTIC CHEF", "GIESSER"]);
});

test("exclude_brands leaves a brand out and doesn't make the list complete", async () => {
  // exam 3, c03-stress T6-T9: the customer ruled out Taiwan brands and nothing could leave them out.
  const catalogue = [
    product({ stock_id: "T1", name: "TONGS 9in", brand: "A", third_category: "Kitchen tongs" }),
    product({ stock_id: "T2", name: "TONGS 12in", brand: "A", third_category: "Kitchen tongs" }),
    product({ stock_id: "T3", name: "TONGS 9in PRO", brand: "B", third_category: "Kitchen tongs" }),
    product({ stock_id: "T4", name: "TONGS 12in PRO", brand: "B", third_category: "Kitchen tongs" }),
  ];
  const body = await searchBody({ queries: ["tongs"], category: "kitchen tongs", exclude_brands: ["a"] }, fakeDeps(catalogue));
  assert.deepEqual(idsOf(body).sort(), ["T3", "T4"]);
  // A brand the customer ruled out still exists, so "that's all" would be false.
  assert.equal(body.complete, false);
  // But its rows aren't matches: once the other brand is listed, nothing more is available.
  assert.deepEqual([body.total_found, body.more_available], [2, false]);
  const search = agentTools.find((tool) => tool.name === "search_catalogue")!;
  assert.ok("exclude_brands" in (search.input_schema.properties as Record<string, unknown>));
});

const ladles = () => Array.from({ length: 10 }, (_, index) => product({ stock_id: `L${index}`, name: `S/S LADLE ${index + 1}0cm handle`, third_category: "Kitchen ladles" }));

test("a size in the query puts the category row with that exact size first (exam 3, s01-A T0)", async () => {
  const sized = product({ stock_id: "L8", name: "S/S ONE-PC LADLE 8.0oz", third_category: "Kitchen ladles", available_quantity: 1 });
  const deps = fakeDeps([...ladles(), sized]);
  deps.searchDirect = async () => ladles();
  assert.equal(idsOf(await searchBody({ queries: ["ladle 8oz"], category: "kitchen ladles" }, deps))[0], "L8");
  // The real 1508's name carries every word of the customer's longer query.
  const real = product({ stock_id: "1508", name: "Stainless Steel One-Pieces Ladle Ø10.5 X L30cm, 8.0oz", third_category: "Kitchen ladles", available_quantity: 1 });
  const realDeps = fakeDeps([...ladles(), real]);
  realDeps.searchDirect = async () => ladles();
  assert.equal(idsOf(await searchBody({ queries: ["stainless steel ladle 8oz"], category: "kitchen ladles" }, realDeps))[0], "1508");
});

test("a number without its unit is not a size: other rows keep today's order", async () => {
  const soup = product({ stock_id: "SOUP10", name: "SOUP LADLE 10 INCH", third_category: "Kitchen ladles" });
  const serving = product({ stock_id: "SERVE", name: "SERVING LADLE 25cm", third_category: "Kitchen ladles" });
  const eightOz = product({ stock_id: "OZ8", name: "Stainless Steel Ladle 8oz", third_category: "Kitchen ladles" });
  const cc = product({ stock_id: "CC10", name: "S/S LADLE 10cc", third_category: "Kitchen ladles" });
  const small = product({ stock_id: "SMALL", name: "S/S LADLE 12cm", third_category: "Kitchen ladles" });
  const deps = fakeDeps([soup, serving, eightOz, cc, small]);
  deps.searchDirect = async (query) => (query === "ladle 10 inch" ? [soup, serving] : [eightOz]);
  // Today's order is SOUP10, OZ8, SERVE, CC10, SMALL: only the exact 8oz row moves up; the "10cc" ladle doesn't jump the query hits.
  const ids = idsOf(await searchBody({ queries: ["ladle 10 inch", "stainless steel ladle 8oz"], category: "kitchen ladles" }, deps));
  assert.deepEqual(ids, ["OZ8", "SOUP10", "SERVE", "CC10", "SMALL"]);
  const stick = product({ stock_id: "STICK", name: "IMMERSION BLENDER STICK", third_category: "Blenders" });
  const hand = product({ stock_id: "HAND", name: "HAND BLENDER 2 IN 1", third_category: "Blenders" });
  const blenderDeps = fakeDeps([stick, hand]);
  blenderDeps.searchDirect = async () => [stick];
  assert.deepEqual(idsOf(await searchBody({ queries: ["2 in 1 hand blender"], category: "blenders" }, blenderDeps)), ["STICK", "HAND"]);
});

test("a size inside a longer number is not the customer's size: 6oz is not 16oz, 2oz is not 1/2oz, 2L is not 17.2L", async () => {
  // Exam 3 customers asked for 2oz, 4oz, 6oz and 8oz ladles (s01-A T0, s06); the real "Ladle 16oz" and "LADLE 1/2oz" jumped the query hits.
  const sixteen = product({ stock_id: "OZ16", name: "S/S LADLE 16oz", third_category: "Kitchen ladles", available_quantity: 900 });
  const half = product({ stock_id: "OZHALF", name: "S/S LADLE 1/2oz/14.8ml", third_category: "Kitchen ladles", available_quantity: 800 });
  const hits = ladles().slice(0, 3);
  const six = product({ stock_id: "OZ6", name: "S/S LADLE 6.0oz", third_category: "Kitchen ladles" });
  const two = product({ stock_id: "OZ2", name: "S/S LADLE 2.0oz", third_category: "Kitchen ladles" });
  const deps = fakeDeps([sixteen, half, ...hits, six, two]);
  deps.searchDirect = async () => hits;
  const hitIds = hits.map((item) => item.stock_id);
  assert.deepEqual(idsOf(await searchBody({ queries: ["ladle 6oz"], category: "kitchen ladles" }, deps)).slice(0, 4), ["OZ6", ...hitIds]);
  assert.deepEqual(idsOf(await searchBody({ queries: ["ladle 2oz"], category: "kitchen ladles" }, deps)).slice(0, 4), ["OZ2", ...hitIds]);
  const pots = [
    product({ stock_id: "P172", name: "STOCK POT 17.2L", third_category: "Stock pots", available_quantity: 900 }),
    product({ stock_id: "P2", name: "STOCK POT 2L", third_category: "Stock pots" }),
    product({ stock_id: "P12", name: "STOCK POT 12L", third_category: "Stock pots" }),
  ];
  const potDeps = fakeDeps(pots);
  potDeps.searchDirect = async () => [];
  assert.deepEqual(idsOf(await searchBody({ queries: ["stock pot 2L"], category: "stock pots" }, potDeps)), ["P2", "P172", "P12"]);
});

test("a decimal size in the query is not read as its fraction: 1.5L doesn't put a 5L jug first", async () => {
  const jugs = [
    product({ stock_id: "J05", name: "MEASURING JUG 0.5L", third_category: "Measuring jugs" }),
    product({ stock_id: "J5", name: "MEASURING JUG 5L", third_category: "Measuring jugs" }),
    product({ stock_id: "J1", name: "MEASURING JUG 1L", third_category: "Measuring jugs" }),
    product({ stock_id: "J2", name: "MEASURING JUG 2L", third_category: "Measuring jugs" }),
  ];
  const deps = fakeDeps(jugs);
  deps.searchDirect = async () => [jugs[0], jugs[2], jugs[3]];
  // No exact-size tier: the query hits first, then the category row naming the query's words, as before V11.
  assert.deepEqual(idsOf(await searchBody({ queries: ["measuring jug 1.5L"], category: "measuring jugs" }, deps)), ["J05", "J1", "J2", "J5"]);
});

test("a size after another unit and a slash is still that size: \"16oz/500ml\" is 500ml, but \"1/2oz\" is not 2oz", async () => {
  // The catalogue writes a second unit after a slash ("475Ml/16Oz", "5Kg/8L", '12"/30cm').
  const hits = [
    product({ stock_id: "H1", name: "PC MEASURING CUP", third_category: "Measuring jugs" }),
    product({ stock_id: "H2", name: "PP MEASURING CUP 1000ml", third_category: "Measuring jugs" }),
  ];
  const dual = product({ stock_id: "DUAL", name: "PLASTIC MEASURING CUP 16oz/500ml", third_category: "Measuring jugs" });
  const half = product({ stock_id: "HALF", name: "MEASURING CUP 1/2oz", third_category: "Measuring jugs" });
  const deps = fakeDeps([...hits, dual, half]);
  deps.searchDirect = async () => hits;
  assert.equal(idsOf(await searchBody({ queries: ["measuring cup 500ml"], category: "measuring jugs" }, deps))[0], "DUAL");
  assert.notEqual(idsOf(await searchBody({ queries: ["measuring cup 2oz"], category: "measuring jugs" }, deps))[0], "HALF");
});

test("a query listing sizes of one unit finds rows with any of them, and S/S names match 'stainless steel' (exam 4, s01-B idx 0)", async () => {
  const four = product({ stock_id: "OZ4", name: "S/S ONE-PC LADLE 4.0oz", third_category: "Kitchen ladles" });
  const six = product({ stock_id: "OZ6", name: "S/S ONE-PC LADLE 6.0oz", third_category: "Kitchen ladles" });
  const deps = fakeDeps([...ladles(), four, six]);
  deps.searchDirect = async () => ladles();
  assert.deepEqual(idsOf(await searchBody({ queries: ["stainless steel ladle 4oz 6oz 8oz"], category: "kitchen ladles" }, deps)).slice(0, 2), ["OZ4", "OZ6"]);
});

test("sizes in different units describe one product: every one must match (stock pot 40cm 50l)", async () => {
  // 12 in-category pots that match one size each, and the exact pot in another leaf that only the query search returns.
  const partial = [
    ...["A", "B", "C", "D", "E", "F"].map((brand, index) => product({ stock_id: `P40-${brand}`, name: `${brand}BRAND S/S STOCK POT 40CM ${60 + index * 10}L`, brand: `${brand}brand`, third_category: "Stock pots" })),
    ...["G", "H", "I", "J", "K", "L"].map((brand, index) => product({ stock_id: `P50-${brand}`, name: `${brand}BRAND S/S STOCK POT ${44 + index * 2}CM 50L`, brand: `${brand}brand`, third_category: "Stock pots" })),
  ];
  const exact = product({ stock_id: "EXACT", name: "ZBRAND STOCK POT 40CM 50L", brand: "Zbrand", third_category: "Casseroles" });
  const deps = fakeDeps([...partial, exact]);
  deps.searchDirect = async () => [exact];
  assert.equal(idsOf(await searchBody({ queries: ["stock pot 40cm 50l"], category: "stock pots" }, deps))[0], "EXACT");
});

test("with no category, a row naming every word of a query comes before other query hits (exam 4, s03-B idx 1: rice dispenser)", async () => {
  const near = ["RICE COOKER 1.8L", "RICE COOKER 3L", "RICE SCOOP", "RICE BOWL 11CM"].map((name, index) => product({ stock_id: `R${index}`, name }));
  const dispenser = product({ stock_id: "EK9108S", name: "STAINLESS STEEL FOOD GRADE RICE DISPENSER" });
  const bins = ["INGREDIENT BIN 50L", "FLOUR BIN", "SUGAR BIN", "STORAGE BIN 20L", "MOBILE BIN"].map((name, index) => product({ stock_id: `B${index}`, name }));
  const deps = fakeDeps([...near, dispenser, ...bins]);
  deps.searchDirect = async (query) => (query === "rice dispenser" ? [...near, dispenser] : bins);
  assert.ok(idsOf(await searchBody({ queries: ["rice dispenser", "rice bin"] }, deps)).slice(0, 3).includes("EK9108S"));
});

test("when max_price leaves nothing, the note says the matches are all above it and categories come from them (exam 4, c06-stress idx 2-3)", async () => {
  const skimmers = Array.from({ length: 12 }, (_, index) => product({ stock_id: `SK${index}`, name: `FINE MESH SKIMMER ${index + 10}CM`, list_price: 2.29 + index, third_category: "Skimmers and splatter screens" }));
  const body = await searchBody({ queries: ["fine mesh skimmer"], max_price: 2 }, fakeDeps(skimmers)) as SearchBody & { note?: string };
  assert.deepEqual(body.products, []);
  assert.equal(body.note, "Nothing within max_price among the top matches for these words; they are all above it. Try the customer's own shorter words (one key word) with max_price, or a category from categories, before saying there is nothing cheaper.");
  assert.deepEqual(body.categories, ["Skimmers and splatter screens"]);
  assert.equal(body.more_available, false);
  // No hits at all is still "no matches".
  const none = await searchBody({ queries: ["gelato cabinet"], max_price: 2 }, fakeDeps(skimmers)) as SearchBody & { note?: string };
  assert.equal(none.note, "No catalogue matches for these words. Try other words the customer might mean, or ask one question.");
  // Hits a ruled-out brand or code removed are not "above it": the Waring within budget was left out by exclude_brands.
  const waring = [
    product({ stock_id: "W1", name: "WARING STICK BLENDER 175W", brand: "Waring", list_price: 150, third_category: "Stick blenders" }),
    product({ stock_id: "W2", name: "WARING STICK BLENDER 200W", brand: "Waring", list_price: 30, third_category: "Stick blenders" }),
  ];
  for (const input of [{ exclude_brands: ["Waring"] }, { exclude_ids: ["W1", "W2"] }]) {
    const ruledOut = await searchBody({ queries: ["stick blender"], max_price: 100, ...input }, fakeDeps(waring)) as SearchBody & { note?: string };
    assert.equal(ruledOut.note, "No catalogue matches for these words. Try other words the customer might mean, or ask one question.");
    assert.deepEqual(ruledOut.categories, []);
  }
});

test("a short brand inside a query word is not named by the customer, so it is still capped", async () => {
  // Real brands AG, IR and AKI sit inside "bag", "stir" and "baking".
  const bags = [
    ...Array.from({ length: 6 }, (_, index) => product({
      stock_id: `AG${index}`, name: `AG STORAGE BAG ${20 + index}cm`, brand: "AG", list_price: 5 + index, third_category: "Storage bags",
    })),
    product({ stock_id: "ZIP", name: "ZIP STORAGE BAG 30cm", brand: "OTHER", third_category: "Storage bags" }),
  ];
  assert.deepEqual(idsOf(await searchBody({ queries: ["storage bag"], category: "storage bags" }, fakeDeps(bags))), ["AG0", "AG1", "AG2", "AG3", "ZIP", "AG4", "AG5"]);
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

test("get_product retries a lookup that fails once", async () => {
  const deps = fakeDeps([blowtorch, safico]);
  const { findByCode, findBySourceUrl } = deps;
  let codeTries = 0;
  let urlTries = 0;
  deps.findByCode = async (code) => { codeTries += 1; if (codeTries === 1) throw new Error("DB_DOWN"); return findByCode(code); };
  deps.findBySourceUrl = async (url) => { urlTries += 1; if (urlTries === 1) throw new Error("DB_DOWN"); return findBySourceUrl(url); };
  assert.match((await runTool("get_product", { stock_id: "970S" }, context(deps))).content, /"stock_id":"970S"/);
  assert.match((await runTool("get_product", { url: safico.source_url }, context(deps))).content, /"stock_id":"BTS-8026D"/);
  assert.deepEqual([codeTries, urlTries], [2, 2]);
});

test("the get_product description tells Claude not to re-look-up checked search results", () => {
  const description = agentTools.find((tool) => tool.name === "get_product")?.description ?? "";
  assert.ok(description.includes("don't call get_product for an item a search returned in this turn with price_and_stock_verified_live true"));
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
    product({ stock_id: "HB1", name: "CORDLESS HAND BLENDER PRO, 1 YEAR WARRANTY, UK PLUG, DOMESTIC USE" }),
    product({ stock_id: "FAN", name: "STAND FAN 1 YEAR WARRANTY" }),
    product({ stock_id: "GRINDER", name: "COFFEE GRINDER PRO 1400RPM, 1-PHASE, UK PLUG, COMMERCIAL USE" }),
    product({ stock_id: "STICK", name: "STICK BLENDER" }),
  ]);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["STICK"]);
});

test("a brand name doesn't hide the kind words inside it, and plurals match", async () => {
  const body = await alternativesFor("PN28", [
    product({ stock_id: "PN28", name: "PANASONIC PAN 28CM", brand: "PANASONIC" }),
    product({ stock_id: "WOK", name: "WOK 30CM" }),
    product({ stock_id: "FRY", name: "FRY PANS 24CM" }),
  ]);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["FRY"]);
});

test("a lid or cover for another product is not an alternative, unless a lid is what is out", async () => {
  const pots = [
    product({ stock_id: "4020", name: "Stainless Steel Bain Marie Pot 12Qt/11.4L" }),
    product({ stock_id: "4010C", name: "Stainless Steel Cover For #4010 Pot" }),
    product({ stock_id: "4012C", name: "S/S COVER for #4012 POT" }),
    product({ stock_id: "4010", name: "S/S BAIN MARIE POT 1.25qt/1.2L" }),
  ];
  assert.deepEqual((await alternativesFor("4020", pots)).products.map((item) => item.stock_id), ["4010"]);
  // A cover's closest match is another cover.
  assert.deepEqual((await alternativesFor("4010C", pots)).products.map((item) => item.stock_id), ["4012C", "4020", "4010"]);
});

const altIds = async (deps: ReturnType<typeof fakeDeps>, stockId: string, minQty: number) => (JSON.parse(
  (await runTool("find_alternatives", { stock_id: stockId, min_qty: minQty }, context(deps))).content,
) as AlternativesBody).products.map((item) => item.stock_id);
const MIXERS = "Immersion blenders, whisks and emulsifiers";

test("find_alternatives offers the closest products that have the quantity, not the most stocked (exam 3, c07-persona T7)", async () => {
  const catalogue = [
    product({ stock_id: "FT001", name: "Dynamic Power Whisk Mixer 5 Gal", brand: "DYNAMIC", list_price: 1340.37, third_category: MIXERS }),
    product({ stock_id: "E001", name: "MANUAL SALAD SPINNER 2.5gal/10Ltr", third_category: "Salad spinners", available_quantity: 900 }),
    product({ stock_id: "MX425", name: "Dynamic Standard Mixer With 4 Emulsifying Knife", list_price: 428.44, third_category: MIXERS, available_quantity: 800 }),
    product({ stock_id: "34761", name: "Robot Coupe Mini MP 240 Power Mixer", brand: "ROBOT COUPE", list_price: 730, third_category: MIXERS, available_quantity: 700 }),
    product({ stock_id: "34801L", name: "Robot Coupe MP 350 Ultra Power Mixer", brand: "ROBOT COUPE", list_price: 970, third_category: MIXERS, available_quantity: 4 }),
    product({ stock_id: "MX022", name: "Dynamic Junior Mixer Bi-Function, Up To 5Gal", list_price: 1222.02, third_category: MIXERS, available_quantity: 2 }),
    product({ stock_id: "34311B", name: "Robot Coupe CMP300 Combi Power Mixer", brand: "ROBOT COUPE", list_price: 1295, third_category: MIXERS, available_quantity: 1 }),
  ];
  assert.deepEqual(await altIds(fakeDeps(catalogue), "FT001", 2), ["34801L", "34761", "MX022"]);
});

test("unit words don't make products the same kind", async () => {
  const catalogue = [
    product({ stock_id: "WM", name: "POWER WHISK MIXER 5 GAL" }),
    product({ stock_id: "SPIN", name: "SALAD SPINNER 2.5GAL/10LTR" }),
    product({ stock_id: "HAND", name: "HAND MIXER 450W" }),
  ];
  assert.deepEqual(await altIds(fakeDeps(catalogue), "WM", 1), ["HAND"]);
});

test("a product with no leaf category gets same-series alternatives by name (exam 3, c05-persona T12)", async () => {
  const patra = (cm: number, price: number, quantity: number) => product({
    stock_id: `3500-00${cm}`, name: `Patra Rim Plate ${cm}cm, Porcelain White`, list_price: price, available_quantity: quantity, category: "Dinnerware",
  });
  const deps = fakeDeps([
    product({ stock_id: "3500-0018", name: "Patra Rim Plate 18cm", list_price: 7.8, available_quantity: 1, category: "Dinnerware" }),
    patra(16, 6.51, 237), patra(25, 13.12, 106), patra(28, 18.9, 68),
    product({ stock_id: "SH16", name: "PORCELAIN ROUND PLATE 16.25cm, SHANGRILA" }),
  ]);
  deps.findAlternatives = async () => [];
  assert.deepEqual(await altIds(deps, "3500-0018", 4), ["3500-0016", "3500-0025", "3500-0028"]);
  assert.equal(deps.calls.filter((call) => call === "search:Patra Rim Plate").length, 1);
});

test("a failed series search still returns the catalogue's alternatives", async () => {
  const deps = fakeDeps([product({ stock_id: "A1", name: "Patra Rim Plate 18cm" }), product({ stock_id: "B1", name: "Other Rim Plate 18cm" })]);
  deps.searchDirect = async () => { throw new Error("SUPABASE_SEARCH_500"); };
  assert.deepEqual(await altIds(deps, "A1", 1), ["B1"]);
});

test("series siblings must be in the same unit, have the quantity and not be the item itself", async () => {
  const plate = (stockId: string, cm: number, overrides: Partial<Product> = {}) => product({
    stock_id: stockId, name: `Patra Rim Plate ${cm}cm`, list_price: cm, category: "Dinnerware", ...overrides,
  });
  const deps = fakeDeps([
    plate("PATRA18", 18, { available_quantity: 100 }),
    plate("PATRA16", 16, { available_quantity: 237 }),
    plate("PATRA25", 25, { uom_id: "SET", available_quantity: 106 }),
    plate("PATRA28", 28, { available_quantity: 3 }),
  ]);
  deps.findAlternatives = async () => [];
  // The code typed in lower case is not in the exclude list: only the check against the item itself keeps it out.
  assert.deepEqual(await altIds(deps, "patra18", 4), ["PATRA16"]);
  // A sibling without the quantity doesn't use up a live check.
  assert.ok(!deps.calls.includes("live:PATRA28"), deps.calls.join(","));
});

test("a series-search hit from another series is not an alternative", async () => {
  // Exam 3 check on the real catalogue: a name search offered refuse bins for a step stool.
  const catalogue = [
    product({ stock_id: "MSS", name: "Vicando Mobile Step Stool with Wheels Ø40.6X34.3cm", brand: "VICANDO", list_price: 56.15, third_category: "Step stools and ladders" }),
    product({ stock_id: "FSS", name: "Vicando Two-Step Folding Stepstool W49xH58", brand: "VICANDO", list_price: 53.67, third_category: "Step stools and ladders" }),
    product({ stock_id: "NT120", name: "Vicando Mobile Refuse Bin with Wheels 120L", brand: "VICANDO", list_price: 85.5, third_category: "Refuse bins" }),
  ];
  const deps = fakeDeps(catalogue);
  deps.findAlternatives = async () => catalogue.filter((item) => item.stock_id === "FSS");
  deps.searchDirect = async () => catalogue.filter((item) => item.stock_id !== "FSS");
  assert.deepEqual(await altIds(deps, "MSS", 1), ["FSS"]);
});

test("out-of-stock series siblings don't use up the live checks", async () => {
  const source = product({ stock_id: "W1", name: "Dynamic Power Whisk Mixer 5 Gal", brand: "DYNAMIC", list_price: 1340, third_category: MIXERS });
  const siblings = Array.from({ length: 8 }, (_, index) => product({
    stock_id: `SIB${index}`, name: `Dynamic Power Whisk Mixer ${index + 2} Gal`, brand: "DYNAMIC", list_price: 1300 + index, third_category: MIXERS,
    stock_status: "out_of_stock", in_stock: false, available_quantity: 0,
  }));
  const pool = [product({ stock_id: "MP350", name: "Robot Coupe MP 350 Ultra Power Mixer", brand: "ROBOT COUPE", list_price: 970, third_category: MIXERS, available_quantity: 4 })];
  const deps = fakeDeps([source, ...siblings, ...pool]);
  deps.findAlternatives = async () => pool;
  deps.searchDirect = async () => siblings;
  assert.deepEqual(await altIds(deps, "W1", 1), ["MP350"]);
  assert.deepEqual(deps.calls.filter((call) => call.startsWith("live:SIB")), []);
});

test("find_alternatives live-checks the product it was asked about and keeps it for the reply", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico], { "970S": { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 } });
  const ctx = context(deps);
  const body = JSON.parse((await runTool("find_alternatives", { stock_id: "970S" }, ctx)).content) as AlternativesBody & { source?: FactBody };
  assert.deepEqual([ctx.seen.get("970S")?.verified, ctx.seen.get("970S")?.product.stock_status], [true, "out_of_stock"]);
  assert.deepEqual([body.source?.stock_id, body.source?.stock, body.source?.price_and_stock_verified_live], ["970S", "out of stock", true]);
  assert.deepEqual(body.products.map((item) => item.stock_id), ["F46700", "BTS-8026D"]);
});

test("when no candidate's stock could be checked, find_alternatives says so instead of 'no close match'", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico], { F46700: "fail", "BTS-8026D": "fail" });
  const body = JSON.parse((await runTool("find_alternatives", { stock_id: "970S" }, context(deps))).content) as AlternativesBody;
  assert.deepEqual(body.products, []);
  assert.match(body.note ?? "", /couldn't be checked/);
  assert.doesNotMatch(body.note ?? "", /No close in-stock match/);
});

test("a look for alternatives is recorded for the absence check, unless it failed or no stock could be checked", async () => {
  // exam 4, s03-B idx 1: "no close substitute" was repaired as unbacked after find_alternatives had run.
  const ctx = context(fakeDeps([blowtorch, mastrad, safico]));
  await runTool("find_alternatives", { stock_id: "970S" }, ctx);
  assert.deepEqual(ctx.searches, [{ queries: [], category: null, categoryFound: false, maxPrice: null, complete: false, alternativesFor: "970S" }]);
  const unchecked = context(fakeDeps([blowtorch, mastrad, safico], { F46700: "fail", "BTS-8026D": "fail" }));
  await runTool("find_alternatives", { stock_id: "970S" }, unchecked);
  assert.deepEqual(unchecked.searches, []);
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

/** A context whose pick check answers with `answer`; check.calls lists the proposals it was asked about. */
function checked(answer: Parameters<typeof fakePickCheck>[0] = {}, overrides: Partial<TurnContext> = {}, deps = fakeDeps([blowtorch, mastrad, safico])) {
  const check = fakePickCheck(answer);
  return { ctx: context(deps, { checkPick: pickCheckCache(check), ...overrides }), check };
}
const update = (ctx: TurnContext, input: Record<string, unknown>) => runTool("update_enquiry", input, ctx);
const addSafico = (ctx: TurnContext, quantity = 2) => update(ctx, { action: "add", stock_id: "BTS-8026D", quantity });
const bodyOf = (outcome: ToolOutcome) => JSON.parse(outcome.content) as Record<string, unknown> & { error?: string; note?: string; notice?: string };
const saficoLine = (quantity: number) => ({ item: safico.name, code: "BTS-8026D", pricePerItem: 23.36, quantity, total: 23.36 * quantity, uom: "PC" });
const linesOf = (ctx: TurnContext) => ctx.lines.map((line) => [line.code, line.quantity]);

test("update_enquiry changes the turn's enquiry once the check confirms the pick", async () => {
  const { ctx, check } = checked({}, { customerTexts: ["2 please"] });
  const outcome = await addSafico(ctx);
  assert.equal(outcome.isError, false);
  assert.equal(ctx.lines[0].quantity, 2);
  assert.ok(ctx.seen.has("BTS-8026D"));
  // The proposal carries the catalogue's name, price and unit, and Claude's number both as typed and as sent.
  assert.deepEqual(check.calls.map((p) => [p.code, p.name, p.price, p.uom, p.action, p.quantity, p.requested, p.unit]), [["BTS-8026D", safico.name, 23.36, "PC", "add", 2, 2, "uom"]]);
});

test("a set on a line already on the enquiry makes one check", async () => {
  const { ctx, check } = checked({}, { customerTexts: ["make it 5"], lines: [saficoLine(2)] });
  assert.equal((await update(ctx, { action: "set", stock_id: "BTS-8026D", quantity: 5 })).isError, false);
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 5]]);
  assert.deepEqual(check.calls.map((p) => p.action), ["set"]);
});

test("a successful update is recorded in ctx.changes; a refused one is not", async () => {
  const { ctx } = checked((p) => (p.code === "970S" ? { verdict: "not_picked" } : {}), { customerTexts: ["2 please"] });
  assert.match((await update(ctx, { action: "add", stock_id: "970S", quantity: 2 })).content, /NOT_PICKED/);
  assert.deepEqual(ctx.changes, []);
  await update(ctx, { action: "add", stock_id: "bts-8026d", quantity: 2 });
  assert.deepEqual(ctx.changes, [{ action: "add", code: "BTS-8026D" }]); // the catalogue's spelling
});

test("a second add of the same item in one turn is refused, so the line is not doubled", async () => {
  const ctx = context(undefined, { customerTexts: ["4 can"], currentText: "4 can" });
  assert.equal((await addSafico(ctx, 4)).isError, false);
  const again = await update(ctx, { action: "add", stock_id: "bts-8026d", quantity: 4 });
  assert.equal(again.isError, true);
  assert.match(again.content, /ALREADY_ON_ENQUIRY/);
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 4]]);
  assert.deepEqual(ctx.changes, [{ action: "add", code: "BTS-8026D" }]);
});

test("the number the customer typed for this item wins: QTY_NOT_FOR_ITEM, then the retry is added with no second check", async () => {
  // r2 c11-persona idx 8 shape: two numbers typed, one per product.
  const { ctx, check } = checked((p) => ({ quantity: p.code === "BTS-8026D" ? 3 : 2 }), { customerTexts: ["3 of the safico and 2 of the blow torch"] });
  const refusal = bodyOf(await addSafico(ctx, 2));
  assert.equal(refusal.error, "QTY_NOT_FOR_ITEM");
  assert.equal(refusal.typed_quantity, 3);
  assert.match(refusal.note ?? "", /use that number/);
  assert.deepEqual(ctx.lines, []);
  assert.equal((await addSafico(ctx, 3)).isError, false);
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 3]]);
  assert.equal(check.calls.length, 1);
});

test("a typed number the check doesn't give this item is QTY_NOT_STATED, with the how-many notice", async () => {
  // r4 s05-A idx 1 "Yes per level 2 pans side by side": only the check's "no number" stopped a wrong 2.
  const { ctx } = checked({ quantity: null }, { customerTexts: ["yes per level 2 pans side by side"] });
  assert.deepEqual(bodyOf(await addSafico(ctx)), { error: "QTY_NOT_STATED", notice: QTY_NOTICE });
  assert.deepEqual(ctx.lines, []);
  assert.deepEqual(ctx.refused, []);
});

test("a pick the check isn't sure of is PICK_UNCONFIRMED: one question naming the product, with its live facts for the card", async () => {
  // exam 3, c08-persona T8: the refused product wasn't looked up, so the question about it lost its price and its card.
  const { ctx } = checked({ sure: false }, { customerTexts: ["2 torches"] });
  const outcome = await addSafico(ctx);
  const body = bodyOf(outcome) as { error: string; note: string; product: { stock_id: string; price_ex_gst: number | null } | null };
  assert.equal(outcome.isError, true);
  assert.deepEqual(Object.keys(body), ["error", "product", "note"]);
  assert.equal(body.error, "PICK_UNCONFIRMED");
  assert.deepEqual([body.product?.stock_id, body.product?.price_ex_gst], ["BTS-8026D", 23.36]);
  assert.match(body.note, /Is it the <name> <code>\?/);
  assert.match(body.note, /Don't call update_enquiry for it again this turn/);
  assert.equal(ctx.seen.get("BTS-8026D")?.verified, true);
  assert.deepEqual(ctx.refused, ["BTS-8026D"]);
  assert.deepEqual(ctx.lines, []);
});

test("a product the customer hasn't asked for is NOT_PICKED: answer what they said, no confirm question", async () => {
  const { ctx } = checked({ verdict: "not_picked" }, { customerTexts: ["ok 2"] });
  const body = bodyOf(await addSafico(ctx));
  assert.deepEqual(Object.keys(body), ["error", "note"]);
  assert.equal(body.error, "NOT_PICKED");
  assert.match(body.note ?? "", /Don't add it or ask them to confirm it; answer what they said/);
  assert.deepEqual(ctx.refused, ["BTS-8026D"]);
  assert.deepEqual([ctx.lines, ctx.changes], [[], []]);
});

test("a pick of another product is PICKED_OTHER with its typed number, and adding that one needs no second check", async () => {
  const { ctx, check } = checked({ verdict: "different", code: "970S", quantity: 2 }, { customerTexts: ["2 of the blow torch"] });
  const body = bodyOf(await addSafico(ctx)) as { error: string; picked: unknown; product: { stock_id: string } | null; note: string };
  assert.equal(body.error, "PICKED_OTHER");
  assert.deepEqual(body.picked, { code: "970S", quantity: 2 });
  assert.equal(body.product?.stock_id, "970S");
  assert.match(body.note, /add it with picked.quantity if that is set; otherwise ask how many/);
  assert.deepEqual(ctx.refused, ["BTS-8026D"]);
  assert.equal((await update(ctx, { action: "add", stock_id: "970S", quantity: 2 })).isError, false);
  assert.deepEqual(linesOf(ctx), [["970S", 2]]);
  assert.equal(check.calls.length, 1);
});

test("words that fit two products are PICK_UNCLEAR with both cards' facts, and both codes are refused", async () => {
  const { ctx } = checked({ verdict: "unclear", candidates: ["970S", "BTS-8026D"] }, { customerTexts: ["2 torches"] });
  const body = bodyOf(await addSafico(ctx)) as { error: string; candidates: Array<{ stock_id: string }>; note: string };
  assert.equal(body.error, "PICK_UNCLEAR");
  assert.deepEqual(body.candidates.map((item) => item.stock_id), ["970S", "BTS-8026D"]);
  assert.match(body.note, /attach these cards and ask which one, naming them \(X or Y\?\)/);
  assert.deepEqual([...ctx.refused].sort(), ["970S", "BTS-8026D"]);
  assert.deepEqual(ctx.lines, []);
});

test("a check that fails is PICK_UNCHECKED: the enquiry is unchanged and Claire asks about the product", async () => {
  const { ctx } = checked({ verdict: "error", sure: false, quantity: null }, { customerTexts: ["2 please"], lines: [saficoLine(1)] });
  const body = bodyOf(await update(ctx, { action: "add", stock_id: "970S", quantity: 2 })) as { error: string; product: { stock_id: string } | null };
  assert.equal(body.error, "PICK_UNCHECKED");
  assert.equal(body.product?.stock_id, "970S");
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 1]]);
  assert.deepEqual(ctx.changes, []);
});

test("a tap this turn is the pick: with one typed number it is added with no check; with two numbers the check binds the number", async () => {
  const one = checked({}, { tapped: "bts-8026d", customerTexts: ["2 please"] });
  assert.equal((await addSafico(one.ctx)).isError, false);
  assert.deepEqual([one.check.calls.length, one.ctx.pickFast], [0, 1]);
  const two = checked({}, { tapped: "BTS-8026D", customerTexts: ["3 of this and 5 of the blow torch"] });
  assert.equal((await addSafico(two.ctx, 3)).isError, false);
  assert.deepEqual([two.check.calls.length, two.ctx.pickFast], [1, 0]);
});

test("a tap with no typed number is QTY_NOT_STATED, with no check", async () => {
  const { ctx, check } = checked({}, { tapped: "BTS-8026D", customerTexts: ["blow torch"] });
  assert.match((await addSafico(ctx)).content, /QTY_NOT_STATED/);
  assert.equal(check.calls.length, 0);
});

test("'Recommend' with a number Claude made up is checked with no number and refused as NOT_PICKED, not QTY_NOT_STATED", async () => {
  // r2 c03-B idx 5: the old rule's refusal led to "How many?" on a recommendation request.
  const { ctx, check } = checked({ verdict: "not_picked" }, { customerTexts: ["Recommend"] });
  assert.equal(bodyOf(await addSafico(ctx, 3)).error, "NOT_PICKED");
  assert.deepEqual(check.calls.map((p) => [p.quantity, p.requested]), [[null, 3]]);
});

test("a product found this turn that fits the customer's words as well as another is PICK_UNCLEAR, not added", async () => {
  // "I need 2 blow torches" before any card was shown: the search finds several torches, and none of them was chosen.
  const { ctx } = checked({ verdict: "unclear", candidates: ["970S", "F46700"] }, { customerTexts: ["I need 2 blow torches"] });
  await runTool("search_catalogue", { queries: ["torch"] }, ctx);
  assert.equal(bodyOf(await update(ctx, { action: "add", stock_id: "970S", quantity: 2 })).error, "PICK_UNCLEAR");
  assert.deepEqual(ctx.lines, []);
});

test("clearing and a code the catalogue doesn't have make no check", async () => {
  const { ctx, check } = checked({}, { customerTexts: ["2 please"], clearTexts: ["clear all"], lines: [saficoLine(1)] });
  assert.match((await update(ctx, { action: "add", stock_id: "NOPE-1", quantity: 2 })).content, /NOT_FOUND/);
  assert.equal((await update(ctx, { action: "clear" })).isError, false);
  assert.equal(check.calls.length, 0);
});

test("a failed catalogue lookup still runs the check: a flaky lookup can't skip it", async () => {
  const deps = fakeDeps([blowtorch, mastrad, safico]);
  let failures = 1;
  const findByCode = deps.findByCode;
  deps.findByCode = (code) => (failures-- > 0 ? Promise.reject(new Error("DB_DOWN")) : findByCode(code));
  const { ctx, check } = checked({ verdict: "not_picked" }, { customerTexts: ["2 please"] }, deps);
  assert.equal(bodyOf(await addSafico(ctx)).error, "NOT_PICKED");
  assert.deepEqual(check.calls.map((p) => [p.code, p.name]), [["BTS-8026D", "BTS-8026D"]]);
});

test("a removal the customer asked for goes through after one check; a refused one keeps the line", async () => {
  const asked = checked({}, { customerTexts: ["remove the safico"], currentText: "remove the safico", lines: [saficoLine(2)] });
  assert.equal((await update(asked.ctx, { action: "remove", stock_id: "BTS-8026D" })).isError, false);
  assert.deepEqual(asked.ctx.lines, []);
  assert.deepEqual(asked.check.calls.map((p) => [p.code, p.name, p.action, p.quantity]), [["BTS-8026D", safico.name, "remove", null]]);
  // r4 c02-A idx 16: a price complaint is no removal.
  const text = "so expensive. got something cheaper?";
  const refused = checked({ verdict: "not_picked" }, { customerTexts: [text], currentText: text, lines: [saficoLine(2)] });
  const body = bodyOf(await update(refused.ctx, { action: "remove", stock_id: "BTS-8026D" }));
  assert.equal(body.error, "REMOVE_REFUSED");
  assert.match(body.note ?? "", /stays on the enquiry. Don't remove it; answer what they said, and don't tell them they never asked/);
  assert.deepEqual(linesOf(refused.ctx), [["BTS-8026D", 2]]);
  assert.deepEqual([refused.ctx.kept, refused.ctx.changes, refused.ctx.refused], [["BTS-8026D"], [], []]);
});

test("a removal the check says was meant for another line names that line", async () => {
  const { ctx } = checked({ verdict: "different", code: "970S" }, { customerTexts: ["remove the blow torch"], currentText: "remove the blow torch", lines: [saficoLine(2)] });
  const body = bodyOf(await update(ctx, { action: "remove", stock_id: "BTS-8026D" }));
  assert.deepEqual([body.error, body.meant], ["REMOVE_REFUSED", "970S"]);
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 2]]);
});

test("removing a line that could not be re-checked is recorded as a change", async () => {
  const ctx = context(undefined, { uncheckedCodes: ["F46700"] });
  await update(ctx, { action: "remove", stock_id: "F46700" });
  assert.deepEqual(ctx.changes, [{ action: "remove", code: "F46700" }]);
});

test("removing a line that could not be re-checked goes through the check too", async () => {
  const { ctx, check } = checked({ verdict: "not_picked" }, { uncheckedCodes: ["F46700"] });
  assert.equal(bodyOf(await update(ctx, { action: "remove", stock_id: "F46700" })).error, "REMOVE_REFUSED");
  assert.deepEqual([ctx.uncheckedCodes, ctx.changes, ctx.kept], [["F46700"], [], ["F46700"]]);
  assert.deepEqual(check.calls.map((p) => [p.code, p.action]), [["F46700", "remove"]]);
});

const tong16 = product({ stock_id: "UT16HR", name: "Utility Tong 16 inch", list_price: 3.5 });
const tong165 = product({ stock_id: "2564L", name: "Long Tong 16.5 inch", list_price: 4.2 });
const tongLine = { item: tong16.name, code: "UT16HR", pricePerItem: 3.5, quantity: 2, total: 7, uom: "PC" };

test("a swap's remove waits for the new item: SWAP_NOT_DONE before the add, allowed once the add went through", async () => {
  // r4 c09-persona idx 11: the old line came off while the new one was refused, so the customer lost both.
  const text = "change to the 16.5 one la, same 2 pcs";
  const { ctx, check } = checked({}, { customerTexts: [text], currentText: text, lines: [tongLine] }, fakeDeps([tong16, tong165]));
  const held = bodyOf(await update(ctx, { action: "remove", stock_id: "UT16HR" }));
  assert.equal(held.error, "SWAP_NOT_DONE");
  assert.match(held.note ?? "", /the old line comes off only once the new item is on the enquiry/);
  assert.deepEqual([linesOf(ctx), ctx.kept, check.calls.length], [[["UT16HR", 2]], ["UT16HR"], 0]);
  assert.equal((await update(ctx, { action: "add", stock_id: "2564L", quantity: 2 })).isError, false);
  assert.equal((await update(ctx, { action: "remove", stock_id: "UT16HR" })).isError, false);
  assert.deepEqual(linesOf(ctx), [["2564L", 2]]);
});

test("an explicit removal in a swap-worded message is not held", async () => {
  for (const text of ["just remove the safico instead", "cancel the safico, i buy torch elsewhere instead", "take out safico. 换别家买"]) {
    const { ctx } = checked({}, { customerTexts: [text], currentText: text, lines: [saficoLine(2)] });
    assert.equal((await update(ctx, { action: "remove", stock_id: "BTS-8026D" })).isError, false, text);
    assert.deepEqual(ctx.lines, [], text);
  }
});

test("after a refused removal, an add of that line is refused so it isn't merged (4 + 6 = 10)", async () => {
  const text = "hmm make the safico 6";
  const { ctx } = checked((p) => (p.action === "remove" ? { verdict: "not_picked" } : {}), { customerTexts: [text], currentText: text, lines: [saficoLine(4)] });
  assert.equal(bodyOf(await update(ctx, { action: "remove", stock_id: "BTS-8026D" })).error, "REMOVE_REFUSED");
  const again = bodyOf(await addSafico(ctx, 6));
  assert.equal(again.error, "ALREADY_ON_ENQUIRY");
  assert.match(again.notice ?? "", /use set with the new total/);
  assert.deepEqual(linesOf(ctx), [["BTS-8026D", 4]]);
});

test("a line that could not be re-checked can be removed or cleared, but not changed", async () => {
  const check = fakePickCheck();
  const ctx = context(undefined, { customerTexts: ["2 please"], clearTexts: ["clear it all"], uncheckedCodes: ["BTS-8026D", "F46700"], checkPick: pickCheckCache(check) });
  const changed = await update(ctx, { action: "add", stock_id: "bts-8026d", quantity: 2 });
  assert.match(changed.content, /STOCK_UNVERIFIED/);
  // The round's early start makes no check for a change that can't happen.
  await startPickCheck({ action: "set", stock_id: "BTS-8026D", quantity: 2 }, ctx);
  assert.equal(check.calls.length, 0);
  const removed = await update(ctx, { action: "remove", stock_id: "BTS-8026D" });
  assert.equal(removed.isError, false);
  assert.deepEqual(ctx.uncheckedCodes, ["F46700"]);
  const cleared = await update(ctx, { action: "clear" });
  assert.equal(cleared.isError, false);
  assert.deepEqual(ctx.uncheckedCodes, []);
});

test("while a line is unchecked, update_enquiry results tell Claude not to quote a total or item count", async () => {
  const ctx = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["F46700"] });
  const added = JSON.parse((await addSafico(ctx)).content) as { unchecked?: string };
  assert.match(added.unchecked ?? "", /Unchecked lines \(kept by the customer, not in these lines or totals\): F46700\./);
  assert.match(added.unchecked ?? "", /Don't quote an enquiry total or item count/);
  const removed = JSON.parse((await update(ctx, { action: "remove", stock_id: "F46700" })).content) as { unchecked?: string };
  assert.equal(removed.unchecked, undefined);
});

test("after a GST question, update_enquiry's totals and the product facts carry code's estimate with GST; otherwise neither does", async () => {
  // Owner decision 2: code works out the amount with GST, so Claude never does the sum.
  for (const gstAsked of [true, false]) {
    const { ctx } = checked({}, { customerTexts: ["2 please, total wif gst how much"], gstAsked });
    const totals = bodyOf(await addSafico(ctx)).totals as Record<string, unknown>;
    const fact = bodyOf(await runTool("get_product", { stock_id: "BTS-8026D" }, ctx)).product as Record<string, unknown>;
    const estimate = [totals.grandTotal, totals.grandTotalWithGst, totals.gstOnTotal, fact.price_with_gst];
    assert.deepEqual(estimate, gstAsked ? [46.72, 50.92, 4.2, 25.46] : [46.72, undefined, undefined, undefined], String(gstAsked));
  }
});

test("while a line is unchecked, update_enquiry's totals have no estimate with GST, but a product's price with GST stays", async () => {
  // The totals leave the unchecked line out, so a total with GST would be for part of the enquiry.
  const { ctx } = checked({}, { customerTexts: ["2 please, total wif gst how much"], gstAsked: true, uncheckedCodes: ["F46700"] });
  const totals = bodyOf(await addSafico(ctx)).totals as Record<string, unknown>;
  assert.deepEqual([totals.grandTotal, "grandTotalWithGst" in totals, "gstOnTotal" in totals], [46.72, false, false]);
  const fact = bodyOf(await runTool("get_product", { stock_id: "BTS-8026D" }, ctx)).product as Record<string, unknown>;
  assert.equal(fact.price_with_gst, 25.46);
});

test("a line that could not be re-checked is still on the enquiry, and the tool says so", async () => {
  // exam 3, c08-stress T12: a bare STOCK_UNVERIFIED on an unchecked line led to retries and a "removed" claim.
  const ctx = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["BTS-8026D"] });
  const changed = JSON.parse((await update(ctx, { action: "set", stock_id: "BTS-8026D", quantity: 2 })).content) as { error: string; note?: string };
  assert.equal(changed.error, "STOCK_UNVERIFIED");
  assert.match(changed.note ?? "", /still on the customer's enquiry.*don't change it this turn/);
  const other = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["F46700"] });
  const added = JSON.parse((await addSafico(other)).content) as { unchecked?: string };
  assert.match(added.unchecked ?? "", /They are still on the customer's enquiry: never say they were removed or are missing\./);
});

test("a refused add whose lookup fails or stalls returns product null within about 2 s", async () => {
  const unsure = () => pickCheckCache(fakePickCheck({ sure: false }));
  const failing = fakeDeps([blowtorch, mastrad, safico]);
  failing.findByCode = async () => { throw new Error("DB_DOWN"); };
  const refusedCtx = context(failing, { customerTexts: ["2 torches"], checkPick: unsure() });
  const failed = bodyOf(await addSafico(refusedCtx)) as { error: string; product: unknown };
  assert.equal(failed.error, "PICK_UNCONFIRMED");
  assert.equal(failed.product, null);
  assert.deepEqual(refusedCtx.refused, ["BTS-8026D"]);
  const stalled = fakeDeps([blowtorch, mastrad, safico]);
  const fetchLive = stalled.fetchLive;
  stalled.fetchLive = (url, ms) => (url === safico.source_url ? new Promise(() => undefined) : fetchLive(url, ms));
  const started = performance.now();
  const slow = bodyOf(await addSafico(context(stalled, { customerTexts: ["2 torches"], checkPick: unsure() }))) as { error: string; product: unknown };
  assert.ok(performance.now() - started < 2_300, `${performance.now() - started} ms`);
  assert.equal(slow.error, "PICK_UNCONFIRMED");
  assert.equal(slow.product, null);
  // The live check gets only what is left of the 2 s, so it can't run on after the tool has answered.
  const lateFind = fakeDeps([blowtorch, mastrad, safico]);
  const findByCode = lateFind.findByCode;
  lateFind.findByCode = async (code) => { await new Promise((resolve) => setTimeout(resolve, 300)); return findByCode(code); };
  const given: number[] = [];
  const liveAfterFind = lateFind.fetchLive;
  lateFind.fetchLive = (url, ms) => { given.push(ms ?? Infinity); return liveAfterFind(url, ms); };
  await addSafico(context(lateFind, { customerTexts: ["2 torches"], checkPick: unsure() }));
  assert.ok(given.length === 1 && given[0] <= 1_700, `${given}`);
});

test("match_photo records which products the photo matched, exactly or as look-alikes, for the pick check", async () => {
  const image = { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" } as TurnContext["image"];
  const lookup = (kind: "direct" | "candidates") => ({ kind, matches: [], products: [blowtorch, safico], totalProducts: 2 });
  const direct = context(fakeDeps([blowtorch, safico], {}, lookup("direct")), { image });
  await runTool("match_photo", {}, direct);
  assert.deepEqual([...direct.photoMatches], [["970S", "direct"], ["BTS-8026D", "direct"]]);
  const alike = context(fakeDeps([blowtorch, safico], {}, lookup("candidates")), { image });
  await runTool("match_photo", {}, alike);
  assert.deepEqual([...alike.photoMatches], [["970S", "look-alike"], ["BTS-8026D", "look-alike"]]);
});

test("the update_enquiry description says a separate check confirms the pick and a swap is an add plus a remove", () => {
  const description = agentTools.find((tool) => tool.name === "update_enquiry")?.description ?? "";
  assert.ok(description.endsWith("stock_id must be a product the customer picked. A separate check reads the chat to confirm the pick (or that they asked to remove the line) and the number they typed for this item. For a swap, send the add of the new item and the remove of the old one in the same response."));
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
