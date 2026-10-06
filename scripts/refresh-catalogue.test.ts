import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import type { ScrapedSiaHuatProduct } from "../src/lib/siahuat-product";
import { applyPlan, classify, dryRun, type CatalogueRow, type PageRead } from "./refresh-catalogue";

// Run explicitly (npm test only globs src/): node --conditions=react-server --import tsx --test scripts/refresh-catalogue.test.ts

const product = (stock_id: string, page: string, price: number, quantity = 5): ScrapedSiaHuatProduct => ({
  stock_id, source_stock_id: `105SF-${stock_id}`, source_product_id: page, name: `Product ${stock_id}`,
  source_url: `https://store.siahuat.com/product/${page}`, image_url: null, description: null, size: null, dimensions: null,
  brand: "SAFICO PRO", model: null, price_ex_gst: price, in_stock: quantity > 0, available_quantity: quantity,
  stock_status: quantity > 0 ? "in_stock" : "out_of_stock", category: null, subcategory: null, third_category: null,
  uom_id: "PC", attributes: {}, last_scraped_at: "2026-10-06T00:00:00.000Z",
});
const row = (stock_id: string, page: string, status = "Active", list_price = 10): CatalogueRow => ({
  stock_id, source_product_id: page, source_url: `https://store.siahuat.com/product/${page}`, status, list_price,
});
const live = (item: ScrapedSiaHuatProduct): PageRead[] => [{ product: item }];
const goneTwice: PageRead[] = [{ gone: true }, { gone: true }];

// One small store and catalogue with every case the refresh sorts (r8): the page ids are what the store's sitemap lists.
const sitemap = ["200", "201", "202", "203", "204", "300"];
const rows = [
  row("04-00820", "100"), // the chiller: its page is gone; the grinder's new page 202 shows the code
  row("05982-SS", "101", "Active", 993.08), // alive off the sitemap; a new $0 page 203 shows the same code
  row("08-00836", "102"), // gone, no new page
  row("TB40", "103"), // alive off the sitemap
  row("OLD-1", "104", "Discontinued"), // gone, already retired
  row("1550a", "105"), // gone; 1550A is another row, on a live page
  row("1550A", "300"),
];
const reads = new Map<string, PageRead[]>([
  ["200", live(product("NEW-1", "200", 12.5))],
  ["201", live(product("TCW1030", "201", 0, 479))],
  ["202", live(product("04-00820", "202", 440.37, 9))],
  ["203", live(product("05982-SS", "203", 0, 0))],
  ["204", live(product("1550A", "204", 30))],
  ["100", goneTwice],
  ["101", live(product("05982-SS", "101", 993.08, 2))],
  ["102", goneTwice],
  ["103", live(product("TB40", "103", 4, 0))],
  ["104", goneTwice],
  ["105", goneTwice],
]);
const plan = classify(sitemap, rows, reads);
const codes = (list: Array<{ stock_id: string | null }>) => list.map((item) => item.stock_id);

test("a new code on one live page at a price is inserted; a new code at $0 is left out and listed", () => {
  assert.deepEqual(codes(plan.insert), ["NEW-1"]);
  assert.deepEqual(plan.skipZeroPrice.map((item) => [item.stock_id, item.page, item.available_quantity]), [["TCW1030", "201", 479]]);
});

test("a code whose page is gone moves to the one live page that shows it, as the product that page shows", () => {
  assert.deepEqual(plan.updateMovedFromDead.map((item) => [item.fromPage, item.product.stock_id, item.product.source_product_id, item.product.price_ex_gst]),
    [["100", "04-00820", "202", 440.37]]);
});

test("a row whose own page is alive never moves, even when a new page shows its code at $0", () => {
  assert.deepEqual(plan.skipDuplicateCode.map((item) => [item.stock_id, item.page]), [["05982-SS", "203"], ["1550A", "204"]]);
  assert.ok(plan.keepAlive.some((item) => item.stock_id === "05982-SS" && item.page === "101"));
});

test("a gone page with no live page for its code is retired; one already Discontinued is left alone", () => {
  assert.deepEqual(plan.deactivate, [{ stock_id: "08-00836", page: "102" }, { stock_id: "1550a", page: "105" }]);
});

test("pages alive but off the sitemap stay as they are", () => {
  assert.deepEqual(plan.keepAlive.map((item) => [item.stock_id, item.page]), [["05982-SS", "101"], ["TB40", "103"]]);
});

test("codes compare exactly: 1550a is not moved to 1550A's page, and 1550A is not touched", () => {
  assert.ok(!plan.updateMovedFromDead.some((item) => item.product.stock_id.toLowerCase() === "1550a"));
  assert.ok(!plan.deactivate.some((item) => item.stock_id === "1550A"));
  assert.deepEqual(plan.unresolved, []);
  assert.deepEqual(plan.counts, { insert: 1, updateMovedFromDead: 1, deactivate: 2, skipDuplicateCode: 2, skipZeroPrice: 1, keepAlive: 2, unresolved: 0 });
});

test("a page is retired only when both reads showed it gone; a slow or failed read changes nothing", () => {
  const once = classify([], [row("A1", "1"), row("A2", "2"), row("A3", "3")], new Map<string, PageRead[]>([
    ["1", [{ gone: true }]],
    ["2", [{ gone: true }, { error: "TimeoutError" }]],
    ["3", [{ error: "SIA_HUAT_HTTP_503" }, { error: "SIA_HUAT_HTTP_503" }]],
  ]));
  assert.deepEqual(once.deactivate, []);
  assert.deepEqual(codes(once.unresolved), ["A1", "A2", "A3"]);
});

test("a retired row whose page is alive again is listed for review, on or off the sitemap, never as kept Active", () => {
  const back = classify(["500"], [row("X1", "500", "Discontinued"), row("X2", "501", "Discontinued"), row("X3", "502", "Discontinued")], new Map([
    ["500", live(product("X1", "500", 12))], ["501", live(product("X2", "501", 12))], ["502", goneTwice],
  ]));
  assert.deepEqual(back.keepAlive, []);
  assert.deepEqual(back.deactivate, []);
  assert.deepEqual(back.unresolved.map((item) => [item.stock_id, item.page, item.why]),
    [["X1", "500", "Discontinued, but its page is alive again"], ["X2", "501", "Discontinued, but its page is alive again"]]);
});

test("a new code on two new pages, or one held by a live page, is never inserted", () => {
  const twice = classify(["7", "8"], [], new Map([["7", live(product("1520", "7", 3))], ["8", live(product("1520", "8", 4))]]));
  assert.deepEqual(twice.insert, []);
  assert.deepEqual(twice.skipDuplicateCode.map((item) => item.page), ["7", "8"]);
});

// The store as fetch sees it: the sitemap, the catalogue through REST, and product pages the real parser reads.
const flightPush = (payload: string) => `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
const productPage = (code: string, price: number) => `<html><head><title>Item | Sia Huat E-store</title></head><body>
<div class="MuiGrid-container"><div><h5>Item ${code}</h5><span>code: ${code}</span></div></div>
${flightPush(JSON.stringify({ stkId: `105SF-${code}`, b2bPrice: price, availableQty: 4, uomId: "PC" }))}</body></html>`;
const gonePage = `<html><head><title>Product - 1 | Sia Huat E-store</title></head><body>${flightPush('5:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n')}</body></html>`;
const store: Record<string, string> = {
  "200": productPage("NEW-1", 12.5), "201": productPage("TCW1030", 0), "202": productPage("04-00820", 440.37),
  "204": productPage("NEW-2", 7), "100": gonePage, "102": gonePage, "103": productPage("TB40", 4), "104": productPage("TB41", 2),
};
const storeRows = [row("04-00820", "100"), row("08-00836", "102"), row("J2603", "300"), row("TB40", "103"), row("TB41", "104")];

test("the dry run only reads: no database connection, GET requests only, and the same plan file twice", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => { throw new Error("the dry run must not open a database connection"); });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-06T00:00:00Z") });
  const requests: string[] = [];
  let calls = 0;
  let runs = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    requests.push(`${init?.method ?? "GET"} ${url.host}`);
    // Pages finish out of order, as they do at four at a time, and the second run gets the sitemap and rows in reverse.
    await new Promise((resolve) => setTimeout(resolve, (calls++ * 7) % 5));
    const inRunOrder = <T>(list: T[]) => (runs > 1 ? [...list].reverse() : list);
    if (url.pathname === "/sitemap.xml") {
      runs += 1;
      return new Response(inRunOrder(["200", "201", "202", "204", "300"]).map((id) => `<loc>https://store.siahuat.com/product/${id}</loc>`).join(""));
    }
    if (url.pathname === "/rest/v1/products") return Response.json(inRunOrder(storeRows));
    return new Response(store[url.pathname.split("/").at(-1) ?? ""] ?? gonePage);
  });
  const options = { supabaseUrl: "https://catalogue.example", publishableKey: "publishable", pauseMs: 0, log: () => {} };
  const first = await dryRun(options);
  const second = await dryRun(options);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(connect.mock.callCount(), 0);
  assert.deepEqual([...new Set(requests)].sort(), ["GET catalogue.example", "GET store.siahuat.com"]);
  assert.deepEqual(first.counts, { insert: 2, updateMovedFromDead: 1, deactivate: 1, skipDuplicateCode: 0, skipZeroPrice: 1, keepAlive: 2, unresolved: 0 });
  assert.equal(first.updateMovedFromDead[0].product.price_ex_gst, 440.37);
});

test("the dry run reads the page of a retired row that is back on the sitemap", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === "/sitemap.xml") return new Response("<loc>https://store.siahuat.com/product/500</loc>");
    if (url.pathname === "/rest/v1/products") return Response.json([row("X1", "500", "Discontinued")]);
    return new Response(url.pathname.endsWith("/500") ? productPage("X1", 12) : gonePage);
  });
  const back = await dryRun({ supabaseUrl: "https://catalogue.example", publishableKey: "publishable", pauseMs: 0, log: () => {} });
  assert.deepEqual(back.unresolved, [{ stock_id: "X1", page: "500", why: "Discontinued, but its page is alive again" }]);
});

// A stand-in for pg's client: it records each statement and answers with the row counts given.
const fakeClient = (counts: { held?: Array<{ stock_id: string; source_product_id: string }>; upserted?: number; retired?: number }) => {
  const statements: string[] = [];
  return {
    statements,
    query: async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase());
      if (/^select/i.test(sql.trim())) return { rows: counts.held ?? [], rowCount: counts.held?.length ?? 0 };
      if (/^insert/i.test(sql.trim())) return { rows: [], rowCount: counts.upserted ?? 0 };
      if (/^update/i.test(sql.trim())) return { rows: [], rowCount: counts.retired ?? 0 };
      return { rows: [], rowCount: null };
    },
  };
};

test("apply backs up outside public, writes the reviewed plan in one transaction and never deletes", async () => {
  const client = fakeClient({ held: [{ stock_id: "04-00820", source_product_id: "100" }], upserted: 2, retired: 2 });
  await applyPlan(plan, client, "20261006");
  assert.deepEqual(client.statements, [
    "begin", "create schema if", "create table backup.products_20261006",
    "select stock_id, source_product_id", "insert into public.products", "update public.products set", "commit",
  ]);
});

test("apply rolls back when a row count differs from the plan, or the plan no longer matches the catalogue", async () => {
  const short = fakeClient({ held: [{ stock_id: "04-00820", source_product_id: "100" }], upserted: 2, retired: 1 });
  await assert.rejects(applyPlan(plan, short, "20261006"), /ROW_COUNT/);
  assert.deepEqual(short.statements.slice(-2), ["update public.products set", "rollback"]);
  // NEW-1 is in the catalogue now: an upsert would swap the product its code points at.
  const stale = fakeClient({ held: [{ stock_id: "04-00820", source_product_id: "100" }, { stock_id: "NEW-1", source_product_id: "9" }] });
  await assert.rejects(applyPlan(plan, stale, "20261006"), /STALE_PLAN/);
  assert.ok(!stale.statements.some((statement) => statement.startsWith("insert")));
  assert.equal(stale.statements.at(-1), "rollback");
});
