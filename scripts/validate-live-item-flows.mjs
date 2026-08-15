import fs from "node:fs/promises";

const webhookUrl = process.env.N8N_WEBHOOK_URL;
const workflowKey = process.env.N8N_WORKFLOW_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!webhookUrl || !workflowKey || !supabaseUrl || !supabaseKey) {
  throw new Error("Live n8n and Supabase environment variables are required");
}

const cases = [
  {
    id: "chef-knife",
    messages: ["Do you have chef knives?", "Western style, around 8 inches. Please show me the options."],
    family: /chef(?:'s)?\s+knife/i,
  },
  {
    id: "cleaver",
    messages: ["Show me Chinese-style cleavers"],
    family: /cleaver|chinese knife|chopper/i,
  },
  {
    id: "frying-pan",
    messages: ["I need a frying pan", "Non-stick please. Show me a few available options."],
    family: /frying pan|frypan/i,
  },
  {
    id: "glass-bowl",
    messages: ["I need a glass serving bowl", "Medium size, around 25 cm. Please show me the options."],
    family: /glass.*bowl|bowl.*glass/i,
  },
  {
    id: "cutlery-set",
    messages: ["Show me cutlery sets", "For 6 place settings. Please show me the options."],
    family: /cutlery.*set|set.*cutlery/i,
  },
  {
    id: "wine-glass",
    messages: ["Do you sell wine glasses?", "Stemmed wine glasses please. Show me the options."],
    family: /wine.*glass|glass.*wine/i,
  },
  {
    id: "coffee",
    messages: ["I need coffee beans", "Whole beans, medium roast. Please show me the options."],
    family: /coffee/i,
  },
  {
    id: "dispenser",
    messages: ["Do you have beverage dispensers?", "For cold drinks. Please show me the options."],
    family: /dispenser/i,
  },
  {
    id: "dinner-plate",
    messages: ["Show me dinner plates", "Porcelain, around 27 cm. Please show me the options."],
    family: /plate/i,
  },
  {
    id: "food-storage",
    messages: ["I need food storage containers", "Plastic and airtight please. Show me the options."],
    family: /container|storage box|food box/i,
  },
];

const requestedIds = new Set(
  String(process.env.TEST_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const activeCases = requestedIds.size
  ? cases.filter((test) => requestedIds.has(test.id))
  : cases;

async function postChat({ message, sessionId, history }) {
  const started = performance.now();
  let lastFailure;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sia-huat-key": workflowKey,
      },
      body: JSON.stringify({ sessionId, message, history }),
      signal: AbortSignal.timeout(75_000),
    });
    const raw = await response.text();
    try {
      const body = JSON.parse(raw);
      return { status: response.status, body, durationMs: Math.round(performance.now() - started), attempts: attempt };
    } catch {
      lastFailure = new Error(`Live workflow returned HTTP ${response.status} with an empty or non-JSON body`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
  }

  throw lastFailure;
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

function replyDefects(message) {
  const defects = [];
  if (/trouble processing|please try again/i.test(message)) defects.push("generic processing error");
  if (/\b(stock_id|list_price|supabase|database|tool call)\b/i.test(message)) defects.push("implementation jargon");
  if (/\(Note:/i.test(message)) defects.push("internal note leaked");
  if (/\s[—–]\s/.test(message)) defects.push("robotic dash punctuation");
  return defects;
}

async function runCase(test) {
  const sessionId = `live-flow-${test.id}-${crypto.randomUUID()}`;
  const history = [];
  const turns = [];
  let products = [];

  for (const message of test.messages) {
    const response = await postChat({ message, sessionId, history });
    const reply = String(response.body.message ?? "");
    products = returnedProducts(response.body);
    turns.push({
      user: message,
      status: response.status,
      stage: response.body.stage,
      reply,
      durationMs: response.durationMs,
      productCount: products.length,
      defects: replyDefects(reply),
    });
    history.push({ role: "user", content: message }, { role: "assistant", content: reply });
    if (products.length > 0) break;
  }

  if (products.length === 0) {
    const message = "No other preference. Please show me the closest active catalogue options now.";
    const response = await postChat({ message, sessionId, history });
    const reply = String(response.body.message ?? "");
    products = returnedProducts(response.body);
    turns.push({
      user: message,
      status: response.status,
      stage: response.body.stage,
      reply,
      durationMs: response.durationMs,
      productCount: products.length,
      defects: replyDefects(reply),
    });
  }

  const dbChecks = await verifyAgainstDatabase(products);
  const failures = [
    turns.every((turn) => turn.status === 200) ? null : "non-200 response",
    turns.flatMap((turn) => turn.defects).length === 0 ? null : [...new Set(turns.flatMap((turn) => turn.defects))].join(", "),
    products.length > 0 ? null : "no products after clarification",
    products.length <= 3 ? null : `too many options (${products.length})`,
    products.every((item) => test.family.test(item.name ?? "")) ? null : "unrelated product family returned",
    products.every((item) => Number(item.list_price) > 0) ? null : "missing or invalid price",
    dbChecks.every((item) => item.found && item.exactName && item.exactPrice && item.eligibleStatus)
      ? null
      : "response does not match an eligible Supabase catalogue row",
  ].filter(Boolean);

  return {
    id: test.id,
    pass: failures.length === 0,
    failures,
    totalDurationMs: turns.reduce((total, turn) => total + turn.durationMs, 0),
    turns,
    products: products.map(({ stock_id, name, list_price, status, uom_id }) => ({
      stock_id,
      name,
      list_price,
      status,
      uom_id,
    })),
    dbChecks,
  };
}

const results = [];
for (const test of activeCases) {
  const result = await runCase(test);
  results.push(result);
  const turnSummary = result.turns.map((turn) => `${turn.durationMs}ms/${turn.stage}/${turn.productCount}`).join(" -> ");
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id} ${turnSummary}${result.failures.length ? `: ${result.failures.join("; ")}` : ""}`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
  results,
};

await fs.mkdir("tmp/qa-reports", { recursive: true });
await fs.writeFile("tmp/qa-reports/live-item-flows.json", `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ total: summary.total, passed: summary.passed, failed: summary.failed }, null, 2));
process.exitCode = summary.failed === 0 ? 0 : 1;
