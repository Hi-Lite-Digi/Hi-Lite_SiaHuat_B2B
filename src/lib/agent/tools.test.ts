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
  return { deps, seen: new Map<string, CheckedProduct>(), lines: [], uncheckedCodes: [], customerTexts: [], clearTexts: [], image: null, shownIds: new Set(), ...overrides };
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

test("search outage is reported as a tool error", async () => {
  const deps = fakeDeps([blowtorch]);
  deps.searchDirect = async () => { throw new Error("down"); };
  const outcome = await runTool("search_catalogue", { queries: ["torch"] }, context(deps));
  assert.equal(outcome.isError, true);
  assert.match(outcome.content, /SEARCH_UNAVAILABLE/);
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
  const ctx = context(undefined, { customerTexts: ["2 please"] });
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
  const ctx = context(undefined, { customerTexts: ["2 please"], uncheckedCodes: ["F46700"] });
  const added = JSON.parse((await runTool("update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ctx)).content) as { unchecked?: string };
  assert.match(added.unchecked ?? "", /Unchecked lines \(kept by the customer, not in these lines or totals\): F46700\./);
  assert.match(added.unchecked ?? "", /Don't quote an enquiry total or item count/);
  const removed = JSON.parse((await runTool("update_enquiry", { action: "remove", stock_id: "F46700" }, ctx)).content) as { unchecked?: string };
  assert.equal(removed.unchecked, undefined);
});

test("clearing checks the texts that may ask for it, which include a tapped chip", async () => {
  const refused = await runTool("update_enquiry", { action: "clear" }, context(undefined, { customerTexts: ["blow torch"], clearTexts: ["blow torch"] }));
  assert.match(refused.content, /CLEAR_NOT_REQUESTED/);
  const cleared = await runTool("update_enquiry", { action: "clear" }, context(undefined, { customerTexts: ["blow torch"], clearTexts: ["Start over", "blow torch"] }));
  assert.equal(cleared.isError, false);
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
