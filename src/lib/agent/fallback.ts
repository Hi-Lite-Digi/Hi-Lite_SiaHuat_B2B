// src/lib/agent/fallback.ts
import "server-only";
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { SALES_CONTACT } from "./contact";
import type { AgentReply } from "./contract";
import { enquiryTotals } from "./enquiry";
import { liveCheck, type FactDeps } from "./facts";

/** Used when Claude is unavailable or its reply fails the guards twice. */
export async function buildFallbackReply(input: { searchText: string | null; lines: EnquiryReceiptLine[]; deps: FactDeps }): Promise<AgentReply> {
  let cards: Product[] = [];
  const search = input.searchText?.trim() ?? "";
  if (search.length >= 2) {
    try {
      const found = await input.deps.searchDirect(search.slice(0, 80), 10);
      const checked = await Promise.all(found.slice(0, 3).map((item) => liveCheck(item, input.deps)));
      cards = checked.map((item) => item.product);
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
