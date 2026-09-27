// src/lib/agent/picks.ts
import { CHIP_PREFIX, TAP_PREFIX, parseCardsNote, withoutCardsNote, type AgentRequest, type ShownCard } from "./contract";
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
      const text = item.content.replace(/^\[photo\]\s*/, "");
      events.push({ seen: replies.length, text: text && text !== "(no caption)" ? text : undefined });
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
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
  for (const match of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(\s*-?\s*)("|″|”|''|[a-z]+)/gi)) {
    if (!COUNT_UNITS.test(match[3].toLowerCase())) found.add(`${Number(match[1])}${unitKey(match[3], /\s/.test(match[2]))}`);
  }
  return found;
}

// A price that picks a card: "the $5 one", "the 5 dollar one", "the 1.2k one". Never "budget 5 dollar only" or "below 1k".
const pricePick = /(?:S?\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(k)?|(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:(k)|\s?(?:dollars?|bucks|sgd)))\s?(?:la|lah)?\s?(?:one|ones|de)\b/gi;

/** "5 dollar" fits $5.00-$5.99 or what rounds to $5; "5.41" fits only $5.41; "1.2k" fits $1,150-$1,249.99. */
function priceFits(price: number, text: string) {
  return [...text.matchAll(pricePick)].some((match) => {
    const raw = (match[1] ?? match[3]).replace(/,/g, "");
    const thousands = Boolean(match[2] ?? match[4]);
    const value = Number(raw) * (thousands ? 1000 : 1);
    const step = (thousands ? 1000 : 1) / 10 ** (raw.split(".")[1]?.length ?? 0);
    return (!thousands && step === 1 && Math.floor(price) === value) || Math.abs(price - value) < step / 2;
  });
}

/** A name's words of 4+ letters, singular ("slots" and "slot" count once), without words that say nothing about the product. */
const nameWords = (name: string) => [...new Set((name.toLowerCase().match(/\p{L}{4,}/gu) ?? [])
  .filter((word) => !STOP.has(word))
  .map((word) => (word.length >= 5 ? word.replace(/s$/, "") : word)))];

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
  for (const word of nameWords(card.name)) if (startsAWord(lower, word)) found.add(word);
  const typed = measures(text);
  for (const size of measures(card.name)) if (typed.has(size)) found.add(size);
  if (card.price !== null && priceFits(card.price, text)) found.add("$price");
  return found;
}

/**
 * The cards the text points at: each has hits, and every other card sharing one of those hits has fewer.
 * On a tie, a card in `newest` beats one that isn't.
 */
export function pointedCards(text: string, cards: ShownCard[], newest: ShownCard[] = []) {
  const scored = [...new Map(cards.map((card) => [card.code.toLowerCase(), card])).values()]
    .map((card) => ({ card, hits: hits(card, text), newest: newest.some((item) => same(item.code, card.code)) }));
  return scored.filter((own) => own.hits.size > 0 && scored.every((other) => other === own
    || other.hits.size < own.hits.size
    || ![...other.hits].some((hit) => own.hits.has(hit))
    || (other.hits.size === own.hits.size && own.newest && !other.newest))).map(({ card }) => card);
}

// "$1,220" and "5.41" stay whole. Runs of spaces become one, so the clause patterns below stay fast on long texts.
const clausesOf = (text: string) => text.split(/(?<=[;!?\n，；！？。])|(?<=\D,)|(?<=,)(?!\d)|(?<=\.)(?!\d)/)
  .map((clause) => clause.replace(/\s+/g, " ").trim()).filter(Boolean);
const refusal = /\b(?:no|not|dont|don'?t|dun|didn'?t|never|nvm|forget|cancel|wrong|remove)\b|不要|不用|取消/i;
// "got stock or not" asks and "no rush" is polite; neither turns anything down.
const refuses = (clause: string) => refusal.test(clause.replace(/\bor\s+not\b|\bno\s+(?:rush|hurry|problem|worries)\b/gi, " "));
const isQuestion = (clause: string) => /[?？]|\b(?:or not|anot|meh|har)[\s.,;!]*$/i.test(clause);
const questionStart = /^(?:which|what|whats|wat|where|when|who|how|why|is|are|does|do|can|got|any)\b/i;
// "can" starts a yes as often as a question ("Can u help me do a 50 pcs qoutation for this").
const asksFirst = (clause: string) => questionStart.test(clause) && !/^can\b/i.test(clause);
// "now got 4 inch" asks (exam 2, c12-stress).
const namingHedge = /\b(?:other|others|another|else|cheaper|instead|too|ex|expensive|but|got)\b/i;
const pickVerb = /\b(?:take|add|want|wan|go with|go for|choose|chose|pick|buy|order|get|make it|change to|switch to|confirm|i say|i said|said|i tap)\b|要|拿|买|加/i;
const okStart = /^(?:ok|okay|yes|ya|yah|yeah|sure)\b/i;
const yesHedge = /\b(?:but|other|others|else|another|cheaper|instead|wait|boss|expensive|ex|how about|what about|hmm|or not|anot)\b/i;
const acceptStart = /^\s*(?:(?:aiya|aiyo|haiz|wah|eh|ok(?:ay)?|ya|yes)[\s,!.]+)*(?:ok(?:ay)?|yes|ya|yah|yeah|yep|sure|confirm|go ahead|(?:just\s+)?(?:add|take))\b|^\s*can\s*(?:la|lah|lor|liao|already|alr)?\s*(?:\d+\s*(?:pcs?|units?)?)?[\s.!]*$|^\s*(?:好的|可以|就这个)/i;
const thisOne = /\b(?:this|that|tis|dis|tat|it)\b/i;
const bareQuantity = /^\s*(?:just|only)?\s*(?:x\s*)?\d+\s*(?:pcs?|pieces?|units?|sets?|nos?)?\s*(?:only|la|lah|lor|leh|ah|can|pls|please|thanks)?[\s.!,;]*$/i;
// Owner default (Q4): a bare number is a yes only after Claire asked how many or offered to add.
const askedHowMany = /\bhow many\b|\b(?:quantity|qty)\b|\b(?:want|shall|should|can) (?:me to |i )?add\b|\badd (?:it|this|that|one|the|\d)/i;
const switchWord = /\b(?:change|switch|instead|rather|actually|other one)\b|换/i;

/** The cards each clause of a text points at, worked out once per text. */
type Pointing = Map<PickText, Map<string, ShownCard[]>>;

/** What one customer text says about this card: it picks it, turns it down, or says nothing about it. */
function textVerdict(code: string, quantity: number | null, sent: PickText, recent: boolean, replies: PickReply[], pointing: Pointing): "pick" | "refuse" | null {
  const seenSets = replies.slice(0, sent.seen).map((reply) => reply.cards);
  const seenCards = seenSets.flat();
  const all = clausesOf(sent.text);
  // Questions and refusals never pick.
  const clauses = all.filter((clause) => !refuses(clause) && !isQuestion(clause));
  const pointed = pointing.get(sent) ?? new Map<string, ShownCard[]>();
  pointing.set(sent, pointed);
  const points = (target: string, clause: string) => {
    if (!pointed.has(clause)) pointed.set(clause, pointedCards(clause, seenCards, seenSets.findLast((cards) => cards.length)));
    return pointed.get(clause)!.some((card) => same(card.code, target));
  };
  const typedCode = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(code)}(?![\\p{L}\\p{N}])`, "iu");
  // A typed code picks even in a question ("Can I get 10 pcs of BTS-8026D?").
  if (all.some((clause) => !refuses(clause) && typedCode.test(clause))) return "pick";

  // Naming: a card in the reply just before, from a recent text; otherwise only when the text is picking something
  // or the naming clause itself has a pick word ("i want for cooking" doesn't pick the tong named in another clause).
  const before = replies[sent.seen - 1];
  const picking = (quantity !== null && quantityStated(quantity, [sent.text])) || sent.chip || clauses.some((clause) => okStart.test(clause));
  const nameOk = picking || (recent && before?.cards.some((card) => same(card.code, code)));
  if (clauses.some((clause) => (nameOk || pickVerb.test(clause)) && !questionStart.test(clause) && !namingHedge.test(clause) && points(code, clause))) return "pick";

  // Asked, then shown: "need scrub sponge 2pkt", and the next reply showed one card that clearly matches it.
  const next = replies[sent.seen]?.cards ?? [];
  const shown = next.find((card) => same(card.code, code));
  if (quantity !== null && shown && clauses.some((clause) => {
    if (!quantityStated(quantity, [clause])) return false;
    const mine = hits(shown, clause);
    return (mine.size >= 2 || [...mine].some((hit) => hit === "$price" || /^\d/.test(hit)))
      && next.every((card) => card === shown || ![...hits(card, clause)].some((hit) => mine.has(hit)));
  })) return "pick";

  // A yes to the only card Claire just showed, with no hedge and no other card named.
  if (before?.cards.length === 1 && same(before.cards[0].code, code) && !yesHedge.test(sent.text)
    && !seenCards.some((card) => !same(card.code, code) && clauses.some((clause) => points(card.code, clause)))
    && clauses.some((clause) => acceptStart.test(clause)
      || (quantity !== null && !asksFirst(clause) && quantityStated(quantity, [clause]) && thisOne.test(clause))
      || (bareQuantity.test(clause) && askedHowMany.test(before.text)))) return "pick";

  const own = seenCards.findLast((card) => same(card.code, code));
  // A refusal turns down the cards it names most: "the dinner knife no need" is not about the dinner fork.
  const namesMost = (clause: string) => {
    const mine = own ? hits(own, clause).size : 0;
    return mine > 0 && seenCards.every((card) => hits(card, clause).size <= mine);
  };
  const turnsDown = (clause: string) => refuses(clause) && !isQuestion(clause) && (typedCode.test(clause) || namesMost(clause));
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
 * before Claire showed it, or said yes to it as the only card Claire had just shown.
 * A newer text that turns it down ("knife dont need") ends the walk.
 */
export function customerChose(stockId: string, quantity: number | null, picks: PickEvidence, lineCodes: string[]) {
  return chose(stockId, quantity, picks, lineCodes, new Map());
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
