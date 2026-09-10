import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chatReplySchema, type HistoryItem } from "../src/lib/chat-contract";
import { replyStyleIssues } from "../src/lib/reply-style";

const baseUrl = process.env.QA_BASE_URL || "http://localhost:3017";
const records: unknown[] = [];

async function conversation(name: string, messages: string[]) {
  const history: HistoryItem[] = [];
  const sessionId = `claude-qa-${name}-${Date.now()}`;
  for (const message of messages) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message, history }),
      signal: AbortSignal.timeout(32_000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const reply = chatReplySchema.parse(body);
    const provider = response.headers.get("x-chat-provider");
    const model = response.headers.get("x-chat-model");
    records.push({ name, message, provider, model, usage: response.headers.get("x-ai-usage"), elapsedMs: Math.round(performance.now() - started), reply });
    assert.equal(provider, "anthropic", "Acceptance must exercise Claude, not the fallback");
    assert.equal(model, process.env.QA_CLAUDE_MODEL || "claude-sonnet-5");
    assert.deepEqual(replyStyleIssues(reply), [], reply.message);
    assert.ok((reply.message.match(/[?？]/g) ?? []).length <= 1, reply.message);
    assert.doesNotMatch(reply.message, /No sourcing request has been sent|current online catalogue|I won.t show an accessory/i);
    if (name === "chinese") assert.match(reply.message, /[\u4e00-\u9fff]/u);
    if (name === "plates") {
      for (const product of reply.products) assert.doesNotMatch(`${product.name} ${product.description}`, /\bnarrow\b|\bsushi\b|\bcanap[eé]/i);
    }
    console.log(JSON.stringify({ name, provider, message: reply.message, products: reply.products.map(p => p.stock_id) }));
    history.push({ role: "user", content: message }, { role: "assistant", content: reply.message });
  }
}

async function photo() {
  const file = process.env.QA_IMAGE_PATH;
  if (!file) return;
  const data = await readFile(file);
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: `claude-photo-${Date.now()}`, message: "What product is this?", history: [],
      image: { name: "reference.jpg", mimeType: "image/jpeg", dataUrl: `data:image/jpeg;base64,${data.toString("base64")}` } }),
    signal: AbortSignal.timeout(32_000),
  });
  const body = await response.json();
  records.push({ name: "stove-photo", provider: response.headers.get("x-chat-provider"), model: response.headers.get("x-chat-model"),
    usage: response.headers.get("x-ai-usage"), elapsedMs: Math.round(performance.now() - started), reply: body });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("x-chat-provider"), "anthropic");
  assert.equal(response.headers.get("x-chat-model"), process.env.QA_CLAUDE_MODEL || "claude-sonnet-5");
  const reply = chatReplySchema.parse(body);
  assert.match(reply.message, /stove|cooker|burner/i);
  assert.doesNotMatch(reply.message, /trouble making out|what(?:'s| is) the item|what is it called/i);
  assert.deepEqual(replyStyleIssues(reply), []);
  console.log(JSON.stringify({ name: "stove-photo", message: reply.message, products: reply.products.map(p => p.stock_id) }));
}

async function main() {
  try {
    await conversation("plates", ["Hi, I'm opening a small cafe and need 30 black dinner plates. What would you suggest?", "I need reusable round plates for mains, around 10 inches."]);
    await conversation("chinese", ["你好，我想买一把厨师刀。"]);
    await conversation("knife", ["I need a 20cm chef knife, 2 pieces."]);
    await photo();
  } finally {
    await mkdir("tmp/qa-reports", { recursive: true });
    await writeFile(process.env.QA_REPORT_PATH || "tmp/qa-reports/claude-restoration.json", JSON.stringify(records, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
