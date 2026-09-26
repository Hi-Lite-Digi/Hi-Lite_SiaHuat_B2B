// src/lib/agent/loop.ts
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { beginModelCall, recordClaudeUsage, type ClaudeUsage } from "@/lib/model-usage";
import { prepareVisionPhoto } from "@/lib/product-image-crop";
import type { AgentReply, AgentRequest } from "./contract";
import { enquiryTotals, verifyEnquiry } from "./enquiry";
import { liveCheck, productFact, type FactDeps } from "./facts";
import { buildFallbackReply } from "./fallback";
import { MONEY_ISSUE_PREFIX, allowedCents, customerMessage, removeAmounts, reviewAnswer, tidyMessage, unverifiedAmounts, type EarlierTurns, type FinalAnswer } from "./guards";
import { CLAIRE_AGENT_PROMPT } from "./prompt";
import { agentTools, runTool, uncheckedNote, type ShownCard, type ToolOutcome, type TurnContext } from "./tools";

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
const TAP_PREFIX = "[tap]";
const CHIP_PREFIX = "[chip]";

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

const CARDS_NOTE = "[cards shown: ";

/** The cards the chat screen noted on an assistant history entry: "[cards shown: CODE name; CODE name]". */
function shownCards(content: string): ShownCard[] {
  const start = content.lastIndexOf(CARDS_NOTE);
  if (start < 0) return [];
  return content.slice(start + CARDS_NOTE.length).replace(/\]\s*$/, "").split("; ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const space = entry.indexOf(" ");
      return space < 0 ? { code: entry, name: "" } : { code: entry.slice(0, space), name: entry.slice(space + 1) };
    });
}

/** An assistant history entry's message without its cards note. */
function withoutCardsNote(content: string) {
  const start = content.lastIndexOf(CARDS_NOTE);
  return (start < 0 ? content : content.slice(0, start)).trim();
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

async function runToolBlocks(content: Anthropic.ContentBlock[], ctx: TurnContext): Promise<Anthropic.ToolResultBlockParam[]> {
  const calls = content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
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
}): Promise<AgentReply> {
  const started = performance.now();
  const { request, deps, client, model } = input;
  const deadlineMs = input.deadlineMs ?? TURN_DEADLINE_MS;
  const fallbackReserveMs = input.fallbackReserveMs ?? FALLBACK_RESERVE_MS;
  const workMs = Math.max(1, Math.floor(deadlineMs - fallbackReserveMs));
  const deadline = AbortSignal.timeout(workMs);
  const verified = await verifyEnquiry(request.enquiry, deps, Math.max(VERIFY_FLOOR_MS, Math.min(5_000, Math.floor(workMs / 3))));
  const customerTexts = recentCustomerTexts(request);
  const claireReplies = request.history.filter((item) => item.role === "assistant");
  const previousReply = claireReplies.at(-1);
  const ctx: TurnContext = {
    deps,
    seen: new Map(verified.products),
    lines: verified.lines,
    uncheckedCodes: verified.unchecked,
    customerTexts,
    // A chip tap can ask to clear the enquiry, but never states a quantity.
    clearTexts: request.event.type === "text" && request.event.chip ? [request.event.text, ...customerTexts] : customerTexts,
    image: request.event.type === "image" ? request.event.image : null,
    shownIds: new Set(request.shownProductIds),
    tappedId: request.event.type === "select_product" ? request.event.stockId : null,
    previousCards: previousReply ? shownCards(previousReply.content) : [],
  };
  const searchText = request.event.type === "text" ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null;
  const earlier: EarlierTurns = {
    cardSets: claireReplies.map((item) => shownCards(item.content).map((card) => card.code)),
    previousMessage: previousReply ? withoutCardsNote(previousReply.content) : null,
    currentText: searchText ?? "",
  };

  try {
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages(request),
      { role: "user", content: await beforeDeadline(eventContent(request, ctx, verified.notes), deadline) },
    ];
    let result: { final: FinalAnswer | null; content: Anthropic.ContentBlock[] } | null = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS && !result; round += 1) {
      const response = await callClaude(client, model, messages, round < MAX_TOOL_ROUNDS ? "auto" : "none", deadline);
      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: await beforeDeadline(runToolBlocks(response.content, ctx), deadline) });
        continue;
      }
      result = { final: readFinal(response), content: response.content };
    }
    if (!result) throw new Error("AGENT_NO_ANSWER");

    let final = result.final;
    let allowed = allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal);
    let review = final && reviewAnswer(final, ctx.seen, allowed, earlier);
    if (!final || !review || review.safety.length || review.style.length) {
      const problems = review ? [...review.safety, ...review.style] : [INVALID_ANSWER_ISSUE];
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: `[Context from the system, not the customer] Your reply was not sent. Fix these problems and answer again in the same JSON format without calling tools:\n- ${problems.join("\n- ")}`,
      });
      final = readFinal(await callClaude(client, model, messages, "none", deadline));
      if (!final) throw new Error("AGENT_INVALID_ANSWER");
      allowed = allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal);
      review = reviewAnswer(final, ctx.seen, allowed, earlier);
      if (review.safety.length && review.safety.every((issue) => issue.startsWith(MONEY_ISSUE_PREFIX))) {
        final = { ...final, message: removeAmounts(final.message, unverifiedAmounts(final.message, allowed)) };
        review = { ...review, safety: [] };
      }
      if (review.safety.length) throw new Error("AGENT_REPLY_REJECTED");
      // Style problems left after the repair are not worth the backup reply: send the answer, lightly tidied.
      if (review.style.length) final = { ...final, message: tidyMessage(final.message) };
    }

    const cleaned = customerMessage(final.message);
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
    const reason = !(error instanceof Error) ? "unknown" : /^[A-Z0-9_]{3,60}$/.test(error.message) ? error.message : error.name;
    console.warn("[api/agent] fallback reply", { reason });
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
