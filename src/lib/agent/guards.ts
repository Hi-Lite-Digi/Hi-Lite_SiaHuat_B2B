// src/lib/agent/guards.ts
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { honestManualHandoff } from "@/lib/honest-handoff";
import { replyStyleIssues } from "@/lib/reply-style";
import { SALES_CONTACT } from "./contact";
import type { ShownCard } from "./contract";
import { withGstCents } from "./enquiry";
import type { CheckedProduct } from "./facts";
import { codePattern, hits, pointedCards, same } from "./picks";
import type { EnquiryChange, SearchRecord } from "./tools";

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

/**
 * Amounts Claire may mention: live-checked prices, enquiry line prices and totals, and code's GST estimates (a live-checked price
 * with GST; the enquiry total with GST and its GST part). Not gated on GST words: "ok so final total how much ah, i tell boss", two
 * turns after an estimate, had its right figure repaired away in 3 of 3 runs. No total with GST while a line is unchecked: the
 * total leaves it out, and a sum Claude worked out on part of the enquiry would pass (2 of 3 GST replay drafts did).
 */
export function allowedCents(seen: Map<string, CheckedProduct>, lines: EnquiryReceiptLine[], grandTotal: number, allLinesChecked = true) {
  const cents = new Set<number>();
  for (const { product, verified } of seen.values()) if (verified) cents.add(Math.round(product.list_price * 100)).add(withGstCents(product.list_price));
  for (const line of lines) {
    cents.add(Math.round(line.pricePerItem * 100));
    cents.add(Math.round(line.total * 100));
  }
  cents.add(Math.round(grandTotal * 100));
  if (lines.length && allLinesChecked) {
    const withGst = withGstCents(grandTotal);
    cents.add(withGst).add(withGst - Math.round(grandTotal * 100));
  }
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
function removeSentences(message: string, drop: (sentence: string) => boolean) {
  let out = message;
  for (const sentence of sentences(message)) if (drop(sentence)) out = out.replace(sentence, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// A reply cut off where Claude typed a raw " : with structured output that quote ends the message string (exam 2: 5 replies).
const properEnding = /(?:[.!?。！？…:)\]}"'”’»″′～~）」』]|\p{Script=Han}|\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\p{Extended_Pictographic}]*|https?:\/\/\S+|store\.siahuat\.com\S*|(?:\$|S\$|SG\$|SGD\s?)\d[\d,]*(?:\.\d{1,2})?)\s*$/u;
const listLine = /(?:^|\n)[ \t]*(?:[-•*]|\d{1,2}[.)])[ \t]+[^\n]+$/;
export const endsMidSentence = (message: string) => message.trim().length > 0 && !properEnding.test(message.trim()) && !listLine.test(message.trim());
export const MID_SENTENCE_ISSUE = "Your message stops mid-sentence. A double-quote character inside the message ends it early: write the whole message again without the \" character (inches as 16in, quoted words in single quotes).";
const danglingCurrency = /(?:^|[^\w$])(?:SG?)?\$(?!\s?\d)/;
export const DANGLING_CURRENCY_ISSUE = "A price is missing after the $ sign. Give the exact price from a tool result in this turn, or rephrase without a price.";

// A reservation claim only counts with no negation or condition before it, and no condition right after it, in the same clause.
// A dash (—, –, or a spaced hyphen) starts a new clause like a comma does ("Don't worry—they're reserved" is a claim).
// A sentence that opens with a condition waiting on sales ("Once sales confirm, ...", "Once confirmed, ...") is conditional
// throughout; one the customer meets ("Once you confirm, ...") is not. A bare "no" only negates when it opens the claim's
// subject ("No stock is reserved"), not "No rush: ...". 不锈 (stainless) and 不粘 (non-stick) are product words.
const inClause = String.raw`(?:(?!\s-\s)[^.!?,;—–])`;
const clauseWord = String.raw`[^\s.!?,;:—–]+`;
const negatedBefore = new RegExp(String.raw`\b(?:not|never|nothing|no longer|isn't|aren't|won't|can't|cannot|don't|doesn't|until|once|when|after|before|if)\b${inClause}{0,30}$|\bno(?!\s+(?:problem|worries)\b)\s+${clauseWord}(?:\s+${clauseWord})?\s*$|^\s*(?:once|when|after|before|if|until)\b[^.!?]*(?:\bsales\s+(?:team\s+)?(?:\w+\s+)?(?:confirm|check|approv|verif)\w*|(?<!\byou(?:'ve|\s+have)?\s+)\bconfirmed\b)|不(?![锈粘])|[没未]|无法`, "i");
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

/**
 * Earlier turns from the chat history: the card codes of each Claire reply, her previous message, what the customer just sent,
 * the store links already in the chat (card notes included), the links of Claire's previous reply, and the text of all her replies
 * in the history, oldest first (previousMessage is the last).
 */
export type EarlierTurns = { cardSets: string[][]; previousMessage: string | null; currentText: string; links?: string[]; previousLinks?: string[]; replies?: string[] };
const NO_EARLIER_TURNS: EarlierTurns = { cardSets: [], previousMessage: null, currentText: "" };
// Keyed only on the customer's words ("where the product?? show me then i tap la", "u nvr show anything"), never on Claire's own
// "tap it". Show words or card nouns make again/same/those/back an ask to see cards again; on their own they are complaints,
// quantities and picks ("SAME qty la", "add back 2", "why need tap again", "only 1 of them") (exam 3: all 6 identical third
// showings). "no need show again" asks not to see them.
const againWord = String.raw`(?:again|those|them|same|previous|earlier|back)`;
const notBefore = String.raw`(?<!\b(?:dun|don'?t|dont|do\s+not|stop|no\s+need(?:\s+to)?|(?:dun|don'?t|dont)\s+need\s+to|won'?t|wont|will\s+not|never|nvr)\s+)`;
const asksAgain = new RegExp([
  String.raw`${notBefore}\b(?:show|see|resend|list|pull\s+up|bring\s+up)\b[^.?!\n]{0,25}\b${againWord}\b`,
  String.raw`${notBefore}\b(?:send|give)\b[^.?!\n]{0,25}\bagain\b`,
  String.raw`(?<!\b(?:dun|don'?t|dont|not|no|stop)\b[^.?!\n]{0,20})\b(?:those|them|the\s+same|previous|earlier|last)\s+(?:\w+\s+)?(?:cards?|options?|ones|products|items|list|pics?|photos?)\b`,
  String.raw`\b(?:cards?|options?|ones|products)\s+again\b`,
  String.raw`\b(?:go|going|come)\s+back\s+to\b`,
  String.raw`\bshow (?:me )?(?:it|that|the (?:card|product|one))\b`,
  String.raw`\bwhere(?:'s| is)? (?:the )?(?:card|product)\b`,
  String.raw`\b(?:tap|click)\s+(?:where|what)\b`,
  String.raw`\bnothing to (?:tap|click)\b`,
  String.raw`\b(?:nvr|never|didn'?t|dint|did not)\s+(?:show|see|saw)\w*`,
  String.raw`\bi (?:don'?t|dun|cannot|can'?t) see\b`,
].join("|"), "i");
const cardSetKey = (codes: string[]) => [...new Set(codes.map((code) => code.toLowerCase()))].sort().join(" ");
const plainText = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
// The repair runs with tools off, so it can't show different options.
const REPEATED_CARDS_ISSUE = "You've already shown this same set of cards twice. Don't attach the whole set again (you can name them, and attach only the one you recommend). Answer what the customer just said, recommend one if they are choosing, and don't ask again a question you already asked.";
const REPEATED_MESSAGE_ISSUE = "Don't repeat your previous message word for word; move the conversation forward.";
// A closing offer to do something, or a push for a pick or a quantity (exam 2, c05-A: "Want me to add 4 of each?" two replies running).
const offerPattern = /\b(?:want (?:me to|to (?:add|go|take|order))|shall (?:i|we)|should i|would you like (?:me to|to (?:add|go|order))|how many\b|go ahead|add (?:it|them|this|these|one|either|any|\d+)\b)/i;
const genericAsk = /\b(?:anything|something) else\b|^what else\b/i;
const YES = "yes|yeah|ya|yup|ok(?:ay)?|sure|can|go ahead|add(?: it| them)?|confirm|do it";
// "yes la", "Yes, add it", "ok can", "yes pls add".
const plainYes = new RegExp(`^\\s*(?:${YES})(?:[\\s,]*(?:${YES}|la|lah|leh|pls|please))*[\\s.!]*$`, "i");
const lastQuestion = (message: string) => sentences(message).reverse().find((sentence) => /[?？]$/.test(sentence)) ?? null;
const OFFER_STOP = new Set(["the", "a", "an", "to", "of", "me", "you", "your", "it", "is", "are", "and", "or", "for", "i", "we", "do", "this", "that", "these", "those", "with", "in", "on"]);
const offerWords = (text: string) => new Set((text.toLowerCase().match(/\p{L}{2,}|\d+/gu) ?? []).filter((word) => !OFFER_STOP.has(word)).map((word) => word.replace(/s$/, "")));
/** Both are offers (not a generic "anything else?") that share 3 or more content words, and most of the shorter one's. */
function sameOffer(current: string, previous: string) {
  if (![current, previous].every((ask) => offerPattern.test(ask) && !genericAsk.test(ask))) return false;
  const [now, before] = [offerWords(current), offerWords(previous)];
  const shared = [...now].filter((word) => before.has(word)).length;
  return shared >= 3 && shared / Math.min(now.size, before.size) >= 0.6;
}
const OFFER_ISSUE_PREFIX = "Your last reply ended with the same offer";
// Claire asking for the customer's photo to be sent again (exam 2, c12: asked on every turn).
const photoAgain = /\b(?:re-?send(?:ing)?|send(?:ing)? (?:it|the (?:photo|image|picture|pic)) (?:again|once more)|attach(?:ing)? (?:it|the (?:photo|image|picture)) again|try (?:attaching|sending|resending))\b|\b(?:photo|image|picture|pic)\b[^.?!]{0,40}\b(?:come|came|coming|go|goes|went|going) through\b/i;
// Only a question counts: "Thanks for resending, the photo came through" is not an ask.
const asksPhotoAgain = (message: string) => sentences(message).some((sentence) => /[?？]$/.test(sentence) && photoAgain.test(sentence));
export const PHOTO_AGAIN_ISSUE = "You already asked once for the photo. Don't ask again: ask what it looks like or what it's for (shape, size, material, any brand or label) and offer Sia Huat sales (show_contact true).";

function repetitionIssues(message: string, cards: Product[], earlier: EarlierTurns, changed: boolean, needed: boolean) {
  const issues: string[] = [];
  const key = cardSetKey(cards.map((card) => card.stock_id));
  if (cards.length && !needed && !asksAgain.test(earlier.currentText)) {
    if (earlier.cardSets.filter((codes) => cardSetKey(codes) === key).length >= 2) {
      issues.push(REPEATED_CARDS_ISSUE);
    }
  }
  const previous = earlier.previousMessage;
  const plain = plainText(message);
  if (plain && previous !== null && plain === plainText(previous)) {
    issues.push(REPEATED_MESSAGE_ISSUE);
  }
  // A card tap (no text), a plain yes or an enquiry change this turn takes the offer up; a new product is a new offer.
  const offer = lastQuestion(message);
  const offerBefore = previous === null ? null : lastQuestion(previous);
  if (offer && offerBefore && earlier.currentText && !changed && !plainYes.test(earlier.currentText) && key === cardSetKey(earlier.cardSets.at(-1) ?? []) && sameOffer(offer, offerBefore)) {
    issues.push(`${OFFER_ISSUE_PREFIX} ("${offerBefore.slice(0, 160)}") and the customer didn't take it up. Don't make it again: answer what they just said, or try a different next step. Tools are off for this fix, so don't say anything was added, removed or checked.`);
  }
  if (previous !== null && asksPhotoAgain(message) && asksPhotoAgain(previous)) issues.push(PHOTO_AGAIN_ISSUE);
  return issues;
}

// Pointing the customer to Sia Huat sales or the enquiry PDF.
const handoffPitch = /\b(?:contact|reach|call|email|check with|speak (?:to|with)|talk to)\b[^.?!\n]{0,40}\bsales\b|\bPDF\b/i;
// Asking what to do next is asking for the route too (r4 c08-stress idx 13: "so now how, u send my order to them or i must do wat").
const asksForContact = /\b(?:what(?:['’]?s| is)?|give|send|got|can i|how (?:to|do i))\b[^.?!]{0,30}\b(?:phone|number|contact|email|pdf)\b|\b(?:speak|talk) to (?:someone|a person|a human|staff|sales)\b|\bq(?:uo|ou)t(?:e|ation)s?\b|\bcall me\b|\bget someone\b|\bsomeone (?:to )?call\b|\b(?:real|actual) (?:person|human)\b|\bi(?:['’]ll| will)? call\b|\bhow (?:to |do i |can i |i )?(?:order|buy|download|pay)\b|\b(?:send|pass|forward|submit)\b[^.?!]{0,20}\b(?:order|enquiry|list)\b|\b(?:what|wat)\s+(?:do|must|should|shld)\s+i\s+do\b|\bi\s+(?:must|need\s+to|have\s+to)\s+do\s+(?:what|wat)\b|\bhow\s+(?:to|do\s+i|can\s+i)\s+(?:proceed|place|confirm|complete)\b|\bnow\s+how\b(?!\s+(?:much|many|long|big))|电话|联系方式|报价/i;
// Asked if she's a bot, her answer names Sia Huat's sales staff as the real people to reach (exam 3, c02-stress T14). "ai" only
// counts after "u", "are", "is" or "an": it is also Hokkien for "want" ("wa ai 2 pcs leh").
const asksIfBot = /\b(?:(?:chat)?bot|human)\b|\b(?:u|you|are|r|is|it|this|an?)\s+(?:an?\s+)?ai\b|机器人/i;
// "thank u" and "tysm" too, as the loop's thank-you turns (exam 3, s01-B T3).
const closingOnly = /^\s*(?:ok(?:ay)?|k|thanks?|thank (?:you|u)|thx|ty|tq|tysm|no,? that'?s all|that'?s all|bye|noted|alright)\b[\s.!,]*(?:(?:thanks?|thank (?:you|u)|thx|tysm|bye)[\s.!,]*){0,2}$/i;
// A pitch sentence that also says what Claire can't do may be the answer to the customer's question (exam 2, s06-B: delivery timing).
const limitation = /\b(?:can['’]?t|cannot|unable|not able|out of stock)\b/i;
const apology = /\b(?:sorry|apolog(?:y|ies|i[sz]e[sd]?)|my (?:mistake|bad))\b/i;
// What only sales can do for the customer.
const SALES_TOPICS = [/\bsourc/i, /\bspecial[- ]order/i, /\blead[- ]?times?\b/i, /\brestock/i, /\bbulk\b/i, /\bdiscount/i, /\bdeliver/i, /\bcollect(?:ion|ing)?\b/i, /\b(?:visit\w*|showroom)\b/i, /\baddress\b/i];
// Telling a customer who thinks the chat ordered that nothing has reached Sia Huat: its route to order is the answer, not a repeat
// (r4 s07-A; without this the c08-stress idx 13 replays lost the route 3 of 3 times).
const notSentYet = /\bnothing (?:from this chat )?has (?:been sent|reached|gone)\b|\b(?:still|stays|remains) (?:just |only )?(?:an|as an) enquiry\b|\b(?:isn['’]?t|not) (?:yet )?an order\b|\bhasn['’]?t (?:been sent|reached)\b/i;

/**
 * The message without its sales or PDF pitch when one of Claire's earlier replies already made it and the contact block shows
 * (it carries the phone and email, and the PDF link once the enquiry has items), unless the customer asked for contact or a quote,
 * asked if Claire is a bot, or only said thanks (exam 2, c12-stress).
 * Any earlier reply counts, not only the last: the history carries the text after this drop, so the pitch would come back every other turn.
 */
export function dropRepeatedPitch(message: string, earlier: EarlierTurns, showContact: boolean) {
  if (notSentYet.test(message)) return message;
  const replies = earlier.replies ?? (earlier.previousMessage ? [earlier.previousMessage] : []);
  const pitched = replies.some((reply) => handoffPitch.test(reply));
  if (!showContact || !pitched || asksForContact.test(earlier.currentText) || asksIfBot.test(earlier.currentText) || closingOnly.test(earlier.currentText)) return message;
  // What sales can do for this request, said for the first time or about what the customer just asked, is the answer, not a
  // repeat (exam 3, s03-B T2: sourcing); an apology is never dropped with it (exam 3, c05-stress T13-T15).
  const answersTopic = (sentence: string) => SALES_TOPICS.some((topic) => topic.test(sentence) && (!replies.some((reply) => topic.test(reply)) || topic.test(earlier.currentText)));
  return removeSentences(message, (sentence) => handoffPitch.test(sentence) && !limitation.test(sentence) && !apology.test(sentence) && !answersTopic(sentence)) || message;
}

// A closing "Anything else ...?" as its own sentence ("Want the Kenwood, or anything else?" is a real question).
const closingAsk = /(?:^|(?<=[.!?]\s+)|(?<=\n))anything else\b[^.?!\n]{0,40}\?\s*$/i;
/**
 * The message without its closing "Anything else?" unless the enquiry changed this turn and the last reply didn't end on one
 * too: r4 c09-persona ended 9 replies with it, c03-stress 7. A message that is only the closer is kept.
 */
export function withoutRepeatedCloser(message: string, previousMessage: string | null, changed: boolean) {
  if (!closingAsk.test(message) || (changed && !closingAsk.test(previousMessage?.trim() ?? ""))) return message;
  return message.replace(closingAsk, "").trim() || message;
}

export const LINK_ISSUE_PREFIX = "These store links";
// ASCII only, and not ending on punctuation, so a link stops before 。, an em dash, a curly quote or a full stop.
const anyStoreLink = /(?:https?:\/\/)?store\.siahuat\.com(?:\/[\w\-.~%\/?#=&+]*[\w\-~%\/#=&+])?/gi;
const STORE_HOME = "https://store.siahuat.com";
const linkKey = (link: string) => link.replace(/^(?:https?:\/\/)?/i, "https://").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
export const storeLinks = (text: string) => [...text.matchAll(anyStoreLink)].map((match) => match[0]);
/** The message with these links cut back to the store's home address. */
export function removeLinks(message: string, links: string[]) {
  return message.replace(anyStoreLink, (link) => (links.includes(link) ? "store.siahuat.com" : link));
}

/** Store links in the message that no product looked up this turn and nothing in the chat gave (exam 2: links built from item codes). */
export function unknownStoreLinks(message: string, seen: ReadonlyMap<string, CheckedProduct>, earlier: EarlierTurns) {
  const known = new Set([...[...seen.values()].flatMap(({ product }) => (product.source_url ? [product.source_url] : [])), ...(earlier.links ?? [])].map(linkKey));
  return storeLinks(message).filter((link) => linkKey(link) !== STORE_HOME && !known.has(linkKey(link)));
}

// "zyliss link cannot open leh", "Same link. Still not working", "the link got nothing inside" (exam 2, c03 and c08). A bare "still
// no" or "still not" isn't one: "i open the link still no photo", "still not sure which, the website say 5 dollar".
const linkWord = /\b(?:link|url|page|website|site)s?\b|链接|网页/i;
const linkFails = /\b(?:not (?:work|open|load)\w*|(?:can ?not|can't|cant|couldn't|won't|wont|doesn't|doesnt|didn't|dun|don't|never) (?:open|load|work)\w*|broken|dead|empty|nothing (?:inside|there|come|show)\w*|error|not found|still (?:no|not|can'?t|cannot)\s*(?:work|open|load)\w*|same link)\b|打不开|无法打开/i;
const choosing = /\d|\b(?:add|take|tap|buy|order|show)\b/i;
const blamesCustomer = /\b(?:browser|network|connection|cach(?:e|ing)|incognito|private window|on your (?:side|end))\b/i;
export const BROKEN_LINK_ISSUE = "The customer says a link you sent doesn't open. Don't send that link again. Give the item code and the facts from the tools, and offer Sia Huat sales for photos (show_contact true) or a similar product.";
export const LINK_BLAME_ISSUE = "Don't suggest the problem is the customer's browser, network or device.";

/** When the customer says a link doesn't open: the same link typed again or on a card they didn't ask for, or blame on their side. */
function brokenLinkIssues(message: string, cards: Product[], earlier: EarlierTurns) {
  if (!linkWord.test(earlier.currentText) || !linkFails.test(earlier.currentText)) return [];
  const previous = new Set((earlier.previousLinks ?? []).map(linkKey).filter((key) => key !== STORE_HOME));
  const retyped = storeLinks(message).some((link) => previous.has(linkKey(link)));
  const onCard = !choosing.test(earlier.currentText) && cards.some((card) => card.source_url && previous.has(linkKey(card.source_url)));
  return [...(retyped || onCard ? [BROKEN_LINK_ISSUE] : []), ...(blamesCustomer.test(message) ? [LINK_BLAME_ISSUE] : [])];
}

/**
 * The codes of the linked cards whose link the customer says doesn't open, which the loop drops from the reply in code: those the
 * text names (code, words, size or price) in Claire's last reply, else in any earlier reply (r3 c08-persona idx 4: the Zyliss card
 * was two replies back), else every linked card of the last reply ("same link la!! still cannot open"). Exam 4, c08: 3 replies
 * re-sent the Zyliss card right after the customer said its link doesn't open.
 */
export function brokenLinkCodes(currentText: string, replies: readonly { cards: readonly ShownCard[] }[]) {
  if (!linkWord.test(currentText) || !linkFails.test(currentText)) return [];
  const linked = (cards: readonly ShownCard[]) => cards.filter((card) => card.link);
  const named = (cards: readonly ShownCard[]) => linked(cards).filter((card) => codePattern(card.code).test(currentText) || hits(card, currentText).size > 0);
  const previous = replies.at(-1)?.cards ?? [];
  const found = named(previous).length ? named(previous) : named(replies.flatMap((reply) => reply.cards));
  return [...new Set((found.length ? found : linked(previous)).map((card) => card.code))];
}

export const NO_CARD_PREFIX = "No card attached";
// "tap it", "tap the Kenwood mixer to confirm", "tap the HET-4 card"; not a tap on a link, the PDF button or the enquiry bar, nor a water tap
// ("a tap that locks": after an article it is the noun).
const tapAsk = /(?<!\b(?:a|an|the|its|one|single)\s+)(?:\btap(?:ping)?\s+(?:on\s+)?(?:it|this|that|these|those|each|them|both|to\s+(?:add|confirm|select|choose|pick))\b|\btap\s+(?:the\s+)?(?:[\w'’″-]+\s+){0,5}(?:card|cards|item|product|to\s+(?:add|confirm|select|choose|pick))\b)/i;
const tapNotACard = /\btap\s+(?:the\s+)?(?:\w+\s+){0,3}(?:link|pdf|button|bar|chip|download|mic|photo|enquiry)\b/i;
const asksForTap = (sentence: string) => tapAsk.test(sentence) && !tapNotACard.test(sentence);
const showPromise = /\b(?:let me|I'?ll|I will|one sec|one moment|hold on)\b[^.!?\n]{0,40}\b(?:pull|bring|show|get)\b[^.!?\n]{0,25}(?<!\bset )\bup\b|\b(?:pulling|bringing) (?:up|those|these|it|that)\b/i;
// "Let me know the type and I'll pull up options" waits for the customer; "having trouble pulling up the catalogue" is honest.
const promisesToShow = (sentence: string) => showPromise.test(sentence) && !/\b(?:if|once|when|let me know|tell me|trouble|unable|cannot)\b|n['’]t\b/i.test(sentence);
// Words that point at a card keep it: "tap it", "here it is", "here they are", "card below"; not "(details below)" or "number and
// email below", which point at the contact details (r2 c08-stress idx 6).
const pointsAtCard = (sentence: string) => asksForTap(sentence) || promisesToShow(sentence)
  || /\b(?:cards?|here it is|here they are)\b|(?<!\b(?:details|number|email|contact|phone)s?\s+)\bbelow\b/i.test(sentence);
/** The message without its sentences that point at a card, for an answer whose cards were all dropped. */
export const withoutCardPointers = (message: string) => removeSentences(message, pointsAtCard);
/**
 * The answer without the cards of items this turn added or set that the customer has already seen: the words and the enquiry
 * bar show the change, and the card would only repeat (exam 3: 61 of 87 add confirmations re-sent the card, 54 of those a
 * third showing, and each could cost a REPEAT repair). Words that point at a card, or a customer asking to see it, keep it.
 */
export function withoutChangedCards(answer: FinalAnswer, changes: EnquiryChange[], shownIds: ReadonlySet<string>, currentText: string): FinalAnswer {
  if (sentences(answer.message).some(pointsAtCard) || asksAgain.test(currentText)) return answer;
  const shown = new Set([...shownIds].map((id) => id.toLowerCase()));
  const changed = new Set(changes.flatMap((change) => (change.code && (change.action === "add" || change.action === "set") ? [change.code.toLowerCase()] : [])));
  return { ...answer, card_ids: answer.card_ids.filter((id) => !(changed.has(id.toLowerCase()) && shown.has(id.toLowerCase()))) };
}
/**
 * The answer without its cards when that same set was already shown twice (exam 4: 14 third showings, most re-attached to "Just to
 * confirm?", "Want me to add it?" or "How many?"), unless the customer asked to see it again, the message points at the cards (without
 * them the words would point at nothing, and a show promise would cost a NO_CARD repair), or update_enquiry refused one of them this
 * turn (the question about it offers it). The pick check reads the chat, so a yes or a number no longer needs the card on screen.
 */
export function withoutRepeatedSet(answer: FinalAnswer, earlier: EarlierTurns, refused: readonly string[]): FinalAnswer {
  if (!answer.card_ids.length || asksAgain.test(earlier.currentText) || sentences(answer.message).some(pointsAtCard)) return answer;
  if (answer.card_ids.some((id) => refused.some((code) => same(code, id)))) return answer;
  const key = cardSetKey(answer.card_ids);
  return earlier.cardSets.filter((codes) => cardSetKey(codes) === key).length >= 2 ? { ...answer, card_ids: [] } : answer;
}
const NO_CARD_TAP_ISSUE = `${NO_CARD_PREFIX}: you asked the customer to tap a card but card_ids is empty. Put its code in card_ids (any card shown earlier in this chat can be attached) or don't ask for a tap.`;
const NO_CARD_SHOW_ISSUE = `${NO_CARD_PREFIX}: you promised to show products but attached none. Attach them now or don't promise.`;
/** After the repair, a tap request or show promise with no card attached is cut out. */
export const noCardFixer: Fixer = {
  prefix: NO_CARD_PREFIX,
  fix: (message) => removeSentences(message, (s) => asksForTap(s) || promisesToShow(s)) || "Tell me which one by its name or code.",
};

/**
 * What this turn's tools did, for checks on the reply; refused: the codes update_enquiry refused as not picked; picked: whether
 * the customer picked a product (a permission question about one is the confirm step); earlierCards: the cards of Claire's
 * earlier replies, which a permission question can name without attaching or looking them up; unchecked: the enquiry codes not
 * re-checked this turn, which the browser still holds.
 */
export type TurnFacts = {
  lines: EnquiryReceiptLine[]; changes: EnquiryChange[]; searches: SearchRecord[]; refused?: string[]; picked?: (code: string) => boolean;
  earlierCards?: readonly ShownCard[]; unchecked?: string[];
};
/** The enquiry facts plus the products looked up this turn, which the reply's words can point at. */
type ClaimFacts = Pick<TurnFacts, "lines" | "changes" | "unchecked"> & { seen: ReadonlyMap<string, CheckedProduct> };

/** A product as a card the reply's words can point at: only its code and name count. */
const asCard = (product: Pick<Product, "stock_id" | "name">): ShownCard => ({ code: product.stock_id, name: product.name, price: null, link: null });
/** The products looked up this turn, as cards the reply's words can point at. */
const seenCards = (seen: ReadonlyMap<string, CheckedProduct>): ShownCard[] => [...seen.values()].map(({ product }) => asCard(product));
/** The cards whose code the text types, else the ones its words point at. */
function pointedBy(text: string, cards: ShownCard[]) {
  // Amounts are left out: the cents of "$547.66" would point at a card coded 66 (runs-new2 c02-persona T14).
  const words = text.replace(moneyPattern, "");
  const typed = cards.filter((card) => codePattern(card.code).test(words));
  return typed.length ? typed : pointedCards(words, cards);
}

export const ENQUIRY_CLAIM_PREFIX = "The enquiry didn't change";
// A leading "Got it: 2" claims a change; "Got it, 4 pax" or "OK, 2 options" only echoes the customer's numbers. An apology before it
// still claims one (r6 rescue sample: "Sorry, got it: 2 ..." for an add that never ran, with the enquiry empty), with a dash, "about
// that" or "Oops" too (r6 review).
const changeClaim = /\b(?:added|adding|removed|removing|updated|updating|dropped|noted down)\b|\bput\b[^.!?\n]{0,25}\bin(?:to)?\s+(?:your|the)\s+enquiry\b|\b(?:is|are|now)\s+(?:in|on)\s+(?:your|the)\s+enquiry\b|\bqty\s*\d+\s*done\b|^\s*(?:(?:sorry|apologies|oops)(?:\s+about\s+that)?\s*[,!.:–—-]?\s*)?(?:noted|got it|done|ok(?:ay)?)[:,!]?\s*\d(?![\d.]*(?:(?:in|l|g|m)\b|\s*(?:inch(?:es)?|cm|mm|ltr|litres?|liters?|qt|quarts?|ml|oz|kg|pax|ppl|people|persons?|guests?|options?|choices?|sizes?|dollars?|bucks|sgd|slots?|tiers?|burners?)\b|\s*[%″"]))|已(?:添加|加入|更新|删除|移除)|加好了|帮你加了/i;
const promiseChange = /\b(?:I'?ll|I will|let me|going to)\s+(?:add|put|remove|update|note)\b|\badding\b[^.!?\n]*\bnow\b|我来加/i;
// "I'll get 2 added" and "I'll have it updated" promise a change; they don't report one (exam 3, c06-persona T8 replayed). Lazy, so
// it ends at the promise's own "added": "I'll get 2 added - I've added the torch" still reports one.
const futureChange = /\b(?:I'?ll|I will|let me|going to|can)\s+(?:get|have)\s+(?:[\w'’″-]+\s+){0,4}?(?:added|removed|updated)\b/i;
const honestWording = /\b(?:not|never|nothing|no longer|yet to|trouble|unable|cannot|failed|want me to|shall I|should I|would you like)\b|n['’]t\b|\?\s*$/i;
// A question about what the customer wants: "is it the HET-4 you want added, qty 1?" (exam 3, c11-stress T9 replayed: split from its
// "?" by the comma). Only a clause that opens as a question in a sentence that ends as one counts, so "The torch you want added is on
// your enquiry now" and "Can confirm the 2 you need added" are claims.
const wantsChange = /\b(?:want|like|need)s?\s+(?:[\w'’″-]+\s+){0,5}(?:added|removed|updated)\b/i;
const questionOpen = /^(?:is|are|was|were|do|does|did|which|what|how many|should|shall|can|could|would)\b/i;
// A clause saying an add failed ("having a hiccup adding these", exam 3, c05-persona T10); it never excuses a whole sentence, so
// "Sorry for the hiccup, I'll add 2 now" is still a promise.
const failedWording = /\b(?:hiccup|snag|trouble)s?\s+(?:with\s+)?(?:adding|updating|removing)\b/i;
// Neither phrase excuses a claim made beside it in the same clause: "Sorted the hiccup adding these and added 2 torches".
const notAClaim = (clause: string, question: boolean) => honestWording.test(clause)
  || (failedWording.test(clause) && !changeClaim.test(clause.replace(failedWording, " ")))
  || (question && questionOpen.test(clause) && wantsChange.test(clause) && !changeClaim.test(clause.replace(wantsChange, " ")));
// GST sums are not enquiry changes: "Adding 9% to $119.09 gets you the GST-inclusive total" (exam 3, c12-persona T11). Stripped like
// featureWording, so "Added 2 torches - adding 9% GST, about $153.72" is still judged on its add; "I'll add GST and 2 torches now"
// keeps its verb.
const gstWording = /\badd(?:s|ed|ing)?\s+(?:the\s+)?(?:\d+(?:\.\d+)?\s?%\s*)?(?:gst|tax)\b(?!\s+and\s+\d)|\badding\s+\d+(?:\.\d+)?\s?%(?:\s*(?:gst|tax)\b)?(?!\s*(?:gst|tax)\b|\s+and\s+\d)/gi;
// "Pick a plate you like, and I'll add it" waits for the customer too (exam 2, c05-B); "tap to select it, then I'll add" doesn't.
// A closing "confirmed once more" is no condition (exam 3, c11-stress T9 replayed); "once more stock arrives" still is.
const conditionalWording = /\b(?:if|once(?!\s+(?:more|again)\s*(?:[.!?…,:;)–—-]|$))|after|when|let me know|tell me)\b|\b(?:pick|choose)\s+(?:a|an|one|any|the|which(?:ever)?)\b[^.!?]*\b(?:and|then)\s+I'?ll\b/i;
// "contact sales to get that line added" is advice, not a claim (exam 2, c05-stress).
const notAboutEnquiry = /\bto get\b[^.!?]{0,30}\badded\b|\b(?:gst|tax|fee|charges?)\b[^.!?]{0,30}\badded\b|\badded\b[^.!?]{0,20}\b(?:gst|tax|on top|at checkout)\b|\bupdated (?:prices?|stock|list|link|photos?)\b|\bupdated (?:\w+ )?total\b|\bprices?\s+(?:has|have|was|were|is)\s+(?:been\s+)?(?:updated|dropped|changed)\b|\bremoved (?:[^.!?]{0,30} )?from (?:the|my) (?:list of )?(?:options|results|search)\b/i;
// Product features, not enquiry changes: "the bowl can be removed", "the lid is easily removed", "an added splash guard", "an updated motor".
const featureWording = /\b(?:can|could|may|might)\s+be\s+(?:\w+\s+)?(?:added|removed|updated)\b|\b(?:is|are)\s+easily\s+(?:added|removed)\b|\ban\s+(?:added|updated)\s+(?!to\b|on\b|in\b)(?=\w)/gi;
const removalWord = /\b(?:removed|removing|dropped)\b|已(?:删除|移除)/i;
// "Already added", "2 so far", "both are in your enquiry" describe the enquiry as it stands: true while the item is on it.
// A leading "Done" or "just added" reports a change this turn instead.
const statusWording = /\b(?:already|so far|still)\b/i;
const onEnquiryWording = /\b(?:is|are|now)\s+(?:in|on)\s+(?:your|the)\s+enquiry\b/i;
const reportsChange = /^\s*done\b|\bjust\s+(?:added|put|updated|removed)\b/i;
// Clauses: split at commas outside brackets, semicolons, dashes between words, a bracket holding its own change
// ("(19.1cm removed)") and an "and" with a change word on both sides ("removed the 4-slot and added 2 HET-6", exam 3, c11-stress
// T4 replayed); never at a colon, so "Got it: 2 torches" stays whole, nor in a list ("Added 2 torches and 4 plates").
const claimClauses = (sentence: string) => sentence
  .split(/,\s+(?![^()]*\))|[;；，]\s*|\s*[–—]\s*|\s-\s|\s*\((?=[^()]*\b(?:added|removed|updated|dropped)\b)/i)
  .flatMap((part) => part.split(/\s+and\s+/i).reduce<string[]>((clauses, half) => {
    if (clauses.length && !(changeClaim.test(half) && changeClaim.test(clauses[clauses.length - 1]))) clauses[clauses.length - 1] += ` and ${half}`;
    else clauses.push(half);
    return clauses;
  }, []))
  .map((part) => part.trim()).filter(Boolean);
// The fixer's lines (fixedLine picks one): true for a false add, change or removal, including of an item already on the enquiry. An
// add or change asks what is still needed, never for an item code and never with "I'll"; exam-numbers counts the first sentence.
const NOT_ON_ENQUIRY = "That change isn't on your enquiry yet.";
const NOT_ADDED_LINE = `${NOT_ON_ENQUIRY} Which item and how many would you like?`;
const NOT_REMOVED_LINE = "That line is still on your enquiry.";
/** The products a reply's words can point at: those looked up this turn and the enquiry's lines. */
const claimCards = (facts: ClaimFacts): ShownCard[] => [
  ...seenCards(facts.seen),
  ...facts.lines.map((line) => asCard({ stock_id: line.code, name: line.item })),
];

/**
 * Sentences that say an item was added, changed or removed, or promise to do it, when update_enquiry didn't do that
 * for the item this turn. The item is the product whose code the clause types, else the one its words point at.
 */
function falseEnquiryClaims(message: string, facts: ClaimFacts) {
  const cards = claimCards(facts);
  const onLines = (card: ShownCard) => facts.lines.some((line) => same(line.code, card.code));
  const changed = (card: ShownCard, actions: EnquiryChange["action"][] = ["add", "set", "remove"]) => facts.changes.some((change) => change.code !== null && same(change.code, card.code) && actions.includes(change.action));
  const point = (text: string) => pointedBy(text, cards);
  // A clause with a change word, judged on its own: a swap's "HET-4 removed" and "WCT708K added" each hold for their item.
  const falseClause = (clause: string, statusAllowed: boolean, question: boolean) => {
    if (notAClaim(clause, question)) return false;
    const status = statusAllowed && (statusWording.test(clause) || !changeClaim.test(clause.replace(onEnquiryWording, "")));
    const pointed = point(clause);
    if (!pointed.length) return !facts.changes.length && !(status && facts.lines.length);
    if (removalWord.test(clause)) return pointed.some((card) => onLines(card) && !changed(card, ["remove", "set"]));
    // An add or update needs its own change this turn; a status line only needs the item on the enquiry.
    return pointed.some((card) => !onLines(card) || !(status || changed(card, ["add", "set"])));
  };
  // A line the browser still holds said to be removed is keptLineClaims' to fix: it must never become NOT_ON_ENQUIRY.
  const keptLineSentences = new Set(keptLineClaims(message, facts.unchecked ?? [], facts.changes).map((claim) => claim.sentence));
  return sentences(message).filter((said) => {
    if (keptLineSentences.has(said)) return false;
    // Judged without its feature and GST wording, so "Added 2 torches - the lid can be removed" is still a claim.
    const sentence = said.replace(featureWording, " ").replace(gstWording, " ");
    if (notAboutEnquiry.test(sentence)) return false;
    const promise = (promiseChange.test(sentence) || futureChange.test(sentence)) && !honestWording.test(sentence) && !conditionalWording.test(sentence);
    if (promise) {
      const pointed = point(sentence);
      if (!(pointed.length && pointed.every((card) => changed(card)))) return true;
    }
    // A condition ("once you pick one, I'll add it") only excuses a sentence with no past-tense claim in it; the "added" of a
    // promise ("let me know and I'll get 2 added") is not one, but a status beside it ("…and the torch is now in your enquiry") is.
    const waiting = sentence.replace(futureChange, " ");
    if (!changeClaim.test(sentence) || (conditionalWording.test(sentence) && !/\b(?:added|removed|updated)\b/i.test(waiting) && !(waiting !== sentence && onEnquiryWording.test(waiting)))) return false;
    const question = /\?\s*$/.test(sentence);
    const clauses = claimClauses(sentence).filter((clause) => changeClaim.test(clause));
    const judged = clauses.length ? clauses : [sentence];
    if (judged.some((clause) => falseClause(clause, !reportsChange.test(sentence), question))) return true;
    // The rest of an add's list ("Added: 2 torches, 4 plates") has no change word of its own: each item it names must be
    // on the enquiry or changed this turn.
    if (!judged.some((clause) => !removalWord.test(clause) && !notAClaim(clause, question))) return false;
    return claimClauses(sentence).filter((part) => !notAClaim(part, question)).some((part) => point(part).some((card) => !onLines(card) && !changed(card)));
  });
}

/** Issues for sentences that say the enquiry changed (or will) when update_enquiry didn't change it this turn. */
export function enquiryClaimIssues(message: string, facts: ClaimFacts) {
  // The item may be on the enquiry already (a false "Updated: 5"), so the repair isn't told to say it isn't there.
  return falseEnquiryClaims(message, facts).map((sentence) => `${ENQUIRY_CLAIM_PREFIX} for: "${sentence.slice(0, 120)}". No update_enquiry call succeeded for it in this turn, so don't say it was added, changed or removed, and don't promise to do it later. If the customer asked for that change, say it hasn't been made yet and what you still need (which product, or how many); if they didn't ask for one, just leave that sentence out and answer what they said.`);
}

// A pure advice or comparison question asks for no enquiry change (exam 3: the fixed line answered "Recommend" and "which one more
// versatile?", and the customers asked "wat change??"); anything else might.
const adviceOnly = /\b(?:recomm?end\w*|recomend\w*|suggest\w*|which\b[^.?!]{0,25}\b(?:one|better|best|suit\w*|good|versatile)|better|best|suitable|versatile|difference|differ|compare|vs)\b|哪个|推荐/i;
const changeWords = /\b(?:add\w*|put|take|want|order|buy|change|switch|swap|remove|cancel|delete|make it|yes|ya|yup|ok(?:ay)?|confirm|same|need|skip|only|tap\w*|enquiry|cart|keep|pls|please)\b|\d|加|要|换|删|不要/i;
/** Whether the customer's message (or a card tap) may ask for an enquiry change. */
export const askedForChange = (currentText: string | null, tapped = false) => tapped || !adviceOnly.test(currentText ?? "") || changeWords.test(currentText ?? "");
// A sentence saying the change wasn't made (exam 3: c06-persona T8 "didn't go through", c08-persona T9 "hasn't been added yet");
// "not made in Japan" and "prices are not final on your enquiry" don't.
const saysNotMade = /\b(?:hasn['’]t|has not|haven['’]t|isn['’]t|wasn['’]t|not)\b[^.!?]{0,40}\b(?:added|gone through|been made)\b|\b(?:isn['’]t|aren['’]t|not)\s+(?:yet\s+|still\s+)?(?:in|on)\s+(?:your|the)\s+enquiry\b|\bdidn['’]t go through\b|\bnothing['’]?s? (?:is )?(?:in|on) (?:your|the) enquiry\b/i;
/**
 * Whether the rest of the reply already says each dropped change wasn't made: a sentence saying so about the claim's product, or
 * about none. A sentence naming no product is about the one the reply names: exam 3, c10-stress T5 (replayed) said "That one hasn't
 * been added yet" of the other tong, not the steak tong it claimed. A GST note ("GST is not added yet") is about no change.
 */
function saysEachNotMade(unclaimed: string, claims: string[], cards: ShownCard[]) {
  const replyNamed = pointedBy(unclaimed, cards);
  const notMade = sentences(unclaimed).filter((sentence) => saysNotMade.test(sentence) && !/\b(?:gst|tax)\b/i.test(sentence))
    .map((sentence) => { const named = pointedBy(sentence, cards); return named.length ? named : replyNamed; });
  return claims.every((claim) => {
    const claimed = pointedBy(claim, cards);
    return notMade.some((named) => !claimed.length || !named.length || named.some((card) => claimed.some((item) => same(item.code, card.code))));
  });
}

const addWording = /\b(?:added|adding|updated|updating|put|noted down)\b|已(?:添加|加入|更新)|加好了|帮你加了/i;
/**
 * The fixed line for a false claim. NOT_REMOVED_LINE only for a claim that only removes (or promises to), every line it names still
 * on the enquiry and no removal of anything else made this turn; a removal beside an add, or of anything not on the enquiry, gets the
 * bare NOT_ON_ENQUIRY, true of any false change (exam 3, c11-stress T4 replayed: the swap's removal ran and its add didn't). An add
 * or change asks what is still needed, unless the rest of the reply already asks its own question.
 */
function fixedLine(claim: string, facts: ClaimFacts, unclaimed: string) {
  const parts = claimClauses(claim).filter((clause) => changeClaim.test(clause) || promiseChange.test(clause));
  const removals = parts.filter((clause) => removalWord.test(clause) || /\bremove\b/i.test(clause));
  if (removals.length) {
    const alone = removals.length === parts.length && !addWording.test(claim) && !onEnquiryWording.test(claim);
    // Every named line, not one: "Removed the HET-4 and set the HET-6 to 3" stays one clause, and the HET-6 on the enquiry
    // doesn't keep the HET-4 that was removed. A removal that ran for an item the claim doesn't name may be the one it means
    // ("Removed it and set the HET-6 to 3"), so it rules the removal line out too, and so does a clear, which removed them all.
    const named = removals.flatMap((clause) => pointedBy(clause, claimCards(facts)));
    const unnamedRemoval = facts.changes.some(({ action, code }) => action === "clear"
      || (action === "remove" && code !== null && !named.some((card) => same(card.code, code))));
    const kept = named.length > 0 && !unnamedRemoval && named.every((card) => facts.lines.some((line) => same(line.code, card.code)));
    return alone && kept ? NOT_REMOVED_LINE : NOT_ON_ENQUIRY;
  }
  return sentences(unclaimed).some((sentence) => /[?？]$/.test(sentence) && !genericAsk.test(sentence)) ? NOT_ON_ENQUIRY : NOT_ADDED_LINE;
}

/**
 * The message without its false enquiry claims. Only when the customer asked for a change, and the rest of the reply doesn't already
 * say each one wasn't made, does one fixed line take the first claim's place.
 */
export function withoutEnquiryClaims(message: string, facts: ClaimFacts, askedChange = true) {
  const claims = falseEnquiryClaims(message, facts);
  const [first, ...rest] = claims;
  if (!first) return message;
  const unclaimed = removeSentences(message, (sentence) => claims.includes(sentence));
  if (!askedChange || saysEachNotMade(unclaimed, claims, claimCards(facts))) return unclaimed;
  return removeSentences(message.replace(first, fixedLine(first, facts, unclaimed)), (sentence) => rest.includes(sentence));
}

export const KEPT_LINE_PREFIX = "This line is still on the enquiry";
const lostWording = /\b(?:removed|dropped|lost|missing|deleted|no longer (?:on|in)|(?:not|isn['’]?t) (?:on|in) (?:your|the) enquiry)\b/i;
// "wasn't removed", "has not been removed", "nothing was removed": a denial is already true.
const deniedLoss = /\b(?:not|never|nothing|wasn['’]?t|isn['’]?t|hasn['’]?t|haven['’]?t|weren['’]?t|aren['’]?t)\s+(?:(?:been|was|were|got)\s+)?(?:removed|dropped|lost|missing|deleted)\b/gi;
/**
 * Sentences saying a line the browser still holds (not re-checked this turn) was removed or is missing, when no remove ran for
 * it (exam 3, c08-stress T12: "an earlier step accidentally removed your SB3027 line"). Only a typed code counts.
 */
export function keptLineClaims(message: string, unchecked: string[], changes: EnquiryChange[]) {
  const removed = (code: string) => changes.some((change) => change.action === "remove" && change.code !== null && same(change.code, code));
  return sentences(message).flatMap((sentence) => {
    const code = unchecked.find((item) => codePattern(item).test(sentence) && !removed(item));
    // Judged without product features ("the SB3027 blades can be removed") and denials; only "still on/in" excuses a loss word,
    // so "SB3027 is still missing" counts.
    const said = sentence.replace(featureWording, " ").replace(deniedLoss, " ");
    return code && lostWording.test(said) && !/\bstill\s+(?:on|in)\b/i.test(said) ? [{ sentence, code }] : [];
  });
}
/** The message with each such sentence replaced by one whole sentence saying the line is still there. */
export function withoutKeptLineClaims(message: string, unchecked: string[], changes: EnquiryChange[]) {
  return keptLineClaims(message, unchecked, changes).reduce((text, { sentence, code }) => text.replace(sentence, `${code} is still on your enquiry.`), message);
}

export const CLAIM_ISSUE_PREFIX = "This claim";
const ABSENCE_ISSUE_PREFIX = "This 'we don't have it'";
// Claims about the range that no code checked (exam 2: "That covers our tong range", "Comes in two sizes", "Nothing cheaper in that
// longer length", "our listings are aluminium step ladders"). Talk about the enquiry ("No other changes to your enquiry") is neither
// a completeness nor an absence claim, and "the only one of these" is about the cards shown.
const ENQUIRY_TALK = /\b(?:enquiry|added|removed|updated|your\s+(?:list|order|cart))\b/i;
// The list rule's pointer to sales ("send the whole list to Sia Huat sales for a formal quote", exam 3, s01-A/B T0) is about the
// customer's list, not the range.
const LIST_TO_SALES = /\b(?:send|forward|email|share)\b[^.!?]{0,30}\blist\b|\bquot(?:e|ation)\b[^.!?]{0,30}\blist\b|\blist\b[^.!?]{0,30}\b(?:to\s+(?:sia\s+huat\s+)?sales|quot(?:e|ation))\b/i;
const RELATIVE = /\b(?:of\s+(?:these|those|the\s+(?:two|three|four|five|ones?\s+(?:shown|above)))|shown\s+above)\b/i;
// "Between these two, the Zyliss is the cheapest" ranks the cards shown; "Between these, that's our full range" still claims the range.
const AMONG_SHOWN = /\b(?:between|among|of)\s+(?:these|those|the\s+(?:two|three|cards?|ones?\s+(?:above|shown)))\b/i;
// "Nothing else to add?", "No other questions", "Everything else looks fine" and "The only option now is to ask sales" aren't about the range,
// nor are a product's parts and materials ("everything else is stainless steel", "no other assembly", "needs no other attachments") or charges.
const MATERIAL = String.raw`(?:stainless|plastic|glass|porcelain|ceramic|alumin(?:i)?um|metal|wood(?:en)?|silicone|pom|pp|nylon|melamine|copper|brass|iron)`;
const COMPLETE = new RegExp(String.raw`\b(?:that|this|these)\s+(?:covers?|is|are)\s+(?:all\s+of\s+)?(?:our|the)\s+(?:[\w/-]+\s+){0,4}(?:range|line[- ]?up|selection)\b|\bthat['’]?s\s+(?:(?:all|everything)\s+(?:we|i)\s+(?:have|carry|stock|sell|found|could\s+find)|the\s+(?:full|whole|complete|entire)\s+(?:list|range))\b|\b(?:our|the)\s+(?:full|whole|complete|entire)\s+(?:range|list|line[- ]?up|selection)\b|\beverything\s+else\b(?!\s+(?:looks?|is\s+(?:fine|good|ok|okay|set)|(?:is|are)\s+(?:made\s+(?:of|from)\s+)?${MATERIAL})\b)|\beverything\s+(?:is\s+sold|we\s+(?:have|carry|sell|stock))\b|\bour\s+(?:listings|range|options)\s+(?:are|is)\b|\b(?:only|just)\s+(?:comes?\s+in\s+)?(?:two|three|four|five|\d)\s+(?:sizes|options|kinds|types|models|versions|colou?rs)\b|\bcomes?\s+in\s+(?:two|three|four|five|\d)\s+(?:sizes|colou?rs|versions)\b|(?<!\b(?:needs?|requires?)\s+)\bno\s+other\b(?!\s+(?:questions?|changes?|parts?|assembly|setup|tools?|charges?|fees?|costs?|way)\b)|(?<!\bif\b[^.!?]*)\bnothing\s+else\b(?!\s+(?:to\s+add|needed)\b)|\bbeyond\s+these,\s+(?:other|the\s+rest|nothing)\b`, "i");
// Summaries of the whole range: "all our chef knives are ...", "what we carry are ...", "the only option", "the only other cordless
// option we carry" (exam 3: c01-A T9-T11, c03-stress T7/T9, c07-stress T3, c04-stress T8). Prices ("all our listed prices are before
// GST"), stock counts, facts ("the only thing I can't confirm") and a series match ("our Patra plates are the same series") are not.
// The fact words are checked at every word ("the only other thing I have") and "the only catch is we have to" is not about the range.
// "We only have 27.5cm and 17.5cm" is a list of sizes, not a stock count (c01 chef knives).
const W = String.raw`[\w'’/-]+`;
const RANGE_SUMMARY = new RegExp([
  // Up to six words: "All our in-stock chef knives right now are ..." (exam 4, c03-A idx 8).
  String.raw`\ball\s+(?:of\s+)?our\s+(?!stock\b|(?:${W}\s+)?(?:prices?|cards?|links?|totals?|figures?|orders?|deliver\w*|enquir\w*|products?\s+(?:are\s+)?priced)\b)(?:${W}\s+){0,6}?(?:\([^)]*\)\s+)?(?:are|is)\b(?!\s+(?:priced|sold|ex|live|checked|quoted)\b)`,
  String.raw`\b(?:our|the)\s+(?:full|whole|complete|entire)\s+(?:${W}\s+){1,3}(?:range|list|line[- ]?up|selection|catalogue)\b`,
  String.raw`\bthe\s+only\s+(?:other\s+)?(?:${W}\s+){0,3}?(?:ones?|options?|models?|choices?|kinds?|types?|versions?|brands?)\b(?!\s+(?:\w+\s+)?is\s+to\b)`,
  String.raw`\bthe\s+only\s+(?:(?!(?:is|was|reasons?|thing|things|question|way|difference|info\w*|details?|specs?|photos?|pictures?|images?|data|figures?|note|link|record)\b)${W}\s+){1,4}?(?:we|I|sia\s+huat)\s+(?:have|carry|stock|sell)\b`,
  String.raw`\bwhat\s+we\s+(?:carry|stock|have|sell)\s+(?:are|is)\b`,
  String.raw`\bwe\s+only\s+(?:carry|stock|have|sell)\b(?!\s+(?:\d+(?!\.\d)|one|two|three|four|five|a\s+few|a\s+couple)\b)(?![^.!?]{0,30}\b(?:units?|pcs?|pieces|left|in\s+stock)\b)`,
  String.raw`\bour\s+(?:${W}\s+){1,8}?are\s+(?:all\s+|only\s+|just\s+)?the\s+(?!same\b)(?:${W}\s+){1,3}(?:range|line|series)\b`,
].join("|"), "i");
// "the only cordless option I found", "of the ones I found", "of the Waring blenders I've shown" is the honest scope the repair
// itself asks for. Not "I got": in Singapore English it means "we have".
const SCOPED = /\b(?:I|we)\s+(?:found|could\s+find|can\s+find|saw|see)\b|\bturned\s+up\b|\bso\s+far\b|\bof\s+the\s+ones\s+I\b|\b(?:in|among)\s+(?:these|the\s+results|my\s+search(?:es)?)\b|\bI(?:['’]ve|\s+have)\s+(?:shown|listed)\b/i;
const rangeSummary = (sentence: string) => RANGE_SUMMARY.test(sentence) && !SCOPED.test(sentence);
// "Two options: I can check with sales on restock, or ..." offers next steps.
const NEXT_STEP = String.raw`(?![^:.!?]{0,15}:\s*(?:I\s+can|you\s+can|add|wait|check|ask)\b)`;
const COUNTED = String.raw`\b(?:we\s+(?:have|carry|stock|sell)|there\s+are|we['’]ve\s+got)\s+(?:only\s+|just\s+)?(?:two|three|four|[2-4])`;
// Rankings and counts of the range: "That's the one for home use we've got" (exam 4, c04-persona idx 3), "Two options: ..." and "we
// have two fish scalers" (s09-B idx 1), "the most budget option ... next up in price" (c07-stress idx 4). Often the answer to "got
// cheaper?", so they are reworded, never removed.
const RANKING = new RegExp([
  // "the one I have in mind" is no ranking.
  String.raw`\bthe\s+(?:only\s+)?one\b[^.!?,]{0,30}?(?<!\bfrom\s+what\s+)\b(?:we|I)(?:['’]ve\s+got|\s+(?:have|carry|stock))\b(?!\s+in\s+mind)`,
  String.raw`^(?:(?:only|just)\s+)?(?:two|three|four|[2-4])\s+(?:options?|choices|models|versions)\b${NEXT_STEP}`,
  String.raw`${COUNTED}\s+(?!(?:[\w-]+\s+)?(?:types|kinds|categories|lines|styles|ways|things|steps|questions|reasons|items|units|differences)\b|(?:units?|pcs?|pieces|sets?|pkts?|cartons?|left|in\s+stock|available|more)\b)(?:[\w-]+\s+){0,2}?[a-z-]+s\b(?!\s+(?:left|available|in\s+stock|on\s+(?:hand|your)))${NEXT_STEP}`,
  // A bare count: "We have two: the Giesser 28cm ... and a smaller ... one" (r4 s09-B idx 1, replayed); not "We have 2 left".
  String.raw`${COUNTED}(?=\s*(?::|[-–—]\s|[.!?]?$))${NEXT_STEP}`,
].join("|"), "i");
const PRICE_RANK = /\b(?:the\s+)?(?:cheapest|most\s+(?:budget|affordable|economical)|lowest[- ]priced|least\s+expensive)\b|\bnext\s+up\s+in\s+price\b/i;
// An offer to look ("Want me to look for the cheapest one?", "I can check which is the cheapest") or a question ("Looking for the
// cheapest?") ranks nothing; only its own clause is left out, so "The Mika is the cheapest; I can check stock" still ranks.
const OFFER = /\b(?:want\s+me\s+to|shall\s+I|should\s+I|would\s+you\s+like\s+me\s+to|I\s+can|I\s+could)\s+(?:\w+\s+){0,2}?(?:check|look|search|find)\b[^.!?,;]*|\blooking\s+for\b[^.!?,;]*\?/gi;
const ranking = (sentence: string) => RANKING.test(sentence) || PRICE_RANK.test(sentence.replace(OFFER, " "));
// "No other sizes showed up, but there may be more" says the list may not be complete.
const OPEN_ENDED = /\b(?:may|might|could)\s+be\s+(?:more|others)\b/i;
// "I don't have a spec on that", "couldn't find the photo" or "haven't seen this issue before" is not about a product.
const NOT_A_PRODUCT = String.raw`(?!\s+(?:\w+\s+){0,3}(?:spec|specs|info|information|details?|photos?|pictures?|images?|dates?|confirmation|figures?|rating|record|way|link|attachment|order|invoice|address|code|codes|price|prices|message|live\s+price|issue|problem))`;
// "I haven't found an actual Japan-made knife brand" and "I don't have anything actually made in Japan" (exam 4, c03-A idx 6,
// c03-persona idx 4); "I haven't found a boxed set yet" says its own scope, and "I don't have anything else to add" or "anything more
// on its warranty" is no product.
const ABSENT = new RegExp(String.raw`\b(?:we|i|sia\s+huat)\s+(?:don['’]?t|do\s+not|doesn['’]?t|does\s+not)\s+(?:carry|stock|sell)\b|\b(?:we|i)\s+(?:don['’]?t|do\s+not)\s+have\s+(?:a|an|any|anything(?!\s+(?:else|more)\s+(?:to\s+add|on)\b)|another|other|bundled|boxed|pre[- ]?\w+|such)\b${NOT_A_PRODUCT}|\bnot\s+in\s+(?:our|the)\s+(?:catalogue|range|listings?)\b|\b(?:couldn['’]?t|could\s+not|can['’]?t|cannot|didn['’]?t|did\s+not)\s+find\b${NOT_A_PRODUCT}|\b(?:i['’]?m|am)\s+not\s+finding\b|\b(?:I|we)\s+(?:haven['’]?t|have\s+not)\s+(?:yet\s+)?(?:found|seen|come\s+across)\b(?![^.!?]*\b(?:yet|so\s+far))${NOT_A_PRODUCT}|\bnone\s+of\s+our\b`, "i");
// "No close substitute", "couldn't find a close in-stock substitute": a finished find_alternatives backs these (exam 4, s03-B idx 1: 3
// of 4 reruns were repaired at 18.6-27.1 s after it had run).
const SUBSTITUTE_ABSENT = /\bno\s+(?:direct\s+|close\s+|similar\s+)?(?:substitute|alternative|replacement)s?\b(?!\s+needed)|\bcan['’]?t\s+offer\s+(?:a|an|any)\s+(?:substitute|alternative)|\b(?:couldn['’]?t|could\s+not|can['’]?t|cannot|didn['’]?t|did\s+not)\s+find\s+(?:(?:a|an|any)\s+)?(?:[\w-]+\s+){0,3}?(?:substitute|alternative|replacement)s?\b/i;
const EVERY_SUBSTITUTE_ABSENT = new RegExp(SUBSTITUTE_ABSENT.source, "gi");
// "Under", "below" and "within" only count before a price or a budget: "none turned up under that name" is not about price
// (runs-new2 c01-B T9), and a bare number after "within" isn't a price ("within 3 days").
const BUDGET_WORD = String.raw`(?:(?:your|that|the)\s+(?:S?\$\s?[\d,.]+\s+)?(?:budget|price|amount)\b|budget\b)`;
const PRICE_LIMIT = String.raw`(?:the\s+)?(?:S?\$\s?\d|\d|${BUDGET_WORD})`;
const BUDGET = new RegExp(String.raw`\b(?:no(?:ne)?|nothing)\s+(?:[\w-]+\s+){0,6}(?:cheaper\b|less\s+expensive\b|(?:under|below)\s+${PRICE_LIMIT}|within\s+(?:S?\$\s?\d|${BUDGET_WORD}))|\b(?:don['’]?t|do\s+not)\s+have\s+(?:[\w-]+\s+){0,6}(?:in\s+that|under|below|within)\s+(?:(?:[\w-]+\s+){0,2}(?:budget|price)|${PRICE_LIMIT})`, "i");
// "We don't sell mangoes - we're a kitchen and F&B equipment supplier" already says what Sia Huat supplies, as the prompt asks;
// "F&B-grade vacuum sealers" is product talk.
const SAYS_WHAT_WE_SUPPLY = /\bF&B\s+(?:equipment|supplies|supplier|smallwares|needs)\b|\b(?:equipment|tableware)\s+supplier\b/i;
const NOT = String.raw`(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t)`;
const STOCK = new RegExp(String.raw`\b(?:out\s+of\s+stock|sold\s+out|${NOT}\s+in\s+stock)\b|\bno\s+stock\b(?!\s+(?:figure|info|information|count|data|details?|level))`, "i");
const IN_STOCK = new RegExp(String.raw`(?<!\b${NOT}\s)\bin\s+stock\b|\b\d+\s*(?:left|available|units?|pcs?|pkts?)\b|\bonly\s+has\b`, "i");
const HEDGE = /\b(?:may|might|could)\s+be\b|\bnot\s+(?:yet\s+)?confirmed\b|\bunconfirmed\b|\bneeds?\s+checking\b/i;
// A plural subject: "both", "all", "they", or a plural verb ("X, Y and Z are out of stock").
const PLURAL = /\b(?:both|all|these|those|they|them|are|were)\b/i;
const CLAIM_FIXES = {
  complete: "No search this turn listed a whole category (complete: true). Say these are some of the options and offer to narrow down.",
  budget: "No search this turn listed a whole priced category. Say what you found under the budget so far and offer to check the whole range.",
  stock: "Its stock wasn't checked live this turn, or the check says it's in stock. Describe stock only as the tool result says.",
};
// The old wording ("in the searches you ran") invited search narration (exam 4, s03-B idx 4).
const ABSENCE_FIX = "First check this turn's results for it. If it isn't there, say you couldn't find it (without describing your searches) rather than that Sia Huat doesn't carry it; if the item isn't kitchen or F&B equipment at all, say what Sia Huat supplies instead.";

// Country words as the catalogue's 'Country of Brand Origin' spells them ("china" is left out: bone china is a material).
const COUNTRIES: Record<string, string> = {
  japan: "JAPAN", japanese: "JAPAN", germany: "GERMANY", german: "GERMANY", chinese: "CHINA", taiwan: "TAIWAN", taiwanese: "TAIWAN",
  france: "FRANCE", french: "FRANCE", italy: "ITALY", italian: "ITALY", spain: "SPAIN", spanish: "SPAIN", thailand: "THAILAND", thai: "THAILAND",
  usa: "USA", american: "USA", switzerland: "SWITZERLAND", swiss: "SWITZERLAND", korea: "KOREA", korean: "KOREA", singapore: "SINGAPORE",
};
const originOf = (details?: Record<string, string> | null) => {
  const origin = (details?.["Country of Brand Origin"] ?? "").trim().toUpperCase();
  return origin === "UNITED STATES OF AMERICA" ? "USA" : origin;
};
// Words that end the item a clause names after its country, and words in it that name no product ("Japan-made knife brand in our
// catalogue" names a knife).
const ITEM_END = new Set(["in", "at", "for", "from", "with", "that", "which", "by", "on", "of", "or", "and", "but", "to", "available", "right", "now", "here", "yet", "currently", "we", "i"]);
const NOT_ITEM = new Set(["made", "brand", "brands", "style", "actual", "actually", "genuine", "real", "item", "items", "product", "products", "one", "ones", "option", "options"]);
// An item's words for "we don't have it", singular ("knives" is "knife"): looser than picks.ts's nameWords, which drops short and stop words.
const itemWord = (word: string) => word.replace(/ives$/, "ife").replace(/(?<=\p{L}{3})s$/u, "");
const itemWords = (text: string) => (text.toLowerCase().match(/\p{L}{3,}/gu) ?? []).map(itemWord);
const soldOutProduct = ({ product }: CheckedProduct) => product.stock_status === "out_of_stock" || product.available_quantity === 0;

/**
 * Products seen this turn that a "we don't have it" names: every word of a quoted item of 2+ words is in the product's name (exam
 * 4, s03-B idx 1: "couldn't find a 'rice dispenser'" beside EK9108S), or the product's brand is from the country the clause names and
 * its name has every word of the item named after the country (c03-A idx 6: "no Japan-made knife brand" beside Global GF-34, JAPAN;
 * not a Japan rice bowl for "Japanese rice cookers"). Never a clause about where things are made or what is confirmed (brand origin
 * is not manufacture), an out-of-stock product when the clause says in stock or available, or a product from another named country;
 * nor a product the sentence already names by code or the one find_alternatives looked around (sources). A quoted item counts
 * only in a "we don't have it" (quotes): after "no close substitute for" it is the item replaced.
 */
function disprovedBy(sentence: string, seen: ReadonlyMap<string, CheckedProduct>, quotes: boolean, sources: string[]) {
  const at = [ABSENT, SUBSTITUTE_ABSENT].map((pattern) => sentence.search(pattern)).find((index) => index >= 0) ?? 0;
  // Only the clause that says we don't have it: "... in Japan - we do have the Atlantic Chef" names what we do have after the dash.
  const clause = sentence.slice(at).split(/\s[-–—]\s|[;,]|\bbut\b/i)[0];
  if (/\bmade\s+in\b|\bconfirmed\b/i.test(clause)) return [];
  const words = clause.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const countries = new Set(words.flatMap((word) => (COUNTRIES[word] ? [COUNTRIES[word]] : [])));
  const countryAt = words.findIndex((word) => COUNTRIES[word]);
  const end = words.findIndex((word, index) => index > countryAt && ITEM_END.has(word));
  const item = countryAt < 0 ? [] : words.slice(countryAt + 1, end < 0 ? undefined : end).filter((word) => /^\p{L}{3,}$/u.test(word) && !NOT_ITEM.has(word)).map(itemWord);
  // A quote opens after a space or bracket, so the apostrophe of "couldn't" never starts one.
  const quoted = !quotes ? [] : [...clause.matchAll(/(?<![\p{L}\p{N}])['‘“"]([^'’”"]{3,40})['’”"](?![\p{L}\p{N}])/gu)].map((match) => itemWords(match[1])).filter((quote) => quote.length >= 2);
  const inStockAsked = /\bin[- ]stock\b|\bavailable\b/i.test(clause);
  return [...seen.values()].filter((checked) => {
    const code = checked.product.stock_id;
    if (codePattern(code).test(sentence) || sources.some((source) => same(source, code))) return false;
    const origin = originOf(checked.details);
    if ((inStockAsked && soldOutProduct(checked)) || (countries.size && origin && !countries.has(origin))) return false;
    const name = new Set(itemWords(checked.product.name));
    return quoted.some((quote) => quote.every((word) => name.has(word)))
      || (countries.has(origin) && item.length > 0 && item.every((word) => name.has(word)));
  }).map(({ product }) => product);
}

/**
 * Sentences that claim more than this turn's searches and live checks back, one kind each: a budget, completeness or ranking claim
 * needs a search that listed a whole (priced) category; "we don't have it" needs two different queries and a category that
 * exists (for "no substitute", a find_alternatives run will do), and is disproved by a product seen this turn that it names; "out
 * of stock" needs every product it points at checked live as out of stock.
 */
function unbackedClaims(message: string, searches: SearchRecord[], seen: ReadonlyMap<string, CheckedProduct>) {
  const complete = searches.some((search) => search.complete);
  const budgetBacked = searches.some((search) => search.maxPrice !== null && search.complete);
  const queries = new Set(searches.flatMap((search) => search.queries.map((query) => query.trim().toLowerCase())));
  const absenceBacked = queries.size >= 2 && searches.some((search) => search.categoryFound);
  const sources = searches.flatMap((search) => (search.alternativesFor ? [search.alternativesFor] : []));
  const substituteBacked = absenceBacked || sources.length > 0;
  const cards = seenCards(seen);
  const soldOut = (card: ShownCard) => {
    const item = seen.get(card.code);
    return !!item?.verified && soldOutProduct(item);
  };
  // Each part that says "out of stock" is judged on its subject: the products that part points at; with a plural subject
  // since the last stock talk ("GF-33, GS-7 and XXGS-9 are out of stock"), also those of the parts before it; with "it" or a
  // bare "is", those of the nearest part before that names a product. Other parts ("closest in-stock alternatives are ...")
  // are not judged, nor is a part that says in stock or hedges, nor a subject that points at no product ("the 12QT pot").
  const stockBacked = (sentence: string) => {
    const parts = sentence.split(/[,;]|\s[-–—]\s|\b(?:and|but|while)\b/i).filter((part) => part.trim());
    const aboutStock = (part: string) => STOCK.test(part) || IN_STOCK.test(part);
    return parts.every((part, index) => {
      if (!STOCK.test(part) || IN_STOCK.test(part) || HEDGE.test(part)) return true;
      const own = pointedBy(part, cards);
      const start = parts.slice(0, index).findLastIndex(aboutStock) + 1;
      const earlier = parts.slice(start, index);
      const nearest = earlier.findLast((text) => pointedBy(text, cards).length);
      const before = PLURAL.test(parts.slice(start, index + 1).join(" ")) ? earlier : !own.length && nearest ? [nearest] : [];
      return [...own, ...before.flatMap((text) => pointedBy(text, cards))].every(soldOut);
    });
  };
  return sentences(message).flatMap((sentence) => {
    const talk = ENQUIRY_TALK.test(sentence);
    const aboutRange = !talk && !LIST_TO_SALES.test(sentence) && !RELATIVE.test(sentence) && !OPEN_ENDED.test(sentence);
    // Judged without its substitute wording, which find_alternatives backs: "we don't carry X" beside it still needs the searches.
    const absent = ABSENT.test(sentence.replace(EVERY_SUBSTITUTE_ABSENT, " "));
    const absence = (absent || SUBSTITUTE_ABSENT.test(sentence)) && !talk && !SAYS_WHAT_WE_SUPPLY.test(sentence);
    const found = absence ? disprovedBy(sentence, seen, absent, sources) : [];
    // The first range claim a sentence makes decides it: a backed budget claim isn't judged again as a "we don't have it". A backed
    // ranking backs no absence, so "the cheapest ..., as we don't carry Japanese knives" is still judged as one.
    const range = BUDGET.test(sentence) ? (budgetBacked ? null : "budget" as const)
      : (COMPLETE.test(sentence) || rangeSummary(sentence)) && aboutRange ? (complete ? null : "complete" as const)
      : !complete && ranking(sentence) && !SCOPED.test(sentence) && !AMONG_SHOWN.test(sentence) && aboutRange ? "ranking" as const
      : absence ? (found.length ? "disproved" as const : (absent ? absenceBacked : substituteBacked) ? null : "absence" as const)
      : null;
    // An unbacked stock claim is removed if it survives the repair, so it outranks the kinds that are only reworded.
    const stock = STOCK.test(sentence) && !stockBacked(sentence);
    const reworded = range === "absence" || range === "disproved" || range === "ranking";
    const kind = reworded && stock ? "stock" as const : range ?? (stock ? "stock" as const : null);
    return kind ? [{ sentence, kind, found }] : [];
  });
}

/** The message without its unbacked completeness, budget and stock claims; a "we don't have it" or a ranking stays for the repair to reword. */
export function removeClaims(message: string, searches: SearchRecord[], seen: ReadonlyMap<string, CheckedProduct>) {
  const unbacked = unbackedClaims(message, searches, seen).filter(({ kind }) => kind === "complete" || kind === "budget" || kind === "stock").map(({ sentence }) => sentence);
  return removeSentences(message, (sentence) => unbacked.includes(sentence));
}

export const STOCK_NUMBER_PREFIX = "These stock numbers";
// "35 available", "only 2 left", "(12 in stock)", "131 units in stock", "(2,702 in stock)" read whole; never a code's digits ("HET-6
// units in stock"), a price or "2 left-handed".
const STOCK_COUNT = /(?:\b(?:only|just)\s+)?(?<![\p{L}\p{N}.,$-])(\d{1,3}(?:,\d{3})+|\d{1,5})\s*(?:(pcs?|pieces?|units?|sets?|pkts?|packets?)\s+)?(?:available|left|in\s+stock)(?:\s+in\s+stock)?(?![\w-])/giu;
// "over 30 available" is no count to check.
const APPROX_BEFORE = /\b(?:over|more\s+than|at\s+least|about|around|up\s+to|under|nearly|almost)\b[^.!?\n]{0,15}$/i;
// A count in pieces is not one in the product's own unit: "36 pcs available" of a DOZ item.
const UNIT_UOMS: Array<[RegExp, string[]]> = [[/^(?:pcs?|pieces?|units?)$/i, ["PC", "UNIT"]], [/^sets?$/i, ["SET"]], [/^(?:pkts?|packets?)$/i, ["PKT"]]];
const unitFits = (unit: string, uom: string) => UNIT_UOMS.some(([words, uoms]) => words.test(unit) && uoms.includes(uom.trim().toUpperCase()));
// A message's parts: sentence ends, line breaks, and commas, semicolons, dashes, "and" and "or" outside brackets, so "16in Iron Wok
// (35 available)" keeps its bracket with its product. A comma between digits (2,702) is no break.
const PART_BREAK = /[.!?](?=\s)|\n|(?:;|(?<!\d),|,(?!\d))(?![^()]*\))|\s[-–—]\s|\b(?:or|and)\b(?![^()]*\))/gi;
function partAt(message: string, index: number) {
  let start = 0;
  for (const found of message.matchAll(PART_BREAK)) {
    if (found.index >= index) return message.slice(start, found.index);
    start = found.index + found[0].length;
  }
  return message.slice(start);
}

/**
 * Stock counts the message types for one of its cards that differ from that card's live available_quantity: only where the count's
 * part points at exactly one product among all those seen this turn, and it is that card (exam 4, c03-stress idx 7: "16in Iron Wok
 * (35 available)" on a card with 2 left, while the P-16HD in the same results had 35). alsoMatches: the seen products that have it.
 */
export function wrongStockCounts(message: string, cards: readonly Product[], seen: ReadonlyMap<string, CheckedProduct>) {
  const all = seenCards(seen);
  return [...message.matchAll(STOCK_COUNT)].flatMap((match) => {
    if (APPROX_BEFORE.test(message.slice(Math.max(0, match.index - 40), match.index))) return [];
    const pointed = pointedBy(partAt(message, match.index), all);
    const item = pointed.length === 1 ? seen.get(pointed[0].code) : undefined;
    const count = Number(match[1].replace(/,/g, ""));
    const live = item?.product.available_quantity;
    if (!item?.verified || live === null || live === undefined || live === count || !cards.some((card) => same(card.stock_id, item.product.stock_id))) return [];
    if (match[2] && !unitFits(match[2], item.product.uom_id)) return [];
    const alsoMatches = [...seen.values()].flatMap(({ product, verified }) => (verified && product.available_quantity === count && product !== item.product ? [product] : []));
    return [{ said: match[0], index: match.index, count, code: item.product.stock_id, live, alsoMatches }];
  });
}

// A claim that the count covers the order goes with a wrong count: "plenty for 4", "so tight for 4pcs", "matches your qty".
const COVERAGE = String.raw`(?:(?:so\s+|which\s+is\s+|that['’]?s\s+)?(?:(?:more\s+than\s+)?enough|plenty|tight|short)\s+for|(?:which\s+|that\s+)?(?:matches|covers?)\s+your|covered)\b`;
const COVERAGE_PIECE = new RegExp(`^${COVERAGE}`, "i");
const COVERAGE_AFTER = new RegExp(String.raw`^(?:\s*[,;]|\s+[-–—])?\s*${COVERAGE}[^,;.!?()\n]*`, "i");
// A bracket's pieces and the separators between them (a comma between digits is none); pieces kept are joined by the last mark.
const PIECE_BREAK = /((?:\s*(?:;|(?<!\d),|,(?!\d))|\s+[-–—](?=\s))+\s*)/;
const joint = (separator: string) => {
  const mark = separator.trim().slice(-1);
  return /[,;]/.test(mark) ? `${mark} ` : ` ${mark} `;
};
// What comes before an unbracketed count: "in stock with 642 pcs available" drops it, "we have 35 in stock" and "there are 35 left"
// read "it's in stock", "has exactly 3 pcs left" reads "is in stock" (rounds 2-4 phrasings).
const QUALIFIER = String.raw`(?:(?:only|exactly|just)\s+)?`;
const WITH_BEFORE = new RegExp(String.raw`\s*\bwith\s+${QUALIFIER}$`, "i");
const WE_HAVE_BEFORE = new RegExp(String.raw`\b(?:we\s+(?:have|got)|we['’]ve\s+got|there\s+(?:are|is)|there['’]s)\s+${QUALIFIER}$`, "i");
const HAS_BEFORE = new RegExp(String.raw`\b(?:only\s+)?(has|have)\s+${QUALIFIER}$`, "i");

/**
 * The message a wrong count that survived the repair can go out in: dropped from its bracket, else said as "in stock" or "out of
 * stock" from the live check, with any coverage claim made from it. Never another number: the wrong figure may belong to another
 * product.
 */
export function withoutWrongStockCounts(message: string, cards: readonly Product[], seen: ReadonlyMap<string, CheckedProduct>) {
  // Last first, found again after each fix: rewriting a bracket moves or drops the counts before it in that bracket. Each fix takes
  // its count's digits out, and there are never more fixes than wrong counts to begin with.
  let text = message;
  for (let left = wrongStockCounts(message, cards, seen).length; left > 0; left -= 1) {
    const wrong = wrongStockCounts(text, cards, seen).at(-1);
    if (!wrong) break;
    text = withoutStockCount(text, wrong, seen);
  }
  return text;
}

/** The message with this one wrong count dropped from its bracket, or said as "in stock" or "out of stock". */
function withoutStockCount(text: string, { said, index, code }: ReturnType<typeof wrongStockCounts>[number], seen: ReadonlyMap<string, CheckedProduct>) {
  const before = text.slice(0, index);
  const after = text.slice(index + said.length);
  if (/\([^()]*$/.test(before) && /^[^()]*\)/.test(after)) {
    const open = before.lastIndexOf("(");
    const close = index + said.length + after.indexOf(")");
    const pieces = `${text.slice(open + 1, index)}${text.slice(index + said.length, close)}`.split(PIECE_BREAK);
    let inside = "";
    for (let at = 0; at < pieces.length; at += 2) {
      const piece = pieces[at].trim();
      if (piece && !COVERAGE_PIECE.test(piece)) inside += inside ? `${joint(pieces[at - 1])}${piece}` : piece;
    }
    return inside ? `${text.slice(0, open + 1)}${inside}${text.slice(close)}` : `${text.slice(0, open).replace(/\s+$/, "")}${text.slice(close + 1)}`;
  }
  const rest = after.slice(COVERAGE_AFTER.exec(after)?.[0].length ?? 0);
  const status = soldOutProduct(seen.get(code)!) ? "out of stock" : "in stock";
  const withCount = WITH_BEFORE.exec(before);
  if (withCount) return `${before.slice(0, withCount.index)}${rest}`;
  const weHave = WE_HAVE_BEFORE.exec(before);
  if (weHave) return `${before.slice(0, weHave.index)}${/^[A-Z]/.test(weHave[0]) ? "It's" : "it's"} ${status}${rest}`;
  const verb = HAS_BEFORE.exec(before);
  if (verb) return `${before.slice(0, verb.index)}${verb[1].toLowerCase() === "has" ? "is" : "are"} ${status}${rest}`;
  return `${before}${/^[A-Z]/.test(said) ? `${status[0].toUpperCase()}${status.slice(1)}` : status}${rest}`;
}
const stockNumberIssue = (wrong: ReturnType<typeof wrongStockCounts>) => `${STOCK_NUMBER_PREFIX} don't match the live stock: ${wrong.map(({ said, count, code, live, alsoMatches }) => `"${said}" for ${code} (live ${live})${alsoMatches.length
  ? `; ${count} matches ${alsoMatches.slice(0, 2).map((item) => `${item.stock_id} ${item.name.replace(/"/g, "″")}`).join(", ")}: if you meant that product, attach its card instead` : ""}`).join("; ")}. Give each product's available_quantity, or leave the number out; never say stock changed.`;

const ALL_IN_STOCK_ISSUE_PREFIX = "You wrote that the cards are all in stock";
// "All confirmed in stock", "both available", "3 porcelain options in stock"; not "Both are 0 in stock" or "not available".
const everyCardInStock = /\b(?:all|both|every(?:thing|one)|(?:two|three|four|five|[2-5])\s+(?:[\w-]+\s+){0,3}(?:options?|ones?|models?|sizes?|picks?|items?|choices?))\b[^.?!\n]{0,60}?(?<!\b(?:0|no|not|zero)\s+)\b(?:in\s+stock|available)\b|\b(?:in\s+stock|available)\b[^.?!\n]{0,3}\b(?:all|both)\b/i;

/** A style issue when the message says every card is in stock but a card isn't (or wasn't checked), unless it says which is out. */
export function stockIssues(message: string, cards: Product[]) {
  const notIn = cards.filter((card) => card.stock_status !== "in_stock");
  if (!notIn.length || !everyCardInStock.test(message) || /\b(?:out\s+of\s+stock|sold\s+out)\b/i.test(message)) return [];
  const which = notIn.map((card) => `${card.stock_id} (${card.stock_status === "out_of_stock" ? "out of stock" : "stock not checked"})`).join(", ");
  return [`${ALL_IN_STOCK_ISSUE_PREFIX}, but ${which} ${notIn.length > 1 ? "aren't" : "isn't"}. Describe each product's stock as its tool result says.`];
}

// Old Claire's reply-style text for a permission question. The new Claire gets NO_SHOW_PERMISSION_ISSUE when a question asks to
// show a product or check its stock (or the reply never says "add"), else NO_PERMISSION_ISSUE when the add question is the
// confirm step; an add question before a pick is let through.
const CHOOSE_FIRST = "The customer must choose a product card first";
// The show and check-stock half of old Claire's rule, per question: "Want me to check stock on it? Tap it to add." still asks to
// check stock although the reply says "add".
const asksToShow = /\b(?:want|shall|would|can|should|may)\b[^?？\n]*\b(?:check (?:the )?(?:live )?stock|pull (?:it|this|that|them) up|show (?:it|this|that|them))\b[^?？\n]*[?？]$/i;
// Sent in the tool-less repair whenever the customer typed no number; with one typed, the loop first nudges the question back
// with tools while a tool round is left.
export const NO_PERMISSION_ISSUE = "Don't ask permission to add it: the customer already chose this product. Tools are off for this fix, so don't say it was added or that you will add it. Keep the rest of your answer and change only that question: if they haven't typed how many, ask how many.";
export const NO_SHOW_PERMISSION_ISSUE = "Don't ask permission to show a product or check its stock: the cards already show it with the stock the tools found. Just say what you found.";
// "Want me to add it?", "Once you confirm I'll add it"; not "Want me to add 5, or check alternatives?" nor "How many, so I can add it?".
const asksToConfirmAdd = /\b(?:shall|should|can|may|want|would you like)\b(?![^?？\n]*\bor\b)[^?？\n]*(?<!\bso I can )\badd\b[^?？\n]*[?？]|\bonce you confirm\b[^.!?\n]*\badd\b|\bconfirming:?[^.?!\n]*\?/i;
// Judged per sentence, so "you can download the PDF. Anything else to add?" isn't one question. "How many would you like to
// add?" and "What else can I add?" ask what the prompt wants asked; "Want me to add it, and how many?" still asks permission.
const asksPermissionToAdd = (sentence: string) => asksToConfirmAdd.test(sentence) && !/\b(?:how many|else)\b[^?？]*\badd\b|\badd\s+(?:anything|more|another)\b/i.test(sentence);
/**
 * The permission questions that are the confirm step the owner ruled out: about a product the customer already chose (the cards
 * the question names, else the reply's cards, else the products the reply names), or naming no product at all. "Want me to add the
 * Safico one?" after "which one is more suitable?" asks them to choose (exam 3, c09-stress T1: the nudge turned the recommendation
 * into "How many Safico tongs do you need?"). Without `picked`, every permission question counts, as before.
 */
function confirmStepAsks(message: string, replyCards: readonly ShownCard[], knownCards: readonly ShownCard[], picked?: (code: string) => boolean) {
  return sentences(message).filter(asksPermissionToAdd).filter((sentence) => {
    if (!picked) return true;
    const about = questionCards(sentence, message, replyCards, knownCards);
    return !about.length || about.some((card) => picked(card.code));
  });
}
/** The cards a permission question is about: those it names, else the reply's cards, else the products the reply names. */
function questionCards(sentence: string, message: string, replyCards: readonly ShownCard[], knownCards: readonly ShownCard[]) {
  const named = pointedBy(sentence, [...replyCards, ...knownCards]);
  return named.length ? named : replyCards.length ? [...replyCards] : pointedBy(message, [...knownCards]);
}
/**
 * An answer's cards and the cards its words can name: the products looked up this turn, and the cards of earlier replies, which a
 * question can name without attaching or looking them up (exam 3, c09-stress T1: an unknown product counted as the confirm step).
 */
function answerCards(answer: FinalAnswer, seen: ReadonlyMap<string, CheckedProduct>, earlierCards: readonly ShownCard[]) {
  const looked = seenCards(seen);
  const known = [...looked, ...earlierCards.filter((card) => !looked.some((item) => same(item.code, card.code)))];
  const replyCards = answer.card_ids.flatMap((id) => {
    const found = seen.get(id);
    if (found) return [asCard(found.product)];
    return earlierCards.filter((card) => same(card.code, id)).slice(0, 1);
  });
  return { known, replyCards };
}
/** confirmStepAsks for an answer. */
export function asksConfirmStep(answer: FinalAnswer, seen: ReadonlyMap<string, CheckedProduct>, picked?: (code: string) => boolean, earlierCards: readonly ShownCard[] = []) {
  const { known, replyCards } = answerCards(answer, seen, earlierCards);
  return confirmStepAsks(answer.message, replyCards, known, picked).length > 0;
}
/**
 * The codes of the products the answer's permission-to-add questions are about. The loop checks a named product Claude never
 * proposed before deciding the nudge (r4 c02-persona idx 8: "shall I add 2 of the MX1000" after the customer had named it).
 */
export function permissionCodes(answer: FinalAnswer, seen: ReadonlyMap<string, CheckedProduct>, earlierCards: readonly ShownCard[] = []) {
  const { known, replyCards } = answerCards(answer, seen, earlierCards);
  const codes = sentences(answer.message).filter(asksPermissionToAdd).flatMap((sentence) => questionCards(sentence, answer.message, replyCards, known).map((card) => card.code));
  return [...new Map(codes.map((code) => [code.toLowerCase(), code])).values()];
}
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
  const said = sentences(answer.message);
  const ids = [...new Set(answer.card_ids)];
  const unknown = ids.filter((id) => !seen.has(id));
  if (unknown.length) safety.push(`${UNKNOWN_CARD_ISSUE_PREFIX} in this turn or shown earlier in this chat; not found: ${unknown.join(", ")}.`);
  if (ids.length > 5) style.push("Show at most 5 cards.");
  const cards = ids.filter((id) => seen.has(id)).slice(0, 5).map((id) => seen.get(id)!.product);
  // Chips that break the rules are dropped rather than sent back. A long chip or a 'Yes, add it' chip (the confirm step the owner
  // ruled out; 'Add more items' is not) is dropped alone, and a fourth chip moves up. A chip with a number or amount among the
  // three shown takes the set along: a lone 'with silicone grip' under an either/or question reads as the only answer (exam 3: 43
  // of 80 single-chip turns).
  const confirmChip = /\b(?:add|confirm)\b(?!\s+(?:more|another|other|anything)\b)/i;
  const slots = answer.chips.filter((chip) => chip.length <= 40 && !confirmChip.test(chip)).slice(0, 3);
  const chips = slots.every(chipAllowed) ? slots : [];
  const amounts = unverifiedAmounts(answer.message, allowed);
  if (amounts.length) safety.push(`${MONEY_ISSUE_PREFIX} are not live-checked prices or enquiry totals from this turn: ${amounts.join(", ")}. Remove them or use the exact figures from the tools. When you drop an amount, rephrase the sentence; never leave a bare $. That includes an amount the customer typed ('the 2 dollar one'): name the product instead.`);
  const links = unknownStoreLinks(answer.message, seen, earlier);
  if (links.length) safety.push(`${LINK_ISSUE_PREFIX} did not come from a tool result or this chat: ${links.join(", ")}. Only give a product's link field or a link from a [cards shown] note; never build one from an item code.`);
  if (turn.changes) safety.push(...enquiryClaimIssues(answer.message, { lines: turn.lines ?? [], changes: turn.changes, unchecked: turn.unchecked, seen }));
  for (const { sentence, code } of keptLineClaims(answer.message, turn.unchecked ?? [], turn.changes ?? [])) {
    safety.push(`${KEPT_LINE_PREFIX}: "${sentence}". ${code} wasn't re-checked this turn but is still on the customer's enquiry: don't say it was removed or is missing.`);
  }
  for (const { sentence, kind, found } of turn.searches ? unbackedClaims(answer.message, turn.searches, seen) : []) {
    // A "we don't have it" can be honest about a product type the searches missed, and a ranking may be the answer to "got cheaper?",
    // so they are reworded, never removed.
    if (kind === "absence") style.push(`${ABSENCE_ISSUE_PREFIX} isn't backed by this turn's searches: "${sentence}". ${ABSENCE_FIX}`);
    else if (kind === "disproved") {
      const named = found.slice(0, 3).map((item) => `${item.stock_id} (${item.name.replace(/"/g, "″")})`).join(", ");
      style.push(`${ABSENCE_ISSUE_PREFIX}: "${sentence}". ${named} came up in this turn's results: if it is what the customer asked for, name it with its stock; if not, keep your sentence.`);
    } else if (kind === "ranking") style.push(`${CLAIM_ISSUE_PREFIX} isn't backed by this turn's searches: "${sentence}". ${CLAIM_FIXES.complete}`);
    else safety.push(`${CLAIM_ISSUE_PREFIX} isn't backed by this turn's searches: "${sentence}". ${CLAIM_FIXES[kind]}`);
  }
  style.push(...stockIssues(answer.message, cards));
  const wrongCounts = wrongStockCounts(answer.message, cards, seen);
  if (wrongCounts.length) style.push(stockNumberIssue(wrongCounts));
  if (!cards.length) {
    if (said.some(asksForTap)) safety.push(NO_CARD_TAP_ISSUE);
    if (said.some(promisesToShow)) safety.push(NO_CARD_SHOW_ISSUE);
  }
  // A permission question about a product the customer hasn't picked yet lets them pick it: it is not the confirm step. Judged
  // with the earlier cards, as the loop's nudge is: a recommendation naming an earlier card it doesn't attach names a product
  // (exam 3, c09-stress T1).
  const confirmStep = asksConfirmStep(answer, seen, turn.picked, turn.earlierCards);
  style.push(...replyStyleIssues({ message: answer.message, products: cards, selectedProduct: null }).flatMap((issue) => (!issue.startsWith(CHOOSE_FIRST) ? [issue]
    : !/\badd\b/i.test(answer.message) || said.some((s) => asksToShow.test(s)) ? [NO_SHOW_PERMISSION_ISSUE] : [])));
  if (confirmStep) style.push(NO_PERMISSION_ISSUE);
  if (promiseLater.test(answer.message)) style.push(PROMISE_LATER_ISSUE);
  if (endsMidSentence(answer.message)) style.push(MID_SENTENCE_ISSUE);
  if (danglingCurrency.test(answer.message)) style.push(DANGLING_CURRENCY_ISSUE);
  if (said.some((s) => claims(s, reservationWords))) style.push(RESERVATION_ISSUE);
  // A card update_enquiry refused is not a loop: the question about it offers it. A question naming one card no longer needs it a
  // third time: the pick check reads the chat (exam 4: most same-set third showings were one such card).
  const refused = turn.refused ?? [];
  const needed = cards.some((card) => refused.some((code) => same(code, card.stock_id)));
  style.push(...repetitionIssues(answer.message, cards, earlier, Boolean(turn.changes?.length), needed));
  style.push(...brokenLinkIssues(answer.message, cards, earlier));
  return { safety, style, cards, chips };
}

/** Fixes in code the safety issues that start with `prefix`. */
export type Fixer = { prefix: string; fix: (message: string) => string };

const covers = (fixer: Fixer, issue: string) => issue.startsWith(fixer.prefix);
/** The safety issues no fixer covers. */
export const unfixable = (safety: string[], fixers: Fixer[]) => safety.filter((issue) => !fixers.some((fixer) => covers(fixer, issue)));

/** Runs each fixer whose issue is present, in list order; issues no fixer covers are returned in `left`. */
export function applyFixers(message: string, safety: string[], fixers: Fixer[]) {
  const fixed = fixers.reduce((text, fixer) => (safety.some((issue) => covers(fixer, issue)) ? fixer.fix(text) : text), message);
  return { message: fixed, left: unfixable(safety, fixers) };
}

// Log codes by issue prefix; any other issue is a wording (STYLE) issue.
const ISSUE_CODES: Array<[prefix: string, code: string]> = [
  [UNKNOWN_CARD_ISSUE_PREFIX, "UNKNOWN_CARD"],
  [MONEY_ISSUE_PREFIX, "MONEY"],
  [STOCK_NUMBER_PREFIX, "STOCK_NUMBER"],
  [ENQUIRY_CLAIM_PREFIX, "ENQUIRY_CLAIM"],
  [KEPT_LINE_PREFIX, "KEPT_LINE"],
  [CLAIM_ISSUE_PREFIX, "CLAIM"],
  [ALL_IN_STOCK_ISSUE_PREFIX, "CLAIM"],
  [ABSENCE_ISSUE_PREFIX, "ABSENCE"],
  [MID_SENTENCE_ISSUE, "MID_SENTENCE"],
  [DANGLING_CURRENCY_ISSUE, "DANGLING_CURRENCY"],
  [NO_CARD_PREFIX, "NO_CARD"],
  [LINK_ISSUE_PREFIX, "LINK"],
  [BROKEN_LINK_ISSUE, "LINK"],
  [LINK_BLAME_ISSUE, "LINK"],
  [REPEATED_CARDS_ISSUE, "REPEAT"],
  [REPEATED_MESSAGE_ISSUE, "REPEAT"],
  [PHOTO_AGAIN_ISSUE, "REPEAT"],
  [OFFER_ISSUE_PREFIX, "OFFER"],
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
 * removed (an enquiry reserves nothing). A phone number or email that isn't Sia Huat's sales contact or an item code
 * from this chat is replaced with a pointer to the contact block; that, or a removed staff claim, turns the block on.
 */
export function customerMessage(message: string, itemCodes: readonly string[] = []) {
  // 175 catalogue codes fit the phone pattern (the Patra range 3500-xxxx, Westmark 30002260): a code from this chat stays
  // (exam 3, c05-persona T10-T11). Codes with a space are never spared, so "9123 4567" can't pass as one.
  const codes = new Set(itemCodes.filter((code) => /^\S+$/.test(code)).map((code) => code.toLowerCase()));
  const trimmed = message.trim();
  const unreserved = sentences(trimmed).some(isReservationClaim) ? removeSentences(trimmed, isReservationClaim) : trimmed;
  if (trimmed && !unreserved) return { message: CONTACT_LINE, showContact: true };
  // Only a phone-shaped code is spared: shownProductIds come from the browser, so an email among them is still replaced.
  const contactChecked = unreserved.replace(contactPattern, (found) => (isSalesContact(found) || (!found.includes("@") && codes.has(found.toLowerCase())) ? found : OTHER_CONTACT));
  const checked = honestManualHandoff(contactChecked);
  if (checked === contactChecked) return { message: contactChecked, showContact: contactChecked !== unreserved };
  return { message: checked.replace(HANDOFF_SENTENCE, "").trim() || CONTACT_LINE, showContact: true };
}
