import dotenv from "dotenv";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { getDatabaseUrl } from "./database-url";
import { fetchSiaHuatProduct, type ScrapedSiaHuatProduct } from "../src/lib/siahuat-product";

dotenv.config({ path: ".env.local" });

const SITEMAP_URL = "https://store.siahuat.com/sitemap.xml";
const outputDirectory = "tmp/siahuat-crawl";
const outputFile = `${outputDirectory}/products.jsonl`;
const failuresFile = `${outputDirectory}/failures.jsonl`;

function option(name: string, fallback: number) {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];
  return raw ? Number(raw) : fallback;
}

async function loadCompleted() {
  try {
    const lines = (await readFile(outputFile, "utf8")).split("\n").filter(Boolean);
    return new Set(lines.map((line) => (JSON.parse(line) as ScrapedSiaHuatProduct).source_url));
  } catch {
    return new Set<string>();
  }
}

async function fetchWithRetry(url: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchSiaHuatProduct(url);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

async function importProducts(products: ScrapedSiaHuatProduct[]) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (supabaseUrl && publishableKey) {
    for (let start = 0; start < products.length; start += 250) {
      const chunk = products.slice(start, start + 250).map((product) => ({
        ...product,
        status: "Active",
        list_price: product.price_ex_gst,
        brand_id: product.brand,
        scrape_checksum: createHash("sha256").update(JSON.stringify(product)).digest("hex"),
      }));
      const response = await fetch(`${supabaseUrl}/rest/v1/products?on_conflict=stock_id`, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${publishableKey}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`SUPABASE_IMPORT_${response.status}: ${await response.text()}`);
      console.log(`Imported ${Math.min(start + chunk.length, products.length).toLocaleString()} / ${products.length.toLocaleString()}`);
    }
    return;
  }

  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    for (let start = 0; start < products.length; start += 100) {
      const chunk = products.slice(start, start + 100).map((product) => ({
        ...product,
        status: "Active",
        list_price: product.price_ex_gst,
        brand_id: product.brand,
        scrape_checksum: createHash("sha256").update(JSON.stringify(product)).digest("hex"),
      }));
      await client.query(
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
      console.log(`Imported ${Math.min(start + chunk.length, products.length).toLocaleString()} / ${products.length.toLocaleString()}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const concurrency = Math.max(1, Math.min(option("concurrency", 8), 16));
  const limit = Math.max(1, option("limit", Number.MAX_SAFE_INTEGER));
  await mkdir(outputDirectory, { recursive: true });

  if (process.argv.includes("--fresh")) {
    await writeFile(outputFile, "", "utf8");
    await writeFile(failuresFile, "", "utf8");
  }

  const sitemapResponse = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(30_000) });
  if (!sitemapResponse.ok) throw new Error(`SITEMAP_HTTP_${sitemapResponse.status}`);
  const sitemap = await sitemapResponse.text();
  const allUrls = [...sitemap.matchAll(/<loc>(https:\/\/store\.siahuat\.com\/product\/\d+)<\/loc>/g)].map((match) => match[1]);
  const completed = await loadCompleted();
  const pending = allUrls.filter((url) => !completed.has(url)).slice(0, limit);
  console.log(`Sitemap products: ${allUrls.length.toLocaleString()}; complete: ${completed.size.toLocaleString()}; pending this run: ${pending.length.toLocaleString()}.`);

  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let writeQueue = Promise.resolve();
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      try {
        const product = await fetchWithRetry(url);
        writeQueue = writeQueue.then(() => appendFile(outputFile, `${JSON.stringify(product)}\n`, "utf8"));
        await writeQueue;
        succeeded += 1;
      } catch (error) {
        failed += 1;
        await appendFile(failuresFile, `${JSON.stringify({ url, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })}\n`, "utf8");
      }
      if ((succeeded + failed) % 100 === 0) console.log(`Processed ${(succeeded + failed).toLocaleString()} / ${pending.length.toLocaleString()} (${failed} failed).`);
    }
  });
  await Promise.all(workers);

  const rows = (await readFile(outputFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ScrapedSiaHuatProduct);
  const unique = [...new Map(rows.map((row) => [row.stock_id, row])).values()].sort((a, b) => a.stock_id.localeCompare(b.stock_id));
  await writeFile(`${outputDirectory}/products.sorted.json`, JSON.stringify(unique, null, 2), "utf8");
  await writeFile(`${outputDirectory}/summary.json`, JSON.stringify({ sitemapProducts: allUrls.length, uniqueProducts: unique.length, succeeded, failed, completedAt: new Date().toISOString() }, null, 2), "utf8");
  console.log(`Crawl finished with ${unique.length.toLocaleString()} unique item codes and ${failed} failures.`);

  if (process.argv.includes("--import")) await importProducts(unique);
}

void main();
