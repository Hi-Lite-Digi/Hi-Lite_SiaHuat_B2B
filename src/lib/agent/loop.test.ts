// src/lib/agent/loop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import type { AgentRequest } from "./contract";
import { verifyEnquiry } from "./enquiry";
import { MAX_TOOL_ROUNDS, recentCustomerTexts, runAgentTurn, type AgentClient } from "./loop";
import { fakeDeps, product } from "./testing";

const blowtorch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31 });
const safico = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", list_price: 23.36 });
const deps = () => fakeDeps([blowtorch, safico]);

const usage = { input_tokens: 10, output_tokens: 5 };
const toolCall = (id: string, name: string, input: unknown) => ({
  id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "tool_use", stop_sequence: null, usage,
  content: [{ type: "tool_use", id, name, input }],
}) as unknown as Anthropic.Message;
const answer = (value: { message: string; card_ids?: string[]; chips?: string[]; show_contact?: boolean }) => ({
  id: "msg_final", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn", stop_sequence: null, usage,
  content: [{ type: "text", text: JSON.stringify({ card_ids: [], chips: [], show_contact: false, ...value }) }],
}) as unknown as Anthropic.Message;

function fakeClient(responses: Array<Anthropic.Message | Error>) {
  const bodies: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AgentClient = {
    messages: {
      async create(body) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        const next = responses.shift();
        if (!next) throw new Error("NO_MORE_RESPONSES");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, bodies };
}

const request = (overrides: Partial<AgentRequest>): AgentRequest => ({
  sessionId: "session-1234", event: { type: "text", text: "blow torch" }, history: [], enquiry: [], shownProductIds: [], ...overrides,
});

test("Claude searches with the customer's words and recommends a grounded card", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "This one is a handheld kitchen blow torch.", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  const second = bodies[1].messages.at(-1)!;
  assert.match(JSON.stringify(second.content), /tool_result/);
});

test("a tapped card plus an earlier typed quantity is added straight away", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "Got it: 2 blow torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "select_product", stockId: "970S" }, history: [{ role: "user", content: "I need 2 blow torches" }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2]]);
});

test("a tap is never a quantity: the enquiry tool refuses and Claire asks", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "Good choice. How many do you need?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "select_product", stockId: "970S" }, history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: "Two options.\n[cards shown: 970S; BTS-8026D]" }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /QTY_NOT_STATED/);
});

test("a made-up card is sent back for one repair", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Try this.", card_ids: ["FAKE-1"] }),
    answer({ message: "What will you use it for?", chips: ["Cooking", "Desserts"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards, []);
  assert.equal((bodies[1].tool_choice as { type: string }).type, "none");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /not found: FAKE-1/);
});

test("an unverified amount that survives the repair is removed", async () => {
  const { client } = fakeClient([
    answer({ message: "That one is $99.", chips: ["Yes, $99 one", "Show others"] }),
    answer({ message: "That one is $99.", chips: ["Yes, $99 one", "Show others"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.doesNotMatch(reply.message, /\$99/);
  assert.deepEqual(reply.chips, ["Show others"]);
});

test("a made-up card that survives the repair gets the backup reply", async () => {
  const { client } = fakeClient([
    answer({ message: "Try this.", card_ids: ["FAKE-1"] }),
    answer({ message: "Try this.", card_ids: ["FAKE-1"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "fallback");
  assert.ok(!reply.cards.some((card) => card.stock_id === "FAKE-1"));
});

test("a style problem that survives the repair is tidied and sent, not replaced by the backup reply", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Noted: 2 torches." }),
    answer({ message: "Noted: 2 torches." }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Got it: 2 torches.");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /plain, friendly customer language/);
});

test("a cut-off reply is sent back for one repair", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "We don't carry a boxed" }),
    answer({ message: "We don't sell boxed dining sets, only single pieces." }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  assert.equal((bodies[1].tool_choice as { type: string }).type, "none");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /stops mid-sentence/);
  assert.equal(reply.message, "We don't sell boxed dining sets, only single pieces.");
});

test("a cut-off that survives the repair loses only its unfinished sentence", async () => {
  const { client } = fakeClient([answer({ message: "Sure. We don't carry a boxed" }), answer({ message: "Sure. We don't carry a boxed" })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Sure.");
});

test("a made-up card next to a style problem still gets the backup reply after the repair", async () => {
  const { client } = fakeClient([
    answer({ message: "Noted. Try this.", card_ids: ["FAKE-1"] }),
    answer({ message: "Noted. Try this.", card_ids: ["FAKE-1"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "fallback");
});

test("chips with numbers are dropped without a repair call", async () => {
  const { client, bodies } = fakeClient([answer({ message: "What will you use it for?", chips: ["2", "Cooking"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.chips, ["Cooking"]);
  assert.equal(bodies.length, 1);
});

test("an empty message with a valid card is sent with a default line", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: " ", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Here are some options.");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.equal(bodies.length, 2);
});

const rawAnswer = (text: string) => ({ ...answer({ message: "unused" }), content: [{ type: "text", text }] }) as unknown as Anthropic.Message;

test("an answer that is not valid JSON gets one repair round, then the backup reply", async () => {
  const repaired = fakeClient([rawAnswer("Sure, here you go"), answer({ message: "What will you use it for?" })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client: repaired.client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "What will you use it for?");
  assert.match(JSON.stringify(repaired.bodies[1].messages.at(-1)), /valid JSON/);
  assert.equal((repaired.bodies[1].tool_choice as { type: string }).type, "none");

  const broken = fakeClient([rawAnswer("{\"message\": \"\"}"), rawAnswer("{\"message\": \"\", \"card_ids\": [], \"chips\": [], \"show_contact\": false}")]);
  const fallback = await runAgentTurn({ request: request({}), deps: deps(), client: broken.client, model: "claude-sonnet-5" });
  assert.equal(fallback.provider, "fallback");
  assert.equal(broken.bodies.length, 2);
});

test("the history's card notes and previous message feed the repetition checks", async () => {
  const shown = { role: "assistant" as const, content: "This one fits.\n[cards shown: 970S KITCHEN BLOW TORCH 970S]" };
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "This one fits.", card_ids: ["970S"] }),
    answer({ message: "That's the only blow torch in stock. Want a gas torch instead?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "any other?" }, history: [{ role: "user", content: "blow torch" }, shown, { role: "user", content: "hmm" }, shown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  const repair = JSON.stringify(bodies[2].messages.at(-1));
  assert.match(repair, /already shown these same cards twice/);
  assert.match(repair, /Don't repeat your previous message word for word/);
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards, []);
});

test("a staff claim is removed and the reply shows the sales contact", async () => {
  const { client } = fakeClient([answer({ message: "I've notified our sales team." })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.doesNotMatch(reply.message, /notified/);
  assert.notEqual(reply.message.trim(), "");
  assert.equal(reply.showContact, true);
});

test("after the tool-round cap Claude must answer without tools", async () => {
  const calls = Array.from({ length: MAX_TOOL_ROUNDS }, (_, index) => toolCall(`t${index}`, "search_catalogue", { queries: ["torch"] }));
  const { client, bodies } = fakeClient([...calls, answer({ message: "Here are the torches." })]);
  await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal((bodies[MAX_TOOL_ROUNDS].tool_choice as { type: string }).type, "none");
});

test("a Claude outage returns the backup reply", async () => {
  const { client } = fakeClient([new Error("overloaded")]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "fallback");
  assert.equal(reply.showContact, true);
  assert.ok(reply.cards.some((card) => card.stock_id === "970S"));
});

test("the backup-reply log carries only a reason code, never error text", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const outage = fakeClient([new Error("customer wrote: blow torch for my shop")]);
  await runAgentTurn({ request: request({}), deps: deps(), client: outage.client, model: "claude-sonnet-5" });
  const cutOff = fakeClient([{ ...answer({ message: "Here" }), stop_reason: "max_tokens" } as Anthropic.Message]);
  await runAgentTurn({ request: request({}), deps: deps(), client: cutOff.client, model: "claude-sonnet-5" });
  const rejected = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: rejected.client, model: "claude-sonnet-5" });
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments[1]), [
    { reason: "Error" }, { reason: "AGENT_STOP_MAX_TOKENS" }, { reason: "AGENT_REPLY_REJECTED" },
  ]);
});

const CLAUDE_IMAGE_LIMIT = 5 * 1024 * 1024; // the API measures the base64 text
const photoRequest = (bytes: Buffer) => request({
  event: { type: "image", image: { dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`, mimeType: "image/jpeg", name: "photo.jpg" } },
});
const sentBlocks = (body: Anthropic.MessageCreateParamsNonStreaming) => body.messages[0].content as Anthropic.ContentBlockParam[];

test("a large phone photo is shrunk below Claude's image limit and cached across rounds", async () => {
  const photo = await sharp({ create: { width: 2600, height: 1950, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg({ quality: 95 }).toBuffer();
  assert.ok(photo.toString("base64").length > CLAUDE_IMAGE_LIMIT && photo.length < 5_000_000);
  const { client, bodies } = fakeClient([
    toolCall("t1", "match_photo", {}),
    answer({ message: "What is this used for?" }),
  ]);
  const reply = await runAgentTurn({ request: photoRequest(photo), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  const image = sentBlocks(bodies[0]).find((block) => block.type === "image") as Anthropic.ImageBlockParam;
  assert.ok((image.source as Anthropic.Base64ImageSource).data.length <= CLAUDE_IMAGE_LIMIT);
  assert.deepEqual(image.cache_control, { type: "ephemeral" });
});

test("a photo that cannot be opened is not sent to Claude, which asks for another", async () => {
  const { client, bodies } = fakeClient([answer({ message: "Could you send a smaller photo?" })]);
  const reply = await runAgentTurn({ request: photoRequest(Buffer.alloc(5_100_000)), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.ok(!sentBlocks(bodies[0]).some((block) => block.type === "image"));
  assert.match(JSON.stringify(sentBlocks(bodies[0])), /could not be opened/);
});

function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A Claude call that never answers until its signal aborts. */
const hangingClient: AgentClient = {
  messages: {
    create: (_body, options) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (options?.signal?.aborted) return abort();
      options?.signal?.addEventListener("abort", abort, { once: true });
    }),
  },
};

test("a Claude call that never answers still leaves time for the backup reply", async () => {
  const turn = runAgentTurn({ request: request({}), deps: deps(), client: hangingClient, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500 });
  const reply = await within(turn, 2_500);
  assert.equal(reply.provider, "fallback");
});

test("a tool that never answers still leaves time for the backup reply", async () => {
  const stuck = deps();
  stuck.searchDirect = () => new Promise(() => undefined);
  const { client } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["blow torch"] })]);
  const turn = runAgentTurn({ request: request({}), deps: stuck, client, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500 });
  const reply = await within(turn, 2_500);
  assert.equal(reply.provider, "fallback");
  assert.deepEqual(reply.cards, []);
});

test("a slow catalogue lookup cannot hold up enquiry re-verification", async () => {
  const slow = deps();
  slow.findByCode = (stockId) => new Promise((resolve) => setTimeout(() => resolve(stockId === "970S" ? blowtorch : null), 2_000));
  const started = performance.now();
  const result = await verifyEnquiry([{ stockId: "970S", quantity: 2 }], slow, 300);
  assert.ok(performance.now() - started < 700, "re-verification waited for the slow lookup");
  assert.equal(result.notes.length, 1);
  assert.deepEqual(result.unchecked, ["970S"]);
});

test("a turn that starts with little time left still keeps the customer's enquiry", async () => {
  const slow = deps();
  slow.findByCode = (stockId) => new Promise((resolve) => setTimeout(() => resolve(stockId === "970S" ? blowtorch : null), 50));
  const reply = await within(runAgentTurn({
    request: request({ enquiry: [{ stockId: "970S", quantity: 2 }] }), deps: slow, client: hangingClient, model: "claude-sonnet-5", deadlineMs: 10,
  }), 2_500);
  assert.equal(reply.provider, "fallback");
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2]]);
});

test("a line whose lookup times out is left for the browser to keep, and Claude is told", async () => {
  const stuck = deps();
  stuck.findByCode = (stockId) => stockId === "970S" ? new Promise(() => undefined) : Promise.resolve(safico);
  const { client, bodies } = fakeClient([answer({ message: "What else do you need?" })]);
  const reply = await within(runAgentTurn({
    request: request({ enquiry: [{ stockId: "970S", quantity: 2 }, { stockId: "BTS-8026D", quantity: 1 }] }),
    deps: stuck, client, model: "claude-sonnet-5", deadlineMs: 13_000,
  }), 2_500);
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.enquiry.lines.map((line) => line.code), ["BTS-8026D"]);
  assert.deepEqual(reply.enquiry.unchecked, ["970S"]);
  assert.match(JSON.stringify(bodies[0].messages.at(-1)), /970S could not be checked just now; it stays on the enquiry/);
});

test("while a line is unchecked, the context tells Claude not to quote a total or item count", async () => {
  const stuck = deps();
  stuck.findByCode = (stockId) => stockId === "970S" ? new Promise(() => undefined) : Promise.resolve(safico);
  const { client, bodies } = fakeClient([answer({ message: "What else do you need?" })]);
  await within(runAgentTurn({
    request: request({ enquiry: [{ stockId: "970S", quantity: 2 }, { stockId: "BTS-8026D", quantity: 1 }] }),
    deps: stuck, client, model: "claude-sonnet-5", deadlineMs: 13_000,
  }), 2_500);
  const context = JSON.stringify(bodies[0].messages.at(-1));
  assert.match(context, /Unchecked lines \(kept by the customer, not in these lines or totals\): 970S\./);
  assert.match(context, /Don't quote an enquiry total or item count/);

  const checked = fakeClient([answer({ message: "What else do you need?" })]);
  await runAgentTurn({ request: request({ enquiry: [{ stockId: "BTS-8026D", quantity: 1 }] }), deps: deps(), client: checked.client, model: "claude-sonnet-5" });
  assert.doesNotMatch(JSON.stringify(checked.bodies[0].messages.at(-1)), /Unchecked lines/);
});

test("a chip can ask to clear the enquiry", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "clear" }),
    answer({ message: "Done, your enquiry is empty now. What are you looking for?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "Clear enquiry", chip: true }, enquiry: [{ stockId: "970S", quantity: 2 }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.doesNotMatch(JSON.stringify(bodies[1].messages.at(-1)), /CLEAR_NOT_REQUESTED/);
  assert.deepEqual(reply.enquiry.lines, []);
});

test("customer texts exclude chip taps, earlier and current", () => {
  const texts = recentCustomerTexts(request({
    event: { type: "text", text: "5 pcs", chip: true },
    history: [{ role: "user", content: "[chip] 10 pcs" }, { role: "user", content: "blow torch" }],
  }));
  assert.deepEqual(texts, ["blow torch"]);
});

test("a chip tap is never a quantity: the enquiry tool refuses", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 5 }),
    answer({ message: "Good choice. How many do you need?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "5 pcs", chip: true }, history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: "This one fits.\n[cards shown: 970S KITCHEN BLOW TORCH 970S]" }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /QTY_NOT_STATED/);
});

const twoCardsShown = { role: "assistant" as const, content: "Two options.\n[cards shown: 970S KITCHEN BLOW TORCH 970S; BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO]" };

test("with two cards shown, \"ok 2\" does not choose one: the enquiry tool refuses", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Which one would you like?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /PRODUCT_NOT_CHOSEN/);
});

test("only the previous reply's cards count: a single card there is the customer's choice", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "ok 2" },
      history: [{ role: "user", content: "torch" }, twoCardsShown, { role: "user", content: "the gas one" }, { role: "assistant", content: "This one runs on gas.\n[cards shown: BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO]" }],
    }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
});

test("customer texts exclude taps and include the current message", () => {
  const texts = recentCustomerTexts(request({
    event: { type: "text", text: "3 please" },
    history: [{ role: "user", content: "blow torch" }, { role: "user", content: "[tap] Picked: TORCH L15.6xW5.8xH5cm (code BTS-8026D)" }],
  }));
  assert.deepEqual(texts, ["3 please", "blow torch"]);
});
