// src/lib/agent/picks.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ShownCard } from "./contract";
import { hits, pickEvidence, pointedCards } from "./picks";

const card = (code: string, name: string, price: number | null = 10): ShownCard => ({ code, name, price, link: null });
const codes = (cards: ShownCard[]) => cards.map((item) => item.code);

const safico = card("BTS-8026D", "CASSETTE GAS TORCH BURNER SAFICO PRO", 23.36);
const luminarc = card("Q1930", "Luminarc Everyday Opal Glass Dinner Plate Ø24cm", 5.41);
const carrara = card("F3-CRR-01009-27", "Cerabon Petye Carrara Porcelain Round Dinner Plate Ø27.5cm", 24.68);
const waring2l = card("MX1100XTXEE", "Waring Commercial Electronic Blender With Bpa-Free Container, 2L", 1288.99);
const waring64 = card("MX1000XTXEE", "Waring Commercial Hi-Power Blender With 64 Oz. Bpa-Free Copolyester Container", 1220.18);
const waringGallon = card("CB15K", "Waring Commercial One-Gallon 3.75 Hp Food Blender With Electronic Keypad", 3223.85);
const toaster4 = card("HET-4", "S/S 4-SLOTS TOASTER, 340x230x250mm, 230V/50Hz/1800W, •1 YEAR WARRANTY•", 196.36);
const toaster6 = card("HET-6", "Stainless Steel 6-Slots Toaster,230V/50Hz/2500W", 257.85);
const tong12 = card("UT12HR", "Stainless Steel Utility Tong with Locking Ring 12\"", 4.77);
const tong16 = card("UT16HR", "Stainless Steel Utility Tong with Locking Ring 16\"", 5.69);
const meshStrainer = card("13122-0304", "Stainless Steel Strainer Fine Mesh With Stainless Steel Handle 10.5\"", 18.53);
const skimmer = card("13128-0401", "S/S FINE MESH SKIMMER Ø15cm", 2.29);
const scissors = card("E910076", "Zyliss Stainless Steel Household Scissors", 29.27);
const siliconeTong = card("02-00864", "Safico Stainless Steel Tong With Silicone Grip L32cm, BPA Free", 11.83);
const steakTong = card("ST-15", "Stainless Steel Steak Tong 15\"", 12.48);
const zylissBasic = card("E910077", "Zyliss Polypropylene Basic Household Scissors Basic, Gray", 22.84);
const shibazi = card("SB3038", "Stainless Steel Household Kitchen Scissors L21cm, Shibazi", 7.25);
const shibaziDetachable = card("SB3027", "Stainless Steel Detachable Household Kitchen Scissors L20.5cm, Shibazi", 10);
const zebra = card("993-003-RD", "Zebra Multi-Purpose Scissors 22.5cm,Red, Together", 19.17);
const skimmer165 = card("13128-0402", "S/S FINE MESH SKIMMER Ø16.5cm", 2.75);
const skimmer19 = card("13128-0403", "S/S FINE MESH SKIMMER Ø19cm", 3.21);
const skimmer24 = card("13128-0405", "S/S FINE MESH SKIMMER Ø24cm", 5.05);
const wireMesh26 = card("00600500104", "Stainless Steel Wire Mesh Strainer With Wooden Handle 26cm", 7.25);
const tong9 = card("UT09L", "Stainless Steel Utility Tong 9\"", 2.02);
const plainTong16 = card("2564L", "Stainless Steel Utility Tong 16\"", 3.85);
const scallopTong = card("JQ-OT113", "STAINLESS STEEL SCALLOP TONG with PLASTIC HANDLE", 3.85);
const edlund16 = card("36670", "Edlund Stainless Steel Heavy Duty Grip Tong 16\"", 34.86);
const edlundLock = card("34471", "S/S HD SCALLOP TONG WITH LOCK 12\", EDLUND", 27.52);
const plate24 = card("P-24", "Porcelain Dinner Plate 24cm", 5);
const plate27 = card("P-27", "Porcelain Dinner Plate 27cm", 8);
const plate30 = card("P-30", "Porcelain Dinner Plate 30cm", 12);

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
  assert.deepEqual(codes(pointedCards("the 16 inch one", [tong12, tong16])), ["UT16HR"]);
  assert.deepEqual(pointedCards("the tong", [tong12, tong16]), []);
  assert.deepEqual(codes(pointedCards("the $1,220 one", [waring2l, waring64])), ["MX1000XTXEE"]);
});

test("a size points at the card with that size, and a word two cards share points at neither", () => {
  assert.deepEqual(codes(pointedCards("6 slot 2 only", [toaster4, toaster6])), ["HET-6"]);
  assert.deepEqual(codes(pointedCards("the 16 inch one, 4", [tong12, tong16])), ["UT16HR"]);
  assert.deepEqual(pointedCards("the plate also 4", [luminarc, carrara]), []);
});

test("a price in 'the 5 dollar one' or 'the 1.2k one' form points at the card with that price", () => {
  assert.deepEqual(codes(pointedCards("the 5 dollar one la i said already", [luminarc, carrara])), ["Q1930"]);
  assert.deepEqual(codes(pointedCards("i take the waring 1.2k one. 2 unit", [waring2l, waring64, waringGallon])), ["MX1000XTXEE"]);
  assert.deepEqual(codes(pointedCards("i take the $1,220 one, 2 unit", [waring2l, waring64, waringGallon])), ["MX1000XTXEE"]);
});

test("a price counts with the card's own name words before 'one' or right after it, but not as a budget (exam 3)", () => {
  // c08-stress T6: "shibazi" alone fits both Shibazi scissors; the price tells them apart.
  assert.deepEqual(codes(pointedCards("i take the 7 dollar shibazi one, 3 pcs", [shibazi, shibaziDetachable, zebra, scissors, zylissBasic])), ["SB3038"]);
  // c06-persona T8: "the 2 dollar skimmer", after the skimmer was re-shown without a price.
  const skimmers = [skimmer, skimmer19, skimmer24, meshStrainer, { ...skimmer, price: null }, { ...wireMesh26, price: null }, wireMesh26];
  assert.deepEqual(codes(pointedCards("The 2 dollar skimmer also take 2 lah, for scoop the egg", skimmers)), ["13128-0401"]);
  // c10-stress T5: "the 16 inch cheap one, the 3 dollar plus one" is the $3.85 16-inch tong.
  const tongs = [tong9, steakTong, siliconeTong, plainTong16, tong16, scallopTong, edlund16, edlundLock];
  assert.deepEqual(codes(pointedCards("then 3 more of the 16 inch cheap one, the 3 dollar plus one", tongs)), ["2564L"]);
  assert.deepEqual(pointedCards("i pay 5 dollar for one also can, 2 pcs", [plate24, plate27, plate30]), []);
  const twoSkimmers = [card("A1", "Round Skimmer 10cm", 5.29), card("B2", "Square Skimmer 12cm", 3.1)];
  for (const text of ["i want below 5 dollar one, 2 pcs", "budget 5 dollar one, 2 pcs"]) assert.ok(!hits(twoSkimmers[0], text).has("$price"), text);
  assert.deepEqual(codes(pointedCards("i want the 5 dollar one, 2 pcs", twoSkimmers)), ["A1"]);
});

test("when several cards fit a typed price, only those whose price rounds to it keep it, and a tie points at none (exam 3, c06-stress T4)", () => {
  assert.deepEqual(codes(pointedCards("ok the 2 dollar one lah, take 2", [wireMesh26, skimmer, skimmer165, skimmer19])), ["13128-0401"]);
  assert.deepEqual(pointedCards("the 5 dollar one, 10", [card("A-510", "Dinner Plate A", 5.1), card("A-545", "Dinner Plate B", 5.45)]), []);
  assert.deepEqual(pointedCards("the 3 dollar plus one", [plainTong16, scallopTong]), []);
});

test("a card re-shown as Price to be confirmed keeps the price shown earlier (exam 3, c10-persona T8)", () => {
  const tbc = (item: ShownCard) => ({ ...item, price: null });
  const cards = [steakTong, siliconeTong, tong9, plainTong16, scallopTong, tbc(steakTong), tbc(siliconeTong), tbc(tong9), tbc(plainTong16), plainTong16, scallopTong, tong16];
  assert.deepEqual(codes(pointedCards("the 2 dollar one also, 10", cards)), ["UT09L"]);
});

test("'2 or 3 in total' is no 2in size; '4 or 6 inch' and '4 or 6 slots' still are", () => {
  const pan2 = card("SP-2", "Steam Table Pan 2\" Deep", 20);
  const pan4 = card("SP-4", "Steam Table Pan 4\" Deep", 25);
  assert.deepEqual([...hits(pan2, "need 2 or 3 in total for the steam table pan")].sort(), ["steam", "table"]);
  assert.ok(hits(pan4, "the 4 or 6 inch pan").has("4in"));
  assert.ok(hits(toaster4, "4 or 6 slots toaster").has("4slot"));
  assert.deepEqual(pointedCards("the steam pan, need 2 or 3 in total", [pan2, pan4]), []);
});

test("15 long replies of long-named cards and long questions are read quickly", () => {
  // Card names, replies and texts come from the client; the guards point every reply sentence and text at these cards.
  const name = (n: number) => `Stainless Steel Utility Tong With Locking Ring ${n} inch Heavy Duty Porcelain Plate Bowl Cup Scissors Knife ${n}cm ${"Word".repeat(3)} `.repeat(3).slice(0, 190);
  const cards = Array.from({ length: 75 }, (_, i) => card(`C-${i}`, name(i), 3 + ((i + 1) % 7)));
  const questions = Array.from({ length: 15 }, (_, r) => Array.from({ length: 60 }, (_, i) => `Is it the C-${r * 5 + (i % 5)} tong you want, the ${i} inch one?`).join(" ").slice(0, 1900));
  const texts = Array.from({ length: 6 }, (_, i) => `ok the cheap 4 slot and the ${i} dollar tong plus the bigger bowl n plate, take 2, change the knife to the 7 dollar scissors one `.repeat(4).slice(0, 480));
  const start = performance.now();
  for (const text of [...questions, ...texts]) pointedCards(text, cards);
  const took = performance.now() - start;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
});

test("a long run of spaces is read quickly", () => {
  const text = `1${" ".repeat(2000)}z`;
  const start = performance.now();
  for (let i = 0; i < 3; i += 1) pointedCards(text, [safico, skimmer]);
  const took = performance.now() - start;
  assert.ok(took < 100, `took ${Math.round(took)} ms`);
});

test("a request crafted with many look-alike cards is read quickly", () => {
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
  const cards = picks.replies.flatMap((item) => item.cards);
  const start = performance.now();
  for (const text of picks.texts) pointedCards(text.text, cards);
  const took = performance.now() - start;
  assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
});

test("a long run of spaces in a card name is read quickly", () => {
  const name = `1${" ".repeat(1950)}!`;
  const cards = [card("X1", name), card("X2", name), card("X3", name)];
  const start = performance.now();
  for (let i = 0; i < 3; i += 1) pointedCards("no,".repeat(50), cards);
  const took = performance.now() - start;
  assert.ok(took < 100, `took ${Math.round(took)} ms`);
});
