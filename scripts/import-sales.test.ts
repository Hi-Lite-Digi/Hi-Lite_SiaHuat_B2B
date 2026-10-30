import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import test from "node:test";
import { applyPlan, cleanSalesName, rankSales, salesRows, type CatalogueRow, type SalesRow } from "./import-sales";

// Run explicitly (npm test only globs src/): node --conditions=react-server --import tsx --test scripts/import-sales.test.ts
// Made-up codes and quantities only: the client's sales file never comes near the repo.

test("the sales sheet is read by its header names and only three columns are kept", () => {
  const header = ["Brand Id", " Stk Id ", "Stock trade price", "ABC Type", "STKMAS Name", "Stock list price", "YTD Sale Qty"];
  const rows = salesRows(header, [
    ["ZZ", "999ZZ-A1", 1.5, "A", "NAME A1", 2.5, 10],
    ["ZZ", "  ", 1, "B", "BLANK CODE", 2, 3],
    ["ZZ", "999ZZ-A2", 1, "C", "NAME A2", 2, "-4"],
  ]);
  assert.deepEqual(rows, [{ stockId: "999ZZ-A1", salesName: "NAME A1", qty: 10 }, { stockId: "999ZZ-A2", salesName: "NAME A2", qty: -4 }]);
  assert.ok(rows.every((row) => Object.keys(row).sort().join() === "qty,salesName,stockId"));
  assert.throws(() => salesRows(header.slice(0, -1), []), /MISSING_COLUMN/);
  assert.throws(() => salesRows(header, [["ZZ", "999ZZ-A1", 1, "A", "X", 2, 1], ["ZZ", "999ZZ-A1", 1, "A", "Y", 2, 1]]),
    (error: Error) => /DUPLICATE_STOCK_ID/.test(error.message) && !error.message.includes("999ZZ-A1"));
  assert.throws(() => salesRows(header, [["ZZ", "999ZZ-A1", 1, "A", "X", 2, 1], ["ZZ", "999ZZ-A2", 1, "A", "Y", 2, "lots"]]),
    (error: Error) => /BAD_QTY: row 3/.test(error.message) && !error.message.includes("lots"));
});

test("a sales name keeps what helps a search", () => {
  assert.equal(cleanSalesName("(TP) WHITE WINE GLASS Ø8xH20cm, 400ml"), "WHITE WINE GLASS Ø8xH20cm, 400ml");
  assert.equal(cleanSalesName("-TD- SMART STICK HAND BLENDER"), "SMART STICK HAND BLENDER");
  assert.equal(cleanSalesName("-MTO- (alt code G2667) GLASS JUG"), "(alt code G2667) GLASS JUG");
  assert.equal(cleanSalesName("  "), null);
});

const row = (stock_id: string, third_category: string | null, subcategory: string, status = "Active"): CatalogueRow => ({
  stock_id, source_stock_id: `999ZZ-${stock_id}`, status, category: "Stuff", subcategory, third_category,
});
const sale = (stock_id: string, qty: number): SalesRow => ({ stockId: `999ZZ-${stock_id}`, salesName: `(TP) NAME ${stock_id}`, qty });
const catalogue = [
  ...["W1", "W2", "W3", "W4", "W5", "W6", "W0", "WX"].map((code) => row(code, "Widgets", "Things")),
  row("T1", "Tinies", "Things"), row("T2", "Tinies", "Things"),
  // "Stuff", the top-level category, has 5+ sellers, but it holds every kind of product: never a group (A2).
  row("L1", "Lonely", "Odds"), row("L2", " Lonely ", "Odds"),
  row("D1", "Widgets", "Things", "Discontinued"),
];
const sales = [
  sale("W1", 7777), sale("W2", 6666), sale("W3", 6666), sale("W4", 500), sale("W5", 40), sale("W6", 3), sale("W0", 0),
  sale("T1", 600), sale("T2", 2), sale("L1", 900), sale("L2", 8), sale("D1", 8888), sale("GONE", 5),
];
const plan = rankSales(catalogue, sales);
const rank = (code: string) => {
  const { stock_id, ...rest } = plan.ranks.find((item) => item.stock_id === code)!;
  assert.equal(stock_id, code);
  return rest;
};

test("products are ranked within their type, by percentile in tenths, with the top few flagged", () => {
  assert.deepEqual(plan.ranks.map((item) => item.stock_id), catalogue.map((item) => item.stock_id));
  assert.deepEqual(["W1", "W2", "W3", "W4", "W5", "W6"].map((code) => [rank(code).popularity, rank(code).best_seller]),
    [[100, true], [90, true], [90, true], [50, false], [40, false], [20, false]]);
  assert.deepEqual(rank("W1").sales_name, "NAME W1");
  assert.deepEqual(rank("W0"), { popularity: 0, best_seller: false, sales_name: "NAME W0" });
  assert.deepEqual(rank("WX"), { popularity: null, best_seller: false, sales_name: null });
  // Two sellers are too few for a type: the Tinies are ranked among all 8 sellers of their subcategory.
  assert.deepEqual([rank("T1"), rank("T2")].map((item) => [item.popularity, item.best_seller]), [[70, false], [20, false]]);
  assert.deepEqual(rank("L1"), { popularity: null, best_seller: false, sales_name: "NAME L1" });
  assert.deepEqual(rank("L2"), { popularity: null, best_seller: false, sales_name: "NAME L2" });
  assert.deepEqual(rank("D1"), { popularity: null, best_seller: false, sales_name: null });
  assert.deepEqual(plan.counts, {
    catalogueRows: 13, ranked: 12, matched: 11, sellers: 10, zeroSales: 1, unmatched: 1,
    byLevel: { third_category: 6, subcategory: 2, none: 2 }, bestSellers: 3, salesRowsNotInCatalogue: 2,
  });
});

test("the plan carries no quantity", () => {
  const text = JSON.stringify(plan);
  for (const banned of ["7777", "6666", "8888", "qty", "trade"]) assert.ok(!text.includes(banned), banned);
});

// A stand-in for pg's client: it records each statement's first words and answers the update with the row count given.
const fakeClient = (updated: number) => {
  const statements: string[] = [];
  const values: unknown[][] = [];
  return {
    statements,
    values,
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase());
      if (params) values.push(params);
      return { rows: [], rowCount: /^update/i.test(sql.trim()) ? updated : null };
    },
  };
};

test("apply writes one reviewed plan in one transaction after a backup", async () => {
  const client = fakeClient(plan.ranks.length);
  await applyPlan(plan, client, "20261030");
  assert.deepEqual(client.statements, ["begin", "create schema if", "create table backup.products_sales_20261030", "update public.products p", "commit"]);
  assert.deepEqual(JSON.parse(String(client.values[0][0])), plan.ranks);

  const short = fakeClient(plan.ranks.length - 1);
  await assert.rejects(applyPlan(plan, short, "20261030"), /ROW_COUNT/);
  assert.deepEqual(short.statements.slice(-2), ["update public.products p", "rollback"]);

  const badDay = fakeClient(plan.ranks.length);
  await assert.rejects(applyPlan(plan, badDay, "2026-10-30"), /BAD_BACKUP_DAY/);
  assert.deepEqual(badDay.statements, []);

  const leaky = fakeClient(plan.ranks.length);
  await assert.rejects(applyPlan({ ...plan, ranks: [{ ...plan.ranks[0], qty: 5 } as never, ...plan.ranks.slice(1)] }, leaky, "20261030"), /BAD_PLAN/);
  assert.deepEqual(leaky.statements, []);
});

test("importing the module doesn't start a run", async () => {
  await import("./import-sales");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const files = await readdir("tmp/sales-import").catch(() => [] as string[]);
  const fresh = [];
  for (const file of files) if ((await stat(`tmp/sales-import/${file}`)).mtimeMs >= performance.timeOrigin) fresh.push(file);
  assert.deepEqual(fresh, []);
});
