import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { Client } from "pg";
import { getDatabaseUrl } from "./database-url";

dotenv.config({ path: ".env.local" });
async function main() {
  const source = process.argv[2] ?? "tmp/spreadsheet_analysis/cleaned/cleaned.csv";
  const records = parse(await readFile(source, "utf8"), { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
  const rows: unknown[][] = records.map((row) => [row["Stock ID"].trim(), row["Product Name"].trim(), row["Brand ID"].trim() || null, row.Status.trim(), Number(row["List Price"]), row["UOM ID"].trim(), Number(row["Source Row"])]);
  const client = new Client({ connectionString: getDatabaseUrl() }); await client.connect();
  try {
    for (let start = 0; start < rows.length; start += 250) {
      const chunk = rows.slice(start, start + 250); const values: unknown[] = [];
      const placeholders = chunk.map((row, index) => { values.push(...row); const base = index * 7; return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`; });
      await client.query(`insert into public.products(stock_id,name,brand_id,status,list_price,uom_id,source_row) values ${placeholders.join(",")} on conflict(stock_id) do update set name=excluded.name,brand_id=excluded.brand_id,status=excluded.status,list_price=excluded.list_price,uom_id=excluded.uom_id,source_row=excluded.source_row,updated_at=now()`, values);
    }
    console.log(`Imported ${rows.length.toLocaleString()} catalogue rows.`);
  } catch (error) { throw error; }
  finally { await client.end(); }
}
void main();
