// src/lib/agent/loop.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { cardsNote, type AgentRequest } from "./contract";
import { verifyEnquiry } from "./enquiry";
import { searchSlots } from "./facts";
import { CLAIM_ISSUE_PREFIX, LINK_ISSUE_PREFIX, PRICE_HEDGE_PREFIX } from "./guards";
import { MAX_TOOL_ROUNDS, recentCustomerTexts, runAgentTurn, type AgentClient } from "./loop";
import { fakeDeps, fakePickCheck, product } from "./testing";
import { PICK_CHECK_PROMPT, type PickCheck } from "./verify";

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

type TurnInput = Parameters<typeof runAgentTurn>[0];
/** A turn whose pick check is a fake: a sure pick with the proposal's number, or (refusedTurn) "not picked". */
const checkedTurn = (input: TurnInput) => runAgentTurn({ pickCheck: () => fakePickCheck(), ...input });
const refusedTurn = (input: TurnInput) => runAgentTurn({ pickCheck: () => fakePickCheck({ verdict: "not_picked" }), ...input });

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

test("every Claude call asks for conversation caching", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "Try this.", card_ids: ["FAKE-1"] }),
    answer({ message: "This one is a handheld kitchen blow torch.", card_ids: ["970S"] }),
  ]);
  await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((body) => body.cache_control?.type === "ephemeral"));
  assert.ok(bodies.every((body) => (body.system as Anthropic.TextBlockParam[])[0].cache_control?.type === "ephemeral"));
});

test("a tapped card plus an earlier typed quantity is added straight away", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "Got it: 2 blow torches. Anything else?" }),
  ]);
  const reply = await checkedTurn({
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
  const reply = await checkedTurn({
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

test("a wrong stock count left after the repair is dropped from its bracket, never rewritten to another number (exam 4, c03-stress idx 7)", async () => {
  const woks = [product({ stock_id: "P-16HD", name: "IRON WOK", available_quantity: 35 }), product({ stock_id: "13103-1601", name: "Iron Wok 16\"", available_quantity: 2 })];
  const draft = "A few options in stock: 16in Iron Wok (35 available). Which size do you need?";
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["iron wok"] }),
    answer({ message: draft, card_ids: ["13103-1601"] }),
    answer({ message: draft, card_ids: ["13103-1601"] }),
  ]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "got wok? need 4 for zichar" } }), deps: fakeDeps(woks), client, model: "claude-sonnet-5" });
  assert.match(String(bodies[2].messages.at(-1)!.content), /"35 available" for 13103-1601 \(live 2\); 35 matches P-16HD IRON WOK/);
  assert.equal(reply.message, "A few options in stock: 16in Iron Wok. Which size do you need?");
});

test("an unverified amount that survives the repair is removed", async () => {
  const { client } = fakeClient([
    answer({ message: "That one is $99.", chips: ["Yes, $99 one", "Show others"] }),
    answer({ message: "That one is $99.", chips: ["Yes, $99 one", "Show others"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.doesNotMatch(reply.message, /\$99/);
  // The chip with the amount takes its set along (exam 3: lopsided chips).
  assert.deepEqual(reply.chips, []);
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

test("a problem code can fix, with little time left, is fixed in code and sent without a repair call", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
    answer({ message: "That covers our torch range. This one is $31.31.", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 9_000, fallbackReserveMs: 5_000 });
  assert.equal(bodies.length, 2);
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "This one is $31.31.");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

test("a made-up card with little time left still gets its repair", async () => {
  const { client, bodies } = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), answer({ message: "What will you use it for?" })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 9_000, fallbackReserveMs: 5_000 });
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, "What will you use it for?");
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

test("an answer code can fix whose repair fails is sent fixed, not as the backup reply (r6 T-R4)", async () => {
  const { client } = fakeClient([answer({ message: "That one is $99. Which size do you need?" }), new Error("overloaded")]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "That one is the listed price. Which size do you need?");
});

test("an answer code can fix whose repair brings a made-up card is sent fixed (r6 T-R4)", async () => {
  const { client } = fakeClient([answer({ message: "That one is $99. Which size do you need?" }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "That one is the listed price. Which size do you need?");
  assert.deepEqual(reply.cards, []);
});

test("an answer code can fix whose repair is cut by the answer deadline is sent fixed (r6 T-R4)", async () => {
  // Work time 9 s, 1 s over the repair's 8 s floor, so the repair is tried; it hangs until the answer deadline at 10 s cuts it.
  const started = performance.now();
  const reply = await within(runAgentTurn({
    request: request({}), deps: deps(), client: answersThenHangs([answer({ message: "That one is $99. Which size do you need?" })]),
    model: "claude-sonnet-5", deadlineMs: 14_000, fallbackReserveMs: 5_000,
  }), 12_000);
  assert.ok(performance.now() - started >= 9_500, "the repair was not tried");
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "That one is the listed price. Which size do you need?");
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
  assert.deepEqual(reply.chips, []);
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
    request: request({ event: { type: "text", text: "any other?" }, history: [{ role: "user", content: "blow torch" }, shown, { role: "user", content: "hmm" }, shown], shownProductIds: ["970S"] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  const repair = JSON.stringify(bodies[2].messages.at(-1));
  // The card set the notes show twice is dropped in code before the review, so only the repeated words need the repair.
  assert.doesNotMatch(repair, /already shown this same set of cards twice/);
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

test("an item code from the chat that looks like a phone number reaches the customer unchanged", async () => {
  // exam 3, c05-persona T10: "3500-0018" was sent as "Sia Huat sales (details below)".
  const plate = product({ stock_id: "3500-0018", name: "Patra Rim Plate 18cm, Porcelain White", list_price: 7.8 });
  const shown = `Plain white pair.\n[cards shown: 3500-0018 Patra Rim Plate 18cm, Porcelain White ($7.80) <${plate.source_url}>]`;
  const message = "Could you type back the plate's code, 3500-0018, with how many you need?";
  const { client } = fakeClient([answer({ message })]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "ok this one la" }, history: [{ role: "user", content: "white plate" }, { role: "assistant", content: shown }], shownProductIds: ["3500-0018"] }),
    deps: fakeDeps([plate]), client, model: "claude-sonnet-5",
  });
  assert.equal(reply.message, message);
  assert.equal(reply.showContact, false);
});

test("a repeated pitch is dropped without a repair call", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Yes, each product's store page has Add to Cart. You can contact Sia Huat sales with the PDF.", show_contact: true }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "then online can buy or not?" },
      history: [{ role: "user", content: "how do i order" }, { role: "assistant", content: "Contact Sia Huat sales with the PDF of your enquiry." }],
    }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 1);
  assert.equal(reply.message, "Yes, each product's store page has Add to Cart.");
  assert.equal(reply.showContact, true);
});

test("a pitch dropped last turn doesn't come back: any earlier reply's pitch counts", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Yes, each product's store page has Add to Cart. You can contact Sia Huat sales with the PDF.", show_contact: true }),
  ]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "then online can buy or not?" },
      history: [
        { role: "user", content: "how do i order" }, { role: "assistant", content: "Contact Sia Huat sales with the PDF of your enquiry." },
        { role: "user", content: "so troublesome" }, { role: "assistant", content: "Sorry for the confusion." },
      ],
    }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 1);
  assert.equal(reply.message, "Yes, each product's store page has Add to Cart.");
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

test("a turn's own searches never time out in the shared search queue", async () => {
  // Three list items in one round, 3 phrasings and a category each: 12 searches through a 4-slot queue that gives up after 200 ms.
  const shared = searchSlots(4, 200);
  const slow = deps();
  const { searchDirect, searchCategory } = slow;
  const later = <T>(work: () => Promise<T>) => shared(() => new Promise<T>((resolve) => { setTimeout(() => resolve(work()), 150); }));
  slow.searchDirect = (query, limit) => later(() => searchDirect(query, limit));
  slow.searchCategory = (words, limit, maxPrice) => later(() => searchCategory(words, limit, maxPrice));
  const search = (id: string, item: string) => ({ type: "tool_use", id, name: "search_catalogue", input: { queries: [item, `${item} steel`, `${item} pro`], category: "torches" } });
  const threeItems = { ...toolCall("t1", "search_catalogue", {}), content: [search("t1", "torch"), search("t2", "burner"), search("t3", "lighter")] } as unknown as Anthropic.Message;
  const { client, bodies } = fakeClient([threeItems, answer({ message: "Here is what I found." })]);
  await runAgentTurn({ request: request({}), deps: slow, client, model: "claude-sonnet-5" });
  const results = JSON.stringify(bodies[1].messages.at(-1));
  assert.doesNotMatch(results, /SEARCH_UNAVAILABLE|Category search failed/);
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
  // The session's last 8 characters and the cards' code:status:qty match a log line to its transcript turn (exam 3 couldn't).
  assert.deepEqual({ ...first, ms: 0 }, {
    ms: 0, session: "ion-1234", rounds: 2, forcedEarly: false, cut: null, stopped: null, repaired: false, repairCauses: [], repairSkipped: false, repairFailed: null,
    tools: ["search_catalogue"], updates: [], picks: [], pickFast: 0, cards: ["970S:in_stock:50"],
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

test("the backup-reply log carries only a reason code, the time taken and the session, never error text", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const outage = fakeClient([new Error("customer wrote: blow torch for my shop")]);
  await runAgentTurn({ request: request({}), deps: deps(), client: outage.client, model: "claude-sonnet-5" });
  const cutOff = fakeClient([{ ...answer({ message: "Here" }), stop_reason: "max_tokens" } as Anthropic.Message]);
  await runAgentTurn({ request: request({}), deps: deps(), client: cutOff.client, model: "claude-sonnet-5" });
  const rejected = fakeClient([answer({ message: "Try this.", card_ids: ["FAKE-1"] }), answer({ message: "Try this.", card_ids: ["FAKE-1"] })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: rejected.client, model: "claude-sonnet-5" });
  const overloaded = fakeClient([Object.assign(new Error("Overloaded while reading: blow torch for my shop"), { status: 529 })]);
  await runAgentTurn({ request: request({}), deps: deps(), client: overloaded.client, model: "claude-sonnet-5" });
  const logged = warn.mock.calls.map((call) => call.arguments[1] as { reason: string; ms: number; session: string });
  assert.deepEqual(logged.map((entry) => entry.reason), ["Error", "AGENT_STOP_MAX_TOKENS", "AGENT_REPLY_REJECTED", "API_529"]);
  assert.ok(logged.every((entry) => typeof entry.ms === "number" && entry.session === "ion-1234" && Object.keys(entry).length === 3));
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
  assert.deepEqual(result.notes, []);
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

/** The system context block of the turn's first Claude call. */
const contextText = (body: Anthropic.MessageCreateParamsNonStreaming) => (body.messages.at(-1)!.content as Anthropic.ContentBlockParam[])
  .flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

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
  const context = contextText(bodies[0]);
  assert.match(context, /"unchecked_lines":\[\{"code":"970S","quantity":2\}\]/);
  assert.match(context, /They are still on the customer's enquiry: never say they were removed or are missing/);
  assert.doesNotMatch(context, /Enquiry changes since last turn/);
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

test("a photo sent without a caption is not a typed message; a caption is", () => {
  const texts = recentCustomerTexts(request({
    event: { type: "text", text: "this one" },
    history: [{ role: "user", content: "need 4 of these" }, { role: "user", content: "[photo] (no caption)" }],
  }));
  assert.deepEqual(texts, ["this one", "need 4 of these"]);
  assert.deepEqual(recentCustomerTexts(request({ history: [{ role: "user", content: "[photo] 2 of this" }] })), ["blow torch", "2 of this"]);
});

test("a chip tap is never a quantity: the enquiry tool refuses", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 5 }),
    answer({ message: "Good choice. How many do you need?" }),
  ]);
  const reply = await checkedTurn({
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
  const reply = await refusedTurn({
    request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines, []);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /NOT_PICKED/);
});

test("a yes to the only card in Claire's previous reply picks it", async () => {
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await checkedTurn({
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
  const reply = await checkedTurn({
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
  const reply = await checkedTurn({
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
  const reply = await refusedTurn({
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
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /NOT_PICKED/);
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

test("a reply still asking which type of a range is sent without cards (r7: pushing furniture)", async () => {
  const { client } = fakeClient([answer({ message: "We carry folding tables and Q-posts. Here are a few. Which type do you need?", card_ids: ["970S"], chips: ["Folding tables", "Q-posts"] })]);
  const reply = await runAgentTurn({ request: askedAgain("how about furniture"), deps: deps(), client, model: "claude-sonnet-5" });
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, "We carry folding tables and Q-posts. Which type do you need?");
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

test("a re-attached earlier card whose live price changed still fails the money check when the reply quotes the old history price", async () => {
  // exam 3: re-attached cards went out unchecked, so this check never had a live price to compare with.
  const { client, bodies } = fakeClient([
    answer({ message: "Here it is: $25.50.", card_ids: ["197-55"] }),
    answer({ message: "Here it is: $26.00 now.", card_ids: ["197-55"] }),
  ]);
  const reply = await runAgentTurn({ request: strainerAsked, deps: fakeDeps([strainer], { "197-55": { price_ex_gst: 26 } }), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /\$25\.50/);
  assert.equal(reply.message, "Here it is: $26.00 now.");
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.list_price, card.stock_status]), [["197-55", 26, "in_stock"]]);
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

// exam 3, c02-A T18: the card was shown twice, the customer said yes with a quantity, and the add receipt re-sent the card.
const torchShownTwice = (shownProductIds: string[]) => request({
  event: { type: "text", text: "ok sure. i want 2 units." },
  history: [{ role: "user", content: "blow torch" }, torchShown, { role: "user", content: "how much ah" }, torchShown],
  shownProductIds,
});

test("an add confirmation that re-attaches an already-seen card is sent without a repair", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "Got it: 2 blow torches.", card_ids: ["970S"] }),
  ]);
  const reply = await checkedTurn({ request: torchShownTwice(["970S"]), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  assert.deepEqual(reply.cards, []);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2]]);
  const log = info.mock.calls.find((call) => call.arguments[0] === "[api/agent] turn")!.arguments[1] as Record<string, unknown>;
  assert.deepEqual(log.repairCauses, []);
});

test("an add confirmation keeps a card the customer hasn't seen, and a cards-only answer keeps its card", async () => {
  const firstShowing = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "Got it: 2 blow torches.", card_ids: ["970S"] }),
  ]);
  const shownNever = await checkedTurn({
    request: { ...torchShownTwice([]), history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: "Which kind of torch do you need?" }, { role: "user", content: "how much ah" }] },
    deps: deps(), client: firstShowing.client, model: "claude-sonnet-5",
  });
  assert.deepEqual(shownNever.cards.map((card) => card.stock_id), ["970S"]);
  const cardsOnly = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    answer({ message: "", card_ids: ["970S"] }),
  ]);
  const onlyCards = await checkedTurn({ request: torchShownTwice(["970S"]), deps: deps(), client: cardsOnly.client, model: "claude-sonnet-5" });
  assert.deepEqual(onlyCards.cards.map((card) => card.stock_id), ["970S"]);
});

test("an invalid first answer after an add is still repaired", async () => {
  const invalid = { ...answer({ message: "" }), content: [{ type: "text", text: "not json" }] } as unknown as Anthropic.Message;
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
    invalid,
    answer({ message: "Got it: 2 blow torches." }),
  ]);
  const reply = await checkedTurn({ request: torchShownTwice(["970S"]), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 3); // the add, the invalid answer and its repair
  assert.match(JSON.stringify(bodies.at(-1)!.messages.at(-1)), /not valid JSON/);
  assert.equal(reply.message, "Got it: 2 blow torches.");
});

test("a refused add, then 'Is it the X?' with X shown twice before, is sent with its card and no repair", async (t) => {
  // exam 3, c08-persona T8 and c11-stress T7: REPEAT stripped the one card the question was about, so the next yes had nothing to pick.
  const info = t.mock.method(console, "info", () => undefined);
  for (const message of ["Is it the Kitchen Blow Torch 970S?", "Which one do you mean?"]) {
    const { client, bodies } = fakeClient([
      toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }),
      answer({ message, card_ids: ["970S"] }),
    ]);
    const reply = await refusedTurn({
      request: { ...torchShownTwice(["970S"]), event: { type: "text", text: "2 of the gas one" } }, deps: deps(), client, model: "claude-sonnet-5",
    });
    assert.match(JSON.stringify(bodies[1].messages.at(-1)), /NOT_PICKED/, message);
    assert.equal(bodies.length, 2, message);
    assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"], message);
    assert.deepEqual(reply.enquiry.lines, [], message);
    const log = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").at(-1)!.arguments[1] as Record<string, unknown>;
    assert.deepEqual(log.repairCauses, [], message);
  }
});

test("a how-many question re-attaching a card shown twice goes out without the card and without a repair", async (t) => {
  // exam 4: 14 same-set third showings, most re-attached to "Just to confirm?", "Want me to add it?" or "How many?".
  const info = t.mock.method(console, "info", () => undefined);
  const { client, bodies } = fakeClient([answer({ message: "How many of the Safico torch do you need?", card_ids: ["BTS-8026D"] })]);
  const shownTwice = { role: "assistant" as const, content: `This one runs on gas.${cardsNote([safico])}` };
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "ok the safico one" }, history: [{ role: "user", content: "gas torch" }, shownTwice, { role: "user", content: "how much ah" }, shownTwice], shownProductIds: ["BTS-8026D"] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 1);
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, "How many of the Safico torch do you need?");
  const log = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").at(-1)!.arguments[1] as Record<string, unknown>;
  assert.deepEqual(log.repairCauses, []);
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
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "ok" }, history: [{ role: "user", content: "torch 2 pcs" }, saficoShown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal((bodies[1].tool_choice as { type: string }).type, "auto");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /no update_enquiry call succeeded/);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
  assert.equal(reply.message, "Got it: 2 Safico torches. Anything else?");
});

test("a permission question is sent back with tools, and the add then goes through", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Shall I add 2 to your enquiry?" }),
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "ok 2 first" }, history: [{ role: "user", content: "torch" }, saficoShown] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal((bodies[1].tool_choice as { type: string }).type, "auto");
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /Don't ask permission to add/);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
  assert.equal(reply.message, "Got it: 2 Safico torches. Anything else?");
});

test("a permission question with no tool round left is repaired without asking for update_enquiry", async () => {
  const { client, bodies } = fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["torch"] }),
    toolCall("t2", "search_catalogue", { queries: ["gas torch"] }),
    answer({ message: "Shall I add 2 to your enquiry?" }),
    answer({ message: "Which torch would you like?" }),
  ]);
  await runAgentTurn({ request: request({ event: { type: "text", text: "2 torches" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal((bodies.at(-1)!.tool_choice as { type: string }).type, "none");
  const repair = JSON.stringify(bodies.at(-1)!.messages.at(-1));
  assert.match(repair, /Don't ask permission to add/);
  assert.doesNotMatch(repair, /update_enquiry/);
});

test("a permission question with no tool round left is repaired and asked to keep the rest", async () => {
  // exam 3, s06-A T1: the repair threw away "Sorry to hear that" and sent only "How many?".
  const searchedTwice = (message: string) => fakeClient([
    toolCall("t1", "search_catalogue", { queries: ["torch"] }),
    toolCall("t2", "search_catalogue", { queries: ["gas torch"] }),
    answer({ message }),
    answer({ message: "The Safico runs on gas. How many do you need?" }),
  ]);
  // A tap is a pick: no check says so for a product only named, as no number was typed (a named product is checked only when a number was typed).
  const picked = searchedTwice("The Safico runs on gas. Want me to add it?");
  await runAgentTurn({ request: request({ event: { type: "select_product", stockId: "BTS-8026D" }, history: [{ role: "user", content: "torch" }, saficoShown] }), deps: deps(), client: picked.client, model: "claude-sonnet-5" });
  assert.equal(picked.bodies.length, 4);
  assert.match(JSON.stringify(picked.bodies.at(-1)!.messages.at(-1)), /Keep the rest of your answer/);
  // exam 3, c09-stress T1: offering the product they asked about lets them pick it; it is not the confirm step.
  const recommended = searchedTwice("For cooking I'd go with the Safico, it runs on gas. Want me to add the Safico one?");
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "which one is better for cooking?" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client: recommended.client, model: "claude-sonnet-5",
  });
  assert.equal(recommended.bodies.length, 3);
  assert.equal(reply.message, "For cooking I'd go with the Safico, it runs on gas. Want me to add the Safico one?");
});

test("a permission question after two long messages full of numbers is reviewed quickly", async () => {
  // Review of V5: the pick check tried every number the customer typed, and two 500-character lists of numbers took seconds per review.
  const names = ["Porcelain Round Plate", "Deep Bowl", "Utility Tong", "Chef Knife", "Gas Torch", "Rice Bowl", "Dinner Fork", "Soup Spoon", "Stock Pot", "Mesh Strainer"];
  const cardsFor = (r: number) => Array.from({ length: 5 }, (_, i) => product({ stock_id: `P${r}${i}-${10 + i}`, name: `${names[(r + i) % names.length]} ${10 + r + i}cm Series ${r}`, list_price: 3 + r + i }));
  const shown = (r: number) => ({ role: "assistant" as const, content: `Some options.\n[cards shown: ${cardsFor(r).map((card) => `${card.stock_id} ${card.name} ($${card.list_price.toFixed(2)})`).join("; ")}]` });
  const numbers = (from: number) => Array.from({ length: 200 }, (_, i) => i + from).join(" ").slice(0, 500);
  const history = Array.from({ length: 12 }, (_, r) => [{ role: "user" as const, content: `need ${names[r % names.length].toLowerCase()}` }, shown(r)]).flat();
  const plates = cardsFor(11);
  const message = "Here are the ones that fit. Want me to add them to your enquiry?";
  const { client } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["series 11"] }), answer({ message, card_ids: plates.map((card) => card.stock_id) }), answer({ message, card_ids: plates.map((card) => card.stock_id) })]);
  const started = performance.now();
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: numbers(150) }, history: [...history, { role: "user", content: numbers(1) }, shown(3)] }),
    deps: fakeDeps(plates), client, model: "claude-sonnet-5",
  });
  assert.equal(reply.message, message);
  assert.ok(performance.now() - started < 1_500, `took ${Math.round(performance.now() - started)} ms`);
});

test("a permission question after a crafted history of long refusal texts is reviewed quickly", async () => {
  // Card names and texts come from the client: each product the question is about was checked with every typed number, each
  // check reading every text's clauses again, and one turn held the server for 8 s.
  const name = (n: number) => `Stainless Steel Utility Tong With Locking Ring ${n} inch Heavy Duty Porcelain Plate Bowl Cup Scissors Knife ${n}cm ${"Word".repeat(3)} `.repeat(3).slice(0, 190);
  const long = (seed: number, max: number) => {
    let out = "";
    for (let i = 0; out.length < max; i += 1) out += i % 2 ? `take the cheapest tong ${seed * 1000 + i}, ` : `no spoon ${seed * 1000 + i}, take ${i % 9 + 1} z${seed}${i}, no q${seed}${i}, `;
    return out.slice(0, max);
  };
  const history = Array.from({ length: 15 }, (_, r) => {
    const cards = Array.from({ length: 5 }, (_, i) => product({ stock_id: `C-${r * 5 + i}`, name: name(r * 5 + i), list_price: 3 + ((r * 5 + i + 1) % 7) }));
    return [{ role: "user" as const, content: long(r, 1990) }, { role: "assistant" as const, content: `How many do you need?${cardsNote(cards)}`.slice(0, 2000) }];
  }).flat();
  const message = "Both are gas torches. Shall I add 2 of these?";
  const { client } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"] }), ...Array.from({ length: 3 }, () => answer({ message, card_ids: ["970S", "BTS-8026D"] }))]);
  const started = performance.now();
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: long(99, 1990) }, history }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.ok(performance.now() - started < 2_000, `took ${Math.round(performance.now() - started)} ms`);
});

test("a false add claim that survives the nudge and the repair is replaced", async () => {
  const claim = answer({ message: "Added: 2 torches. Anything else?" });
  const { client, bodies } = fakeClient([claim, claim, claim]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "2 torches" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 3);
  assert.equal(reply.provider, "anthropic");
  assert.doesNotMatch(reply.message, /added/i);
  // Nothing changed this turn, so the closer goes too.
  assert.equal(reply.message, "That change isn't on your enquiry yet. Which item and how many would you like?");
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
  assert.equal(reply.message, "That change isn't on your enquiry yet. Which item and how many would you like?");
});

test("a false promise answering a recommendation request is dropped without the fixed line", async () => {
  // exam 3, c03-persona T5: "Recommend" got "That change isn't on your enquiry yet.", though the customer asked for no change.
  const claim = answer({ message: "The Safico runs on a gas cassette. I'll add 1 for you now." });
  const { client, bodies } = fakeClient([claim, claim, claim]);
  const shown = `Two options.\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <${blowtorch.source_url}>; BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO ($23.36) <${safico.source_url}>]`;
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "Recommend" }, history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: shown }], shownProductIds: ["970S", "BTS-8026D"] }),
    deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 3);
  assert.equal(reply.message, "The Safico runs on a gas cassette.");
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
    // Nothing changed this turn, so the closer goes.
    assert.equal(reply.message, message.replace(" Anything else?", ""));
    assert.doesNotMatch(reply.message, /isn't on your enquiry/);
    assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), enquiry.map((item) => [item.stockId, item.quantity]));
  }
});

test("a doubly escaped character reaches the customer as the character (r4 c11-A idx 1)", async () => {
  const { client } = fakeClient([answer({ message: "Got it, not conveyor \\u2014 both are pop-up toasters.", chips: ["Pop-up \\u2014 smaller"] })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "not conveyor" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.message, "Got it, not conveyor — both are pop-up toasters.");
  assert.deepEqual(reply.chips, ["Pop-up — smaller"]);
  const emoji = fakeClient([answer({ message: "Happy cooking \\ud83d\\ude0a" })]);
  const smiled = await runAgentTurn({ request: request({ event: { type: "text", text: "ok la" } }), deps: deps(), client: emoji.client, model: "claude-sonnet-5" });
  assert.equal(smiled.message, "Happy cooking 😊");
});

test("a doubly escaped quote reaches the customer as an inch mark or a quote, not a backslash (live, 1 Oct: 'Ø5\\\" up to Ø21\\\"')", async () => {
  const { client } = fakeClient([answer({ message: "We carry sizes from Ø5\\\" up to Ø21\\\" - the \\\"Hokkien Deluxe\\\" range.", chips: ["The \\\"Deluxe\\\" range"] })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "bamboo steamer" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.message, "We carry sizes from Ø5″ up to Ø21″ - the 'Hokkien Deluxe' range.");
  assert.deepEqual(reply.chips, ["The 'Deluxe' range"]);
});

test("a closing 'Anything else?' with no enquiry change this turn is dropped (r4 c09-persona, c03-stress)", async () => {
  const { client } = fakeClient([answer({ message: "The blow torch is for kitchen use. Anything else?" })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "the blow torch for kitchen or not" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.message, "The blow torch is for kitchen use.");
});

test("an 'Updated: 5' reply for a line already on the enquiry is nudged until update_enquiry runs", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Updated: 5 Safico torches now." }),
    toolCall("t1", "update_enquiry", { action: "set", stock_id: "BTS-8026D", quantity: 5 }),
    answer({ message: "Updated: 5 Safico torches now." }),
  ]);
  const reply = await checkedTurn({
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
  const reply = await checkedTurn({
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
  assert.equal(reply.message, "That change isn't on your enquiry yet. Which item and how many would you like? Anything else?");
});

test("a true removal reply that names the item left is sent as it is", async () => {
  const message = "Removed - your enquiry now has just the 1 Safico torch burner, total $23.36. Anything else?";
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", { action: "remove", stock_id: "970S" }), answer({ message })]);
  const reply = await checkedTurn({
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

// r8 R01: 04-00820's old Nernst chiller page answers 200 with Next's not-found page, so its listing is gone. The real-Claude
// replay sent "Item 04-00820 is the Nernst 3-Layer Glass Display Chiller" with the dead page's card.
const chiller = product({ stock_id: "04-00820", name: "Nernst 3 Layer Glass Display Chiller", source_url: "https://store.siahuat.com/product/14355600983" });
const chillerGone = () => fakeDeps([blowtorch, safico, chiller], { "04-00820": "gone" });
const chillerAsked = request({ event: { type: "text", text: "what is item 04-00820?" } });
const lookUpChiller = () => toolCall("t1", "get_product", { stock_id: "04-00820" });

test("a removed listing's card is dropped before the review, so no repair is spent on it (r8 R01)", async () => {
  const { client, bodies } = fakeClient([
    lookUpChiller(),
    answer({ message: "I couldn't confirm item 04-00820 on the store just now.", card_ids: ["04-00820"], show_contact: true }),
  ]);
  const reply = await runAgentTurn({ request: chillerAsked, deps: chillerGone(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards, []);
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /LISTING_GONE/);
  assert.doesNotMatch(JSON.stringify(bodies[1].messages.at(-1)), /Nernst|14355600983/);
});

test("a removed listing drops only its own exact code: 1550a's dead page leaves the 1550A card (r8 R01)", async () => {
  const dead = product({ stock_id: "1550a", name: "CHAFING DISH 1550a" });
  const live = product({ stock_id: "1550A", name: "CHAFING DISH 1550A" });
  const { client, bodies } = fakeClient([
    toolCall("t1", "get_product", { stock_id: "1550a" }),
    toolCall("t2", "search_catalogue", { queries: ["chafing dish"] }),
    answer({ message: "This chafing dish is the one on the store now.", card_ids: ["1550A"] }),
  ]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "1550a chafing dish" } }), deps: fakeDeps([dead, live], { "1550a": "gone" }), client, model: "claude-sonnet-5" });
  assert.deepEqual([reply.cards.map((card) => card.stock_id), bodies.length], [["1550A"], 3]);
});

test("a cards-only answer whose only card is a removed listing gets the next step and the contact (r8 R01)", async () => {
  const { client, bodies } = fakeClient([lookUpChiller(), answer({ message: "", card_ids: ["04-00820"] })]);
  const reply = await runAgentTurn({ request: chillerAsked, deps: chillerGone(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 2);
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).");
  assert.equal(reply.showContact, true);
});

test("words pointing at a removed listing's card go with it: a reply with nothing left gets the next step and the contact (r8 R01)", async () => {
  const nothingLeft = "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).";
  const outcome = (reply: Awaited<ReturnType<typeof runAgentTurn>>, bodies: unknown[]) => [reply.provider, reply.message, reply.cards, reply.showContact, bodies.length];
  // Found gone by get_product in the tool round.
  const looked = fakeClient([lookUpChiller(), answer({ message: "Here it is, the card below has the details.", card_ids: ["04-00820"] })]);
  const tool = await runAgentTurn({ request: chillerAsked, deps: chillerGone(), client: looked.client, model: "claude-sonnet-5" });
  assert.deepEqual(outcome(tool, looked.bodies), ["anthropic", nothingLeft, [], true, 2]);
  // An earlier card, found gone only when the answer re-attaches it: cards only, and "Here it is again."
  for (const message of ["", "Here it is again."]) {
    const shown = fakeClient([answer({ message, card_ids: ["970S"] })]);
    const reply = await runAgentTurn({ request: askedAgain("show me the torch again"), deps: fakeDeps([blowtorch, safico], { "970S": "gone" }), client: shown.client, model: "claude-sonnet-5" });
    assert.deepEqual(outcome(reply, shown.bodies), ["anthropic", nothingLeft, [], true, 1], message);
  }
  // This turn's search result whose read ran late, found gone by the read before the reply.
  const lookups = fakeDeps([blowtorch, safico]);
  let attempts = 0;
  const fetchLive = lookups.fetchLive;
  lookups.fetchLive = (url, ms) => {
    if (url !== blowtorch.source_url) return fetchLive(url, ms);
    attempts += 1;
    return Promise.reject(attempts === 1 ? new DOMException("The operation was aborted due to timeout", "TimeoutError") : new Error(`PAGE_GONE: ${url}`));
  };
  const late = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"] }), answer({ message: "", card_ids: ["970S"] })]);
  const reread = await runAgentTurn({ request: request({}), deps: lookups, client: late.client, model: "claude-sonnet-5" });
  assert.deepEqual([...outcome(reread, late.bodies), attempts], ["anthropic", nothingLeft, [], true, 2, 2]);
});

test("an earlier card whose listing is now gone is dropped, read once in the turn, with no repair (r8 R01)", async () => {
  const counted = () => {
    const lookups = fakeDeps([blowtorch, safico], { "970S": "gone" });
    const fetchLive = lookups.fetchLive;
    const reads = { count: 0 };
    lookups.fetchLive = (url, ms) => {
      if (url === blowtorch.source_url) reads.count += 1;
      return fetchLive(url, ms);
    };
    return { lookups, reads };
  };
  // Looked up for the first time when the answer re-attaches it.
  const again = counted();
  const shown = fakeClient([answer({ message: "That torch can't be confirmed on the store just now.", card_ids: ["970S"], show_contact: true })]);
  const reattached = await runAgentTurn({ request: askedAgain("show me the torch again"), deps: again.lookups, client: shown.client, model: "claude-sonnet-5" });
  assert.deepEqual([reattached.cards, again.reads.count, shown.bodies.length], [[], 1, 1]);
  // On the enquiry, so the re-check finds it gone first: a quoted price makes the answer look up Claire's previous cards, and the
  // gone one isn't read again (failures leave the turn's memo).
  const onEnquiry = counted();
  const priced = fakeClient([answer({ message: "I couldn't confirm the 970S on the store just now. The BTS-8026D is $23.36.", card_ids: ["970S", "BTS-8026D"], show_contact: true })]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "how much now" }, history: [{ role: "user", content: "torch" }, twoCardsShown], shownProductIds: ["970S", "BTS-8026D"], enquiry: [{ stockId: "970S", quantity: 2 }] }),
    deps: onEnquiry.lookups, client: priced.client, model: "claude-sonnet-5",
  });
  assert.deepEqual([reply.cards.map((card) => card.stock_id), onEnquiry.reads.count, priced.bodies.length], [["BTS-8026D"], 1, 1]);
  assert.deepEqual(reply.enquiry.unchecked, ["970S"]);
});

test("a tapped card whose listing is gone gives Claude no product facts for it, and its card stays off (r8 R01)", async () => {
  const { client, bodies } = fakeClient([answer({ message: "I couldn't open item 04-00820 on the store just now.", card_ids: ["04-00820"], show_contact: true })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "select_product", stockId: "04-00820" } }), deps: chillerGone(), client, model: "claude-sonnet-5" });
  assert.doesNotMatch(JSON.stringify(bodies[0].messages), /Nernst|14355600983/);
  assert.deepEqual([reply.cards, bodies.length], [[], 1]);
});

test("a phone-shaped item code whose listing is gone is named back unchanged, not taken for a phone number (r8 R01)", async () => {
  const old = product({ stock_id: "62231732", name: "OLD ITEM" });
  const message = "I couldn't confirm item 62231732 on the store just now.";
  const { client } = fakeClient([toolCall("t1", "get_product", { stock_id: "62231732" }), answer({ message, show_contact: true })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "item 62231732 got?" } }), deps: fakeDeps([old], { "62231732": "gone" }), client, model: "claude-sonnet-5" });
  assert.equal(reply.message, message);
});

test("a removed listing's link typed in the reply is cut, and its card stays off (r8 R01)", async () => {
  const withLink = answer({ message: "I couldn't confirm 04-00820 just now: https://store.siahuat.com/product/14355600983", card_ids: ["04-00820"], show_contact: true });
  const { client } = fakeClient([lookUpChiller(), withLink, withLink]);
  const reply = await runAgentTurn({ request: chillerAsked, deps: chillerGone(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards, []);
  assert.doesNotMatch(reply.message, /14355600983/);
});

test("the memo does not outlive the turn", async () => {
  const shared = deps();
  for (let turn = 0; turn < 2; turn += 1) {
    const { client } = fakeClient([
      toolCall("t1", "search_catalogue", { queries: ["blow torch"] }),
      answer({ message: "This one is a handheld kitchen blow torch.", card_ids: ["970S"] }),
    ]);
    await runAgentTurn({ request: request({}), deps: shared, client, model: "claude-sonnet-5" });
  }
  assert.equal(shared.calls.filter((call) => call === "live:970S").length, 2);
});

test("two adds in one round both land", async () => {
  const shared = deps();
  const twoAdds = {
    ...toolCall("t1", "update_enquiry", {}),
    content: [
      { type: "tool_use", id: "t1", name: "update_enquiry", input: { action: "add", stock_id: "970S", quantity: 2 } },
      { type: "tool_use", id: "t2", name: "update_enquiry", input: { action: "add", stock_id: "BTS-8026D", quantity: 3 } },
    ],
  } as unknown as Anthropic.Message;
  const { client } = fakeClient([twoAdds, answer({ message: "Got it: 2 blow torches and 3 Safico torches. Anything else?" })]);
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "2 of the 970S and 3 of the BTS-8026D please" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: shared, client, model: "claude-sonnet-5",
  });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2], ["BTS-8026D", 3]]);
  // Both lookups start together before the first add, and the adds reuse them.
  assert.deepEqual(shared.calls, ["code:970S", "code:BTS-8026D", "live:970S", "live:BTS-8026D"]);
});

test("an unbacked completeness claim is repaired once, then removed", async () => {
  const claim = answer({ message: "That covers our torch range. Anything else?" });
  const { client, bodies } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"] }), claim, claim]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 3);
  assert.ok(JSON.stringify(bodies[2].messages.at(-1)).includes(CLAIM_ISSUE_PREFIX));
  assert.equal(reply.message, "Anything else?");
});

test("an answer the fixers empty with no card left gets a next step", async () => {
  // r6: every sentence removed used to end on "Sia Huat sales can help", with nothing the customer could do here.
  const claim = answer({ message: "That covers our torch range." });
  const { client, bodies } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"] }), claim, claim]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 3);
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).");
  assert.equal(reply.showContact, true);
});

test("a reply that would show as a blank bubble gets the next step", async () => {
  // r7: a zero-width space, an escaped space decoded after the trim, or only marks (a direction mark, a soft hyphen, an emoji
  // selector) got past every check and reached the customer as '' or an invisible bubble.
  const zeroWidth = answer({ message: String.fromCodePoint(0x200b) });
  const escapedSpace = rawAnswer('{"message":"\\\\u0020","card_ids":[],"chips":[],"show_contact":false}');
  const marks = answer({ message: String.fromCodePoint(0x200e, 0xad, 0xfe0f) });
  for (const [label, responses] of [["zero-width", [zeroWidth, zeroWidth]], ["escaped space", [escapedSpace]], ["marks", [marks, marks]]] as const) {
    const { client } = fakeClient([...responses]);
    const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
    assert.equal(reply.provider, "anthropic", label);
    assert.deepEqual(reply.cards, [], label);
    assert.equal(reply.message, "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).", label);
    assert.equal(reply.showContact, true, label);
  }
});

test("a blank reply with a card keeps the card and gets the cards-only line", async () => {
  const zeroWidth = answer({ message: String.fromCodePoint(0x200b), card_ids: ["970S"] });
  const { client } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["blow torch"] }), zeroWidth, zeroWidth]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(reply.message, "Here are some options.");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

test("a cards-only line with no cards and no link complaint gets the next step, not the broken-link line", async () => {
  // D8 review: nobody mentioned a link, so "that link isn't opening" would be a false statement.
  const { client } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["blow torch"] }), answer({ message: "Here are some options." })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).");
  assert.equal(reply.showContact, true);
});

test("a completeness claim backed by a complete category search is sent without a repair", async () => {
  const lighters = [
    product({ stock_id: "GL1", name: "COOKING TORCH", third_category: "Gas lighters" }),
    product({ stock_id: "GL2", name: "GAS TORCH BURNER", third_category: "Gas lighters" }),
  ];
  const message = "That covers our torch range. Anything else?";
  const { client, bodies } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"], category: "gas lighters" }), answer({ message })]);
  const reply = await runAgentTurn({ request: request({}), deps: fakeDeps(lighters), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  // Nothing changed this turn, so the closer goes.
  assert.equal(reply.message, "That covers our torch range.");
});

test("an out-of-stock claim about a product checked live as out of stock needs no repair", async () => {
  const message = "The kitchen blow torch is out of stock.";
  const { client, bodies } = fakeClient([toolCall("t1", "search_catalogue", { queries: ["blow torch"] }), answer({ message })]);
  const soldOut = fakeDeps([blowtorch, safico], { "970S": { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 } });
  const reply = await runAgentTurn({ request: request({}), deps: soldOut, client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, message);
});

test("an absence claim is repaired once, then sent tidied, not removed", async () => {
  const claim = answer({ message: "We don't carry boxed dining sets. Plates and cutlery are sold on their own." });
  const { client, bodies } = fakeClient([claim, claim]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "boxed dining set" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /This 'we don't have it' isn't backed/);
  assert.equal(reply.message, "We don't carry boxed dining sets. Plates and cutlery are sold on their own.");
});

test("an honest out-of-stock line about the product find_alternatives was asked about needs no repair", async () => {
  const mastrad = product({ stock_id: "F46700", name: "MASTRAD EXPERT COOKING TORCH, BLACK", brand: "MASTRAD", third_category: "Gas lighters" });
  const burner = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", third_category: "Gas lighters" });
  const soldOut = fakeDeps([mastrad, burner], { F46700: { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 } });
  const message = "The Mastrad cooking torch is out of stock. The Safico gas torch burner is in stock - how many do you need?";
  const { client, bodies } = fakeClient([toolCall("t1", "find_alternatives", { stock_id: "F46700" }), answer({ message, card_ids: ["BTS-8026D"] })]);
  const reply = await runAgentTurn({
    request: request({
      event: { type: "text", text: "Choose option 2" },
      history: [{ role: "user", content: "blow torch" }, { role: "assistant", content: "Two torches.\n[cards shown: 970S KITCHEN BLOW TORCH ($31.31); F46700 MASTRAD EXPERT COOKING TORCH, BLACK]" }],
      shownProductIds: ["970S", "F46700"],
    }),
    deps: soldOut, client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, message);
});

test("a made-up store link is sent back for one repair, and removed if it survives", async () => {
  const madeUp = answer({ message: "Photos: store.siahuat.com/product/8321T05-R." });
  const { client, bodies } = fakeClient([madeUp, madeUp]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "got pic?" } }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(reply.provider, "anthropic");
  assert.equal(bodies.length, 2);
  assert.ok(JSON.stringify(bodies[1].messages.at(-1)).includes(LINK_ISSUE_PREFIX));
  assert.equal(reply.message, "Photos: store.siahuat.com.");
});

test("a link from a tool result or already in the chat is sent as it is", async () => {
  const fromTool = `Photos: ${blowtorch.source_url}`;
  const searched = fakeClient([toolCall("t1", "search_catalogue", { queries: ["blow torch"] }), answer({ message: fromTool, card_ids: ["970S"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: deps(), client: searched.client, model: "claude-sonnet-5" });
  assert.equal(searched.bodies.length, 2);
  assert.equal(reply.message, fromTool);
  const fromChat = `The photos are on its page: ${blowtorch.source_url}`;
  const { client, bodies } = fakeClient([answer({ message: fromChat })]);
  const again = await runAgentTurn({ request: askedAgain("got photo?"), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 1);
  assert.equal(again.message, fromChat);
});

test("a card whose link the customer says doesn't open is dropped in code, with no link repair", async (t) => {
  // exam 4, c08: the Zyliss card went out again with the link the customer had just said doesn't open.
  const info = t.mock.method(console, "info", () => undefined);
  const zyliss = product({ stock_id: "E910076", name: "Zyliss Stainless Steel Household Scissors", list_price: 29.27 });
  const shibazi = product({ stock_id: "SB3038", name: "Stainless Steel Household Kitchen Scissors L21cm, Shibazi", list_price: 7.25 });
  const message = "Sorry that link isn't opening. It's item E910076: you can search that code on the store.";
  const brokenTurn = (client: AgentClient) => runAgentTurn({
    request: request({
      event: { type: "text", text: "Zyliss link not working" },
      history: [{ role: "user", content: "household scissors" }, { role: "assistant", content: `Two options.${cardsNote([zyliss, shibazi])}` }],
      shownProductIds: ["E910076", "SB3038"],
    }),
    deps: fakeDeps([zyliss, shibazi]), client, model: "claude-sonnet-5",
  });
  const { client, bodies } = fakeClient([answer({ message, card_ids: ["E910076"] })]);
  const reply = await brokenTurn(client);
  assert.equal(bodies.length, 1);
  assert.deepEqual(reply.cards, []);
  assert.equal(reply.message, message);
  const log = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").at(-1)!.arguments[1] as Record<string, unknown>;
  assert.deepEqual(log.repairCauses, []);
  // With every card dropped, a sentence pointing at them goes too (r3 c08-stress idx 5: "the card below carries the same details").
  const pointing = await brokenTurn(fakeClient([answer({ message: `${message} The card below has the same details.`, card_ids: ["E910076"] })]).client);
  assert.deepEqual(pointing.cards, []);
  assert.equal(pointing.message, message);
  // With nothing left after the drop, a next step: ask about it here, or sales (r6: not a dead end).
  const brokenLink = "Sorry, that link isn't opening for you. Tell me what you'd like to know about it, or Sia Huat sales can help (details below).";
  const onlyPointing = await brokenTurn(fakeClient([answer({ message: "The card below has the same details.", card_ids: ["E910076"] })]).client);
  assert.equal(onlyPointing.showContact, true);
  assert.equal(onlyPointing.message, brokenLink);
  const cardsOnly = await brokenTurn(fakeClient([answer({ message: "", card_ids: ["E910076"] })]).client);
  assert.deepEqual(cardsOnly.cards, []);
  assert.equal(cardsOnly.showContact, true);
  assert.equal(cardsOnly.message, brokenLink);
});

const choice = (body: Anthropic.MessageCreateParamsNonStreaming) => (body.tool_choice as { type: string }).type;
const lastMessage = (body: Anthropic.MessageCreateParamsNonStreaming) => JSON.stringify(body.messages.at(-1));
const ASK_NOTE = /update_enquiry needs a number the customer types for this item/;
const WHICH_NOTE = /update_enquiry couldn't settle which product the customer means/;
const ANSWER_NOTE = /The customer hasn't picked this product. No more tools this turn/;
const KEEP_NOTE = /That line stays on the enquiry. No more tools this turn/;
const LIST_NOTE = /That's all the lookups for this list this turn/;
const PERMISSION_NUDGE = /If the customer typed how many of this product/;

/** One update_enquiry call after the torch card, then Claude's answer: the second call's tool choice and whether it asks for a number. */
async function afterUpdate(text: string, input: unknown, live: Parameters<typeof fakeDeps>[1] = {}) {
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", input), answer({ message: "How many do you need?" })]);
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text }, history: [{ role: "user", content: "blow torch" }, torchShown], shownProductIds: ["970S"] }),
    deps: fakeDeps([blowtorch, safico], live), client, model: "claude-sonnet-5",
  });
  return { bodies, reply, second: choice(bodies[1]), asked: ASK_NOTE.test(lastMessage(bodies[1])) };
}

test("an add that needs a number only the customer can type ends the tool rounds with one how-many question", async () => {
  // exam 3, c09-stress T7: update_enquiry went three rounds on a number the customer hadn't typed (13.4 s).
  const qty = await afterUpdate("the 970S one", { action: "add", stock_id: "970S", quantity: 20 });
  assert.match(lastMessage(qty.bodies[1]), /QTY_NOT_STATED/);
  assert.deepEqual([qty.second, qty.asked, qty.bodies.length, qty.reply.enquiry.lines.length], ["none", true, 2, 0]);
  // Quantity 0 fails before the pick check, so nothing says the typed code is a pick: no how-many stop (see the 'ask' test below).
  const zero = await afterUpdate("the 970S one", { action: "add", stock_id: "970S", quantity: 0 });
  assert.deepEqual([zero.second, zero.asked], ["auto", false]);
  const none = await afterUpdate("the 970S one", { action: "set", stock_id: "970S" });
  assert.deepEqual([none.second, none.asked], ["none", true]);
});

test("a failed add keeps its tools when the customer typed a number or another call can fix it", async () => {
  // Claude sent 2 cartons as 48 pieces: the retry with unit carton needs a tool round.
  const cartons = await afterUpdate("970S, 2 ctn pls", { action: "add", stock_id: "970S", quantity: 48 });
  assert.deepEqual([cartons.second, cartons.asked], ["auto", false]);
  const overStock = await afterUpdate("970S 20 pcs", { action: "add", stock_id: "970S", quantity: 20 }, { "970S": { available_quantity: 5 } });
  assert.match(lastMessage(overStock.bodies[1]), /OVER_STOCK/);
  assert.equal(overStock.second, "auto");
  // No number typed: only the missing stock_id keeps the tools on, with or without a quantity.
  for (const input of [{ action: "add", quantity: 2 }, { action: "add" }]) {
    const noCode = await afterUpdate("the 970S one", input);
    assert.match(lastMessage(noCode.bodies[1]), /MISSING_FIELDS/);
    assert.equal(noCode.second, "auto", JSON.stringify(input));
  }
  // Quantity 0 is refused before the pick check: for a product the customer never picked, "how many?" is not the question to ask.
  const unpicked = await afterUpdate("the 970S one", { action: "add", stock_id: "BTS-8026D", quantity: 0 });
  assert.match(lastMessage(unpicked.bodies[1]), /INVALID_INPUT/);
  assert.deepEqual([unpicked.second, unpicked.asked], ["auto", false]);
});

test("the same product the check isn't sure of, refused twice, ends the tool rounds with one question about it", async () => {
  // exam 3, c08-persona T8 and c11-stress T7: the refused add was retried round after round.
  const refusedAdd = () => toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 });
  const okTwo = request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] });
  const unsureTurn = (input: TurnInput) => runAgentTurn({ pickCheck: () => fakePickCheck({ sure: false }), ...input });
  const twice = fakeClient([refusedAdd(), refusedAdd(), answer({ message: "Is it the Safico gas torch burner BTS-8026D?", card_ids: ["BTS-8026D"] })]);
  const reply = await unsureTurn({ request: okTwo, deps: deps(), client: twice.client, model: "claude-sonnet-5" });
  assert.equal(twice.bodies.length, 3);
  assert.deepEqual(twice.bodies.map(choice), ["auto", "auto", "none"]);
  assert.match(lastMessage(twice.bodies[2]), WHICH_NOTE);
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["BTS-8026D"]);
  assert.deepEqual(reply.enquiry.lines, []);
  const searched = fakeClient([refusedAdd(), toolCall("t2", "search_catalogue", { queries: ["gas torch"] }), answer({ message: "Which one would you like?" })]);
  await unsureTurn({ request: okTwo, deps: deps(), client: searched.client, model: "claude-sonnet-5" });
  assert.deepEqual(searched.bodies.map(choice), ["auto", "auto", "auto"]);
  assert.ok(!searched.bodies.some((body) => WHICH_NOTE.test(JSON.stringify(body.messages))));
});

test("after a refused add, a reply that claims or offers the add is not nudged back to the tools", async () => {
  // exam 3, c08-persona T8: a retry after a refusal is refused again; the claim guard still repairs a false add.
  for (const message of ["Adding the Safico torch now.", "Shall I add 2 of the Safico torch?"]) {
    const { client, bodies } = fakeClient([
      toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
      answer({ message }),
      answer({ message: "Which one would you like, the blow torch or the Safico?" }),
    ]);
    const reply = await refusedTurn({ request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }), deps: deps(), client, model: "claude-sonnet-5" });
    assert.ok(!bodies.some((body) => NUDGE.test(JSON.stringify(body.messages)) || PERMISSION_NUDGE.test(JSON.stringify(body.messages))), message);
    assert.deepEqual(reply.enquiry.lines, [], message);
    if (message.startsWith("Adding")) {
      assert.equal(bodies.length, 3, message);
      assert.equal(choice(bodies[2]), "none", message);
      assert.match(lastMessage(bodies[2]), /The enquiry didn't change/, message);
      assert.equal(reply.message, "Which one would you like, the blow torch or the Safico?");
    } else {
      assert.equal(bodies.length, 2, message);
    }
  }
});

test("after a refused removal, or an item the check says has no typed number, a false claim is repaired without another tool round", async () => {
  // r4 c02-A idx 16 shape: the retry the nudge asks for is answered from the check's cache with the same refusal (one wasted round).
  const cases: Array<[string, Record<string, unknown>, Parameters<typeof fakePickCheck>[0], string, AgentRequest["enquiry"]]> = [
    ["so expensive. got something cheaper?", { action: "remove", stock_id: "BTS-8026D" }, { verdict: "not_picked" }, "I've removed the Safico torch from your enquiry. The blow torch is another option.", [{ stockId: "BTS-8026D", quantity: 2 }]],
    ["the safico one for outlet B", { action: "add", stock_id: "BTS-8026D", quantity: 2 }, { quantity: null }, "Added 2 of the Safico torch.", []],
  ];
  for (const [text, input, verdict, claim, enquiry] of cases) {
    const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", input), answer({ message: claim }), answer({ message: "How many of the Safico torch do you need for outlet B?" })]);
    const reply = await runAgentTurn({
      request: request({ event: { type: "text", text }, history: [{ role: "user", content: "need torches. 2 for outlet A" }, saficoShown], enquiry }),
      deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => fakePickCheck(verdict),
    });
    assert.equal(bodies.length, 3, text);
    assert.ok(!bodies.some((body) => NUDGE.test(JSON.stringify(body.messages))), text);
    assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), enquiry.map((line) => [line.stockId, line.quantity]), text);
  }
});

test("'same qty' after switching items adds the number typed a few messages back", async () => {
  // exam 3, c09-stress T7: "ya tht one. same qty" after a single UT12HR card; the 20 was typed two messages earlier.
  const tong16 = product({ stock_id: "2564L", name: "Stainless Steel Utility Tong 16in", list_price: 3.85 });
  const tong12 = product({ stock_id: "UT12HR", name: "Stainless Steel Utility Tong with Locking Ring 12in", list_price: 4.77 });
  const { client } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "UT12HR", quantity: 20 }),
    answer({ message: "Got it: 20 of the 12in locking tongs. Anything else?" }),
  ]);
  const reply = await checkedTurn({
    request: request({
      event: { type: "text", text: "ya tht one. same qty" },
      history: [
        { role: "user", content: "ok la take the 16 inch one, 20pcs" }, { role: "assistant", content: `Got it: 20 of the 16in tongs.${cardsNote([tong16])}` },
        { role: "user", content: "wait 16 inch too long for my kitchen la. got shorter one with the lock thing? 12 inch like tht" },
        { role: "assistant", content: `Removed the 16in tong. Here's a 12in with a locking ring. Is this the one you meant?${cardsNote([tong12])}` },
      ],
      shownProductIds: ["2564L", "UT12HR"],
    }),
    deps: fakeDeps([tong16, tong12]), client, model: "claude-sonnet-5",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["UT12HR", 20]]);
});

test("a plain thank-you is answered without tools", async () => {
  // exam 3, s01-B T3: a plain "Thank you" started 3-4 tool rounds and got a stand-in reply.
  for (const text of ["Thank you", "ok thanks", "Thanks!", "thx", "thank u", "ok. thanks", "tysm", "Thanks 😊", "thank you 🙏🏻"]) {
    const { client, bodies } = fakeClient([answer({ message: "You're welcome." })]);
    await runAgentTurn({ request: request({ event: { type: "text", text }, history: [{ role: "user", content: "torch" }, twoCardsShown] }), deps: deps(), client, model: "claude-sonnet-5" });
    assert.deepEqual(bodies.map(choice), ["none"], text);
  }
  // "ok thanks" to the only card just shown can be a yes, and a photo captioned "thanks" still needs match_photo.
  const yes = fakeClient([answer({ message: "How many do you need?" })]);
  await runAgentTurn({ request: askedAgain("ok thanks"), deps: deps(), client: yes.client, model: "claude-sonnet-5" });
  assert.equal(choice(yes.bodies[0]), "auto");
  const photo = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  const captioned = photoRequest(photo);
  const withPhoto = fakeClient([answer({ message: "What is this used for?" })]);
  await runAgentTurn({ request: { ...captioned, event: { ...captioned.event, caption: "thanks" } as AgentRequest["event"] }, deps: deps(), client: withPhoto.client, model: "claude-sonnet-5" });
  assert.equal(choice(withPhoto.bodies[0]), "auto");
});

const s01List = "Hi, can you send me a quote for the following items: 1) Stainless Steel Pot 12QT 2) Stainless Steel Strainer for the 12QT Pot 3) Stainless Steel Ladle 4oz, 6oz, 8oz 4) 1/2 Stainless Steel Pan 5) 1/4 Stainless Steel Pan 6) Lid for 1/2 S/S Pan 7) Lid for 1/4 S/S Pan 8) Oyster Knife with Plastic Handle";

test("a long list gets one round of lookups, then an answer", async () => {
  // exam 3, s01-B T0: an 8-item list ran 2-3 tool rounds (31-34 s) and got a stand-in reply.
  const search = (id: string, item: string) => ({ type: "tool_use", id, name: "search_catalogue", input: { queries: [item] } });
  const threeItems = { ...toolCall("t1", "search_catalogue", {}), content: [search("t1", "stock pot"), search("t2", "strainer"), search("t3", "ladle")] } as unknown as Anthropic.Message;
  const lookups = deps();
  const { client, bodies } = fakeClient([threeItems, answer({ message: "There are 8 items on your list. Which size of stock pot do you need? Next: the pans." })]);
  await runAgentTurn({ request: request({ event: { type: "text", text: s01List } }), deps: lookups, client, model: "claude-sonnet-5" });
  assert.equal(lookups.calls.filter((call) => call.startsWith("search:")).length, 3);
  assert.deepEqual(bodies.map(choice), ["auto", "none"]);
  assert.match(lastMessage(bodies[1]), LIST_NOTE);
  assert.ok(!bodies.some((body) => NUDGE.test(JSON.stringify(body.messages)) || PERMISSION_NUDGE.test(JSON.stringify(body.messages))));
  // A short list keeps its tools, and a long list answered without tools gets no note.
  const short = fakeClient([toolCall("t1", "search_catalogue", { queries: ["torch"] }), answer({ message: "Which torch do you need?" })]);
  await runAgentTurn({ request: request({ event: { type: "text", text: "1) torch 2) pot" } }), deps: deps(), client: short.client, model: "claude-sonnet-5" });
  assert.deepEqual(short.bodies.map(choice), ["auto", "auto"]);
  const noTools = fakeClient([answer({ message: "There are 8 items on your list. Which size of stock pot do you need?" })]);
  await runAgentTurn({ request: request({ event: { type: "text", text: s01List } }), deps: deps(), client: noTools.client, model: "claude-sonnet-5" });
  assert.ok(!noTools.bodies.some((body) => LIST_NOTE.test(JSON.stringify(body.messages))));
});

test("a recommendation that offers to add a product the customer hasn't picked is sent as it is", async () => {
  // exam 3, c09-stress T1: the permission nudge turned "which one is better?" into "How many Safico tongs do you need?".
  const message = "For cooking I'd go with the Safico, it runs on gas. Want me to add the Safico one?";
  // Also with a number typed: the nudge is decided before the earlier card is looked up again, so it must know that card too.
  // With no card attached and nothing looked up, the nudge and the review both judge it by the earlier cards: an unknown product
  // counted as the confirm step, and the repair turned it into "How many do you need?".
  // With a number typed, the named Safico gets one pick check first, which says "not picked" here.
  for (const cardIds of [["BTS-8026D"], []]) {
    for (const text of ["which one is better for cooking?", "which one better for cooking? need 10", "need 2 pcs. which one more suitable for cooking"]) {
      const { client, bodies } = fakeClient([answer({ message, card_ids: cardIds }), answer({ message: "How many do you need?" })]);
      const reply = await refusedTurn({
        request: request({ event: { type: "text", text }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
        deps: deps(), client, model: "claude-sonnet-5",
      });
      const label = `${text} ${cardIds.length}`;
      assert.equal(bodies.length, 1, label);
      assert.equal(reply.message, message, label);
      assert.deepEqual(reply.cards.map((card) => card.stock_id), cardIds, label);
    }
  }
});

test("a permission question after the customer picked and typed a number is nudged, then added", async () => {
  const { client, bodies } = fakeClient([
    answer({ message: "Want me to add 2 of these?" }),
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "this one 2 pcs" }, history: [{ role: "user", content: "torch" }, saficoShown] }), deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(choice(bodies[1]), "auto");
  assert.match(lastMessage(bodies[1]), PERMISSION_NUDGE);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
});

test("a permission question after a pick with no number typed is repaired without tools, not nudged", async () => {
  // Without a typed number update_enquiry can only refuse: the tool-less repair keeps the rest of the answer. The pick is a tap.
  const { client, bodies } = fakeClient([
    answer({ message: "The Safico runs on gas. Want me to add it?" }),
    answer({ message: "The Safico runs on gas. How many do you need?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "select_product", stockId: "BTS-8026D" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }), deps: deps(), client, model: "claude-sonnet-5",
  });
  assert.equal(bodies.length, 2);
  assert.equal(choice(bodies[1]), "none");
  assert.match(lastMessage(bodies[1]), /Don't ask permission to add it/);
  assert.ok(!PERMISSION_NUDGE.test(JSON.stringify(bodies[1].messages)));
  assert.equal(reply.message, "The Safico runs on gas. How many do you need?");
});

test("the turn log names why the tool rounds stopped", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  await afterUpdate("the 970S one", { action: "add", stock_id: "970S", quantity: 20 });
  const thanks = fakeClient([answer({ message: "You're welcome." })]);
  await runAgentTurn({ request: request({ event: { type: "text", text: "thank you" } }), deps: deps(), client: thanks.client, model: "claude-sonnet-5" });
  const logs = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").map((call) => call.arguments[1] as Record<string, unknown>);
  assert.deepEqual(logs.map((log) => [log.stopped, log.forcedEarly]), [["ask", false], ["thanks", false]]);
});

// exam 3, c08-stress T12: SB3027's re-check timed out, its note sat under "Enquiry changes since last turn", and Claire said an
// earlier step had accidentally removed it.
const scissors = product({ stock_id: "SB3027", name: "Stainless Steel Detachable Household Kitchen Scissors L20.5cm", list_price: 10 });
const scissorsUnchecked = request({ event: { type: "text", text: "ok so how i buy. website can?" }, enquiry: [{ stockId: "SB3027", quantity: 2 }, { stockId: "970S", quantity: 3 }] });

test("a line whose live re-check fails is shown to Claude as still on the enquiry, never as a change", async () => {
  const { client, bodies } = fakeClient([answer({ message: "Yes, each product's store page has Add to Cart." })]);
  const reply = await runAgentTurn({ request: scissorsUnchecked, deps: fakeDeps([scissors, blowtorch], { SB3027: "fail" }), client, model: "claude-sonnet-5" });
  const context = contextText(bodies[0]);
  assert.match(context, /"unchecked_lines":\[\{"code":"SB3027","quantity":2\}\]/);
  assert.match(context, /still on the customer's enquiry/);
  assert.doesNotMatch(context, /Enquiry changes since last turn/);
  assert.deepEqual(reply.enquiry.lines.map((line) => line.code), ["970S"]);
  assert.deepEqual(reply.enquiry.unchecked, ["SB3027"]);
});

test("a reply saying an unchecked line was removed is repaired, then fixed with one whole sentence", async () => {
  const claim = answer({ message: "Sorry, an earlier step accidentally removed your SB3027 line from the enquiry. Yes, each product's store page has Add to Cart." });
  for (const failing of ["live check", "catalogue lookup"]) {
    // When the catalogue lookup fails too, the enquiry-claim guard can't point at SB3027 and flags the sentence as well.
    const deps = fakeDeps([scissors, blowtorch], { SB3027: "fail" });
    if (failing === "catalogue lookup") deps.findByCode = (code) => (code === "SB3027" ? Promise.reject(new Error("SUPABASE_PRODUCT_500")) : Promise.resolve(blowtorch));
    const { client, bodies } = fakeClient([claim, claim]);
    const reply = await runAgentTurn({ request: scissorsUnchecked, deps, client, model: "claude-sonnet-5" });
    assert.equal(bodies.length, 2, failing);
    assert.equal(choice(bodies[1]), "none");
    assert.match(lastMessage(bodies[1]), /This line is still on the enquiry/);
    assert.equal(reply.message, "SB3027 is still on your enquiry. Yes, each product's store page has Add to Cart.", failing);
    assert.deepEqual(reply.enquiry.unchecked, ["SB3027"]);
  }
});

test("a code on the customer's enquiry that fits the phone pattern is never taken for a phone number", async () => {
  // A Patra code (3500-xxxx) fits the phone pattern; its line couldn't be looked up this turn, so only the enquiry names it.
  const plate = product({ stock_id: "3500-0018", name: "Patra Rim Plate 18cm", list_price: 4 });
  const deps = fakeDeps([plate, blowtorch]);
  deps.findByCode = (code) => (code === "3500-0018" ? Promise.reject(new Error("SUPABASE_PRODUCT_500")) : Promise.resolve(blowtorch));
  const claim = answer({ message: "Sorry, an earlier step removed your 3500-0018 line. Yes, each product's store page has Add to Cart." });
  const { client } = fakeClient([claim, claim]);
  const reply = await runAgentTurn({ request: { ...scissorsUnchecked, enquiry: [{ stockId: "3500-0018", quantity: 2 }, { stockId: "970S", quantity: 3 }] }, deps, client, model: "claude-sonnet-5" });
  assert.deepEqual(reply.enquiry.unchecked, ["3500-0018"]);
  assert.equal(reply.message, "3500-0018 is still on your enquiry. Yes, each product's store page has Add to Cart.");
});

// Owner decision 2: code works out the GST estimate (exam 4: 18 of the 19 chats that asked about GST were refused).
const otherThing = product({ stock_id: "OTHER-1", name: "OTHER THING", list_price: 5 });
const saficoTwo = [{ stockId: "BTS-8026D", quantity: 2 }];
const ESTIMATE = "About $50.92 with GST (GST $4.20); the checkout or Sia Huat's quote shows the exact amount.";

test("asked for the total with GST, Claude gets code's estimate in the context and the answer goes out after 1 call", async () => {
  const { client, bodies } = fakeClient([answer({ message: ESTIMATE })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "total with gst how much" }, enquiry: saficoTwo }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.match(contextText(bodies[0]), /"grandTotalWithGst":50\.92,"gstOnTotal":4\.2/);
  assert.equal(bodies.length, 1);
  assert.equal(reply.message, ESTIMATE);
  // The enquiry bar, the PDF and the backup reply keep the totals before GST.
  assert.deepEqual(Object.keys(reply.enquiry.totals).sort(), ["grandTotal", "lineCount", "quantitiesByUom"]);
});

test("a follow-up to a GST question still gets the estimate; a total question two messages on does not", async () => {
  const history = [{ role: "user" as const, content: "total with gst how much" }, { role: "assistant" as const, content: ESTIMATE }];
  const followUp = fakeClient([answer({ message: "Yes, that's close: about $50.92 with GST." })]);
  await runAgentTurn({ request: request({ event: { type: "text", text: "ard 51 like that correct anot" }, history, enquiry: saficoTwo }), deps: deps(), client: followUp.client, model: "claude-sonnet-5" });
  assert.match(contextText(followUp.bodies[0]), /"grandTotalWithGst":50\.92,"gstOnTotal":4\.2/);
  const later = fakeClient([answer({ message: "It's $46.72 before GST." })]);
  const laterHistory = [...history, { role: "user" as const, content: "ok noted" }, { role: "assistant" as const, content: "Anything else?" }];
  await runAgentTurn({ request: request({ event: { type: "text", text: "total how much now" }, history: laterHistory, enquiry: saficoTwo }), deps: deps(), client: later.client, model: "claude-sonnet-5" });
  assert.doesNotMatch(contextText(later.bodies[0]), /grandTotalWithGst/);
});

test("while a line is unchecked, a total with GST is sent back for a repair that names it", async () => {
  // 2 of 3 GST replay drafts gave a figure with GST for the checked line only.
  const fixed = "The checkout or Sia Huat's quote shows the exact amount with GST.";
  const { client, bodies } = fakeClient([answer({ message: ESTIMATE }), answer({ message: fixed })]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "total with gst how much" }, enquiry: [...saficoTwo, { stockId: "OTHER-1", quantity: 1 }] }),
    deps: fakeDeps([safico, otherThing], { "OTHER-1": "fail" }), client, model: "claude-sonnet-5",
  });
  assert.doesNotMatch(contextText(bodies[0]), /grandTotalWithGst/);
  assert.equal(bodies.length, 2);
  assert.match(lastMessage(bodies[1]), /\$50\.92/);
  assert.equal(reply.message, fixed);
});

test("an estimate given earlier goes out again on a plain total question", async () => {
  // r4 c09-stress, replayed: "ok so final total how much ah, i tell boss" two turns after the estimate.
  const message = "Total is $46.72 before GST, about $50.92 with GST (GST $4.20).";
  const { client, bodies } = fakeClient([answer({ message })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: "ok so final total how much ah" }, enquiry: saficoTwo }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 1);
  assert.equal(reply.message, message);
});

test("removing the only unchecked line mid-turn allows the estimate afterwards", async () => {
  const message = `Removed the other thing. ${ESTIMATE}`;
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", { action: "remove", stock_id: "OTHER-1" }), answer({ message })]);
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "remove the other thing. then total with gst how much" }, enquiry: [...saficoTwo, { stockId: "OTHER-1", quantity: 1 }] }),
    deps: fakeDeps([safico, otherThing], { "OTHER-1": "fail" }), client, model: "claude-sonnet-5",
  });
  assert.match(lastMessage(bodies[1]), /grandTotalWithGst\\":50\.92,\\"gstOnTotal\\":4\.2/);
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, message);
  assert.equal(reply.enquiry.unchecked, undefined);
});

test("without an injected check, update_enquiry asks the turn's client: pickModel, thinking disabled, the check's prompt", async () => {
  const verdict = (value: Record<string, unknown>) => ({ ...answer({ message: "" }), id: "msg_check", content: [{ type: "text", text: JSON.stringify(value) }] }) as unknown as Anthropic.Message;
  const { client, bodies } = fakeClient([
    toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
    verdict({ verdict: "picked", sure: true, code: "", candidates: [], quantity: 2 }),
    answer({ message: "Got it: 2 Safico torches. Anything else?" }),
  ]);
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, saficoShown] }),
    deps: deps(), client, model: "claude-sonnet-5", pickModel: "claude-check-model",
  });
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
  assert.equal(bodies.length, 3);
  assert.deepEqual([bodies[1].model, bodies[1].system, bodies[1].thinking], ["claude-check-model", PICK_CHECK_PROMPT, { type: "disabled" }]);
  assert.match(String(bodies[1].messages[0].content), /NOW customer: "ok 2"\n<\/chat>/);
  assert.match(String(bodies[1].messages[0].content), /Proposed: add 2 \(unit PC\) of BTS-8026D "CASSETTE GAS TORCH BURNER SAFICO PRO" \$23\.36$/);
});

const twoAddsRound = (first: Record<string, unknown>, second: Record<string, unknown>) => ({
  ...toolCall("t1", "update_enquiry", {}),
  content: [{ type: "tool_use", id: "t1", name: "update_enquiry", input: first }, { type: "tool_use", id: "t2", name: "update_enquiry", input: second }],
}) as unknown as Anthropic.Message;

test("two adds in one round start both pick checks before either answers", async () => {
  // "these 2. 6 each" costs one check round, not two.
  const started: string[] = [];
  let release = () => {};
  const both = new Promise<void>((resolve) => { release = resolve; });
  const check: PickCheck = async (p) => {
    started.push(p.code);
    if (started.length === 2) release();
    await both;
    return { verdict: "picked", sure: true, code: null, candidates: [], quantity: p.quantity, ms: 0, proposed: p.code, action: p.action };
  };
  const { client } = fakeClient([
    twoAddsRound({ action: "add", stock_id: "970S", quantity: 2 }, { action: "add", stock_id: "BTS-8026D", quantity: 3 }),
    answer({ message: "Got it: 2 blow torches and 3 Safico torches. Anything else?" }),
  ]);
  const reply = await within(runAgentTurn({
    request: request({ event: { type: "text", text: "2 of the 970S and 3 of the BTS-8026D please" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => check, deadlineMs: 6_000, fallbackReserveMs: 1_000, lastCallMs: 1_000,
  }), 5_500);
  assert.equal(reply.provider, "anthropic");
  assert.deepEqual([...started].sort(), ["970S", "BTS-8026D"]);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 2], ["BTS-8026D", 3]]);
});

test("a swap in one round adds the new item first: a failed add keeps the old line and asks how many; with the number typed it completes", async () => {
  // r4 c09-persona idx 11: [remove old, add new] took the old line off while the new one was refused.
  const tong16 = product({ stock_id: "UT16HR", name: "Stainless Steel Utility Tong 16in", list_price: 3.85 });
  const lockTong = product({ stock_id: "UT16LR", name: "Stainless Steel Utility Tong with Locking Ring 16in", list_price: 4.9 });
  const text = "ok whatever. actually change the 16 inch ones to the one with the lock ring";
  const swap = async (typed: string, message: string) => {
    const { client, bodies } = fakeClient([twoAddsRound({ action: "remove", stock_id: "UT16HR" }, { action: "add", stock_id: "UT16LR", quantity: 4 }), answer({ message })]);
    const shown = { role: "assistant" as const, content: `Here's the one with a lock ring.${cardsNote([lockTong])}` };
    const reply = await checkedTurn({
      request: request({ event: { type: "text", text: typed }, history: [{ role: "user", content: "got one with lock ring?" }, shown], enquiry: [{ stockId: "UT16HR", quantity: 4 }] }),
      deps: fakeDeps([tong16, lockTong]), client, model: "claude-sonnet-5",
    });
    return { reply, bodies };
  };
  const failed = await swap(text, "How many of the locking-ring tong do you need?");
  const results = (failed.bodies[1].messages.at(-1)!.content as Array<{ type: string; tool_use_id: string; content: string }>).filter((item) => item.type === "tool_result").map((item) => [item.tool_use_id, JSON.parse(item.content).error]);
  assert.deepEqual(results, [["t1", "SWAP_NOT_DONE"], ["t2", "QTY_NOT_STATED"]]); // in call order, though the add ran first
  assert.equal(choice(failed.bodies[1]), "none");
  assert.match(lastMessage(failed.bodies[1]), ASK_NOTE);
  assert.deepEqual(failed.reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["UT16HR", 4]]);
  const done = await swap(`${text}, same 4`, "Got it: 4 locking-ring tongs. Anything else?");
  assert.deepEqual(done.reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["UT16LR", 4]]);
});

test("a swap from a chip or a plain yes keeps the old line when the new item's add fails", async () => {
  // A chip "Switch to the 16.5cm" or a "yes" has no swap words: [add new, remove old] took the old line off while the add failed.
  const small = product({ stock_id: "13128-0401", name: "S/S FINE MESH SKIMMER Ø15cm", list_price: 2.29 });
  const bigger = product({ stock_id: "13128-0402", name: "S/S FINE MESH SKIMMER Ø16.5cm", list_price: 2.75 });
  const history: AgentRequest["history"] = [
    { role: "user", content: "ok the 2.29 one lor, take 2" }, { role: "assistant", content: `Got it: 2 added.${cardsNote([small])}` },
    { role: "user", content: "eh wait ah. 15cm maybe too small for maggi" },
    { role: "assistant", content: `The 16.5cm is a bit bigger. Want to switch?${cardsNote([bigger])}` },
  ];
  for (const event of [{ type: "text", text: "Switch to the 16.5cm", chip: true }, { type: "text", text: "yes" }] as const) {
    const { client, bodies } = fakeClient([
      twoAddsRound({ action: "add", stock_id: "13128-0402", quantity: 2 }, { action: "remove", stock_id: "13128-0401" }),
      answer({ message: "How many of the 16.5cm skimmer would you like?" }),
    ]);
    const reply = await runAgentTurn({
      request: request({ event, history, enquiry: [{ stockId: "13128-0401", quantity: 2 }] }), deps: fakeDeps([small, bigger]), client, model: "claude-sonnet-5",
      pickCheck: () => fakePickCheck((p) => (p.action === "add" ? { quantity: null } : {})),
    });
    const results = (bodies[1].messages.at(-1)!.content as Array<{ type: string; content: string }>).filter((item) => item.type === "tool_result").map((item) => JSON.parse(item.content).error);
    assert.deepEqual(results, ["QTY_NOT_STATED", "SWAP_NOT_DONE"], event.text);
    assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["13128-0401", 2]], event.text);
  }
});

/** The same update_enquiry call in two rounds, then Claude's answer; the check answers as `answerFor` says. */
async function sameCallTwice(answerFor: Parameters<typeof fakePickCheck>[0], input: Record<string, unknown>, overrides: Partial<AgentRequest> = {}) {
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", input), toolCall("t2", "update_enquiry", input), answer({ message: "Which one would you like?" })]);
  await runAgentTurn({
    request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown], ...overrides }),
    deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => fakePickCheck(answerFor),
  });
  return { choices: bodies.map(choice), note: lastMessage(bodies.at(-1)!) };
}

test("a refusal repeated in the next round ends the tools: not picked answers, unclear or another pick asks which, a kept line stays", async () => {
  const add = { action: "add", stock_id: "BTS-8026D", quantity: 2 };
  // exam 4: 23 forced "which" stops asked "Just to confirm…?" about products the customer never picked.
  const notPicked = await sameCallTwice({ verdict: "not_picked" }, add);
  assert.deepEqual(notPicked.choices, ["auto", "auto", "none"]);
  assert.match(notPicked.note, ANSWER_NOTE);
  assert.doesNotMatch(notPicked.note, WHICH_NOTE);
  const unclear = await sameCallTwice({ verdict: "unclear", candidates: ["970S", "BTS-8026D"] }, add);
  assert.deepEqual(unclear.choices, ["auto", "auto", "none"]);
  assert.match(unclear.note, WHICH_NOTE);
  const other = await sameCallTwice({ verdict: "different", code: "970S", quantity: 2 }, add);
  assert.deepEqual(other.choices, ["auto", "auto", "none"]);
  assert.match(other.note, WHICH_NOTE);
  const kept = await sameCallTwice({ verdict: "not_picked" }, { action: "remove", stock_id: "BTS-8026D" }, { event: { type: "text", text: "so expensive leh" }, enquiry: [{ stockId: "BTS-8026D", quantity: 2 }] });
  assert.deepEqual(kept.choices, ["auto", "auto", "none"]);
  assert.match(kept.note, KEEP_NOTE);
  // PICKED_OTHER for another number is a new call, so the tools stay on.
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", add), toolCall("t2", "update_enquiry", { ...add, quantity: 3 }), answer({ message: "Which one would you like?" })]);
  await runAgentTurn({
    request: request({ event: { type: "text", text: "ok 2 or 3" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => fakePickCheck({ verdict: "different", code: "970S", quantity: null }),
  });
  assert.deepEqual(bodies.map(choice), ["auto", "auto", "auto"]);
});

test("the how-many stop needs a product the customer picked", async () => {
  // A code the check never confirmed (an unknown one, with Claude's untyped number): no how-many question about it.
  const unknown = await afterUpdate("the 970S one", { action: "add", stock_id: "NOPE-1", quantity: 2 });
  assert.match(lastMessage(unknown.bodies[1]), /QTY_NOT_STATED/);
  assert.deepEqual([unknown.second, unknown.asked], ["auto", false]);
  // The check picked it, with Claude's untyped number: ask how many.
  const picked = await afterUpdate("the 970S one", { action: "add", stock_id: "970S", quantity: 2 });
  assert.deepEqual([picked.second, picked.asked], ["none", true]);
  // r4 c06-persona idx 14 shape: a GST question, and Claude sends quantity 0 for a card shown earlier.
  const gst = await afterUpdate("I ask gst is 9% or not only. yes or no", { action: "add", stock_id: "970S", quantity: 0 });
  assert.match(lastMessage(gst.bodies[1]), /INVALID_INPUT/);
  assert.deepEqual([gst.second, gst.asked], ["auto", false]);
  // A tapped card is picked: quantity 0 for it asks how many.
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 0 }), answer({ message: "How many do you need?" })]);
  await checkedTurn({ request: request({ event: { type: "select_product", stockId: "970S" }, history: [{ role: "user", content: "blow torch" }, torchShown] }), deps: deps(), client, model: "claude-sonnet-5" });
  assert.deepEqual([choice(bodies[1]), ASK_NOTE.test(lastMessage(bodies[1]))], ["none", true]);
});

test("a permission question about a product the customer named but Claude never proposed gets one check, and a nudge only on a sure pick", async () => {
  // r4 c02-persona idx 8 shape: "shall I add 2 of the MX1000" after the customer had named it is the confirm step the owner ruled out.
  const message = "The Safico runs on gas. Want me to add 2 of the Safico?";
  const cases: Array<[Parameters<typeof fakePickCheck>[0], boolean]> = [[{ quantity: 2 }, true], [{ sure: false }, false], [{ verdict: "not_picked" }, false]];
  for (const [answerFor, nudged] of cases) {
    const check = fakePickCheck(answerFor);
    const { client, bodies } = fakeClient([
      answer({ message }),
      toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }),
      answer({ message: "Got it: 2 Safico torches. Anything else?" }),
    ]);
    const reply = await runAgentTurn({
      request: request({ event: { type: "text", text: "the safico one, need 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
      deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => check,
    });
    const label = JSON.stringify(answerFor);
    assert.deepEqual([check.calls[0].code, check.calls[0].action, check.calls[0].quantity], ["BTS-8026D", "add", null], label);
    assert.equal(check.calls.length, nudged ? 2 : 1, label); // the nudged add gets its own check with the number
    if (nudged) {
      assert.deepEqual([check.calls[1].code, check.calls[1].action, check.calls[1].quantity], ["BTS-8026D", "add", 2], label);
      assert.match(lastMessage(bodies[1]), PERMISSION_NUDGE, label);
      assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]], label);
    } else {
      assert.equal(bodies.length, 1, label);
      assert.equal(reply.message, message, label);
    }
  }
});

test("no permission nudge when the pick check leaves too little time for the nudged round", async () => {
  // The check is a model call (1-3 s): a round that fitted before it may not fit after, and a nudge its forced call can't act on
  // only contradicts the time note.
  const sure = fakePickCheck({ quantity: 2 });
  const slow: PickCheck = (p) => new Promise((resolve) => setTimeout(resolve, 1_000)).then(() => sure(p));
  const { client, bodies } = fakeClient([
    answer({ message: "The Safico runs on gas. Want me to add 2 of the Safico?" }),
    answer({ message: "The Safico runs on gas. I can't add it right now, please try again in a moment." }),
  ]);
  // 16.5 s of work time: the check starts with about 16.5 s left and ends with about 15.5 s, under the 16 s a round needs.
  const reply = await runAgentTurn({
    request: request({ event: { type: "text", text: "the safico one, need 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
    deps: deps(), client, model: "claude-sonnet-5", pickCheck: () => slow, deadlineMs: 26_500, lastCallMs: 16_000,
  });
  assert.equal(reply.provider, "anthropic");
  assert.equal(sure.calls.length, 1);
  assert.ok(!bodies.some((body) => PERMISSION_NUDGE.test(JSON.stringify(body.messages))));
});

/** A client whose pick-check calls never answer until aborted; Claire's own calls get the scripted responses. */
function checksHang(responses: Array<Anthropic.Message | Error>) {
  const { client, bodies } = fakeClient(responses);
  let checks = 0;
  const hanging: AgentClient = {
    messages: {
      create: (body, options) => {
        if (body.system !== PICK_CHECK_PROMPT) return client.messages.create(body, options);
        checks += 1;
        return new Promise((_, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
  };
  return { client: hanging, bodies, checks: () => checks };
}

test("a pick check that never answers is cut at its budget and Claire asks; with under a second to spare no check is made", async () => {
  const run = async (lastCallMs: number) => {
    const hang = checksHang([toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }), answer({ message: "Is it the Safico gas torch burner BTS-8026D?", card_ids: ["BTS-8026D"] })]);
    const started = performance.now();
    // 15 s of work time: the check gets what the last call leaves, 1.5 s or 0.5 s.
    const reply = await within(runAgentTurn({
      request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, twoCardsShown] }),
      deps: deps(), client: hang.client, model: "claude-sonnet-5", deadlineMs: 16_000, fallbackReserveMs: 1_000, lastCallMs,
    }), 10_000);
    return { reply, ms: performance.now() - started, checks: hang.checks(), result: lastMessage(hang.bodies[1]) };
  };
  const cut = await run(13_500);
  assert.equal(cut.reply.provider, "anthropic");
  assert.ok(cut.ms < 4_000, `${Math.round(cut.ms)} ms`);
  assert.equal(cut.checks, 1);
  assert.match(cut.result, /PICK_UNCHECKED/);
  assert.deepEqual(cut.reply.enquiry.lines, []);
  assert.deepEqual(cut.reply.cards.map((card) => card.stock_id), ["BTS-8026D"]);
  const none = await run(14_500);
  assert.equal(none.reply.provider, "anthropic");
  assert.equal(none.checks, 0);
  assert.match(none.result, /PICK_UNCHECKED/);
});

test("the turn log adds the pick verdicts, the tap passes and each update's result, never text", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const { client } = fakeClient([toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }), answer({ message: "Got it: 2 Safico torches. Anything else?" })]);
  await checkedTurn({ request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, saficoShown] }), deps: deps(), client, model: "claude-sonnet-5" });
  const tapped = fakeClient([toolCall("t1", "update_enquiry", { action: "add", stock_id: "970S", quantity: 2 }), answer({ message: "Got it: 2 blow torches. Anything else?" })]);
  await checkedTurn({ request: request({ event: { type: "select_product", stockId: "970S" }, history: [{ role: "user", content: "I need 2 blow torches" }, twoCardsShown] }), deps: deps(), client: tapped.client, model: "claude-sonnet-5" });
  const logs = info.mock.calls.filter((call) => call.arguments[0] === "[api/agent] turn").map((call) => call.arguments[1] as Record<string, unknown>);
  assert.deepEqual(logs.map((log) => [log.picks, log.pickFast, log.updates]), [[["add:picked:0"], 0, ["add:ok"]], [[], 1, ["add:ok"]]]);
  assert.doesNotMatch(JSON.stringify(logs), /ok 2|safico|blow torch|got it/i);
});

/** Answers with these responses in turn, then never answers until its signal aborts (the owner's 10 s Claude call, 2026-09-30). */
function answersThenHangs(responses: Anthropic.Message[]): AgentClient {
  return {
    messages: {
      create: (body, options) => {
        const next = responses.shift();
        return next ? Promise.resolve(next) : hangingClient.messages.create(body, options);
      },
    },
  };
}

test("owner 2026-09-30: a turn that runs out of time after its searches asks for more detail, not unrelated pans", async () => {
  const griddle = product({ stock_id: "PA10313", name: "ELECTRIC GRIDDLE", third_category: "Griddles" });
  const gnPan = product({ stock_id: "1165EBK", name: "MELAMINE GN PAN", third_category: "Gastronorm pans" });
  const shop = fakeDeps([griddle, gnPan]);
  // The real search ranks rows by any word: "prata pan maybe" found only melamine GN pans.
  shop.searchDirect = async (query) => [griddle, gnPan].filter((item) => item.name.toLowerCase().split(" ").some((word) => query.toLowerCase().split(/\s+/).includes(word)));
  const client = answersThenHangs([toolCall("t1", "search_catalogue", { queries: ["prata pan", "griddle"] })]);
  // A reserve under STAND_IN_MS keeps no time for a rescue call: the cut goes straight to the backup reply.
  const reply = await within(runAgentTurn({
    request: request({ event: { type: "text", text: "prata pan maybe" } }), deps: shop, client, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500,
  }), 2_500);
  assert.equal(reply.provider, "fallback");
  assert.deepEqual(reply.cards, []);
  assert.match(reply.message, /^Sorry, I don't have a clear match/);
  assert.doesNotMatch(reply.message, /trouble/);
});

test("an add that went through before the turn ran out of time is said in the backup reply", async () => {
  const client = answersThenHangs([toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 })]);
  const reply = await within(checkedTurn({
    request: request({ event: { type: "text", text: "ok 2" }, history: [{ role: "user", content: "torch" }, saficoShown] }),
    deps: deps(), client, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500,
  }), 2_500);
  assert.equal(reply.provider, "fallback");
  assert.equal(reply.message, "Done: 2 PC CASSETTE GAS TORCH BURNER SAFICO PRO (BTS-8026D) is on your enquiry. Anything else?");
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 2]]);
});

test("an add that lands while the backup reply searches is neither shown nor said (r6 skeptic g)", async () => {
  const shop = deps();
  const search = shop.searchDirect;
  let searching = () => {};
  const searchStarted = new Promise<void>((resolve) => { searching = resolve; });
  // The backup's own search of the customer's words: the add's pick check lands while it runs.
  shop.searchDirect = async (query, limit) => {
    searching();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return search(query, limit);
  };
  const late = fakePickCheck();
  const client = answersThenHangs([toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 })]);
  const reply = await within(runAgentTurn({
    request: request({ event: { type: "text", text: "2 of the safico torch" }, history: [{ role: "user", content: "torch" }, saficoShown] }),
    deps: shop, client, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500,
    pickCheck: () => async (p) => { await searchStarted; return late(p); },
  }), 2_500);
  assert.equal(reply.provider, "fallback");
  assert.equal(late.calls.length, 1);
  assert.deepEqual(reply.enquiry.lines, []);
  assert.doesNotMatch(reply.message, /^Done/);
});

test("a card tap that runs out of time asks for the tap again", async () => {
  const reply = await within(runAgentTurn({
    request: request({ event: { type: "select_product", stockId: "970S" } }), deps: deps(), client: hangingClient, model: "claude-sonnet-5", deadlineMs: 1_500, fallbackReserveMs: 500,
  }), 2_500);
  assert.equal(reply.provider, "fallback");
  assert.match(reply.message, /^Sorry, I couldn't open that one just now\. Could you tap it again\?/);
});

// r8 R02, R09: a search result whose read ran past its limit went out "Price to be confirmed" with time left in the turn.
const torchSearch = toolCall("t1", "search_catalogue", { queries: ["torch"] });
const reads = (lookups: ReturnType<typeof fakeDeps>, code: string) => lookups.calls.filter((call) => call === `late:${code}` || call === `live:${code}`);

test("this turn's card whose read ran late is read again before the reply goes out (r8 R02, R09)", async () => {
  const lookups = fakeDeps([blowtorch, safico], { "970S": "timeout-once" });
  const { client, bodies } = fakeClient([torchSearch, answer({ message: "This one is a handheld kitchen torch.", card_ids: ["970S"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: lookups, client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 2);
  assert.deepEqual(reads(lookups, "970S"), ["late:970S", "live:970S"]);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status, card.list_price]), [["970S", "in_stock", 31.31]]);
  // Named by its code without a card (a 6th item past the card cap), it is read again too; an unnamed one isn't.
  const lighter = product({ stock_id: "L1", name: "TORCH LIGHTER" });
  const named = fakeDeps([blowtorch, safico, lighter], { "970S": "timeout-once", L1: "timeout-once" });
  const second = fakeClient([torchSearch, answer({ message: "970S is a handheld kitchen torch." })]);
  await runAgentTurn({ request: request({}), deps: named, client: second.client, model: "claude-sonnet-5" });
  assert.deepEqual([reads(named, "970S"), reads(named, "L1")], [["late:970S", "live:970S"], ["late:L1"]]);
});

test("in an outage, with no read landing this turn, a late product is read once and its card stays unconfirmed (r8 R02, R09)", async () => {
  const outage = fakeDeps([blowtorch, safico], { "970S": "timeout", "BTS-8026D": "timeout" });
  const { client } = fakeClient([torchSearch, answer({ message: "Here it is; its stock still needs checking.", card_ids: ["970S"] })]);
  const reply = await runAgentTurn({ request: request({}), deps: outage, client, model: "claude-sonnet-5" });
  assert.deepEqual([reads(outage, "970S"), reads(outage, "BTS-8026D")], [["late:970S"], ["late:BTS-8026D"]]);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["970S", "unknown"]]);
});

test("a read that failed for another reason, or found the listing gone, is not read again (r8 R01, R02)", async () => {
  for (const override of ["fail", "gone"] as const) {
    const lookups = fakeDeps([blowtorch, safico], { "970S": override });
    let attempts = 0;
    const fetchLive = lookups.fetchLive;
    lookups.fetchLive = (url, ms) => {
      if (url === blowtorch.source_url) attempts += 1;
      return fetchLive(url, ms);
    };
    // A gone listing is left out of the search results, so Claude has no card for it.
    const { client } = fakeClient([torchSearch, answer({ message: "I checked the 970S for you.", card_ids: override === "fail" ? ["970S"] : [] })]);
    const reply = await runAgentTurn({ request: request({}), deps: lookups, client, model: "claude-sonnet-5" });
    assert.deepEqual([reply.provider, attempts, reply.cards.map((card) => card.stock_status)], ["anthropic", 1, override === "fail" ? ["unknown"] : []], override);
  }
});

test("a late product's second read that stalls holds the reply about 4 s at most, and its card stays unconfirmed (r8 R09)", async () => {
  const lookups = fakeDeps([blowtorch, safico], { "970S": "timeout-once" });
  let attempts = 0;
  const fetchLive = lookups.fetchLive;
  // The round's read runs late; the second never answers.
  lookups.fetchLive = (url, ms) => {
    if (url !== blowtorch.source_url) return fetchLive(url, ms);
    attempts += 1;
    return attempts === 1 ? fetchLive(url, ms) : new Promise(() => undefined);
  };
  const { client } = fakeClient([torchSearch, answer({ message: "This one is a handheld kitchen torch.", card_ids: ["970S"] })]);
  const started = performance.now();
  const reply = await within(runAgentTurn({ request: request({}), deps: lookups, client, model: "claude-sonnet-5" }), 7_000);
  const ms = performance.now() - started;
  assert.ok(ms > 3_500 && ms < 5_000, `${Math.round(ms)} ms`);
  assert.equal(attempts, 2);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["970S", "unknown"]]);
});

test("an add refused as STOCK_UNVERIFIED is never said to be added, though its card is read again in stock (r8 R02)", async () => {
  const claim = answer({ message: "Added 2 Safico torch burners (BTS-8026D) to your enquiry.", card_ids: ["BTS-8026D"] });
  const lookups = fakeDeps([blowtorch, safico]);
  let attempts = 0;
  const fetchLive = lookups.fetchLive;
  // The round's early lookup and the add's own live check both run late; the read before the reply lands.
  lookups.fetchLive = (url, ms) => {
    if (url !== safico.source_url) return fetchLive(url, ms);
    attempts += 1;
    return attempts <= 2 ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : fetchLive(url, ms);
  };
  const { client, bodies } = fakeClient([toolCall("t1", "update_enquiry", { action: "add", stock_id: "BTS-8026D", quantity: 2 }), claim, claim, claim]);
  // The enquiry's 970S line is read first, so the store answered a read this turn.
  const reply = await checkedTurn({
    request: request({ event: { type: "text", text: "2 of the BTS-8026D" }, enquiry: [{ stockId: "970S", quantity: 1 }] }), deps: lookups, client, model: "claude-sonnet-5",
  });
  assert.match(JSON.stringify(bodies[1].messages.at(-1)), /STOCK_UNVERIFIED/);
  assert.match(JSON.stringify(bodies[2].messages.at(-1)), NUDGE);
  assert.match(JSON.stringify(bodies[3].messages.at(-1)), /The enquiry didn't change/);
  assert.equal(attempts, 3);
  assert.deepEqual(reply.enquiry.lines.map((line) => [line.code, line.quantity]), [["970S", 1]]);
  assert.doesNotMatch(reply.message, /\badded\b/i);
  assert.deepEqual(reply.cards.map((card) => [card.stock_id, card.stock_status]), [["BTS-8026D", "in_stock"]]);
});

test("a reply that calls a price unconfirmed after the card re-check priced it is repaired with the live price (r8 R02, R09)", async () => {
  const lookups = fakeDeps([blowtorch, safico], { "970S": "timeout-once" });
  const { client, bodies } = fakeClient([
    torchSearch,
    answer({ message: "Kitchen torch 970S: price not yet confirmed live.", card_ids: ["970S"] }),
    answer({ message: "Kitchen torch 970S: $31.31 ex GST.", card_ids: ["970S"] }),
  ]);
  const reply = await runAgentTurn({ request: request({}), deps: lookups, client, model: "claude-sonnet-5" });
  assert.equal(bodies.length, 3);
  const repairAsk = JSON.stringify(bodies[2].messages.at(-1));
  assert.ok(repairAsk.includes(PRICE_HEDGE_PREFIX));
  assert.match(repairAsk, /970S \$31\.31 \/ PC, in stock/);
  assert.equal(reply.message, "Kitchen torch 970S: $31.31 ex GST.");
  assert.deepEqual(reply.cards.map((card) => card.stock_status), ["in_stock"]);
});

test("a three-search round reads 6 results per search, not 10 (r8 R02, R09)", async () => {
  const many = Array.from({ length: 12 }, (_, index) => product({ stock_id: `T${index + 1}`, name: `TORCH ${index + 1} BURNER LIGHTER` }));
  const lookups = fakeDeps(many);
  const search = (id: string, item: string) => ({ type: "tool_use", id, name: "search_catalogue", input: { queries: [item] } });
  const threeItems = { ...toolCall("t1", "search_catalogue", {}), content: [search("t1", "torch"), search("t2", "burner"), search("t3", "lighter")] } as unknown as Anthropic.Message;
  const { client, bodies } = fakeClient([threeItems, answer({ message: "Here is what I found." })]);
  await runAgentTurn({ request: request({}), deps: lookups, client, model: "claude-sonnet-5" });
  const results = (bodies[1].messages.at(-1)!.content as Array<{ content: string }>).map((block) => JSON.parse(block.content).products.length);
  assert.deepEqual(results, [6, 6, 6]);
  // The turn memo reads each page once: the three searches share the same 6.
  assert.equal(lookups.calls.filter((call) => call.startsWith("live:")).length, 6);
});

// r8 M03, M09, R02, the tester's words.
const sixItems = "Please find all six items: spice/coffee grinder; black mesh shelf liner; blue nitrile gloves medium; grey cut-resistant glove large; 50ml disposable mini sauce pan; red 14cm cast-iron casserole. Give one catalogue code and price per item. Keep all six separate and do not add them yet.";
const six = [
  product({ stock_id: "MC11", name: "Ad Hoc Stainless Steel Coffee Grinder, Moro Ceracut XL", list_price: 84.31 }),
  product({ stock_id: "07-00019", name: "Safico Pro Mesh Bar Shelf Liner W60xL300cm, Black", list_price: 37.52, uom_id: "ROLL" }),
  product({ stock_id: "R52232D", name: "Pal Powderfree Nitrile Glove, Medium, Blue", list_price: 9.08, uom_id: "BOX" }),
  product({ stock_id: "08-00840", name: "Safico Pro Cut Resistant Glove Large, Grey", list_price: 18.26 }),
  product({ stock_id: "VO57143", name: "Solia Sugarcane Pulp Mini Sauce Pan, 50ml", list_price: 24.31, uom_id: "PKT" }),
  product({ stock_id: "Y-TC-14-K2-RD", name: "Lava Cast Iron Round Casserole Ø14cm, Red", list_price: 188.99 }),
];
const toolRound = (calls: Array<[name: string, input: unknown]>) => ({
  ...toolCall("t0", calls[0][0], calls[0][1]), content: calls.map(([name, input], i) => ({ type: "tool_use", id: `t${i}`, name, input })),
}) as unknown as Anthropic.Message;

test("a list of six searches whose answer ends 'None added yet' goes out as it is (r8 R02)", async () => {
  const words = ["coffee grinder", "shelf liner", "nitrile glove", "cut resistant glove", "mini sauce pan", "cast iron casserole"];
  const message = `${six.map((item, i) => `${i + 1}. ${item.name}, ${item.stock_id} - $${item.list_price.toFixed(2)}`).join("\n")}\nNone added yet.`;
  const { client, bodies } = fakeClient([toolRound(words.map((word) => ["search_catalogue", { queries: [word] }])), answer({ message, card_ids: six.slice(0, 5).map((item) => item.stock_id) })]);
  const reply = await runAgentTurn({ request: request({ event: { type: "text", text: sixItems } }), deps: fakeDeps(six), client, model: "claude-sonnet-5" });
  // No nudge and no repair: R02 took four Claude calls and ended "That change isn't on your enquiry yet. Which item and how many would you like?"
  assert.equal(bodies.length, 2);
  assert.equal(reply.message, message);
});
