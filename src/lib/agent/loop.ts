// src/lib/agent/loop.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { beginModelCall, recordClaudeUsage, type ClaudeUsage } from "@/lib/model-usage";
import { prepareVisionPhoto } from "@/lib/product-image-crop";
import { CHIP_PREFIX, TAP_PREFIX, type AgentReply, type AgentRequest } from "./contract";
import { enquiryTotals, verifyEnquiry } from "./enquiry";
import { liveCheck, productFact, withTimeout, type CheckedProduct, type FactDeps } from "./facts";
import { buildFallbackReply } from "./fallback";
import {
  ENQUIRY_CLAIM_PREFIX, MONEY_ISSUE_PREFIX, allowedCents, applyFixers, customerMessage, enquiryClaimIssues, issueCode, noCardFixer, removeAmounts, reviewAnswer,
  tidyMessage, unverifiedAmounts, withoutEnquiryClaims, type EarlierTurns, type FinalAnswer, type Fixer,
} from "./guards";
import { codePattern, pickEvidence } from "./picks";
import { CLAIRE_AGENT_PROMPT } from "./prompt";
import { agentTools, errorCode, runTool, uncheckedNote, type ToolOutcome, type TurnContext } from "./tools";

export type AgentClient = {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
};

export const MAX_TOOL_ROUNDS = 3;
export const AGENT_EFFORT = "low" as const;
const TURN_DEADLINE_MS = 45_000;
const FALLBACK_RESERVE_MS = 10_000;
// Enquiry re-checks get at least this long even when the work budget is smaller. The time comes out of the
// backup reply's reserve; with a nearly spent budget the turn runs slightly over rather than time out every line.
const VERIFY_FLOOR_MS = 1_000;
const STYLE_REPAIR_MIN_MS = 8_000; // a style-only repair needs about this long; with less left, the tidied answer is sent
const LAST_CALL_MS = 12_000; // below this, the next Claude call answers with what it has
const EARLIER_CARD_CHECK_MS = 2_000;
const CLAIM_NUDGE_MIN_MS = 15_000; // the nudge costs a Claude round, and the reply may still need a repair after it

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
const finalAnswerSchema = z.object({
  message: z.string().trim(),
  card_ids: z.array(z.string()),
  chips: z.array(z.string()),
  show_contact: z.boolean(),
});
const CARDS_ONLY_MESSAGE = "Here are some options.";
const INVALID_ANSWER_ISSUE = "Your answer was not valid JSON with a non-empty message, card_ids, chips and show_contact. Answer with that JSON only.";
const NOTHING_LEFT_MESSAGE = "Sorry, I couldn't confirm that from here. Sia Huat sales can help (details below).";
const TIME_NOTE = "[Context from the system, not the customer] Time is nearly up: answer now with what you found. Nothing more can be looked up or changed this turn.";
const CLAIM_NUDGE = "[Context from the system, not the customer] Your reply says the enquiry changed (or will change), but no update_enquiry call succeeded for that item in this turn. Call update_enquiry only for exactly what the customer picked and the number they typed; otherwise answer without saying it changed.";

/** The customer's last two typed messages (card and chip taps excluded), newest first. */
export function recentCustomerTexts(request: AgentRequest) {
  const event = request.event;
  const current = event.type === "text" && !event.chip ? [event.text] : event.type === "image" && event.caption ? [event.caption] : [];
  const earlier = request.history
    .filter((item) => item.role === "user" && !item.content.startsWith(TAP_PREFIX) && !item.content.startsWith(CHIP_PREFIX))
    .map((item) => item.content.replace(/^\[photo\]\s*/, ""))
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
    const found = await ctx.deps.findByCode(event.stockId).catch(() => null);
    if (found) {
      const checked = await liveCheck(found, ctx.deps);
      ctx.seen.set(checked.product.stock_id, checked);
      blocks.push({ type: "text", text: `Customer tapped this product card to choose it: ${JSON.stringify(productFact(checked, true))}` });
    } else {
      blocks.push({ type: "text", text: `Customer tapped item ${event.stockId}, but it is no longer in the catalogue.` });
    }
  }
  const shown = [...ctx.shownIds].slice(-40).join(", ") || "none";
  const unchecked = uncheckedNote(ctx.uncheckedCodes);
  blocks.push({
    type: "text",
    text: `[Context from the system, not the customer] Current enquiry: ${JSON.stringify({ lines: ctx.lines, totals: enquiryTotals(ctx.lines) })}${unchecked ? `\n${unchecked}` : ""}${notes.length ? `\nEnquiry changes since last turn: ${notes.join(" ")}` : ""}\nItem codes already shown as cards: ${shown}`,
  });
  return blocks;
}

async function callClaude(client: AgentClient, model: string, messages: Anthropic.MessageParam[], toolChoice: "auto" | "none", signal: AbortSignal) {
  const finish = beginModelCall();
  const response = await client.messages.create({
    model,
    max_tokens: 4_096,
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

/** Stores a checked product; a failed check never replaces a live-checked one. */
function keepBest(ctx: TurnContext, checked: CheckedProduct) {
  if (checked.verified || !ctx.seen.get(checked.product.stock_id)?.verified) ctx.seen.set(checked.product.stock_id, checked);
}

/**
 * Cards Claude chose that this turn hasn't looked up but the customer has already seen or has on the enquiry, plus (when the
 * message quotes an amount code can't back yet) the cards of Claire's previous reply and earlier-shown codes named in the message:
 * looked up and live-checked by code now, so every card and price still comes from this turn's facts.
 */
async function attachEarlierCards(
  final: FinalAnswer, ctx: TurnContext, previousCodes: string[], amountsUnbacked: boolean, timeLeft: () => number, tried: Set<string>,
): Promise<FinalAnswer> {
  const known = new Map([...ctx.shownIds, ...ctx.lines.map((line) => line.code), ...previousCodes].map((id) => [id.toLowerCase(), id]));
  const seen = new Map([...ctx.seen.keys()].map((id) => [id.toLowerCase(), id]));
  const named = amountsUnbacked ? [...previousCodes, ...[...known.values()].filter((id) => codePattern(id).test(final.message))] : [];
  // A code tried earlier this turn isn't looked up again after the repair: a stalled check would stall again.
  const wanted = [...new Set([...final.card_ids, ...named].map((id) => id.toLowerCase()))]
    .filter((id) => known.has(id) && !tried.has(id) && !ctx.seen.get(seen.get(id) ?? "")?.verified).slice(0, 5);
  for (const id of wanted) tried.add(id);
  // One time limit covers each card's code lookup and live check together.
  const end = performance.now() + Math.max(1, Math.min(EARLIER_CARD_CHECK_MS, timeLeft() - 1_000));
  const left = () => Math.max(1, end - performance.now());
  await Promise.all(wanted.map(async (id) => {
    const found = await withTimeout(ctx.deps.findByCode(known.get(id)!).catch(() => null), left(), null);
    if (!found) return;
    // A live check that stalls sends the card unconfirmed, like a search result that wasn't checked.
    const unconfirmed: CheckedProduct = { product: { ...found, stock_status: "unknown", in_stock: null, available_quantity: null }, verified: false };
    const ms = left();
    keepBest(ctx, await withTimeout(liveCheck(found, ctx.deps, ms), ms, unconfirmed));
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
  return deadline.aborted ? "AGENT_DEADLINE"
    : typeof status === "number" ? `API_${status}`
    : /timed out/i.test(error.message) ? "API_TIMEOUT"
    : /aborted/i.test(error.message) ? "CLIENT_ABORT" : code;
}

/** Runs the tool calls in Claude's response; each tool's name is added to `names` for the turn log. */
async function runToolBlocks(content: Anthropic.ContentBlock[], ctx: TurnContext, names: string[]): Promise<Anthropic.ToolResultBlockParam[]> {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  names.push(...calls.map((call) => call.name));
  const outcomes = new Map<string, ToolOutcome>();
  // Enquiry updates change shared state, so they run one after another; lookups run in parallel.
  for (const call of calls.filter((item) => item.name === "update_enquiry")) {
    outcomes.set(call.id, await runTool(call.name, call.input, ctx));
  }
  await Promise.all(calls.filter((item) => item.name !== "update_enquiry").map(async (call) => {
    outcomes.set(call.id, await runTool(call.name, call.input, ctx));
  }));
  return calls.map((call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: outcomes.get(call.id)!.content,
    is_error: outcomes.get(call.id)!.isError,
  }));
}

export async function runAgentTurn(input: {
  request: AgentRequest;
  deps: FactDeps;
  client: AgentClient;
  model: string;
  /** The whole turn's remaining time, backup reply included. */
  deadlineMs?: number;
  /** The last part of deadlineMs, kept back for the backup reply. */
  fallbackReserveMs?: number;
  /** With this little work time left after a tool round, the next Claude call must answer without tools. */
  lastCallMs?: number;
}): Promise<AgentReply> {
  const started = performance.now();
  const { request, deps, client, model } = input;
  const deadlineMs = input.deadlineMs ?? TURN_DEADLINE_MS;
  const fallbackReserveMs = input.fallbackReserveMs ?? FALLBACK_RESERVE_MS;
  const lastCallMs = input.lastCallMs ?? LAST_CALL_MS;
  const workMs = Math.max(1, Math.floor(deadlineMs - fallbackReserveMs));
  const deadline = AbortSignal.timeout(workMs);
  const timeLeft = () => workMs - (performance.now() - started);
  const verified = await verifyEnquiry(request.enquiry, deps, Math.max(VERIFY_FLOOR_MS, Math.min(5_000, Math.floor(workMs / 3))));
  const customerTexts = recentCustomerTexts(request);
  const picks = pickEvidence(request.history, request.event);
  const ctx: TurnContext = {
    deps,
    seen: new Map(verified.products),
    lines: verified.lines,
    changes: [],
    uncheckedCodes: verified.unchecked,
    customerTexts,
    currentText: request.event.type === "text" && !request.event.chip ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null,
    // A chip tap can ask to clear the enquiry, but never states a quantity.
    clearTexts: request.event.type === "text" && request.event.chip ? [request.event.text, ...customerTexts] : customerTexts,
    image: request.event.type === "image" ? request.event.image : null,
    shownIds: new Set(request.shownProductIds),
    picks,
  };
  const searchText = request.event.type === "text" ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null;
  const earlier: EarlierTurns = {
    cardSets: picks.replies.map((reply) => reply.cards.map((card) => card.code)),
    previousMessage: picks.replies.at(-1)?.text ?? null,
    currentText: searchText ?? "",
  };

  try {
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages(request),
      { role: "user", content: await beforeDeadline(eventContent(request, ctx, verified.notes), deadline) },
    ];
    const toolNames: string[] = [];
    let rounds = 0;
    let forcedEarly = false;
    let result: { final: FinalAnswer | null; content: Anthropic.ContentBlock[] } | null = null;
    const turnFacts = () => ({ lines: ctx.lines, changes: ctx.changes });
    let nudged = false;
    for (let round = 0; round <= MAX_TOOL_ROUNDS && !result; round += 1) {
      // The first call may always use tools; after a tool round, a nearly spent budget means answer now.
      const forceAnswer = round >= MAX_TOOL_ROUNDS || (round > 0 && timeLeft() <= lastCallMs);
      if (forceAnswer && round < MAX_TOOL_ROUNDS) {
        forcedEarly = true;
        (messages.at(-1)!.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: TIME_NOTE }); // after the tool results
      }
      rounds += 1;
      const response = await callClaude(client, model, messages, forceAnswer ? "none" : "auto", deadline);
      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: await beforeDeadline(runToolBlocks(response.content, ctx, toolNames), deadline) });
        continue;
      }
      const final = readFinal(response);
      // One chance to make the change the reply talks about, only while the next round may still use tools.
      // Safe only because update_enquiry checks the pick and the typed number.
      if (final && !nudged && round + 1 < MAX_TOOL_ROUNDS && timeLeft() > CLAIM_NUDGE_MIN_MS && enquiryClaimIssues(final.message, { ...turnFacts(), seen: ctx.seen }).length) {
        nudged = true;
        messages.push({ role: "assistant", content: response.content }, { role: "user", content: [{ type: "text", text: CLAIM_NUDGE }] });
        continue;
      }
      result = { final, content: response.content };
    }
    if (!result) throw new Error("AGENT_NO_ANSWER");

    const currentAllowed = () => allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal);
    const previousCodes = picks.replies.at(-1)?.cards.map((card) => card.code) ?? [];
    const triedCodes = new Set<string>();
    // Run before `allowed` is read; a lookup cut short by the deadline leaves the answer as it was.
    const withEarlierCards = (answer: FinalAnswer) => beforeDeadline(
      attachEarlierCards(answer, ctx, previousCodes, unverifiedAmounts(answer.message, currentAllowed()).length > 0, timeLeft, triedCodes), deadline,
    ).catch(() => answer);
    let final = result.final && await withEarlierCards(result.final);
    let allowed = currentAllowed();
    let review = final && reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
    // Safety issues that code fixes after the repair. `allowed` is read when a fix runs: the repair recomputes it.
    const withoutClaims = (message: string) => withoutEnquiryClaims(message, { ...turnFacts(), seen: ctx.seen });
    const fixers: Fixer[] = [
      { prefix: ENQUIRY_CLAIM_PREFIX, fix: withoutClaims },
      noCardFixer,
      { prefix: MONEY_ISSUE_PREFIX, fix: (message) => removeAmounts(message, unverifiedAmounts(message, allowed)) },
    ];
    // A first answer with only style problems can still be sent, lightly tidied, when there is no time or no usable repair.
    const styleOnly = final && review && !review.safety.length && review.style.length ? final : null;
    const tidiedFirst = styleOnly && { ...styleOnly, message: tidyMessage(styleOnly.message) };
    let repairCauses: string[] = [];
    let repaired = false;
    let repairFailed: string | null = null;
    if (tidiedFirst && review && timeLeft() < STYLE_REPAIR_MIN_MS) {
      final = tidiedFirst; // review (cards, chips) stays
      repairCauses = review.style.map(issueCode);
    } else if (!final || !review || review.safety.length || review.style.length) {
      const problems = review ? [...review.safety, ...review.style] : [INVALID_ANSWER_ISSUE];
      repairCauses = review ? problems.map(issueCode) : ["INVALID_ANSWER"];
      repaired = true;
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: `[Context from the system, not the customer] Your reply was not sent. Fix these problems and answer again in the same JSON format without calling tools:\n- ${problems.join("\n- ")}`,
      });
      final = await callClaude(client, model, messages, "none", deadline)
        .then((response) => readFinal(response) ?? Promise.reject(new Error("AGENT_INVALID_ANSWER")))
        .catch((error: unknown) => {
          if (!tidiedFirst) throw error;
          repairFailed = failureCode(error, deadline);
          return tidiedFirst;
        });
      final = await withEarlierCards(final);
      allowed = currentAllowed();
      review = reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
      if (tidiedFirst && applyFixers(final.message, review.safety, fixers).left.length) {
        // The repair brought a made-up card, but the first answer was safe to send: it goes out tidied instead.
        repairFailed = "AGENT_REPLY_REJECTED";
        final = tidiedFirst;
        review = reviewAnswer(final, ctx.seen, allowed, earlier, turnFacts());
      }
      const fixed = applyFixers(final.message, review.safety, fixers);
      if (fixed.left.length) throw new Error("AGENT_REPLY_REJECTED"); // only unknown card ids stay unfixable
      final = { ...final, message: fixed.message };
      // Style problems left after the repair are not worth the backup reply: send the answer, lightly tidied.
      // Checked again after tidying, which rewords the reply ("Noted: 2" becomes "Got it: 2").
      if (review.style.length) final = { ...final, message: withoutClaims(tidyMessage(final.message)) };
      if (!final.message.trim()) {
        final = { ...final, message: review.cards.length ? CARDS_ONLY_MESSAGE : NOTHING_LEFT_MESSAGE, show_contact: final.show_contact || !review.cards.length };
      }
    }

    const cleaned = customerMessage(final.message);
    // Codes and counts only, never customer or reply text.
    console.info("[api/agent] turn", {
      ms: Math.round(performance.now() - started), rounds, forcedEarly, repaired, repairCauses,
      repairSkipped: repairCauses.length > 0 && !repaired, repairFailed, tools: toolNames,
    });
    return {
      message: cleaned.message,
      cards: review.cards,
      chips: review.chips,
      enquiry: replyEnquiry(ctx),
      showContact: final.show_contact || cleaned.showContact,
      provider: "anthropic",
    };
  } catch (error) {
    // Only a reason code is logged: error text could echo customer or model content.
    console.warn("[api/agent] fallback reply", { reason: failureCode(error, deadline), ms: Math.round(performance.now() - started) });
    // The backup reply gets the reserve, or less if the turn started with less than that left.
    const left = deadlineMs - (performance.now() - started);
    const reply = await buildFallbackReply({ searchText, lines: ctx.lines, deps, timeoutMs: Math.max(1, Math.floor(Math.min(fallbackReserveMs, left) * 0.9)) });
    return { ...reply, enquiry: replyEnquiry(ctx) };
  }
}

/** The turn's enquiry, plus the codes the browser keeps as it has them because they could not be re-checked. */
function replyEnquiry(ctx: TurnContext): AgentReply["enquiry"] {
  return { lines: ctx.lines, totals: enquiryTotals(ctx.lines), ...(ctx.uncheckedCodes.length ? { unchecked: ctx.uncheckedCodes } : {}) };
}
