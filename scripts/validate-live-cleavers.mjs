import fs from "node:fs/promises";
import path from "node:path";

const webhookUrl = process.env.N8N_WEBHOOK_URL;
const workflowKey = process.env.N8N_WORKFLOW_KEY;

if (!webhookUrl || !workflowKey) {
  throw new Error("N8N_WEBHOOK_URL and N8N_WORKFLOW_KEY are required");
}

async function ask(message, imagePath) {
  const image = imagePath
    ? {
        dataUrl: `data:image/${path.extname(imagePath).toLowerCase() === ".png" ? "png" : "jpeg"};base64,${(await fs.readFile(imagePath)).toString("base64")}`,
        mimeType: path.extname(imagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg",
        name: "customer-upload",
      }
    : undefined;
  const started = performance.now();
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sia-huat-key": workflowKey,
    },
    body: JSON.stringify({
      sessionId: `live-cleaver-${crypto.randomUUID()}`,
      message,
      history: [],
      image,
    }),
    signal: AbortSignal.timeout(image ? 90_000 : 60_000),
  });
  const body = await response.json();
  return {
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    body,
  };
}

function productsOf(body) {
  return [
    ...(body.selectedProduct ? [body.selectedProduct] : []),
    ...(Array.isArray(body.products) ? body.products : []),
  ];
}

function validateCleaverReply(result, label) {
  const products = productsOf(result.body);
  const failures = [
    result.status === 200 ? null : `HTTP ${result.status}`,
    products.length > 0 ? null : "no catalogue options returned",
    products.every((product) => /cleaver|chinese knife|chopper/i.test(product.name ?? ""))
      ? null
      : "response contains a non-cleaver product",
    /trouble processing|try again/i.test(result.body.message ?? "")
      ? "generic workflow error returned"
      : null,
  ].filter(Boolean);
  return {
    label,
    pass: failures.length === 0,
    failures,
    durationMs: result.durationMs,
    message: result.body.message,
    products: products.map(({ stock_id, name, list_price, uom, status }) => ({
      stock_id,
      name,
      list_price,
      uom,
      status,
    })),
  };
}

const textCases = [
  "Any cleaver",
  "Chinese-style cleaver",
  "Is there any other cleaver that is available?",
];
const results = [];

for (const message of textCases) {
  results.push(validateCleaverReply(await ask(message), message));
}

const imagePath = process.argv[2];
if (imagePath) {
  results.push(validateCleaverReply(
    await ask("Do you have something like this? Please show me available cleaver options.", imagePath),
    "cleaver image",
  ));
}

const summary = {
  total: results.length,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
  results,
};

console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.failed === 0 ? 0 : 1;
