import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

const supabaseUrl = required("SUPABASE_URL");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = required("SUPABASE_ANON_KEY");

function headers(key: string, extra: Record<string, string> = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

async function exactCount(
  pathname: string,
  key: string,
  filter?: Record<string, string>,
  allowDenied = false,
) {
  const url = new URL(`/rest/v1/${pathname}`, supabaseUrl);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1");
  for (const [name, value] of Object.entries(filter ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: headers(key, { Prefer: "count=exact", Range: "0-0" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (allowDenied && (response.status === 401 || response.status === 403)) return 0;
  if (!response.ok) throw new Error(`${pathname} count failed with ${response.status}`);
  const contentRange = response.headers.get("content-range") ?? "";
  const total = Number.parseInt(contentRange.split("/")[1] ?? "0", 10);
  return Number.isFinite(total) ? total : 0;
}

async function searchSample() {
  const response = await fetch(new URL("/rest/v1/rpc/search_products", supabaseUrl), {
    method: "POST",
    headers: headers(serviceKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ search_query: "coffee beans", result_limit: 3 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`search_products failed with ${response.status}`);
  return await response.json() as Array<{ stock_id: string; name: string; status: string; list_price: number; uom_id: string }>;
}

async function main() {
  const [active, discontinued, total, anonymousProducts, anonymousEnquiries, sample] = await Promise.all([
    exactCount("products", serviceKey, { status: "eq.Active" }),
    exactCount("products", serviceKey, { status: "eq.Discontinued" }),
    exactCount("products", serviceKey),
    exactCount("products", anonKey, undefined, true),
    exactCount("enquiries", anonKey, undefined, true),
    searchSample(),
  ]);

  if (total <= 0) throw new Error("The products table is empty");
  if (anonymousProducts !== 0 || anonymousEnquiries !== 0) {
    throw new Error("Anonymous access can read protected catalogue or enquiry rows");
  }
  if (sample.length === 0) throw new Error("search_products returned no sample rows");

  console.log(JSON.stringify({
    counts: { total, Active: active, Discontinued: discontinued },
    security: { anonymousProducts, anonymousEnquiries, protected: true },
    sample,
  }, null, 2));
}

void main();
