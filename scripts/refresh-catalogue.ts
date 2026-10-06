import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { getDatabaseUrl } from "./database-url";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "../src/lib/siahuat-product";

// Brings the catalogue up to date with the store, page by page, without a full re-crawl (r8: in 7 weeks 131 pages died and
// 241 appeared, and 04-00820 moved from a dead chiller page to the grinder's). Two steps:
//   pnpm catalogue:refresh                                   dry run: reads only, writes tmp/catalogue-refresh/plan-<date>.json
//   pnpm catalogue:refresh --apply --plan <reviewed file>    writes that plan to the database (only after the owner's yes)
// Afterwards run catalogue:images, catalogue:ranges and catalogue:nouns. The crawler isn't used: it keeps the last row per
// code, upserts everything Active and never retires a dead page.

const SITEMAP_URL = "https://store.siahuat.com/sitemap.xml";
const outputDirectory = "tmp/catalogue-refresh";

export type CatalogueRow = { stock_id: string; source_product_id: string | null; source_url: string | null; status: string; list_price: number };
/** One read of a store page: the product it shows, the store's not-found page, or a failure that proves nothing. */
export type PageRead = { product: ScrapedSiaHuatProduct } | { gone: true } | { error: string };
type Skipped = { stock_id: string; page: string; name: string; why: string };

export type RefreshPlan = {
  counts: Record<"insert" | "updateMovedFromDead" | "deactivate" | "skipDuplicateCode" | "skipZeroPrice" | "keepAlive" | "unresolved", number>;
  /** New codes, each on one live sitemap page, with a price. */
  insert: ScrapedSiaHuatProduct[];
  /** The row's own page is gone and exactly one live sitemap page shows its code: the row takes that page's product. */
  updateMovedFromDead: Array<{ fromPage: string; product: ScrapedSiaHuatProduct }>;
  /** Gone on both reads, and no new page shows the code: marked Discontinued, never deleted. */
  deactivate: Array<{ stock_id: string; page: string }>;
  /** A code already held by another live page, or shown on 2+ new pages: one product per code (OD-16). */
  skipDuplicateCode: Skipped[];
  /** $0 pages stay out until Sia Huat prices them (OD-3). */
  skipZeroPrice: Array<Skipped & { available_quantity: number | null }>;
  /** Alive but off the sitemap: left Active (OD-5). */
  keepAlive: Array<{ stock_id: string; page: string; stock_status: string }>;
  /** Couldn't tell (a read failed, gone on one read only, or the page shows another code), or a Discontinued row whose page
   *  is alive again (nothing records who retired it, so it isn't set back to Active): left as it is. */
  unresolved: Array<{ stock_id: string | null; page: string; why: string }>;
};

const byCodeThenPage = (list: Array<{ stock_id: string | null; page: string }>) =>
  list.sort((a, b) => ((a.stock_id ?? "") < (b.stock_id ?? "") ? -1 : (a.stock_id ?? "") > (b.stock_id ?? "") ? 1 : Number(a.page) - Number(b.page)));

/** Sorts the store's pages and the catalogue's rows into the plan. Codes compare exactly: stock_id's unique index is case-sensitive. */
export function classify(sitemapPages: string[], rows: CatalogueRow[], reads: Map<string, PageRead[]>): RefreshPlan {
  const onSitemap = new Set(sitemapPages);
  const rowByCode = new Map(rows.map((row) => [row.stock_id, row]));
  const catalogued = new Set(rows.flatMap((row) => (row.source_product_id ? [row.source_product_id] : [])));
  // A page is gone only when two reads, at least 5 minutes apart, both found the store's not-found page.
  const pageState = (page: string) => {
    const pageReads = reads.get(page) ?? [];
    const product = pageReads.findLast((read): read is { product: ScrapedSiaHuatProduct } => "product" in read)?.product;
    if (product) return { product };
    if (pageReads.length >= 2 && pageReads.every((read) => "gone" in read)) return { gone: true };
    const failed = pageReads.find((read): read is { error: string } => "error" in read);
    return { why: failed ? `read failed: ${failed.error}` : pageReads.length ? "gone on one read only" : "not read" };
  };
  const plan: Omit<RefreshPlan, "counts"> = { insert: [], updateMovedFromDead: [], deactivate: [], skipDuplicateCode: [], skipZeroPrice: [], keepAlive: [], unresolved: [] };

  const newPages = new Map<string, ScrapedSiaHuatProduct[]>();
  for (const page of new Set(sitemapPages)) {
    if (catalogued.has(page)) continue;
    const state = pageState(page);
    if (!state.product) plan.unresolved.push({ stock_id: null, page, why: state.gone ? "on the sitemap but gone" : state.why! });
    else newPages.set(state.product.stock_id, [...(newPages.get(state.product.stock_id) ?? []), state.product]);
  }
  const movedFrom = new Set<string>();
  for (const [code, products] of newPages) {
    const skip = (product: ScrapedSiaHuatProduct, why: string) => ({ stock_id: code, page: product.source_product_id, name: product.name, why });
    const zeroPrice = (product: ScrapedSiaHuatProduct, why: string) => plan.skipZeroPrice.push({ ...skip(product, why), available_quantity: product.available_quantity });
    if (products.length > 1) {
      for (const product of products) plan.skipDuplicateCode.push(skip(product, `${products.length} new pages show this code`));
      continue;
    }
    const [product] = products;
    const holder = rowByCode.get(code);
    if (!holder) {
      if (product.price_ex_gst > 0) plan.insert.push(product);
      else zeroPrice(product, "new code at $0");
      continue;
    }
    const heldPage = holder.source_product_id;
    const held = heldPage && !onSitemap.has(heldPage) ? pageState(heldPage) : null;
    // A row whose own page is alive never moves, even to a page the sitemap lists (r8: two in-stock samovars would have
    // moved onto $0, out-of-stock pages).
    if (!held || held.product?.stock_id === code) plan.skipDuplicateCode.push(skip(product, `code already held by page ${heldPage}`));
    else if (!held.gone) plan.unresolved.push({ stock_id: code, page: product.source_product_id, why: `code held by page ${heldPage}, not confirmed alive or gone` });
    else if (product.price_ex_gst > 0) {
      plan.updateMovedFromDead.push({ fromPage: heldPage!, product });
      movedFrom.add(heldPage!);
    } else zeroPrice(product, `would replace the gone page ${heldPage}, but is $0`);
  }

  for (const row of rows) {
    const page = row.source_product_id;
    const retired = row.status === "Discontinued";
    // A retired row is checked on the sitemap too: the refresh repeats weekly, and a retired page can come back.
    if (!page || (onSitemap.has(page) && !retired) || movedFrom.has(page)) continue;
    const state = pageState(page);
    if (state.product?.stock_id === row.stock_id && retired) plan.unresolved.push({ stock_id: row.stock_id, page, why: "Discontinued, but its page is alive again" });
    else if (state.product?.stock_id === row.stock_id) plan.keepAlive.push({ stock_id: row.stock_id, page, stock_status: state.product.stock_status });
    else if (state.product) plan.unresolved.push({ stock_id: row.stock_id, page, why: `page now shows code ${state.product.stock_id}` });
    else if (!state.gone) plan.unresolved.push({ stock_id: row.stock_id, page, why: state.why! });
    else if (retired) continue;
    else if (newPages.has(row.stock_id)) plan.unresolved.push({ stock_id: row.stock_id, page, why: "gone, but its code is on a new page that can't take it" });
    else plan.deactivate.push({ stock_id: row.stock_id, page });
  }

  plan.insert.sort((a, b) => (a.stock_id < b.stock_id ? -1 : a.stock_id > b.stock_id ? 1 : 0));
  plan.updateMovedFromDead.sort((a, b) => (a.product.stock_id < b.product.stock_id ? -1 : a.product.stock_id > b.product.stock_id ? 1 : 0));
  for (const list of [plan.deactivate, plan.skipDuplicateCode, plan.skipZeroPrice, plan.keepAlive, plan.unresolved]) byCodeThenPage(list);
  const counts = Object.fromEntries(Object.entries(plan).map(([list, items]) => [list, items.length])) as RefreshPlan["counts"];
  return { counts, ...plan };
}

async function readCatalogue(supabaseUrl: string, publishableKey: string) {
  const rows: CatalogueRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${supabaseUrl}/rest/v1/products?select=stock_id,source_product_id,source_url,status,list_price&order=stock_id&limit=1000&offset=${offset}`, {
      headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}` },
    });
    if (!response.ok) throw new Error(`SUPABASE_${response.status}`);
    const page = await response.json() as CatalogueRow[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// At most 4 store reads at a time, as the crawl checks did (r8: 461 pages in 44 s).
async function readPages(pages: string[], reads: Map<string, PageRead[]>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < pages.length) {
      const page = pages[cursor++];
      const read: PageRead = await fetchSiaHuatProduct(`https://store.siahuat.com/product/${page}`)
        .then((product) => ({ product }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? (error.name === "TimeoutError" ? error.name : error.message.split(":")[0]) : String(error);
          return message === "PAGE_GONE" ? { gone: true as const } : { error: message };
        });
      reads.set(page, [...(reads.get(page) ?? []), read]);
    }
  }));
}

/** Reads the sitemap, the catalogue (REST, publishable key, read only) and the pages that differ. Never opens a database connection. */
export async function dryRun({ supabaseUrl, publishableKey, pauseMs = 5 * 60_000, log = console.log }: {
  supabaseUrl: string; publishableKey: string; pauseMs?: number; log?: (line: string) => void;
}) {
  const sitemapResponse = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(30_000) });
  if (!sitemapResponse.ok) throw new Error(`SITEMAP_HTTP_${sitemapResponse.status}`);
  const sitemapPages = [...new Set([...(await sitemapResponse.text()).matchAll(/<loc>https:\/\/store\.siahuat\.com\/product\/(\d+)<\/loc>/g)].map((match) => match[1]))];
  const rows = await readCatalogue(supabaseUrl, publishableKey);
  const onSitemap = new Set(sitemapPages);
  const catalogued = new Set(rows.flatMap((row) => (row.source_product_id ? [row.source_product_id] : [])));
  const missing = sitemapPages.filter((page) => !catalogued.has(page));
  const offSitemap = [...catalogued].filter((page) => !onSitemap.has(page));
  const retiredOnSitemap = [...new Set(rows.flatMap((row) => (row.status === "Discontinued" && row.source_product_id && onSitemap.has(row.source_product_id) ? [row.source_product_id] : [])))];
  log(`Sitemap pages: ${sitemapPages.length}; catalogue rows: ${rows.length}; new pages: ${missing.length}; catalogue pages off the sitemap: ${offSitemap.length}; retired pages on the sitemap: ${retiredOnSitemap.length}.`);

  const reads = new Map<string, PageRead[]>();
  await readPages([...missing, ...offSitemap, ...retiredOnSitemap], reads);
  // Every page that didn't show a product is read again later: gone needs both reads, and a failure may pass.
  const again = [...reads].filter(([, [first]]) => !("product" in first)).map(([page]) => page);
  if (again.length) {
    log(`Reading ${again.length} pages again in ${Math.round(pauseMs / 60_000)} minutes.`);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    await readPages(again, reads);
  }
  return classify(sitemapPages, rows, reads);
}

/** Writes a reviewed plan in one transaction, after a backup outside the public schema. Any count that differs rolls it all back. */
export async function applyPlan(plan: RefreshPlan, client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> }, day: string) {
  if (!/^\d{8}$/.test(day)) throw new Error(`BAD_BACKUP_DAY: ${day}`);
  const products = [...plan.insert, ...plan.updateMovedFromDead.map((move) => move.product)];
  const retired = plan.deactivate.map((row) => row.page);
  const check = (what: string, rowCount: number | null, expected: number) => {
    if (rowCount !== expected) throw new Error(`ROW_COUNT ${what}: ${rowCount} rows, plan says ${expected}`);
  };
  await client.query("begin");
  try {
    // Not in public: a copy there would be readable and writable through REST with the publishable key.
    await client.query("create schema if not exists backup");
    await client.query(`create table backup.products_${day} as table public.products`);
    // The plan must still match the catalogue: an insert whose code is taken now, or a moved row on another page, would
    // swap the product a code points at.
    const held = await client.query("select stock_id, source_product_id from public.products where stock_id = any($1)", [products.map((product) => product.stock_id)]);
    const expected = new Map(plan.updateMovedFromDead.map((move) => [move.product.stock_id, move.fromPage]));
    const holders = held.rows as Array<{ stock_id: string; source_product_id: string | null }>;
    if (holders.length !== expected.size || holders.some((row) => expected.get(row.stock_id) !== row.source_product_id)) {
      throw new Error("STALE_PLAN: the catalogue changed since the dry run; run it again and review the new plan");
    }
    const chunk = products.map((product) => ({
      ...product,
      status: "Active",
      list_price: product.price_ex_gst,
      brand_id: product.brand,
      scrape_checksum: createHash("sha256").update(JSON.stringify(product)).digest("hex"),
    }));
    // The crawler's column list and conflict rule (crawl-siahuat.ts), copied so the crawler stays untouched.
    const upserted = await client.query(
      `insert into public.products (
        stock_id, name, brand_id, status, list_price, uom_id, source_stock_id,
        source_product_id, source_url, image_url, description, size, dimensions,
        brand, model, price_ex_gst, in_stock, available_quantity, stock_status,
        category, subcategory, third_category, attributes, last_scraped_at, scrape_checksum
      )
      select stock_id, name, brand_id, status, list_price, uom_id, source_stock_id,
        source_product_id, source_url, image_url, description, size, dimensions,
        brand, model, price_ex_gst, in_stock, available_quantity, stock_status,
        category, subcategory, third_category, attributes, last_scraped_at, scrape_checksum
      from jsonb_to_recordset($1::jsonb) as x(
        stock_id text, name text, brand_id text, status text, list_price numeric,
        uom_id text, source_stock_id text, source_product_id text, source_url text,
        image_url text, description text, size text, dimensions text, brand text,
        model text, price_ex_gst numeric, in_stock boolean, available_quantity numeric,
        stock_status text, category text, subcategory text, third_category text,
        attributes jsonb, last_scraped_at timestamptz, scrape_checksum text
      )
      on conflict (stock_id) do update set
        name=excluded.name, brand_id=excluded.brand_id, status=excluded.status,
        list_price=excluded.list_price, uom_id=excluded.uom_id,
        source_stock_id=excluded.source_stock_id, source_product_id=excluded.source_product_id,
        source_url=excluded.source_url, image_url=excluded.image_url,
        description=excluded.description, size=excluded.size, dimensions=excluded.dimensions,
        brand=excluded.brand, model=excluded.model, price_ex_gst=excluded.price_ex_gst,
        in_stock=excluded.in_stock, available_quantity=excluded.available_quantity,
        stock_status=excluded.stock_status, category=excluded.category,
        subcategory=excluded.subcategory, third_category=excluded.third_category,
        attributes=excluded.attributes, last_scraped_at=excluded.last_scraped_at,
        scrape_checksum=excluded.scrape_checksum, updated_at=now()`,
      [JSON.stringify(chunk)],
    );
    check("upserted", upserted.rowCount, products.length);
    const discontinued = await client.query(
      "update public.products set status = 'Discontinued', updated_at = now() where source_product_id = any($1) and status <> 'Discontinued'",
      [retired],
    );
    check("marked Discontinued", discontinued.rowCount, retired.length);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  dotenv.config({ path: ".env.local", quiet: true });
  const day = new Date().toISOString().slice(0, 10);
  if (process.argv.includes("--apply")) {
    const at = process.argv.indexOf("--plan");
    const file = at > 0 ? process.argv[at + 1] : undefined;
    if (!file) throw new Error("--apply needs --plan <file>: it applies a reviewed dry-run plan, never a fresh one");
    const plan = JSON.parse(await readFile(file, "utf8")) as RefreshPlan;
    const client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
    try {
      await applyPlan(plan, client, day.replace(/-/g, ""));
    } finally {
      await client.end();
    }
    console.log(`Applied ${file}: ${JSON.stringify(plan.counts)}. Next: catalogue:images, catalogue:ranges, catalogue:nouns.`);
    return;
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
  const plan = await dryRun({ supabaseUrl, publishableKey });
  await mkdir(outputDirectory, { recursive: true });
  const file = `${outputDirectory}/plan-${day}.json`;
  await writeFile(file, `${JSON.stringify(plan, null, 1)}\n`, "utf8");
  console.log(`${JSON.stringify(plan.counts)}\nWrote ${file}. Nothing was written to the database.`);
}

// Importing the classifier (the tests do) must not start a run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { console.error(error); process.exitCode = 1; });
