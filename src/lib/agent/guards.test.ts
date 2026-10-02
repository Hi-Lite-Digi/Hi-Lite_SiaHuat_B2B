// src/lib/agent/guards.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import type { ShownCard } from "./contract";
import type { CheckedProduct } from "./facts";
import {
  BROKEN_LINK_ISSUE, CLAIM_ISSUE_PREFIX, DANGLING_CURRENCY_ISSUE, ENQUIRY_CLAIM_PREFIX, KEPT_LINE_PREFIX, LINK_BLAME_ISSUE, LINK_ISSUE_PREFIX, MID_SENTENCE_ISSUE, MONEY_ISSUE_PREFIX, NO_CARD_PREFIX, NO_PERMISSION_ISSUE,
  NO_SHOW_PERMISSION_ISSUE, PHOTO_AGAIN_ISSUE, PROMISE_LATER_ISSUE, RESERVATION_ISSUE, allowedCents, applyFixers, askedForChange, brokenLinkCodes, customerMessage, deniedRange, dropRepeatedPitch, endsMidSentence, enquiryClaimIssues, issueCode,
  keptLineClaims, noCardFixer, permissionCodes, removeAmounts, removeClaims, removeLinks, reviewAnswer, stockIssues, tidyMessage, unverifiedAmounts, withoutCardPointers, withoutChangedCards, withoutEnquiryClaims, withoutKeptLineClaims, withoutRepeatedCloser,
  withoutRepeatedSet, withoutWrongStockCounts, wrongStockCounts, type EarlierTurns, type FinalAnswer, type TurnFacts,
} from "./guards";
import { product } from "./testing";
import type { EnquiryChange, SearchRecord } from "./tools";

const seen = new Map<string, CheckedProduct>([
  ["BTS-8026D", { product: product({ stock_id: "BTS-8026D", list_price: 23.36 }), verified: true }],
  ["OLD", { product: product({ stock_id: "OLD", list_price: 99 }), verified: false }],
]);
const lines = [{ item: "Torch", code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
const allowed = allowedCents(seen, lines, 46.72);

test("cards must come from this turn's tool results", () => {
  const review = reviewAnswer({ message: "Here you go.", card_ids: ["BTS-8026D", "FAKE"], chips: [], show_contact: false }, seen, allowed);
  assert.deepEqual(review.cards.map((card) => card.stock_id), ["BTS-8026D"]);
  assert.match(review.safety.join(" "), /not found: FAKE/);
  assert.match(review.safety.join(" "), /or shown earlier in this chat/);
});

test("only live-checked prices and enquiry totals may appear as amounts", () => {
  assert.deepEqual(unverifiedAmounts("Noted: 2 torches, $46.72 ($23.36 each).", allowed), []);
  assert.deepEqual(unverifiedAmounts("That one is $99 and delivery is $15.", allowed), ["$99", "$15"]);
  assert.equal(removeAmounts("It's $99 now.", ["$99"]), "It's the listed price now.");
});

test("code's GST estimates may appear as amounts: a live-checked price and the enquiry total with GST, and the total's GST part", () => {
  // Owner decision 2. Allowed whether or not the customer's words asked: "ok so final total how much ah, i tell boss", two turns after
  // an estimate, had its right figure repaired away in 3 of 3 runs when the allowance waited on GST words.
  assert.deepEqual(unverifiedAmounts("About $50.92 with GST (GST $4.20); the checkout or Sia Huat's quote shows the exact amount.", allowed), []);
  assert.deepEqual(unverifiedAmounts("About $25.46 each with GST.", allowed), []);
  // A cent off, and the unchecked $99 with GST, are not code's figures.
  assert.deepEqual(unverifiedAmounts("About $50.93 with GST.", allowed), ["$50.93"]);
  assert.deepEqual(unverifiedAmounts("That one is about $107.91 with GST.", allowed), ["$107.91"]);
});

test("while a line is unchecked, no total with GST is allowed, but a price with GST is", () => {
  // The total leaves the unchecked line out, so its figure with GST would be for part of the enquiry (2 of 3 GST replay drafts did).
  const partial = allowedCents(seen, lines, 46.72, false);
  assert.deepEqual(unverifiedAmounts("About $50.92 with GST (GST $4.20), $25.46 each.", partial), ["$50.92", "$4.20"]);
});

test("a GST sum is not an enquiry claim", () => {
  const facts = { lines, changes: [], seen };
  assert.deepEqual(enquiryClaimIssues("Adding 9% GST, it comes to about $50.92.", facts), []);
});

test("amounts in SGD, dollars and 元 are checked like $ amounts", () => {
  for (const text of ["S$46.72", "SGD 23.36", "46.72 dollars", "23.36元"]) assert.deepEqual(unverifiedAmounts(text, allowed), [], text);
  for (const text of ["SGD 50.00", "50 dollars", "50元", "新币 50"]) assert.deepEqual(unverifiedAmounts(text, allowed), [text], text);
  assert.equal(removeAmounts("That's SGD 50.00 now.", ["SGD 50.00"]), "That's the listed price now.");
});

test("removing an amount leaves longer amounts that start with it intact", () => {
  assert.equal(removeAmounts("Was $23, now $23.36.", ["$23"]), "Was the listed price, now $23.36.");
  assert.equal(removeAmounts("It's $9 or $99.", ["$9"]), "It's the listed price or $99.");
});

test("an unverified amount in the message is a safety issue", () => {
  const review = reviewAnswer({ message: "That one is $99, the other $23.36.", card_ids: [], chips: [], show_contact: false }, seen, allowed);
  assert.equal(review.safety.filter((issue) => issue.startsWith(MONEY_ISSUE_PREFIX)).length, 1);
  assert.match(review.safety.join(" "), /\$99/);
  assert.doesNotMatch(review.safety.join(" "), /\$23\.36/);
});

test("applyFixers removes what code can fix and leaves the rest", () => {
  const review = reviewAnswer({ message: "That one is $99.", card_ids: ["FAKE"], chips: [], show_contact: false }, seen, allowed);
  const fixers = [{ prefix: MONEY_ISSUE_PREFIX, fix: (message: string) => removeAmounts(message, unverifiedAmounts(message, allowed)) }];
  const fixed = applyFixers("That one is $99.", review.safety, fixers);
  assert.equal(fixed.message, "That one is the listed price.");
  assert.equal(fixed.left.length, 1);
  assert.match(fixed.left[0], /not found: FAKE/);
  assert.deepEqual(applyFixers("Here you go.", [], fixers), { message: "Here you go.", left: [] });
});

test("each review issue has a log code", () => {
  const codes = (answer: Partial<FinalAnswer>, earlier?: EarlierTurns) => {
    const review = reviewAnswer({ message: "", card_ids: [], chips: [], show_contact: false, ...answer }, seen, allowed, earlier);
    return [...review.safety, ...review.style].map(issueCode);
  };
  assert.deepEqual(codes({ message: "That one is $99.", card_ids: ["FAKE"] }), ["UNKNOWN_CARD", "MONEY"]);
  assert.deepEqual(codes({ message: "Noted. We don't carry a boxed" }), ["STYLE", "MID_SENTENCE"]);
  assert.deepEqual(codes({ message: "197-55 is $ - let me confirm." }), ["DANGLING_CURRENCY"]);
  assert.deepEqual(codes({ message: "Your order is confirmed." }), ["STYLE"]);
  assert.deepEqual(codes({ message: "Which size?", card_ids: ["BTS-8026D"] }, { cardSets: [["BTS-8026D"], ["BTS-8026D"]], previousMessage: "Which size?", currentText: "hmm" }), ["REPEAT", "REPEAT"]);
});

test("chips with numbers or amounts, long chips and chips past the third are dropped, not raised", () => {
  const review = (chips: string[]) => reviewAnswer({ message: "Which one would you like?", card_ids: [], chips, show_contact: false }, seen, allowed);
  // A chip dropped for a number takes the rest of its set along (exam 3: a lone chip under an either/or question).
  for (const chip of ["2", "5 pcs", "two", "两个", "Yes, $99 one"]) {
    const result = review([chip, "Cooking"]);
    assert.deepEqual(result.chips, [], chip);
    assert.deepEqual([...result.safety, ...result.style], [], chip);
  }
  assert.deepEqual(review(["9 inch", "16 inch", "with silicone grip"]).chips, []);
  assert.deepEqual(review(["Kitchen use", "Serving"]).chips, ["Kitchen use", "Serving"]);
  // A chip dropped for its length doesn't clear the set, even with a number in it.
  assert.deepEqual(review(["A chip that is far too long to fit on one button"]).chips, []);
  assert.deepEqual(review(["A chip that is far too long to fit on 1 button", "Cooking"]).chips, ["Cooking"]);
  assert.deepEqual(review(["Cooking", "Desserts", "Grilling", "Bar"]).chips, ["Cooking", "Desserts", "Grilling"]);
  // A number chip clears the set only when it would have taken one of the three visible slots.
  assert.deepEqual(review(["Cooking", "Desserts", "Grilling", "2 pcs"]).chips, ["Cooking", "Desserts", "Grilling"]);
  // A dropped 'add' chip moves a fourth chip into view: it shows when clean, and clears the set when it has a number.
  assert.deepEqual(review(["Yes, add it", "Cooking", "Desserts", "Grilling"]).chips, ["Cooking", "Desserts", "Grilling"]);
  assert.deepEqual(review(["Yes, add it", "Without grip", "With grip", "With 2 grips"]).chips, []);
  // An 'add' chip never shows, so a number in it leaves the rest, as 'Yes, add it' does.
  assert.deepEqual(review(["Yes, add 2", "Show others"]).chips, ["Show others"]);
});

test("reply-style problems are style issues, not safety issues", () => {
  const review = reviewAnswer({ message: "Noted: 2 torches.", card_ids: [], chips: [], show_contact: false }, seen, allowed);
  assert.deepEqual(review.safety, []);
  assert.match(review.style.join(" "), /plain, friendly customer language/);
});

test("the light clean-up swaps a leading Noted and drops JSON field names", () => {
  assert.equal(tidyMessage("Noted: 2 torches."), "Got it: 2 torches.");
  assert.equal(tidyMessage("Noted, adding them now."), "Got it, adding them now.");
  assert.equal(tidyMessage("I set show_contact so you can reach sales. card_ids below."), "I set so you can reach sales. below.");
});

const styleOf = (message: string) => reviewAnswer({ message, card_ids: [], chips: [], show_contact: false }, seen, allowed).style;

test("a reply that stops mid-sentence is a style issue", () => {
  for (const message of [
    "Congrats on the new place! We don't carry a boxed",
    "For that",
    "Here's the Rooster Series Round Plate 6",
    "Those are single pieces, so a",
    "4 x UT16HR at $5.69 each. If you can just say",
  ]) {
    assert.equal(endsMidSentence(message), true, message);
    assert.ok(styleOf(message).includes(MID_SENTENCE_ISSUE), message);
  }
});

test("normal endings are not mid-sentence", () => {
  for (const message of [
    "Here you go.", "Sure 👍", "OK 👌🏻", "Thanks 👨‍🍳", "好的，已加入。", "好的", "Total: $22.76", "Got it. Total: SGD 22.76",
    "Link: https://store.siahuat.com/product/1", "Options:\n- A, $5\n- B, $6", "(ex GST)", "Yes, the 18″", "See you ~", `the 16" one"`,
    "好的，价格是 $16.97（不含消费税）", "推荐「不锈钢汤锅」", "Photos are on its page: store.siahuat.com",
  ]) {
    assert.equal(endsMidSentence(message), false, message);
    assert.ok(!styleOf(message).includes(MID_SENTENCE_ISSUE), message);
  }
});

test("a bare $ is a style issue; prices and SGD words are not", () => {
  assert.ok(styleOf("197-55 is $ - let me confirm that one.").includes(DANGLING_CURRENCY_ISSUE));
  for (const message of ["$16.97", "S$ 16.97", "SGD 16.97", "16.97 SGD", "All prices are in SGD, ex GST.", "US$5", "新币16"]) {
    assert.ok(!styleOf(message).includes(DANGLING_CURRENCY_ISSUE), message);
  }
});

test("tidyMessage drops an unfinished last sentence and a sentence with a bare $", () => {
  assert.equal(tidyMessage("Congrats on the new place! We don't carry a boxed"), "Congrats on the new place!");
  assert.equal(tidyMessage("For that"), "For that");
  assert.equal(tidyMessage("It's $5.69 and the"), "It's $5.69 and the");
  assert.equal(tidyMessage("Checked. 197-55 is $ - let me confirm."), "Checked.");
  assert.equal(tidyMessage("Done! 2 torches added"), "Done!"); // a rare loss: the unfinished-looking line was complete
  // The link fixer's store address at the end is a proper ending.
  const madeUp = "Sorry about that. Photos are on its page: https://store.siahuat.com/product/999999";
  assert.equal(tidyMessage(removeLinks(madeUp, [madeUp.slice(madeUp.indexOf("https"))])), "Sorry about that. Photos are on its page: store.siahuat.com");
});

test("a card set already shown twice is flagged unless the customer asks for it again", () => {
  const answer = { message: "The Safico one is lighter.", card_ids: ["BTS-8026D"], chips: [], show_contact: false };
  const earlier = { cardSets: [["BTS-8026D"], ["OLD", "BTS-8026D"], ["bts-8026d"]], previousMessage: "Here you go.", currentText: "any others?" };
  // The repair runs with tools off, so it can't show different options.
  assert.match(reviewAnswer(answer, seen, allowed, earlier).style.join(" "), /You've already shown this same set of cards twice\. Don't attach the whole set again \(you can name them, and attach only the one you recommend\)\. Answer what the customer just said, recommend one if they are choosing, and don't ask again a question you already asked\./);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, currentText: "show me those again" }).style, []);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, cardSets: [["BTS-8026D"], ["OLD", "BTS-8026D"]] }).style, []);
});

test("a card update_enquiry refused is not a repeat; a question naming the one card no longer exempts it", () => {
  // exam 3, c08-persona T8: the confirm card had been shown alone twice, REPEAT stripped it, and the next "yes" had no card to point at.
  // Since round 5 the pick check reads the chat, so a yes or a number no longer needs the card on screen.
  const scissors = new Map<string, CheckedProduct>([
    ["E910076", { product: product({ stock_id: "E910076", name: "Zyliss Stainless Steel Household Scissors", list_price: 29.27 }), verified: true }],
    ["E910077", { product: product({ stock_id: "E910077", name: "Zyliss Polypropylene Basic Household Scissors Basic, Gray", list_price: 22.84 }), verified: true }],
    ["BTS-8026D", { product: product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", list_price: 23.36 }), verified: true }],
  ]);
  const repeats = (message: string, card_ids: string[], turn: Partial<TurnFacts> = {}) => reviewAnswer(
    { message, card_ids, chips: [], show_contact: false }, scissors, allowed, { cardSets: [card_ids, card_ids], previousMessage: null, currentText: "hmm" }, turn,
  ).style.some((issue) => issueCode(issue) === "REPEAT");
  assert.equal(repeats("This one is stainless steel.", ["E910076"]), true);
  assert.equal(repeats("This one is stainless steel.", ["E910076"], { refused: ["e910076"] }), false);
  // exam 4: 8 of 14 same-set third showings were re-attached to "Just to confirm?", "Want me to add it?" or "How many?".
  assert.equal(repeats("Is it the Zyliss E910076?", ["E910076"]), true);
  assert.equal(repeats("You mean the Zyliss scissors? How many do you need?", ["E910076"]), true);
  assert.equal(repeats("Is it the Zyliss E910076?", ["E910076"], { refused: ["E910076"] }), false);
  assert.equal(repeats("The Zyliss scissors are in stock. How many do you need?", ["E910076"]), true);
  assert.equal(repeats("Here are the Zyliss scissors again.", ["E910076"]), true);
  // A generic closer doesn't need the card.
  assert.equal(repeats("Here are the Zyliss scissors again. Need anything else?", ["E910076"]), true);
  assert.equal(repeats("Which one would you like?", ["E910076", "E910077", "BTS-8026D"]), true);
});

test("repeating the previous message word for word is flagged", () => {
  const answer = { message: "Which size do you need?", card_ids: [], chips: [], show_contact: false };
  const earlier = { cardSets: [], previousMessage: "which size do you need", currentText: "not sure" };
  assert.deepEqual(reviewAnswer(answer, seen, allowed, earlier).style, ["Don't repeat your previous message word for word; move the conversation forward."]);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, previousMessage: "What will you use it for?" }).style, []);
});

test("the same closing offer two replies running is flagged; a new offer, a new product, a generic closer, a plain yes or a card tap is not", () => {
  const offerBefore = "For 4 pax, the Rooster Series Round Plate 6in and Deep Bowl 5in would work. Want me to add 4 of each to your enquiry?";
  const offerAgain = "You're right - everything is sold as individual pieces. The Rooster plate and bowl work well together. Want me to add 4 of each?";
  const offers = (message: string, currentText: string, previousMessage = offerBefore, cardSets: string[][] = [[]], card_ids: string[] = []) => reviewAnswer(
    { message, card_ids, chips: [], show_contact: false }, seen, allowed, { cardSets, previousMessage, currentText },
  ).style.filter((issue) => issueCode(issue) === "OFFER");
  const pushback = "These are not sets these are individual plates";
  const flagged = offers(offerAgain, pushback);
  assert.equal(flagged.length, 1);
  assert.ok(flagged[0].includes('the same offer ("Want me to add 4 of each to your enquiry?")'));
  assert.match(flagged[0], /Tools are off/);
  assert.deepEqual(offers("Got it, they're individual pieces. Want me to show the cutlery sets instead?", pushback), []);
  assert.deepEqual(offers("Got it, they're individual pieces. Anything else?", pushback), []);
  assert.deepEqual(offers(offerAgain, ""), []);
  assert.deepEqual(offers(offerAgain, "ok"), []);
  const goWith = "Want to go with that instead?";
  assert.equal(offers(`This one is lighter. ${goWith}`, "hmm", `That one is cheaper. ${goWith}`, [["OLD"]], ["OLD"]).length, 1);
  assert.deepEqual(offers(`This one is lighter. ${goWith}`, "hmm", `That one is cheaper. ${goWith}`, [["OLD"]], ["BTS-8026D"]), []);
  for (const yes of ["Yes, add it", "ok can", "yes pls add"]) assert.deepEqual(offers(offerAgain, yes), [], yes);
  // A generic closer is not an offer, wherever "anything else" sits in it.
  const review = "Your enquiry is still open - want to review or add anything else?";
  assert.deepEqual(offers(review, "really dun have?", review), []);
  const addMore = "Noted: 2 Safico torches, $46.72. Would you like to add anything else?";
  assert.deepEqual(offers(addMore, "hmm", addMore), []);
  // An enquiry change this turn means the customer took the offer up.
  const askCups = "Noted: 6 bowls, $30.00. How many cups would you like?";
  const offersAfterChange = reviewAnswer({ message: askCups, card_ids: [], chips: [], show_contact: false }, seen, allowed,
    { cardSets: [[]], previousMessage: "How many bowls would you like?", currentText: "6" }, { changes: [{ action: "add", code: "BTS-8026D" }] });
  assert.deepEqual(offersAfterChange.style.filter((issue) => issueCode(issue) === "OFFER"), []);
  assert.equal(offers(askCups, "6", "How many bowls would you like?").length, 1);
});

test("asking for the photo again a second time is flagged", () => {
  const earlier = { cardSets: [], previousMessage: "I don't see a photo attached - could you resend it?", currentText: "What product is this?" };
  const style = (message: string) => reviewAnswer({ message, card_ids: [], chips: [], show_contact: false }, seen, allowed, earlier).style;
  assert.deepEqual(style("I'm not seeing a photo come through on my end. Could you try sending it again?"), [PHOTO_AGAIN_ISSUE]);
  assert.deepEqual(style("Still nothing here. What does it look like, and what is it used for?"), []);
  // The photo arriving after one resend is not a second ask.
  assert.deepEqual(style("Thanks, the photo came through. It looks like a cassette gas torch."), []);
  assert.deepEqual(style("Thanks for resending the photo! It looks like a cassette gas torch."), []);
  assert.deepEqual(style("Sorry, could you resend it?"), [PHOTO_AGAIN_ISSUE]);
  assert.equal(issueCode(PHOTO_AGAIN_ISSUE), "REPEAT");
  // D7 review: two catalogue outages in a row ask to resend the request, not a photo.
  const outage = { ...earlier, previousMessage: "Sorry, I couldn't check that just now. Could you resend your request, maybe with the size?" };
  const outageStyle = reviewAnswer({ message: "Sorry, I couldn't check that just now. Could you try sending that again, with the length you need?", card_ids: [], chips: [], show_contact: true }, seen, allowed, outage).style;
  assert.deepEqual(outageStyle, []);
});

test("a repeated sales pitch is dropped unless the customer asked for contact, a quote or only said thanks", () => {
  const earlier = (currentText: string): EarlierTurns => ({
    cardSets: [], previousMessage: "Your enquiry is saved. Contact Sia Huat sales with the PDF to confirm ordering and delivery.", currentText,
  });
  const message = "Yes, each product's store page has Add to Cart. You can contact Sia Huat sales with the PDF.";
  const answered = "Yes, each product's store page has Add to Cart.";
  assert.equal(dropRepeatedPitch(message, earlier("then online can buy or not?"), true), answered);
  assert.equal(dropRepeatedPitch(message, earlier("only must call sales meh"), true), answered);
  for (const text of [
    "whats ur phone number", "can i speak to someone", "Can u help me do a 50 pcs qoutation", "Ok thanks", "can I get a quote for 50 pcs?", "cant u just get someone call me",
    "i want to talk to a real person", "ok bowl i call ur sales la", "ok that's all. how do i order?", "ya la add. then how i pay", "ok thanks bye",
    // The loop's thank-you turns (exam 3, s01-B T3) are thanks here too.
    "thank u", "ok thank u", "tysm",
    // Asking what to do next is asking for the route (r4 c08-stress idx 13).
    "ok whatever. so now how, u send my order to them or i must do wat", "how to confirm order", "send me the list",
  ]) {
    assert.equal(dropRepeatedPitch(message, earlier(text), true), message, text);
  }
  assert.equal(dropRepeatedPitch(message, earlier("so now how much"), true), answered);
  // The client sends back the text after this drop, so a pitch two replies back still counts.
  const twoBack = { ...earlier("then online can buy or not?"), previousMessage: "Sorry for the confusion.", replies: [earlier("").previousMessage!, "Sorry for the confusion."] };
  assert.equal(dropRepeatedPitch(message, twoBack, true), answered);
  // A sentence that also says what Claire can't do is kept: it may be the answer.
  const limited = "Your 50 pcs are set in the enquiry. I can't confirm delivery timing here - please contact Sia Huat sales directly with this enquiry.";
  assert.equal(dropRepeatedPitch(limited, earlier("Please i need it asap"), true), limited);
  const pitchOnly = "You can contact Sia Huat sales with the PDF.";
  assert.equal(dropRepeatedPitch(pitchOnly, earlier("then online can buy or not?"), true), pitchOnly);
  // Without the contact block the pitch is the only pointer to sales; a first pitch is always kept.
  assert.equal(dropRepeatedPitch(message, earlier("then online can buy or not?"), false), message);
  assert.equal(dropRepeatedPitch(message, { ...earlier("then online can buy or not?"), previousMessage: "Here are two torches." }, true), message);
});

test("a sales pointer that apologises, or says for the first time or on request what sales can do, is kept (exam 3)", () => {
  const pitched = "Your enquiry is saved. You can contact Sia Huat sales with the PDF.";
  const earlier = (currentText: string, replies: string[] = [pitched]): EarlierTurns => ({ cardSets: [], previousMessage: replies.at(-1) ?? null, replies, currentText });
  // exam 3, c05-stress: an apology is never dropped with the pointer it carries.
  const sorry = "Sorry about the mix-ups earlier - you can reach Sia Huat sales directly if you'd like a person. The prices shown are ex-GST.";
  assert.equal(dropRepeatedPitch(sorry, earlier("no sorry also ah"), true), sorry);
  for (const opening of ["My apologies", "Apologies for the trouble"]) {
    const apology = `${opening} - you can reach Sia Huat sales directly if you'd like a person. The prices shown are ex-GST.`;
    assert.equal(dropRepeatedPitch(apology, earlier("wah so slow"), true), apology, opening);
  }
  // Asked if she's a bot, the real people to reach are half the answer (V15 prompt bullet; exam 3, c02-stress T14).
  const bot = "I'm Claire, Sia Huat's automated assistant (an AI), not a person. You can reach Sia Huat sales directly - they're real people.";
  for (const text of ["are you a bot?", "wah still never answer me. bot or human??", "u AI ah", "is this AI?", "u bot is it. i wan talk to real person"]) {
    assert.equal(dropRepeatedPitch(bot, earlier(text), true), bot, text);
  }
  // "ai" is also Hokkien for "want": these ask nothing about Claire, so the repeated pointer goes.
  for (const text of ["wa ai 2 pcs leh", "ok i ai the black one"]) {
    assert.equal(dropRepeatedPitch(bot, earlier(text), true), "I'm Claire, Sia Huat's automated assistant (an AI), not a person.", text);
  }
  // exam 3, s03-B T2: the first sourcing pointer was dropped, leaving "send them a photo" with no one to send it to.
  const t1 = "Could you describe or send a photo of the unit you mean? That'll help me search further, or you can check with Sia Huat sales directly.";
  const t2 = "I searched again but we don't list an automatic rice portioning machine. You can check with Sia Huat sales directly - they can advise if it's something we can source. You could also send them a photo of the exact unit you mean.";
  assert.equal(dropRepeatedPitch(t2, earlier("The one that portion out cooked rice, can choose half, full, extra", [t1]), true), t2);
  // A lone pointer is never emptied out, whatever the rule.
  const leadTime = "You can check with Sia Huat sales directly on lead time.";
  assert.equal(dropRepeatedPitch(leadTime, earlier("Can check for me price and lead time?", [t1, t2]), true), leadTime);
  assert.equal(dropRepeatedPitch(leadTime, earlier("Can check for me price and lead time?", [t1, `${t2} Sia Huat sales can also tell you the lead time.`]), true), leadTime);
  // Asked about a topic, the pointer on it is the answer, even when an earlier reply named it (s03-B T3); unasked, it's a repeat.
  const named = [t1, `${t2} You can check with Sia Huat sales on lead time.`];
  const leadAgain = `It's not in our catalogue. ${leadTime}`;
  assert.equal(dropRepeatedPitch(leadAgain, earlier("Can check for me price and lead time?", named), true), leadAgain);
  assert.equal(dropRepeatedPitch(leadAgain, earlier("hmm ok", named), true), "It's not in our catalogue.");
  // Said again unasked, it is still a repeat; an apology in another sentence doesn't keep it.
  const again = "Sorry, it's not in our catalogue. You can check with Sia Huat sales directly - they can advise if it's something we can source.";
  assert.equal(dropRepeatedPitch(again, earlier("hmm ok", [t1, t2]), true), "Sorry, it's not in our catalogue.");
});

test("a reply saying nothing has reached Sia Huat yet keeps its route to order (r4 c08-stress idx 13, s07-A)", () => {
  const pitched = "The exact figure with GST will show at checkout. If the website gives you trouble, you can contact Sia Huat sales directly.";
  const earlier = (currentText: string): EarlierTurns => ({ cardSets: [], previousMessage: pitched, replies: [pitched], currentText });
  const raw = "Nothing from this chat has reached Sia Huat yet - it's still just an enquiry here. To actually order, you can download the enquiry PDF and send it to Sia Huat sales, and they can help you complete the order.";
  for (const text of ["ok whatever. so now how, u send my order to them or i must do wat", "any update on this order?"]) {
    assert.equal(dropRepeatedPitch(raw, earlier(text), true), raw, text);
  }
  const plain = "Yes, each product's store page has Add to Cart. You can contact Sia Huat sales with the PDF.";
  assert.equal(dropRepeatedPitch(plain, earlier("any update on this order?"), true), "Yes, each product's store page has Add to Cart.");
});

test("a closing 'Anything else?' is kept right after a change, but not with no change or twice running (r4 c09-persona)", () => {
  const added = "Got it: 2 Safico torches. Anything else?";
  assert.equal(withoutRepeatedCloser(added, "Here are two torches.", true), added);
  assert.equal(withoutRepeatedCloser("The blow torch is for kitchen use. Anything else?", "Here are two torches.", false), "The blow torch is for kitchen use.");
  assert.equal(withoutRepeatedCloser(added, "Got it: 1 blow torch. Anything else you'd like to add?", true), "Got it: 2 Safico torches.");
  // Never emptied, and a real either-or question is not a closer.
  assert.equal(withoutRepeatedCloser("Anything else?", "Got it: 1 blow torch. Anything else?", false), "Anything else?");
  assert.equal(withoutRepeatedCloser("Want the Kenwood, or anything else?", null, false), "Want the Kenwood, or anything else?");
});

const safetyOf = (message: string, card_ids: string[] = []) => reviewAnswer({ message, card_ids, chips: [], show_contact: false }, seen, allowed).safety;

test("asking for a tap needs a card", () => {
  for (const message of [
    "Please tap the Kenwood mixer to confirm it.", "Please tap the HET-4 card from earlier to add the 1 unit.",
    "Please tap HET-6 and HET-4 from the cards shown earlier.", "Could you tap on the UT16HR product to select it again?",
  ]) {
    assert.ok(safetyOf(message)[0]?.startsWith(NO_CARD_PREFIX), message);
    assert.deepEqual(safetyOf(message, ["BTS-8026D"]), [], message);
  }
  for (const message of [
    "Closest is a water dispenser with a single tap.", "Tap the Download PDF button to save it.", "Tap the enquiry bar to see the lines.", "Sorry ah, done - no tap needed.",
    "The dispenser has a tap that locks.", "It comes with a tap to add water.",
  ]) {
    assert.deepEqual(safetyOf(message), [], message);
  }
});

test("promising to pull cards up needs the cards", () => {
  for (const message of ["One sec, let me pull those up again.", "Sorry for the run-around - let me pull these up fresh for you to tap.", "One sec, pulling up the HET-4 card for you to tap."]) {
    assert.ok(safetyOf(message)[0]?.startsWith(NO_CARD_PREFIX), message);
  }
  for (const message of ["Let me know the knife type and I'll pull up options.", "Sorry, having trouble pulling up the catalogue right now.", "Let me get that set up for you."]) {
    assert.deepEqual(safetyOf(message), [], message);
  }
});

test("a tap request or show promise with no card is cut out after the repair", () => {
  const fixed = (message: string) => applyFixers(message, safetyOf(message), [noCardFixer]);
  assert.deepEqual(fixed("Sorry about that. Please tap the card to confirm."), { message: "Sorry about that.", left: [] });
  assert.deepEqual(fixed("One sec, let me pull those up again."), { message: "Tell me which one by its name or code.", left: [] });
  assert.equal(issueCode(safetyOf("Please tap the card to confirm.")[0]), "NO_CARD");
});

test("re-showing cards is allowed when the customer asks to see or tap them", () => {
  const tongs = new Map<string, CheckedProduct>([["UT16HR", { product: product({ stock_id: "UT16HR", name: "Stainless Steel Utility Tong with Locking Ring 16in", list_price: 5.69 }), verified: true }]]);
  const styleFor = (currentText: string, message = "Here it is - tap it to add 4.") => reviewAnswer(
    { message, card_ids: ["UT16HR"], chips: [], show_contact: false }, tongs, allowed, { cardSets: [["UT16HR"], ["UT16HR"]], previousMessage: null, currentText },
  ).style;
  for (const text of ["where the product?? show me then i tap la", "ok show me the card, i tap", "show me that one", "tap what?? u nvr show anything", "i cant see the card", "you never showed me"]) {
    assert.deepEqual(styleFor(text), [], text);
  }
  for (const text of ["hello police?", "any others?", "wah still nvr ans how much", "dont show me tongs"]) assert.ok(styleFor(text).some((issue) => issueCode(issue) === "REPEAT"), text);
});

test("complaints, quantities and picks that use again, same, back or earlier don't count as asking to see cards again", () => {
  // exam 3: all 6 identical third showings went out on bare words (c08-stress "SAME qty la. 20", c09-stress "ok add back 2 la").
  const tongs = new Map<string, CheckedProduct>([["UT16HR", { product: product({ stock_id: "UT16HR", name: "Stainless Steel Utility Tong with Locking Ring 16in", list_price: 5.69 }), verified: true }]]);
  const repeated = (currentText: string) => reviewAnswer(
    { message: "This one locks shut.", card_ids: ["UT16HR"], chips: [], show_contact: false }, tongs, allowed, { cardSets: [["UT16HR"], ["UT16HR"]], previousMessage: null, currentText },
  ).style.some((issue) => issueCode(issue) === "REPEAT");
  for (const text of [
    "SAME qty la. 20", "ya tht one. same qty", "still same link leh", "ok add back 2 la", "dont anyhow remove again ah",
    "Then why did you even ask earlier on", "only 1 of them", "i TAP ALR just now!!", "why need to tap again", "dun give me 3 again",
    "give me 2 of those", "give me 5 of them", "send them to my office",
    "don't show me the same ones", "u say wont send but below still got same link??", "no need show again", "dont need to show them again",
  ]) assert.equal(repeated(text), true, text);
  for (const text of [
    "show me those again", "can see the earlier ones?", "send the same cards again", "give me those again",
    "ok ok show the 2 again i tap", "tap where?? nothing to tap here leh", "where the product?? show me then i tap la",
    "u nvr show anything", "i cant see the card", "the previous options pls", "go back to the knives", "what were the options again?",
  ]) assert.equal(repeated(text), false, text);
});

test("an add or change confirmation leaves off a card the customer has already seen", () => {
  const answerWith = (message: string, card_ids: string[]): FinalAnswer => ({ message, card_ids, chips: [], show_contact: false });
  const added: EnquiryChange[] = [{ action: "add", code: "970S" }];
  const shown = new Set(["970S"]);
  const got = "Got it: 2 blow torches.";
  assert.deepEqual(withoutChangedCards(answerWith(got, ["970S"]), added, shown, "ok 2").card_ids, []);
  assert.deepEqual(withoutChangedCards(answerWith(got, ["970S"]), [{ action: "set", code: "970s" }], shown, "make it 2").card_ids, []);
  assert.deepEqual(withoutChangedCards(answerWith(got, ["970S"]), added, new Set(), "ok 2").card_ids, ["970S"]); // first showing
  assert.deepEqual(withoutChangedCards(answerWith(got, ["970S", "BTS-8026D"]), added, new Set(["970S", "BTS-8026D"]), "ok 2").card_ids, ["BTS-8026D"]);
  assert.deepEqual(withoutChangedCards(answerWith("Removed the torch.", ["970S"]), [{ action: "remove", code: "970S" }], shown, "remove it").card_ids, ["970S"]);
  for (const message of ["Got it: 2 blow torches. Tap it if you want a different one.", "Here it is again.", "See the card below."]) {
    assert.deepEqual(withoutChangedCards(answerWith(message, ["970S"]), added, shown, "ok 2").card_ids, ["970S"], message);
  }
  assert.deepEqual(withoutChangedCards(answerWith(got, ["970S"]), added, shown, "show me those again").card_ids, ["970S"]);
});

test("a card set shown twice already is dropped unless the customer asks for it, the message points at it, or a card was refused", () => {
  // exam 4: 14 same-set third showings, most re-attached to "Just to confirm?", "Want me to add it?" or "How many?".
  const earlier = { cardSets: [["UT16HR"], ["ut16hr"]], previousMessage: null, currentText: "ya lah that one, 6pcs" };
  const ask: FinalAnswer = { message: "How many of the locking-ring tong do you need?", card_ids: ["UT16HR"], chips: [], show_contact: false };
  assert.deepEqual(withoutRepeatedSet(ask, earlier, []).card_ids, []);
  assert.deepEqual(withoutRepeatedSet(ask, { ...earlier, cardSets: [["UT16HR"]] }, []).card_ids, ["UT16HR"]);
  assert.deepEqual(withoutRepeatedSet(ask, { ...earlier, currentText: "show me that one again" }, []).card_ids, ["UT16HR"]);
  assert.deepEqual(withoutRepeatedSet({ ...ask, message: "Tap it to add." }, earlier, []).card_ids, ["UT16HR"]);
  // A show promise or "here they are" points at the cards too (the promise lost its cards and cost a NO_CARD repair).
  for (const message of ["Let me pull up the locking-ring tong again for you.", "Here they are again: the 16in is the longer one."]) {
    assert.deepEqual(withoutRepeatedSet({ ...ask, message }, earlier, []).card_ids, ["UT16HR"], message);
  }
  // "details below" points at the contact details, not the cards.
  assert.deepEqual(withoutRepeatedSet({ ...ask, message: "Sia Huat sales can help with photos (details below)." }, earlier, []).card_ids, []);
  assert.deepEqual(withoutRepeatedSet(ask, earlier, ["ut16hr"]).card_ids, ["UT16HR"]);
  // Another set is a new showing.
  assert.deepEqual(withoutRepeatedSet({ ...ask, card_ids: ["UT16HR", "UT12HR"] }, earlier, []).card_ids, ["UT16HR", "UT12HR"]);
});

test("withoutCardPointers cuts the sentences that point at a card, not those that point at the contact details", () => {
  assert.equal(withoutCardPointers("It's item E910076. The card below has the same details. Tap it to add."), "It's item E910076.");
  // r2 c08-stress idx 6: this "below" is the contact details.
  for (const message of ["You can call our sales line to check or ask more, or email us - number and email below.", "Sia Huat sales can help (details below)."]) {
    assert.equal(withoutCardPointers(message), message);
  }
});

const checked = (stock_id: string, name: string, list_price: number): [string, CheckedProduct] => [stock_id, { product: product({ stock_id, name, list_price }), verified: true }];
const shop = new Map<string, CheckedProduct>([
  checked("BTS-8026D", "CASSETTE GAS TORCH BURNER SAFICO PRO", 23.36),
  checked("RS-J1009-7", "Rooster Series Round Plate 7in", 4.2),
  checked("RS-J1001-5", "Rooster Series Deep Bowl 5in", 3.1),
  checked("02003-11", "Roca by Cerabon Rice Bowl Ø107xH50mm", 2.5),
  checked("2527-003", "S/S DINNER SPOON L20cm, WAVE", 1.2),
]);
const line = (code: string, quantity: number) => {
  const { product: item } = shop.get(code)!;
  return { item: item.name, code, pricePerItem: item.list_price, quantity, total: item.list_price * quantity, uom: "PC" };
};
const added = (code: string): EnquiryChange => ({ action: "add", code });
const claimIssues = (message: string, turn: Partial<TurnFacts> = {}) => reviewAnswer(
  { message, card_ids: [], chips: [], show_contact: false }, shop, allowed, undefined, { lines: [], changes: [], ...turn },
).safety.filter((issue) => issue.startsWith(ENQUIRY_CLAIM_PREFIX));

test("saying the enquiry changed needs an update for that item this turn", () => {
  for (const message of [
    "Got it, adding 1 Kenwood Lite Hand Mixer to your enquiry now.",
    "Confirming: 1 Kenwood Lite Hand Mixer added to your enquiry.",
    "I'll add that to your enquiry now.",
    "Let me add that for you now.",
    "I've noted down 1 unit of the strainer.",
    "Got it: 2 torches. Anything else?",
    "Noted: 2 torches.",
    "Got the 3 ST-15 steak tongs added — tap the card to confirm and I'll add them",
    "Got it — I'll note 3 units of the 6-slot toaster.",
    "Please tap the card below to select it, then I'll add 60 pcs.",
    "I've put 2 in your enquiry.",
    "Done - both are in your enquiry now.",
    "好的，已加入2个火枪。",
    "Added 2 Safico torches, anything else?",
    "Added 2 Safico torches - the 3rd isn't in stock.",
    "Added 2 torches, not 3.",
    // A product feature in the same sentence doesn't excuse the claim.
    "Added 2 Safico torches - the lid can be removed for washing.",
    "Got it, 2 in your enquiry now.",
  ]) {
    assert.equal(claimIssues(message).length, 1, message);
  }
  const torchAdded = { lines: [line("BTS-8026D", 2)], changes: [added("BTS-8026D")] };
  for (const message of ["Got it: 2 Safico torches. Anything else?", "You've added 2 Safico torches so far."]) {
    assert.deepEqual(claimIssues(message, torchAdded), [], message);
  }
  assert.equal(issueCode(claimIssues("Noted: 2 torches.")[0]), "ENQUIRY_CLAIM");
});

test("an apology before 'Got it: N' still claims an add", () => {
  // r6 rescue sample: "Sorry, got it: 2 ..." after a cut, with nothing added and the enquiry empty.
  const crepe = new Map([checked("LACOR-22", "Lacor Robust Non-Stick Crepe Pan Ø22cm", 48.81)]);
  const facts = { lines: [], changes: [], seen: crepe };
  // With a dash, "about that" or "Oops" too (r6 review).
  for (const apology of ["Sorry,", "Sorry -", "Sorry —", "Sorry about that,", "Oops,"]) {
    assert.equal(enquiryClaimIssues(`${apology} got it: 2 of the Lacor Robust Non-Stick Crepe Pan Ø22cm.`, facts).length, 1, apology);
  }
  // Echoed numbers and plain apologies are still not claims.
  for (const message of ["Sorry, got it, 4 pax.", "Sorry - got it, 4 pax.", "Sorry, 2 sizes are listed.", "Oops, 2 sizes are listed."]) assert.deepEqual(enquiryClaimIssues(message, facts), [], message);
});

test("claims are checked per item", () => {
  const plateAdded = { lines: [line("RS-J1009-7", 4)], changes: [added("RS-J1009-7")] };
  const issues = claimIssues("Plate qty 4 done. Let me add the bowl too.", plateAdded);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Let me add the bowl too/);
  assert.equal(claimIssues("Added 4 rice bowls and 4 spoons.", { lines: [line("02003-11", 4)], changes: [added("02003-11")] }).length, 1);
  assert.equal(claimIssues("Removed the rice bowls.", { lines: [line("02003-11", 4)], changes: [added("02003-11")] }).length, 1);
  assert.deepEqual(claimIssues("Removed the rice bowls.", { changes: [{ action: "remove", code: "02003-11" }] }), []);
});

test("an added or updated claim needs a change for that item this turn, even when it is on the enquiry", () => {
  const torchOn = { lines: [line("BTS-8026D", 2)] };
  for (const message of ["Updated: 5 Safico torches now.", "Got it: 5 Safico torches."]) assert.equal(claimIssues(message, torchOn).length, 1, message);
  assert.deepEqual(claimIssues("It's already added (2 Safico torches).", torchOn), []);
  // The torch is on the enquiry at 2, so the repair must not be told to say it isn't there.
  assert.doesNotMatch(claimIssues("Updated: 5 Safico torches now.", torchOn)[0], /isn't on the enquiry/);
});

test("every item in a list after an add must be on the enquiry", () => {
  const torchAdded = { lines: [line("BTS-8026D", 2)], changes: [added("BTS-8026D")] };
  for (const message of [
    "Added: 2 Safico torches, 4 Rooster plates.",
    "Got it: 2 Safico torches, 4 Rooster plates.",
    "I've added 2 Safico torches, 4 Rooster plates and 12 spoons to your enquiry.",
    "Both added: 2 Safico torches; 4 Rooster plates.",
  ]) {
    assert.equal(claimIssues(message, torchAdded).length, 1, message);
  }
  const bothAdded = { lines: [line("BTS-8026D", 2), line("RS-J1009-7", 4)], changes: [added("BTS-8026D"), added("RS-J1009-7")] };
  assert.deepEqual(claimIssues("Added: 2 Safico torches, 4 Rooster plates.", bothAdded), []);
  // runs-new2 c02-persona T14: the cents of an amount don't point at a card coded 66.
  const blenders = new Map([checked("MK-768L", "Mika Bar Blender 2.0Liter", 273.83), checked("66", "Santos Compact Brushless Blender 1.4L", 1759.63)]);
  const mikaLine = { item: "Mika Bar Blender 2.0Liter", code: "MK-768L", pricePerItem: 273.83, quantity: 2, total: 547.66, uom: "PC" };
  for (const message of ["Added: 2 Mika MK-768L blenders, total $547.66 ex GST.", "Added 2 Mika MK-768L blenders at $547.66 in total."]) {
    assert.deepEqual(enquiryClaimIssues(message, { lines: [mikaLine], changes: [added("MK-768L")], seen: blenders }), [], message);
  }
});

test("a line about what is already on the enquiry is not a claim of a change", () => {
  const onEnquiry = { lines: [line("BTS-8026D", 2), line("RS-J1009-7", 4)] };
  for (const message of ["Yes, it's already added.", "Yes, both are in your enquiry.", "It's already added (2 Safico torches).", "You've added 2 Safico torches so far."]) {
    assert.deepEqual(claimIssues(message, onEnquiry), [], message);
    assert.equal(claimIssues(message).length, 1, message); // with nothing on the enquiry it is false
  }
  assert.equal(claimIssues("Done - both are in your enquiry now.", onEnquiry).length, 1);
  // runs-new s06-B T3: the 50 were added the turn before.
  const shot = new Map([checked("AC44-5-PC", "Polycarbonate Shot Glass With Thick Bottom Ø3.8xH9.3cm, 2oz", 2.06)]);
  const shotLine = { item: "Polycarbonate Shot Glass With Thick Bottom Ø3.8xH9.3cm, 2oz", code: "AC44-5-PC", pricePerItem: 2.06, quantity: 50, total: 103, uom: "PC" };
  assert.deepEqual(enquiryClaimIssues("Your 50 pcs are in the enquiry now and in stock (642 available).", { lines: [shotLine], changes: [], seen: shot }), []);
});

test("each change word is judged in its own clause", () => {
  const facts = (names: Array<[string, string]>, lineCodes: string[], changes: EnquiryChange[]) => {
    const found = new Map(names.map(([code, name]) => checked(code, name, 10)));
    return { seen: found, changes, lines: lineCodes.map((code) => ({ item: found.get(code)!.product.name, code, pricePerItem: 10, quantity: 1, total: 10, uom: "PC" })) };
  };
  const toasters: Array<[string, string]> = [["HET-4", "Electric Toaster 4-Slot HET-4"], ["HET-6", "Electric Toaster 6-Slot HET-6"], ["WCT708K", "Waring Commercial Toaster WCT708K"]];
  // runs-new c11-persona T11 and c07-persona T13, after update_enquiry succeeded.
  const swap = "Swapped: HET-4 removed, WCT708K (Waring, 1 unit) added. Now: 2 HET-6 + 1 WCT708K, total SGD 923.96 (ex GST).";
  assert.deepEqual(enquiryClaimIssues(swap, facts(toasters, ["HET-6", "WCT708K"], [{ action: "remove", code: "HET-4" }, { action: "add", code: "WCT708K" }])), []);
  assert.deepEqual(enquiryClaimIssues(
    "Removed - your enquiry now has just the 1 Dynamic Power Whisk Mixer, total SGD 1,340.37. Anything else?",
    facts([["MX130", "Dynamic Mini Cordless Mixer MX130"], ["FT001", "Dynamic Power Whisk Mixer FT001"]], ["FT001"], [{ action: "remove", code: "MX130" }]),
  ), []);
  // The same swap when it didn't happen, or only half of it did.
  assert.equal(enquiryClaimIssues(swap, facts(toasters, ["HET-4", "HET-6"], [])).length, 1);
  assert.equal(enquiryClaimIssues(swap, facts(toasters, ["HET-6"], [{ action: "remove", code: "HET-4" }])).length, 1);
  // runs-new c03-stress T10: a bracket that holds its own change is a clause too.
  const knives: Array<[string, string]> = [["ZK-176", "Zyliss Chef Knife 17.6cm"], ["ZK-191", "Zyliss Chef Knife 19.1cm"]];
  const knifeSwap = "Swapped: 3 Zyliss Chef Knife 17.6cm at $35.69 each now in your enquiry (19.1cm removed).";
  assert.deepEqual(enquiryClaimIssues(knifeSwap, facts(knives, ["ZK-176"], [{ action: "remove", code: "ZK-191" }, { action: "add", code: "ZK-176" }])), []);
  assert.equal(enquiryClaimIssues(knifeSwap, facts(knives, ["ZK-191"], [])).length, 1);
});

test("honest or conditional wording is not a claim", () => {
  for (const message of [
    "Nothing has been added yet.",
    "Sorry, the add didn't go through.",
    "It wasn't actually added yet.",
    "I'm having trouble adding it.",
    "9% GST will be added on top at checkout.",
    "GST will be added at checkout.",
    "Here are the updated prices.",
    "I removed the serving tongs from the list of options.",
    "Want me to add it?",
    "Tell me how many and I'll add them right away.",
    "Best if you contact Sia Huat sales directly to get that line added.",
    "Pick a plate style and a bowl style you like, and I'll add the quantities you need.",
    "Pick whichever suits and I'll add it to your enquiry.",
    "The price was updated today.",
    // Product features, not enquiry changes.
    "The bowl can be removed for easy cleaning.",
    "The handle can be removed for storage.",
    "The lid is easily removed for washing.",
    "It comes with an added splash guard.",
    "The Kenwood has an added dough hook.",
    "The newer model has an updated motor.",
    // The customer's own numbers echoed back.
    "Got it, 4 pax. A 12L pot would suit.",
    "Got it, 16in is the longer one.",
    "OK, 2 options fit your budget.",
  ]) {
    assert.deepEqual(claimIssues(message), [], message);
    assert.equal(withoutEnquiryClaims(message, { lines: [], changes: [], seen: shop }), message);
  }
  assert.deepEqual(claimIssues("Your updated total is $46.72.", { lines: [line("BTS-8026D", 2)] }), []);
});

test("a false claim is replaced by one plain line where the first one was", () => {
  const facts = { lines: [line("RS-J1009-7", 4)], changes: [added("RS-J1009-7")], seen: shop };
  assert.equal(withoutEnquiryClaims("Plate qty 4 done. Let me add the bowl too. Anything else?", facts), "Plate qty 4 done. That change isn't on your enquiry yet. Which item and how many would you like? Anything else?");
  assert.equal(withoutEnquiryClaims("Added the spoons. Added the rice bowls too.", { ...facts, seen: shop }), "That change isn't on your enquiry yet. Which item and how many would you like?");
  // The torch is on the enquiry at 2, so the line must not say it isn't there at all.
  assert.equal(withoutEnquiryClaims("Updated: 5 Safico torches now.", { lines: [line("BTS-8026D", 2)], changes: [], seen: shop }), "That change isn't on your enquiry yet. Which item and how many would you like?");
  // A false removal: the line is still there, and no number is asked for.
  assert.equal(withoutEnquiryClaims("Removed the Safico torch. Anything else?", { lines: [line("BTS-8026D", 2)], changes: [], seen: shop }), "That line is still on your enquiry. Anything else?");
  assert.equal(withoutEnquiryClaims("Here you go.", facts), "Here you go.");
});

const toasterShop = new Map([checked("HET-4", "S/S 4-SLOTS TOASTER", 196.36), checked("BTS-8026D", "Safico Blow Torch", 12.5)]);
const het6Line = { item: "S/S 6-SLOTS TOASTER", code: "HET-6", pricePerItem: 250, quantity: 2, total: 500, uom: "PC" };
const toasterClaims = (message: string) => enquiryClaimIssues(message, { lines: [het6Line], changes: [], seen: toasterShop });

test("a swap reported in one clause joined by 'and' is judged per item", () => {
  // exam 3, c11-stress T4 replayed: both update_enquiry calls succeeded, but "removed the 4-slot and added 2 HET-6" was read as
  // HET-6 removed, and the reply became "That change isn't on your enquiry yet."
  const toasters = new Map([...toasterShop, checked("HET-6", "S/S 6-SLOTS TOASTER", 257.85)]);
  const swapped: EnquiryChange[] = [{ action: "remove", code: "HET-4" }, { action: "add", code: "HET-6" }];
  for (const message of ["Done: removed the 4-slot and added 2 HET-6 6-slot toasters. Anything else?", "The 4-slot is removed and 2 HET-6 6-slot toasters are on your enquiry."]) {
    assert.deepEqual(enquiryClaimIssues(message, { lines: [het6Line], changes: swapped, seen: toasters }), [], message);
  }
  // Only the removal ran: the add half is still false.
  assert.equal(enquiryClaimIssues("Done: removed the 4-slot and added 2 HET-6 6-slot toasters.", { lines: [], changes: [swapped[0]], seen: toasters }).length, 1);
  // "and" inside one change still leaves one clause: every item it names must be on the enquiry.
  assert.equal(enquiryClaimIssues("Added 2 6-slot toasters and 2 Safico torches.", { lines: [het6Line], changes: [swapped[1]], seen: toasters }).length, 1);
});

test("the removal line replaces only a removal whose line is still on the enquiry; a swap or a removal of nothing gets the bare line", () => {
  // Any removal word in the claim picked "That line is still on your enquiry.", which was false when the swap's removal
  // ran and its add didn't (exam 3, c11-stress T4 replayed; r4 c11-stress idx 13), or when nothing was on the enquiry.
  const toasters = new Map([...toasterShop, checked("HET-6", "S/S 6-SLOTS TOASTER", 257.85)]);
  const removedHet4 = { lines: [], changes: [{ action: "remove", code: "HET-4" }] as EnquiryChange[], seen: toasters };
  assert.equal(withoutEnquiryClaims("Done: removed the 4-slot and added 2 HET-6 6-slot toasters. Anything else?", removedHet4), "That change isn't on your enquiry yet. Anything else?");
  assert.equal(withoutEnquiryClaims("HET-4 removed, 2 HET-6 added.", removedHet4), "That change isn't on your enquiry yet.");
  assert.equal(withoutEnquiryClaims("HET-4 removed and 2 HET-6 added for outlet 2. Anything else?", { ...removedHet4, lines: [{ ...het6Line, quantity: 1, total: 250 }] }),
    "That change isn't on your enquiry yet. Anything else?");
  const empty = { lines: [], changes: [], seen: shop };
  for (const message of ["Removed it from your enquiry.", "Removed the Zyliss garlic press from your enquiry.", "Added 4 Rooster plates, and the price dropped to $4.20 each.", "The price dropped, so I added 2 Safico torches."]) {
    assert.equal(withoutEnquiryClaims(message, empty), "That change isn't on your enquiry yet.", message);
  }
  // The add ran and the removal didn't: the bare line, not a question about the add.
  assert.equal(withoutEnquiryClaims("Added 4 Rooster plates and removed the Safico torch.", { lines: [line("BTS-8026D", 2), line("RS-J1009-7", 4)], changes: [added("RS-J1009-7")], seen: shop }),
    "That change isn't on your enquiry yet.");
  // A promise to remove is a removal too, and the torch is still on.
  assert.equal(withoutEnquiryClaims("I'll remove the Safico torch now.", { lines: [line("BTS-8026D", 2)], changes: [], seen: shop }), "That line is still on your enquiry.");
  // An add or status beside the removal in the same clause is not a removal alone.
  assert.equal(withoutEnquiryClaims("Removed the HET-4 so the HET-6 is now on your enquiry.", { lines: [het6Line], changes: [], seen: toasters }), "That change isn't on your enquiry yet.");
  // The removal ran and the other half ("set", "I'll add") stayed in its clause; that item being on the enquiry doesn't
  // make the removed line still there.
  assert.equal(withoutEnquiryClaims("Removed the HET-4 and set the HET-6 to 3.", { ...removedHet4, lines: [{ ...het6Line, quantity: 1, total: 250 }] }), "That change isn't on your enquiry yet.");
  assert.equal(withoutEnquiryClaims("I've removed the torch and I'll add 2 more plates now.", { lines: [line("RS-J1009-7", 2)], changes: [{ action: "remove", code: "BTS-8026D" }], seen: shop }),
    "That change isn't on your enquiry yet.");
  // A pronoun, or a code not looked up this turn, leaves only the other item named; the removal that ran may be
  // the one the claim means, so the removed line can't be said to be still there.
  const het6One = { ...removedHet4, lines: [{ ...het6Line, quantity: 1, total: 250 }] };
  for (const message of ["Removed it and set the HET-6 to 3.", "Removed that one and I'll add 2 more HET-6 now.", "Removed it so the HET-6 is now 3."]) {
    assert.equal(withoutEnquiryClaims(message, het6One), "That change isn't on your enquiry yet.", message);
  }
  assert.equal(withoutEnquiryClaims("Removed the HET-4 and set the HET-6 to 3.", { ...het6One, seen: new Map([...toasters].filter(([code]) => code !== "HET-4")) }),
    "That change isn't on your enquiry yet.");
  assert.equal(withoutEnquiryClaims("I've removed it and I'll add 2 more plates now.", { lines: [line("RS-J1009-7", 2)], changes: [{ action: "remove", code: "BTS-8026D" }], seen: shop }),
    "That change isn't on your enquiry yet.");
  // A clear that ran this turn removed every line, so a line added back afterwards isn't "still on" the enquiry.
  assert.equal(withoutEnquiryClaims("Removed the Safico torch.", { lines: [line("BTS-8026D", 2)], changes: [{ action: "clear", code: null }, added("BTS-8026D")], seen: shop }),
    "That change isn't on your enquiry yet.");
});

test("sums, GST, questions about what the customer wants and promises that wait are not enquiry claims", () => {
  for (const message of [
    // exam 3, c12-persona T11 (replayed): the repair's GST sum became "That change isn't on your enquiry yet."
    "Adding 9% to $119.09 gets you the GST-inclusive total, but I can't confirm that exact final figure here - Sia Huat sales will confirm it at checkout.",
    "Add 9% GST and it comes to about $101.81.",
    "Adding 9% GST and it comes to about $101.81.",
    "Adding GST, that's about $101.81.",
    // exam 3, c11-stress T9 (replayed): a question split from its "?" by the comma.
    "Sorry, just to be sure - is it the S/S 4-Slot Toaster (HET-4, $196.36) for the other outlet you want added, qty 1?",
    // Promises that wait for the customer (c06-persona T8, c05-persona T11 replayed), and an honest hiccup (c05-persona T10).
    "Tap it or let me know and I'll get 2 added.",
    "Let me know how you'd like to proceed with the plate, and I'll get everything added.",
    "Having a hiccup adding these on my end.",
    // A condition on stock arriving still waits: "once more stock" is not a closing "confirmed once more".
    "Once more stock arrives I'll add the blow torch for you.",
    "I'll add the torch once more stock is confirmed.",
  ]) assert.deepEqual(toasterClaims(message), [], message);
});

test("real claims and unconditional promises are still caught", () => {
  for (const message of [
    "Confirm and I'll get 2 added.",
    "Adding it now to your enquiry along with the 2x HET-6.",
    // exam 3, c11-stress T9 (replayed): a closing "once more" is not a condition.
    "Got it, adding 1 S/S 4-Slot Toaster for your other outlet now - noting it here since our system needs it confirmed once more: it's the HET-4.",
    "Got it: 2 torches. Anything else?",
    // An apology or a "you want" phrase never excuses a claim or a promise.
    "Sorry for the hiccup, I'll add 2 Safico blow torches now.",
    "Added 2 Safico blow torches without a hiccup.",
    "The 2 torches you need are added.",
    "The torch you want added is on your enquiry now.",
    "Got the 2 you need added.",
    // A GST sum next to an add doesn't excuse the add, and "add GST and 2 torches" adds the torches too.
    "Added 2 Safico torches - adding 9% GST, the total is about $153.72.",
    "Adding 2 Safico torches, and adding GST that's about $153.72.",
    "I'll add GST and 2 Safico torches now.",
    "Adding the tax and 2 Safico torches now.",
    // Only a waiting promise's own "added" is excused, not a real claim after it or next to it.
    "Let me know and I'll get 2 added - I've added the Safico torch already.",
    "Once you confirm I can have it updated - updated the Safico torch to 3.",
    "Once you tap it I'll get 3 added and the 2 Safico torches are now in your enquiry.",
    // A statement that opens like a question, or a hiccup clause with its own claim, is still a claim.
    "What you need added is now in your enquiry.",
    "Can confirm the Safico torch you need added is on your enquiry now.",
    "Can confirm the 2 you need added.",
    "Sorted the hiccup adding these and added 2 Safico torches.",
    // A closing "confirmed once more" set off by dashes is no condition either.
    "Adding 1 Safico torch now - confirmed once more - it's the BTS-8026D.",
  ]) assert.equal(toasterClaims(message).length, 1, message);
  // exam 3, c02-A T12 echoed "That change hasn't been made yet" after "what the fk": the repair says so only for an asked change.
  assert.match(toasterClaims("Confirm and I'll get 2 added.")[0], /If the customer asked for that change, say it hasn't been made yet .*; if they didn't ask for one, just leave that sentence out and answer what they said\.$/);
});

test("only a pure advice or comparison question asks for no enquiry change", () => {
  // exam 3: the fixed line answered "Recommend" (c03-persona T5), "i said recomend…" (c03-stress T4) and "which one more versatile?" (c04-persona T3).
  for (const text of ["Recommend", "i said recomend. u tell me which one better la", "which one more versatile? i bake sometimes, and use for cooking"]) {
    assert.equal(askedForChange(text), false, text);
  }
  for (const text of [
    "huh which card?? got no card leh. so added or not", "why need tap again. just put in for me la", "added alr? then how, i pay where", "no la knife only. wok keep",
    "glove no need, here still have", "cannot just add 9%?", "yes!! just add la why keep asking", "Yes that one", "which one better, i need 2",
  ]) assert.equal(askedForChange(text), true, text);
  // A tapped card picks a product, and a turn with no typed words may ask for anything.
  assert.equal(askedForChange("Recommend", true), true);
  assert.equal(askedForChange(null), true);
});

test("the fixed line answers only a change the customer asked for, and only once", () => {
  const facts = { lines: [], changes: [], seen: shop };
  // exam 3, c04-persona T3 ("which one more versatile?"): no change was asked, so the claim just goes.
  assert.equal(withoutEnquiryClaims("Sure — the Kenwood Lite Hand Mixer suits your baking and cooking needs at home. I'll add 1 to your enquiry.", facts, false),
    "Sure — the Kenwood Lite Hand Mixer suits your baking and cooking needs at home.");
  // exam 3, c06-persona T8: the reply already says the add didn't go through, so no second line.
  assert.equal(withoutEnquiryClaims("Sorry, that skimmer add didn't go through on my end. You said 2 - noted, adding 2 now.", facts, true), "Sorry, that skimmer add didn't go through on my end.");
  // A change was asked and nothing says it failed: the line stays, where the claim was.
  assert.equal(withoutEnquiryClaims("Got it: 2 torches added. Anything else?", facts, true), "That change isn't on your enquiry yet. Which item and how many would you like? Anything else?");
  // "not made in Japan" doesn't say the change failed.
  assert.equal(withoutEnquiryClaims("Added 1 Kenwood Hand Mixer. Kenwood is a UK brand, though it's not made in Japan.", facts, true),
    "That change isn't on your enquiry yet. Which item and how many would you like? Kenwood is a UK brand, though it's not made in Japan.");
  // A claim that was the whole reply to an advice question leaves nothing; the loop sends its cards-only or backup line instead.
  assert.equal(withoutEnquiryClaims("I'll add 3 pcs of the 21cm for you.", facts, false), "");
  // "That one hasn't been added yet" about the claim's own product (or naming none) says it failed.
  assert.equal(withoutEnquiryClaims("Sorry, that one hasn't been added yet. I'll add 2 Safico torches now.", facts, true), "Sorry, that one hasn't been added yet.");
  // exam 3, c10-stress T5 (replayed): the other tong "hasn't been added yet" doesn't say the steak tong add failed.
  const tongs = { lines: [], changes: [], seen: new Map([checked("ST-15", "Stainless Steel Steak Tong 15\"", 12.48), checked("2564L", "Stainless Steel Utility Tong 16\"", 3.85)]) };
  const otherTong = "For the 16″ tong, is it the Utility Tong 16″ (2564L)? That one hasn't been added yet, just confirm and I'll add 3 for you.";
  // The reply already asks its own question, so the line asks nothing more (two questions in a row).
  assert.equal(withoutEnquiryClaims(`Got it: 3 Stainless Steel Steak Tong 15″ added. ${otherTong}`, tongs, true), `That change isn't on your enquiry yet. ${otherTong}`);
  // Nor does a GST note, another product, or a sentence that isn't about a change.
  for (const note of [
    "Note GST is not added to these prices yet.", "The Rooster Series Round Plate is not in your enquiry.", "Prices are not final on your enquiry until sales confirms.",
  ]) assert.equal(withoutEnquiryClaims(`Added 2 Safico torches. ${note}`, facts, true), `That change isn't on your enquiry yet. Which item and how many would you like? ${note}`, note);
});

test("asking permission to add is a style issue", () => {
  const styleWith = (message: string, card_ids: string[] = []) => reviewAnswer({ message, card_ids, chips: [], show_contact: false }, shop, allowed).style;
  const withCard = styleWith("The Safico fits. Want me to add it to your enquiry?", ["BTS-8026D"]);
  assert.deepEqual(withCard.filter((issue) => issue === NO_PERMISSION_ISSUE).length, 1);
  assert.ok(!withCard.some((issue) => issue.startsWith("The customer must choose a product card first")));
  for (const message of [
    "Shall I add 2 to your enquiry?", "Once you confirm I'll add it right away.", "Confirming: 3pcs of this one?",
    "Want me to add the CB15K, and how many units total?", "You already saw the plate. Want me to add any of these, and how many of each?",
  ]) {
    assert.ok(styleWith(message).includes(NO_PERMISSION_ISSUE), message);
  }
  for (const message of [
    "How many do you need?", "Only 5 in stock. Want me to add 5 now, or check alternatives for the 6th?",
    "How many would you like so I can add it for you?", "I'll try the search again once you confirm.",
    // runs-new2 c11-persona T9 and s06-B T2: a closing question after a sentence with "can".
    "Delivery and lead times aren't something I can confirm here — Sia Huat sales will work that out based on your enquiry once it's submitted. Anything else you'd like to add?",
    "I can't issue a formal quotation PDF here, but you can download the enquiry summary from the bar to send to Sia Huat sales for a formal quote. Anything else to add?",
    "Got it: 2 Safico torches. You can download the PDF from the enquiry bar. Anything else you'd like to add?",
    "How many would you like to add?", "How many should I add?", "How many do you need so we can add it?",
    "Would you like to add anything else?", "What else can I add for you?",
  ]) {
    assert.ok(!styleWith(message).includes(NO_PERMISSION_ISSUE), message);
  }
  // Asking to check stock or show a card is not about adding, even when the reply says "add" elsewhere.
  const checkStock = styleWith("The Safico fits. Want me to check stock on it?", ["BTS-8026D"]);
  assert.ok(checkStock.includes(NO_SHOW_PERMISSION_ISSUE) && !checkStock.includes(NO_PERMISSION_ISSUE));
  for (const message of ["Here's the Safico. Want me to check stock on it? Tap it to add.", "The Safico fits. Would you like me to show it? You can add it after."]) {
    assert.ok(styleWith(message, ["BTS-8026D"]).includes(NO_SHOW_PERMISSION_ISSUE), message);
  }
});

test("a permission question about a product the customer hasn't picked is a pick question", () => {
  // exam 3, c09-stress T1: "Want me to add the Safico one?" after "which one is more suitable?" was repaired into "How many Safico tongs do you need?".
  const tongs = new Map<string, CheckedProduct>([
    checked("02-00864", "Safico Stainless Steel Tong With Silicone Grip L32cm, BPA Free, Heat Resistant To 220°C", 11.83),
    checked("UT09L", "Stainless Steel Utility Tong 9in", 2.02),
  ]);
  const styleWith = (message: string, card_ids: string[], picked: (code: string) => boolean) => reviewAnswer(
    { message, card_ids, chips: [], show_contact: false }, tongs, allowed, undefined, { picked },
  ).style;
  const recommend = "For cooking I'd go with the Safico. Want me to add the Safico one?";
  assert.ok(!styleWith(recommend, ["02-00864", "UT09L"], () => false).includes(NO_PERMISSION_ISSUE));
  assert.ok(!styleWith(recommend, ["02-00864", "UT09L"], () => false).some((issue) => issue.startsWith("The customer must choose a product card first")));
  assert.ok(styleWith(recommend, ["02-00864", "UT09L"], (code) => code === "02-00864").includes(NO_PERMISSION_ISSUE));
  // A question naming no product is still the confirm step.
  assert.ok(styleWith("Shall I add 2 to your enquiry?", [], () => false).includes(NO_PERMISSION_ISSUE));
  // A show or check-stock question is still flagged when "add" is elsewhere in the reply, picked or not.
  const checkStock = "The Safico has a silicone grip. Want me to check stock on the 9in one too? You can add either to your enquiry anytime.";
  for (const picked of [() => false, () => true]) assert.ok(styleWith(checkStock, ["02-00864", "UT09L"], picked).includes(NO_SHOW_PERMISSION_ISSUE));
  // An "or" question lets them choose.
  assert.deepEqual(styleWith("The Safico fits. Want me to add it to your enquiry, or see other options?", ["02-00864"], () => false), []);
  assert.match(NO_PERMISSION_ISSUE, /Keep the rest of your answer/);
});

test("permissionCodes gives the products a permission-to-add question is about", () => {
  // r4 c02-persona idx 8: "shall I add 2 of the MX1000" after the customer had named it. The loop checks that one product first.
  const blenders = new Map<string, CheckedProduct>([checked("MX1000", "Waring Blender MX1000XTX", 1220), checked("MX1200", "Waring Blender MX1200XTX", 1535)]);
  const answerWith = (message: string, card_ids: string[] = []): FinalAnswer => ({ message, card_ids, chips: [], show_contact: false });
  assert.deepEqual(permissionCodes(answerWith("Shall I add 2 of the MX1000?"), blenders), ["MX1000"]);
  assert.deepEqual(permissionCodes(answerWith("The MX1000 fits. How many do you need?"), blenders), []);
  // A question naming no product is about the reply's cards, else the products the reply names; an earlier card counts too.
  assert.deepEqual(permissionCodes(answerWith("Both fit. Want me to add them?", ["MX1000", "MX1200"]), blenders), ["MX1000", "MX1200"]);
  const earlier = [{ code: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER SAFICO PRO", price: 23.36, link: null }];
  assert.deepEqual(permissionCodes(answerWith("The Safico runs on gas. Want me to add it?"), new Map(), earlier), ["BTS-8026D"]);
  assert.deepEqual(permissionCodes(answerWith("Shall I add 2 to your enquiry?"), blenders), []);
});

test("a confirm-add chip is dropped", () => {
  const review = reviewAnswer({ message: "Which one would you like?", card_ids: [], chips: ["Yes, add it", "Show others"], show_contact: false }, seen, allowed);
  assert.deepEqual(review.chips, ["Show others"]);
  const chipsOf = (chips: string[]) => reviewAnswer({ message: "Which one would you like?", card_ids: [], chips, show_contact: false }, seen, allowed).chips;
  assert.deepEqual(chipsOf(["Add it", "Confirm", "Add both"]), []);
  assert.deepEqual(chipsOf(["Add more items", "Add another item"]), ["Add more items", "Add another item"]);
});

test("promising to come back later is a style issue and is dropped when tidied", () => {
  assert.ok(styleOf("Let me check the rest of your list, then get back to you with all the details.").includes(PROMISE_LATER_ISSUE));
  assert.equal(tidyMessage("Here are the plates. I'll get back to you on the rest."), "Here are the plates.");
});

test("a clean answer has no issues", () => {
  const review = reviewAnswer({ message: "The Safico one is lighter. Want that one?", card_ids: ["BTS-8026D"], chips: ["Yes", "Show others"], show_contact: false }, seen, allowed);
  assert.deepEqual([review.safety, review.style, review.chips], [[], [], ["Yes", "Show others"]]);
});

test("staff-contact claims are removed from the customer message", () => {
  assert.doesNotMatch(customerMessage("I've notified our sales team. They will call you soon.").message, /will call you/);
});

test("a removed staff claim shows the contact block instead of a fixed sentence", () => {
  const cleaned = customerMessage("I've notified our sales team. Anything else you need?");
  assert.doesNotMatch(cleaned.message, /notified our sales team/);
  assert.doesNotMatch(cleaned.message, /No staff member has been notified automatically/);
  assert.equal(cleaned.message, "Anything else you need?");
  assert.equal(cleaned.showContact, true);
  assert.deepEqual(customerMessage(" Which size do you need? "), { message: "Which size do you need?", showContact: false });
});

test("a reply that was only a staff claim still has words", () => {
  for (const text of ["I've notified our sales team.", "I've passed this to our sales team, they will contact you!"]) {
    assert.deepEqual(customerMessage(text), { message: "You can reach our sales team directly below.", showContact: true }, text);
  }
});

test("a claim that stock is reserved or an order placed is removed from the customer message", () => {
  assert.equal(customerMessage("Got it. Your 2 units are already reserved in this enquiry.").message, "Got it.");
  for (const text of ["No worries, your 2 units are already reserved.", "I've put 2 on hold for you.", "已为您预留2个。"]) {
    assert.deepEqual(customerMessage(text), { message: "You can reach our sales team directly below.", showContact: true }, text);
  }
});

test("reservation words that claim nothing are kept", () => {
  for (const text of [
    "The lid is secured with a stainless clip.",
    "It is held in place by two screws.",
    "Stock is reserved when sales confirm the order.",
    "Stock isn't reserved until sales confirm.",
    "Nothing is reserved - an enquiry doesn't hold stock.",
    "Sia Huat sales will confirm once your order is placed.",
    "The 21cm is confirmed in stock.",
    "Got it: 2 torches added. Anything else?",
  ]) {
    assert.deepEqual(customerMessage(text), { message: text, showContact: false }, text);
    assert.ok(!styleOf(text).includes(RESERVATION_ISSUE), text);
  }
});

test("more firm reservation claims are removed: 're, 's, will be, until, and after 不锈钢", () => {
  assert.equal(customerMessage("Added 2 to your enquiry. They're reserved for you.").message, "Added 2 to your enquiry.");
  assert.equal(customerMessage("Done. It's reserved for you now.").message, "Done.");
  assert.equal(customerMessage("Added. They will be reserved for you.").message, "Added.");
  for (const text of [
    "Your 2 units are reserved until Friday.", "I've put 2 on hold until sales call you.", "不锈钢汤锅已为您预留2个。",
    "No worries - your 2 units are already reserved.",
  ]) {
    assert.deepEqual(customerMessage(text), { message: "You can reach our sales team directly below.", showContact: true }, text);
    assert.ok(styleOf(text).includes(RESERVATION_ISSUE), text);
  }
});

test("reserved signs, Chinese product words, a leading condition and a plain 'no' claim nothing", () => {
  for (const text of [
    "These are reserved signs.",
    "Yes, both are reserved signs: the acrylic one is the listed price.",
    "We have an acrylic reserved sign holder, 23 in stock.",
    "这款保留了传统造型，适合家用。",
    "带锁定环的夹子，很好用。",
    "Once sales confirm stock, your order is placed.",
    "After you send the PDF, sales will check and your order is confirmed by them.",
    "Once sales confirm, stock is reserved for you.",
    "No stock is reserved.",
    "No items are reserved by an enquiry.",
    "No units are on hold.",
    "Once you send the enquiry, sales will confirm and your order is placed.",
    "Once confirmed by sales, your order is placed.",
    "Once confirmed, your order is placed.",
    "When our sales team confirms, stock is reserved for you.",
    "Once sales have confirmed, your order is placed.",
    "Stock isn't pre-reserved for enquiries.",
  ]) {
    assert.deepEqual(customerMessage(text), { message: text, showContact: false }, text);
    assert.ok(!styleOf(text).includes(RESERVATION_ISSUE), text);
  }
});

test("'Let's put aside' is not a reservation claim", () => {
  const text = "Let's put aside the lids for now and look at the pots.";
  assert.deepEqual(customerMessage(text), { message: text, showContact: false });
});

test("a 'no rush' opener or a condition that doesn't wait on sales still leaves a claim", () => {
  for (const text of [
    "No rush — your 2 units are on hold for you.", "There's no rush: your 2 are on hold for you.",
    "Yes, no issue - your 2 units are already reserved.", "No MOQ needed and they're reserved for you.",
    "Once you add them, they are reserved for you.", "After adding, your order is confirmed.",
    "Once added, they're reserved for you.", "If you need more, your 2 are reserved.",
    // A dash starts a new clause, spaced or not; a condition the customer meets doesn't wait on sales.
    "No rush—they're on hold for you.", "No rush—your order is confirmed.", "No MOQ—they're all reserved.",
    "Don't worry—they're reserved for you.", "Don't worry – your 2 are reserved.", "Don't worry - your 2 are reserved.",
    "Once you send the enquiry to sales, your 2 are reserved.", "If you confirm the quantity, your order is placed.",
    "When you tap Send to sales, your items are on hold.", "Once you confirm, they're reserved for you.",
  ]) {
    assert.deepEqual(customerMessage(text), { message: "You can reach our sales team directly below.", showContact: true }, text);
    assert.ok(styleOf(text).includes(RESERVATION_ISSUE), text);
  }
});

test("an empty message stays empty and turns nothing on", () => {
  for (const text of ["", "   "]) assert.deepEqual(customerMessage(text), { message: "", showContact: false }, JSON.stringify(text));
});

test("reservation wording is a style issue; only a firm claim is removed in code", () => {
  for (const text of ["I've reserved them for you.", "Your order is confirmed.", "want me to add 5 now (6th on hold)"]) {
    assert.ok(styleOf(text).includes(RESERVATION_ISSUE), text);
  }
  assert.equal(customerMessage("want me to add 5 now (6th on hold)").message, "want me to add 5 now (6th on hold)");
});

test("块 as a counting word is not money", () => {
  assert.deepEqual(unverifiedAmounts("好的，已加入3块砧板。还需要别的吗？", allowed), []);
});

test("a phone number or email that isn't Sia Huat's sales contact is removed and the contact block shown", () => {
  const cases: Array<[string, string]> = [
    ["Call us at 6223 1732", "Call us at Sia Huat sales (details below)"],
    ["Call +65 6223-1732 or email sales@example.com.", "Call Sia Huat sales (details below) or email Sia Huat sales (details below)."],
    ["请拨打62231732。", "请拨打Sia Huat sales (details below)。"],
    ["Toll-free: 1800 123 4567.", "Toll-free: Sia Huat sales (details below)."],
    ["Our HQ is on +44 20 7946 0958.", "Our HQ is on Sia Huat sales (details below)."],
    ["Tel: 65 6223 1732", "Tel: Sia Huat sales (details below)"],
    ["Tel: 65-6223-1732", "Tel: Sia Huat sales (details below)"],
    ["Call 1-800-123-4567.", "Call Sia Huat sales (details below)."],
    ["Tel.62231732", "Tel.Sia Huat sales (details below)"],
    ["Call 62231732,91234567", "Call Sia Huat sales (details below),Sia Huat sales (details below)"],
  ];
  for (const [text, expected] of cases) assert.deepEqual(customerMessage(text), { message: expected, showContact: true }, text);
});

test("Sia Huat's sales contact, prices, item codes, dates and size lists pass unchanged", () => {
  const text = `You can reach Sia Huat sales at ${SALES_CONTACT.phone} or ${SALES_CONTACT.email}.`;
  assert.deepEqual(customerMessage(text), { message: text, showContact: false });
  for (const safe of [
    "Got it: 2 BTS-8026D torches, $46.72.",
    "The total is $1,234,567.89.",
    "Item 12345678D is in stock.",
    "Got it: 2 Giesser knives (218455-20). Anything else?",
    "Delivery is on 2026-09-26.",
    "We have sizes 10 12 14 16.",
    "It comes in 3000 4000 5000 ml.",
  ]) {
    assert.deepEqual(customerMessage(safe), { message: safe, showContact: false }, safe);
  }
});

test("an item code from this chat that fits the phone pattern is kept; other numbers are still replaced", () => {
  // exam 3, c05-persona T10-T11: the Patra codes became "Sia Huat sales (details below)" ("the codes u write also dont have").
  const text = "Could you type back the item codes 3500-0018 (plate) and 3500-3011 (bowl), with how many you need?";
  assert.deepEqual(customerMessage(text, ["3500-0018", "3500-3011", "R-52568-81"]), { message: text, showContact: false });
  assert.deepEqual(customerMessage("Westmark 30002260 is in stock.", ["30002260"]), { message: "Westmark 30002260 is in stock.", showContact: false });
  assert.deepEqual(customerMessage("Call 6223 1732 or see 3500-0018.", ["3500-0018"]), { message: "Call Sia Huat sales (details below) or see 3500-0018.", showContact: true });
  // A code with a space is never spared, so a phone number can't pass as one.
  assert.deepEqual(customerMessage("Call 9123 4567.", ["9123 4567"]), { message: "Call Sia Huat sales (details below).", showContact: true });
  // Only a code is spared: shownProductIds come from the browser, so an email passed as one is still replaced.
  assert.deepEqual(customerMessage("Email evil@example.com for a quote.", ["evil@example.com"]), { message: "Email Sia Huat sales (details below) for a quote.", showContact: true });
  // Without the chat's codes nothing changes.
  assert.deepEqual(customerMessage(text), { message: "Could you type back the item codes Sia Huat sales (details below) (plate) and Sia Huat sales (details below) (bowl), with how many you need?", showContact: true });
});

test("the money repair also covers an amount the customer typed", () => {
  // exam 3, c06-stress T4: the customer's "2 dollar" became "the 'the listed price one'".
  const review = reviewAnswer({ message: "The '2 dollar one' is the skimmer.", card_ids: [], chips: [], show_contact: false }, seen, allowed);
  assert.match(review.safety.find((issue) => issue.startsWith(MONEY_ISSUE_PREFIX)) ?? "", /an amount the customer typed/);
});

const search = (overrides: Partial<SearchRecord> = {}): SearchRecord => ({ queries: ["tongs"], category: null, categoryFound: false, maxPrice: null, complete: false, ...overrides });
const stockSeen = new Map<string, CheckedProduct>([
  ["BLP10.A0WH", { product: product({ stock_id: "BLP10.A0WH", name: "Kenwood Blender x-Tract 1.5L", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }), verified: true }],
  ["1052", { product: product({ stock_id: "1052", name: "Adler Kettle 2L", stock_status: "unknown", in_stock: null, available_quantity: null }), verified: false }],
  ["VD-KT", { product: product({ stock_id: "VD-KT", name: "Vinda Deluxe Kitchen Towel", stock_status: "unknown", in_stock: null, available_quantity: null }), verified: false }],
  ["4006", { product: product({ stock_id: "4006", name: "Beautex Kitchen Towel (Pulp), 6Rolls X 60Sheets", available_quantity: 1 }), verified: true }],
  ["GP111", { product: product({ stock_id: "GP111", name: "COFFEE BAG WITH WIRE HANDLE 4in", stock_status: "unknown", in_stock: null, available_quantity: null }), verified: false }],
  ["GF-33", { product: product({ stock_id: "GF-33", name: "Global Chef Knife 21cm", stock_status: "unknown", in_stock: null, available_quantity: null }), verified: false }],
  ["GS-7", { product: product({ stock_id: "GS-7", name: "Global Vegetable Knife 14cm", available_quantity: 9 }), verified: true }],
  ["XXGS-9", { product: product({ stock_id: "XXGS-9", name: "Global Kitchen Knife 13cm", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }), verified: true }],
]);
const claimReview = (message: string, searches: SearchRecord[] = []) => reviewAnswer(
  { message, card_ids: [], chips: [], show_contact: false }, stockSeen, allowed, undefined, { searches },
);
const claimsOf = (message: string, searches: SearchRecord[] = []) => claimReview(message, searches).safety.filter((issue) => issue.startsWith(CLAIM_ISSUE_PREFIX));
const absenceOf = (message: string, searches: SearchRecord[] = []) => claimReview(message, searches).style.filter((issue) => issueCode(issue) === "ABSENCE");

test("a claim that the range is complete needs a complete search this turn", () => {
  for (const message of ["That covers our tong range.", "Comes in two sizes, 6″ and 8″.", "Everything else in-stock is Atlantic Chef.", "Everything else is German steel.", "No other cordless 3-in-1 combo is in stock right now."]) {
    assert.equal(claimsOf(message).length, 1, message);
    assert.equal(claimsOf(message, [search({ complete: false })]).length, 1, message);
    assert.deepEqual(claimsOf(message, [search({ complete: true })]), [], message);
  }
  assert.equal(issueCode(claimsOf("That covers our tong range.")[0]), "CLAIM");
});

test("a range summary needs a complete search this turn (exam 3)", () => {
  for (const message of [
    "all our chef knives are Atlantic Chef (Taiwan) or Global (Japan).",
    "I've checked our full chef knives range again.",
    "What we carry are Atlantic Chef and Global.",
    "Right now the only chef knives we have in stock for 3pcs are the Atlantic Chef range.",
    "MX130 is actually the only other cordless option we carry.",
    "All our other jug blenders (Severin, Mika, Santos) are corded.",
    "Our in-stock chef knives in the size you'd want are the Atlantic Chef range.",
    "The only chef knives we have to offer are the Atlantic Chef range.",
    "The only sizes we have to choose from are 24cm and 28cm.",
    // A decimal size is not a stock count (c01 chef knives).
    "We only have 27.5cm and 17.5cm chef knives.",
    // Unscoped, with nothing between "only" and the noun, or a list that isn't sent to sales.
    "The only option in stock is the MX130.",
    "That's the full list of tongs we carry.",
    "All our stainless steel tongs are 18/8.",
  ]) {
    assert.equal(claimsOf(message).length, 1, message);
    assert.equal(claimsOf(message, [search({ complete: false })]).length, 1, message);
    assert.deepEqual(claimsOf(message, [search({ complete: true })]), [], message);
    assert.equal(issueCode(claimsOf(message)[0]), "CLAIM", message);
  }
});

test("a claim that nothing fits the budget needs a complete priced search this turn", () => {
  for (const message of ["Nothing cheaper in that longer length.", "I don't have a commercial blender in that lower budget range."]) {
    assert.equal(claimsOf(message, [search({ categoryFound: true, maxPrice: 20, complete: false })]).length, 1, message);
    assert.deepEqual(claimReview(message, [search({ maxPrice: 20, complete: true })]).safety, [], message);
    // A backed budget claim isn't judged again as a "we don't have it".
    assert.deepEqual(absenceOf(message, [search({ maxPrice: 20, complete: true })]), [], message);
  }
  for (const message of [
    "No blenders under the S$100 mark, sorry.", "There's nothing in that range under that amount.", "We don't have anything below 50 dollars.",
    "Nothing below your $50 budget.", "Nothing under your S$80 budget in that size.", "Nothing within your S$50 budget, sorry.",
    "Nothing within $50 in that length.",
  ]) {
    assert.equal(claimsOf(message).length, 1, message);
  }
  for (const message of [
    "No Damascus blades - none turned up under that name.", "Nothing under that name came up in the catalogue.", "No delivery within 3 days is promised.",
  ]) {
    assert.deepEqual(claimsOf(message), [], message);
  }
});

test("a 'we don't have it' needs two searches and a found category, and is only ever a style issue", () => {
  const boxed = "We don't carry boxed dining sets.";
  const unbacked = claimReview(boxed, [search({ queries: ["dining set"], categoryFound: false })]);
  assert.deepEqual(unbacked.safety, []);
  assert.equal(unbacked.style.filter((issue) => issueCode(issue) === "ABSENCE").length, 1);
  assert.deepEqual(absenceOf(boxed, [search({ queries: ["dining set", "cutlery set"], category: "table-setting sets", categoryFound: true })]), []);
  // A search-scoped wording reports this turn's search (see the r6 area N test below). runs-new2 s05-A: a known false absence (Cambro
  // UGNPR11F18-480 exists) that the tools-off repair couldn't fix anyway.
  assert.deepEqual(absenceOf("I'm not finding the GN pan trolley."), []);
  assert.deepEqual(absenceOf("Sorry, we don't sell mangoes - we're a kitchen and F&B equipment supplier."), []);
  assert.equal(absenceOf("We don't sell F&B-grade vacuum sealers of that size.").length, 1);
  const torch = claimReview("Mastrad torch is out of stock, no direct substitute for it.");
  assert.deepEqual(torch.safety, []);
  assert.match(torch.style.find((issue) => issueCode(issue) === "ABSENCE") ?? "", /no direct substitute/);
});

test("'specifically' is not read as 'spec': the 'we don't have it' is still checked (r6 area N)", () => {
  // runs-new3 c03-stress T1 slipped through this way.
  assert.equal(absenceOf("We don't have a tawa specifically.").length, 1);
  assert.deepEqual(absenceOf("I don't have a spec on that."), []);
  // Plurals and long forms are still not about a product (review of D9).
  for (const message of [
    "I don't have any specifications for that one.",
    "I don't have a specification sheet for it.",
    "I don't have any ratings for it.",
    "I don't have any messages from sales yet.",
    "I don't have any other links for it.",
    "We don't have any records of that.",
    "I don't have any issues with that.",
    "I don't have any invoices here.",
    // Other long forms are still prefixes; only 'spec' is a whole word.
    "I don't have a detailed breakdown for that.",
    "I don't have any photographs of it.",
  ]) assert.deepEqual(absenceOf(message), [], message);
});

test("'I couldn't find X' and 'we don't carry X by that name' are not repaired as unbacked, but a range 'we don't carry X' still is (r6 area N)", () => {
  // The area-N baseline: 8 of 13 ABSENCE repairs only reworded "I couldn't find X in our catalogue" to "I couldn't find X among what
  // I found", a Claude round each, and the prompt's "we don't list anything by that name" was repaired when said with 'carry'.
  for (const message of [
    "Sorry, we don't list anything called a 'prata pan'.",
    "We don't list anything called 'tawa' by name, but these crepe pans do the same flat-pan job.",
    "We don't list anything under 'chapati press' by that name.",
    "I couldn't find a kueh tutu mould - our closest match is the chui kuay mould.",
    "I couldn't find a standalone takoyaki pan, but I did find the Iwatani takoyaki cooker.",
    "I couldn't find a kueh tutu mould specifically in our catalogue.",
    "I haven't found an actual Japan-made knife brand in our catalogue.",
    "We don't carry a dedicated 'idli steamer' by that name.",
    "We don't have a jar labelled 'kaya jar' specifically.",
    // Curly or no quotes after "anything called" (review of D10).
    "We don't list anything called “prata pan”.",
    "We don't list anything called a prata pan.",
    // Two names joined by 'or' stay one name-scoped clause.
    "We don't carry a 'prata pan' or 'tawa' by that name.",
    "We don't list a prata pan or tawa by that name.",
  ]) assert.deepEqual(absenceOf(message), [], message);
  for (const message of [
    // 'list' is checked like 'carry', and a name in another clause doesn't scope it.
    "We don't list tandoor ovens specifically.",
    // proto1 takoyaki T0: false (1209-01 CAST IRON OCTOPUS BALL PLATE), and no guard saw it.
    "We don't list a standalone takoyaki pan/plate, but we do have the Iwatani Entako II Cassette Gas Takoyaki Cooker.",
    // base2 angkukueh T1: false (161 ALUM CHUI KUAY MOULD is a traditional kueh mould).
    "We don't list an ang ku kueh mould specifically - no traditional kueh mould in our catalogue.",
    "We don't carry tandoor ovens, or anything called 'tandoor'.",
    // A range summary beside it (base2 murtabak T1 draft; base1 mooncake T1 draft; runs-new3 c03-stress T1; runs-new5 c05-B T6).
    "I couldn't find a dedicated gas griddle in the results - the griddles we carry (PA10313, PA10301) are all electric.",
    "I couldn't find a wooden mooncake mould in our catalogue - our cake/pastry moulds are mainly silicone or aluminium.",
    "We don't have a knife specifically labeled 'Damascus' pattern in stock - our chef knives are German steel 1.4116 blades (Atlantic Chef brand).",
    "I couldn't find a bundled plate+bowl+glass 'dining set' - dinnerware here is sold piece by piece.",
    "We don't carry tandoor ovens.",
    "We don't carry tandoor ovens, and I couldn't find one.",
    "I couldn't find a tandoor, so no substitute either.",
    // A range claim in any clause, not only the first, still needs the searches (review of D10; PA10313 is a flat griddle).
    "We don't carry tandoor ovens or anything called 'tandoor'.",
    "We don't list anything called 'tawa'; we don't carry griddles.",
    "We don't list anything called 'prata pan' - we don't stock griddles.",
    "We don't list anything called 'tawa' - we don't carry flat griddle pans either.",
    "We don't list anything called a 'tawa', and we don't carry flat griddles either.",
    "I couldn't find anything called 'tawa', and we don't carry griddle pans either.",
    "I couldn't find anything by that name, and we don't carry tandoor ovens.",
    "We don't list anything called 'prata pan' - it's not in our catalogue.",
    "We don't list anything called 'prata pan', and none of our pans would suit.",
    // Joined by 'and' with no comma, the range claim is still its own clause.
    "We don't list anything called 'tawa' and we don't carry griddles either.",
    "We don't list anything called 'prata pan' and we don't stock flat griddles.",
    "I couldn't find anything called 'tawa' and we don't carry griddle pans.",
  ]) assert.equal(absenceOf(message).length, 1, message);
  // Backed by two queries and a found category, a range 'we don't list' passes.
  assert.deepEqual(absenceOf("We don't list tandoor ovens specifically.", [search({ queries: ["tandoor oven", "clay oven"], category: "ovens", categoryFound: true })]), []);
});

test("a denial of a whole range or type the catalogue lists is repaired even with backing searches (owner, 2 Oct: furniture)", () => {
  // The owner's chat denied furniture beside a whole Furniture & Banquet range, saying what Sia Huat supplies, after searches that
  // found a category ("furniture" found only wax fuel). A size, a brand, a country or a material makes it a specific denial.
  const backed = [search({ queries: ["furniture", "restaurant furniture"], category: "furniture", categoryFound: true })];
  const denials = (message: string) => claimReview(message, backed).style.filter((issue) => issueCode(issue) === "RANGE_DENIAL");
  for (const message of [
    "We don't carry restaurant furniture like tables or chairs - Sia Huat focuses on kitchen, tableware, bar and F&B equipment.",
    "We're mainly kitchen, tableware and F&B equipment - no dining chairs or tables in our catalogue.",
    "We don't carry furniture.",
    "Sia Huat doesn't sell furniture or uniforms.",
    "We don't have any Q-posts.",
    "We don't sell packaging, sorry.",
    "We don't carry woks.",
    "We don't carry home furniture.",
  ]) {
    const review = claimReview(message, backed);
    assert.equal(denials(message).length, 1, message);
    assert.deepEqual(review.safety, [], message);
  }
  assert.match(denials("We don't carry furniture.")[0], /\(Furniture & Banquet Equipment\)\. Don't say we don't carry it: say what that range covers \(from SIA HUAT'S CATALOGUE RANGES\) and ask which type/);
  for (const message of [
    "We don't have a wok in 60cm.",
    "We don't carry woks in that size.",
    "We don't carry plates in 31cm, the closest is 30cm.",
    "We don't have a lid for that pot.",
    "We don't stock tumblers in 1L.",
    "We don't have any knives with a wooden handle in stock.",
    "I don't have a size guide for these jackets.",
    "We don't list a bowl in that colour.",
    "We don't sell pastries - we supply kitchen and F&B equipment.",
    "We don't carry Le Creuset cookware.",
    "We don't stock Corelle dinnerware.",
    "We don't carry Japanese dinnerware.",
    "Sorry, we don't sell mangoes - we're a kitchen and F&B equipment supplier.",
    "We don't carry a boxed 4-pax dinnerware set.",
    "We don't carry Damascus knives.",
    "We don't carry sofas.",
    "I don't have a range of sizes to compare against for this model.",
    "We don't list regular dining/cafe chairs (only baby/youth seating like high chairs).",
  ]) assert.deepEqual(claimReview(message, backed).style.filter((issue) => ["RANGE_DENIAL", "ABSENCE"].includes(issueCode(issue))), [], message);
});

test("a range denial is read against the ranges given: a range with no named section is no range", () => {
  const ranges = [
    ["Cookware", [["Asian Cookware", ["Woks"]]]],
    ["Dinnerware", [["Serving dishes", ["Serving casseroles and woks"]]]],
    ["Furniture & Banquet Equipment", [["Hotel Equipment", ["Q-posts"]], ["Tables", ["Folding tables"]]]],
    ["Books & Guides", []],
  ] as const;
  assert.equal(deniedRange("We don't carry furniture.", ranges), "Furniture & Banquet Equipment");
  // A type's whole name wins over part of another's: the repair names the range Claire should describe.
  assert.equal(deniedRange("We don't carry woks.", ranges), "Cookware > Asian Cookware > Woks");
  assert.equal(deniedRange("We don't have any Q-posts.", ranges), "Furniture & Banquet Equipment > Hotel Equipment > Q-posts");
  assert.equal(deniedRange("We're mainly kitchen gear - no dining chairs or tables in our catalogue.", ranges), "Furniture & Banquet Equipment > Tables");
  assert.equal(deniedRange("We don't carry folding tables in that size.", ranges), null);
  assert.equal(deniedRange("I don't have a guide for that.", ranges), null);
  assert.equal(deniedRange("We don't carry books.", ranges), null);
});

test("an out-of-stock claim needs every product it points at checked live as out of stock", () => {
  assert.equal(claimsOf("The two cheaper options I found (Kenwood x-Tract, Adler 2L) are both out of stock.").length, 1);
  assert.deepEqual(claimsOf("The Kenwood x-Tract is out of stock."), []);
  assert.equal(claimsOf("Beautex Kitchen Towel (4006) only has 1 pkt left in stock, and the Vinda Deluxe pkt is currently out of stock.").length, 1);
  assert.deepEqual(claimsOf("The 12QT pot is out of stock."), []);
  assert.deepEqual(claimsOf("GP111's stock isn't confirmed yet, so it may be out of stock."), []);
  assert.deepEqual(claimsOf("GP111 has no stock figure yet."), []);
  // Only the part that says out of stock is judged; "it" takes the part before.
  assert.deepEqual(claimsOf("The Kenwood x-Tract is out of stock, but the Adler 2L is worth a look."), []);
  assert.equal(claimsOf("Found the Adler 2L - but it's out of stock right now.").length, 1);
  // A plural subject ("are", "both", "all") takes in every product named before it; a bare "is" takes the nearest one named.
  for (const message of [
    "GF-33, GS-7 and XXGS-9 are out of stock.",
    "All Global knives I checked (GF-33, GS-7, XXGS-9) are out of stock.",
    "The two cheaper options I found (Adler 2L, Kenwood x-Tract) are out of stock.",
    "The Adler 2L and the Kenwood x-Tract are out of stock.",
    "Both the Adler 2L and the Kenwood x-Tract are sold out.",
    "The Adler 2L kettle, sadly, is out of stock.",
    "The Adler 2L isn't in stock right now.",
  ]) {
    assert.equal(claimsOf(message).length, 1, message);
  }
  for (const message of ["The XXGS-9 and the Kenwood x-Tract are both out of stock.", "The Kenwood x-Tract isn't in stock right now."]) {
    assert.deepEqual(claimsOf(message), [], message);
  }
});

test("a sentence that is both an unbacked stock claim and a 'we don't have it' is a stock claim", () => {
  const message = "The Adler 2L is out of stock, and we don't carry another 2L kettle.";
  assert.equal(claimsOf(message).length, 1);
  assert.deepEqual(absenceOf(message), []);
});

test("honest wording raises no claim, even with no searches", () => {
  for (const message of [
    "No other changes to your enquiry.",
    "Everything else on your enquiry stays the same.",
    "That's all added - anything else?",
    "That's all set: 2 Safico torches on your enquiry.",
    "Nothing else needed from you - the enquiry is saved.",
    "That's everything on your list.",
    "There are still more variants beyond these — want me to keep going by size?",
    "I don't have a separate spec on the metal handle",
    "I haven't found a boxed set yet - want me to check cutlery sets?",
    "Only 3 pcs of the ST-15 in stock, so I can't do 4.",
    "I couldn't find item code ABC-123 in our catalogue.",
    "I don't have a live price for the GP111 yet.",
    "I couldn't find the photo on my side",
    "Everything is in stock, so you're good to go.",
    "Nothing else to add?",
    "No other sizes showed up in this search, but there may be more.",
    "The only option now is to ask our sales team about a restock.",
    "No other questions from my side.",
    "Everything else looks fine.",
    // A product's parts and materials, or charges, not the range.
    "The handle is POM; everything else is stainless steel.",
    "No other assembly is needed.",
    "It needs no other attachments to knead dough.",
    "There's no other charge.",
    "No other fees apply at this stage.",
    "Let me know if there's nothing else you need.",
    // Not range summaries: prices, facts, stock counts, a series match, and a summary that says its own scope (V12).
    "All our prices are ex GST.",
    "All our products are priced ex GST.",
    "All our stock figures are live-checked.",
    "The only difference is the handle colour.",
    "The only thing I can't confirm is the weight rating.",
    "The only thing I have to check is the lid size.",
    "The only info I have on it is the capacity.",
    "On the MX1200XTX, we only have 12 units in stock right now.",
    "We only have 2 of the 30cm, so I've shown the 28cm too.",
    "We only have 12 of the 30cm, so I've shown the 28cm too.",
    // A fact word after "other" or a qualifier, "have to" and "is" aren't "the only X we have" either (review of V12).
    "The only other thing I have to check is the lid size.",
    "The only other thing we have to confirm is the delivery date.",
    "The only product info I have is the capacity.",
    "The only size info we have is 30cm.",
    "The only other detail I have on it is the Series.",
    "The only catch is we have to order it in.",
    "The only issue is I have no photo of it.",
    "The only reason I have to ask is the size.",
    "In stock, our Atlantic Chef 'Japanese Chef Knife' range is a Taiwan brand.",
    "Our Patra plates are the same series as your bowl.",
    "Of the ones I found, the only cordless option is the MX130.",
    "The only cordless option I found in stock is the MX130.",
    "So far the only cordless model that turned up is the MX130.",
    // The scope the claim repair asks for, with nothing between "only" and the noun.
    "Of the ones I found, the only option is the MX130.",
    "The Safico is the only option I found.",
    "The only one I can find in stock is the MX130.",
    // A price line with a word before "prices" (the GST prompt line).
    "All our listed prices are before GST.",
    "All our item prices are before GST.",
    // The list rule's pointer to sales: the customer's list, not our range (exam 3, s01-A/B T0).
    "You can also send the whole list to Sia Huat sales for a formal quote.",
    "You can send the full list straight to Sia Huat sales.",
    "Sia Huat sales can do a formal quote on the complete list.",
    "Sia Huat sales can do a formal quote for the entire list.",
  ]) {
    assert.deepEqual(claimReview(message).safety, [], message);
    assert.deepEqual(absenceOf(message), [], message);
  }
});

test("removeClaims drops only the unbacked claim sentences", () => {
  assert.equal(removeClaims("That covers our tong range. Want me to add any?", [], stockSeen), "Want me to add any?");
  assert.equal(removeClaims("Approx. 5L each. That covers our range.", [], stockSeen), "Approx. 5L each.");
  assert.equal(removeClaims("We don't carry boxed dining sets. Want cutlery?", [], stockSeen), "We don't carry boxed dining sets. Want cutlery?");
});

// A search backing every kind of range claim: two queries, a found category, listed in full.
const backing = [search({ queries: ["chef knife", "knives"], category: "chef knives", categoryFound: true, complete: true })];
const rangeIssues = (message: string, searches: SearchRecord[] = []) => {
  const review = claimReview(message, searches);
  return [...review.safety.map((issue) => `safety ${issueCode(issue)}`), ...review.style.filter((issue) => ["CLAIM", "ABSENCE"].includes(issueCode(issue))).map((issue) => `style ${issueCode(issue)}`)];
};

test("range wordings the round-4 guard missed need a backing search (exam 4)", () => {
  for (const [message, expected] of [
    // c03-A idx 8: "all our" with six words before "are".
    ["All our in-stock chef knives right now are Taiwan (Atlantic Chef) or Germany (Giesser) brands.", "safety CLAIM"],
    // c03-persona idx 4: "don't have anything". c03-A idx 6's "haven't found" is search-scoped: a Japan brand seen disproves it (below).
    ["I don't have anything actually made in Japan in the catalogue - we do have the Atlantic Chef 'Japanese Chef Knife' style (German steel 1.4116, POM handle), but Atlantic Chef is a Taiwan brand, so the 'Japanese' in the name refers to the knife style, not its origin.", "style ABSENCE"],
    // c04-persona idx 3, s09-B idx 1, c07-stress idx 4: rankings of the range, reworded but never removed.
    ["That's the one for home use we've got - the Kenwood Lite is actually quite versatile: 5 speeds plus pulse, and comes with both beaters and a dough kneader attachment, so it handles both baking (cakes, cream) and cooking tasks (batters, light dough).", "style CLAIM"],
    ["Two options: the Giesser (German brand, 28cm, ergonomic handle, bigger fish, GERMANY brand) at a higher price, or the all-stainless 21cm scaler which is more budget-friendly and in stock (21 units).", "style CLAIM"],
    ["We have two fish scalers: the Giesser 28cm and the 21cm one.", "style CLAIM"],
    // r4 s09-B idx 1, replayed: a bare count before a colon, a dash or the sentence end.
    ["We have two: the Giesser 28cm (Germany, ergonomic plastic handle, larger fish) and a smaller stainless steel one, L21cm.", "style CLAIM"],
    ["We have two - the 28cm and the 21cm.", "style CLAIM"],
    ["For scalers we have two.", "style CLAIM"],
    ["No worries, here are cheaper hand-held ones in stock: Waring Quik Stik (18cm shaft, 175W) is the most budget option.", "style CLAIM"],
    ["Bamix (39.5cm, 200W) I showed earlier is next up in price.", "style CLAIM"],
  ]) {
    assert.deepEqual(rangeIssues(message), [expected], message);
    assert.deepEqual(rangeIssues(message, backing), [], message);
  }
  for (const message of [
    "That's the one I'd recommend from what we have - German steel blade.",
    "We carry three main types: bar blenders, stick blenders and ice crushers.",
    "We have 2 units left.",
    "We have 2 left.",
    "We have two in stock.",
    "Of the Waring blenders I've shown, the MX1100 is the cheapest.",
    // Next steps, offers and questions rank nothing.
    "Two options: I can check with sales on restock, or show you the 28cm instead.",
    "There are two options: I can check with sales on restock, or show you the 28cm instead.",
    "We have two options: you can wait for restock or take the 28cm.",
    "We have two: I can add either one.",
    "Want me to look for the cheapest one?",
    "Would you like me to search for the most affordable option?",
    "I can check which is the cheapest if you like.",
    "Here's the one I have in mind: the Giesser 28cm.",
    "There are two differences: the MX1000 has a 64oz jar and the MX1200 has a timer.",
    "There are 3 things to check before you order.",
    "Between these two, the Zyliss is the cheapest.",
    // Nothing more to say is not a product we lack.
    "We don't have anything else to add.",
    "I don't have anything more on its warranty, Sia Huat sales can confirm.",
  ]) {
    assert.deepEqual(rangeIssues(message), [], message);
  }
  // An offer only excuses the ranking inside it, and a question the whole sentence.
  assert.deepEqual(rangeIssues("The Mika is the cheapest; I can check stock for you."), ["style CLAIM"]);
  assert.deepEqual(rangeIssues("We don't have anything else in 28cm."), ["style ABSENCE"]);
});

test("'between these' excuses a ranking of the cards shown, not a claim about the whole range", () => {
  assert.deepEqual(rangeIssues("Between these, that's our full range of tongs."), ["safety CLAIM"]);
  assert.deepEqual(rangeIssues("Among these, the Zyliss is the cheapest."), []);
});

test("a ranking of the range is a style issue that is never removed, so a failed repair can't turn it into a stand-in", () => {
  const message = "Waring Quik Stik is the most budget option. Want it?";
  const review = claimReview(message);
  assert.deepEqual(review.safety, []);
  assert.match(review.style.find((issue) => issue.startsWith(CLAIM_ISSUE_PREFIX)) ?? "", /isn't backed by this turn's searches: "Waring Quik Stik is the most budget option\."/);
  assert.equal(removeClaims(message, [], stockSeen), message);
});

const originSeen = (...items: Array<[Parameters<typeof product>[0], string | null]>) => new Map<string, CheckedProduct>(items.map(([overrides, origin]) => [
  overrides.stock_id, { product: product(overrides), verified: true, details: origin ? { "Country of Brand Origin": origin } : null },
]));
const disproved = (message: string, seen: Map<string, CheckedProduct>) => reviewAnswer({ message, card_ids: [], chips: [], show_contact: false }, seen, allowed, undefined, { searches: backing })
  .style.filter((issue) => issueCode(issue) === "ABSENCE");

test("a 'we don't have it' that a product seen this turn disproves names that product (exam 4, s03-B idx 1, c03-A idx 6)", () => {
  const rice = originSeen([{ stock_id: "EK9108S", name: "STAINLESS STEEL FOOD GRADE RICE DISPENSER", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }, null]);
  assert.deepEqual(disproved("I couldn't find a 'rice dispenser' by that name in the searches I ran.", rice), [
    `This 'we don't have it': "I couldn't find a 'rice dispenser' by that name in the searches I ran.". EK9108S (STAINLESS STEEL FOOD GRADE RICE DISPENSER) came up in this turn's results: if it is what the customer asked for, name it with its stock; if not, keep your sentence.`,
  ]);
  const global = originSeen([{ stock_id: "GF-34", name: "CHEF'S KNIFE", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }, "JAPAN"]);
  assert.match(disproved("I haven't found an actual Japan-made knife brand in our catalogue.", global).join(" "), /GF-34 \(CHEF'S KNIFE\) came up/);
  assert.equal(issueCode(disproved("I haven't found an actual Japan-made knife brand in our catalogue.", global)[0]), "ABSENCE");
  assert.equal(removeClaims("I haven't found an actual Japan-made knife brand in our catalogue.", [], global), "I haven't found an actual Japan-made knife brand in our catalogue.");
  // A product seen still disproves a name-scoped or search-scoped wording (r6 area N).
  assert.equal(disproved("We don't list anything called a 'rice dispenser'.", rice).length, 1);
  assert.equal(disproved("We don't carry anything called a 'rice dispenser'.", rice).length, 1);
  const chef = originSeen([{ stock_id: "GC-1", name: "CHEF KNIFE 20CM", available_quantity: 3 }, "JAPAN"]);
  assert.equal(disproved("I couldn't find a Japanese chef knife in our range.", chef).length, 1);
  assert.equal(disproved("I don't have a Japan-made chef knife available right now.", chef).length, 1);
  // A backed ranking in the same sentence doesn't excuse it.
  assert.equal(disproved("The cheapest one is the Atlantic Chef, as we don't carry Japanese chef knives.", chef).length, 1);
});

test("a product that doesn't fit the clause never disproves it", () => {
  // r2 c03-A idx 8: "available" rules out an out-of-stock Japan knife.
  const santoku = originSeen([{ stock_id: "G-80", name: "SANTOKU KNIFE", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }, "JAPAN"]);
  assert.deepEqual(disproved("Our Global brand knives (G-77, G-78, G-79) - which is the Japan-made brand we carry - are all currently out of stock or unverified, so I don't have a Japan-made chef knife available right now.", santoku), []);
  // r3 c03-persona idx 8: a brand's origin is not where it was made.
  const cheese = originSeen([{ stock_id: "GS-10", name: "Global Cheese Knife 14cm" }, "JAPAN"]);
  assert.deepEqual(disproved("I couldn't find a chef knife confirmed as made in Japan in the searches I ran.", cheese), []);
  // The same two skips where only they decide: a Japan chef knife out of stock, and one whose origin is only its brand's.
  const chefOut = originSeen([{ stock_id: "GC-1", name: "CHEF KNIFE 20CM", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }, "JAPAN"]);
  assert.deepEqual(disproved("I don't have a Japan-made chef knife available right now.", chefOut), []);
  const chefIn = originSeen([{ stock_id: "GC-1", name: "CHEF KNIFE 20CM", available_quantity: 3 }, "JAPAN"]);
  assert.deepEqual(disproved("I couldn't find a Japanese chef knife confirmed as made in Japan.", chefIn), []);
  // The sentence already names it, or it is the item find_alternatives looked around (a substitute for a quoted item is not the item).
  const riceIn = originSeen([{ stock_id: "EK9108S", name: "STAINLESS STEEL FOOD GRADE RICE DISPENSER", available_quantity: 2 }, null]);
  assert.deepEqual(disproved("I couldn't find a 'rice dispenser' other than the EK9108S stainless steel rice dispenser.", riceIn), []);
  assert.deepEqual(disproved("No close substitute for the 'rice dispenser' right now.", riceIn), []);
  const lookedAround = reviewAnswer({ message: "No close in-stock substitute for the Japanese chef knife.", card_ids: [], chips: [], show_contact: false }, chefIn, allowed, undefined, {
    searches: [...backing, search({ queries: [], alternativesFor: "GC-1" })],
  }).style.filter((issue) => issueCode(issue) === "ABSENCE");
  assert.deepEqual(lookedAround, []);
  // A one-word quote, another product sharing one word, and a quoted name of another country's brand.
  const stool = originSeen([{ stock_id: "FSS-2", name: "FOLDING STEP STOOL 2-STEP GREY" }, null]);
  assert.deepEqual(disproved("I couldn't find a 3-step stool in 'grey'.", stool), []);
  const bowl = originSeen([{ stock_id: "RB-1", name: "RICE BOWL 11CM WHITE" }, "JAPAN"]);
  assert.deepEqual(disproved("We don't carry Japanese rice cookers.", bowl), []);
  const atlantic = originSeen([{ stock_id: "5301T49", name: "Atlantic Chef Japanese Chef Knife 21cm, Pom Hdle" }, "TAIWAN"]);
  assert.deepEqual(disproved("I couldn't find a 'Japanese Chef Knife' actually made in Japan.", atlantic), []);
});

test("find_alternatives backs 'no substitute' (exam 4, s03-B idx 1: repaired after it had run)", () => {
  const message = "I couldn't find a close in-stock substitute for the Mastrad torch.";
  assert.equal(absenceOf(message).length, 1);
  assert.deepEqual(absenceOf(message, [search({ queries: [], alternativesFor: "F46700" })]), []);
  assert.deepEqual(absenceOf("Mastrad torch is out of stock, no direct substitute for it.", [search({ queries: [], alternativesFor: "F46700" })]), []);
  // It backs only the substitute: "we don't carry" still needs its searches.
  assert.equal(absenceOf("We don't carry Japanese torches, and I couldn't find a close substitute.", [search({ queries: [], alternativesFor: "F46700" })]).length, 1);
  // Every substitute wording in the sentence is backed, not only the first.
  assert.deepEqual(absenceOf("No close substitute, and I couldn't find a replacement either.", [search({ queries: [], alternativesFor: "F46700" })]), []);
});

test("the absence repair asks Claude to check this turn's results first, then to say we don't list anything by the customer's name and attach the closest products", () => {
  assert.ok(absenceOf("We don't carry boxed dining sets.")[0].endsWith(" First check this turn's results for it. If it isn't there, don't say Sia Huat doesn't carry it: say we don't list anything called '<the customer's words>' (without describing your searches), and attach the closest products from this turn's results; if the item isn't kitchen or F&B equipment at all, say what Sia Huat supplies instead."));
  // The wording it asks for is name-scoped, so the repaired reply isn't flagged again (r6 area N).
  assert.deepEqual(absenceOf("Sorry, we don't list anything called a 'boxed dining set'."), []);
});

test("an unbacked 'no substitute', 'another', 'in stock' or origin claim is repaired to 'couldn't find one', not to a name the catalogue may list", () => {
  // Exam 5: Japan-brand Global knives and the cordless RHB100U are listed but out of stock; "we don't list anything called 'made in
  // Japan'" or "... 'cordless hand blender'" would be false (review of D11).
  const find = " First check this turn's results for it. If it isn't there, don't say Sia Huat doesn't carry it: say you couldn't find one this time (without describing your searches), and attach the closest products from this turn's results.";
  const one = [search({ queries: ["stock pot 12L"] })];
  for (const message of ["That one is out of stock, and there's no close substitute right now.", "I don't have anything actually made in Japan.",
    "We don't carry Japanese knife brands.", "We don't have another cordless hand blender with a whisk.", "We don't have a 3-in-1 blender in stock."]) {
    const issues = absenceOf(message, one);
    assert.equal(issues.length, 1, message);
    assert.ok(issues[0].endsWith(find), message);
  }
  // "I couldn't find one this time" is let through.
  assert.deepEqual(absenceOf("I couldn't find one this time, but these are the closest.", one), []);
});

// r4 c03-stress idx 7: the P-16HD (35 in stock) was in the results, but the reply's card was the 13103-1601 (2 left).
const wokSeen = new Map<string, CheckedProduct>([
  ["P-15HD", { product: product({ stock_id: "P-15HD", name: "IRON WOK", available_quantity: 62 }), verified: true }],
  ["P-16HD", { product: product({ stock_id: "P-16HD", name: "IRON WOK", available_quantity: 35 }), verified: true }],
  ["13103-1501", { product: product({ stock_id: "13103-1501", name: "Iron Wok 15\"", available_quantity: 7 }), verified: true }],
  ["13103-1601", { product: product({ stock_id: "13103-1601", name: "Iron Wok 16\"", available_quantity: 2 }), verified: true }],
]);
const wokMessage = "Yes, we've got iron woks good for zichar-style stir frying - traditional carbon iron, high sloping sides. A few options in stock: 15in Iron Wok (62 available), 16in Iron Wok (35 available), or 20in Iron Wok (only 4 left, so tight for 4pcs). Which size do you need?";
const stockNumberIssues = (message: string, cardIds: string[], seen = wokSeen) => reviewAnswer({ message, card_ids: cardIds, chips: [], show_contact: false }, seen, allowed)
  .style.filter((issue) => issueCode(issue) === "STOCK_NUMBER");

test("a typed stock count must match the live stock of the one card it points at (exam 4, c03-stress idx 7)", () => {
  assert.deepEqual(wrongStockCounts(wokMessage, [wokSeen.get("13103-1601")!.product], wokSeen).map(({ said, code, live, alsoMatches }) => [said, code, live, alsoMatches.map((item) => item.stock_id)]), [
    ["35 available", "13103-1601", 2, ["P-16HD"]],
  ]);
  assert.deepEqual(stockNumberIssues(wokMessage, ["13103-1601"]), [
    `These stock numbers don't match the live stock: "35 available" for 13103-1601 (live 2); 35 matches P-16HD IRON WOK: if you meant that product, attach its card instead. Give each product's available_quantity, or leave the number out; never say stock changed.`,
  ]);
  // "15in Iron Wok" points at the 13103-1501, not the P-15HD card, so its 62 isn't judged.
  assert.deepEqual(stockNumberIssues(wokMessage, ["P-15HD"]), []);
});

test("stock counts are judged one by one, and never an approximate count or one in another unit", () => {
  const toasters = new Map<string, CheckedProduct>([
    ["HET-4", { product: product({ stock_id: "HET-4", name: "Pop-Up Toaster 4 Slot", available_quantity: 5 }), verified: true }],
    ["HET-6", { product: product({ stock_id: "HET-6", name: "Pop-Up Toaster 6 Slot", available_quantity: 3 }), verified: true }],
  ]);
  const twice = "The 4-slot toaster has 5 available, and the 6-slot toaster has 5 available too.";
  const cards = [...toasters.values()].map((item) => item.product);
  assert.deepEqual(wrongStockCounts(twice, cards, toasters).map((wrong) => [wrong.code, wrong.index]), [["HET-6", twice.lastIndexOf("5 available")]]);
  assert.equal(withoutWrongStockCounts(twice, cards, toasters), "The 4-slot toaster has 5 available, and the 6-slot toaster is in stock too.");
  const spoons = new Map<string, CheckedProduct>([["SP-12", { product: product({ stock_id: "SP-12", name: "Wave Dinner Spoon", uom_id: "DOZ", available_quantity: 3 }), verified: true }]]);
  assert.deepEqual(wrongStockCounts("The Wave dinner spoon has 36 pcs available.", [spoons.get("SP-12")!.product], spoons), []);
  assert.deepEqual(wrongStockCounts("The Wave dinner spoon (over 30 available) is a good match.", [spoons.get("SP-12")!.product], spoons), []);
  // A code's digits are not a count, nor is "left-handed".
  assert.deepEqual(wrongStockCounts("There are 9 HET-6 units in stock currently.", cards, toasters), []);
  assert.deepEqual(wrongStockCounts("The 6-slot toaster has 2 left-handed dials.", cards, toasters), []);
});

test("a count with a thousands comma is read whole (4-digit live stock, SB3038 has 2702)", () => {
  const scissors = new Map<string, CheckedProduct>([
    ["SB3038", { product: product({ stock_id: "SB3038", name: "Shibazi Household Scissors L21cm", available_quantity: 2702 }), verified: true }],
    ["KS-1", { product: product({ stock_id: "KS-1", name: "Kitchen Shears", available_quantity: 1500 }), verified: true }],
  ]);
  const card = [scissors.get("SB3038")!.product];
  for (const message of ["For basic use, the SB3038 Shibazi scissors (2,702 in stock) are the pick.", "The Shibazi Household Scissors have 2,702 available."]) {
    assert.deepEqual(stockNumberIssues(message, ["SB3038"], scissors), [], message);
    assert.equal(withoutWrongStockCounts(message, card, scissors), message);
  }
  const wrong = "The SB3038 Shibazi scissors (1,500 in stock, plenty for 4) are basic.";
  assert.deepEqual(wrongStockCounts(wrong, card, scissors).map(({ said, live }) => [said, live]), [["1,500 in stock", 2702]]);
  assert.match(stockNumberIssues(wrong, ["SB3038"], scissors)[0], /"1,500 in stock" for SB3038 \(live 2702\); 1500 matches KS-1 Kitchen Shears/);
  assert.equal(withoutWrongStockCounts(wrong, card, scissors), "The SB3038 Shibazi scissors are basic.");
});

test("a wrong count left after the repair is dropped from its bracket, else said as in stock or out of stock, never another number", () => {
  const card = [wokSeen.get("13103-1601")!.product];
  assert.equal(withoutWrongStockCounts("The 16in Iron Wok (35 available) suits zichar.", card, wokSeen), "The 16in Iron Wok suits zichar.");
  // A coverage claim made from the count goes with it: 2 left is not plenty for 4.
  assert.equal(withoutWrongStockCounts("The 16in Iron Wok (only 35 left, plenty for 4) suits zichar.", card, wokSeen), "The 16in Iron Wok suits zichar.");
  assert.equal(withoutWrongStockCounts("The 16in Iron Wok (carbon iron, 35 in stock — matches your qty) is good.", card, wokSeen), "The 16in Iron Wok (carbon iron) is good.");
  assert.equal(withoutWrongStockCounts("The 16in Iron Wok has 35 in stock.", card, wokSeen), "The 16in Iron Wok is in stock.");
  // Two wrong counts in one bracket: fixing the last one moves the first, so each is found again in the fixed text.
  for (const message of ["The 16in Iron Wok (plenty for 4, 35 available, 12 left) is solid.", "The 16in Iron Wok ( 35 available, 12 left) is solid."]) {
    assert.equal(withoutWrongStockCounts(message, card, wokSeen), "The 16in Iron Wok is solid.", message);
  }
  // Real phrasings from rounds 2-4 (r2 c03-A idx 9, s06-B idx 0) and the ways to say "we have N".
  for (const [message, fixed] of [
    ["The 16in Iron Wok has exactly 35 pcs left, enough for your 4.", "The 16in Iron Wok is in stock."],
    ["The 16in Iron Wok is in stock with 35 pcs available.", "The 16in Iron Wok is in stock."],
    ["The 16in Iron Wok: we have 35 in stock.", "The 16in Iron Wok: it's in stock."],
    ["The 16in Iron Wok: there are 35 left.", "The 16in Iron Wok: it's in stock."],
  ]) {
    assert.equal(withoutWrongStockCounts(message, card, wokSeen), fixed, message);
  }
  const soldOut = new Map<string, CheckedProduct>([["13103-1601", { product: product({ stock_id: "13103-1601", name: "Iron Wok 16\"", stock_status: "out_of_stock", in_stock: false, available_quantity: 0 }), verified: true }]]);
  assert.equal(withoutWrongStockCounts("16in Iron Wok: 35 available.", [soldOut.get("13103-1601")!.product], soldOut), "16in Iron Wok: out of stock.");
});

test("saying all the cards are in stock when one isn't is a style issue", () => {
  const card = (stock_id: string, stock_status: "in_stock" | "out_of_stock" | "unknown") => product({
    stock_id, stock_status, in_stock: stock_status === "in_stock", available_quantity: stock_status === "in_stock" ? 5 : null,
  });
  const [inStock, out, unchecked] = [card("IN", "in_stock"), card("OUT", "out_of_stock"), card("UNK", "unknown")];
  assert.match(stockIssues("Here are 3 porcelain options in stock.", [inStock, out]).join(" "), /OUT \(out of stock\)/);
  assert.match(stockIssues("These are all confirmed in stock.", [inStock, unchecked]).join(" "), /stock not checked/);
  assert.deepEqual(stockIssues("Both are in stock.", [inStock, card("IN2", "in_stock")]), []);
  for (const message of ["The first is in stock; the second is out of stock.", "Both are 0 in stock.", "Both are not available now.", "All in stock except the Severin, which is out of stock."]) {
    assert.deepEqual(stockIssues(message, [inStock, out]), [], message);
  }
  const unverified = new Map<string, CheckedProduct>([...seen, ["OLD", { product: card("OLD", "unknown"), verified: false }]]);
  const review = reviewAnswer({ message: "Both are in stock.", card_ids: ["BTS-8026D", "OLD"], chips: [], show_contact: false }, unverified, allowed);
  assert.equal(review.style.filter((issue) => /OLD \(stock not checked\)/.test(issue)).length, 1);
  assert.equal(issueCode(review.style.find((issue) => /stock not checked/.test(issue))!), "CLAIM");
});

const torchLink = "https://store.siahuat.com/product/8475553620";
const linked = new Map<string, CheckedProduct>([["BTS-8026D", { product: product({ stock_id: "BTS-8026D", list_price: 23.36, source_url: torchLink }), verified: true }]]);
const noEarlier: EarlierTurns = { cardSets: [], previousMessage: null, currentText: "" };
const linkReview = (message: string, earlier: Partial<EarlierTurns> = {}, card_ids: string[] = []) => reviewAnswer(
  { message, card_ids, chips: [], show_contact: false }, linked, allowed, { ...noEarlier, ...earlier },
);
const linkIssues = (message: string, earlier: Partial<EarlierTurns> = {}) => linkReview(message, earlier).safety.filter((issue) => issue.startsWith(LINK_ISSUE_PREFIX));

test("a store link must come from this turn's tool results or the chat", () => {
  for (const message of ["Photos: store.siahuat.com/product/8321T05-R (21cm)", "See https://store.siahuat.com/product/8321T61-R for the 25cm.", "Try store.siahuat.com/product/999999."]) {
    assert.equal(linkIssues(message).length, 1, message);
    assert.equal(issueCode(linkIssues(message)[0]), "LINK");
  }
  assert.match(linkIssues("Photos: store.siahuat.com/product/8321T05-R and store.siahuat.com/product/8321T61-R.")[0], /8321T05-R, store\.siahuat\.com\/product\/8321T61-R\./);
  for (const message of [`Photos: ${torchLink}`, "Photos: store.siahuat.com/product/8475553620.", `See ${torchLink}#rt`, "Browse store.siahuat.com for more.", "Here: https://store.siahuat.com/"]) {
    assert.deepEqual(linkIssues(message), [], message);
  }
  assert.deepEqual(linkIssues("The earlier one: store.siahuat.com/product/123456", { links: ["https://store.siahuat.com/product/123456"] }), []);
});

test("a known link next to Chinese punctuation, an em dash or a curly quote is not flagged, and removal keeps the rest", () => {
  for (const message of [`链接：${torchLink}。`, `${torchLink}—the 21cm one`, `“${torchLink}”`]) assert.deepEqual(linkIssues(message), [], message);
  const madeUp = "store.siahuat.com/product/8321T05-R";
  assert.deepEqual(linkIssues(`链接 ${madeUp}。`).length, 1);
  assert.equal(removeLinks(`链接 ${madeUp}。`, [madeUp]), "链接 store.siahuat.com。");
  assert.equal(removeLinks(`Photos: ${madeUp}. Or ${torchLink}.`, [madeUp]), `Photos: store.siahuat.com. Or ${torchLink}.`);
});

test("a link the customer says doesn't open is not typed again, and their browser is not blamed", () => {
  const broken = { previousMessage: `Here's the torch: ${torchLink}`, previousLinks: [torchLink] };
  const linkStyle = (message: string, currentText: string, card_ids: string[] = []) => linkReview(message, { ...broken, currentText }, card_ids).style;
  assert.deepEqual(linkStyle(`Sorry! Here it is again: ${torchLink}`, "torch link cannot open leh"), [BROKEN_LINK_ISSUE]);
  assert.deepEqual(linkStyle("Sorry about that, here it is.", "torch link cannot open leh", ["BTS-8026D"]), [BROKEN_LINK_ISSUE]);
  assert.deepEqual(linkStyle("Sorry about that, here it is.", "link cannot open, just add 2", ["BTS-8026D"]), []);
  assert.deepEqual(linkStyle("It loads fine here; try an incognito window.", "Same link. Still not working"), [LINK_BLAME_ISSUE]);
  assert.deepEqual(linkStyle("Sorry about that. It's item BTS-8026D; you can search that code on the store.", "torch link cannot open leh"), []);
  assert.deepEqual(linkStyle(`Here it is again: ${torchLink}`, "send the torch link again"), []);
  // A page that opens without a photo is no broken link (c04-stress: the only texts the no-photo branch ever matched).
  assert.deepEqual(linkStyle(`Sorry! Here it is again: ${torchLink}`, "got pic or not? i open the link also no picture leh"), []);
  assert.equal(issueCode(BROKEN_LINK_ISSUE), "LINK");
});

test("brokenLinkCodes gives the linked cards the customer says don't open: those named in the last reply, else anywhere, else all the last reply's", () => {
  const zyliss: ShownCard = { code: "E910076", name: "Zyliss Stainless Steel Household Scissors", price: 29.27, link: "https://store.siahuat.com/product/14717370014" };
  const zylissBasic: ShownCard = { code: "E910077", name: "Zyliss Polypropylene Basic Household Scissors Basic, Gray", price: 22.84, link: "https://store.siahuat.com/product/14717370015" };
  const shibazi: ShownCard = { code: "SB3038", name: "Stainless Steel Household Kitchen Scissors L21cm, Shibazi", price: 7.25, link: "https://store.siahuat.com/product/14717605813" };
  const detachable: ShownCard = { code: "SB3027", name: "Stainless Steel Detachable Household Kitchen Scissors L20.5cm, Shibazi", price: 10, link: "https://store.siahuat.com/product/14717605800" };
  const shown = (...sets: ShownCard[][]) => sets.map((cards) => ({ cards }));
  assert.deepEqual(brokenLinkCodes("Zyliss link not working", shown([zyliss, shibazi])), ["E910076"]);
  assert.deepEqual(brokenLinkCodes("same link la!! still cannot open", shown([zyliss, shibazi])), ["E910076", "SB3038"]);
  // r4 c08-stress idx 5: the code typed.
  assert.deepEqual(brokenLinkCodes("u say wont send but the card below still same link lor. i search E910076 on ur website also nothing come out", shown([zyliss])), ["E910076"]);
  // r3 c08-persona idx 4: the Zyliss card was two replies back.
  assert.deepEqual(brokenLinkCodes("I want the Zyliss one not these. Link still doesn't open", shown([zyliss, shibazi], [detachable])), ["E910076"]);
  assert.deepEqual(brokenLinkCodes("zyliss link cannot open leh", shown([zyliss, zylissBasic])), ["E910076", "E910077"]);
  assert.deepEqual(brokenLinkCodes("link can open la, just no photo", shown([zyliss])), []);
  assert.deepEqual(brokenLinkCodes("the zyliss one, 2 pcs", shown([zyliss])), []);
  // "still no" or "still not" alone is no broken link, but a page that still won't open is.
  for (const text of ["i open the link still no photo", "link ok but still no pic", "still not sure which, the website say 5 dollar"]) assert.deepEqual(brokenLinkCodes(text, shown([zyliss])), [], text);
  for (const text of ["Same link. Still not working", "the zyliss page still no open"]) assert.deepEqual(brokenLinkCodes(text, shown([zyliss])), ["E910076"], text);
});

test("a reply saying a line the browser still holds was removed is flagged, and fixed with one whole sentence", () => {
  // exam 3, c08-stress T12: SB3027's re-check timed out and Claire said "an earlier step accidentally removed" it.
  const scissors = new Map<string, CheckedProduct>([["SB3027", { product: product({ stock_id: "SB3027", name: "Detachable Kitchen Scissors" }), verified: false }]]);
  const review = (message: string, turn: Partial<TurnFacts>) => reviewAnswer({ message, card_ids: [], chips: [], show_contact: false }, scissors, allowed, undefined, { lines: [], changes: [], searches: [], ...turn });
  const lost = "Sorry, an earlier step accidentally removed your SB3027 line from the enquiry.";
  const flagged = review(`${lost} You can buy it on our website.`, { unchecked: ["SB3027"] });
  assert.deepEqual(flagged.safety.map(issueCode), ["KEPT_LINE"]);
  assert.ok(flagged.safety[0].startsWith(`${KEPT_LINE_PREFIX}: "${lost}"`));
  assert.equal(withoutKeptLineClaims(`${lost} You can buy it on our website.`, ["SB3027"], []), "SB3027 is still on your enquiry. You can buy it on our website.");
  assert.deepEqual(review("SB3027 is still on your enquiry.", { unchecked: ["SB3027"] }).safety, []);
  assert.deepEqual(review(lost, {}).safety, []);
  assert.deepEqual(review("Done, SB3027 is removed from your enquiry.", { unchecked: [], changes: [{ action: "remove", code: "SB3027" }] }).safety, []);
  assert.deepEqual(review(lost, { unchecked: ["SB3027"], changes: [{ action: "remove", code: "sb3027" }] }).safety.filter((issue) => issueCode(issue) === "KEPT_LINE"), []);
  // With SB3027 not looked up this turn (its catalogue lookup failed), the enquiry-claim check leaves the sentence to this one.
  const notLookedUp = reviewAnswer({ message: lost, card_ids: [], chips: [], show_contact: false }, new Map(), allowed, undefined, { lines: [], changes: [], searches: [], unchecked: ["SB3027"] });
  assert.deepEqual(notLookedUp.safety.map(issueCode), ["KEPT_LINE"]);
  assert.equal(enquiryClaimIssues(lost, { lines: [], changes: [], seen: new Map() }).length, 1);
  // Only a typed code counts, and only with a loss word.
  assert.deepEqual(review("Your scissors were removed from the enquiry.", { unchecked: ["SB3027"] }).safety.filter((issue) => issueCode(issue) === "KEPT_LINE"), []);
  assert.deepEqual(review("SB3027 couldn't be re-checked just now.", { unchecked: ["SB3027"] }).safety, []);
});

test("a kept line's product features and a denial that it was removed are not loss claims", () => {
  const claims = (message: string) => keptLineClaims(message, ["SB3027"], []).map((claim) => claim.sentence);
  // A fixed product fact would be lost ("SB3027 is still on your enquiry."), and a denial is already true.
  for (const message of [
    "The SB3027 blades can be removed for easy washing.", "SB3027 wasn't removed, it's in your enquiry bar.", "SB3027 has not been removed.",
    "SB3027 is still on your enquiry, nothing was removed.",
  ]) assert.deepEqual(claims(message), [], message);
  // "still" excuses only "still on/in"; "isn't on your enquiry" is a loss claim too.
  for (const message of ["SB3027 is still missing from your enquiry.", "SB3027 isn't on your enquiry anymore.", "SB3027 isn’t in the enquiry now."]) {
    assert.deepEqual(claims(message), [message], message);
  }
});
