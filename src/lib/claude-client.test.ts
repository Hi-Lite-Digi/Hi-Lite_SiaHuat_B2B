import assert from "node:assert/strict";
import test from "node:test";
import { applyClaudeWording, composeClaudeReply, inspectImageWithClaude } from "./claude-client";
import type { ChatReply, ChatRequest } from "./chat-contract";
import { withModelUsage } from "./model-usage";
import { replyStyleIssues } from "./reply-style";

const product = { stock_id: "P1", name: "Black plate", status: "Active", list_price: 8.17, uom_id: "PC", available_quantity: 40 };
const draft: ChatReply = { message: "One match", stage: "discover", products: [product], selectedProduct: null, suggestions: ["1", "Choose another item"] };
const input: ChatRequest = { sessionId: "claude-test", message: "30 black dinner plates", history: [] };

test("wording cannot invent a product or an unsupported action", () => {
  assert.throws(() => applyClaudeWording(draft, { message: "Here it is", productIds: ["INVENTED"], suggestions: [] }), /UNGROUNDED/);
  assert.throws(() => applyClaudeWording(draft, { message: "Here it is", productIds: ["P1"], suggestions: ["Buy now"] }), /UNSUPPORTED_ACTION/);
});

test("candidate filtering preserves trusted fields and clears stale numbered buttons", () => {
  const kept = applyClaudeWording(draft, { message: "This could work.", productIds: ["P1"], suggestions: ["1"] });
  assert.equal(kept.products[0], product);
  const removed = applyClaudeWording(draft, { message: "What size do you need?", productIds: [], suggestions: ["1"] });
  assert.deepEqual(removed.products, []);
  assert.deepEqual(removed.suggestions, []);
  assert.equal(removed.stage, "clarify");
});

test("selected product and quantity actions cannot be changed by wording", () => {
  const selected = { ...draft, selectedProduct: product, stage: "quantity" as const, suggestions: ["12", "24"] };
  const reply = applyClaudeWording(selected, { message: "How many do you need?", productIds: [], suggestions: ["24"] });
  assert.equal(reply.selectedProduct, product);
  assert.deepEqual(reply.products, selected.products);
  assert.equal(reply.stage, "quantity");
  assert.deepEqual(reply.suggestions, ["24"]);
});

test("wording cannot offer to check stock before the product has been selected", () => {
  const message = "This is the match I found; want me to check live stock on it before adding to your enquiry?";
  assert.match(replyStyleIssues({ ...draft, message }).join(" "), /choose a product card first/);
  assert.match(replyStyleIssues({ ...draft, message: "It's in stock. Want me to pull it up for you to select?" }).join(" "), /cards are already visible/);
  assert.deepEqual(replyStyleIssues({ ...draft, message: "This matches your cartridge request. Select it below to continue." }), []);
  assert.deepEqual(replyStyleIssues({ ...draft, selectedProduct: product, message }), []);
});

test("plural wording cannot bundle different missing attributes in one question", () => {
  const reply = { ...draft, products: [], message: "Would a smaller size work, or should I look at other shapes/colours?" };
  assert.match(replyStyleIssues(reply).join(" "), /one missing attribute/);
});

test("unsupported sales handoff claims are removed", () => {
  const reply = applyClaudeWording(draft, { message: "I have notified our sales team.", productIds: [], suggestions: [] });
  assert.doesNotMatch(reply.message, /I have notified/);
  assert.match(reply.message, /No staff member has been notified/);
});

test("calls Anthropic Messages with structured output and keeps the key out of the body", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(options.headers).get("x-api-key"), "test-secret");
    assert.doesNotMatch(String(options.body), /test-secret/);
    const body = JSON.parse(String(options.body));
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.thinking.type, "adaptive");
    assert.equal(body.model, "claude-sonnet-5");
    assert.equal(new Headers(options.headers).get("anthropic-version"), "2023-06-01");
    assert.equal(body.output_config.effort, "low");
    assert.equal(body.max_tokens, 2048);
    assert.match(body.system[0].text, /One focused question/);
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ message: "What size would suit your café?", productIds: [], suggestions: [] }) }] });
  });
  const reply = await composeClaudeReply(input, draft);
  assert.equal(reply.message, "What size would suit your café?");
});

test("missing Claude key fails before any request; no old-provider fallback", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (original !== undefined) process.env.ANTHROPIC_API_KEY = original; });
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not call network"); });
  await assert.rejects(composeClaudeReply(input, draft), /CLAUDE_NOT_CONFIGURED/);
});

test("a reply referring to invisible cards receives one repair without changing chosen products", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls += 1;
    if (calls === 2) assert.match(String(options.body), /no visible product cards/);
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
      message: calls === 1 ? "Those two are actually smaller. Would that work?" : "I found only smaller plates. Would a smaller size work?",
      productIds: [], suggestions: [],
    }) }] });
  });
  const reply = await composeClaudeReply(input, draft);
  assert.equal(calls, 2);
  assert.deepEqual(reply.products, []);
  assert.equal(reply.message, "I found only smaller plates. Would a smaller size work?");
});

test("vision sends pixels without trusting a SKU-like filename", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    assert.doesNotMatch(String(options.body), /FAKE-SKU/);
    assert.equal(body.messages.at(-1).content[0].source.data, "aGVsbG8=");
    assert.equal(body.messages.length, 1);
    assert.ok(body.output_config.format.schema.required.includes("imageCategory"));
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ message: "IMAGE_KIND=PRODUCT\nA round plate with an unreadable brand", imageCategory: "plate", productIds: [], suggestions: [] }) }] });
  });
  const reply = await inspectImageWithClaude({ ...input, history: [{role:"user",content:"The previous item was a knife"}], image: { name: "FAKE-SKU.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" } });
  assert.deepEqual(reply.products, []);
  assert.equal(reply.imageCategory, "plate");
});

test("provider failures do not expose error bodies or silently use another provider", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("private provider details", { status: 429 }));
  await assert.rejects(composeClaudeReply(input, draft), /^Error: CLAUDE_HTTP_429$/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("a dropped connection gets one retry without switching providers", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  let calls = 0;
  let deadline: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls += 1;
    if (calls === 1) { deadline = options.signal; throw new TypeError("fetch failed"); }
    assert.equal(options.signal, deadline);
    return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ message: "What size would suit you?", productIds: [], suggestions: [] }) }] });
  });
  const reply = await composeClaudeReply(input, draft);
  assert.equal(calls, 2);
  assert.equal(reply.message, "What size would suit you?");
});

test("incomplete, refused and malformed outputs fail safely while retaining billed usage", async t => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-secret";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  const payloads = [
    { stop_reason: "max_tokens", content: [] },
    { stop_reason: "refusal", content: [{ type: "text", text: "private" }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "private invalid JSON" }] },
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...payloads[calls++], usage: { input_tokens: 1000, output_tokens: 100 } }));
  for (const code of ["INCOMPLETE_REPLY", "REFUSED_REPLY", "INVALID_REPLY"]) {
    const response = await withModelUsage(async () => {
      await assert.rejects(composeClaudeReply(input, draft), new RegExp(`^Error: CLAUDE_${code}$`));
      return Response.json({ fallback: true });
    });
    const usage = JSON.parse(response.headers.get("x-ai-usage")!);
    assert.equal(usage.measuredCalls, 1);
    assert.equal(usage.complete, true);
    assert.equal(usage.estimatedUsd, 0.003);
  }
  assert.equal(calls, 3);
});
