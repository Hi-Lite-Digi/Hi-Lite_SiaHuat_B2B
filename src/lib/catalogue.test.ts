// src/lib/catalogue.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { searchCatalogueByCategory } from "./catalogue";

/** The query of the category search's first request, answered with no rows. */
async function categoryQuery(...args: Parameters<typeof searchCatalogueByCategory>) {
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response("[]", { headers: { "content-range": "*/0" } });
  };
  try {
    await searchCatalogueByCategory(...args);
    return new URL(urls[0]).searchParams;
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_PUBLISHABLE_KEY", saved.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
}
const threeFields = (...terms: string[]) => `(${["category", "third_category", "subcategory"].map((field) => `and(${terms.map((term) => `${field}.ilike.*${term}*`).join(",")})`).join(",")})`;

test("a price sort reads the type's own leaf, dearest first, priced rows only (client, 13 Oct)", async () => {
  const high = await categoryQuery("Chef knives", 200, null, "price_high");
  assert.equal(high.get("or"), "(and(third_category.ilike.*chef*,third_category.ilike.*knives*))");
  assert.equal(high.get("order"), "list_price.desc,name.asc");
  assert.deepEqual(high.getAll("list_price"), ["gt.0"]);
  const budget = await categoryQuery("Chef knives", 200, 100, "price_high");
  assert.deepEqual(budget.getAll("list_price").sort(), ["gt.0", "lte.100"]);
  assert.equal((await categoryQuery("Chef knives", 200, null, "price_low")).get("order"), "list_price.asc,name.asc");
});

test("without a sort the category query puts better sellers first, then the most stocked (r10)", async () => {
  const query = await categoryQuery("Chef knives", 200, null);
  assert.equal(query.get("or"), threeFields("chef", "knives"));
  assert.equal(query.get("order"), "popularity.desc.nullslast,available_quantity.desc.nullslast,name.asc");
  assert.deepEqual(query.getAll("list_price"), []);
});

test("every catalogue read asks for the sales fields (r10)", async () => {
  const fields = (await categoryQuery("Chef knives", 200, null)).get("select")?.split(",") ?? [];
  for (const field of ["popularity", "best_seller", "sales_name"]) assert.ok(fields.includes(field), field);
});

test("a range, section or word that isn't exactly a type name keeps the three-field filter under a sort", async () => {
  // "Cookware" as a leaf read only 389 of its 1,511 rows (lids, sets, accessories) and "Tables" only folding tables (r9 skeptic S1).
  for (const [words, terms] of [["Furniture & Banquet Equipment", ["furniture", "banquet", "equipment"]], ["Cookware", ["cookware"]], ["Tables", ["tables"]], ["chef knife", ["chef", "knife"]]] as const) {
    const query = await categoryQuery(words, 200, null, "price_high");
    assert.equal(query.get("or"), threeFields(...terms), words);
    assert.equal(query.get("order"), "list_price.desc,name.asc", words);
  }
});
