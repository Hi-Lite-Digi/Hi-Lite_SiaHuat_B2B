// src/lib/agent/chat-log.ts
import type { AgentReply, AgentRequest } from "./contract";

/** One chat turn as saved for review: the customer's words (a photo or a card tap as a short note) and Claire's reply. */
export function chatTurnRow(request: AgentRequest, reply: AgentReply) {
  const event = request.event;
  const customer = event.type === "text" ? event.text
    : event.type === "image" ? `[photo]${event.caption ? ` ${event.caption}` : ""}`
    : `[tapped] ${event.stockId}`;
  return {
    session_id: request.sessionId,
    customer,
    claire: reply.message,
    cards: reply.cards.map((card) => card.stock_id),
    chips: reply.chips,
    show_contact: reply.showContact,
    provider: reply.provider,
    enquiry: reply.enquiry.lines.map((line) => ({ code: line.code, quantity: line.quantity })),
  };
}

/** Saves a turn to chat_turns. A failure is only logged: it never reaches the customer. */
export async function logChatTurn(request: AgentRequest, reply: AgentReply) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return;
  try {
    const response = await fetch(`${url}/rest/v1/chat_turns`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}`, prefer: "return=minimal" },
      body: JSON.stringify(chatTurnRow(request, reply)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.warn("[api/agent] chat log failed", response.status);
  } catch (error) {
    console.warn("[api/agent] chat log failed", error instanceof Error ? error.message : String(error));
  }
}
