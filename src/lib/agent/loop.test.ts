// src/lib/agent/loop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRequest } from "./contract";
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

test("customer texts exclude taps and include the current message", () => {
  const texts = recentCustomerTexts(request({
    event: { type: "text", text: "3 please" },
    history: [{ role: "user", content: "blow torch" }, { role: "user", content: "[tap] Picked: TORCH L15.6xW5.8xH5cm (code BTS-8026D)" }],
  }));
  assert.deepEqual(texts, ["3 please", "blow torch"]);
});
