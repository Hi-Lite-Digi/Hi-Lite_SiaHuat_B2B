import dotenv from "dotenv";
import ExcelJS from "exceljs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { getDatabaseUrl } from "./database-url";

// Ranks products by the client's year-to-date sales and keeps only coarse ranks (r10). The sales file is the client's confidential
// data: it is read from the path given here, never copied into the repo, and no quantity, price or ABC class leaves this process.
//   pnpm sales:import "<path to the .xlsx>"              dry run: reads only, writes tmp/sales-import/plan-<date>.json
//   pnpm sales:import --apply --plan <reviewed file>     writes that plan to the database (only after the owner's yes)
// Re-run with each new export: every catalogue row is rewritten, so products that dropped out lose their rank.

const outputDirectory = "tmp/sales-import";
const MIN_GROUP = 5;
// The leaf, else the subcategory; never the top-level category, which mixes GN pans with blenders.
const LEVELS = ["third_category", "subcategory"] as const;
type Level = (typeof LEVELS)[number];

export type SalesRow = { stockId: string; salesName: string; qty: number };
export type CatalogueRow = {
  stock_id: string; source_stock_id: string | null; status: string; category: string | null; subcategory: string | null; third_category: string | null;
};
export type SalesRank = { stock_id: string; popularity: number | null; best_seller: boolean; sales_name: string | null };
export type SalesPlan = {
  counts: Record<"catalogueRows" | "ranked" | "matched" | "sellers" | "zeroSales" | "unmatched" | "bestSellers" | "salesRowsNotInCatalogue", number>
    & { byLevel: Record<Level | "none", number> };
  ranks: SalesRank[];
};

/** Keeps the three columns the ranks need, found by header text. Errors name the sheet row, never a cell: the file is the client's. */
export function salesRows(header: unknown[], rows: unknown[][]): SalesRow[] {
  const titles = header.map((title) => String(title ?? "").trim());
  const [idAt, nameAt, qtyAt] = ["Stk Id", "STKMAS Name", "YTD Sale Qty"].map((title) => {
    const at = titles.indexOf(title);
    if (at < 0) throw new Error(`MISSING_COLUMN: ${title}`);
    return at;
  });
  const seen = new Set<string>();
  return rows.flatMap((row, index) => {
    const stockId = String(row[idAt] ?? "").trim();
    if (!stockId) return [];
    const sheetRow = index + 2;
    if (seen.has(stockId)) throw new Error(`DUPLICATE_STOCK_ID: row ${sheetRow}`);
    seen.add(stockId);
    const value = row[qtyAt];
    const qty = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(qty)) throw new Error(`BAD_QTY: row ${sheetRow}`);
    return [{ stockId, salesName: String(row[nameAt] ?? ""), qty }];
  });
}

/** Drops the sales system's internal markers ("(TP)", "-TD-"; meaning unknown) and odd spaces; keeps "(alt code …)", an old code. */
export const cleanSalesName = (name: string) => name.replace(/\((?:TP|TT)\)|-(?:TD|TS|MTO)-/gi, " ").replace(/\s+/g, " ").trim() || null;

const rankable = (row: CatalogueRow) => row.status === "Active" || row.status === "New";

/** Matches Active/New rows to the sales by exact code, and puts each seller (qty > 0) in the first of its leaf and subcategory with
 *  at least 5 sellers. A name is one group wherever it occurs ("Casseroles" sits under both Asian and Western cookware). */
function groupSales(catalogue: CatalogueRow[], sales: SalesRow[]) {
  const byCode = new Map(sales.map((row) => [row.stockId, row]));
  const matched = new Map(catalogue.flatMap((row) => {
    const sale = rankable(row) && row.source_stock_id ? byCode.get(row.source_stock_id) : undefined;
    return sale ? [[row.stock_id, sale] as const] : [];
  }));
  const sellers = catalogue.filter((row) => (matched.get(row.stock_id)?.qty ?? 0) > 0);
  const keyOf = (row: CatalogueRow, level: Level) => (row[level]?.trim() ? `${level}: ${row[level]!.trim()}` : "");
  // Each group's sellers' quantities, per level and name.
  const members = new Map<string, number[]>();
  for (const row of sellers) {
    for (const level of LEVELS) {
      const key = keyOf(row, level);
      if (!key) continue;
      const list = members.get(key) ?? [];
      list.push(matched.get(row.stock_id)!.qty);
      members.set(key, list);
    }
  }
  const groupOf = new Map(sellers.map((row) => {
    const level = LEVELS.find((at) => (members.get(keyOf(row, at))?.length ?? 0) >= MIN_GROUP);
    return [row.stock_id, level ? { level, key: keyOf(row, level) } : null] as const;
  }));
  return { matched, members, groupOf };
}

/** One rank for every catalogue row, so a re-run also resets the rows that left the sales file. */
export function rankSales(catalogue: CatalogueRow[], sales: SalesRow[]): SalesPlan {
  const { matched, members, groupOf } = groupSales(catalogue, sales);
  const byLevel = { third_category: 0, subcategory: 0, none: 0 };
  const ranks = catalogue.map((row): SalesRank => {
    const sale = matched.get(row.stock_id);
    const unranked = { stock_id: row.stock_id, popularity: null, best_seller: false, sales_name: sale ? cleanSalesName(sale.salesName) : null };
    if (!sale) return unranked;
    if (sale.qty <= 0) return { ...unranked, popularity: 0 };
    const group = groupOf.get(row.stock_id);
    byLevel[group?.level ?? "none"] += 1;
    // Too few sellers in its leaf and subcategory to rank: it keeps its sales name for the search.
    if (!group) return unranked;
    const quantities = members.get(group.key)!;
    const atOrBelow = quantities.filter((qty) => qty <= sale.qty).length;
    return {
      ...unranked,
      // The share of the group's sellers selling as many or fewer, in tenths: coarse, as the publishable key can read it.
      popularity: Math.ceil((10 * atOrBelow) / quantities.length) * 10,
      // The top few of the type; ties at the cut are all flagged.
      best_seller: quantities.length - atOrBelow < Math.min(3, Math.ceil(quantities.length / 5)),
    };
  });
  const ranked = catalogue.filter(rankable);
  const liveCodes = new Set(ranked.map((row) => row.source_stock_id));
  const sellers = byLevel.third_category + byLevel.subcategory + byLevel.none;
  return {
    counts: {
      catalogueRows: catalogue.length,
      ranked: ranked.length,
      matched: matched.size,
      sellers,
      zeroSales: matched.size - sellers,
      unmatched: ranked.length - matched.size,
      byLevel,
      bestSellers: ranks.filter((rank) => rank.best_seller).length,
      salesRowsNotInCatalogue: sales.filter((row) => !liveCodes.has(row.stockId)).length,
    },
    ranks,
  };
}

const planSchema = z.object({
  ranks: z.array(z.object({
    stock_id: z.string().min(1),
    popularity: z.number().int().min(0).max(100).nullable(),
    best_seller: z.boolean(),
    sales_name: z.string().nullable(),
  }).strict()).min(1),
});

/** Writes a reviewed plan in one transaction, after a backup outside the public schema. Never deletes or inserts. */
export async function applyPlan(plan: SalesPlan, client: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null }> }, day: string) {
  // The plan file is hand-reviewed and could be edited: anything beyond the four fields (a quantity) stops here.
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) throw new Error(`BAD_PLAN: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`);
  if (!/^\d{8}$/.test(day)) throw new Error(`BAD_BACKUP_DAY: ${day}`);
  const { ranks } = parsed.data;
  await client.query("begin");
  try {
    // Not in public: a copy there would be readable through REST with the publishable key.
    await client.query("create schema if not exists backup");
    await client.query(`create table backup.products_sales_${day} as select stock_id, popularity, best_seller, sales_name from public.products`);
    // updated_at stays as it is: these aren't store changes.
    const updated = await client.query(
      `update public.products p set popularity = x.popularity, best_seller = x.best_seller, sales_name = x.sales_name
      from jsonb_to_recordset($1::jsonb) as x(stock_id text, popularity smallint, best_seller boolean, sales_name text)
      where p.stock_id = x.stock_id`,
      [JSON.stringify(ranks)],
    );
    if (updated.rowCount !== ranks.length) throw new Error(`ROW_COUNT: ${updated.rowCount} rows updated, plan says ${ranks.length}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** A formula cell gives its result, rich text its text, a link its label. */
const cellValue = (value: ExcelJS.CellValue): unknown => {
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if ("result" in value) return value.result;
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  return "text" in value ? value.text : value;
};

async function readSalesFile(path: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.getWorksheet("Sales Analysis");
  if (!sheet) throw new Error("MISSING_SHEET: Sales Analysis");
  const lines: unknown[][] = [];
  // Empty rows too, so a row's place is its sheet row, which the errors name.
  sheet.eachRow({ includeEmpty: true }, (row) => lines.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellValue)));
  const [header = [], ...rows] = lines;
  return salesRows(header, rows);
}

async function readCatalogue(supabaseUrl: string, publishableKey: string) {
  const rows: CatalogueRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${supabaseUrl}/rest/v1/products?select=stock_id,source_stock_id,status,category,subcategory,third_category&order=stock_id&limit=1000&offset=${offset}`, {
      headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}` },
    });
    if (!response.ok) throw new Error(`SUPABASE_${response.status}`);
    const page = await response.json() as CatalogueRow[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
  const day = new Date().toISOString().slice(0, 10);
  if (process.argv.includes("--apply")) {
    const at = process.argv.indexOf("--plan");
    const file = at > 0 ? process.argv[at + 1] : undefined;
    if (!file) throw new Error("--apply needs --plan <file>: it applies a reviewed dry-run plan, never a fresh one");
    const plan = JSON.parse(await readFile(file, "utf8")) as SalesPlan;
    const client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
    try {
      await applyPlan(plan, client, day.replace(/-/g, ""));
    } finally {
      await client.end();
    }
    console.log(`Applied ${file}: ${JSON.stringify(plan.counts)}.`);
    return;
  }
  const path = process.argv[2];
  if (!path || path.startsWith("--")) throw new Error('Usage: pnpm sales:import "<path to the .xlsx>" (dry run), or pnpm sales:import --apply --plan <file>');
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
  const [sales, catalogue] = await Promise.all([readSalesFile(path), readCatalogue(supabaseUrl, publishableKey)]);
  const plan = rankSales(catalogue, sales);
  console.log(JSON.stringify(plan.counts));
  // A sample for the owner: the three largest groups and their flagged rows, as ranks only (never a quantity).
  const { members, groupOf } = groupSales(catalogue, sales);
  const used = [...new Set([...groupOf.values()].flatMap((group) => (group ? [group.key] : [])))];
  for (const key of used.sort((a, b) => members.get(b)!.length - members.get(a)!.length).slice(0, 3)) {
    console.log(`\n${key} (${members.get(key)!.length} products with sales)`);
    for (const rank of plan.ranks.filter((item) => item.best_seller && groupOf.get(item.stock_id)?.key === key)) {
      console.log(`  ${rank.stock_id} | ${rank.sales_name} | ${rank.popularity}`);
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  const file = `${outputDirectory}/plan-${day}.json`;
  await writeFile(file, `${JSON.stringify(plan, null, 1)}\n`, "utf8");
  console.log(`\nWrote ${file}. Nothing was written to the database.`);
}

// Importing the ranker (the tests do) must not start a run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error); process.exitCode = 1; });
