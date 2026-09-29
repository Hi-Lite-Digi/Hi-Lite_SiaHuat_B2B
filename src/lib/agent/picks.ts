// src/lib/agent/picks.ts
import { CHIP_PREFIX, TAP_PREFIX, customerWords, parseCardsNote, withoutCardsNote, type AgentRequest, type ShownCard } from "./contract";
import { quantityStated } from "./enquiry";

/** A card the customer tapped. age: customer messages since (0 = this turn); seen: Claire's replies before it. */
export type PickTap = { code: string; age: number; seen: number };
/** A text the customer typed, or a chip they tapped. */
export type PickText = { text: string; seen: number; age: number; chip: boolean };
/** One of Claire's replies: the cards it showed and its message. */
export type PickReply = { cards: ShownCard[]; text: string };
/** Everything in the chat that can show which product the customer picked. */
export type PickEvidence = { taps: PickTap[]; texts: PickText[]; replies: PickReply[] };

const TAP_EVENTS = 6; // exam 2, c01-stress: a knife tapped at T7 was still the one meant at T12
// Only the newest 4 texts can pick; older texts within the tap window can still turn a card down.
const PICK_TEXTS = 4;
// A card named with no pick word counts only in the newest 2 texts, like a quantity (exam 2, c08-persona: a link complaint).
const NAMING_TEXTS = 2;

/** The pick evidence in the chat history and this turn's event, newest first. Every customer message counts toward age. */
export function pickEvidence(history: AgentRequest["history"], event: AgentRequest["event"]): PickEvidence {
  const replies: PickReply[] = [];
  const events: Array<{ seen: number; tap?: string; text?: string; chip?: boolean }> = [];
  for (const item of history) {
    if (item.role === "assistant") {
      replies.push({ cards: parseCardsNote(item.content), text: withoutCardsNote(item.content) });
    } else if (item.content.startsWith(TAP_PREFIX)) {
      events.push({ seen: replies.length, tap: item.content.match(/\(code ([^()]+)\)\s*$/)?.[1] });
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
// Material and part words many products share: a later card sharing only these is not the same kind as a tapped one.
const MATERIALS = new Set(["stainles", "steel", "porcelain", "plastic", "handle"]);
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

// Card names come from the client and every clause is checked against them: each card's name words and sizes are worked out once.
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

// A definite "the cheap 4 slot", "that bigger one", "whichever cheapest"; never "want bigger plate la cheap cheap",
// "the price is cheap" or "the price cheap".
const definite = (words: string) => new RegExp(`\\b(?:the|that|tat|dat|whichever|wichever)\\s+(?:(?!(?:is|are|was|were|so|very|quite|too|not|abit|damn|price|prices|pricing|cost)\\b)\\S+\\s+){0,2}?(?:${words})\\b`, "i");
const CHEAP = "cheap|cheapest|lowest[- ]priced?|least expensive|most affordable";
const BIG = "bigger|biggest|larger|largest|longer|longest";
const SMALL = "smaller|smallest|shorter|shortest";
const cheapWord = definite(CHEAP);
const bigWord = definite(BIG);
const smallWord = definite(SMALL);
// "the bigger pan" names a kind, often by a word too short to be a name word; only a bare "the bigger one" means the cards just shown.
const kindNamed = new RegExp(`\\b(?:${CHEAP}|${BIG}|${SMALL})\\s+(?!(?:one|ones|de|la|lah|lor|also|can|pls|please|same|take|want|and|n)\\b)\\p{L}{3,}`, "iu");

/** The one card with the lowest or highest value, when every card has one and no two tie for it. */
function extreme(cards: ShownCard[], key: (card: ShownCard) => number | null, pick: "min" | "max") {
  const values = cards.map(key);
  if (cards.length < 2 || values.some((value) => value === null)) return null;
  const best = pick === "min" ? Math.min(...(values as number[])) : Math.max(...(values as number[]));
  const winners = cards.filter((_, index) => values[index] === best);
  return winners.length === 1 ? winners[0] : null;
}

/** The card's size when its name gives exactly one: lengths in cm, else the number with its unit. */
function oneMeasure(card: ShownCard) {
  const sizes = [...factsOf(card).sizes].filter((size) => /^\d+(?:\.\d+)?(?:cm|mm|in|l|qt|ml|oz|slot|m)$/.test(size));
  if (sizes.length !== 1) return null;
  const [, value, unit] = sizes[0].match(/^(\d+(?:\.\d+)?)(\D+)$/)!;
  const cm = unit === "mm" ? Number(value) / 10 : unit === "in" ? Number(value) * 2.54 : unit === "cm" ? Number(value) : null;
  return cm !== null ? { value: cm, unit: "len" } : { value: Number(value), unit };
}

/**
 * The cards the text points at: each has hits, and every other card sharing one of those hits has fewer.
 * On a tie, a card in `newest` beats one that isn't. When several cards fit the typed price, only those whose price rounds
 * to it keep that hit. With `superlative`, "the cheap/bigger/smaller …" points at the one card code knows is cheapest,
 * biggest or smallest among the cards the other words point at most (else `fallback`), leaving out `exclude`.
 */
export function pointedCards(text: string, cards: ShownCard[], newest: ShownCard[] = [], fallback: ShownCard[] = [], superlative: { exclude: Set<string> } | null = null) {
  // A card re-shown as "Price to be confirmed" keeps the price shown earlier (exam 3, c10-persona T8).
  const byCode = new Map<string, ShownCard>();
  for (const card of cards) if (card.price !== null || !byCode.has(card.code.toLowerCase())) byCode.set(card.code.toLowerCase(), card);
  const scored = [...byCode.values()]
    .map((card) => ({ card, hits: hits(card, text), newest: newest.some((item) => same(item.code, card.code)) }));
  // "the 2 dollar one" fits $2.29 and $2.75: only $2.29 rounds to 2 (exam 3, c06-stress T4). $5.10 and $5.45 both round to 5, so both stay.
  const priced = scored.filter((item) => item.hits.has("$price") && item.card.price !== null);
  if (priced.length > 1) {
    const rounds = (item: (typeof priced)[number]) => priceMentions(text, item.card).some(({ value, step, plus }) => plus || Math.abs(item.card.price! - value) < step / 2);
    if (priced.some(rounds)) for (const item of priced) if (!rounds(item)) item.hits.delete("$price");
  }
  const pointed = scored.filter((own) => own.hits.size > 0 && scored.every((other) => other === own
    || other.hits.size < own.hits.size
    || ![...other.hits].some((hit) => own.hits.has(hit))
    || (other.hits.size === own.hits.size && own.newest && !other.newest))).map(({ card }) => card);
  if (superlative && (cheapWord.test(text) || bigWord.test(text) || smallWord.test(text))) {
    // Exam 3: "the cheap 4 slot" (c11-persona T7), "the cheapest waring" (c02-stress T8). "Cheapest" needs every price known.
    // Material words don't say which kind: "the cheapest stainless steel one" is not the knife shown earlier among tongs.
    const kindHits = (item: (typeof scored)[number]) => [...item.hits].filter((hit) => !MATERIALS.has(hit)).length;
    const most = Math.max(0, ...scored.map(kindHits));
    const pool = (most > 0 ? scored.filter((item) => kindHits(item) === most).map((item) => item.card) : kindNamed.test(text) ? [] : fallback)
      .filter((card) => !superlative.exclude.has(card.code.toLowerCase()));
    const byPrice = cheapWord.test(text) ? extreme(pool, (card) => card.price, "min") : null;
    const units = new Set(pool.map((card) => oneMeasure(card)?.unit ?? "?"));
    const bySize = !byPrice && units.size === 1 && !units.has("?") && (bigWord.test(text) || smallWord.test(text))
      ? extreme(pool, (card) => oneMeasure(card)?.value ?? null, bigWord.test(text) ? "max" : "min") : null;
    const chosen = byPrice ?? bySize;
    if (chosen) return [chosen];
  }
  return pointed;
}

// "$1,220" and "5.41" stay whole. Runs of spaces become one, so the clause patterns below stay fast on long texts.
const clausesOf = (text: string) => text.split(/(?<=[;!?\n，；！？。])|(?<=\D,)|(?<=,)(?!\d)|(?<=\.)(?!\d)/)
  .map((clause) => clause.replace(/\s+/g, " ").trim()).filter(Boolean);
const refusal = /\b(?:no|not|dont|don'?t|dun|didn'?t|never|nvm|forget|cancel|wrong|remove)\b|不要|不用|取消/i;
// "got stock or not" asks and "no rush" is polite; neither turns anything down.
const refuses = (clause: string) => refusal.test(clause.replace(/\bor\s+not\b|\bno\s+(?:rush|hurry|problem|worries)\b/gi, " "));
const isQuestion = (clause: string) => /[?？]|\b(?:or not|anot|meh|har)[\s.,;!]*$/i.test(clause);
const questionStart = /^(?:which|what|whats|wat|where|when|who|how|why|is|are|does|do|can|got|any|(?:should|shall)\s+(?:i|we))\b/i;
// "can" starts a yes as often as a question ("Can u help me do a 50 pcs qoutation for this").
const asksFirst = (clause: string) => questionStart.test(clause) && !/^can\b/i.test(clause);
// "now got 4 inch" asks (exam 2, c12-stress).
const namingHedge = /\b(?:other|others|another|else|cheaper|instead|too|ex|expensive|but|got)\b/i;
const pickVerb = /\b(?:take|add|want|wan|go with|go for|choose|chose|pick|buy|order|get|make it|change to|switch to|confirm|i say|i said|said|i tap)\b|要|拿|买|加/i;
const okStart = /^(?:ok|okay|yes|ya|yah|yeah|sure)\b/i;
const yesHedge = /\b(?:but|other|others|else|another|cheaper|instead|wait|boss|expensive|ex|how about|what about|hmm|or not|anot|think|later|consider)\b/i;
const yesWords = /^(?:ok(?:ay)?|yes|ya|yah|yeah|sure)\b[\s,!.]*/i;
// A chip Claude wrote to browse on ("More tong options", "Show tong sizes") names a kind of product, not a pick.
const browsingChip = /^(?:show|see|more)\b|\b(?:options|sizes|other)\b/i;
const acceptStart = /^\s*(?:(?:aiya|aiyo|haiz|wah|eh|ok(?:ay)?|ya|yes)[\s,!.]+)*(?:ok(?:ay)?|yes|ya|yah|yeah|yep|sure|confirm|go ahead|(?:just\s+)?(?:add|take))\b|^\s*can\s*(?:la|lah|lor|liao|already|alr)?\s*(?:\d+\s*(?:pcs?|units?)?)?[\s.!]*$|^\s*(?:好的|可以|就这个)/i;
const thisOne = /\b(?:this|that|tis|dis|tat|it)\b/i;
const bareQuantity = /^\s*(?:just|only)?\s*(?:x\s*)?\d+\s*(?:pcs?|pieces?|units?|sets?|nos?)?\s*(?:only|la|lah|lor|leh|ah|can|pls|please|thanks)?[\s.!,;]*$/i;
// Owner default (Q4): a bare number is a yes only after Claire asked how many or offered to add.
const askedHowMany = /\bhow many\b|\b(?:quantity|qty)\b|\b(?:want|shall|should|can) (?:me to |i )?add\b|\badd (?:it|this|that|one|the|\d)/i;
const switchWord = /\b(?:change|switch|instead|rather|actually|other one)\b|换/i;
// "change the 20.5cm to the 21cm one" is a switch too.
const switchTo = /\b(?:change|switch|swap)\b(?:[^.!?]|(?<=\d)\.(?=\d))*\bto\b/i;
// "i said 50 already lah" repeats the quantity: a yes when the text asks nothing (exam 3, c12-stress T6). The number may
// come first ("3 lah i told u already", runs-new c10-persona T13), but nothing except filler may follow it, so
// "i told u 5 is too many" is no yes to 5.
const INSIST_FILLER = "(?:\\s*(?:already|alr|liao|la|lah|mah|leh|lor|wat|what|ah|only|ok|okay|pls|please|u|you))*";
const insist = new RegExp(`\\bi\\s+(?:said|say|told)\\b.*\\d\\s*(?:pcs?|units?|sets?)?${INSIST_FILLER}[\\s.!,]*$|^\\s*\\d+\\s*(?:pcs?|units?|sets?)?${INSIST_FILLER}\\s*i\\s+(?:said|say|told)\\b${INSIST_FILLER}[\\s.!,]*$`, "i");
// "why every time must ask again" complains; it doesn't ask (exam 3, c08-stress T9). "why keep changing price" asks.
const complaint = /^why\b[^?？]*\b(?:ask|asking|again)\b/i;
// A question asking the customer to take a product ("Want to go with 2 of the Mika instead?"), never "Want me to check …?"
// or "Is it for your grill station?".
const takeQuestion = /\b(?:go with|you mean|you'?d like|you want|want (?:this|that|it|the|\d)|is it(?!\s+for\b)|confirm|add)\b/i;
const lookQuestion = /\b(?:check|show|look|search|find|see|compare)\b/i;
// "Is it the Waring…, or the Mika?" offers two products; "got stock or not?" doesn't (exam 3 evidence check).
const eitherOr = (question: string) => /\bor\b/i.test(question.replace(/\bor\s+not\b/gi, " "));

/**
 * The one product Claire's reply asked the customer to take when it showed no card or several (exam 3, c08-persona T9,
 * c02-B T18): its questions together name exactly one product (by code, else by name), and one of them is a take question
 * that isn't either/or.
 */
function focusCards(reply: PickReply, seenCards: ShownCard[]) {
  const pool = reply.cards.length ? reply.cards : seenCards;
  const unique = [...new Map(pool.map((card) => [card.code.toLowerCase(), card])).values()];
  const questions = reply.text.split(/(?<=[.!?？])\s+/).filter((sentence) => /[?？]\s*$/.test(sentence));
  const named = questions.map((question) => {
    const typed = unique.filter((card) => codePattern(card.code).test(question));
    return typed.length ? typed : pointedCards(question.replace(/\$\s?[\d,.]+/g, " "), unique);
  });
  const all = [...new Map(named.flat().map((card) => [card.code.toLowerCase(), card])).values()];
  return all.length === 1 && questions.some((question, index) => !eitherOr(question) && takeQuestion.test(question)
    && !lookQuestion.test(question) && named[index].length === 1) ? all : [];
}

// "change to the mika instead of the waring": the words after "instead of" or "rather than" name the card being dropped.
const dropped = /\b(?:instead of|rather than)\b.*$/i;
/** The words naming the new card in "change/switch/swap X to Y": those after the first "to" (exam 3, c11-persona T7). */
const newSide = (clause: string) => (switchTo.test(clause) ? clause.replace(/^.*?\b(?:change|switch|swap)\b.*?\bto\b/i, "").replace(dropped, "") : clause);
const deferred = /\b(?:maybe|next time|see first|nvm)\b/i;

/** The cards one clause of a customer text points at; `excluded` gives the cards the text turns down, worked out once per text. */
function clauseCards(clause: string, excluded: () => Set<string>, seenCards: ShownCard[], newest: ShownCard[], shown: ShownCard[]) {
  const words = newSide(clause);
  // "the cheap 4 slot" or "whichever cheapest" only in a clause that picks, switches or gives a number, with no hedge,
  // among the cards the customer didn't turn down ("no conveyor").
  const superlative = (pickVerb.test(clause) || switchTo.test(clause) || /\bwh?ichever\b/i.test(clause) || /\d/.test(words))
    && !yesHedge.test(words) && !deferred.test(words) ? { exclude: excluded() } : null;
  let found = pointedCards(words, seenCards, newest, shown.length > 1 ? shown : newest, superlative);
  // A switch whose new side names nothing ("change the 4 slot to 3 pcs") is a quantity change of the card it names. One
  // whose new side names two cards evenly picks neither: never the card being switched from.
  if (!found.length && words !== clause && !seenCards.some((card) => hits(card, words).size)) found = pointedCards(clause.replace(dropped, ""), seenCards, newest);
  // "the white plate and bowl 4 each" names two cards (exam 3, c05-persona T9); "and ask ur boss the 16 inch price" picks nothing.
  if (!found.length) {
    found = words.split(/\s+(?:and|n|&|\+|plus)\s+/i).filter((part) => !yesHedge.test(part) && !deferred.test(part))
      .flatMap((part) => pointedCards(part, seenCards, newest));
  }
  return found;
}

/**
 * Worked out once per text and clause, then shared by every code checked: the cards each clause points at, for each
 * hit the largest hit count of any card that has it, and the one product the reply before the text asked about
 * (card names and replies come from the client, so nothing may be redone per code).
 */
type Pointing = Map<PickText, { pointed: Map<string, ShownCard[]>; most: Map<string, Map<string, number>>; focus?: ShownCard[]; excluded?: Set<string> }>;

/** What one customer text says about this card: it picks it, turns it down, or says nothing about it. */
function textVerdict(code: string, quantity: number | null, sent: PickText, recent: boolean, replies: PickReply[], pointing: Pointing): "pick" | "refuse" | null {
  if (sent.chip && browsingChip.test(sent.text)) return null;
  const seenSets = replies.slice(0, sent.seen).map((reply) => reply.cards);
  const seenCards = seenSets.flat();
  const all = clausesOf(sent.text);
  // Questions and refusals never pick.
  const clauses = all.filter((clause) => !refuses(clause) && !isQuestion(clause));
  const cache = pointing.get(sent) ?? { pointed: new Map<string, ShownCard[]>(), most: new Map<string, Map<string, number>>() };
  pointing.set(sent, cache);
  const before = replies[sent.seen - 1];
  // The cards the text's refusals turn down, for every superlative clause of it (a crafted text of distinct clauses once took 7 s).
  const excluded = () => (cache.excluded ??= new Set(all.filter(refuses).flatMap((other) => pointedCards(other, seenCards)).map((card) => card.code.toLowerCase())));
  const points = (target: string, clause: string) => {
    if (!cache.pointed.has(clause)) cache.pointed.set(clause, clauseCards(clause, excluded, seenCards, seenSets.findLast((cards) => cards.length) ?? [], before?.cards ?? []));
    return cache.pointed.get(clause)!.some((card) => same(card.code, target));
  };
  const typedCode = codePattern(code);
  // A typed code picks even in a question ("Can I get 10 pcs of BTS-8026D?").
  if (all.some((clause) => !refuses(clause) && typedCode.test(clause))) return "pick";

  // Naming: a card in the reply just before, from a recent text; otherwise only when the text is picking something
  // or the naming clause itself has a pick word ("i want for cooking" doesn't pick the tong named in another clause).
  // In a switch only the new side can hedge, and "instead" there is no hedge (exam 3, c11-stress T4).
  const picking = (quantity !== null && quantityStated(quantity, [sent.text])) || sent.chip || clauses.some((clause) => okStart.test(clause));
  const nameOk = picking || (recent && before?.cards.some((card) => same(card.code, code)));
  const hedged = (clause: string) => namingHedge.test(switchTo.test(clause) ? newSide(clause).replace(/\binstead\b/gi, "") : clause);
  if (clauses.some((clause) => (nameOk || pickVerb.test(clause) || switchTo.test(clause)) && !questionStart.test(clause) && !hedged(clause) && points(code, clause))) return "pick";

  // Asked, then shown: "need scrub sponge 2pkt", and the next reply showed one card that clearly matches it.
  const next = replies[sent.seen]?.cards ?? [];
  const shown = next.find((card) => same(card.code, code));
  if (quantity !== null && shown && clauses.some((clause) => {
    if (!quantityStated(quantity, [clause])) return false;
    const mine = hits(shown, clause);
    return (mine.size >= 2 || [...mine].some((hit) => hit === "$price" || /^\d/.test(hit)))
      && next.every((card) => card === shown || ![...hits(card, clause)].some((hit) => mine.has(hit)));
  })) return "pick";

  // A yes to the only card Claire just showed, or to the one product her reply asked about, with no hedge and no other
  // card named. A text that also asks something ("ok, how much?") says yes only with the number in the yes itself
  // ("ok 2, how much total?").
  const asks = all.some((clause) => isQuestion(clause) || (asksFirst(clause.replace(yesWords, "")) && !complaint.test(clause.replace(yesWords, ""))));
  if (before && !cache.focus) cache.focus = before.cards.length === 1 ? before.cards : focusCards(before, seenCards);
  const focus = cache.focus ?? [];
  if (before && focus.length === 1 && same(focus[0].code, code) && !yesHedge.test(sent.text)
    && !seenCards.some((card) => !same(card.code, code) && clauses.some((clause) => points(card.code, clause)))
    && clauses.some((clause) => (acceptStart.test(clause) && (!asks || (quantity !== null && quantityStated(quantity, [clause]))))
      || (quantity !== null && !asksFirst(clause) && quantityStated(quantity, [clause]) && thisOne.test(clause))
      || (bareQuantity.test(clause) && askedHowMany.test(before.text))
      || (!asks && quantity !== null && insist.test(clause) && quantityStated(quantity, [clause])))) return "pick";

  const own = seenCards.findLast((card) => same(card.code, code));
  // A refusal turns down a card when one of its hits is not also a hit of a card the refusal names more:
  // "the dinner knife no need" is not about the dinner fork, but "cancel the chef knife and the fork" is.
  const mostHits = (clause: string) => {
    let most = cache.most.get(clause);
    if (!most) {
      most = new Map<string, number>();
      for (const card of seenCards) {
        const theirs = hits(card, clause);
        for (const hit of theirs) most.set(hit, Math.max(most.get(hit) ?? 0, theirs.size));
      }
      cache.most.set(clause, most);
    }
    return most;
  };
  const namesIt = (clause: string) => {
    const mine = own ? hits(own, clause) : new Set<string>();
    if (!mine.size) return false;
    const most = mostHits(clause);
    return [...mine].some((hit) => (most.get(hit) ?? 0) <= mine.size);
  };
  const turnsDown = (clause: string) => refuses(clause) && !isQuestion(clause) && (typedCode.test(clause) || namesIt(clause));
  return all.some(turnsDown) ? "refuse" : null;
}

/** A tap stops counting after a tap of, or a switch to, another card of its set, or when Claire later showed same-kind cards without it. */
function tapVoided(tap: PickTap, picks: PickEvidence) {
  const set = picks.replies.slice(0, tap.seen).map((reply) => reply.cards).findLast((cards) => cards.some((card) => same(card.code, tap.code))) ?? [];
  const isRival = (code: string) => !same(code, tap.code) && set.some((card) => same(card.code, code));
  if (picks.taps.some((later) => later.age < tap.age && isRival(later.code))) return true;
  if (picks.texts.some((later) => later.age < tap.age && switchWord.test(later.text)
    && clausesOf(later.text).some((clause) => pointedCards(clause, set).some((card) => isRival(card.code))))) return true;
  const tapped = set.find((card) => same(card.code, tap.code));
  if (!tapped) return false;
  const kind = new Set(nameWords(tapped.name).filter((word) => !MATERIALS.has(word)));
  return picks.replies.slice(tap.seen).some((reply) => !reply.cards.some((card) => same(card.code, tap.code))
    && reply.cards.some((card) => nameWords(card.name).some((word) => kind.has(word))));
}

/**
 * True when the customer picked this product: it is on the enquiry, or, walking their taps and texts newest first,
 * they tapped it (within 6 messages), or in one of their newest 4 texts typed its code, named it (words, size or price
 * from its card; with no pick word in that clause, only in their newest 2 texts), asked for it with a quantity just
 * before Claire showed it, or said yes to it as the only card Claire had just shown or the one product she just asked about.
 * A newer text that turns it down ("knife dont need") ends the walk.
 */
export function customerChose(stockId: string, quantity: number | null, picks: PickEvidence, lineCodes: string[]) {
  return chose(stockId, quantity, picks, lineCodes, new Map());
}

export type Chooser = (stockId: string, quantity: number | null, lineCodes: string[]) => boolean;
/**
 * customerChose for one turn's checks, sharing one cache as pickedCodes does: nothing it holds depends on the code or the
 * quantity. The loop tries each product a permission question names with every typed number, and with a cache per check a
 * crafted history held one turn for 8 s.
 */
export function turnChooser(picks: PickEvidence): Chooser {
  const pointing: Pointing = new Map();
  return (stockId: string, quantity: number | null, lineCodes: string[]) => chose(stockId, quantity, picks, lineCodes, pointing);
}

function chose(stockId: string, quantity: number | null, picks: PickEvidence, lineCodes: string[], pointing: Pointing) {
  if (lineCodes.some((code) => same(code, stockId))) return true;
  const events: Array<{ age: number; tap?: PickTap; text?: PickText }> = [
    ...picks.taps.map((tap) => ({ age: tap.age, tap })),
    ...picks.texts.map((text) => ({ age: text.age, text })),
  ].sort((a, b) => a.age - b.age);
  for (const { tap, text } of events) {
    if (tap && same(tap.code, stockId) && !tapVoided(tap, picks)) return true;
    if (!text) continue;
    const index = picks.texts.indexOf(text);
    const verdict = textVerdict(stockId, quantity, text, index < NAMING_TEXTS, picks.replies, pointing);
    if (verdict === "refuse" || (verdict === "pick" && index < PICK_TEXTS)) return verdict === "pick";
  }
  return false;
}

/** The products the customer picked that are not on the enquiry yet. */
export function pickedCodes(picks: PickEvidence, lineCodes: string[]) {
  const pointing: Pointing = new Map();
  const codes = new Map([...picks.taps.map((tap) => tap.code), ...picks.replies.flatMap((reply) => reply.cards.map((card) => card.code))]
    .map((code) => [code.toLowerCase(), code]));
  return [...codes.values()].filter((code) => !lineCodes.some((line) => same(line, code)) && chose(code, null, picks, lineCodes, pointing));
}
