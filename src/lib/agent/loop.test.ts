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
    answer({ message: "Noted. Which size do you need?" }),
    answer({ message: "Noted. Which size do you need?" }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Got it. Which size do you need?");
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

test("a style-only problem with little time left is tidied and sent without a repair call", async () => {
  const { client, bodies } = fakeClient([answer({ message: "Noted. Which size do you need?" })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 9_000, fallbackReserveMs: 5_000 });
  assert.equal(bodies.length, 1);
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Got it. Which size do you need?");
});

test("a style-only repair that fails sends the tidied first answer", async () => {
  const { client } = fakeClient([answer({ message: "Noted. Which size do you need?" }), new Error("overloaded")]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Got it. Which size do you need?");
});

test("a style-only answer whose repair brings a made-up card sends the tidied first answer", async () => {
  const { client } = fakeClient([answer({ message: "Noted. Which size do you need?" }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Got it. Which size do you need?");
  assert.deepEqual(reply.cards, []);
});

test("a made-up card whose repair fails still gets the backup reply", async () => {
  const { client } = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), new Error("overloaded")]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "fallback");
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

test("when time runs low, the next call answers with what was found", async () => {
  const slow = deps();
  const search = slow.searchDirect;
  slow.searchDirect = (query, limit) => new Promise((resolve) => setTimeout(resolve, 400)).then(() => search(query, limit));
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "This one is a handheld kitchen blow torch.", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: slow, client, model: "claude-sonnet-5", deadlineMs: 2_000, fallbackReserveMs: 500, lastCallMs: 1_300 });
  assert.equal(reply.provider, "anthropic");
  assert.equal((bodies[1].tool_choice as { type: string }).type, "none");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /tool_result.*Time is nearly up/);
});

test("the first call may always use tools", async () => {
  // 4.5 s of work time is already below the last-call margin, but nothing has been looked up yet.
  const { client, bodies } = fakeClient([answer({ message: "What will you use it for?" })]);
  await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 5_000, fallbackReserveMs: 500 });
  assert.equal((bodies[0].tool_choice as { type: string }).type, "auto");
});

test("every turn logs one line of codes and counts, never text", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const turnLogs = () => info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").map((call) => call.arguments[1] as Record<string, unknown>);
  const searched = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "This one is a handheld kitchen blow torch.", card_ids: ["970S"] }),
  ]);
  await runAgentTurn({ request: request({}), deps: deps(), client: searched.client, model: "claude-sonnet-5" });
  const repairedTurn = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), answer({ message: "What will you use it for?" })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: repairedTurn.client, model: "claude-sonnet-5" });
  const [first, second] = turnLogs();
  assert.equal(turnLogs().length, 2);
  assert.equal(typeof first.ms, "number");
  assert.deepEqual({ ...first, ms: 0 }, {
    ms: 0, rounds: 2, forcedEarly: false, repaired: false, repairCauses: [], repairSkipped: false, repairFailed: null, tools: ["search_catalogue"],
  });
  assert.deepEqual([second.rounds, second.repaired, second.repairCauses, second.tools], [1, true, ["UNKNOWN_CARD"], []]);
  assert.doesNotMatch(JSON.stringify(turnLogs()), /blow torch|FAKE-1|use it for/);
});

test("the turn log shows a repair skipped for time, or a failed repair replaced by the first answer", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const skipped = fakeClient([answer({ message: "Noted. Which size do you need?" })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: skipped.client, model: "claude-sonnet-5", deadlineMs: 9_000, fallbackReserveMs: 5_000 });
  const failed = fakeClient([answer({ message: "Noted. Which size do you need?" }), new Error("overloaded: blow torch")]);
  await runAgentTurn({ request: request({}), deps: deps(), client: failed.client, model: "claude-sonnet-5" });
  const rejected = fakeClient([answer({ message: "Noted. Which size do you need?" }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: rejected.client, model: "claude-sonnet-5" });
  const logs = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").map((call) => call.arguments[1] as Record<string, unknown>);
  assert.deepEqual(logs.map((log) => [log.repaired, log.repairCauses, log.repairSkipped, log.repairFailed]), [
    [false, ["STYLE"], true, null],
    [true, ["STYLE"], false, "Error"],
    [true, ["STYLE"], false, "AGENT_REPLY_REJECTED"],
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /blow torch|overloaded/);
});

test("a Claude outage returns the backup reply", async () => {
  const { client } = fakeClient([new Error("overloaded")]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "fallback");
  assert.equal(reply.showContact, true);
  assert.ok(reply.cards.some((card) => card.stock_id === "970S"));
});

test("the backup-reply log carries only a reason code and the time taken, never error text", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const outage = fakeClient([new Error("customer wrote: blow torch for my shop")]);
  await runAgentTurn({ request: request({}), deps: deps(), client: outage.client, model: "claude-sonnet-5" });
  const cutOff = fakeClient([{ ...answer({ message: "Here" }), stop_reason: "max_tokens" } as Anthropic.Message]);
  await runAgentTurn({ request: request({}), deps: deps(), client: cutOff.client, model: "claude-sonnet-5" });
  const rejected = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: rejected.client, model: "claude-sonnet-5" });
  const overloaded = fakeClient([Object.assign(new Error("Overloaded while reading: blow torch for my shop"), { status: 529 })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: overloaded.client, model: "claude-sonnet-5" });
  const logged = warn.mock.calls.map((call) => call.arguments[1] as { reason: string; ms: number });
  assert.deepEqual(logged.map((entry) => entry.reason), ["Error", "AGENT_STOP_MAX_TOKENS", "AGENT_REPLY_REJECTED", "API_529"]);
  assert.ok(logged.every((entry) => typeof entry.ms === "number" && Object.keys(entry).length === 2));
  assert.doesNotMatch(JSON.stringify(warn.mock.calls), /blow torch|customer wrote|Overloaded/);
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

test("a turn that runs out of time logs AGENT_DEADLINE", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  await within(runAgentTurn({ request: request({}), deps: deps(), client: hangingClient, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500 }), 2_500);
  assert.deepEqual(warn.mock.calls.map((call) => (call.arguments[1] as { reason: string }).reason), ["AGENT_DEADLINE"]);
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
    request: request({ event: { type: "text", text: "5 pcs", chip: true }, history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: "This one fits. How many do you need?\n[cards shown: 970S KITCHEN BLOW TORCH 970S]" }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /QTY_NOT_STATED/);
});

const twoCardsShown = { role: "assistant" as const, content: `Two options.\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <${blowtorch.source_url}>; BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO ($23.36) <${safico.source_url}>]` };

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

test("a yes to the only card in Claire's previous reply picks it", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "ok 2" },
      history: [{ role: "user", content: "torch" }, twoCardsShown, { role: "user", content: "the gas one" }, { role: "assistant", content: `This one runs on gas.\n[cards shown: BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO ($23.36) <${safico.source_url}>]` }],
    }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
});

test("the 3-in-1 in a request is not quantity 3", async () => {
  const blender = product({ stock_id: "MX130", name: "CORDLESS 3 IN 1 HAND BLENDER MX130", list_price: 62 });
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "MX130", quantity: 3 }),
    answer({ message: "How many do you need?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "ok add it" },
      history: [{ role: "user", content: "got cordless 3 in 1 blender whisk kind anot" }, { role: "assistant", content: `This one has a whisk.\n[cards shown: MX130 ${blender.name} ($62.00) <${blender.source_url}>]` }],
    }),
    deps: fakeDeps([blender]), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /QTY_NOT_STATED/);
});

test("a tap, then How many?, then a typed number adds the tapped product", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 4 }),
    answer({ message: "Got it: 4 Safico torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "4 can" },
      history: [
        { role: "user", content: "blow torch" }, twoCardsShown,
        { role: "user", content: "[tap] Picked: CASSETTE GAS TORCH BURNER SAFICO PRO (code BTS-8026D)" },
        { role: "assistant", content: "How many do you need?" },
      ],
    }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 4]]);
});

test("'only 1 of them' after a single card is refused", async () => {
  const mixer = product({ stock_id: "MX130", name: "Dynamic Mini Cordless Mixer 45x11cm, 10,00Rpm, 230V/220W, Capacity 4Ltr", list_price: 563.3 });
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "MX130", quantity: 1 }),
    answer({ message: "Which one do you mean?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "only 1 of them" },
      history: [
        { role: "user", content: "how about cordless 3-in-1 blender, whisk product" },
        { role: "assistant", content: `The Cuisinart is out of stock. The closest cordless option in stock is this mixer, though it's a mixer, not a blender.\n[cards shown: MX130 ${mixer.name} ($563.30) <${mixer.source_url}>]` },
      ],
    }),
    deps: fakeDeps([mixer]), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /PRODUCT_NOT_CHOSEN/);
});

const torchShown = { role: "assistant" as const, content: `This one fits.\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <${blowtorch.source_url}>]` };
const askedAgain = (text: string) => request({ event: { type: "text", text }, history: [{ role: "user", content: "blow torch" }, torchShown], shownProductIds: ["970S"] });

test("a card shown earlier can be attached again without a tool call", async () => {
  const lookups = deps();
  const { client, bodies } = fakeClient([answer({ message: "Here it is again - tap it to choose.", card_ids: ["970S"] })]);
  const reply = await runAgentTurn({ request: askedAgain("where the card? i tap"), deps: lookups, client, model: "claude-sonnet-5" });
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.equal(bodies.length, 1);
  assert.ok(lookups.calls.includes("code:970S") && lookups.calls.includes("live:970S"), lookups.calls.join(" "));
});

test("a re-shown card carries today's live price", async () => {
  const { client } = fakeClient([answer({ message: "Here it is again.", card_ids: ["970S"] })]);
  const reply = await runAgentTurn({ request: askedAgain("show me again"), deps: fakeDeps([blowtorch, safico], { "970S": { price_ex_gst: 12.34 } }), client, model: "claude-sonnet-5" });
  assert.equal(reply.cards[0].list_price, 12.34);
});

test("a repair that adds an earlier-shown card is accepted", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "No, these aren't sets." }),
    answer({ message: "No, this one isn't a set.", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: askedAgain("is it a set?"), deps: deps(), client, model: "claude-sonnet-5" });
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /no visible product cards/);
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

const strainer = product({ stock_id: "197-55", name: "CCK Stainless Steel Deep Noodle Strainer With Stainless Steel Handle 5.5in", list_price: 25.5 });
const strainerAsked = request({
  event: { type: "text", text: "how much ah" },
  history: [{ role: "user", content: "noodle strainer" }, { role: "assistant", content: `This one has a long handle.\n[cards shown: 197-55 STRAINER ($25.50) <${strainer.source_url}>]` }],
  shownProductIds: ["197-55"],
});

test("an earlier card's price quoted without a lookup is checked by code, not repaired", async () => {
  for (const message of ["197-55 is $25.50.", "The strainer is $25.50."]) {
    const lookups = fakeDeps([strainer]);
    const { client, bodies } = fakeClient([answer({ message })]);
    const reply = await runAgentTurn({ request: strainerAsked, deps: lookups, client, model: "claude-sonnet-5" });
    assert.equal(bodies.length, 1, message);
    assert.equal(reply.message, message);
    assert.ok(lookups.calls.includes("live:197-55"), message);
  }
  const moved = fakeClient([answer({ message: "197-55 is $25.50." }), answer({ message: "197-55 is $26.00 now." })]);
  const reply = await runAgentTurn({ request: strainerAsked, deps: fakeDeps([strainer], { "197-55": { price_ex_gst: 26 } }), client: moved.client, model: "claude-sonnet-5" });
  assert.equal(moved.bodies.length, 2);
  assert.match(JSON.stringify(moved.bodies[1].messages.at(-1)), /\$25\.50/);
  assert.equal(reply.message, "197-55 is $26.00 now.");
});

test("an earlier card whose lookup stalls is attached as unconfirmed within about 2 s", async () => {
  const stalled = deps();
  const fetchLive = stalled.fetchLive;
  stalled.fetchLive = (url, ms) => (url === blowtorch.source_url ? new Promise(() => undefined) : fetchLive(url, ms));
  const { client } = fakeClient([answer({ message: "Here it is again; its stock still needs checking.", card_ids: ["970S"] })]);
  const started = performance.now();
  const reply = await within(runAgentTurn({ request: askedAgain("show me again"), deps: stalled, client, model: "claude-sonnet-5" }), 4_000);
  assert.ok(performance.now() - started < 3_000);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["970S", "unknown"]]);
});

test("customer texts exclude taps and include the current message", () => {
  const texts = recentCustomerTexts(request({
    event: { type: "text", text: "3 please" },
    history: [{ role: "user", content: "blow torch" }, { role: "user", content: "[tap] Picked: TORCH L15.6xW5.8xH5cm (code BTS-8026D)" }],
  }));
  assert.deepEqual(texts, ["3 please", "blow torch"]);
});

const NUDGE = /Call update_enquiry only for exactly what the customer picked/;
const saficoShown = { role: "assistant" as const, content: `This one runs on gas.\n[cards shown: BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO ($23.36) <${safico.source_url}>]` };

test("a reply that says added without an update is sent back with tools, and the add then goes through", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Got it, adding 2 torches now." }),
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "ok" }, history: [{ role: "user", content: "torch 2 pcs" }, saficoShown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal((bodies[1].tool_choice as { type: string }).type, "auto");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /no update_enquiry call succeeded/);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
  assert.equal(reply.message, "Got it: 2 Safico torches. Anything else?");
});

test("a false add claim that survives the nudge and the repair is replaced", async () => {
  const claim = answer({ message: "Added: 2 torches. Anything else?" });
  const { client, bodies } = fakeClient([claim, claim, claim]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "2 torches" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 3);
  assert.equal(reply.provider, "anthropic");
  assert.doesNotMatch(reply.message, /added/i);
  assert.equal(reply.message, "That change isn't on your enquiry yet. Anything else?");
});

test("no nudge when little time is left: the repair runs instead", async () => {
  const { client, bodies } = fakeClient([answer({ message: "Added: 2 torches." }), answer({ message: "Which torch would you like?" })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "2 torches" } }), deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 24_000 });
  assert.equal(bodies.length, 2);
  assert.equal((bodies[1].tool_choice as { type: string }).type, "none");
  assert.ok(!bodies.some((body) => NUDGE.test(JSON.stringify(body.messages))));
  assert.equal(reply.message, "Which torch would you like?");
});

test("a 'Noted: 2 torches' claim with no update is replaced after the repair", async () => {
  const claim = answer({ message: "Noted: 2 torches." });
  const { client } = fakeClient([claim, claim, claim]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "That change isn't on your enquiry yet.");
});

test("a reply about what is already on the enquiry is sent without a nudge", async () => {
  const cases: Array<[string, string, AgentRequest["enquiry"]]> = [
    ["added alr?", "Yes, it's already added. Anything else?", [{ stockId: "970S", quantity: 2 }]],
    ["the 2 blow torch added already?", "Yes, both are in your enquiry.", [{ stockId: "970S", quantity: 2 }, { stockId: "BTS-8026D", quantity: 1 }]],
  ];
  for (const [text, message, enquiry] of cases) {
    const { client, bodies } = fakeClient([answer({ message })]);
    const reply = await runAgentTurn({ request: request({ event: { type: "text", text }, enquiry }), deps: deps(), client, model: "claude-sonnet-5" });
    assert.equal(bodies.length, 1, message);
    assert.equal(reply.message, message);
    assert.doesNotMatch(reply.message, /isn't on your enquiry/);
    assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), enquiry.map((item) => [item.stockId, item.quantity]));
  }
});

test("an 'Updated: 5' reply for a line already on the enquiry is nudged until update_enquiry runs", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Updated: 5 Safico torches now." }),
    toolCall("t1", "update_enquiry", { action: "set", stock_id: "BTS-8026D", quantity: 5 }),
    answer({ message: "Updated: 5 Safico torches now." }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "make it 5" }, enquiry: [{ stockId: "BTS-8026D", quantity: 2 }] }), deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), NUDGE);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 5]]);
  assert.equal(reply.message, "Updated: 5 Safico torches now.");
});

test("a comma list that claims an add which failed is repaired, then replaced", async () => {
  const claim = answer({ message: "Added: 2 Kitchen Blow Torch (970S), 2 Safico Torch Burner (BTS-8026D). Anything else?" });
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    toolCall("t2", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    claim, claim,
  ]);
  const shown = `Both fit.\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <${blowtorch.source_url}>; BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO ($23.36) <${safico.source_url}>]`;
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "2 of the 970S and 2 of the BTS-8026D" },
      history: [{ role: "user", content: "blow torch and safico torch" }, { role: "assistant", content: shown }],
      shownProductIds: ["970S", "BTS-8026D"],
    }),
    deps: fakeDeps([blowtorch, safico], { "BTS-8026D": "fail" }), client, model: "claude-sonnet-5",
  });
  assert.match(JSON.stringify(bodies[2].messages.at(-1)), /STOCK_UNVERIFIED/);
  assert.equal(bodies.length, 4);
  assert.match(JSON.stringify(bodies[3].messages.at(-1)), /The enquiry didn't change/);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2]]);
  assert.equal(reply.message, "That change isn't on your enquiry yet. Anything else?");
});

test("a true removal reply that names the item left is sent as it is", async () => {
  const message = "Removed - your enquiry now has just the 1 Safico torch burner, total $23.36. Anything else?";
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", { action: "remove", stock_id: "970S" }), answer({ message })]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "i never said i want the blow torch. remove it" }, enquiry: [{ stockId: "970S", quantity: 1 }, { stockId: "BTS-8026D", quantity: 1 }] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, message);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 1]]);
});

test("no nudge on the last round that may use tools: the repair runs instead", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["torch"] }),
    toolCall("t2", "search_catalogue", { queries: ["gas torch"] }),
    answer({ message: "Adding 2 torches now." }),
    answer({ message: "Which torch would you like?" }),
  ]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "2 torches" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.deepEqual(bodies.map((body) => (body.tool_choice as { type: string }).type), ["auto", "auto", "auto", "none"]);
  assert.ok(!bodies.some((body) => NUDGE.test(JSON.stringify(body.messages))));
  assert.equal(reply.message, "Which torch would you like?");
});

test("an earlier card's code lookup and live check share one time limit", async () => {
  const slow = deps();
  const findByCode = slow.findByCode;
  slow.findByCode = (code) => new Promise((resolve) => { setTimeout(() => resolve(findByCode(code)), 1_900); });
  slow.fetchLive = () => new Promise(() => undefined);
  const { client } = fakeClient([answer({ message: "Here it is again.", card_ids: ["970S"] })]);
  const started = performance.now();
  const reply = await within(runAgentTurn({ request: askedAgain("show me again"), deps: slow, client, model: "claude-sonnet-5" }), 5_000);
  assert.ok(performance.now() - started < 2_700, `${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["970S", "unknown"]]);
});

test("an earlier card already tried this turn is not looked up again after the repair", async () => {
  const stalled = deps();
  const fetchLive = stalled.fetchLive;
  stalled.fetchLive = (url, ms) => (url === blowtorch.source_url ? new Promise(() => undefined) : fetchLive(url, ms));
  const { client, bodies } = fakeClient([
    answer({ message: "Noted. Here it is again.", card_ids: ["970S"] }),
    answer({ message: "Here it is again.", card_ids: ["970S"] }),
  ]);
  const started = performance.now();
  const reply = await within(runAgentTurn({ request: askedAgain("show me again"), deps: stalled, client, model: "claude-sonnet-5" }), 6_000);
  assert.equal(bodies.length, 2);
  assert.ok(performance.now() - started < 3_000, `${Math.round(performance.now() - started)} ms`);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["970S", "unknown"]]);
});
