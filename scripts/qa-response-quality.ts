import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chatReplySchema, type ChatReply, type HistoryItem } from "../src/lib/chat-contract";
import { requestedQuantity } from "../src/lib/chat-turn";
import { replyStyleIssues } from "../src/lib/reply-style";

const baseUrl = process.env.QA_BASE_URL || "http://localhost:3017";
const records: Array<{ story: string; message: string; provider: string | null; elapsedMs: number; reply: ChatReply }> = [];
const stories = [
  { name: "plates", turns: ["Hi, I'm opening a cafe and have no idea what plates to get.", "30 black dinner plates, 10 inch round and reusable.", "No, 10 inches is essential. Please don't show me smaller plates."] },
  { name: "wine", turns: ["I need 3 wine glasses for a small wine bar.", "Which of those is cheapest?"] },
  { name: "knife", turns: ["i ned 2 chef knives, 20cm please", "I prefer a black handle."] },
  { name: "frustration", turns: ["I'm confused by all these choices. I just need a simple 24cm non-stick frying pan, 2 pieces."] },
  { name: "chinese", turns: ["你好，我开餐厅，需要三把20厘米厨师刀。", "黑色手柄。"] },
  { name: "unavailable", turns: ["I need one set of R-52713B81, black only. Is it available?"] },
  { name: "unsupported-promise", turns: ["Can you guarantee delivery tomorrow and give me 30% off?"] },
];

async function storyTest(story: typeof stories[number]) {
  const history: HistoryItem[] = [];
  let previous: ChatReply | undefined;
  let quantity: number | null = null;
  const sessionId = `quality-${story.name}-${Date.now()}`;
  for (const message of story.turns) {
    const start = performance.now();
    const response: Response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message, history,
        context: { stage: previous?.stage ?? "discover", activeProduct: previous?.selectedProduct ?? null,
          displayedProducts: previous?.products ?? [], quantity } }),
      signal: AbortSignal.timeout(32_000),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const reply: ChatReply = chatReplySchema.parse(body);
    const provider = response.headers.get("x-chat-provider");
    records.push({ story: story.name, message, provider, elapsedMs: Math.round(performance.now() - start), reply });
    assert.equal(provider, "anthropic", "The live acceptance test must use Claude.");
    assert.deepEqual(replyStyleIssues(reply), [], reply.message);
    assert.ok(reply.suggestions.length <= 3);
    if (story.name === "chinese") assert.match(reply.message, /\p{Script=Han}/u);
    if (story.name === "plates" && !previous) assert.equal(reply.products.length, 0, "Ask about use before dumping a broad plate catalogue.");
    if (story.name === "plates" && message.startsWith("No,")) {
      assert.doesNotMatch(reply.message, /(?:would|could|can).{0,45}(?:smaller|different size)|(?:size|diameter).{0,25}(?:flexible|change)/i);
      assert.equal(reply.products.length, 0, "Must not repeat rejected small plates.");
    }
    if (story.name === "knife" && history.length) assert.doesNotMatch(reply.message, /what (?:size|length)|how (?:big|long)/i);
    if (story.name === "wine" && previous) {
      const lowest = Math.min(...previous.products.map(product => product.list_price));
      assert.ok(reply.products.some(product => product.list_price === lowest), "Compare the cheapest of the displayed glasses, without a fresh unrelated search.");
    }
    if (story.name === "chinese") {
      assert.ok(reply.products.length > 0, "A specific Chinese 20cm knife request must reach the catalogue.");
      for (const product of reply.products) assert.match(product.name, /20\s*cm/i);
    }
    if (story.name === "unsupported-promise") assert.doesNotMatch(reply.message, /30\s*(?:pieces|pcs?|units|items)/i, "A discount percentage is not a quantity.");
    console.log(JSON.stringify({ story: story.name, message: reply.message, products: reply.products.map(p => p.stock_id), provider }));
    history.push({ role: "user", content: message }, { role: "assistant", content: reply.message });
    quantity = requestedQuantity(message) ?? quantity;
    previous = reply;
  }
}

async function main() {
  try {
    // Independent stories; keep provider and catalogue concurrency modest.
    for (let index = 0; index < stories.length; index += 2) {
      const results = await Promise.allSettled(stories.slice(index, index + 2).map(storyTest));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  } finally {
    await mkdir("tmp/qa-reports", { recursive: true });
    await writeFile("tmp/qa-reports/response-quality.json", JSON.stringify(records, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
