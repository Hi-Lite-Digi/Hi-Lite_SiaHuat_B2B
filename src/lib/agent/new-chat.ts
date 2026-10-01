// src/lib/agent/new-chat.ts
// The chat screen's New chat button (agent-chat.tsx): what a reset would clear, and request signals a reset cancels.
import type { AgentReply } from "./contract";

/** The confirm text for New chat, or null when there is nothing to lose and the chat resets at once. */
export function newChatWarning(customerWrote: boolean, totals: AgentReply["enquiry"]["totals"]): string | null {
  if (totals.lineCount > 0) {
    return `This clears your enquiry (${totals.lineCount} item${totals.lineCount === 1 ? "" : "s"} · $${totals.grandTotal.toFixed(2)}) and the messages. Tap PDF first to keep a copy.`;
  }
  return customerWrote ? "This clears the messages so far." : null;
}

/** Aborts after ms, or as soon as `chat` aborts (New chat). Not AbortSignal.any: iPhones before iOS 17.4 don't have it. */
export function abortAfter(ms: number, chat: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const stop = () => { clearTimeout(timer); chat.removeEventListener("abort", stop); controller.abort(); };
  const timer = setTimeout(stop, ms);
  if (chat.aborted) stop();
  else chat.addEventListener("abort", stop, { once: true });
  return controller.signal;
}
