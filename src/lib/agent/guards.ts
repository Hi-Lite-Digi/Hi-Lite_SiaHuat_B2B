// src/lib/agent/guards.ts
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { honestManualHandoff } from "@/lib/honest-handoff";
import { replyStyleIssues } from "@/lib/reply-style";
import type { CheckedProduct } from "./facts";

export type FinalAnswer = { message: string; card_ids: string[]; chips: string[]; show_contact: boolean };
/**
 * safety: problems that must never reach the customer (made-up cards, unchecked amounts).
 * style: wording problems worth one repair, but not worth replacing the reply with the backup one.
 * chips: the chips that may be sent (at most 3, short, no numbers).
 */
export type Review = { safety: string[]; style: string[]; cards: Product[]; chips: string[] };

export const MONEY_ISSUE_PREFIX = "These amounts";
const chipNumberPattern = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b|[一二两三四五六七八九十百]/i;

/** A chip is sent as the customer's answer, so it must be short and never carry a number or quantity. */
export function chipAllowed(chip: string) {
  return chip.length <= 40 && !chipNumberPattern.test(chip);
}
const amount = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
// $X, S$X, SG$X, SGD X, 新币X (groups 1-2), or X SGD, X dollars/bucks, X元, X新币 (groups 3-4). 块 is left out: it is also a counting word ("3块砧板").
const moneyPattern = new RegExp(String.raw`(?:SG?\$|\$|SGD|新币)\s?${amount}|(?<![\d.,])${amount}\s?(?:(?:SGD|dollars?|bucks)\b|元|新币)`, "gi");
const toCents = (match: RegExpMatchArray) => {
  const whole = match[1] ?? match[3];
  const fraction = match[2] ?? match[4];
  return Number(whole.replace(/,/g, "")) * 100 + Number((fraction ?? "0").padEnd(2, "0"));
};

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
    .filter((match) => !allowed.has(toCents(match)))
    .map((match) => match[0]);
}

export function removeAmounts(message: string, amounts: string[]) {
  return message.replace(moneyPattern, (match) => (amounts.includes(match) ? "the listed price" : match));
}

/** Earlier turns from the chat history: the card codes of each Claire reply, her previous message, and what the customer just sent. */
export type EarlierTurns = { cardSets: string[][]; previousMessage: string | null; currentText: string };
const NO_EARLIER_TURNS: EarlierTurns = { cardSets: [], previousMessage: null, currentText: "" };
const asksAgain = /\b(?:again|those|them|same|previous|earlier|back)\b/i;
const cardSetKey = (codes: string[]) => [...new Set(codes.map((code) => code.toLowerCase()))].sort().join(" ");
const plainText = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();

function repetitionIssues(message: string, cards: Product[], earlier: EarlierTurns) {
  const issues: string[] = [];
  if (cards.length && !asksAgain.test(earlier.currentText)) {
    const key = cardSetKey(cards.map((card) => card.stock_id));
    if (earlier.cardSets.filter((codes) => cardSetKey(codes) === key).length >= 2) {
      issues.push("You've already shown these same cards twice. Show different options, or none.");
    }
  }
  const plain = plainText(message);
  if (plain && earlier.previousMessage !== null && plain === plainText(earlier.previousMessage)) {
    issues.push("Don't repeat your previous message word for word; move the conversation forward.");
  }
  return issues;
}

export function reviewAnswer(answer: FinalAnswer, seen: Map<string, CheckedProduct>, allowed: ReadonlySet<number>, earlier = NO_EARLIER_TURNS): Review {
  const safety: string[] = [];
  const style: string[] = [];
  const ids = [...new Set(answer.card_ids)];
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length) safety.push(`card_ids must come from a tool result in this turn; not found: ${unknown.join(", ")}.`);
  if (ids.length > 5) style.push("Show at most 5 cards.");
  const cards = ids.filter((id) => seen.has(id)).slice(0, 5).map((id) => seen.get(id)!.product);
  // Chips that break the rules are dropped rather than sent back. A dropped chip takes any amount in it along.
  const chips = answer.chips.filter(chipAllowed).slice(0, 3);
  const amounts = unverifiedAmounts(answer.message, allowed);
  if (amounts.length) safety.push(`${MONEY_ISSUE_PREFIX} are not live-checked prices or enquiry totals from this turn: ${amounts.join(", ")}. Remove them or use the exact figures from the tools.`);
  style.push(...replyStyleIssues({ message: answer.message, products: cards, selectedProduct: null }));
  style.push(...repetitionIssues(answer.message, cards, earlier));
  return { safety, style, cards, chips };
}

/** Light clean-up for a reply sent with style problems left after the repair. */
export function tidyMessage(message: string) {
  return message
    .replace(/^\s*Noted\b/i, "Got it")
    .replace(/\b(?:show_contact|card_ids)\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?])/g, "$1")
    .trim();
}

// honestManualHandoff appends this after removing a claim; the reply's contact block says it better.
const HANDOFF_SENTENCE = "No staff member has been notified automatically. Use the PDF button and contact Sia Huat sales directly.";

/** Final safety pass on the words the customer sees. A removed staff claim turns the contact block on. */
export function customerMessage(message: string) {
  const trimmed = message.trim();
  const checked = honestManualHandoff(trimmed);
  if (checked === trimmed) return { message: trimmed, showContact: false };
  return { message: checked.replace(HANDOFF_SENTENCE, "").trim(), showContact: true };
}
