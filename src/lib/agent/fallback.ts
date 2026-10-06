// src/lib/agent/fallback.ts
import "server-only";
import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import type { AgentReply } from "./contract";
import { enquiryTotals, firstListItem, gstWords, listItemCount } from "./enquiry";
import { liveCheck, retryOnce, withTimeout, type CheckedProduct, type FactDeps } from "./facts";
import type { EnquiryChange } from "./tools";

const FALLBACK_TIMEOUT_MS = 9_000;
const CARDS = 3;
// A customer saying they don't need something is not asking for products.
const declines = /\b(?:no need|don['’]?t need|not needed|nvm|never mind|cancel|no thanks|no thank you|not this)\b|不要|不用/i;
// A follow-up about products already shown, a no, or an enquiry change ("Are there others?", exam 4 c03-A; "this is taiwanese
// knife", "cheaper one", "change the torch to 3"): its words don't say what to show, so no cards are shown for it. "n't" needs its
// apostrophe, so "want" is not a no (r6 skeptic); "dont" and "didnt" are listed.
const FOLLOW_UP = /\b(?:no|not|never|without|other|others|else|besides|except|instead|same|this|that|these|those|cheaper|bigger|smaller|longer|shorter|lighter|better|more|add|change|update|swap|switch|replace|increase|reduce|remove|cancel|delete|minus|keep|take|dun|dont|didnt|doesnt|cant|wont|isnt|arent|havent)\b|n['’]t\b/i;
// A message about Claire asks for no product: "you are a tool" showed leaf tools (review D5+D6). "thank you so much! got crepe
// pan?" is a product question (D5+D6 recheck), and so is "thx u so much, got crepe pan?".
const ABOUT_CLAIRE = /(?<!\b(?:thanks?|thx|ty|tq)\s+)\b(?:you|u)\s+(?:are|r|so)\b|\byou['’]?re\b/i;
// Words that name no product: chat filler, question words, shop talk, Singlish particles, and talk about the chat and the order
// ("I tap already", "link cannot open", "total how much"). Over exams 2-5, the backup's search of the raw text showed cards for
// 60 of 174 sampled texts, most unrelated ("ok": cutlery, "2 pcs": a thermometer, "tap where??": a tapered rolling pin).
const FILLER = new Set(("a an the and or but if so of to in on at by for from with without about as is are am was were be been it its "
  + "there here then than yes ya yah yup ok okay okie can could would should will shall may might must do does did done have has had got get "
  + "i im me my we our us you u ur your yours he she they them their what wat which who why how when where much many most less some any all "
  + "each every both just only also too very really still already alr now today tmr pls please plz thanks thank thx ty tq hi hello hey lah "
  + "la leh lor meh ah ar hor sia one ones anot nvm maybe like want wan wanna need needs looking look find show see sell selling buy sale "
  + "available left price cost recommend recomend suggest best good nice kind type types sort something thing things item items "
  + "product products stuff similar different again around approx per pcs pc piece pieces unit units qty quantity sure know tell told send "
  + "hmm eh oh wah aiyo aiya huh ask asking said say mean don didnt cannot cant nothing everything someone anyone liao oso bro err izzit rite "
  + "right lol haha tap tapped card cards link links photo photos pic pics picture pictures foto sample website web page site pdf listing "
  + "listings enquiry cart checkout add added adding remove removed total gst tax pay payment order deliver collect pickup quote "
  + "invoice call email phone dollar dollars bucks sgd first last next above below under over earlier before after time times dozen dozens "
  + "carton cartons ctn ctns packet packets pkt pkts ll re ve recommendation recommendations").split(" "));
// "Stock" and "delivery" name products ("stock pot", "delivery bag": as filler words they showed a chilli pot and canvas bags,
// review D5+D6), so only shop talk about them goes: "in stock", "got stock?", "stock left", "can delivery?". "got delivery bag?"
// asks for a delivery bag, not any bag (D5+D6 recheck).
const SHOP_TALK = /\b(?:in|got|any|have|has|no|many|enough|can|out\s+of)\s+(?:stock|delivery)\b(?!\s+(?:pots?|bags?|box(?:es)?)\b)|\b(?:stock|delivery)\s+(?:left|available|status|count|charges?|fees?)\b/gi;
// Words about a product's use or grade that names rarely carry ("commercial", "home", "cheap", "big"): a card needn't carry them,
// and a message made only of them names nothing. Kind words (electric, gas, stainless) still count.
const DESCRIBING = new Set(("commercial home household domestic restaurant cafe heavy duty industrial professional handheld big small large "
  + "mini medium cheap premium new normal standard basic simple fine full set sets fresh use black white red blue green grey gray yellow "
  + "pink brown shop shops stall stalls hawker outlet outlets zichar").split(" "));

/** A word without its plural ending: "knives" is "knife", "glasses" "glass", "pans" "pan". */
const stem = (word: string) => word
  .replace(/ives$/, "ife").replace(/(?<=[^aeiou])ies$/, "y").replace(/(?<=ss|sh|ch|x|z)es$/, "").replace(/(?<=^.{2,}[^sui])s$/, "");
/** A text's words as the catalogue writes them: lower case, "S/S" as stainless steel, "12 QT" as 12qt, "8.0oz" as 8oz. */
const words = (text: string) => text.toLowerCase().replace(/\bs\/s\b/g, "stainless steel").replace(/ø/g, " ")
  .replace(/(\d)\s+(oz|qt|l|ltr|ml|cm|mm|in|inch)\b/g, "$1$2").replace(/(\d)\.0(?!\d)/g, "$1")
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// A bare number or a count ("4", "3pcs", "x2") is a quantity, not a product word; a size ("24cm") names the product.
const meaningful = (word: string) => word.length >= 2 && !/^(?:x?\d+|\d+(?:pcs?|units?|sets?|ctns?|pkts?|x))$/.test(word) && !FILLER.has(word);

/** What the customer asked for: their own words once filler and quantities go ("prata pan maybe" is "prata pan"). */
export function askedItem(text: string) {
  // A size typed with a space keeps its number ("24 cm" is 24cm, review D5+D6); "3 in 1" and "2 in stock" hold no size in inches.
  const sized = text.replace(SHOP_TALK, " ").replace(/(\d)\s+(oz|qt|l|ltr|ml|cm|mm|inch)\b/gi, "$1$2");
  const kept = sized.split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((word) => words(word).some(meaningful));
  const naming = kept.flatMap(words).filter((word) => meaningful(word) && !DESCRIBING.has(word)).map(stem);
  return { label: kept.join(" "), naming };
}

/**
 * A product's name and code words, and its brand's only when the customer typed all of the brand: "chef knives" is no Atlantic Chef
 * oyster opener (runs-new2 c01-A #12), while "Atlantic Chef Chef Knife" is still a chef knife.
 */
function productWords(item: Product, naming: string[]) {
  const brand = words(item.brand ?? "").map(stem);
  const name = words(item.name).map(stem);
  const typed = brand.length > 0 && brand.every((word) => naming.includes(word));
  const at = name.findIndex((_, start) => brand.every((word, index) => name[start + index] === word));
  const own = at < 0 ? name : [...name.slice(0, at), ...name.slice(at + brand.length)];
  return [...own, ...(typed ? brand : []), ...words(item.stock_id).map(stem)];
}
/**
 * What kind of product it is: the last word of each part of its category ("Plates and platters", "Kitchen blenders/mixers") and of
 * its name before a comma, bracket, size, "for" or "with" ("Royal Bali Celadon Broken Tall Bowl" is a bowl, "Complete Bowl For
 * Brushless Blender" a bowl, "Deep Fryer W/Tap" a fryer).
 */
const kinds = (item: Product) => [
  ...(item.third_category ?? item.subcategory ?? "").split(/,|\/|\band\b/i),
  item.name.split(/[,(]|\s(?:for|with)\s|\sw\/|\s\d/i)[0],
].map((part) => words(part).filter((word) => !/\d/.test(word)).at(-1) ?? "").filter(Boolean).map(stem);
/** The same word, or one inside a compound ("torch" in "blowtorch"); "time" is not in "timer", nor "pan" in "panasonic". */
const fits = (word: string, own: string) => own === word
  || (Math.min(own.length, word.length) >= 4 && Math.abs(own.length - word.length) >= 4 && (own.includes(word) || word.includes(own)));
/**
 * A product carrying every word naming what the customer asked for, one of them saying what kind of product it is: "prata pan" is
 * not a melamine GN pan (owner, 2026-09-30), and "You are broken" is not a Celadon Broken Tall Bowl.
 */
export const relevantTo = (naming: string[]) => (item: Product) => {
  const own = productWords(item, naming);
  return naming.length > 0 && naming.every((word) => own.some((part) => fits(word, part)))
    && naming.some((word) => kinds(item).some((kind) => fits(word, kind)));
};

/** The enquiry changes this turn made, in the enquiry's own words, or null when none. */
function changeLine(changes: EnquiryChange[], lines: EnquiryReceiptLine[], seen: ReadonlyMap<string, CheckedProduct>) {
  const said = [...new Set(changes.map((change) => {
    if (change.action === "clear") return "Your enquiry is cleared.";
    const line = lines.find((item) => item.code.toLowerCase() === (change.code ?? "").toLowerCase());
    if (change.action === "remove") return line ? "" : `${seen.get(change.code ?? "")?.product.name ?? change.code} is off your enquiry.`;
    return line ? `${line.quantity} ${line.uom.trim()} ${line.item} (${line.code}) is on your enquiry.` : "";
  }))].filter(Boolean);
  return said.length ? `Done: ${said.join(" ")} Anything else?` : null;
}

const SALES = "Sia Huat sales can also help (details below).";

/**
 * Used when Claude is unavailable, runs out of time, or its reply fails the guards twice. It never says the system has trouble
 * (owner, 2026-09-30: "when the AI gives up so easily it looks like the system is broken"): it says what this turn changed, shows
 * cards this turn already found for what the customer asked (else one search of their words), shows only cards that
 * fit it, and otherwise asks for more detail or to send it again. Search and live checks together stay within timeoutMs.
 */
export async function buildFallbackReply(input: {
  searchText: string | null; lines: EnquiryReceiptLine[]; deps: FactDeps; timeoutMs?: number;
  seen?: ReadonlyMap<string, CheckedProduct>; changes?: EnquiryChange[]; thanks?: boolean; event?: "text" | "tap" | "photo";
}): Promise<AgentReply> {
  const timeoutMs = input.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  const started = performance.now();
  const text = input.searchText?.trim() ?? "";
  // Read before any wait: the turn may still be changing after the cut.
  const changed = changeLine(input.changes ?? [], input.lines, input.seen ?? new Map());
  // A pasted list asks first for its first item (exam 3, s01-B T0: its first 80 characters found a can opener and pot lids).
  const first = (firstListItem(text) || text).slice(0, 80); // "1) 2) pot" has an empty first item
  // "got blow torch or not?" asks about a blow torch, and "or not" is no follow-up.
  const asking = first.replace(/\s*\bor\s+not(?:\s+(?:ah|ar|leh|lah|la|hor|meh))?\b[\s?!.]*$/i, "");
  const asked = askedItem(declines.test(text) || gstWords.test(text) || FOLLOW_UP.test(asking) || ABOUT_CLAIRE.test(text) ? "" : asking);
  const relevant = relevantTo(asked.naming);
  const known = [...(input.seen?.values() ?? [])];
  // This turn's lookups and the enquiry's re-check first (verified ones first): no search to wait for (the owner's prata turn had
  // run out of time).
  let cards = known.filter((item) => relevant(item.product)).sort((a, b) => Number(b.verified) - Number(a.verified)).map((item) => item.product).slice(0, CARDS);
  let found = known.map((item) => item.product);
  // No cards go with the Done line, so none are searched for.
  if (!changed && !cards.length && asked.naming.length) {
    try {
      const hits = await withTimeout(retryOnce(() => input.deps.searchDirect(asked.label, 10)), timeoutMs, null);
      found = [...found, ...(hits ?? [])];
      const left = Math.floor(timeoutMs - (performance.now() - started));
      // If the search used up the time, skip the live checks and show no cards.
      if (hits && left > 0) cards = (await Promise.all(hits.filter(relevant).slice(0, CARDS).map((item) => liveCheck(item, input.deps, left)))).filter((item) => !item.gone).map((item) => item.product);
    } catch {
      cards = [];
    }
  }
  // A short message naming a kind of product we carry ("prata pan maybe": pans) gets asked for detail; a longer one, or one naming
  // no kind ("sohai", "You are broken"), gets the plain line.
  const itemAsk = text.split(/\s+/).length <= 6 && asked.naming.some((word) => found.some((item) => kinds(item).some((kind) => fits(word, kind))));
  // Named back only as the customer wrote it, and never a describing word the cards needn't carry ("cheap") or a reordered phrase.
  const echo = asked.label && text.toLowerCase().includes(asked.label.toLowerCase()) && !words(asked.label).some((word) => DESCRIBING.has(word)) ? asked.label : "";
  const list = listItemCount(text) >= 2;
  const place = /\b(?:home|house|shop|restaurant|cafe|commercial|stall|hawker|outlet|zi\s?char)\b/i.test(text);
  const itemQuestion = [place ? "" : "is it for home or a shop", /\d/.test(text) ? "" : "roughly what size do you need"].filter(Boolean).join(", and ");
  const message = changed ?? (input.thanks ? "You're welcome! Anything else I can help with?"
    : cards.length && list ? `Here's what I found for your first item${echo ? `, '${echo}'` : ""}. Could you send the others again, a few at a time?`
    : cards.length ? `Here's what I found${echo ? ` for '${echo}'` : ""}. Want one of these, or something more specific?`
    : list ? `Sorry, I couldn't go through your list just now. Could you send it again, a few items at a time? ${SALES}`
    // No claim about the catalogue: this fires exactly when we carry that kind of product but no card fit every word.
    : itemAsk ? `Sorry, I don't have a clear match to show you yet. ${itemQuestion ? `${itemQuestion[0].toUpperCase()}${itemQuestion.slice(1)}?` : "Could you tell me a bit more about it?"} ${SALES}`
    : input.event === "tap" ? `Sorry, I couldn't open that one just now. Could you tap it again? ${SALES}`
    : input.event === "photo" ? `Sorry, I couldn't check your photo just now. Could you send it again, or tell me what the item is? ${SALES}`
    : `Sorry, I couldn't answer that one just now. Could you send it again, with a bit more detail if you can? ${SALES}`);
  return {
    message,
    cards: changed ? [] : cards,
    chips: [],
    enquiry: { lines: input.lines, totals: enquiryTotals(input.lines) },
    showContact: !changed && !input.thanks,
    provider: "fallback",
  };
}
