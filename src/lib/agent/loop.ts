// src/lib/agent/loop.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { beginModelCall, recordClaudeUsage, type ClaudeUsage } from "@/lib/model-usage";
import { prepareVisionPhoto } from "@/lib/product-image-crop";
import { CHIP_PREFIX, TAP_PREFIX, customerWords, type AgentReply, type AgentRequest } from "./contract";
import { enquiryTotals, gstWords, listItemCount, sameQuantityText, statesAnyQuantity, verifyEnquiry } from "./enquiry";
import { liveCheck, productFact, turnDeps, withTimeout, type CheckedProduct, type FactDeps } from "./facts";
import { buildFallbackReply } from "./fallback";
import {
  CLAIM_ISSUE_PREFIX, ENQUIRY_CLAIM_PREFIX, KEPT_LINE_PREFIX, LINK_ISSUE_PREFIX, MONEY_ISSUE_PREFIX, allowedCents, applyFixers, askedForChange, asksConfirmStep, brokenLinkCodes, customerMessage,
  dropRepeatedPitch, enquiryClaimIssues, issueCode, noCardFixer, permissionCodes, removeAmounts, removeClaims, removeLinks, reviewAnswer, storeLinks, tidyMessage, unfixable, unknownStoreLinks, unverifiedAmounts,
  withoutAllFoundClaims, withoutCardPointers, withoutChangedCards, withoutEnquiryClaims, withoutKeptLineClaims, withNamedCards, withoutRangeCards, withoutRepeatedCloser, withoutRepeatedSet, withoutWrongStockCounts,
  type EarlierTurns, type FinalAnswer, type Fixer, type Review,
} from "./guards";
import { codePattern, pickEvidence, same } from "./picks";
import { CLAIRE_AGENT_PROMPT } from "./prompt";
import { agentTools, errorCode, keepBest, lookupDetails, refusalKey, runTool, startPickCheck, totalsForClaude, uncheckedNote, updateCode as codeOf, withDetails, type ToolOutcome, type TurnContext } from "./tools";
import { modelPickCheck, pickCheckCache, pickView, type PickCheck } from "./verify";

export type AgentClient = {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
};

export const MAX_TOOL_ROUNDS = 3;
export const AGENT_EFFORT = "low" as const;
const TURN_DEADLINE_MS = 45_000;
const FALLBACK_RESERVE_MS = 10_000;
// The backup reply alone: its search and live checks took 1-2 s. The rest of the reserve goes to the call that answers (owner's chat,
// 2026-09-30: "prata pan maybe" got the backup reply when a slow answer call was cut at 35 s with 10 s still held for it). It assumes
// the backup reply makes no Claude call: if one is ever added there, this must grow.
const STAND_IN_MS = 4_000;
// Enquiry re-checks get at least this long even when the work budget is smaller. The time comes out of the
// backup reply's reserve; with a nearly spent budget the turn runs slightly over rather than time out every line.
const VERIFY_FLOOR_MS = 1_000;
const STYLE_REPAIR_MIN_MS = 8_000; // a style-only repair needs about this long; with less left, the tidied answer is sent
const LAST_CALL_MS = 12_000; // below this, the next Claude call answers with what it has
const EARLIER_CARD_CHECK_MS = 2_000;
const CARD_RECHECK_MS = 4_000; // a lone store read from the function took 0.9-3.6 s (r8)
const CLAIM_NUDGE_MIN_MS = 15_000; // the nudge costs a Claude round, and the reply may still need a repair after it
// A pasted list longer than this gets one round of lookups (exam 3, s01-B T0: 8 items ran 2-3 tool rounds and got a stand-in).
const LIST_ITEMS_PER_TURN = 3;
// A plain thank-you needs no lookups (exam 3, s01-B T3: 3-4 tool rounds, then a stand-in); "thank u", "tysm" and a trailing emoji too.
const THANKS_ONLY = /^\s*(?:ok(?:ay)?[\s,.]+)?(?:thanks?|thank (?:you|u)|thx|ty|tq|tysm)(?:\s+(?:so much|a lot|lah?|you))?[\s.!\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]*$/iu;

const finalSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message", "card_ids", "chips", "show_contact"],
  properties: {
    message: { type: "string" },
    card_ids: { type: "array", items: { type: "string" } },
    chips: { type: "array", items: { type: "string" } },
    show_contact: { type: "boolean" },
  },
};
// A doubly escaped character ("\\u2014" in the JSON) reached the customer as six raw characters, not a dash (r4 c11-A idx 1),
// and a doubly escaped quote as \" ("Ø5\" up to Ø21\"", live 1 Oct): after a number it is an inch mark, otherwise a quote
// (the prompt asks for single quotes). Decoded here, so repairs are decoded too and the guards read the real text.
const decodeEscapes = (text: string) => text
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/(?<=\d)\\"/g, "″")
  .replace(/\\"/g, "'");
const finalAnswerSchema = z.object({
  message: z.string().trim().transform(decodeEscapes),
  card_ids: z.array(z.string()),
  chips: z.array(z.string().transform(decodeEscapes)),
  show_contact: z.boolean(),
});
const CARDS_ONLY_MESSAGE = "Here are some options.";
const INVALID_ANSWER_ISSUE = "Your answer was not valid JSON with a non-empty message, card_ids, chips and show_contact. Answer with that JSON only.";
// Every sentence was unconfirmed and removed: say so and give a next step, not a dead end (r6).
const NOTHING_LEFT_MESSAGE = "Sorry, I can't confirm that from here. Could you ask it another way? Sia Huat sales can help too (details below).";
// The answer was only the card whose link the customer says doesn't open (exam 4, c08).
const BROKEN_LINK_MESSAGE = "Sorry, that link isn't opening for you. Tell me what you'd like to know about it, or Sia Huat sales can help (details below).";
const TIME_NOTE = "[Context from the system, not the customer] Time is nearly up: answer now with what you found. Nothing more can be looked up or changed this turn.";
// A cut with nothing looked up: 2 rescues in a local check said "Sia Huat does carry griddles" from no lookup, and one said
// "Sorry, got it: 2 ..." for an add that never ran (r6 skeptic).
const NOTHING_FOUND_NOTE = "[Context from the system, not the customer] Nothing could be looked up in time this turn, and nothing on the enquiry was added or changed. Don't suggest products or say what Sia Huat has or doesn't have. Say sorry briefly, answer only what the chat and the current enquiry already show, then ask one short question: if they asked to add or change something, say it isn't done yet and ask them to send it again; if they are looking for a product, ask what it's for, the size or the type.";
const CLAIM_NUDGE = "[Context from the system, not the customer] Your reply says the enquiry changed (or will change), but no update_enquiry call succeeded for that item in this turn. Call update_enquiry only for exactly what the customer picked and the number they typed; otherwise answer without saying it changed.";
// Conditional: the number the customer typed may be for another item.
const PERMISSION_NUDGE = "[Context from the system, not the customer] Don't ask permission to add. If the customer typed how many of this product, call update_enquiry now; otherwise ask how many, once.";
const ASK_NOTE = "[Context from the system, not the customer] update_enquiry needs a number the customer types for this item: ask how many, once. No more tools this turn.";
const WHICH_NOTE = "[Context from the system, not the customer] update_enquiry couldn't settle which product the customer means. No more tools this turn: ask the one question its result asked for (which of the fitting cards, naming them, or whether it's the named product), with those cards. Don't ask them to confirm a number they typed.";
const ANSWER_NOTE = "[Context from the system, not the customer] The customer hasn't picked this product. No more tools this turn: answer what they said; don't add it, don't ask them to confirm it, and don't say it was added.";
const KEEP_NOTE = "[Context from the system, not the customer] That line stays on the enquiry. No more tools this turn: say plainly it's still on, answer what they said, and don't ask them to confirm again.";
const LIST_NOTE = "[Context from the system, not the customer] That's all the lookups for this list this turn: answer now with what you found for the first items, one card each, and end with what's next by name ('Next: ...'). Don't say you'll look further. Nothing more can be looked up or changed this turn.";
const NOT_FINISHED: ToolOutcome = {
  content: JSON.stringify({ error: "NOT_FINISHED", note: "This didn't finish in time, so there is no result. Don't say what it found or changed." }), isError: true, error: "NOT_FINISHED",
};

/** The customer's last two typed messages (card and chip taps, and photos without a caption, excluded), newest first. */
export function recentCustomerTexts(request: AgentRequest) {
  const event = request.event;
  const current = event.type === "text" && !event.chip ? [event.text] : event.type === "image" && event.caption ? [event.caption] : [];
  const earlier = request.history
    .filter((item) => item.role === "user" && !item.content.startsWith(TAP_PREFIX) && !item.content.startsWith(CHIP_PREFIX))
    .flatMap((item) => customerWords(item.content) ?? [])
    .reverse();
  return [...current, ...earlier].slice(0, 2);
}

function historyMessages(request: AgentRequest): Anthropic.MessageParam[] {
  const items = [...request.history];
  while (items.length && items[0].role === "assistant") items.shift();
  return items.map((item) => ({ role: item.role, content: item.content }));
}

async function eventContent(request: AgentRequest, ctx: TurnContext, notes: string[]): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const event = request.event;
  if (event.type === "text") {
    blocks.push({ type: "text", text: `${event.voice ? "Customer (voice note, transcribed)" : "Customer"}: ${event.text}` });
  }
  if (event.type === "image") {
    // Raw phone photos can pass Claude's 5 MB base64 limit; the shrunk copy also costs fewer tokens.
    const photo = await prepareVisionPhoto(event.image).catch(() => null);
    const sent = `Customer sent a photo${event.caption ? ` with the message: ${event.caption}` : ""}`;
    if (photo) {
      const data = photo.image.dataUrl.slice(photo.image.dataUrl.indexOf(",") + 1);
      // Cached so later tool rounds in this turn re-read the photo instead of paying for it again.
      blocks.push({ type: "image", source: { type: "base64", media_type: photo.image.mimeType, data }, cache_control: { type: "ephemeral" } });
      blocks.push({ type: "text", text: `${sent}. Use match_photo to check the catalogue.` });
    } else {
      blocks.push({ type: "text", text: `${sent}, but it could not be opened. Ask for a smaller photo or a short description.` });
    }
  }
  if (event.type === "select_product") {
    const [tapped, details] = await Promise.all([
      ctx.deps.findByCode(event.stockId).then((found) => found && liveCheck(found, ctx.deps)).catch(() => null),
      lookupDetails(ctx, [event.stockId]),
    ]);
    if (tapped?.gone) ctx.gone.add(tapped.product.stock_id); // a removed listing's card is never shown again (r8)
    if (tapped && !tapped.gone) {
      const checked = keepBest(ctx, withDetails(tapped, details));
      blocks.push({ type: "text", text: `Customer tapped this product card to choose it: ${JSON.stringify(productFact(checked, true))}` });
    } else {
      blocks.push({ type: "text", text: `Customer tapped item ${event.stockId}, but it is no longer in the catalogue.` });
    }
  }
  const shown = [...ctx.shownIds].slice(-40).join(", ") || "none";
  const unchecked = uncheckedNote(ctx.uncheckedCodes);
  // The lines the browser still holds, as the customer has them (exam 3, c08-stress T12: Claude took one for a removal).
  const uncheckedLines = request.enquiry.filter((line) => ctx.uncheckedCodes.some((code) => same(code, line.stockId))).map((line) => ({ code: line.stockId, quantity: line.quantity }));
  const enquiry = { lines: ctx.lines, totals: totalsForClaude(ctx), ...(uncheckedLines.length ? { unchecked_lines: uncheckedLines } : {}) };
  blocks.push({
    type: "text",
    text: `[Context from the system, not the customer] Current enquiry: ${JSON.stringify(enquiry)}${unchecked ? `\n${unchecked}` : ""}${notes.length ? `\nEnquiry changes since last turn: ${notes.join(" ")}` : ""}\nItem codes already shown as cards: ${shown}`,
  });
  return blocks;
}

async function callClaude(client: AgentClient, model: string, messages: Anthropic.MessageParam[], toolChoice: "auto" | "none", signal: AbortSignal) {
  const finish = beginModelCall();
  const response = await client.messages.create({
    model,
    max_tokens: 4_096,
    // Caches the conversation so far, so a later tool round or repair in this turn re-reads it instead of paying for it again.
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: CLAIRE_AGENT_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: agentTools,
    tool_choice: { type: toolChoice },
    thinking: { type: "adaptive" },
    output_config: { effort: AGENT_EFFORT, format: { type: "json_schema", schema: finalSchema } },
    messages,
  }, { signal });
  finish(recordClaudeUsage(response.model ?? model, response.usage as unknown as ClaudeUsage, response.id));
  return response;
}

/** Claude's final JSON answer, or null when it does not fit the schema. An empty message is fine when cards carry the reply. */
function readFinal(response: Anthropic.Message): FinalAnswer | null {
  if (response.stop_reason !== "end_turn") throw new Error(`AGENT_STOP_${String(response.stop_reason).toUpperCase()}`);
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsed: ReturnType<typeof finalAnswerSchema.safeParse>;
  try {
    parsed = finalAnswerSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  if (parsed.data.message) return parsed.data;
  return parsed.data.card_ids.length ? { ...parsed.data, message: CARDS_ONLY_MESSAGE } : null;
}

/**
 * Cards Claude chose that this turn hasn't looked up but the customer has already seen or has on the enquiry, plus (when the
 * message quotes an amount code can't back yet) the cards of Claire's previous reply and earlier-shown codes named in the message:
 * looked up and live-checked by code now, so every card and price still comes from this turn's facts. This turn's own products whose
 * read ran late are read again the same way when the answer shows them or names their code.
 */
async function attachEarlierCards(
  final: FinalAnswer, ctx: TurnContext, previousCodes: string[], amountsUnbacked: boolean, timeLeft: () => number, tried: Set<string>,
): Promise<FinalAnswer> {
  // This turn's products whose live check ran past its limit in the tool round: read again when the answer shows or names them, so a
  // price the store gives isn't sent as "to be confirmed" (r8 R02, R09). Only while the store answered another read this turn: in an
  // outage a second read would only add its wait.
  const storeUp = [...ctx.seen.values()].some((item) => item.verified);
  const again = storeUp ? [...ctx.seen.values()].filter((item) => item.late).map((item) => item.product.stock_id) : [];
  const known = new Map([...ctx.shownIds, ...ctx.lines.map((line) => line.code), ...previousCodes, ...again].map((id) => [id.toLowerCase(), id]));
  const seen = new Map([...ctx.seen.keys()].map((id) => [id.toLowerCase(), id]));
  const named = [
    ...(amountsUnbacked ? [...previousCodes, ...[...known.values()].filter((id) => codePattern(id).test(final.message))] : []),
    ...again.filter((id) => codePattern(id).test(final.message)),
  ];
  // A code tried earlier this turn isn't looked up again after the repair: a stalled check would stall again.
  const wanted = [...new Set([...final.card_ids, ...named].map((id) => id.toLowerCase()))]
    .filter((id) => known.has(id) && !tried.has(id) && !ctx.seen.get(seen.get(id) ?? "")?.verified && !ctx.gone.has(known.get(id)!)).slice(0, 5);
  for (const id of wanted) tried.add(id);
  // One time limit covers each card's code lookup and live check together; a read of this turn's own product gets longer.
  const limit = wanted.some((id) => again.some((code) => same(code, id))) ? CARD_RECHECK_MS : EARLIER_CARD_CHECK_MS;
  const end = performance.now() + Math.max(1, Math.min(limit, timeLeft() - 1_000));
  const left = () => Math.max(1, end - performance.now());
  const details = lookupDetails(ctx, wanted.map((id) => known.get(id)!), left());
  await Promise.all(wanted.map(async (id) => {
    const found = ctx.seen.get(seen.get(id) ?? "")?.product ?? await withTimeout(ctx.deps.findByCode(known.get(id)!).catch(() => null), left(), null);
    if (!found) return;
    // A live check that stalls sends the card unconfirmed, like a search result that wasn't checked.
    const unconfirmed: CheckedProduct = { product: { ...found, stock_status: "unknown", in_stock: null, available_quantity: null }, verified: false };
    const ms = left();
    keepBest(ctx, withDetails(await withTimeout(liveCheck(found, ctx.deps, ms), ms, unconfirmed), await details));
  }));
  const spelled = new Map([...ctx.seen.keys()].map((id) => [id.toLowerCase(), id]));
  return { ...final, card_ids: final.card_ids.map((id) => spelled.get(id.toLowerCase()) ?? id) };
}

/** Rejects when the signal fires, so a stuck step cannot hold the turn past its deadline (the step itself keeps running). */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {};
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("AGENT_DEADLINE"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, expired]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** A failed step as a log code. SDK errors carry text that could echo the chat, so they log as a status or kind. */
function failureCode(error: unknown, deadline: AbortSignal) {
  const code = errorCode(error);
  if (!(error instanceof Error) || code !== error.name) return code;
  const status = (error as { status?: unknown }).status;
  // A status first: the forced answer and the repair run on past the 35 s deadline, and an API error there is not a deadline cut.
  return typeof status === "number" ? `API_${status}`
    : deadline.aborted ? "AGENT_DEADLINE"
    : /timed out/i.test(error.message) ? "API_TIMEOUT"
    : /aborted/i.test(error.message) ? "CLIENT_ABORT" : code;
}

/** A tool call this round ran: its name, what Claude sent and its error code, if it failed. */
type ToolCallDone = { name: string; input: unknown; error?: string };
/** An update_enquiry call's fields as Claude sent them (not yet checked). */
const updateFields = (input: unknown) => input as { action?: unknown; stock_id?: unknown; quantity?: unknown };
const updateCode = (input: unknown) => codeOf(updateFields(input));
/** An update_enquiry call's action for the turn log: one of the four, never other text. */
const updateAction = (input: unknown) => {
  const { action } = updateFields(input);
  return typeof action === "string" && /^(?:add|set|remove|clear)$/.test(action) ? action : "?";
};

/** A round's results for Claude and its calls, in call order. A call with no outcome yet didn't finish in time. */
function roundResults(content: Anthropic.ContentBlock[], outcomes: ReadonlyMap<string, ToolOutcome>): { results: Anthropic.ToolResultBlockParam[]; done: ToolCallDone[] } {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  const outcome = (call: Anthropic.ToolUseBlock) => outcomes.get(call.id) ?? NOT_FINISHED;
  return {
    results: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: outcome(call).content, is_error: outcome(call).isError })),
    done: calls.map((call) => ({ name: call.name, input: call.input, error: outcome(call).error })),
  };
}

/**
 * Runs the tool calls in Claude's response; each tool's name is added to `names` for the turn log, and each outcome to `outcomes`
 * as it lands, so a round the deadline cuts keeps what finished (and makes no enquiry change after it). Returns the round's results.
 */
async function runToolBlocks(content: Anthropic.ContentBlock[], ctx: TurnContext, names: string[], outcomes: Map<string, ToolOutcome>, deadline: AbortSignal) {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  names.push(...calls.map((call) => call.name));
  const updates = calls.filter((item) => item.name === "update_enquiry");
  // The round's searches share its live reads, and more than three at once are a list's (searchCatalogueTool, r8 R02, R09, M03).
  ctx.roundSearches = calls.filter((call) => call.name === "search_catalogue").length;
  const action = (call: Anthropic.ToolUseBlock) => updateFields(call.input).action;
  // Every update's pick check starts now, side by side ("these 2. 6 each" costs one check round, not two), and the adds' lookups
  // run together and fill the turn's memo, so the updates don't wait in turn.
  await Promise.all(updates.map(async (call) => {
    const { stock_id: code } = updateFields(call.input);
    const lookup = (action(call) === "add" || action(call) === "set") && typeof code === "string" && code.trim()
      ? ctx.deps.findByCode(code.trim()).then((found) => found && liveCheck(found, ctx.deps)).catch(() => null) : null;
    await Promise.all([startPickCheck(call.input, ctx), lookup]);
  }));
  // Enquiry updates change shared state, so they run one after another, adds and sets first: a swap's old line comes off only once
  // the new item is on (r4 c09-persona idx 11). A remove of a code the round also adds or sets keeps its place (a redo, not 4 + 6).
  const removeLast = (call: Anthropic.ToolUseBlock) => Number(action(call) === "remove"
    && !updates.some((other) => other !== call && action(other) !== "remove" && updateCode(other.input) === updateCode(call.input)));
  for (const call of [...updates].sort((a, b) => removeLast(a) - removeLast(b))) {
    // Once the deadline has cut the round, nothing more changes: the answer says these didn't finish (r6 skeptic: an add whose live
    // check stalled past the cut went onto the enquiry without the answer knowing).
    if (deadline.aborted) break;
    outcomes.set(call.id, await runTool(call.name, call.input, ctx));
  }
  // No lookup starts after the cut either.
  if (deadline.aborted) return roundResults(content, outcomes);
  await Promise.all(calls.filter((item) => item.name !== "update_enquiry").map(async (call) => {
    outcomes.set(call.id, await runTool(call.name, call.input, ctx));
  }));
  return roundResults(content, outcomes);
}

type Stop = "which" | "ask" | "answer" | "keep";
// A refusal again for a code refused before this round: only the customer can settle it. Exam 4: 23 forced "which" stops asked
// "Just to confirm...?" about products the customer never picked, so a plain "not picked" is answered instead.
const STUCK: Partial<Record<string, Stop>> = { NOT_PICKED: "answer", PICK_UNCLEAR: "which", PICK_UNCONFIRMED: "which", PICK_UNCHECKED: "which", REMOVE_REFUSED: "keep", SWAP_NOT_DONE: "keep" };
// The same code, action and number refused again (another number is a new call).
const BY_KEY: Partial<Record<string, Stop>> = { PICKED_OTHER: "which", QTY_NOT_FOR_ITEM: "which" };

/**
 * Why the tool rounds stop when only the customer can unblock update_enquiry: every call refused again (STUCK, BY_KEY; "which"
 * before "keep" before "answer"), or an add or set of a product the customer picked that needs a number they never typed ("ask")
 * (exam 3, c09-stress T7: three update rounds, 13.4 s). A swap's held remove waits on its add, so the add's error decides. Errors
 * another call can fix (OVER_STOCK, UNIT_MISMATCH, a missing stock_id, a quantity sent in pieces for cartons) leave the tools on,
 * and so does any other tool call in the round. before: the codes refused or kept, and the calls refused, before this round.
 */
function stopNote(done: ToolCallDone[], ctx: TurnContext, before: { codes: ReadonlySet<string>; keys: ReadonlySet<string> }, picked: (code: string) => boolean): Stop | null {
  if (!done.length || done.some((call) => call.name !== "update_enquiry" || !call.error)) return null;
  const judged = done.some((call) => call.error !== "SWAP_NOT_DONE") ? done.filter((call) => call.error !== "SWAP_NOT_DONE") : done;
  const stuck = judged.map((call) => (before.codes.has(updateCode(call.input)) && STUCK[call.error!])
    || (before.keys.has(refusalKey(updateFields(call.input))) && BY_KEY[call.error!]) || null);
  if (stuck.every((stop) => stop !== null)) return stuck.includes("which") ? "which" : stuck.includes("keep") ? "keep" : "answer";
  // "How many?" only about a product the customer picked (a tap, an enquiry line or a sure check): r2 c03-B idx 5 "Recommend" with
  // Claude's own number, and round 4's quantity-0 calls on GST questions, asked it about products nobody picked.
  const needsNumber = (call: ToolCallDone) => {
    const { action, quantity } = updateFields(call.input);
    const noNumber = !(Number.isInteger(quantity) && (quantity as number) > 0);
    return (action === "add" || action === "set") && updateCode(call.input) !== "" && picked(updateCode(call.input))
      && (call.error === "QTY_NOT_STATED" || ((call.error === "MISSING_FIELDS" || call.error === "INVALID_INPUT") && noNumber));
  };
  return judged.every(needsNumber) && !statesAnyQuantity(ctx.customerTexts) ? "ask" : null;
}

export async function runAgentTurn(input: {
  request: AgentRequest;
  deps: FactDeps;
  client: AgentClient;
  model: string;
  /** The whole turn's remaining time, backup reply included. */
  deadlineMs?: number;
  /** The last part of deadlineMs, kept back from lookups for the answer call and the backup reply. */
  fallbackReserveMs?: number;
  /** The last part of the reserve, kept for the backup reply alone. */
  standInMs?: number;
  /** With this little work time left after a tool round, the next Claude call must answer without tools. */
  lastCallMs?: number;
  /** The pick check update_enquiry asks (tests pass a fake); by default the app's own model through this turn's client. */
  pickCheck?: (ctx: TurnContext) => PickCheck;
  /** The model the default pick check calls; by default the turn's model (owner decision 1: Sonnet 5, thinking off). */
  pickModel?: string;
}): Promise<AgentReply> {
  const started = performance.now();
  const { request, client, model } = input;
  // This turn's lookups share one memo. The backup reply gets input.deps, so it never waits on a fetch this turn left running.
  const deps = turnDeps(input.deps);
  // A tapped card's lookup starts now, alongside the enquiry re-check; eventContent then reads it from the memo.
  if (request.event.type === "select_product") void deps.findByCode(request.event.stockId).then((found) => found && liveCheck(found, deps)).catch(() => null);
  const deadlineMs = input.deadlineMs ?? TURN_DEADLINE_MS;
  const fallbackReserveMs = input.fallbackReserveMs ?? FALLBACK_RESERVE_MS;
  const lastCallMs = input.lastCallMs ?? LAST_CALL_MS;
  const workMs = Math.max(1, Math.floor(deadlineMs - fallbackReserveMs));
  const deadline = AbortSignal.timeout(workMs);
  const timeLeft = () => workMs - (performance.now() - started);
  // The call that answers (a forced answer, the repair) may run on into the reserve, up to here.
  const answerMs = Math.max(workMs, Math.floor(deadlineMs - Math.min(input.standInMs ?? STAND_IN_MS, fallbackReserveMs)));
  const answerBy = AbortSignal.timeout(answerMs);
  const answerLeft = () => answerMs - (performance.now() - started);
  // After a cut at the work deadline, the answer call gets another go only when the turn keeps time for it past that deadline: a
  // turn that starts late may keep none, and its cut goes straight to the backup reply.
  const answerAfterCut = () => deadline.aborted && answerMs > workMs && answerLeft() > 0;
  const verified = await verifyEnquiry(request.enquiry, deps, Math.max(VERIFY_FLOOR_MS, Math.min(5_000, Math.floor(workMs / 3))));
  const recent = recentCustomerTexts(request);
  const picks = pickEvidence(request.history, request.event);
  const currentText = request.event.type === "text" && !request.event.chip ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null;
  // "same qty" reuses the one number typed a few messages back, so every quantity check sees it (owner question 4).
  const sameQty = sameQuantityText(currentText, picks.texts.filter((text) => !text.chip).map((text) => text.text));
  const ctx: TurnContext = {
    deps,
    seen: new Map(verified.products),
    lines: verified.lines,
    changes: [],
    uncheckedCodes: verified.unchecked,
    customerTexts: sameQty && !recent.includes(sameQty) ? [...recent, sameQty] : recent,
    currentText,
    // A chip tap can ask to clear the enquiry, but never states a quantity.
    clearTexts: request.event.type === "text" && request.event.chip ? [request.event.text, ...recent] : recent,
    image: request.event.type === "image" ? request.event.image : null,
    shownIds: new Set(request.shownProductIds),
    searches: [],
    refused: [],
    tapped: request.event.type === "select_product" ? request.event.stockId : null,
    // The check is made just below: it reads this context (the enquiry and this turn's lookups) each time it runs.
    checkPick: pickCheckCache((p) => check(p)),
    photoMatches: new Map(),
    kept: [],
    failedAdds: [],
    finalRefusal: false,
    refusedKeys: new Set(),
    pickFast: 0,
    // This text or the one before it: a follow-up ("ard 37 like that correct anot") comes right after the GST ask.
    gstAsked: recent.some((text) => gstWords.test(text)),
    gone: new Set(verified.gone),
  };
  // It must leave the last Claude call its time: with less than a second to spare it makes no call and update_enquiry asks.
  const check = input.pickCheck?.(ctx) ?? modelPickCheck({
    client, model: input.pickModel ?? model, request, view: () => pickView(ctx, request), budgetMs: () => timeLeft() - lastCallMs, signal: deadline,
  });
  const searchText = request.event.type === "text" ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null;
  const earlier: EarlierTurns = {
    cardSets: picks.replies.map((reply) => reply.cards.map((card) => card.code)),
    previousMessage: picks.replies.at(-1)?.text ?? null,
    replies: picks.replies.map((reply) => reply.text),
    currentText: searchText ?? "",
    // Links already in the chat may be given again: Claire's replies and their card notes, or a link the customer pasted.
    links: [...request.history.map((item) => item.content), searchText ?? ""].flatMap(storeLinks),
    previousLinks: storeLinks(request.history.findLast((item) => item.role === "assistant")?.content ?? ""),
  };
  // A plain thank-you is answered without tools; a photo, or "ok thanks" to the only card just shown (a yes), is not one.
  const thanksTurn = request.event.type === "text" && !request.event.chip && THANKS_ONLY.test(request.event.text)
    && !(/^\s*ok/i.test(request.event.text) && picks.replies.at(-1)?.cards.length === 1);

  try {
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages(request),
      { role: "user", content: await beforeDeadline(eventContent(request, ctx, verified.notes), deadline) },
    ];
    const toolNames: string[] = [];
    // Each update_enquiry call as action:error, for the turn log: the real mix of proposals (round 4's log couldn't show it).
    const updateResults: string[] = [];
    // Item codes whose get_product failed this turn (not found, gone, or cut by the deadline): the answer can't say every lookup worked.
    const missingCodes: string[] = [];
    let rounds = 0;
    let forcedEarly = false;
    let result: { final: FinalAnswer | null; content: Anthropic.ContentBlock[] } | null = null;
    // A product the customer picked: tapped this turn, on the enquiry, or a sure pick by the check. A permission question about it is
    // the ruled-out confirm step, and "how many?" may be asked about it.
    const picked = (code: string) => (ctx.tapped !== null && same(ctx.tapped, code)) || ctx.lines.some((line) => same(line.code, code)) || ctx.checkPick.picked(code);
    // The nudge is decided before attachEarlierCards looks up a re-attached card, and a reply may name an earlier card without
    // attaching it, so the nudge and the review both get the earlier replies' cards: an unknown card would count as the confirm
    // step (exam 3, c09-stress T1).
    const earlierCards = picks.replies.flatMap((reply) => reply.cards);
    // What the work deadline cut, if anything, and how many tool calls finished this turn. A search the cut left running may land
    // while Claude answers: only the searches before the cut back a claim, as Claude never saw the rest.
    let cut: "call" | "tools" | null = null;
    let finishedTools = 0;
    let searchCut: number | null = null;
    const searches = () => (searchCut === null ? ctx.searches : ctx.searches.slice(0, searchCut));
    const turnFacts = () => ({ lines: ctx.lines, changes: ctx.changes, searches: searches(), refused: ctx.refused, picked, earlierCards, unchecked: ctx.uncheckedCodes });
    // A product the reply names but Claude never proposed, checked as an add with no number (from this turn's lookups or an earlier card).
    const checkNamed = (code: string) => {
      const product = [...ctx.seen.values()].find((item) => same(item.product.stock_id, code))?.product;
      const card = earlierCards.findLast((item) => same(item.code, code));
      return ctx.checkPick({
        code: product?.stock_id ?? card?.code ?? code, name: product?.name ?? card?.name ?? code, price: product?.list_price ?? card?.price ?? null,
        uom: product?.uom_id.trim() ?? "", action: "add", quantity: null, requested: null, unit: "uom",
      });
    };
    let nudged = false;
    // The customer's typed texts don't change within the turn.
    const typedAny = statesAnyQuantity(ctx.customerTexts);
    const listTurn = listItemCount(searchText ?? "") > LIST_ITEMS_PER_TURN;
    // Why the tool rounds stopped before time or the round cap did: the one place that turns tools off, with its note.
    let stopped: Stop | "list" | "thanks" | null = thanksTurn ? "thanks" : null;
    // This turn's slowest Claude call and tool round so far.
    let slowestCall = 0;
    let slowestTools = 0;
    // What a call that may use tools needs: itself and a tool round as slow as this turn's slowest, then an answer half as long again
    // (answers ran 1.3-1.5 times a tool call's time in a local check). The owner's chat, 2026-09-30: a 10 s first call, then another
    // round started with 12.6 s left and the answer was cut off. With calls and rounds up to about 3 s, lastCallMs decides.
    const roundNeedMs = () => Math.max(lastCallMs, 2.5 * slowestCall + slowestTools);
    for (let round = 0; round <= MAX_TOOL_ROUNDS && !result; round += 1) {
      // A cut with nothing found gets NOTHING_FOUND_NOTE instead: the list note says to answer with what was found (r6 review).
      if (!stopped && listTurn && round > 0 && toolNames.length > 0 && !(cut && !finishedTools)) stopped = "list";
      // The first call is never out of time; after a tool round, answer now when another round won't fit.
      const outOfTime = round >= MAX_TOOL_ROUNDS || (round > 0 && timeLeft() <= roundNeedMs());
      const forceAnswer = stopped !== null || outOfTime;
      const note = stopped === "which" ? WHICH_NOTE : stopped === "ask" ? ASK_NOTE : stopped === "answer" ? ANSWER_NOTE : stopped === "keep" ? KEEP_NOTE
        : stopped === "list" ? LIST_NOTE : outOfTime && round < MAX_TOOL_ROUNDS ? (cut && !finishedTools ? NOTHING_FOUND_NOTE : TIME_NOTE) : null;
      if (!stopped && outOfTime && round < MAX_TOOL_ROUNDS) forcedEarly = true;
      // After the tool results (or the nudge): every user message this loop sends has array content.
      if (note) (messages.at(-1)!.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: note });
      rounds += 1;
      const callStarted = performance.now();
      let response: Anthropic.Message;
      try {
        response = await callClaude(client, model, messages, forceAnswer ? "none" : "auto", forceAnswer ? answerBy : deadline);
      } catch (error) {
        // A call that could still use tools, cut by the work deadline: the next one answers without them, in the time kept for it.
        if (forceAnswer || !answerAfterCut()) throw error;
        cut = "call";
        continue;
      }
      slowestCall = Math.max(slowestCall, performance.now() - callStarted);
      if (response.stop_reason === "tool_use") {
        const before = { codes: new Set([...ctx.refused, ...ctx.kept].map((code) => code.toLowerCase())), keys: new Set(ctx.refusedKeys) };
        const content = response.content;
        const toolsStarted = performance.now();
        const outcomes = new Map<string, ToolOutcome>();
        const { results, done } = await beforeDeadline(runToolBlocks(content, ctx, toolNames, outcomes, deadline), deadline).catch((error: unknown) => {
          // A round the work deadline cut: the tools that finished give their results, the rest say so, and the next call answers
          // (owner's chat, 2026-09-30: a cut round went straight to the backup reply).
          if (!answerAfterCut()) throw error;
          cut = "tools";
          ctx.closed = true;
          searchCut = ctx.searches.length;
          return roundResults(content, outcomes);
        });
        finishedTools += outcomes.size;
        slowestTools = Math.max(slowestTools, performance.now() - toolsStarted);
        updateResults.push(...done.filter((call) => call.name === "update_enquiry").map((call) => `${updateAction(call.input)}:${call.error ?? "ok"}`));
        missingCodes.push(...done.flatMap((call) => (call.name === "get_product" && call.error ? [String((call.input as { stock_id?: unknown }).stock_id ?? "")].filter(Boolean) : [])));
        messages.push({ role: "assistant", content: response.content }, { role: "user", content: results });
        stopped = stopped ?? stopNote(done, ctx, before, picked);
        continue;
      }
      const final = readFinal(response);
      // One nudge, only while the next round may still use tools, and never after a refusal (a retry is refused again, exam 3,
      // c08-persona T8; a refused removal or an item with no typed number is answered from the check's cache, r4 c02-A idx 16) or on
      // a thank-you or a paced list. A permission question is nudged only when it is the confirm step and the customer typed a number:
      // without one, update_enquiry can only refuse, and the tool-less repair keeps the rest of the answer. Safe only because
      // update_enquiry checks the pick and the typed number. A nudged round must fit at this turn's speed, or its call is forced to
      // answer and the nudge can't be acted on; an un-nudged claim is fixed by the ENQUIRY_CLAIM fixer or the tool-less repair.
      const nudgeFits = () => timeLeft() > Math.max(CLAIM_NUDGE_MIN_MS, roundNeedMs());
      const toolsLeft = !nudged && !forceAnswer && round + 1 < MAX_TOOL_ROUNDS && nudgeFits() && !ctx.refused.length && !ctx.finalRefusal;
      // A permission question about the one product the customer named but Claude never proposed: one check says whether they
      // picked it, i.e. whether this is the confirm step the owner ruled out (r4 c02-persona idx 8; about 1 in 700 round-4 turns).
      if (final && toolsLeft && typedAny) {
        const about = permissionCodes(final, ctx.seen, earlierCards).filter((code) => !picked(code));
        if (about.length === 1) await beforeDeadline(checkNamed(about[0]), deadline).catch(() => undefined);
      }
      // The check above is a model call (1-3 s): the nudged round must still fit after it.
      const nudge = !final || !toolsLeft || !nudgeFits() ? null
        : enquiryClaimIssues(final.message, { ...turnFacts(), seen: ctx.seen }).length ? CLAIM_NUDGE
        : asksConfirmStep(final, ctx.seen, picked, earlierCards) && typedAny ? PERMISSION_NUDGE : null;
      if (nudge) {
        nudged = true;
        messages.push({ role: "assistant", content: response.content }, { role: "user", content: [{ type: "text", text: nudge }] });
        continue;
      }
      result = { final, content: response.content };
    }
    if (!result) throw new Error("AGENT_NO_ANSWER");

    // Read when called: removing an unchecked line mid-turn makes the whole enquiry checked, so its total with GST is allowed again.
    const currentAllowed = () => allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal, !ctx.uncheckedCodes.length);
    const previousCodes = picks.replies.at(-1)?.cards.map((card) => card.code) ?? [];
    const triedCodes = new Set<string>();
    // Run before `allowed` is read; a lookup cut short by the deadline leaves the answer as it was.
    const withEarlierCards = (answer: FinalAnswer) => beforeDeadline(
      attachEarlierCards(answer, ctx, previousCodes, unverifiedAmounts(answer.message, currentAllowed()).length > 0, answerLeft, triedCodes), answerBy,
    ).catch(() => answer);
    // Dropped before the lookup and the review, so no re-check, REPEAT or LINK repair is spent on them: a card whose link the customer
    // says doesn't open (exam 4, c08), a changed item's card they've seen (exam 3, c02-A T18) and a set shown twice (exam 4). A
    // cards-only answer keeps its other cards: they are all it says.
    const brokenCodes = brokenLinkCodes(earlier.currentText, picks.replies);
    const broken = (id: string) => brokenCodes.some((code) => same(code, id));
    const trimCards = (answer: FinalAnswer): FinalAnswer => {
      // A code whose store listing came back gone this turn is never a card either, so no UNKNOWN_CARD repair (or backup reply) is
      // spent on it (r8 R01).
      const kept = answer.card_ids.filter((id) => !ctx.gone.has(id) && !broken(id));
      // With every card dropped, the words pointing at them go too (r3 c08-stress idx 5: "the card below carries the same details").
      const message = answer.card_ids.length && !kept.length ? withoutCardPointers(answer.message) : answer.message;
      // The link line only when a card was really dropped for its link: a cards-only line with no cards, or with only removed listings,
      // is not a link complaint (D8 review).
      const nothingLeft = answer.card_ids.some(broken) ? BROKEN_LINK_MESSAGE : NOTHING_LEFT_MESSAGE;
      if (answer.message === CARDS_ONLY_MESSAGE || !message) return kept.length ? { ...answer, card_ids: kept } : { ...answer, card_ids: [], message: nothingLeft, show_contact: true };
      const trimmed = withoutRangeCards(withoutRepeatedSet(withoutChangedCards({ ...answer, message, card_ids: kept }, ctx.changes, ctx.shownIds, earlier.currentText), earlier, ctx.refused), earlier.currentText);
      // A product the words name gets its card before the card they would otherwise stand for, once the cards kept are settled (r8 F6).
      const named = withNamedCards(trimmed, ctx.seen, ctx.lines, ctx.changes);
      return named === trimmed ? trimmed : { ...named, card_ids: named.card_ids.filter((id) => !broken(id)) };
    };
    // The lookup reads an earlier card for the first time and can find its listing gone: trimmed again then, so its words go with it
    // and a reply left with nothing gets the next step and the contact (r8 review).
    const trimAndAttach = async (answer: FinalAnswer) => {
      const attached = await withEarlierCards(trimCards(answer));
      return attached.card_ids.some((id) => ctx.gone.has(id)) ? trimCards(attached) : attached;
    };
    let final = result.final && await trimAndAttach(result.final);
    let allowed = currentAllowed();
    let review = final && reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
    // Safety issues that code fixes after the repair. `allowed` is read when a fix runs: the repair recomputes it.
    // The fixed line answers only a change the customer may have asked for (exam 3: it answered "Recommend").
    const changeAsked = askedForChange(earlier.currentText, request.event.type === "select_product");
    const withoutClaims = (message: string) => withoutEnquiryClaims(message, { ...turnFacts(), seen: ctx.seen }, changeAsked);
    const fixers: Fixer[] = [
      { prefix: CLAIM_ISSUE_PREFIX, fix: (message) => removeClaims(message, searches(), ctx.seen) },
      // Before the enquiry-claim fixer, so a "removed" line the browser still holds gets its own sentence, not NOT_ON_ENQUIRY's.
      { prefix: KEPT_LINE_PREFIX, fix: (message) => withoutKeptLineClaims(message, ctx.uncheckedCodes, ctx.changes) },
      { prefix: ENQUIRY_CLAIM_PREFIX, fix: withoutClaims },
      noCardFixer,
      { prefix: LINK_ISSUE_PREFIX, fix: (message) => removeLinks(message, unknownStoreLinks(message, ctx.seen, earlier)) },
      { prefix: MONEY_ISSUE_PREFIX, fix: (message) => removeAmounts(message, unverifiedAmounts(message, allowed)) },
    ];
    // An answer about to be sent, with what code can fix fixed. Style problems left are not worth the backup reply: the answer is
    // lightly tidied, then checked again for claims, as tidying rewords it ("Noted: 2" becomes "Got it: 2"). A stock count that still
    // disagrees with its card's live stock loses its number (exam 4, c03-stress idx 7). It is never sent empty.
    const finish = (answer: FinalAnswer, checked: Review): FinalAnswer => {
      const fixed = applyFixers(answer.message, checked.safety, fixers);
      if (fixed.left.length) throw new Error("AGENT_REPLY_REJECTED"); // only unknown card ids stay unfixable
      const message = withoutWrongStockCounts(checked.style.length ? withoutClaims(tidyMessage(fixed.message)) : fixed.message, checked.cards, ctx.seen);
      if (message.trim()) return { ...answer, message };
      return { ...answer, message: checked.cards.length ? CARDS_ONLY_MESSAGE : NOTHING_LEFT_MESSAGE, show_contact: answer.show_contact || !checked.cards.length };
    };
    // A first answer whose problems code can fix can still be sent, lightly tidied and fixed, when there is no usable repair: a repair
    // that fails or runs out of time no longer turns an answer code could send into the backup reply (r6 T-R4).
    const fixable = final && review && (review.safety.length || review.style.length) && !unfixable(review.safety, fixers).length ? final : null;
    const tidiedFirst = fixable && { ...fixable, message: tidyMessage(fixable.message) };
    let repairCauses: string[] = [];
    let repaired = false;
    let repairFailed: string | null = null;
    if (fixable && review && timeLeft() < STYLE_REPAIR_MIN_MS) {
      // No time for a repair, which the deadline would cut off for the backup reply: code fixes the answer and it is sent.
      repairCauses = [...review.safety, ...review.style].map(issueCode);
      final = finish(fixable, review); // review (cards, chips) stays
    } else if (!final || !review || review.safety.length || review.style.length) {
      const problems = review ? [...review.safety, ...review.style] : [INVALID_ANSWER_ISSUE];
      repairCauses = review ? problems.map(issueCode) : ["INVALID_ANSWER"];
      repaired = true;
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: `[Context from the system, not the customer] Your reply was not sent. Fix these problems and answer again in the same JSON format without calling tools:\n- ${problems.join("\n- ")}`,
      });
      final = await callClaude(client, model, messages, "none", answerBy)
        .then((response) => readFinal(response) ?? Promise.reject(new Error("AGENT_INVALID_ANSWER")))
        .catch((error: unknown) => {
          if (!tidiedFirst) throw error;
          repairFailed = failureCode(error, deadline);
          return tidiedFirst;
        });
      final = await trimAndAttach(final);
      allowed = currentAllowed();
      review = reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
      if (tidiedFirst && unfixable(review.safety, fixers).length) {
        // The repair brought a made-up card, but code can fix the first answer: it goes out tidied and fixed instead.
        repairFailed = "AGENT_REPLY_REJECTED";
        final = tidiedFirst;
        review = reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
      }
      final = finish(final, review);
    }

    // The chat's item codes, so a code that fits the phone pattern isn't taken for a phone number (exam 3, c05-persona T10); the
    // customer's enquiry codes too, as a line that couldn't be looked up this turn is named nowhere else, and the codes no lookup
    // confirmed, which the reply may now name (r8 R03).
    const chatCodes = [
      ...ctx.seen.keys(), ...ctx.lines.map((line) => line.code), ...request.enquiry.map((line) => line.stockId), ...ctx.shownIds,
      ...picks.replies.flatMap((reply) => reply.cards.map((card) => card.code)), ...ctx.gone, ...missingCodes,
    ];
    // The products the reply names or shows whose live check failed, and the codes found nothing for (r8 R03).
    const unconfirmed = [...missingCodes, ...[...ctx.seen.values()].filter(({ product, verified }) => !verified
      && (review.cards.some((card) => same(card.stock_id, product.stock_id)) || codePattern(product.stock_id).test(final.message))).map(({ product }) => product.stock_id)];
    const truthful = withoutAllFoundClaims(final.message, unconfirmed);
    const cleaned = customerMessage(withoutRepeatedCloser(dropRepeatedPitch(truthful, earlier, final.show_contact), earlier.previousMessage, ctx.changes.length > 0), chatCodes);
    // Never a blank bubble: a reply of only spaces, invisible format characters or lone marks (a zero-width space, a direction mark,
    // an escaped space decoded after the trim) gets past every check above (r7).
    const blank = !/[^\s\p{C}\p{M}]/u.test(cleaned.message);
    // Codes and counts only, never customer or reply text. The session's tail and the cards' code:status:qty let the exam match
    // a line to its transcript turn and settle price and "only N left" disputes (exam 3, c01-stress T13).
    console.info("[api/agent] turn", {
      ms: Math.round(performance.now() - started), session: request.sessionId.slice(-8), rounds, forcedEarly, cut, stopped, repaired, repairCauses,
      repairSkipped: repairCauses.length > 0 && !repaired, repairFailed, tools: toolNames, updates: updateResults,
      picks: ctx.checkPick.settled.map((v) => `${v.action}:${v.verdict}${v.sure ? "" : "?"}:${v.ms}`), pickFast: ctx.pickFast,
      cards: review.cards.map((card) => `${card.stock_id}:${card.stock_status}:${card.available_quantity ?? "?"}`),
    });
    return {
      message: !blank ? cleaned.message : review.cards.length ? CARDS_ONLY_MESSAGE : NOTHING_LEFT_MESSAGE,
      cards: review.cards,
      chips: review.chips,
      enquiry: replyEnquiry(ctx),
      showContact: final.show_contact || cleaned.showContact || (blank && !review.cards.length),
      provider: "anthropic",
    };
  } catch (error) {
    // Only a reason code is logged: error text could echo customer or model content.
    console.warn("[api/agent] fallback reply", { reason: failureCode(error, deadline), ms: Math.round(performance.now() - started), session: request.sessionId.slice(-8) });
    // The enquiry as it stands at the cut: an add still landing isn't said or shown, and the browser keeps its own copy.
    const enquiry = replyEnquiry(ctx);
    const changes = [...ctx.changes];
    // The backup reply gets the reserve, or less if the turn started with less than that left.
    const left = deadlineMs - (performance.now() - started);
    // It starts from what this turn already found and changed: the owner's "prata pan maybe" (2026-09-30) ran out of time after its
    // searches, and the backup's own search of the raw words showed melamine GN pans.
    const reply = await buildFallbackReply({
      searchText, lines: enquiry.lines, deps: input.deps, timeoutMs: Math.max(1, Math.floor(Math.min(fallbackReserveMs, left) * 0.9)),
      seen: ctx.seen, changes, thanks: thanksTurn,
      event: request.event.type === "select_product" ? "tap" : request.event.type === "image" ? "photo" : "text",
    });
    return { ...reply, enquiry };
  }
}

/** The turn's enquiry, plus the codes the browser keeps as it has them because they could not be re-checked. */
function replyEnquiry(ctx: TurnContext): AgentReply["enquiry"] {
  return { lines: ctx.lines, totals: enquiryTotals(ctx.lines), ...(ctx.uncheckedCodes.length ? { unchecked: ctx.uncheckedCodes } : {}) };
}
