import fs from "node:fs/promises";

const webhookUrl = process.env.N8N_WEBHOOK_URL;
const workflowKey = process.env.N8N_WORKFLOW_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!webhookUrl || !workflowKey || !supabaseUrl || !supabaseKey) {
  throw new Error("Live n8n and Supabase environment variables are required");
}

const cases = [
  { id: "chef-knife", message: "Do you have chef knives?", family: /chef(?:'s)?\s+knife/i },
  { id: "cleaver", message: "Show me Chinese-style cleavers", family: /cleaver|chinese knife|chopper/i },
  { id: "frying-pan", message: "I need a frying pan", family: /frying pan|frypan/i },
  { id: "glass-bowl", message: "I need a glass serving bowl", family: /glass.*bowl|bowl.*glass/i },
  { id: "cutlery-set", message: "Show me cutlery sets", family: /cutlery.*set|set.*cutlery/i },
  { id: "wine-glass", message: "Do you sell wine glasses?", family: /wine.*glass|glass.*wine/i },
  { id: "coffee", message: "I need coffee beans", family: /coffee/i },
  { id: "dispenser", message: "Do you have beverage dispensers?", family: /dispenser/i },
  { id: "dinner-plate", message: "Show me dinner plates", family: /dinner.*plate|plate.*dinner/i },
  { id: "food-storage", message: "I need food storage containers", family: /container|storage box|food box/i },
];

async function postChat({ message, sessionId, history = [] }) {
  const started = performance.now();
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sia-huat-key": workflowKey,
    },
    body: JSON.stringify({ sessionId, message, history }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  return { status: response.status, body, durationMs: Math.round(performance.now() - started) };
}

function returnedProducts(body) {
  const products = [...(Array.isArray(body.products) ? body.products : [])];
  if (body.selectedProduct && !products.some((item) => item.stock_id === body.selectedProduct.stock_id)) {
    products.unshift(body.selectedProduct);
  }
  return products;
}

async function verifyAgainstDatabase(products) {
  const checks = [];
  for (const product of products) {
    const query = new URLSearchParams({
      select: "stock_id,name,status,list_price,uom_id",
      stock_id: `eq.${product.stock_id}`,
      limit: "1",
    });
    const response = await fetch(`${supabaseUrl}/rest/v1/products?${query}`, {
      headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    const rows = await response.json();
    const row = rows[0];
    checks.push({
      stock_id: product.stock_id,
      found: Boolean(row),
      exactName: row?.name === product.name,
      exactPrice: Number(row?.list_price) === Number(product.list_price),
      eligibleStatus: ["Active", "New"].includes(row?.status),
    });
  }
  return checks;
}

async function runCase(test) {
  const result = await postChat({
    message: test.message,
    sessionId: `live-item-${test.id}-${crypto.randomUUID()}`,
  });
  const products = returnedProducts(result.body);
  const dbChecks = await verifyAgainstDatabase(products);
  const failures = [
    result.status === 200 ? null : `HTTP ${result.status}`,
    products.length > 0 ? null : "no products returned",
    products.length <= 3 ? null : `too many options (${products.length})`,
    products.every((item) => test.family.test(item.name ?? "")) ? null : "unrelated product family returned",
    products.every((item) => Number(item.list_price) > 0) ? null : "missing or invalid price",
    dbChecks.every((item) => item.found && item.exactName && item.exactPrice && item.eligibleStatus)
      ? null
      : "response does not match an eligible Supabase catalogue row",
    /trouble processing|try again|stock_id|list_price|supabase|database/i.test(result.body.message ?? "")
      ? "generic error or implementation jargon in reply"
      : null,
  ].filter(Boolean);
  return {
    id: test.id,
    message: test.message,
    pass: failures.length === 0,
    failures,
    durationMs: result.durationMs,
    reply: result.body.message,
    products: products.map(({ stock_id, name, list_price, status }) => ({ stock_id, name, list_price, status })),
    dbChecks,
  };
}

const results = [];
for (const test of cases) {
  const result = await runCase(test);
  results.push(result);
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${result.durationMs}ms${result.failures.length ? `: ${result.failures.join("; ")}` : ""}`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
  results,
};

await fs.mkdir("tmp/qa-reports", { recursive: true });
await fs.writeFile("tmp/qa-reports/live-item-matrix.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed }, null, 2));
process.exitCode = summary.failed === 0 ? 0 : 1;
