// src/lib/agent/guards.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import type { CheckedProduct } from "./facts";
import {
  DANGLING_CURRENCY_ISSUE, ENQUIRY_CLAIM_PREFIX, MID_SENTENCE_ISSUE, MONEY_ISSUE_PREFIX, NO_CARD_PREFIX, NO_PERMISSION_ISSUE, NO_SHOW_PERMISSION_ISSUE, PROMISE_LATER_ISSUE,
  RESERVATION_ISSUE, allowedCents, applyFixers, customerMessage, endsMidSentence, enquiryClaimIssues, issueCode, noCardFixer, removeAmounts, reviewAnswer, tidyMessage,
  unverifiedAmounts, withoutEnquiryClaims, type EarlierTurns, type FinalAnswer, type TurnFacts,
} from "./guards";
import { product } from "./testing";
import type { EnquiryChange } from "./tools";

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
  for (const chip of ["2", "5 pcs", "two", "两个", "Yes, $99 one"]) {
    const result = review([chip, "Cooking"]);
    assert.deepEqual(result.chips, ["Cooking"], chip);
    assert.deepEqual([...result.safety, ...result.style], [], chip);
  }
  assert.deepEqual(review(["A chip that is far too long to fit on one button"]).chips, []);
  assert.deepEqual(review(["Cooking", "Desserts", "Grilling", "Bar"]).chips, ["Cooking", "Desserts", "Grilling"]);
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
    "好的，价格是 $16.97（不含消费税）", "推荐「不锈钢汤锅」",
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
});

test("a card set already shown twice is flagged unless the customer asks for it again", () => {
  const answer = { message: "The Safico one is lighter.", card_ids: ["BTS-8026D"], chips: [], show_contact: false };
  const earlier = { cardSets: [["BTS-8026D"], ["OLD", "BTS-8026D"], ["bts-8026d"]], previousMessage: "Here you go.", currentText: "any others?" };
  assert.match(reviewAnswer(answer, seen, allowed, earlier).style.join(" "), /You've already shown these same cards twice\. Show different options, or none\./);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, currentText: "show me those again" }).style, []);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, cardSets: [["BTS-8026D"], ["OLD", "BTS-8026D"]] }).style, []);
});

test("repeating the previous message word for word is flagged", () => {
  const answer = { message: "Which size do you need?", card_ids: [], chips: [], show_contact: false };
  const earlier = { cardSets: [], previousMessage: "which size do you need", currentText: "not sure" };
  assert.deepEqual(reviewAnswer(answer, seen, allowed, earlier).style, ["Don't repeat your previous message word for word; move the conversation forward."]);
  assert.deepEqual(reviewAnswer(answer, seen, allowed, { ...earlier, previousMessage: "What will you use it for?" }).style, []);
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
  for (const text of ["where the product?? show me then i tap la", "ok show me the card, i tap", "show me that one"]) assert.deepEqual(styleFor(text), [], text);
  for (const text of ["hello police?", "any others?", "wah still nvr ans how much"]) assert.match(styleFor(text).join(" "), /already shown these same cards twice/, text);
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
  ]) {
    assert.equal(claimIssues(message).length, 1, message);
  }
  const torchAdded = { lines: [line("BTS-8026D", 2)], changes: [added("BTS-8026D")] };
  for (const message of ["Got it: 2 Safico torches. Anything else?", "You've added 2 Safico torches so far."]) {
    assert.deepEqual(claimIssues(message, torchAdded), [], message);
  }
  assert.equal(issueCode(claimIssues("Noted: 2 torches.")[0]), "ENQUIRY_CLAIM");
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
  ]) {
    assert.deepEqual(claimIssues(message), [], message);
  }
  assert.deepEqual(claimIssues("Your updated total is $46.72.", { lines: [line("BTS-8026D", 2)] }), []);
});

test("a false claim is replaced by one plain line where the first one was", () => {
  const facts = { lines: [line("RS-J1009-7", 4)], changes: [added("RS-J1009-7")], seen: shop };
  assert.equal(withoutEnquiryClaims("Plate qty 4 done. Let me add the bowl too. Anything else?", facts), "Plate qty 4 done. That change isn't on your enquiry yet. Anything else?");
  assert.equal(withoutEnquiryClaims("Added the spoons. Added the rice bowls too.", { ...facts, seen: shop }), "That change isn't on your enquiry yet.");
  // The torch is on the enquiry at 2, so the line must not say it isn't there at all.
  assert.equal(withoutEnquiryClaims("Updated: 5 Safico torches now.", { lines: [line("BTS-8026D", 2)], changes: [], seen: shop }), "That change isn't on your enquiry yet.");
  assert.equal(withoutEnquiryClaims("Here you go.", facts), "Here you go.");
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
  // Asking to check stock or show a card is not about adding.
  const checkStock = styleWith("The Safico fits. Want me to check stock on it?", ["BTS-8026D"]);
  assert.ok(checkStock.includes(NO_SHOW_PERMISSION_ISSUE) && !checkStock.includes(NO_PERMISSION_ISSUE));
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
