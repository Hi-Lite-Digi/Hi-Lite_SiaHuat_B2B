// src/lib/agent/guards.ts
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { honestManualHandoff } from "@/lib/honest-handoff";
import { replyStyleIssues } from "@/lib/reply-style";
import { SALES_CONTACT } from "./contact";
import type { ShownCard } from "./contract";
import type { CheckedProduct } from "./facts";
import { codePattern, pointedCards } from "./picks";
import type { EnquiryChange } from "./tools";

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

/** Sentences of a reply. Splits after . ! ? only before a capital, digit, quote, bracket, bullet or $ (so "$5.69" stays whole), after 。！？, and at line breaks. */
export const sentences = (message: string) => message.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\-•*$])|(?<=[。！？])|\n+/).map((s) => s.trim()).filter(Boolean);

/** The message without the sentences `drop` picks; other text and line breaks are kept. */
export function removeSentences(message: string, drop: (sentence: string) => boolean) {
  let out = message;
  for (const sentence of sentences(message)) if (drop(sentence)) out = out.replace(sentence, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A reply cut off where Claude typed a raw " : with structured output that quote ends the message string (exam 2: 5 replies).
const properEnding = /(?:[.!?。！？…:)\]}"'”’»″′～~）」』]|\p{Script=Han}|\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\p{Extended_Pictographic}]*|https?:\/\/\S+|(?:\$|S\$|SG\$|SGD\s?)\d[\d,]*(?:\.\d{1,2})?)\s*$/u;
const listLine = /(?:^|\n)[ \t]*(?:[-•*]|\d{1,2}[.)])[ \t]+[^\n]+$/;
export const endsMidSentence = (message: string) => message.trim().length > 0 && !properEnding.test(message.trim()) && !listLine.test(message.trim());
export const MID_SENTENCE_ISSUE = "Your message stops mid-sentence. A double-quote character inside the message ends it early: write the whole message again without the \" character (inches as 16in, quoted words in single quotes).";
const danglingCurrency = /(?:^|[^\w$])(?:SG?)?\$(?!\s?\d)/;
export const DANGLING_CURRENCY_ISSUE = "A price is missing after the $ sign. Give the exact price from a tool result in this turn, or rephrase without a price.";

// A reservation claim only counts with no negation or condition before it, and no condition right after it, in the same clause.
// A sentence that opens with a condition waiting on sales ("Once sales confirm, ...") is conditional throughout. A bare "no" only
// negates when it opens the claim's subject ("No stock is reserved"), not "No rush: ...". 不锈 (stainless) and 不粘 (non-stick) are product words.
const negatedBefore = /\b(?:not|never|nothing|no longer|isn't|aren't|won't|can't|cannot|don't|doesn't|until|once|when|after|before|if)\b[^.!?,;]{0,30}$|\bno(?!\s+(?:problem|worries)\b)\s+[^\s.!?,;:]+(?:\s+[^\s.!?,;:]+)?\s*$|^\s*(?:once|when|after|before|if|until)\b[^.!?]*\b(?:sales|confirm\w*)\b|不(?![锈粘])|[没未]|无法/i;
const conditionAfter = /^[^.!?]{0,40}\b(?:when|once|after|if)\b/i;
// "reserved" also names products (reserved signs, table cards and plaques); 保留 and 锁定 alone are product words too.
const reserved = String.raw`reserved(?!\s+(?:table\s+)?(?:signs?|cards?|plaques?|stands?))`;
const reservationWords = new RegExp(String.raw`\b(?:${reserved}|on hold|set aside|put aside|held for you|booked for you|locked in for you)\b|\border (?:is|has been|was) (?:now )?(?:placed|confirmed|processed|submitted)\b|预留|(?:已|已经|为您|给您|帮您)(?:保留|锁定)|订单已(?:确认|提交)`, "i"); // style tier
const reservationClaim = new RegExp(String.raw`(?:\b(?:is|are|been|was|were|will be)|(?<!\blet)['’](?:re|s|ll be))\s+(?:already\s+|now\s+|all\s+)?(?:${reserved}|on hold|set aside|put aside)\b|\b(?:I|we)(?:'ve| have)\s+(?:reserved|set aside|put\b[^.!?]{0,25}\bon hold)\b|\border (?:is|has been|was) (?:now )?(?:placed|confirmed|processed|submitted)\b|已(?:为您|经)?(?:预留|保留|锁定)|订单已(?:确认|提交)`, "i"); // remove tier: no bare "held"
const claims = (sentence: string, pattern: RegExp) => {
  const m = pattern.exec(sentence);
  return !!m && !negatedBefore.test(sentence.slice(0, m.index)) && !conditionAfter.test(sentence.slice(m.index + m[0].length));
};
const isReservationClaim = (sentence: string) => claims(sentence, reservationClaim);
export const RESERVATION_ISSUE = "An enquiry doesn't reserve or hold stock and isn't an order. Say the items are on the enquiry and Sia Huat sales confirm stock and the order.";

/** Earlier turns from the chat history: the card codes of each Claire reply, her previous message, and what the customer just sent. */
export type EarlierTurns = { cardSets: string[][]; previousMessage: string | null; currentText: string };
const NO_EARLIER_TURNS: EarlierTurns = { cardSets: [], previousMessage: null, currentText: "" };
// Keyed only on the customer's words ("show me then i tap la"), never on Claire's own "tap it".
const asksAgain = /\b(?:again|those|them|same|previous|earlier|back)\b|\bshow (?:me )?(?:it|that|the (?:card|product|one))\b|\bwhere(?:'s| is)? (?:the )?(?:card|product)\b|\b(?:i(?:'ll| will)?|let me|to|can|then i) tap\b/i;
const cardSetKey = (codes: string[]) => [...new Set(codes.map((code) => code.toLowerCase()))].sort().join(" ");
const plainText = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
const REPEATED_CARDS_ISSUE = "You've already shown these same cards twice. Show different options, or none.";
const REPEATED_MESSAGE_ISSUE = "Don't repeat your previous message word for word; move the conversation forward.";

function repetitionIssues(message: string, cards: Product[], earlier: EarlierTurns) {
  const issues: string[] = [];
  if (cards.length && !asksAgain.test(earlier.currentText)) {
    const key = cardSetKey(cards.map((card) => card.stock_id));
    if (earlier.cardSets.filter((codes) => cardSetKey(codes) === key).length >= 2) {
      issues.push(REPEATED_CARDS_ISSUE);
    }
  }
  const plain = plainText(message);
  if (plain && earlier.previousMessage !== null && plain === plainText(earlier.previousMessage)) {
    issues.push(REPEATED_MESSAGE_ISSUE);
  }
  return issues;
}

export const NO_CARD_PREFIX = "No card attached";
// "tap it", "tap the Kenwood mixer to confirm", "tap the HET-4 card"; not a tap on a link, the PDF button or the enquiry bar, nor a water tap
// ("a tap that locks": after an article it is the noun).
const tapAsk = /(?<!\b(?:a|an|the|its|one|single)\s+)(?:\btap(?:ping)?\s+(?:on\s+)?(?:it|this|that|these|those|each|them|both|to\s+(?:add|confirm|select|choose|pick))\b|\btap\s+(?:the\s+)?(?:[\w'’″-]+\s+){0,5}(?:card|cards|item|product|to\s+(?:add|confirm|select|choose|pick))\b)/i;
const tapNotACard = /\btap\s+(?:the\s+)?(?:\w+\s+){0,3}(?:link|pdf|button|bar|chip|download|mic|photo|enquiry)\b/i;
export const asksForTap = (sentence: string) => tapAsk.test(sentence) && !tapNotACard.test(sentence);
const showPromise = /\b(?:let me|I'?ll|I will|one sec|one moment|hold on)\b[^.!?\n]{0,40}\b(?:pull|bring|show|get)\b[^.!?\n]{0,25}(?<!\bset )\bup\b|\b(?:pulling|bringing) (?:up|those|these|it|that)\b/i;
// "Let me know the type and I'll pull up options" waits for the customer; "having trouble pulling up the catalogue" is honest.
export const promisesToShow = (sentence: string) => showPromise.test(sentence) && !/\b(?:if|once|when|let me know|tell me|trouble|unable|cannot)\b|n['’]t\b/i.test(sentence);
const NO_CARD_TAP_ISSUE = `${NO_CARD_PREFIX}: you asked the customer to tap a card but card_ids is empty. Put its code in card_ids (any card shown earlier in this chat can be attached) or don't ask for a tap.`;
const NO_CARD_SHOW_ISSUE = `${NO_CARD_PREFIX}: you promised to show products but attached none. Attach them now or don't promise.`;
/** After the repair, a tap request or show promise with no card attached is cut out. */
export const noCardFixer: Fixer = {
  prefix: NO_CARD_PREFIX,
  fix: (message) => removeSentences(message, (s) => asksForTap(s) || promisesToShow(s)) || "Tell me which one by its name or code.",
};

/** What this turn's tools did, for checks on the reply. */
export type TurnFacts = { lines: EnquiryReceiptLine[]; changes: EnquiryChange[] };
/** Turn facts plus the products looked up this turn, which the reply's words can point at. */
export type ClaimFacts = TurnFacts & { seen: ReadonlyMap<string, CheckedProduct> };

export const ENQUIRY_CLAIM_PREFIX = "The enquiry didn't change";
const changeClaim = /\b(?:added|adding|removed|removing|updated|updating|dropped|noted down)\b|\bput\b[^.!?\n]{0,25}\bin(?:to)?\s+(?:your|the)\s+enquiry\b|\b(?:is|are|now)\s+(?:in|on)\s+(?:your|the)\s+enquiry\b|\bqty\s*\d+\s*done\b|^\s*(?:noted|got it|done|ok(?:ay)?)[:,!]?\s*\d|已(?:添加|加入|更新|删除|移除)|加好了|帮你加了/i;
const promiseChange = /\b(?:I'?ll|I will|let me|going to)\s+(?:add|put|remove|update|note)\b|\badding\b[^.!?\n]*\bnow\b|我来加/i;
const honestWording = /\b(?:not|never|nothing|no longer|yet to|trouble|unable|cannot|failed|want me to|shall I|should I|would you like)\b|n['’]t\b|\?\s*$/i;
// "Pick a plate you like, and I'll add it" waits for the customer too (exam 2, c05-B); "tap to select it, then I'll add" doesn't.
const conditionalWording = /\b(?:if|once|after|when|let me know|tell me)\b|\b(?:pick|choose)\s+(?:a|an|one|any|the|which(?:ever)?)\b[^.!?]*\b(?:and|then)\s+I'?ll\b/i;
// "contact sales to get that line added" is advice, not a claim (exam 2, c05-stress).
const notAboutEnquiry = /\bto get\b[^.!?]{0,30}\badded\b|\b(?:gst|tax|fee|charges?)\b[^.!?]{0,30}\badded\b|\badded\b[^.!?]{0,20}\b(?:gst|tax|on top|at checkout)\b|\bupdated (?:prices?|stock|list|link|photos?)\b|\bupdated (?:\w+ )?total\b|\bprices?\s+(?:has|have|was|were|is)\s+(?:been\s+)?(?:updated|dropped|changed)\b|\bremoved (?:[^.!?]{0,30} )?from (?:the|my) (?:list of )?(?:options|results|search)\b/i;
const removalWord = /\b(?:removed|removing|dropped)\b|已(?:删除|移除)/i;
// "Already added", "2 so far", "both are in your enquiry" describe the enquiry as it stands: true while the item is on it.
// A leading "Done" or "just added" reports a change this turn instead.
const statusWording = /\b(?:already|so far|still)\b/i;
const onEnquiryWording = /\b(?:is|are|now)\s+(?:in|on)\s+(?:your|the)\s+enquiry\b/i;
const reportsChange = /^\s*done\b|\bjust\s+(?:added|put|updated|removed)\b/i;
// Clauses: split at commas outside brackets, semicolons, dashes between words and a bracket holding its own change
// ("(19.1cm removed)"); never at a colon, so "Got it: 2 torches" stays whole.
const clausesOf = (sentence: string) => sentence
  .split(/,\s+(?![^()]*\))|[;；，]\s*|\s*[–—]\s*|\s-\s|\s*\((?=[^()]*\b(?:added|removed|updated|dropped)\b)/i)
  .map((part) => part.trim()).filter(Boolean);
// The fixer's line: true for a false add, change or removal, including of an item already on the enquiry.
const NOT_ON_ENQUIRY = "That change isn't on your enquiry yet.";

/**
 * Sentences that say an item was added, changed or removed, or promise to do it, when update_enquiry didn't do that
 * for the item this turn. The item is the product whose code the clause types, else the one its words point at.
 */
function falseEnquiryClaims(message: string, facts: ClaimFacts) {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const cards: ShownCard[] = [
    ...[...facts.seen.values()].map(({ product }) => ({ code: product.stock_id, name: product.name, price: null, link: null })),
    ...facts.lines.map((line) => ({ code: line.code, name: line.item, price: null, link: null })),
  ];
  const onLines = (card: ShownCard) => facts.lines.some((line) => same(line.code, card.code));
  const changed = (card: ShownCard, actions: EnquiryChange["action"][] = ["add", "set", "remove"]) => facts.changes.some((change) => change.code !== null && same(change.code, card.code) && actions.includes(change.action));
  const point = (text: string) => {
    const typed = cards.filter((card) => codePattern(card.code).test(text));
    return typed.length ? typed : pointedCards(text, cards);
  };
  // A clause with a change word, judged on its own: a swap's "HET-4 removed" and "WCT708K added" each hold for their item.
  const falseClause = (clause: string, statusAllowed: boolean) => {
    if (honestWording.test(clause)) return false;
    const status = statusAllowed && (statusWording.test(clause) || !changeClaim.test(clause.replace(onEnquiryWording, "")));
    const pointed = point(clause);
    if (!pointed.length) return !facts.changes.length && !(status && facts.lines.length);
    if (removalWord.test(clause)) return pointed.some((card) => onLines(card) && !changed(card, ["remove", "set"]));
    // An add or update needs its own change this turn; a status line only needs the item on the enquiry.
    return pointed.some((card) => !onLines(card) || !(status || changed(card, ["add", "set"])));
  };
  return sentences(message).filter((sentence) => {
    if (notAboutEnquiry.test(sentence)) return false;
    const promise = promiseChange.test(sentence) && !honestWording.test(sentence) && !conditionalWording.test(sentence);
    if (promise) {
      const pointed = point(sentence);
      if (!(pointed.length && pointed.every((card) => changed(card)))) return true;
    }
    // A condition ("once you pick one, I'll add it") only excuses a sentence with no past-tense claim in it.
    if (!changeClaim.test(sentence) || (conditionalWording.test(sentence) && !/\b(?:added|removed|updated)\b/i.test(sentence))) return false;
    const clauses = clausesOf(sentence).filter((clause) => changeClaim.test(clause));
    return (clauses.length ? clauses : [sentence]).some((clause) => falseClause(clause, !reportsChange.test(sentence)));
  });
}

/** Issues for sentences that say the enquiry changed (or will) when update_enquiry didn't change it this turn. */
export function enquiryClaimIssues(message: string, facts: ClaimFacts) {
  return falseEnquiryClaims(message, facts).map((sentence) => `${ENQUIRY_CLAIM_PREFIX} for: "${sentence.slice(0, 120)}". No update_enquiry call succeeded for it in this turn, so don't say it was added, changed or removed, and don't promise to do it later. Say it isn't on the enquiry yet and what you still need (which product, or how many).`);
}

/** The message with its false enquiry claims replaced by one NOT_ON_ENQUIRY line where the first one was. */
export function withoutEnquiryClaims(message: string, facts: ClaimFacts) {
  const [first, ...rest] = falseEnquiryClaims(message, facts);
  if (!first) return message;
  return removeSentences(message.replace(first, NOT_ON_ENQUIRY), (sentence) => rest.includes(sentence));
}

// Old Claire's reply-style text for a permission question; the new Claire gets NO_PERMISSION_ISSUE (or, when the question
// isn't about adding, NO_SHOW_PERMISSION_ISSUE) instead.
const CHOOSE_FIRST = "The customer must choose a product card first";
export const NO_PERMISSION_ISSUE = "Don't ask permission to add it. If the customer picked the product and typed how many, add it now with update_enquiry; if the quantity is missing, ask how many.";
export const NO_SHOW_PERMISSION_ISSUE = "Don't ask permission to show a product or check its stock: the cards already show it with the stock the tools found. Just say what you found.";
// "Want me to add it?", "Once you confirm I'll add it"; not "Want me to add 5, or check alternatives?" nor "How many, so I can add it?".
const asksToConfirmAdd = /\b(?:shall|should|can|may|want|would you like)\b(?![^?？\n]*\bor\b)[^?？\n]*(?<!\bso I can )\badd\b[^?？\n]*[?？]|\bonce you confirm\b[^.!?\n]*\badd\b|\bconfirming:?[^.?!\n]*\?/i;
// Judged per sentence, so "you can download the PDF. Anything else to add?" isn't one question. "How many would you like to
// add?" and "What else can I add?" ask what the prompt wants asked; "Want me to add it, and how many?" still asks permission.
const asksPermissionToAdd = (sentence: string) => asksToConfirmAdd.test(sentence) && !/\b(?:how many|else)\b[^?？]*\badd\b|\badd\s+(?:anything|more|another)\b/i.test(sentence);
const promiseLater = /\b(?:get|come) back to you\b|\bcircle back\b|\bfollow up (?:with you )?later\b/i;
export const PROMISE_LATER_ISSUE = "You only reply when the customer writes, so don't promise to get back to them. Give what you have now and say what comes next.";
const UNKNOWN_CARD_ISSUE_PREFIX = "card_ids must come from a tool result";

export function reviewAnswer(
  answer: FinalAnswer,
  seen: Map<string, CheckedProduct>,
  allowed: ReadonlySet<number>,
  earlier = NO_EARLIER_TURNS,
  turn: Partial<TurnFacts> = {},
): Review {
  const safety: string[] = [];
  const style: string[] = [];
  const ids = [...new Set(answer.card_ids)];
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length) safety.push(`${UNKNOWN_CARD_ISSUE_PREFIX} in this turn or shown earlier in this chat; not found: ${unknown.join(", ")}.`);
  if (ids.length > 5) style.push("Show at most 5 cards.");
  const cards = ids.filter((id) => seen.has(id)).slice(0, 5).map((id) => seen.get(id)!.product);
  // Chips that break the rules are dropped rather than sent back. A dropped chip takes any amount in it along.
  // A 'Yes, add it' chip is the confirm step the owner ruled out; 'Add more items' is not.
  const chips = answer.chips.filter((chip) => chipAllowed(chip) && !/\b(?:add|confirm)\b(?!\s+(?:more|another|other|anything)\b)/i.test(chip)).slice(0, 3);
  const amounts = unverifiedAmounts(answer.message, allowed);
  if (amounts.length) safety.push(`${MONEY_ISSUE_PREFIX} are not live-checked prices or enquiry totals from this turn: ${amounts.join(", ")}. Remove them or use the exact figures from the tools. When you drop an amount, rephrase the sentence; never leave a bare $.`);
  if (turn.changes) safety.push(...enquiryClaimIssues(answer.message, { lines: turn.lines ?? [], changes: turn.changes, seen }));
  if (!cards.length) {
    const said = sentences(answer.message);
    if (said.some(asksForTap)) safety.push(NO_CARD_TAP_ISSUE);
    if (said.some(promisesToShow)) safety.push(NO_CARD_SHOW_ISSUE);
  }
  style.push(...replyStyleIssues({ message: answer.message, products: cards, selectedProduct: null })
    .map((issue) => (!issue.startsWith(CHOOSE_FIRST) ? issue : /\badd\b/i.test(answer.message) ? NO_PERMISSION_ISSUE : NO_SHOW_PERMISSION_ISSUE)));
  if (sentences(answer.message).some(asksPermissionToAdd) && !style.includes(NO_PERMISSION_ISSUE)) style.push(NO_PERMISSION_ISSUE);
  if (promiseLater.test(answer.message)) style.push(PROMISE_LATER_ISSUE);
  if (endsMidSentence(answer.message)) style.push(MID_SENTENCE_ISSUE);
  if (danglingCurrency.test(answer.message)) style.push(DANGLING_CURRENCY_ISSUE);
  if (sentences(answer.message).some((s) => claims(s, reservationWords))) style.push(RESERVATION_ISSUE);
  style.push(...repetitionIssues(answer.message, cards, earlier));
  return { safety, style, cards, chips };
}

/** Fixes in code the safety issues that start with `prefix`. */
export type Fixer = { prefix: string; fix: (message: string) => string };

/** Runs each fixer whose issue is present, in list order; issues no fixer covers are returned in `left`. */
export function applyFixers(message: string, safety: string[], fixers: Fixer[]) {
  const covers = (fixer: Fixer, issue: string) => issue.startsWith(fixer.prefix);
  const fixed = fixers.reduce((text, fixer) => (safety.some((issue) => covers(fixer, issue)) ? fixer.fix(text) : text), message);
  return { message: fixed, left: safety.filter((issue) => !fixers.some((fixer) => covers(fixer, issue))) };
}

// Log codes by issue prefix; any other issue is a wording (STYLE) issue. Later guards add their rows.
const ISSUE_CODES: Array<[prefix: string, code: string]> = [
  [UNKNOWN_CARD_ISSUE_PREFIX, "UNKNOWN_CARD"],
  [MONEY_ISSUE_PREFIX, "MONEY"],
  [ENQUIRY_CLAIM_PREFIX, "ENQUIRY_CLAIM"],
  [MID_SENTENCE_ISSUE, "MID_SENTENCE"],
  [DANGLING_CURRENCY_ISSUE, "DANGLING_CURRENCY"],
  [NO_CARD_PREFIX, "NO_CARD"],
  [REPEATED_CARDS_ISSUE, "REPEAT"],
  [REPEATED_MESSAGE_ISSUE, "REPEAT"],
];

/** A review issue as a log code: the issue text can quote the reply, so only the code is logged. */
export const issueCode = (issue: string) => ISSUE_CODES.find(([prefix]) => issue.startsWith(prefix))?.[1] ?? "STYLE";

/** Light clean-up for a reply sent with style problems left after the repair. */
export function tidyMessage(message: string) {
  let tidied = message
    .replace(/^\s*Noted\b/i, "Got it")
    .replace(/\b(?:show_contact|card_ids)\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?])/g, "$1")
    .trim();
  tidied = removeSentences(tidied, (s) => danglingCurrency.test(s) || promiseLater.test(s)) || tidied;
  if (endsMidSentence(tidied)) {
    const last = [...tidied.matchAll(/[.!?](?=\s)|[。！？]/g)].at(-1); // a decimal point is not a sentence end
    if (last?.index) tidied = tidied.slice(0, last.index + 1);
  }
  return tidied;
}

// honestManualHandoff appends this after removing a claim; the reply's contact block says it better.
const HANDOFF_SENTENCE = "No staff member has been notified automatically. Use the PDF button and contact Sia Huat sales directly.";
// Used when the staff claim was the whole message, so the contact block never arrives without words.
const CONTACT_LINE = "You can reach our sales team directly below.";

// A phone number: a Singapore number (optional 65 or +65, then 8 digits starting 3, 6, 8 or 9, split only 4+4), a 1800 or
// 1-800 toll-free number, or a longer number that starts with a + country code. Item codes (218455-20), dates and lists of
// sizes don't fit.
const phone = String.raw`(?:\+?65[ -]?)?[3689]\d{3}[ -]?\d{4}|1[ -]?800[ -]?\d{3}[ -]?\d{4}|\+\d(?:[ -]?\d){7,}`;
// An email address, or a phone number standing on its own (not part of a longer run of numbers or a decimal).
const contactPattern = new RegExp(String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w$+-]|\d[ .-])(?:${phone})(?![ -]?\d|\w)`, "gi");
const OTHER_CONTACT = "Sia Huat sales (details below)";
const phoneDigits = (text: string) => text.replace(/\D/g, "").replace(/^65(?=\d{8}$)/, "");
const isSalesContact = (found: string) => (found.includes("@")
  ? found.toLowerCase() === SALES_CONTACT.email.toLowerCase()
  : phoneDigits(found) === phoneDigits(SALES_CONTACT.phone));

/**
 * Final safety pass on the words the customer sees. A sentence claiming stock is reserved or an order placed is
 * removed (an enquiry reserves nothing). A phone number or email that isn't Sia Huat's sales contact is replaced
 * with a pointer to the contact block; that, or a removed staff claim, turns the block on.
 */
export function customerMessage(message: string) {
  const trimmed = message.trim();
  const unreserved = sentences(trimmed).some(isReservationClaim) ? removeSentences(trimmed, isReservationClaim) : trimmed;
  if (trimmed && !unreserved) return { message: CONTACT_LINE, showContact: true };
  const contactChecked = unreserved.replace(contactPattern, (found) => (isSalesContact(found) ? found : OTHER_CONTACT));
  const checked = honestManualHandoff(contactChecked);
  if (checked === contactChecked) return { message: contactChecked, showContact: contactChecked !== unreserved };
  return { message: checked.replace(HANDOFF_SENTENCE, "").trim() || CONTACT_LINE, showContact: true };
}
