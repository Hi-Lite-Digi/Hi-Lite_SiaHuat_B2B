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
import { CHIP_ISSUE, MONEY_ISSUE_PREFIX, allowedCents, chipAllowed, customerMessage, removeAmounts, reviewAnswer, unverifiedAmounts, type FinalAnswer } from "./guards";
import { CLAIRE_AGENT_PROMPT } from "./prompt";
import { agentTools, runTool, type ToolOutcome, type TurnContext } from "./tools";

export type AgentClient = {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
  };
};

export const MAX_TOOL_ROUNDS = 3;
export const AGENT_EFFORT = "low" as const;
const TURN_DEADLINE_MS = 45_000;
const FALLBACK_RESERVE_MS = 10_000;
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
  message: z.string().trim().min(1),
  card_ids: z.array(z.string()),
  chips: z.array(z.string()),
  show_contact: z.boolean(),
});

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
  blocks.push({
    type: "text",
    text: `[Context from the system, not the customer] Current enquiry: ${JSON.stringify({ lines: ctx.lines, totals: enquiryTotals(ctx.lines) })}${notes.length ? `\nEnquiry changes since last turn: ${notes.join(" ")}` : ""}\nItem codes already shown as cards: ${shown}`,
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

function parseFinal(response: Anthropic.Message): FinalAnswer {
  if (response.stop_reason !== "end_turn") throw new Error(`AGENT_STOP_${String(response.stop_reason).toUpperCase()}`);
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  return finalAnswerSchema.parse(JSON.parse(text));
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
  const verified = await verifyEnquiry(request.enquiry, deps, Math.max(1, Math.min(5_000, Math.floor(workMs / 3))));
  const ctx: TurnContext = {
    deps,
    seen: new Map(verified.products),
    lines: verified.lines,
    customerTexts: recentCustomerTexts(request),
    image: request.event.type === "image" ? request.event.image : null,
    shownIds: new Set(request.shownProductIds),
  };
  const searchText = request.event.type === "text" ? request.event.text : request.event.type === "image" ? request.event.caption ?? null : null;

  try {
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages(request),
      { role: "user", content: await beforeDeadline(eventContent(request, ctx, verified.notes), deadline) },
    ];
    let result: { final: FinalAnswer; content: Anthropic.ContentBlock[] } | null = null;
    for (let round = 0; round <= MAX_TOOL_ROUNDS && !result; round += 1) {
      const response = await callClaude(client, model, messages, round < MAX_TOOL_ROUNDS ? "auto" : "none", deadline);
      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: await beforeDeadline(runToolBlocks(response.content, ctx), deadline) });
        continue;
      }
      result = { final: parseFinal(response), content: response.content };
    }
    if (!result) throw new Error("AGENT_NO_ANSWER");

    let final = result.final;
    let allowed = allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal);
    let review = reviewAnswer(final, ctx.seen, allowed);
    if (review.issues.length) {
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: `[Context from the system, not the customer] Your reply was not sent. Fix these problems and answer again in the same JSON format without calling tools:\n- ${review.issues.join("\n- ")}`,
      });
      final = parseFinal(await callClaude(client, model, messages, "none", deadline));
      allowed = allowedCents(ctx.seen, ctx.lines, enquiryTotals(ctx.lines).grandTotal);
      review = reviewAnswer(final, ctx.seen, allowed);
      if (review.issues.length && review.issues.every((issue) => issue.startsWith(MONEY_ISSUE_PREFIX) || issue === CHIP_ISSUE)) {
        // Chips never carry digits, so dropping the disallowed ones also drops any amount in a chip.
        final = {
          ...final,
          message: removeAmounts(final.message, unverifiedAmounts(final.message, allowed)),
          chips: final.chips.filter(chipAllowed),
        };
        review = { ...review, issues: [] };
      }
      if (review.issues.length) throw new Error("AGENT_REPLY_REJECTED");
    }

    return {
      message: customerMessage(final.message),
      cards: review.cards,
      chips: final.chips.slice(0, 3),
      enquiry: { lines: ctx.lines, totals: enquiryTotals(ctx.lines) },
      showContact: final.show_contact,
      provider: "anthropic",
    };
  } catch (error) {
    // Only a reason code is logged: error text could echo customer or model content.
    const reason = !(error instanceof Error) ? "unknown" : /^[A-Z0-9_]{3,60}$/.test(error.message) ? error.message : error.name;
    console.warn("[api/agent] fallback reply", { reason });
    // The backup reply gets the reserve, or less if the turn started with less than that left.
    const left = deadlineMs - (performance.now() - started);
    return buildFallbackReply({ searchText, lines: ctx.lines, deps, timeoutMs: Math.max(1, Math.floor(Math.min(fallbackReserveMs, left) * 0.9)) });
  }
}
