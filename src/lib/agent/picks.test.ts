// src/lib/agent/picks.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ShownCard } from "./contract";
import { customerChose, hits, pickEvidence, pickedCodes, pointedCards, type PickEvidence, type PickReply, type PickTap, type PickText } from "./picks";

const card = (code: string, name: string, price: number | null = 10): ShownCard => ({ code, name, price, link: null });
const reply = (cards: ShownCard[], text = "Here you go."): PickReply => ({ cards, text });
const said = (text: string, seen: number, age = 0, chip = false): PickText => ({ text, seen, age, chip });
const tap = (code: string, seen: number, age: number): PickTap => ({ code, seen, age });
const chose = (code: string, quantity: number | null, picks: Partial<PickEvidence>, lineCodes: string[] = []) =>
  customerChose(code, quantity, { taps: [], texts: [], replies: [], ...picks }, lineCodes);

const greeting = reply([], "Hi, I'm Claire. What are you looking for?");
const blowtorch = card("970S", "KITCHEN BLOW TORCH 970S", 31.31);
const mastrad = card("F46700", "Mastrad Cooking Torch", 40);
const safico = card("BTS-8026D", "CASSETTE GAS TORCH BURNER SAFICO PRO", 23.36);
const luminarc = card("Q1930", "Luminarc Everyday Opal Glass Dinner Plate Ø24cm", 5.41);
const carrara = card("F3-CRR-01009-27", "Cerabon Petye Carrara Porcelain Round Dinner Plate Ø27.5cm", 24.68);
const tigerEye = card("F2-TGE-01002-25", "PORCELAIN ROUND DINNER PLATE Ø25cm, TIGER EYE, CERABON by PE", 19.17);
const ovalPlate = card("P5608", "Royal Porcelain Mood Oval Plate 18x33cm", 22.34);
const mx130 = card("MX130", "Dynamic Mini Cordless Mixer 45x11cm, 10,00Rpm, 230V/220W, Capacity 4Ltr", 563.3);
const handMixer = card("HMP30.A0-WH", "Kenwood Hand Mixer With 5 Speed Come With Pulse Function, Stainless Steel Beaters & Kneader, 220-240V, 450W, White, Lite", 73.3);
const standMixer = card("KMX751ARD", "Kenwood Stand Mixer L38.5xW24xH34.5cm, 5L, 220-240V, 1000W, Red, KMIX, Kenwood ==1 Year Warranty==", 641.28);
const handBlender = card("RHB100U", "Cuisinart Cordless Hand Blender With Whisk & 250ml Mini Chopper, 240V/50-60Hz, Pro == 1 Year Warranty, Domestic Use ==", 277.06);
const mightyMixer = card("MX010", "Dynamic Mighty Handy Mixer 18cm, 2Gal,230V/50Hz", 492.66);
const waring2l = card("MX1100XTXEE", "Waring Commercial Electronic Blender With Bpa-Free Container, 2L", 1288.99);
const waring64 = card("MX1000XTXEE", "Waring Commercial Hi-Power Blender With 64 Oz. Bpa-Free Copolyester Container", 1220.18);
const waringGallon = card("CB15K", "Waring Commercial One-Gallon 3.75 Hp Food Blender With Electronic Keypad", 3223.85);
const mika = card("MK-768L", "Mika Bar Blender with Pc Container, 2.0Liter, 2Hp/1500with 2", 273.83);
const braun = card("JB9040", "Braun Blender With Tritan Jug With 10 Speeds & Multi-Speed Pulse", 366.06);
const toaster4 = card("HET-4", "S/S 4-SLOTS TOASTER, 340x230x250mm, 230V/50Hz/1800W, •1 YEAR WARRANTY•", 196.36);
const toaster6 = card("HET-6", "Stainless Steel 6-Slots Toaster,230V/50Hz/2500W", 257.85);
const waringToaster = card("WCT708K", "Waring 4-Slots Toaster, Slot Width 1.3/8\"", 408.26);
const tong12 = card("UT12HR", "Stainless Steel Utility Tong with Locking Ring 12\"", 4.77);
const tong16 = card("UT16HR", "Stainless Steel Utility Tong with Locking Ring 16\"", 5.69);
const sponge = card("7443", "3M S/B Gen Purpose Scrub Sponge, 3x4\", 6Pcs/Pkt, 54Pkts/Ctn", 6.33);
const towel = card("4006", "Beautex Kitchen Towel (Pulp), 6Rolls X 60Sheets", 5.79);
const knife = card("2527-001", "STAINLESS STEEL DINNER KNIFE", 1.1);
const fork = card("2527-002", "STAINLESS STEEL DINNER FORK", 1.01);
const spoon = card("2527-003", "S/S DINNER SPOON L20cm, WAVE", 1.01);
const chefKnife16 = card("8455-16", "CHEF'S KNIFE 16cm w/WIDE BLADE, PLC HDLE, GIESSER", 32.94);
const cookKnife16 = card("8456-16", "Giesser Cook's Knife 16cm With Narrow Blade, Plastic Handle", 29.82);
const chefKnife26 = card("8455-26", "CHEF'S KNIFE 26cm w/WIDE BLADE, PLC HDLE, GIESSER", 47.25);
const cheapStrainer = card("HL00700100301-N", "Stainless Steel U-Shape Noodle Strainer With Black Handle 17cm", 5.69);
const meshStrainer = card("13122-0304", "Stainless Steel Strainer Fine Mesh With Stainless Steel Handle 10.5\"", 18.53);
const oilStrainer = card("HL168", "STAINLESS STEEL FINE MESH OIL STRAINER WITH BAMBOO HANDLE", 22.2);
const deepStrainer = card("HL164", "STAINLESS STEEL DEEP NOODLE STRAINER WITH BAMBOO HANDLE", 50);
const oilStrainer9 = card("HL169", "STAINLESS STEEL FINE MESH OIL STRAINER WITH BAMBOO HANDLE", 25.87);
const skimmer = card("13128-0401", "S/S FINE MESH SKIMMER Ø15cm", 2.29);
const scissors = card("E910076", "Zyliss Stainless Steel Household Scissors", 29.27);
const wok = card("P-16HD", "IRON WOK 16\" w/HANDLE", 13.03);
const siliconeTong = card("02-00864", "Safico Stainless Steel Tong With Silicone Grip L32cm, BPA Free", 11.83);
const stool = card("FSS", "Vicando Two-Step Folding Stepstool W49xH58cm, Grey", 53.67);
const steakTong = card("ST-15", "Stainless Steel Steak Tong 15\"", 12.48);
const zylissBasic = card("E910077", "Zyliss Polypropylene Basic Household Scissors Basic, Gray", 22.84);
const shibazi = card("SB3038", "Stainless Steel Household Kitchen Scissors L21cm, Shibazi", 7.25);
const shibaziDetachable = card("SB3027", "Stainless Steel Detachable Household Kitchen Scissors L20.5cm, Shibazi", 10);
const zebra = card("993-003-RD", "Zebra Multi-Purpose Scissors 22.5cm,Red, Together", 19.17);
const atlantic = card("9300T01", "Atlantic Chef Detachable Scissors", 27.43);
const skimmer165 = card("13128-0402", "S/S FINE MESH SKIMMER Ø16.5cm", 2.75);
const skimmer19 = card("13128-0403", "S/S FINE MESH SKIMMER Ø19cm", 3.21);
const skimmer24 = card("13128-0405", "S/S FINE MESH SKIMMER Ø24cm", 5.05);
const wireMesh26 = card("00600500104", "Stainless Steel Wire Mesh Strainer With Wooden Handle 26cm", 7.25);
const tong9 = card("UT09L", "Stainless Steel Utility Tong 9\"", 2.02);
const plainTong16 = card("2564L", "Stainless Steel Utility Tong 16\"", 3.85);
const scallopTong = card("JQ-OT113", "STAINLESS STEEL SCALLOP TONG with PLASTIC HANDLE", 3.85);
const edlund16 = card("36670", "Edlund Stainless Steel Heavy Duty Grip Tong 16\"", 34.86);
const edlundLock = card("34471", "S/S HD SCALLOP TONG WITH LOCK 12\", EDLUND", 27.52);
const santos = card("FHA24-33GE", "Santos Bar Blender With Polycarbonate Container L18xW18xH42cm, 1.25L, 220-240V/50/60/1, 600W, Uk Plug, Painted Grey, Santos ==1 Year Warranty==", 614.68);
const waringQuiet = card("MX1500XTXSEE", "Waring Programmeable Electronic Blender With Sound Enclosure And Bpa-Free Container, 2L, 45000Rpm", 1822.94);
const waringVariable = card("MX1200XTXEE", "Waring Commercial Blender With Bpa-Free Stackable Container, Variable-Speed, 2L", 1535.78);
const santos66 = card("66", "Santos Compact Brushless Blender 1.4L", 1759.63);
const patraPlate = card("3500-0018", "Patra Rim Plate 18cm, Porcelain White", 7.8);
const patraBowl = card("3500-3011", "Patra Rice Bowl 11.5cm, Porcelain White", 7.52);
const rocaBowl = card("02002-11", "Roca by Cerabon Rice Bowl Ø109xH50mm", 7.25);
const cutlery = card("R-52568-81", "Sambonet 18/10 Stainless Steel Cutlery Set, 24 Pieces, Mirror Finish, Bloom", 266.97);
const mould60 = card("158-19", "CCK Round Fluted Alum Tart Mould #19,Dia 60Mm", 0.64);
const mould70 = card("158-12", "CCK Round Fluted Aluminium Tart Mould #12,Ø70mm", 0.64);
const plate24 = card("P-24", "Porcelain Dinner Plate 24cm", 5);
const plate27 = card("P-27", "Porcelain Dinner Plate 27cm", 8);
const plate30 = card("P-30", "Porcelain Dinner Plate 30cm", 12);

test("a card tapped earlier is still the pick after a How many? reply with no card", () => {
  const picks = { taps: [tap("UT16HR", 2, 1)], texts: [said("4 can", 3)], replies: [greeting, reply([tong12, tong16]), reply([], "How many do you need?")] };
  assert.equal(chose("UT16HR", 4, picks), true);
  assert.equal(chose("UT12HR", 4, picks), false);
});

test("a card named with a pick word counts even when it was shown several replies ago", () => {
  const picks = { texts: [said("ok forget it la. i take the kenwood hand mixer the 3 one, 1 enough", 4)], replies: [reply([handMixer]), reply([standMixer]), reply([]), reply([handBlender])] };
  assert.equal(chose("HMP30.A0-WH", 1, picks), true);
  assert.equal(chose("KMX751ARD", 1, picks), false);
});

test("a price in 'the 5 dollar one' or 'the 1.2k one' form picks the card with that price", () => {
  const plates = { texts: [said("the 5 dollar one la i said already", 2)], replies: [greeting, reply([luminarc, carrara])] };
  assert.equal(chose("Q1930", 4, plates), true);
  assert.equal(chose("F3-CRR-01009-27", 4, plates), false);
  const blenders = { texts: [said("i take the waring 1.2k one. 2 unit", 2)], replies: [reply([waring2l, waring64, waringGallon]), reply([mika, braun])] };
  assert.equal(chose("MX1000XTXEE", 2, blenders), true);
  assert.equal(chose("MX1100XTXEE", 2, blenders), false);
  assert.equal(chose("CB15K", 2, blenders), false);
  const comma = { texts: [said("i take the $1,220 one, 2 unit", 1)], replies: [reply([waring2l, waring64, waringGallon])] };
  assert.equal(chose("MX1000XTXEE", 2, comma), true);
  assert.equal(chose("MX1100XTXEE", 2, comma), false);
});

test("a size picks the card with that size", () => {
  const toasters = { texts: [said("6 slot 2 only", 2)], replies: [reply([toaster4]), reply([toaster6])] };
  assert.equal(chose("HET-6", 2, toasters), true);
  assert.equal(chose("HET-4", 2, toasters), false);
  const tongs = { texts: [said("the 16 inch one, 4", 1)], replies: [reply([tong12, tong16])] };
  assert.equal(chose("UT16HR", 4, tongs), true);
  assert.equal(chose("UT12HR", 4, tongs), false);
});

test("a word two cards share goes to the one in the newest card set, and to neither when they were shown together", () => {
  const apart = { texts: [said("the plate also 4", 2)], replies: [reply([luminarc]), reply([carrara])] };
  assert.equal(chose("F3-CRR-01009-27", 4, apart), true);
  assert.equal(chose("Q1930", 4, apart), false);
  const together = { texts: [said("the plate also 4", 1)], replies: [reply([luminarc, carrara])] };
  assert.equal(chose("F3-CRR-01009-27", 4, together), false);
  assert.equal(chose("Q1930", 4, together), false);
});

test("each clause picks its own card, and a card the customer turns down is vetoed", () => {
  const picks = { texts: [said("the plate 4 pcs, rice bowl 4, spoon 4 fork 4. knife dont need", 2)], replies: [greeting, reply([knife, fork, spoon])] };
  assert.equal(chose("2527-003", 4, picks), true);
  assert.equal(chose("2527-002", 4, picks), true);
  assert.equal(chose("2527-001", 4, picks), false);
});

test("an item asked for with its quantity is picked when the next reply shows exactly one card that matches it", () => {
  const picks = { texts: [said("glove no need, here still have", 2), said("need scrub sponge 2pkt, kitchen paper towel 2pkt", 1, 1)], replies: [greeting, reply([sponge, towel])] };
  assert.equal(chose("7443", 2, picks), true);
  assert.equal(chose("7443", 3, picks), false);
});

test("a chip naming a card from an older reply picks it", () => {
  const picks = { texts: [said("Go with Carrara", 2, 0, true)], replies: [reply([carrara, tigerEye, ovalPlate]), reply([], "Happy to search for other plates.")] };
  assert.equal(chose("F3-CRR-01009-27", 60, picks), true);
  assert.equal(chose("F2-TGE-01002-25", 60, picks), false);
});

test("a size shared by a newer set goes to the newer card, not an older one with the same size", () => {
  const picks = { texts: [said("the 4 slot 1 unit add also", 3)], replies: [reply([waringToaster, toaster6]), reply([toaster4]), reply([toaster6, toaster4])] };
  assert.equal(chose("HET-4", 1, picks), true);
  assert.equal(chose("WCT708K", 1, picks), false);
});

test("a yes to the only card in Claire's previous reply picks it", () => {
  const offered = [greeting, reply([safico], "This one runs on gas.")];
  for (const [text, quantity, chip] of [["ok 2", 2, false], ["aiya just add la why need tap again", 2, false], ["Add it", 2, true], ["can lah 2", 2, false], ["Can u help me do a 50 pcs qoutation for this", 50, false]] as const) {
    assert.equal(chose("BTS-8026D", quantity, { texts: [said(text, 2, 0, chip)], replies: offered }), true, text);
  }
  const strainers = { texts: [said("ok take tis one 1pc. the 5 dollar one dun want liao", 2)], replies: [reply([cheapStrainer]), reply([meshStrainer], "It holds noodles. Want me to add 1?")] };
  assert.equal(chose("13122-0304", 1, strainers), true);
  assert.equal(chose("HL00700100301-N", 1, strainers), false);
  for (const ask of ["How many do you need?", "Want me to add the 1 available?", "What quantity do you need?"]) {
    for (const [text, quantity] of [["4 can", 4], ["1 lor", 1], ["2 please", 2]] as const) {
      assert.equal(chose("BTS-8026D", quantity, { texts: [said(text, 2)], replies: [greeting, reply([safico], ask)] }), true, `${ask} ${text}`);
    }
  }
});

test("'no rush' or 'no problem' doesn't turn a card down", () => {
  const torches = [greeting, reply([blowtorch, safico])];
  for (const text of ["the safico 2 pcs no rush", "no problem take the safico 2"]) {
    assert.equal(chose("BTS-8026D", 2, { texts: [said(text, 2)], replies: torches }), true, text);
  }
});

test("a tap still counts 5 customer messages later, but not 6", () => {
  const history = [
    { role: "assistant" as const, content: "Two knives.\n[cards shown: 2527-001 STAINLESS STEEL DINNER KNIFE ($1.10); 2527-002 STAINLESS STEEL DINNER FORK ($1.01)]" },
    { role: "user" as const, content: "[tap] Picked: STAINLESS STEEL DINNER KNIFE (code 2527-001)" },
    ...["the plate got photo", "ok", "hmm"].flatMap((content) => [{ role: "assistant" as const, content: "Sure." }, { role: "user" as const, content }]),
    { role: "assistant" as const, content: "Sure." },
  ];
  const fiveLater = pickEvidence([...history, { role: "user", content: "wah" }], { type: "text", text: "plates take the 25cm one" });
  assert.equal(customerChose("2527-001", 5, fiveLater, []), true);
  const sixLater = pickEvidence([...history, { role: "user", content: "wah" }, { role: "user", content: "eh" }], { type: "text", text: "plates take the 25cm one" });
  assert.equal(customerChose("2527-001", 5, sixLater, []), false);
});

test("nothing shown yet means nothing was picked", () => {
  assert.equal(chose("BTS-8026D", 2, { texts: [said("I need 2 safico torches", 1)], replies: [greeting] }), false);
});

test("'only 1 of them' after a single card is not a pick of that card", () => {
  const t0 = reply([mx130], "Found the Cuisinart RHB100U, but it's out of stock. Closest cordless option in stock is the Dynamic Mini Cordless Mixer MX130. Want me to check that one, or keep the Cuisinart on a restock enquiry?");
  assert.equal(chose("MX130", 1, { texts: [said("only 1 of them", 2)], replies: [greeting, t0] }), false);
  assert.equal(chose("MX130", 1, { texts: [said("mixer not same leh. only 1 of them can alr, blender", 2)], replies: [greeting, t0] }), false);
  assert.equal(chose("MX130", 1, { texts: [said("only 1", 2)], replies: [greeting, t0] }), false);
  const later = [greeting, t0, reply([], "Got it."), reply([waring2l], "Some blenders here."), reply([])];
  assert.equal(chose("MX130", 1, { texts: [said("how about mixers?", 4, 0), said("blender", 3, 1), said("only 1 of them", 2, 2)], replies: later }), false);
});

test("a complaint or a question that names a card is not a pick", () => {
  const strainers = [greeting, reply([oilStrainer, deepStrainer, oilStrainer9])];
  assert.equal(chose("HL168", 1, { texts: [said("22 dollar still ex leh. Got smaller one cheaper or not", 2)], replies: strainers }), false);
  assert.equal(chose("E910076", 1, { texts: [said("Ok. Any other Zyliss household one", 2)], replies: [greeting, reply([scissors])] }), false);
  assert.equal(chose("P-16HD", 1, { texts: [said("which one better for wok frying", 2)], replies: [greeting, reply([wok, siliconeTong])] }), false);
  assert.equal(chose("HMP30.A0-WH", 2, { texts: [said("the kenwood hand mixer got whisk?", 2)], replies: [greeting, reply([handMixer, standMixer])] }), false);
  assert.equal(chose("MX010", 1, { texts: [said("hmm 500 dollar for home baking", 2)], replies: [greeting, reply([mightyMixer])] }), false);
  // c08-stress T3-T4: "wat" starts a question.
  const zyliss = [greeting, reply([scissors]), reply([card("SB3038", "Stainless Steel Household Kitchen Scissors L21cm, Shibazi", 7.25), card("E910077", "Zyliss Polypropylene Basic Household Scissors Basic, Gray", 22.84)]), reply([], "Links.")];
  assert.equal(chose("E910077", 2, { texts: [said("zyliss link cannot open leh", 4, 0), said("send me all the link la i compare. wat diff btw the 2 zyliss", 3, 1)], replies: zyliss }), false);
  assert.equal(chose("MX1000XTXEE", 1, { texts: [said("below 1k", 2)], replies: [greeting, reply([waring64, mika])] }), false);
  assert.equal(chose("Q1930", 4, { texts: [said("budget 5 dollar only per plate, need 4", 2)], replies: [greeting, reply([luminarc, carrara])] }), false);
});

test("a card named with no pick word counts in the next message, but not two messages later", () => {
  const asked = [greeting, reply([blowtorch, safico], "Two options."), reply([], "How many do you need?")];
  assert.equal(chose("BTS-8026D", 2, { texts: [said("2", 3, 0), said("the safico one", 2, 1)], replies: asked }), true);
  const later = [...asked, reply([], "Sure. Anything else?")];
  assert.equal(chose("BTS-8026D", 2, { texts: [said("2", 4, 0), said("hmm", 3, 1), said("the safico one", 2, 2)], replies: later }), false);
  // c08-persona: a complaint about the only card's link is not a pick of it three messages later.
  const basicScissors = card("E910077", "Zyliss Polypropylene Basic Household Scissors Basic, Gray", 22.84);
  const link = [greeting, reply([scissors], "Here's the link again."), reply([], "It loads fine here."), reply([], "Sales can help."), reply([basicScissors], "Found one more.")];
  assert.equal(chose("E910076", 2, { texts: [said("Whats the difference between the 2 Zyliss household ones", 5, 0), said("Ok. Any other Zyliss household scissors?", 4, 1), said("Still no. Is there someone who can help", 3, 2), said("Other links open fine. Only the Zyliss one doesn't. Can you just check it", 2, 3)], replies: link }), false);
});

test("a clause with 'got' asks, it doesn't pick", () => {
  const bags = [greeting, reply([card("GP106", "COFFEE BAG w/WIRE HDLE 6\", Ø15xL31xW26cm", 3.58), card("GP108", "COFFEE BAG w/WIRE HDLE 8\", Ø19.5xL42.6xW29cm", 4.13)]), reply([card("GP111", "(26-01688) COFFEE BAG w/WIRE HDLE 4\", Ø10.6xL26xW24cm", 2.94)], "Yes, there's a smaller 4in one.")];
  assert.equal(chose("GP111", 2, { texts: [said("just now u say only got 2 size leh. now got 4 inch. how many size actually", 3)], replies: bags }), false);
});

test("a size asked for before any card was shown is not a quantity pick", () => {
  // s02: "4 or 6 slot" is two sizes, not 4 of the 6-slot toaster Claire showed next.
  const picks = { texts: [said("Thank you", 3, 0), said("4 or 6 slot", 2, 1)], replies: [greeting, reply([waringToaster]), reply([toaster6], "For 6-slot, this one has temp control. Want this instead?")] };
  assert.equal(chose("HET-6", 4, picks), false);
});

test("an ok or a number is not a yes when it hedges, asks, or the reply didn't ask how many", () => {
  const offered = [greeting, reply([mx130], "This one is cordless.")];
  for (const text of ["ok, how about cheaper one", "ok la but too expensive", "ok wait let me ask my boss", "ok so what else u have", "can la but show me other colour", "i go ur shop buy can?", "cannot order the other 2 first meh? i can wait one"]) {
    assert.equal(chose("MX130", 1, { texts: [said(text, 2)], replies: offered }), false, text);
  }
  const stool2 = reply([stool], "Meanwhile the closest in-stock option I have is still the Vicando 2-step folding stool in grey.");
  assert.equal(chose("FSS", 1, { texts: [said("1 unit per outlet opening", 2)], replies: [greeting, stool2] }), false);
  for (const [text, quantity] of [["4 can", 4], ["2", 2], ["does it come with 2 blades", 2], ["is it 2 years warranty", 2]] as const) {
    assert.equal(chose("MX130", quantity, { texts: [said(text, 2)], replies: offered }), false, text);
  }
});

test("an ok next to a question or a pause is not a yes, unless the number is in the yes", () => {
  const offered = [greeting, reply([waring64], "This one fits.")];
  const after = (text: string) => ({ texts: [said(text, 2), said("need 2 blenders", 1, 1)], replies: offered });
  for (const text of ["ok, how much?", "sure, got warranty?", "ok what is the price", "ok let me think first", "ok later then"]) {
    assert.equal(chose("MX1000XTXEE", 2, after(text)), false, text);
  }
  for (const text of ["ok 2, how much total?", "ok"]) assert.equal(chose("MX1000XTXEE", 2, after(text)), true, text);
});

test("a chip that asks to see more names no card", () => {
  const shown = [greeting, reply([tong16], "This one locks.")];
  for (const chip of ["More tong options", "See longer tongs", "Show tong sizes", "Other tongs"]) {
    assert.equal(chose("UT16HR", 4, { texts: [said(chip, 2, 0, true), said("need 4 tongs", 1, 1)], replies: shown }), false, chip);
  }
  assert.equal(chose("UT16HR", 4, { texts: [said("Go with the 16 inch tong", 2, 0, true), said("need 4 tongs", 1, 1)], replies: shown }), true);
});

test("a yes that names another card is not a yes to the only card", () => {
  const picks = { texts: [said("ok forget it la. i take the kenwood hand mixer the 3 one, 1 enough", 4)], replies: [reply([handMixer]), reply([standMixer]), reply([]), reply([handBlender])] };
  assert.equal(chose("RHB100U", 1, picks), false);
});

test("a tap is voided by a switch to another card of its set, or by later alternatives of the same kind", () => {
  const knives = [greeting, reply([chefKnife16, cookKnife16, chefKnife26])];
  const switched = { taps: [tap("8455-26", 2, 1)], texts: [said("i said 3 already wat.. eh wait no, change to the 16cm wide one. 26 too long", 3)], replies: [...knives, reply([], "How many do you need?")] };
  assert.equal(chose("8455-26", 3, switched), false);
  assert.equal(chose("8455-16", 3, switched), true);
  const longer = { taps: [tap("970S", 2, 2)], texts: [said("2 pcs", 3, 0), said("show me the longer ones", 2, 1)], replies: [greeting, reply([blowtorch]), reply([mastrad, safico], "These two are longer.")] };
  assert.equal(chose("970S", 2, longer), false);
});

test("a product already on the enquiry counts as picked", () => {
  assert.equal(chose("BTS-8026D", 3, { texts: [said("make it 3", 1)], replies: [greeting] }, ["bts-8026d"]), true);
});

test("a typed item code picks the product, but not in a clause that turns it down", () => {
  assert.equal(chose("BTS-8026D", 2, { texts: [said("2 pcs of bts-8026d", 1)], replies: [greeting] }), true);
  for (const text of ["Can I get 10 pcs of BTS-8026D?", "BTS-8026D x10 got stock or not"]) {
    assert.equal(chose("BTS-8026D", 10, { texts: [said(text, 1)], replies: [greeting] }), true, text);
  }
  assert.equal(chose("BTS-8026D", 2, { taps: [tap("BTS-8026D", 2, 1)], texts: [said("dont want BTS-8026D, 2 of the 970S", 3)], replies: [greeting, reply([blowtorch, safico]), reply([])] }), false);
});

test("the pick evidence is read from the chat history and this turn's event", () => {
  const picks = pickEvidence([
    { role: "assistant", content: "Hi, I'm Claire." },
    { role: "user", content: "blow torch" },
    { role: "assistant", content: "Two.\n[cards shown: 970S KITCHEN BLOW TORCH 970S ($31.31) <https://store.siahuat.com/product/1>; BTS-8026D CASSETTE GAS TORCH BURNER SAFICO PRO]" },
    { role: "user", content: "[tap] Picked: CASSETTE GAS TORCH BURNER SAFICO PRO (code BTS-8026D)" },
    { role: "assistant", content: "How many?" },
    { role: "user", content: "[chip] Add it" },
  ], { type: "text", text: "4 can" });
  assert.deepEqual(picks.taps, [{ code: "BTS-8026D", age: 2, seen: 2 }]);
  assert.deepEqual(picks.texts, [{ text: "4 can", seen: 3, age: 0, chip: false }, { text: "Add it", seen: 3, age: 1, chip: true }, { text: "blow torch", seen: 1, age: 3, chip: false }]);
  assert.equal(picks.replies[1].cards[0].price, 31.31);
  assert.equal(picks.replies[1].cards[1].price, null);
  assert.equal(picks.replies[2].text, "How many?");
});

test("the pick evidence keeps a tapped card from this turn, a photo caption, and texts back to the tap window", () => {
  const tapped = pickEvidence([{ role: "user", content: "[photo] (no caption)" }, { role: "user", content: "[photo] this one got?" }], { type: "select_product", stockId: "970S" });
  assert.deepEqual(tapped.taps, [{ code: "970S", age: 0, seen: 0 }]);
  assert.deepEqual(tapped.texts.map((item) => item.text), ["this one got?"]);
  const many = pickEvidence(["a", "b", "c", "d", "e", "f", "g"].map((content) => ({ role: "user" as const, content })), { type: "text", text: "h" });
  assert.deepEqual(many.texts.map((item) => item.text), ["h", "g", "f", "e", "d", "c"]);
});

test("a photo with no caption still counts as a customer message", () => {
  const history = [
    { role: "user" as const, content: "[tap] Picked: CASSETTE GAS TORCH BURNER SAFICO PRO (code BTS-8026D)" },
    { role: "assistant" as const, content: "How many do you need?" },
    { role: "user" as const, content: "[photo] (no caption)" },
  ];
  const image = { dataUrl: "data:image/jpeg;base64,AA==", mimeType: "image/jpeg" as const, name: "photo.jpg" };
  assert.deepEqual(pickEvidence(history.slice(0, 2), { type: "image", image }).taps, [{ code: "BTS-8026D", age: 1, seen: 0 }]);
  assert.deepEqual(pickEvidence(history, { type: "text", text: "4" }).taps, [{ code: "BTS-8026D", age: 2, seen: 0 }]);
});

test("hits and pointedCards find the words, sizes and price a text gives for a card", () => {
  assert.deepEqual([...hits(tong16, "the 16 inch tong")].sort(), ["16in", "tong"]);
  assert.deepEqual([...hits(luminarc, "the $5 one")], ["$price"]);
  assert.deepEqual([...hits(luminarc, "budget $5 only")], []);
  assert.deepEqual(pointedCards("the 16 inch one", [tong12, tong16]).map((item) => item.code), ["UT16HR"]);
  assert.deepEqual(pointedCards("the tong", [tong12, tong16]), []);
  assert.deepEqual(pointedCards("the $1,220 one", [waring2l, waring64]).map((item) => item.code), ["MX1000XTXEE"]);
});

test("pickedCodes lists the products the customer picked that are not on the enquiry yet", () => {
  const picks = { taps: [tap("UT16HR", 2, 1)], texts: [said("need 4", 3)], replies: [greeting, reply([tong12, tong16]), reply([], "How many do you need?")] };
  assert.deepEqual(pickedCodes(picks, []), ["UT16HR"]);
  assert.deepEqual(pickedCodes(picks, ["UT16HR"]), []);
});

test("the steak tong accepted two messages ago is still the pick when the next reply showed another tong", () => {
  // c10-stress T10: "ok tis one. want 5" accepted ST-15; the reply after it offered 2564L instead of the 5; "ok add the 3 la" follows.
  const picks = {
    texts: [said("ok add the 3 la", 4, 0), said("cannot order the other 2 first meh? i can wait one", 3, 1), said("ok tis one. want 5", 2, 2)],
    replies: [greeting, reply([steakTong], "Got Stainless Steel Steak Tong 15in. How many do you need?"), reply([card("2564L", "Stainless Steel Utility Tong 16\"", 3.85)], "Only 3 in stock. Want me to add the 3 available?"), reply([], "Want me to add the 3 available for now?")],
  };
  assert.equal(chose("ST-15", 3, picks), true);
  assert.equal(chose("2564L", 3, picks), false);
});

test("a refusal older than the newest 4 texts still vetoes the tap it came after", () => {
  const history = [
    { role: "assistant" as const, content: "Two.\n[cards shown: 2527-001 STAINLESS STEEL DINNER KNIFE ($1.10); 8455-16 CHEF'S KNIFE 16cm w/WIDE BLADE ($32.94)]" },
    { role: "user" as const, content: "[tap] Picked: STAINLESS STEEL DINNER KNIFE (code 2527-001)" },
    { role: "assistant" as const, content: "How many do you need?" },
    { role: "user" as const, content: "knife dont need, i take the plates first" },
    ...["show me plates", "the big one", "how much ah"].flatMap((content) => [{ role: "assistant" as const, content: "Sure." }, { role: "user" as const, content }]),
    { role: "assistant" as const, content: "It is $5." },
  ];
  const picks = pickEvidence(history, { type: "text", text: "4 pcs" });
  assert.equal(customerChose("2527-001", 4, picks, []), false);
  assert.deepEqual(pickedCodes(picks, []), []);
});

test("a pick word in another clause doesn't let a text name a card from an older reply", () => {
  // c08-stress T7: "i dun wan kitchen" turns the Shibazi down; its "wan" is not a pick of it.
  const note = (cards: string) => `\n[cards shown: ${cards}]`;
  const history = [
    { role: "assistant" as const, content: "Hi, I'm Claire." },
    { role: "user" as const, content: "scissor got?" },
    { role: "assistant" as const, content: "A few types." + note("ST-26 -TS- S/S KITCHEN SCISSOR 20cm, JPN ($15.50); 9300T01 Atlantic Chef Detachable Scissors ($27.43); K014 CRAB SCISSORS ($3.58)") },
    { role: "user" as const, content: "not for food la. house use, cut paper cut box tht kind" },
    { role: "assistant" as const, content: "Cheaper options." + note("SB3038 Stainless Steel Household Kitchen Scissors L21cm, Shibazi ($7.25); E910077 Zyliss Polypropylene Basic Household Scissors Basic, Gray ($22.84)") },
    { role: "user" as const, content: "zyliss link cannot open leh" },
    { role: "assistant" as const, content: "Links again." + note("E910076 Zyliss Stainless Steel Household Scissors ($29.27); E910077 Zyliss Polypropylene Basic Household Scissors Basic, Gray ($22.84)") },
    { role: "user" as const, content: "nvm la zyliss too ex. shibazi tht one say kitchen leh, i dun wan kitchen. got other normal one not so ex?" },
    { role: "assistant" as const, content: "This one is for the house." + note("993-003-RD Zebra Multi-Purpose Scissors 22.5cm ($19.17)") },
    { role: "user" as const, content: "[tap] Picked: Zebra Multi-Purpose Scissors 22.5cm (code 993-003-RD)" },
    { role: "assistant" as const, content: "Good choice. How many do you need?" },
  ];
  const picks = pickEvidence(history, { type: "text", text: "2 lah. this link better can open ah" });
  assert.equal(customerChose("SB3038", 2, picks, []), false);
  assert.deepEqual(pickedCodes(picks, []), ["993-003-RD"]);
  // c10-persona T5: "i want for cooking" is not a pick of the serving tong named in another clause.
  const servingTong = (code: string, size: string, price: number) => card(code, `Stainless Steel Serving Tongs ${size}`, price);
  const tongs = [
    greeting, reply([servingTong("488901", "L18cm", 3.21), servingTong("488902", "L23cm", 3.58)]),
    reply([servingTong("488903", "L30cm", 4.13), card("01822302", "Piazza Nylon Perforated Kitchen & BBQ Tong L23cm", 36.61)]),
    reply([card("UT09L", "Stainless Steel Utility Tong 9\"", 2.02), tong12, card("2564L", "Stainless Steel Utility Tong 16\"", 3.85)]),
    reply([card("K038", "SNAIL TONG", 2.75), card("UT12L", "S/S UTILITY TONG 12\"", 2.94), steakTong]), reply([steakTong], "Good pick. How many do you need?"),
  ];
  const texts = [
    said("need 4 pcs can?", 6, 0), said("Stainless Steel Steak Tong 15\"", 5, 1),
    said("only 3? i said show me all leh. everything u got for cooking tong", 4, 2), said("these all serving tong leh. i want for cooking, stainless steel. show me all", 3, 3),
  ];
  assert.equal(chose("488903", 4, { texts, replies: tongs }), false);
  assert.equal(chose("ST-15", 4, { texts, replies: tongs }), true);
});

test("c06-persona T11: the tapped strainer is the pick, not the cards the earlier complaint and wish describe", () => {
  const sizedSkimmer = (code: string, size: string, price: number) => card(code, `S/S FINE MESH SKIMMER Ø${size}cm`, price);
  const deepCck = card("197-55", "CCK Stainless Steel Deep Noodle Strainer With Stainless Steel Handle 5.5\"", 25.5);
  const hl165 = card("HL165", "STAINLESS STEEL FINE MESH OIL STRAINER WITH BAMBOO HANDLE", 11.01);
  const replies = [
    greeting, reply([card("193012", "S/S U-SHAPE NOODLE STRAINER Ø13xH15cm", 16.97)]),
    reply([card("V-507", "-TS- S/S RD COLANDER 36cm", 46.7), card("821", "PLASTIC ROUND COLANDER", 3.67), card("2166-BL", "PLASTIC RECTANGLE COLANDER", 7.52)]),
    reply([meshStrainer, sizedSkimmer("13128-0403", "19", 3.21), skimmer]),
    reply([skimmer, sizedSkimmer("13128-0403", "19", 3.21), sizedSkimmer("13128-0405", "24", 5.05)]),
    reply([deepCck, card("HL140", "S/S CHINESE STRAINER WITH BAMBOO HANDLE Ø11\"", 51.83), card("HL177", "(26-00947) S/S NOODLE STRAINER SQ HOLES WITH BAMBOO HANDLE Ø9\"", 29.82)]),
    reply([skimmer], "Want this one?"), reply([skimmer], "Want me to show those again?"),
    reply([oilStrainer, deepStrainer, oilStrainer9]), reply([card("HL174", "STAINLESS STEEL NOODLE STRAINER SQUARE HOLES WITH BAMBOO HANDLE", 16.06)]),
    reply([hl165, card("HL166", "STAINLESS STEEL FINE MESH OIL STRAINER WITH BAMBOO HANDLE", 13.94)], "Which one?"), reply([], "Good pick. How many do you need?"),
  ];
  const picks = {
    taps: [tap("HL165", 11, 1)],
    texts: [
      said("1 enough. For home use only", 12, 0),
      said("This one square hole leh not fine mesh. I say already fine mesh. The maggi small small bits will fall out", 10, 2),
      said("22 dollar still ex leh. Got smaller one cheaper or not, small small one enough already", 9, 3),
      said("Colander too big la. Want the one got handle, deep deep one, pour maggi inside then shake shake the water. Fine mesh. Not so ex", 8, 4),
    ],
    replies,
  };
  assert.equal(chose("HL165", 1, picks), true);
  for (const code of ["V-507", "197-55", "13128-0401"]) assert.equal(chose(code, 1, picks), false, code);
  // Known gap: at T7 itself "Fine mesh." names the skimmer Claire had just shown; only the quantity check refuses it then.
});

test("turning down one card doesn't veto a card that shares fewer of its words", () => {
  const picks = { taps: [tap("2527-002", 2, 2)], texts: [said("4", 4, 0), said("the dinner knife no need", 3, 1)], replies: [greeting, reply([knife, fork, spoon]), reply([], "How many? Want the knife too?"), reply([], "Ok. How many forks do you need?")] };
  assert.equal(chose("2527-002", 4, picks), true);
  assert.equal(chose("2527-001", 4, picks), false);
});

test("one refusal naming two cards vetoes both, even when one matches on more words", () => {
  for (const refusal of ["cancel the chef knife and the fork", "dont need the chef knife and fork", "no need chef knife and fork", "chef knife and fork no need"]) {
    const picks = { taps: [tap("2527-002", 2, 2)], texts: [said("4 pcs", 4, 0), said(refusal, 3, 1)], replies: [greeting, reply([chefKnife16, fork]), reply([], "How many do you need?"), reply([], "Ok, noted.")] };
    assert.equal(chose("2527-002", 4, picks), false, refusal);
    assert.deepEqual(pickedCodes(picks, []), [], refusal);
  }
});

test("a later card that shares only a material word with a tapped card doesn't void the tap", () => {
  const bowl = card("BWL-30", "Stainless Steel Mixing Bowl 30cm", 8);
  const picks = { taps: [tap("UT16HR", 2, 1)], texts: [said("4", 3, 0)], replies: [greeting, reply([tong16]), reply([bowl], "Here's a bowl. How many tongs do you need?")] };
  assert.equal(chose("UT16HR", 4, picks), true);
});

test("a price picks with the card's own name words before 'one' or right after it, but not as a budget (exam 3)", () => {
  // c08-stress T6: "shibazi" alone fits both Shibazi scissors; the price tells them apart.
  const scissorSets = [greeting, reply([shibazi, shibaziDetachable, zebra]), reply([scissors, zylissBasic]), reply([scissors, { ...zylissBasic, price: null }])];
  const t6 = { texts: [said("forget it la zyliss too ex anyway. i take the 7 dollar shibazi one, 3 pcs", 4)], replies: scissorSets };
  assert.equal(chose("SB3038", 3, t6), true);
  assert.equal(chose("SB3027", 3, t6), false);
  // c08-persona T12.
  const t12 = { texts: [said("Also add 1 of the 7 dollar Shibazi one", 3)], replies: [greeting, reply([shibazi, scissors]), reply([shibaziDetachable]), reply([], "Your enquiry has 1 item line.")] };
  assert.equal(chose("SB3038", 1, t12), true);
  assert.equal(chose("SB3027", 1, t12), false);
  // c06-persona T8: "the 2 dollar skimmer", after the skimmer was re-shown without a price.
  const skimmers = [greeting, reply([skimmer, skimmer19, skimmer24]), reply([meshStrainer]), reply([{ ...skimmer, price: null }, { ...wireMesh26, price: null }]), reply([wireMesh26], "Got it: 1 added.")];
  const t8 = { texts: [said("The 2 dollar skimmer also take 2 lah, for scoop the egg", 5)], replies: skimmers };
  assert.equal(chose("13128-0401", 2, t8), true);
  assert.equal(chose("13128-0403", 2, t8), false);
  // c10-stress T5: "the 16 inch cheap one" is the $3.85 tong; "the 3 dollar plus one" alone fits two $3.85 tongs.
  const tongSets = [greeting, reply([tong9, steakTong, siliconeTong]), reply([plainTong16, tong16]), reply([scallopTong, edlund16]), reply([steakTong], "How many would you like?"), reply([steakTong, edlundLock], "Only 3 left.")];
  const t5 = { texts: [said("27 bucks too ex la. ok take the 3 steak tong, then 3 more of the 16 inch cheap one, the 3 dollar plus one", 6)], replies: tongSets };
  assert.equal(chose("2564L", 3, t5), true);
  for (const code of ["UT16HR", "JQ-OT113", "36670", "34471"]) assert.equal(chose(code, 3, t5), false, code);
  assert.equal(chose("P-24", 2, { texts: [said("i pay 5 dollar for one also can, 2 pcs", 1)], replies: [reply([plate24, plate27, plate30])] }), false);
});

test("when several cards fit a typed price, only those whose price rounds to it keep it, and a tie picks none (exam 3, c06-stress T4)", () => {
  const skimmers = { texts: [said("ok the 2 dollar one lah, take 2", 3)], replies: [greeting, reply([wireMesh26]), reply([skimmer, skimmer165, skimmer19], "Smallest at $2.29.")] };
  assert.equal(chose("13128-0401", 2, skimmers), true);
  for (const code of ["13128-0402", "13128-0403"]) assert.equal(chose(code, 2, skimmers), false, code);
  const close = { texts: [said("the 5 dollar one, 10", 1)], replies: [reply([card("A-510", "Dinner Plate A", 5.1), card("A-545", "Dinner Plate B", 5.45)])] };
  for (const code of ["A-510", "A-545"]) assert.equal(chose(code, 10, close), false, code);
  const tied = { texts: [said("the 3 dollar plus one", 1)], replies: [reply([plainTong16, scallopTong])] };
  for (const code of ["2564L", "JQ-OT113"]) assert.equal(chose(code, null, tied), false, code);
});

test("a card re-shown as Price to be confirmed keeps the price shown earlier (exam 3, c10-persona T8)", () => {
  const tbc = (item: ShownCard) => ({ ...item, price: null });
  const replies = [greeting, reply([steakTong, siliconeTong, tong9]), reply([plainTong16, scallopTong]),
    reply([tbc(steakTong), tbc(siliconeTong), tbc(tong9), tbc(plainTong16)], "Here's what I've shown so far."), reply([plainTong16, scallopTong, tong16]), reply([steakTong, tong16], "Got it: 3 of each added.")];
  const picks = { texts: [said("the 2 dollar one also, 10", 6)], replies };
  assert.equal(chose("UT09L", 10, picks, ["ST-15", "UT16HR"]), true);
  assert.equal(chose("2564L", 10, picks, ["ST-15", "UT16HR"]), false);
});

test("'the cheap 4 slot', 'the cheapest waring' or 'the bigger one' picks the one card code knows is cheapest or biggest (exam 3)", () => {
  // c11-persona T7, from this text alone (in the chat the 6-slot is on the enquiry).
  const toasters = [greeting, reply([waringToaster, toaster6, toaster4]), reply([waringToaster, toaster6], "Got it: 1 Waring added."), reply([], "Your enquiry totals $923.96.")];
  const switched = { texts: [said("actually change the 6 slot to the cheap 4 slot. same 2", 4)], replies: toasters };
  assert.equal(chose("HET-4", 2, switched), true);
  assert.equal(chose("WCT708K", 2, switched), false);
  // c02-stress T8: the 2L Waring was last shown without a price; its earlier price still counts.
  const blenders = [greeting, reply([mika, santos66, waringQuiet]), reply([waring2l, waringVariable, santos66]), reply([waring64, waringVariable, waringGallon]),
    reply([waringQuiet, santos66]), reply([mika, { ...waring2l, price: null }]), reply([mika], "Got it: 2 added.")];
  const cheapest = { texts: [said("hmm nvm la mika sure spoil one. change to the cheapest waring, same 2 unit", 7)], replies: blenders };
  assert.equal(chose("MX1000XTXEE", 2, cheapest), true);
  assert.equal(chose("MX1100XTXEE", 2, cheapest), false);
  // c11-stress T7, from this text alone: "4 or 6 slots" names both sizes.
  const outlet = {
    texts: [said("oh our other outlet also need 1. no conveyor. 4 or 6 slots toaster wichever cheapest can liao", 6)],
    replies: [greeting, reply([waringToaster, toaster6]), reply([toaster4], "Want this one?"), reply([], "Got it: 2 added."), reply([toaster6], "To confirm - you want the 6-slot, qty 2?"), reply([], "Your enquiry has 2 HET-6.")],
  };
  assert.equal(chose("HET-4", 1, outlet), true);
  assert.equal(chose("HET-6", 1, outlet), false);
  const plates = [greeting, reply([plate24, plate27, plate30])];
  assert.equal(chose("P-30", 2, { texts: [said("i want the bigger one, 2", 2)], replies: plates }), true);
  assert.equal(chose("P-24", 2, { texts: [said("change to the cheapest one, same 2", 2)], replies: plates }), true);
});

test("a cheap or bigger word that doesn't send the customer to one card picks nothing", () => {
  const plates = [greeting, reply([plate24, plate27, plate30])];
  for (const code of ["P-24", "P-30"]) assert.equal(chose(code, null, { texts: [said("want bigger dinner plate la cheap cheap", 2)], replies: plates }), false, code);
  for (const text of ["the bigger one I take later, now take the small one 2", "the bigger one cannot fit my shelf, i take 2 of the 24cm"]) {
    assert.equal(chose("P-30", 2, { texts: [said(text, 2)], replies: plates }), false, text);
  }
  const blenders = [greeting, reply([mika, santos, waring2l])];
  for (const text of ["nah cheap one sure spoil fast", "the cheap one sure spoil fast, take the waring 2", "ok the price is cheap take 2"]) {
    assert.equal(chose("MK-768L", 2, { texts: [said(text, 2)], replies: blenders }), false, text);
  }
  const conveyor = card("CONV-4", "Conveyor 4-Slots Toaster", 150);
  assert.equal(chose("CONV-4", 1, { texts: [said("no conveyor. 4 or 6 slots toaster wichever cheapest, need 1", 2)], replies: [greeting, reply([conveyor, toaster4, toaster6])] }), false);
  // A Waring with no known price may be the cheapest.
  const unpriced = card("TBC-1", "Waring Bar Blender Basic", null);
  assert.equal(chose("MX1000XTXEE", 2, { texts: [said("take the cheapest waring, 2", 2)], replies: [greeting, reply([unpriced, waring64, waring2l])] }), false);
  // "the price cheap" says the price is cheap.
  assert.equal(chose("MK-768L", 2, { texts: [said("ok the price cheap take 2", 2)], replies: blenders }), false);
});

test("a cheap or bigger word naming a kind no card name word matches picks nothing, and shared material words don't pool other kinds", () => {
  // "pan", "mug" and "wok" are too short to be name words: "the bigger pan" is not the biggest of everything shown.
  const pans = [greeting, reply([card("PAN-20", "Aluminium Sauce Pan 20cm", 18), card("PAN-24", "Aluminium Sauce Pan 24cm", 24), card("POT-30", "Aluminium Stock Pot 30cm", 60)])];
  assert.deepEqual(pickedCodes({ taps: [], texts: [said("i want the bigger pan, 2", 2)], replies: pans }, []), []);
  const mugs = [greeting, reply([card("MUG-1", "Porcelain Coffee Mug 300ml", 4.2), card("CUP-1", "Porcelain Coffee Cup 200ml", 3.5), card("MUG-2", "Porcelain Coffee Mug 350ml", 5.1)])];
  assert.equal(chose("CUP-1", 10, { texts: [said("take the cheapest mug, 10", 2)], replies: mugs }), false);
  const woks = [greeting, reply([card("WOK-14", "Iron Wok 14\"", 13), card("FRY-12", "Iron Fry Pan 12\"", 11), card("FRY-16", "Iron Fry Pan 16\"", 15)])];
  assert.equal(chose("FRY-16", 1, { texts: [said("the bigger wok 1", 2)], replies: woks }), false);
  assert.equal(chose("FRY-12", 1, { texts: [said("the cheapest wok 1", 2)], replies: woks }), false);
  // Only "stainless steel" fits the knife shown earlier and the tongs just shown.
  const tongs = [greeting, reply([knife]), reply([card("T-A", "Stainless Steel Serving Tong 9\"", 3.2), card("T-B", "Stainless Steel Serving Tong 12\"", 4.1)], "Two serving tongs.")];
  assert.deepEqual(pickedCodes({ taps: [], texts: [said("take the cheapest stainless steel one, 2", 3)], replies: tongs }, []), []);
});

test("a switch names the new card after its first 'to', and 'instead' there is no hedge (exam 3, c11-stress T4)", () => {
  const toasters = [greeting, reply([waringToaster, toaster6]), reply([toaster4], "Yes, there's a cheaper 4-slot option. Want this one?"), reply([], "Got it: 2 HET-4 added. Anything else?")];
  const instead = { texts: [said("wait ah boss say 6 slot better. change to 6 slot instead, same qty", 4)], replies: toasters };
  assert.equal(chose("HET-6", 2, instead), true);
  assert.equal(chose("HET-4", 2, instead), false);
  const two = [greeting, reply([toaster4, toaster6], "Two toasters.")];
  assert.equal(chose("HET-4", 2, { texts: [said("change to the 4 slot want to try 2", 2)], replies: two }), true);
  // Nothing named after "to": a quantity change of the card before it.
  assert.equal(chose("HET-4", 3, { texts: [said("change the 4 slot to 3 pcs", 2)], replies: two }), true);
  assert.equal(chose("HET-6", 3, { texts: [said("change the 4 slot to 3 pcs", 2)], replies: two }), false);
  assert.equal(chose("HET-4", 2, { texts: [said("swap the kettle to the 6 slot one la. same 2", 2)], replies: two }), false);
});

test("a switch never picks the card it replaces", () => {
  // "instead of" and "rather than" name the card being dropped.
  const newest = { texts: [said("change to 6 slot instead of 4 slot, same 2", 3)], replies: [greeting, reply([toaster6]), reply([toaster4], "Want this one?")] };
  assert.equal(chose("HET-6", 2, newest), true);
  assert.equal(chose("HET-4", 2, newest), false);
  const blenders = [greeting, reply([mika]), reply([waring2l], "Want this one?")];
  for (const text of ["switch to the mika instead of the waring, same 2", "change to the mika rather than the waring, 2", "change to this one instead of the waring, 2"]) {
    const picks = { taps: [], texts: [said(text, 3)], replies: blenders };
    assert.equal(chose("MX1100XTXEE", 2, picks), false, text);
    assert.ok(!pickedCodes(picks, []).includes("MX1100XTXEE"), text);
  }
  // The new side names two cards evenly: the card before "to" is not the pick.
  const toasters = { texts: [said("change the 6 slot to the 4 slot, 2", 3)], replies: [greeting, reply([toaster4, waringToaster]), reply([toaster6], "Want this one?")] };
  assert.equal(chose("HET-6", 2, toasters), false);
  // A decimal size before "to" is still the old side.
  const decimal = { texts: [said("change the 20.5cm to the 21cm one, 3", 2)], replies: [greeting, reply([card("SK-205", "Fine Mesh Skimmer 20.5cm", 4), card("SK-21", "Fine Mesh Skimmer 21cm", 5)])] };
  assert.equal(chose("SK-21", 3, decimal), true);
  assert.equal(chose("SK-205", 3, decimal), false);
  // "should i change …" asks.
  assert.equal(chose("HET-4", 2, { texts: [said("should i change the 6 slot to the 4 slot 2", 2)], replies: [greeting, reply([toaster4, toaster6])] }), false);
});

test("a clause naming two cards picks both (exam 3, c05-persona T9)", () => {
  const replies = [greeting, reply([carrara, rocaBowl, cutlery]), reply([patraPlate, patraBowl, cutlery], "For 4 pax, how many plates and bowls do you need?")];
  const picks = { texts: [said("ok this ok. the white plate and bowl 4 each, the spoon fork set 1", 3)], replies };
  assert.equal(chose("3500-0018", 4, picks), true);
  assert.equal(chose("3500-3011", 4, picks), true);
  // A part put off for later is no pick.
  const tongs = [greeting, reply([tong9, tong12, tong16])];
  for (const text of ["take the 12 inch tong 2 and ask ur boss the 16 inch price", "12 inch tong 2 and 16 inch maybe later"]) {
    assert.equal(chose("UT12HR", 2, { texts: [said(text, 2)], replies: tongs }), true, text);
    assert.equal(chose("UT16HR", 2, { texts: [said(text, 2)], replies: tongs }), false, text);
  }
});

test("a name or size that fits two cards evenly picks neither, however recently one was shown", () => {
  const gn11 = card("GN11-65", "GN 1/1 Pan 65mm", 20);
  const gn23 = card("GN23-65", "GN 2/3 Pan 65mm", 15);
  for (const code of ["GN11-65", "GN23-65"]) assert.equal(chose(code, 2, { texts: [said("ok i want 2 pan", 1)], replies: [reply([gn11, gn23])] }), false, code);
  // The newer 10in chef knife doesn't win over the 8in cook's knife the customer sized.
  const cook8 = card("K-8", "Cook's Knife 8in", 20);
  const chef10 = card("K-10", "Chef Knife 10in", 25);
  assert.equal(chose("K-10", 2, { texts: [said("add the 8 inch chef knife, 2", 3)], replies: [reply([cook8]), reply([chef10]), reply([tong12])] }), false);
  // runs-new2 c05-stress T15: three bowls, each shown in a different reply.
  const bowls = [greeting, reply([card("N3600", "Luminarc Diwali Opal Glass Rice Bowl Ø12cm", 4.5)]), reply([card("N3601", "Luminarc Noodle Bowl 18cm, Generic Opal Glass", 8.17)]),
    reply([card("RS-J1004-5", "Rooster Series Deep Bowl 5\"", 3.46)]), reply([card("RS-J1037", "Rooster Series Soup Spoon", 2.8)]), reply([], "Soup spoon x4 added. The bowl still isn't going through on my side.")];
  for (const code of ["N3600", "N3601", "RS-J1004-5"]) assert.equal(chose(code, null, { texts: [said("ok bowl i call ur sales la. so troublesome", 6)], replies: bowls }), false, code);
});

test("a yes to the one product Claire's question asked about picks it, even when that reply showed no card or several (exam 3)", () => {
  // c08-persona T9: the confirm question carried no card.
  const zyliss = [greeting, reply([scissors, zylissBasic], "Main difference: E910076 is L22.8cm (larger). Which size suits you?"),
    reply([], "Just to confirm - you'd like the bigger Zyliss household scissors, E910076 (L22.8cm)? That hasn't been added yet - please confirm this is the one and I'll add 2 pcs for you.")];
  const yes = { texts: [said("Yes that one", 3, 0), said("Ok the bigger one. 2 pcs", 2, 1)], replies: zyliss };
  assert.equal(chose("E910076", 2, yes), true);
  assert.equal(chose("E910077", 2, yes), false);
  // c02-B T18: the question under two cards names only the Mika.
  const blenders = [greeting, reply([santos], "Want to go with this at 2 units?"),
    reply([santos, mika], "Sorry, price on the Santos Bar Blender is $614.68, within your budget. But only 1 unit is in stock, so it can't cover your 2. A cheaper option that has plenty in stock is the Mika Bar Blender (2L, $273.83) — well within budget too. Want to go with 2 of the Mika instead?")];
  const sure = { texts: [said("ok sure. i want 2 units. let me know which one has at least 2 units in stock and when i can collect it.", 3, 0), said("im taking about price not code", 2, 1)], replies: blenders };
  assert.equal(chose("MK-768L", 2, sure), true);
  assert.equal(chose("FHA24-33GE", 2, sure), false);
});

test("a yes to an either/or question, a check, a question about use, or questions naming two products picks nothing", () => {
  const zyliss = [greeting, reply([scissors, zylissBasic])];
  const after = (question: string, text: string) => ({ texts: [said(text, 3)], replies: [...zyliss, reply([], question)] });
  for (const code of ["E910076", "E910077"]) assert.equal(chose(code, 2, after("Is it the E910076 (22.8cm)? Or is it the E910077 you'd like?", "yes, 2")), false, code);
  assert.equal(chose("E910076", 2, after("Sure. Is this for cutting fabric, like the E910076 is made for?", "yes 2 pcs")), false);
  const blenders = [greeting, reply([waring64, waring2l]), reply([mika], "Cheaper.")];
  for (const question of ["Is it the Waring you had in mind, or the Mika?", "Is it the Waring MX1100XTXEE, or the Mika?"]) {
    for (const code of ["MK-768L", "MX1100XTXEE", "MX1000XTXEE"]) {
      assert.equal(chose(code, 2, { texts: [said("yes 2", 4)], replies: [...blenders, reply([], question)] }), false, `${question} ${code}`);
    }
  }
  assert.equal(chose("UT12HR", 5, { texts: [said("yes 5", 3)], replies: [greeting, reply([tong9, tong12]), reply([], "Do you want the 12in or a longer one?")] }), false);
  assert.equal(chose("UT16HR", 2, { texts: [said("yes 2", 3)], replies: [greeting, reply([tong9, tong12, tong16]), reply([], "Noted. Is it for your 16\" tong grill station?")] }), false);
  // s05-B T1: a yes to "Want me to check ...?" under two trolleys.
  const trolleys = [greeting, reply([
    card("JW-RK16-2N", "Jiwins Stainless Steel Double Column Trolley For GN 1/1 Inserts With Reinforcement Bar W74xD55xH170cm, 5 Swivel Castors With 2 Brakes, Max Load: 15Kg/Shelf Or 200Kgs/Trolley", 380.73),
    card("113003", "S/S SINGLE COLUMN TROLLEY FOR GN 2/1 INSERTS W59xD67xH173.5cm, MAX LOAD: 60kg", 253.21),
  ], "A GN 1/1-size shelf takes two 1/2 GN pans side by side. If you want exactly 2x1/2 per level, the single column GN 1/1 trolley (JW-RK16) fits that but is out of stock. Want me to check single-column GN 1/1 alternatives that are in stock?")];
  for (const code of ["JW-RK16-2N", "113003"]) assert.equal(chose(code, 2, { texts: [said("Yes per level 2 pans side by side", 2)], replies: trolleys }), false, code);
});

test("'i said 50' and a complaint starting with 'why' still say yes to the only card Claire just showed (exam 3)", () => {
  // c12-stress T6: "7cm" is not the 70mm card's size, so only the insisted quantity is the yes.
  const moulds = [greeting, reply([mould60], "The closest is the CCK #19 (Ø60mm), $0.64 each."), reply([mould60], "Got it: added 50 pcs."),
    reply([mould70], "Removed the 60mm one. For 7cm, this is the CCK #12, Ø70mm, same $0.64 each. How many do you need?")];
  const insisted = { texts: [said("i said 50 already lah", 4, 0), said("wait i measure again is 7cm leh. change to the 7cm one, same 50", 3, 1)], replies: moulds };
  assert.equal(chose("158-12", 50, insisted), true);
  assert.equal(chose("158-19", 50, insisted), false);
  // The number may come first (runs-new c10-persona T13 "3 lah i told u already") or end in "only" or "ok".
  for (const text of ["50 lah i told u already", "i said 50 only", "i told u 50 ok"]) assert.equal(chose("158-12", 50, { texts: [said(text, 4)], replies: moulds }), true, text);
  // c08-stress T9: "detachable" also fits the older Atlantic card, so the text before it picks nothing.
  const scissorSets = [greeting, reply([card("ST-26", "-TS- S/S KITCHEN SCISSOR 20cm, JPN", 15.5), atlantic]), reply([shibazi, shibaziDetachable, zebra]), reply([shibazi], "Got it: 3 added. Anything else?"),
    reply([shibaziDetachable], "Just to confirm - this is the SB3027 Shibazi Detachable Household Kitchen Scissors, 20.5cm, at $10.00. Is this the one you mean?")];
  const complaint = { texts: [said("yes!! why every time must ask again. n i ask total u never answer", 5, 0), said("ok add the detachable one also, 2. total how much", 4, 1)], replies: scissorSets };
  assert.equal(chose("SB3027", 2, complaint, ["SB3038"]), true);
  // A real question still needs the number in the yes.
  assert.equal(chose("SB3027", 2, { texts: [said("ok, why is it $10?", 5)], replies: scissorSets }, ["SB3038"]), false);
  const plate = [greeting, reply([plate24], "How many do you need?")];
  assert.equal(chose("P-24", null, { texts: [said("ok why keep changing price", 2)], replies: plate }), false);
  // A number the customer objects to is no quantity.
  assert.equal(chose("P-24", 5, { texts: [said("i told u 5 is too many", 2)], replies: plate }), false);
});

test("15 long replies of long-named cards and long questions are read quickly", () => {
  // Card names, replies and texts come from the client; the price, superlative, switch and question rules read them all.
  const name = (n: number) => `Stainless Steel Utility Tong With Locking Ring ${n} inch Heavy Duty Porcelain Plate Bowl Cup Scissors Knife ${n}cm ${"Word".repeat(3)} `.repeat(3).slice(0, 190);
  const replies = Array.from({ length: 15 }, (_, r) => reply(
    Array.from({ length: 5 }, (_, i) => card(`C-${r * 5 + i}`, name(r * 5 + i), 3 + ((r * 5 + i + 1) % 7))),
    Array.from({ length: 60 }, (_, i) => `Is it the C-${r * 5 + (i % 5)} tong you want, the ${i} inch one?`).join(" ").slice(0, 1900),
  ));
  const texts = Array.from({ length: 6 }, (_, i) => said(`ok the cheap 4 slot and the ${i} dollar tong plus the bigger bowl n plate, take 2, change the knife to the 7 dollar scissors one `.repeat(4).slice(0, 480), 15 - i, i));
  const picks: PickEvidence = { taps: [], texts, replies };
  const start = performance.now();
  pickedCodes(picks, []);
  for (let i = 0; i < 20; i += 1) customerChose(`C-${i}`, 2, picks, []);
  const took = performance.now() - start;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
});

test("distinct refusal clauses between distinct cheap or numbered picks in long texts are read quickly", () => {
  // Every clause is new, so the per-clause cache can't hide the refusals being read again for each one.
  const name = (n: number) => `Stainless Steel Utility Tong With Locking Ring ${n} inch Heavy Duty Porcelain Plate Bowl Cup Scissors Knife ${n}cm ${"Word".repeat(3)} `.repeat(3).slice(0, 190);
  const replies = Array.from({ length: 15 }, (_, r) => reply(Array.from({ length: 5 }, (_, i) => card(`C-${r * 5 + i}`, name(r * 5 + i), 3 + ((r * 5 + i + 1) % 7))), "How many do you need?"));
  const long = (seed: number, max: number) => {
    let out = "";
    for (let i = 0; out.length < max; i += 1) out += i % 2 ? `take the cheapest tong ${seed * 1000 + i}, ` : `no spoon ${seed * 1000 + i}, take ${i % 9 + 1} z${seed}${i}, no q${seed}${i}, `;
    return out.slice(0, max);
  };
  const picks: PickEvidence = { taps: [], texts: Array.from({ length: 6 }, (_, i) => said(long(i, i ? 2000 : 500), 15 - i, i)), replies };
  const start = performance.now();
  pickedCodes(picks, []);
  customerChose("C-3", 2, picks, []);
  const took = performance.now() - start;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
});

test("'2 or 3 in total' is no 2in size; '4 or 6 inch' and '4 or 6 slots' still are", () => {
  const pan2 = card("SP-2", "Steam Table Pan 2\" Deep", 20);
  const pan4 = card("SP-4", "Steam Table Pan 4\" Deep", 25);
  assert.deepEqual([...hits(pan2, "need 2 or 3 in total for the steam table pan")].sort(), ["steam", "table"]);
  assert.ok(hits(pan4, "the 4 or 6 inch pan").has("4in"));
  assert.ok(hits(toaster4, "4 or 6 slots toaster").has("4slot"));
  assert.equal(chose("SP-2", 2, { texts: [said("the steam pan, need 2 or 3 in total", 2)], replies: [greeting, reply([pan2, pan4])] }), false);
});

test("a long run of spaces is read quickly", () => {
  const text = `1${" ".repeat(2000)}z`;
  const asked = reply([safico], "How many do you need?");
  const picks: PickEvidence = { taps: [], texts: [said(text, 4, 0), said(text, 3, 1), said(text, 2, 2)], replies: [greeting, asked, asked, asked] };
  const start = performance.now();
  customerChose("BTS-8026D", 1, picks, []);
  pickedCodes(picks, []);
  const took = performance.now() - start;
  assert.ok(took < 100, `took ${Math.round(took)} ms`);
});

test("a request crafted with many look-alike cards and refusals is read quickly", () => {
  // Card names and texts come from the client: 60 shared words per card once took a pick check 76 s.
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const words = Array.from({ length: 61 }, (_, i) => `q${letters[Math.floor(i / 26)]}${letters[i % 26]}x`);
  const shared = words.slice(0, 60).join(" ");
  const refusal = `no ${words.join(" ")}`;
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let a = 0; a < 24; a += 1) {
    const cards = [...Array.from({ length: 5 }, (_, i) => `A${a * 5 + i} ${shared}`), `B${a} ${words.join(" ")}`];
    history.push({ role: "assistant", content: `Here.\n[cards shown: ${cards.join("; ")}]` });
  }
  for (let u = 0; u < 5; u += 1) history.push({ role: "user", content: Array(6).fill(refusal).join(". ") });
  const picks = pickEvidence(history, { type: "text", text: refusal });
  assert.ok(picks.replies.every((item) => item.cards.length <= 5));
  const start = performance.now();
  customerChose("A0", 2, picks, []);
  pickedCodes(picks, []);
  const took = performance.now() - start;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
});

test("a long run of spaces in a card name is read quickly", () => {
  const name = `1${" ".repeat(1950)}!`;
  const text = "no,".repeat(50);
  const replies = [greeting, reply([card("X1", name)]), reply([card("X2", name)]), reply([card("X3", name)])];
  const picks: PickEvidence = { taps: [], texts: [said(text, 4, 0), said(text, 3, 1), said(text, 2, 2)], replies };
  const start = performance.now();
  customerChose("X1", 2, picks, []);
  pickedCodes(picks, []);
  const took = performance.now() - start;
  assert.ok(took < 100, `took ${Math.round(took)} ms`);
});
