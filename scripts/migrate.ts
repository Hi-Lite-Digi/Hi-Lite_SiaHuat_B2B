import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { getDatabaseUrl } from "./database-url";

dotenv.config({ path: ".env.local" });

async function main() {
  const directory = "supabase/migrations";
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();

  try {
    await client.query(`
      create table if not exists public.app_schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const sql = await readFile(path.join(directory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "select checksum from public.app_schema_migrations where version = $1",
        [version],
      );

      if (!existing.rows[0] && version === "20260807093517_init_catalogue") {
        const legacyInstall = await client.query<{ installed: boolean }>(
          "select to_regclass('public.products') is not null as installed",
        );
        if (legacyInstall.rows[0]?.installed) {
          await client.query(
            "insert into public.app_schema_migrations(version, checksum) values($1, $2)",
            [version, checksum],
          );
          console.log(`Recorded existing ${file}`);
          continue;
        }
      }

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration ${version} changed after it was applied.`);
        }
        console.log(`Skipped ${file}`);
        continue;
      }

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into public.app_schema_migrations(version, checksum) values($1, $2)",
          [version, checksum],
        );
        await client.query("commit");
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

void main();
