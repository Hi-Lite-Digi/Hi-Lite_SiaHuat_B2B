// src/lib/agent/guards.ts
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { honestManualHandoff } from "@/lib/honest-handoff";
import { replyStyleIssues } from "@/lib/reply-style";
import type { CheckedProduct } from "./facts";

export type FinalAnswer = { message: string; card_ids: string[]; chips: string[]; show_contact: boolean };
export type Review = { issues: string[]; cards: Product[] };

export const MONEY_ISSUE_PREFIX = "These amounts";
const moneyPattern = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const toCents = (whole: string, fraction?: string) => Number(whole.replace(/,/g, "")) * 100 + Number((fraction ?? "0").padEnd(2, "0"));

/** Amounts Claire may mention: live-checked prices, enquiry line prices and totals. */
export function allowedCents(seen: Map<string, CheckedProduct>, lines: EnquiryReceiptLine[], grandTotal: number) {
  const cents = new Set<number>();
  for (const { product, verified } of seen.values()) if (verified) cents.add(Math.round(product.list_price * 100));
  for (const line of lines) {
    cents.add(Math.round(line.pricePerItem * 100));
    cents.add(Math.round(line.total * 100));
  }
  cents.add(Math.round(grandTotal * 100));
  return cents;
}

export function unverifiedAmounts(message: string, allowed: ReadonlySet<number>) {
  return [...message.matchAll(moneyPattern)]
    .filter((match) => !allowed.has(toCents(match[1], match[2])))
    .map((match) => match[0]);
}

export function removeAmounts(message: string, amounts: string[]) {
  return amounts.reduce((text, amount) => text.split(amount).join("the listed price"), message);
}

export function reviewAnswer(answer: FinalAnswer, seen: Map<string, CheckedProduct>, allowed: ReadonlySet<number>): Review {
  const issues: string[] = [];
  const ids = [...new Set(answer.card_ids)];
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length) issues.push(`card_ids must come from a tool result in this turn; not found: ${unknown.join(", ")}.`);
  if (ids.length > 5) issues.push("Show at most 5 cards.");
  const cards = ids.filter((id) => seen.has(id)).slice(0, 5).map((id) => seen.get(id)!.product);
  const amounts = unverifiedAmounts(answer.message, allowed);
  if (amounts.length) issues.push(`${MONEY_ISSUE_PREFIX} are not live-checked prices or enquiry totals from this turn: ${amounts.join(", ")}. Remove them or use the exact figures from the tools.`);
  issues.push(...replyStyleIssues({ message: answer.message, products: cards, selectedProduct: null }));
  if (answer.chips.length > 3 || answer.chips.some((chip) => chip.length > 40 || /^\s*\d+\s*$/.test(chip))) {
    issues.push("Chips: at most 3 short answers under 40 characters, never bare numbers.");
  }
  return { issues, cards };
}

/** Final safety pass on the words the customer sees. */
export function customerMessage(message: string) {
  return honestManualHandoff(message.trim());
}
