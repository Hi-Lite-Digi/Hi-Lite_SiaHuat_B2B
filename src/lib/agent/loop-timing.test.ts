// src/lib/agent/loop-timing.test.ts
// The turn's time management, with slow and hung calls and lookups (owner's chat, 2026-09-30: "prata pan maybe" got the backup
// reply after a 10 s first call). Times are the real ones scaled 1:25 (S ms per real second): turn 45 s, reserve 10 s, backup reply
// alone 4 s, last call 12 s, so lookups stop at 35 s and the answer call may run to 41 s. Every decision boundary has at least 1.5
// scaled s (60 ms) of margin, except where timer slack can only push the result the safe way.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { cardsNote, type AgentRequest } from "./contract";
import { runAgentTurn, type AgentClient } from "./loop";
import { fakeDeps, fakePickCheck, product } from "./testing";

const S = 40;
const TIMES = { deadlineMs: 45 * S, fallbackReserveMs: 10 * S, standInMs: 4 * S, lastCallMs: 12 * S };
const HANG = Infinity;

const griddle = product({ stock_id: "PA10313", name: "ELECTRIC GRIDDLE", list_price: 389.91 });
const crepe = product({ stock_id: "CREPE-24", name: "CREPE PAN 24CM", list_price: 48.81 });
const blowtorch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S", list_price: 31.31 });

const usage = { input_tokens: 10, output_tokens: 5 };
const toolUse = (...calls: Array<{ id: string; name: string; input: unknown }>) => ({
  id: "msg_tools", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "tool_use", stop_sequence: null, usage,
  content: calls.map((call) => ({ type: "tool_use", ...call })),
}) as unknown as Anthropic.Message;
const answer = (value: { message: string; card_ids?: string[] }) => ({
  id: "msg_final", type: "message", role: "assistant", model: "claude-sonnet-5", stop_reason: "end_turn", stop_sequence: null, usage,
  content: [{ type: "text", text: JSON.stringify({ card_ids: [], chips: [], show_contact: false, ...value }) }],
}) as unknown as Anthropic.Message;
type Body = Anthropic.MessageCreateParamsNonStreaming;
const toolChoice = (body: Body) => (body.tool_choice as { type: string }).type;
/** Like the real API: a call at tool_choice "none" can only answer. */
const either = (tools: Anthropic.Message, final: Anthropic.Message) => (body: Body) => (toolChoice(body) === "none" ? final : tools);

type Step = { ms: number; reply: Anthropic.Message | Error | ((body: Body) => Anthropic.Message) };
/** A Claude client whose nth call takes steps[n].ms (HANG: never answers) and honours the abort signal, as the SDK does. */
function timedClient(steps: Step[]) {
  const bodies: Body[] = [];
  const client: AgentClient = {
    messages: {
      create(body, options) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        const step = steps.shift();
        if (!step) return Promise.reject(new Error("NO_MORE_RESPONSES"));
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("This operation was aborted", "AbortError"));
          };
          if (step.ms !== HANG) {
            timer = setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              const reply = typeof step.reply === "function" ? step.reply(body) : step.reply;
              if (reply instanceof Error) reject(reply);
              else resolve(reply);
            }, step.ms);
          }
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
  };
  return { client, bodies };
}

/** Catalogue fakes whose nth search waits searchMs[n] (HANG: never answers). */
function slowSearches(searchMs: number[]) {
  const deps = fakeDeps([griddle, crepe, blowtorch]);
  const search = deps.searchDirect;
  let n = 0;
  deps.searchDirect = (query, limit) => {
    const ms = searchMs[n++] ?? 0;
    return ms === HANG ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(resolve, ms)).then(() => search(query, limit));
  };
  return deps;
}

/** The owner's two messages (2026-09-30). */
const prata = (): AgentRequest => ({
  sessionId: "session-prata01", event: { type: "text", text: "prata pan maybe" }, enquiry: [], shownProductIds: [],
  history: [
    { role: "user", content: "do you sell roti prata" },
    { role: "assistant", content: "We're a kitchen and F&B equipment supplier, so we don't sell roti prata itself. Are you after a prata pan or griddle?" },
  ],
});
const search = (id: string, query: string) => ({ id, name: "search_catalogue", input: { queries: [query] } });
const GOOD = answer({ message: "A flat griddle works well for prata. Is it for home or for a shop?", card_ids: ["PA10313"] });

/** Silences the turn's logs and keeps them for the asserts. */
function quiet(t: TestContext) {
  const info = t.mock.method(console, "info", () => undefined);
  const warn = t.mock.method(console, "warn", () => undefined);
  // AbortSignal.timeout timers don't keep node running: a turn waiting only on them would end the test early.
  const alive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(alive));
  const lines = (calls: Array<{ arguments: unknown[] }>, label: string) => calls.filter((call) => call.arguments[0] === label).map((call) => call.arguments[1] as Record<string, unknown>);
  return { turnLog: () => lines(info.mock.calls, "[api/agent] turn"), fallbacks: () => lines(warn.mock.calls, "[api/agent] fallback reply") };
}

// The first turn in a process takes about 300 ms (about 7 scaled s) to load; the timed tests run after it.
test.before(async () => {
  const { client } = timedClient([{ ms: 0, reply: toolUse(search("w1", "griddle")) }, { ms: 0, reply: GOOD }]);
  const log = console.info;
  console.info = () => undefined;
  await runAgentTurn({ request: prata(), deps: slowSearches([]), client, model: "claude-sonnet-5" }).finally(() => { console.info = log; });
});

test("a slow last search still leaves the answer call its time", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([
    { ms: 2 * S, reply: toolUse(search("t1", "griddle")) },
    { ms: 2 * S, reply: either(toolUse(search("t2", "crepe pan")), GOOD) },
    { ms: 2 * S, reply: either(toolUse(search("t3", "pan")), GOOD) },
    { ms: 6 * S, reply: GOOD },
  ]);
  // The third search ends at about 30 s (31.5 s with timer drift, which is about 0.2 s a timer on Windows); the forced answer lands
  // at about 36 s, past the 35 s work deadline.
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([6 * S, 6 * S, 12 * S]), client, model: "claude-sonnet-5", ...TIMES });
  assert.equal(reply.provider, "anthropic", JSON.stringify(log.fallbacks()));
  assert.equal(toolChoice(bodies.at(-1)!), "none");
});

test("a made-up card in an answer that lands at 32.5 s still gets its repair", async (t) => {
  const log = quiet(t);
  // The first answer lands at about 33 s with start-up and timer drift; the repair ends at about 37 s.
  const { client } = timedClient([
    { ms: 32.5 * S, reply: answer({ message: "Try this one.", card_ids: ["FAKE-1"] }) },
    { ms: 4 * S, reply: answer({ message: "Is the pan for home or for a shop?" }) },
  ]);
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([]), client, model: "claude-sonnet-5", ...TIMES });
  assert.equal(reply.provider, "anthropic", JSON.stringify(log.fallbacks()));
  assert.equal(reply.message, "Is the pan for home or for a shop?");
});

test("when the first call hangs, the backup reply still comes within the turn's time", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([{ ms: HANG, reply: GOOD }, { ms: HANG, reply: GOOD }]);
  const started = performance.now();
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([]), client, model: "claude-sonnet-5", ...TIMES });
  const took = (performance.now() - started) / S;
  assert.equal(reply.provider, "fallback");
  assert.ok(took <= 45.5, `took ${took.toFixed(1)} s`);
  assert.ok(bodies.length <= 2);
  assert.deepEqual(log.fallbacks().map((line) => line.reason), ["AGENT_DEADLINE"]);
});

test("when the forced answer hangs, the backup reply still comes within the turn's time", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([{ ms: 12.5 * S, reply: toolUse(search("t1", "griddle")) }, { ms: HANG, reply: GOOD }]);
  const started = performance.now();
  // The forced answer may run to 41 s; the backup reply then has the last 4 s.
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([1.5 * S]), client, model: "claude-sonnet-5", ...TIMES });
  const took = (performance.now() - started) / S;
  assert.equal(reply.provider, "fallback");
  assert.deepEqual(bodies.map(toolChoice), ["auto", "none"]);
  assert.ok(took <= 45.5, `took ${took.toFixed(1)} s`);
  assert.deepEqual(log.fallbacks().map((line) => line.reason), ["AGENT_DEADLINE"]);
});

test("an API error in the forced answer after 35 s logs its status, not AGENT_DEADLINE", async (t) => {
  const log = quiet(t);
  const overloaded = Object.assign(new Error("Overloaded"), { status: 529 });
  const { client } = timedClient([{ ms: 12.5 * S, reply: toolUse(search("t1", "griddle")) }, { ms: 22 * S, reply: overloaded }]);
  // The forced answer fails at about 36.5 s, inside the time it may run to.
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([1.5 * S]), client, model: "claude-sonnet-5", ...TIMES });
  assert.equal(reply.provider, "fallback");
  assert.deepEqual(log.fallbacks().map((line) => line.reason), ["API_529"]);
});

test("the prata timeline: a 10 s and an 11 s call end in the answer, not the backup reply", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([
    { ms: 9.7 * S, reply: toolUse(search("t1", "griddle")) },
    { ms: 11.2 * S, reply: either(toolUse(search("t2", "crepe pan")), GOOD) },
    { ms: 12 * S, reply: either(toolUse(search("t3", "pan")), GOOD) },
  ]);
  const started = performance.now();
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([1.5 * S, 1.5 * S]), client, model: "claude-sonnet-5", ...TIMES });
  const took = (performance.now() - started) / S;
  assert.equal(reply.provider, "anthropic", JSON.stringify(log.fallbacks()));
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["PA10313"]);
  // At the second call 23.8 s are left, and another round at this turn's speed needs 2.5 x 9.7 + 1.5 = 25.75 s: it answers.
  assert.deepEqual(bodies.map(toolChoice), ["auto", "none"]);
  assert.ok(took < 42, `took ${took.toFixed(1)} s`);
});

test("after a 12.5 s first call and a tool round, the next call answers", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([
    { ms: 12.5 * S, reply: toolUse(search("t1", "griddle")) },
    { ms: 12.5 * S, reply: either(toolUse(search("t2", "crepe pan")), GOOD) },
    { ms: 12.5 * S, reply: either(toolUse(search("t3", "pan")), GOOD) },
  ]);
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([1.5 * S]), client, model: "claude-sonnet-5", ...TIMES });
  assert.equal(reply.provider, "anthropic", JSON.stringify(log.fallbacks()));
  // 21 s are left, and another round and an answer at this turn's speed need 32.75 s.
  assert.deepEqual(bodies.map(toolChoice), ["auto", "none"]);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /tool_result.*Time is nearly up/);
  assert.deepEqual(log.turnLog().map((line) => line.forcedEarly), [true]);
});

test("at normal speeds the next call may still use tools, as before", async (t) => {
  const log = quiet(t);
  const { client, bodies } = timedClient([
    { ms: 3 * S, reply: toolUse(search("t1", "griddle")) },
    { ms: 3 * S, reply: either(toolUse(search("t2", "crepe pan")), GOOD) },
    { ms: 3 * S, reply: either(toolUse(search("t3", "pan")), GOOD) },
    { ms: 3 * S, reply: GOOD },
  ]);
  // A 26.5 s work budget: the third call starts with about 16.5 s left, and 3 s calls and 2 s rounds need lastCallMs's 12 s.
  const reply = await runAgentTurn({ request: prata(), deps: slowSearches([2 * S, 2 * S, 2 * S]), client, model: "claude-sonnet-5", ...TIMES, deadlineMs: 36.5 * S });
  assert.equal(reply.provider, "anthropic", JSON.stringify(log.fallbacks()));
  assert.deepEqual(bodies.map(toolChoice), ["auto", "auto", "auto", "none"]);
});

// Real time scale (about 8 s): the nudge's 15 s minimum isn't an input, so a scaled test can't reach it.
test("no claim nudge when a nudged round wouldn't fit at this turn's speed", async (t) => {
  quiet(t);
  const request: AgentRequest = {
    sessionId: "session-nudge01", event: { type: "text", text: "ok 2 of the crepe pan" }, enquiry: [], shownProductIds: ["CREPE-24"],
    history: [{ role: "user", content: "crepe pan got?" }, { role: "assistant", content: `Yes, the 24cm crepe pan.${cardsNote([crepe])}` }],
  };
  const { client, bodies } = timedClient([
    { ms: 7_000, reply: answer({ message: "Got it: 2 CREPE PAN 24CM added. Anything else?", card_ids: ["CREPE-24"] }) },
    { ms: 300, reply: answer({ message: "How many of the crepe pan do you need?" }) },
  ]);
  // 16 s of work time are left after the first call: more than the nudge's 15 s, less than the 17.5 s a nudged round needs at 7 s a call.
  const reply = await runAgentTurn({ request, deps: slowSearches([]), client, model: "claude-sonnet-5", deadlineMs: 33_000, pickCheck: () => fakePickCheck() });
  assert.equal(reply.provider, "anthropic");
  assert.ok(bodies.every((body) => !JSON.stringify(body.messages.at(-1)).includes("Call update_enquiry")));
  assert.equal(bodies.length, 2);
  assert.equal(toolChoice(bodies[1]), "none"); // the repair
  assert.doesNotMatch(reply.message, /added/i);
});
