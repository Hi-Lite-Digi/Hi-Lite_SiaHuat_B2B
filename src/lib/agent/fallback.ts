// src/lib/agent/fallback.ts
import "server-only";
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { SALES_CONTACT } from "./contact";
import type { AgentReply } from "./contract";
import { enquiryTotals, firstListItem } from "./enquiry";
import { liveCheck, retryOnce, withTimeout, type FactDeps } from "./facts";

const FALLBACK_TIMEOUT_MS = 9_000;
// A customer saying they don't need something is not asking for products.
const declines = /\b(?:no need|don['’]?t need|not needed|nvm|never mind|cancel|no thanks|no thank you|not this)\b|不要|不用/i;

/** Used when Claude is unavailable or its reply fails the guards twice. Search and live checks together stay within timeoutMs. */
export async function buildFallbackReply(input: { searchText: string | null; lines: EnquiryReceiptLine[]; deps: FactDeps; timeoutMs?: number }): Promise<AgentReply> {
  const timeoutMs = input.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  const started = performance.now();
  let cards: Product[] = [];
  const search = input.searchText?.trim() ?? "";
  if (search.length >= 3 && !declines.test(search)) {
    // A pasted list searches its first item (exam 3, s01-B T0: its first 80 characters found a can opener and pot lids).
    const query = (firstListItem(search) || search).slice(0, 80); // "1) 2) pot" has an empty first item
    try {
      const found = await withTimeout(retryOnce(() => input.deps.searchDirect(query, 10)), timeoutMs, null);
      const left = Math.floor(timeoutMs - (performance.now() - started));
      // If the search used up the time, skip the live checks and show no cards.
      if (found && left > 0) {
        const checked = await Promise.all(found.slice(0, 3).map((item) => liveCheck(item, input.deps, left)));
        cards = checked.map((item) => item.product);
      }
    } catch {
      cards = [];
    }
  }
  return {
    message: `Sorry, I'm having trouble replying properly right now.${cards.length ? " Here's what I found." : ""} You can also reach Sia Huat sales at ${SALES_CONTACT.phone} or ${SALES_CONTACT.email}.`,
    cards,
    chips: [],
    enquiry: { lines: input.lines, totals: enquiryTotals(input.lines) },
    showContact: true,
    provider: "fallback",
  };
}
