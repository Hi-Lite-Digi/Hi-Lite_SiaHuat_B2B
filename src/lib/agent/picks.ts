// src/lib/agent/picks.ts
import { CHIP_PREFIX, TAP_PREFIX, customerWords, parseCardsNote, tappedCode, withoutCardsNote, type AgentRequest, type ShownCard } from "./contract";

/** A card the customer tapped. age: customer messages since (0 = this turn); seen: Claire's replies before it. */
export type PickTap = { code: string; age: number; seen: number };
/** A text the customer typed, or a chip they tapped. */
export type PickText = { text: string; seen: number; age: number; chip: boolean };
/** One of Claire's replies: the cards it showed and its message. */
export type PickReply = { cards: ShownCard[]; text: string };
/** Claire's replies (their cards and text, for the repeat and card checks) and the customer's newest taps and typed texts ("same qty"). */
export type PickEvidence = { taps: PickTap[]; texts: PickText[]; replies: PickReply[] };

// The customer's newest 6 messages, taps included: "same qty" reads the newest 4 typed texts among them (exam 3, c09-stress T7).
const TAP_EVENTS = 6;

/** The chat history and this turn's event as PickEvidence, newest first. Every customer message counts toward age. */
export function pickEvidence(history: AgentRequest["history"], event: AgentRequest["event"]): PickEvidence {
  const replies: PickReply[] = [];
  const events: Array<{ seen: number; tap?: string; text?: string; chip?: boolean }> = [];
  for (const item of history) {
    if (item.role === "assistant") {
      replies.push({ cards: parseCardsNote(item.content), text: withoutCardsNote(item.content) });
    } else if (item.content.startsWith(TAP_PREFIX)) {
      events.push({ seen: replies.length, tap: tappedCode(item.content) ?? undefined });
    } else if (item.content.startsWith(CHIP_PREFIX)) {
      events.push({ seen: replies.length, text: item.content.slice(CHIP_PREFIX.length).trim(), chip: true });
    } else {
      events.push({ seen: replies.length, text: customerWords(item.content) ?? undefined });
    }
  }
  if (event.type === "select_product") events.push({ seen: replies.length, tap: event.stockId });
  if (event.type === "text") events.push({ seen: replies.length, text: event.text, chip: Boolean(event.chip) });
  if (event.type === "image") events.push({ seen: replies.length, text: event.caption || undefined });
  const newest = events.reverse().map((item, age) => ({ ...item, age })).filter(({ age }) => age < TAP_EVENTS);
  return {
    taps: newest.flatMap(({ tap, seen, age }) => (tap ? [{ code: tap, seen, age }] : [])),
    texts: newest.flatMap(({ text, chip, seen, age }) => (text === undefined ? [] : [{ text, seen, age, chip: chip ?? false }])),
    replies,
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches this item code typed whole: "bts-8026d" in "2 pcs of bts-8026d", not in "bts-8026d2". */
export const codePattern = (code: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(code)}(?![\\p{L}\\p{N}])`, "iu");
/** The same item code, whatever the case. */
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Name words that say nothing about which product it is.
const STOP = new Set(["with", "come", "from", "that", "this", "have", "only", "also", "each", "type", "free", "size", "series", "pieces"]);
// A number followed by one of these is a quantity, never a product's size.
const COUNT_UNITS = /^(?:pcs?|pieces?|units?|sets?|pkts?|packets?|packs?|ctns?|cartons?|boxe?s?|nos?|x)$/;

function unitKey(unit: string, spaced: boolean) {
  const u = unit.toLowerCase();
  if (/^(?:"|″|”|''|inch|inches)$/.test(u) || (u === "in" && !spaced)) return "in";
  if (u === "in") return "in-word"; // "2 in stock" is not a size
  if (/^(?:l|lt|ltr|litres?|liters?)$/.test(u)) return "l";
  if (/^(?:qt|quarts?)$/.test(u)) return "qt";
  return u.replace(/(?:es|s)$/, "");
}

/** Sizes and part counts written next to a number: 16" / 16 inch, 6-Slots / 6 slot, Ø25cm / 25cm, 5L / 5 litre. */
function measures(text: string) {
  const found = new Set<string>();
  // "4 or 6 slots" names both sizes (exam 3, c11-stress T7); "GN 2/3" is never a size of 2, nor "2 or 3 in total" of 2in.
  for (const match of text.matchAll(/(?<![\w.])(\d+)\s*or\s*(\d+)(\s*(?:-\s*)?)([a-z]+)/gi)) {
    if (!COUNT_UNITS.test(match[4].toLowerCase())) found.add(`${Number(match[1])}${unitKey(match[4], /\s/.test(match[3]))}`);
  }
  // Card names come from the client, so the spaces-hyphen-spaces group must not backtrack on long runs of spaces.
  for (const match of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(\s*(?:-\s*)?)("|″|”|''|[a-z]+)/gi)) {
    if (!COUNT_UNITS.test(match[3].toLowerCase())) found.add(`${Number(match[1])}${unitKey(match[3], /\s/.test(match[2]))}`);
  }
  return found;
}

// A price that picks a card: "the $5 one", "the 5 dollar one", "the 1.2k one", with the card's own name words before "one" ("the
// 7 dollar shibazi one", exam 3 c08-stress T6) or right before a word of its name ("the 2 dollar skimmer", c06-persona T8). Never
// a budget ("budget 5 dollar only", "below 5 dollar one", "below 1k"). "3 dollar plus", "$3+" and "3 dollar something" mean
// $3.00-$3.99 (c10-stress T5); a bare "the 3 plus one" may be a count, so it needs the $ or dollar word.
const priceWord = /(?:S?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(k)?|(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:(k)|\s?(?:dollars?|bucks|sgd)))(\s*(?:\+|plus\b|something\b))?((?:\s+\p{L}+){0,3})/giu;
const budgetBefore = /\b(?:below|under|within|budget|less than|max|maximum|around|about|cheaper than|than|over|above)\s*$/i;
const priceFiller = /^(?:la|lah|lor|the|that|tat|one|ones|de)$/;

/** The prices this text gives with the card's name words; "i pay 5 dollar for one also can" gives none. */
function priceMentions(text: string, card: ShownCard) {
  const own = factsOf(card).words;
  const found: Array<{ value: number; step: number; plus: boolean; thousands: boolean }> = [];
  for (const match of text.matchAll(priceWord)) {
    // Only the words just before the price can make it a budget; a long text is not read again for every price in it.
    if (budgetBefore.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
    const after = (match[6] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const oneAt = after.findIndex((word) => /^(?:one|ones|de)$/.test(word));
    const nameAt = after.findIndex((word) => own.includes(singular(word)));
    const named = (oneAt >= 0 && oneAt <= 2 && after.slice(0, oneAt).every((word) => priceFiller.test(word) || own.includes(singular(word))))
      || (nameAt >= 0 && nameAt <= 1 && after.slice(0, nameAt).every((word) => priceFiller.test(word)));
    if (!named) continue;
    const raw = (match[1] ?? match[3]).replace(/,/g, "");
    const thousands = Boolean(match[2] ?? match[4]);
    found.push({ value: Number(raw) * (thousands ? 1000 : 1), step: (thousands ? 1000 : 1) / 10 ** (raw.split(".")[1]?.length ?? 0), plus: Boolean(match[5]), thousands });
  }
  return found;
}

/** "5 dollar" fits $5.00-$5.99 or what rounds to $5; "5.41" fits only $5.41; "1.2k" fits $1,150-$1,249.99. */
function namedPriceFits(price: number, text: string, card: ShownCard) {
  return priceMentions(text, card).some(({ value, step, plus, thousands }) => (plus ? price >= value && price < value + (thousands ? 1000 : 1)
    : (!thousands && step === 1 && Math.floor(price) === value) || Math.abs(price - value) < step / 2));
}

const singular = (word: string) => (word.length >= 5 ? word.replace(/s$/, "") : word);
/** A name's words of 4+ letters, singular ("slots" and "slot" count once), without words that say nothing about the product. */
const nameWords = (name: string) => [...new Set((name.toLowerCase().match(/\p{L}{4,}/gu) ?? [])
  .filter((word) => !STOP.has(word))
  .map(singular))];

// Card names come from the client and every text is checked against them: each card's name words and sizes are worked out once.
const nameFacts = new WeakMap<ShownCard, { words: string[]; sizes: Set<string> }>();
function factsOf(card: ShownCard) {
  let facts = nameFacts.get(card);
  if (!facts) nameFacts.set(card, (facts = { words: nameWords(card.name), sizes: measures(card.name) }));
  return facts;
}

/** True when a word of the (lower-case) text starts with this word: "plate" is in "2 plates". */
function startsAWord(text: string, word: string) {
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0 || !/\p{L}/u.test(text[at - 1])) return true;
  }
  return false;
}

/** The name words, sizes and price ("$price") of this card that the text mentions. */
export function hits(card: ShownCard, text: string) {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  const { words, sizes } = factsOf(card);
  for (const word of words) if (startsAWord(lower, word)) found.add(word);
  const typed = measures(text);
  for (const size of sizes) if (typed.has(size)) found.add(size);
  if (card.price !== null && namedPriceFits(card.price, text, card)) found.add("$price");
  return found;
}

/**
 * The cards the text points at: each has hits, and every other card sharing one of those hits has fewer. When several
 * cards fit the typed price, only those whose price rounds to it keep that hit.
 */
export function pointedCards(text: string, cards: ShownCard[]) {
  // A card re-shown as "Price to be confirmed" keeps the price shown earlier (exam 3, c10-persona T8).
  const byCode = new Map<string, ShownCard>();
  for (const card of cards) if (card.price !== null || !byCode.has(card.code.toLowerCase())) byCode.set(card.code.toLowerCase(), card);
  const scored = [...byCode.values()].map((card) => ({ card, hits: hits(card, text) }));
  // "the 2 dollar one" fits $2.29 and $2.75: only $2.29 rounds to 2 (exam 3, c06-stress T4). $5.10 and $5.45 both round to 5, so both stay.
  const priced = scored.filter((item) => item.hits.has("$price") && item.card.price !== null);
  if (priced.length > 1) {
    const rounds = (item: (typeof priced)[number]) => priceMentions(text, item.card).some(({ value, step, plus }) => plus || Math.abs(item.card.price! - value) < step / 2);
    if (priced.some(rounds)) for (const item of priced) if (!rounds(item)) item.hits.delete("$price");
  }
  return scored.filter((own) => own.hits.size > 0 && scored.every((other) => other === own
    || other.hits.size < own.hits.size
    || ![...other.hits].some((hit) => own.hits.has(hit)))).map(({ card }) => card);
}
