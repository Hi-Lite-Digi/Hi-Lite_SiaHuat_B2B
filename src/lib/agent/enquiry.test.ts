// src/lib/agent/enquiry.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  QTY_NOTICE, applyEnquiryAction, enquiryTotals, firstListItem, gstWords, inPieces, listItemCount, quantityStated, sameQuantityText, statesAnyQuantity, totalsWithGst,
  typedQuantities, verifyEnquiry, withGstCents,
} from "./enquiry";
import { allowedCents } from "./guards";
import { fakeDeps, product } from "./testing";

const torch = product({ stock_id: "BTS-8026D", name: "CASSETTE GAS TORCH BURNER L15.6xW5.8xH5cm, BLUE, SAFICO PRO", list_price: 23.36, available_quantity: 40 });
const gas = product({ stock_id: "GAS", name: "IWATANI GAS CARTRIDGE 250gm/can, 3pcs/pkt, 48pcs/ctn", list_price: 3.85, available_quantity: 1759 });

test("a quantity counts only when the customer typed it as a quantity", () => {
  assert.equal(quantityStated(2, ["I need 2 blow torches"]), true);
  assert.equal(quantityStated(2, ["2pcs pls"]), true);
  assert.equal(quantityStated(2, ["x2"]), true);
  assert.equal(quantityStated(3, ["three please"]), true);
  assert.equal(quantityStated(5, ["CASSETTE GAS TORCH BURNER L15.6xW5.8xH5cm"]), false);
  assert.equal(quantityStated(12, ["Stainless Steel Pot 12QT"]), false);
  assert.equal(quantityStated(2, ["blow torch"]), false);
});

test("sizes written with a space and prices do not count as quantities", () => {
  assert.equal(quantityStated(5, ["the 5 cm torch"]), false);
  assert.equal(quantityStated(12, ["Stainless Steel Pot 12 QT"]), false);
  assert.equal(quantityStated(24, ["24 cm pot"]), false);
  assert.equal(quantityStated(5, ["5 L"]), false);
  assert.equal(quantityStated(2, ["2 kg bag"]), false);
  assert.equal(quantityStated(23, ["is it $23?"]), false);
  assert.equal(quantityStated(23, ["S$ 23 each?"]), false);
  assert.equal(quantityStated(20, ["20 more"]), true);
  assert.equal(quantityStated(5, ["5 large pots"]), true);
  assert.equal(quantityStated(2, ["2 gas cans"]), true);
});

test("the word \"in\" after a number is not a size unit", () => {
  assert.equal(quantityStated(5, ["I need 5 in blue"]), true);
  assert.equal(quantityStated(2, ["2 in red please"]), true);
  assert.equal(quantityStated(2, ["do you have 2 in stock"]), true);
  assert.equal(quantityStated(6, ["6 inch pan"]), false);
  assert.equal(quantityStated(6, ["6in pan"]), false);
});

test("option numbers, sizes, tiers, burners and outlet counts are not quantities", () => {
  const notQuantities: Array<[number, string]> = [
    [2, "I'll take option 2"], [3, "3-tier stand"], [2, "2 burner stove"], [2, "size 2"], [4, "4 outlets"],
    [4, "we have 4 outlets"], [5, "model 5"], [2, "the 2nd one"], [2, "#2"], [6, "6 slot toaster"], [48, "48pcs/ctn"],
    [1, "give me 2 of option 1"],
  ];
  for (const [quantity, text] of notQuantities) assert.equal(quantityStated(quantity, [text]), false, text);
  const quantities: Array<[number, string]> = [
    [2, "2 pcs"], [2, "I need 2"], [2, "2 please"], [3, "x3"], [3, "3 units"], [2, "give me 2 of option 1"],
  ];
  for (const [quantity, text] of quantities) assert.equal(quantityStated(quantity, [text]), true, text);
});

test("Chinese numbers count as quantities only before a measure word or at the end", () => {
  assert.equal(quantityStated(2, ["我要两个"]), true);
  assert.equal(quantityStated(12, ["十二个"]), true);
  assert.equal(quantityStated(5, ["来五箱"]), true);
  assert.equal(quantityStated(3, ["要3个"]), true);
  assert.equal(quantityStated(3, ["三层架"]), false);
  assert.equal(quantityStated(2, ["两头炉"]), false);
});

test("Chinese ordinals, option numbers and model numbers are not quantities", () => {
  const notQuantities: Array<[number, string]> = [
    [2, "我要第二个"], [2, "第二"], [2, "第2个"], [2, "选项二"], [2, "选项2"], [2, "型号2"], [2, "2号"], [2, "2款"], [1, "第一个要2个"],
  ];
  for (const [quantity, text] of notQuantities) assert.equal(quantityStated(quantity, [text]), false, text);
  assert.equal(quantityStated(2, ["第一个要2个"]), true);
  assert.equal(quantityStated(2, ["我要两个"]), true);
});

test("adding needs a stated quantity", async () => {
  const deps = fakeDeps([torch]);
  const refused = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ["blow torch"], deps);
  assert.deepEqual(refused.ok ? null : refused.error, "QTY_NOT_STATED");
  const added = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ["2 torches"], deps);
  assert.equal(added.ok && added.lines[0].quantity, 2);
  assert.equal(added.ok && added.lines[0].total, 46.72);
});

test("stock limits count what is already on the enquiry", async () => {
  const deps = fakeDeps([torch]);
  const first = await applyEnquiryAction([], { action: "set", stock_id: "BTS-8026D", quantity: 30 }, ["30 pcs"], deps);
  assert.ok(first.ok);
  const over = await applyEnquiryAction(first.ok ? first.lines : [], { action: "add", stock_id: "BTS-8026D", quantity: 20 }, ["20 more"], deps, { currentText: "20 more" });
  assert.deepEqual(over.ok ? null : [over.error, over.available], ["OVER_STOCK", 40]);
});

test("out-of-stock and unverified items are refused", async () => {
  const outOfStock = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 1 }, ["1"], fakeDeps([torch], { "BTS-8026D": { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 } }));
  assert.equal(outOfStock.ok ? null : outOfStock.error, "OUT_OF_STOCK");
  const unverified = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 1 }, ["1"], fakeDeps([torch], { "BTS-8026D": "fail" }));
  assert.equal(unverified.ok ? null : unverified.error, "STOCK_UNVERIFIED");
});

test("a removed store listing is never added: LISTING_GONE with its notice and the product (r8 R01)", async () => {
  const gone = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 1 }, ["1"], fakeDeps([torch], { "BTS-8026D": "gone" }));
  assert.equal(gone.ok ? null : gone.error, "LISTING_GONE");
  assert.match(gone.ok ? "" : gone.notice ?? "", /listing has been removed/);
  assert.deepEqual([gone.product?.product.stock_id, gone.product?.gone], ["BTS-8026D", true]);
});

test("cartons convert only with the product's own pack size", async () => {
  const cartons = await applyEnquiryAction([], { action: "add", stock_id: "GAS", quantity: 2, unit: "carton" }, ["2 ctn"], fakeDeps([gas]));
  assert.equal(cartons.ok && cartons.lines[0].quantity, 96);
  const unknown = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 2, unit: "carton" }, ["2 ctn"], fakeDeps([torch]));
  assert.equal(unknown.ok ? null : unknown.error, "PACK_SIZE_UNKNOWN");
});

test("the unit must be the one the customer typed with the number", async () => {
  const add = (text: string, unit?: "uom" | "carton" | "packet") => applyEnquiryAction([], { action: "add", stock_id: "GAS", quantity: 2, unit }, [text], fakeDeps([gas]));
  const refused: Array<[string, "uom" | "carton" | "packet" | undefined]> = [
    ["2", "carton"], ["2 pcs", "packet"], ["2 ctn", "packet"], ["2 ctn", "uom"], ["2 ctn", undefined], ["two cartons", "uom"], ["来2箱", "uom"],
  ];
  for (const [text, unit] of refused) {
    const result = await add(text, unit);
    assert.equal(result.ok ? null : result.error, "UNIT_MISMATCH", `${text} + ${unit}`);
  }
  const accepted: Array<[string, "uom" | "carton" | "packet" | undefined, number]> = [
    ["2 ctn", "carton", 96], ["来2箱", "carton", 96], ["two cartons", "carton", 96], ["2 pkts", "packet", 6], ["2 pcs", "uom", 2], ["2 pcs", undefined, 2],
  ];
  for (const [text, unit, quantity] of accepted) {
    const result = await add(text, unit);
    assert.equal(result.ok && result.lines[0].quantity, quantity, `${text} + ${unit}`);
  }
});

test("remove and clear", async () => {
  const deps = fakeDeps([torch, gas]);
  const lines = [
    { item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" },
    { item: gas.name, code: "GAS", pricePerItem: 3.85, quantity: 48, total: 184.8, uom: "PC" },
  ];
  const removed = await applyEnquiryAction(lines, { action: "remove", stock_id: "bts-8026d" }, [], deps);
  assert.deepEqual(removed.ok && removed.lines.map((line) => line.code), ["GAS"]);
  const cleared = await applyEnquiryAction(lines, { action: "clear" }, ["please clear everything"], deps);
  assert.deepEqual(cleared.ok && cleared.lines, []);
});

test("clearing needs the customer to ask for it", async () => {
  const deps = fakeDeps([torch]);
  const lines = [{ item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
  const refused = await applyEnquiryAction(lines, { action: "clear" }, ["blow torch", "2 please"], deps);
  assert.equal(refused.ok ? null : refused.error, "CLEAR_NOT_REQUESTED");
  for (const text of ["Let's start over", "cancel everything please", "清空"]) {
    const cleared = await applyEnquiryAction(lines, { action: "clear" }, [text], deps);
    assert.deepEqual(cleared.ok && cleared.lines, [], text);
  }
});

test("removing a code that is not on the enquiry is refused", async () => {
  const deps = fakeDeps([torch]);
  const empty = await applyEnquiryAction([], { action: "remove", stock_id: "ZZZ" }, [], deps);
  assert.equal(empty.ok ? null : empty.error, "NOT_FOUND");
  const lines = [{ item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
  const wrongCode = await applyEnquiryAction(lines, { action: "remove", stock_id: "GAS" }, [], deps);
  assert.equal(wrongCode.ok ? null : wrongCode.error, "NOT_FOUND");
});

test("re-verification refreshes prices, trims to stock and removes sold-out lines", async () => {
  const deps = fakeDeps([torch, gas], {
    "BTS-8026D": { price_ex_gst: 25, available_quantity: 3 },
    GAS: { stock_status: "out_of_stock", in_stock: false, available_quantity: 0 },
  });
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 5 }, { stockId: "GAS", quantity: 48 }], deps);
  assert.deepEqual(result.lines.map((line) => [line.code, line.quantity, line.pricePerItem]), [["BTS-8026D", 3, 25]]);
  assert.equal(result.notes.length, 2);
});

test("re-verification combines duplicate echo lines by code before checking stock", async () => {
  const deps = fakeDeps([torch], { "BTS-8026D": { available_quantity: 5 } });
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 4 }, { stockId: "bts-8026d", quantity: 4 }], deps);
  assert.deepEqual(result.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 5]]);
  assert.match(result.notes[0], /reduced from 8/);
  const withinStock = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }, { stockId: "BTS-8026D", quantity: 2 }], deps);
  assert.deepEqual(withinStock.lines.map((line) => [line.code, line.quantity]), [["BTS-8026D", 4]]);
});

test("a line whose catalogue lookup fails stays with the browser instead of being removed", async () => {
  const failing = fakeDeps([torch]);
  failing.findByCode = async () => { throw new Error("SUPABASE_PRODUCT_500"); };
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }], failing);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.unchecked, ["BTS-8026D"]);
  // The unchecked list carries it; a note under "Enquiry changes" read as a removal (exam 3, c08-stress T12).
  assert.deepEqual(result.notes, []);
});

test("a line whose live re-check fails stays with the browser and its catalogue price is never used", async () => {
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }, { stockId: "GAS", quantity: 48 }], fakeDeps([torch, gas], { "BTS-8026D": "fail" }));
  assert.deepEqual(result.lines.map((line) => line.code), ["GAS"]);
  assert.deepEqual(result.unchecked, ["BTS-8026D"]);
  assert.deepEqual(result.notes, []);
  const allowed = allowedCents(result.products, result.lines, enquiryTotals(result.lines).grandTotal);
  assert.equal(allowed.has(2336), false);
  assert.equal(allowed.has(4672), false);
});

test("a line whose store listing was removed stays with the browser as unchecked, is named gone and is never a product (r8 R01)", async () => {
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }, { stockId: "GAS", quantity: 48 }], fakeDeps([torch, gas], { "BTS-8026D": "gone" }));
  assert.deepEqual(result.lines.map((line) => line.code), ["GAS"]);
  assert.deepEqual([result.unchecked, result.gone], [["BTS-8026D"], ["BTS-8026D"]]);
  assert.deepEqual([...result.products.keys()], ["GAS"]);
  assert.deepEqual(result.notes, []);
});

test("totals are rounded to cents", () => {
  const totals = enquiryTotals([
    { item: "a", code: "A", pricePerItem: 0.1, quantity: 1, total: 0.1, uom: "PC" },
    { item: "b", code: "B", pricePerItem: 0.2, quantity: 1, total: 0.2, uom: "PC" },
  ]);
  assert.equal(totals.grandTotal, 0.3);
});

test("an amount with GST is worked out in whole cents, rounded half-up", () => {
  // Owner decision 2: code gives the estimate (exam 4: 18 of the 19 chats that asked about GST were refused).
  const cases: Array<[number, number]> = [[37.34, 4070], [34.14, 3721], [712.06, 77615], [1307.4, 142507], [73.3, 7990], [9.91, 1080], [0.5, 55], [1.5, 164], [50, 5450]];
  for (const [amount, cents] of cases) assert.equal(withGstCents(amount), cents, String(amount));
});

test("the totals with GST add the estimate and its GST part; an empty enquiry has no estimate", () => {
  const lines = [{ item: "Torch", code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
  assert.deepEqual(totalsWithGst(lines), { ...enquiryTotals(lines), grandTotalWithGst: 50.92, gstOnTotal: 4.2 });
  assert.deepEqual(totalsWithGst([]), enquiryTotals([]));
});

test("GST words: gst, tax, 9%, 9 percent, x1.09 and 税; not 19%, 11.09, a 9-piece order or a plain total question", () => {
  for (const text of ["wif gst how much", "incl gst?", "9% only also cannot count meh", "37.34x1.09", "含税多少", "after tax", "9 percent"]) assert.ok(gstWords.test(text), text);
  for (const text of ["ard 37 like that correct anot", "19% cheaper?", "11.09 one", "take 9 pcs", "total how much now"]) assert.equal(gstWords.test(text), false, text);
});

test("numbers inside item codes and GN fractions are not quantities", () => {
  assert.equal(quantityStated(20, ["Do you have 218455-20?"]), false);
  assert.equal(quantityStated(218455, ["Do you have 218455-20?"]), false);
  assert.equal(quantityStated(8026, ["BTS-8026 please"]), false);
  assert.equal(quantityStated(1, ["need 1/2 GN pan"]), false);
  assert.equal(quantityStated(2, ["need 1/2 GN pan"]), false);
  assert.equal(quantityStated(2, ["2/3 pan"]), false);
  assert.equal(quantityStated(2, ["2 pcs of the 1/2 GN pan"]), true);
});

test("a number followed by a full stop still counts, a decimal does not", () => {
  assert.equal(quantityStated(2, ["ok 2. how many u have in stock"]), true);
  assert.equal(quantityStated(2, ["2. also 1 of the 6 slot"]), true);
  assert.equal(quantityStated(2, ["2.5 kg"]), false);
});

test("product names, prices, head counts, repeats and inch sizes are not quantities", () => {
  const notQuantities: Array<[number, string]> = [
    [3, "how about cordless 3-in-1 blender"], [3, "cordless 3 in 1 blender"], [4, "need dining set 4 ppl"], [1, "1 more time ask me tap"],
    [5, "the 5 dollar one la"], [62, "62 bucks some more"], [20, "wah 20+ so ex for tong"], [4, "4 or 6 slot"], [2, "show the 2 again i tap"],
    [26, "change to the 16cm wide one. 26 too long"], [16, 'the 16" one'], [18, "CCK 18″ wok pls"],
    [3, "same same reply 3 times already. cant u just get someone call me"], [2, "asked 2 times liao"],
  ];
  for (const [quantity, text] of notQuantities) assert.equal(quantityStated(quantity, [text]), false, text);
  const quantities: Array<[number, string]> = [
    [20, "20 more"], [3, "3"], [4, '4 x 16" tongs'], [5, "1) Pot x 5\n2) Lid\n3) Ladle"], [5, "1) Pot x 5 2) Lid 3) Ladle"], [2, "pot x2 + lid x3"],
    [2, "need 2 in 2 sizes"], [2, "need 2 in 3 days"], [5, "can deliver 5 in 2 days?"],
  ];
  for (const [quantity, text] of quantities) assert.equal(quantityStated(quantity, [text]), true, text);
});

test("the labels of a numbered list are not quantities", () => {
  const list = [
    "Hi, can you send me a quote for the following items:", "1) Stainless Steel Pot 12QT", "2) Stainless Steel Strainer for the 12QT Pot",
    "3) Stainless Steel Ladle 4oz, 6oz, 8oz, length approximate 10inch", '4) 1/2 Stainless Steel Pan, 6" Deep', '5) 1/4 Stainless Steel Pan, 6" Deep',
    "6) Lid for 1/2 S/S Pan with notch for ladle", "7) Lid for 1/4 S/S Pan with notch for ladle", "8) Oyster Knife with Plastic Handle",
  ].join("\n");
  const dotted = list.replace(/^(\d)\)/gm, "$1.");
  // The chat box is a single-line input, so a pasted list reaches the server with its line breaks turned into spaces.
  const forms = { "1) lines": list, "1. lines": dotted, "1) one line": list.replace(/\n/g, " "), "1. one line": dotted.replace(/\n/g, " ") };
  for (const [form, text] of Object.entries(forms)) {
    for (let quantity = 1; quantity <= 8; quantity++) assert.equal(quantityStated(quantity, [text]), false, `${quantity} in the ${form} list`);
  }
  for (let quantity = 1; quantity <= 3; quantity++) assert.equal(quantityStated(quantity, ["1. pot 2. lid 3. ladle"]), false, `${quantity} in 1. pot 2. lid`);
  assert.equal(quantityStated(1, ["1) Pot x 5 2) Lid 3) Ladle"]), false);
  assert.equal(quantityStated(1, ["1) pot x 2 2) lid x 3 3) ladle"]), false);
  // No space after the dot, or an item ending in "x 5." between two labels, still reads as a list.
  const labelsOnly: Array<[string, number[]]> = [
    ["1.pot 2.lid 3.ladle", []], ["1. Pot x 5. 2. Lid. 3. Ladle.", [5]], ["1) Pot x 5. 2) Lid. 3) Ladle.", [5]],
    ["1. Pot 12. 2. Lid 3. Ladle", [12]], ["1. Pot x 2. 2. Lid x 1. 3. Ladle", [1, 2]],
    // A Chinese list has no space after the dot either; a label before a quote or bracket is still a label.
    ["1.锅 2.盖 3.汤勺", []], ["我要报价 1.锅 2.盖 3.汤勺", []], ["1.锅x5 2.盖 3.汤勺", [5]], ['1."pot" 2."lid"', []], ["1.(pot) 2.(lid)", []],
  ];
  for (const [text, stated] of labelsOnly) {
    for (const quantity of [1, 2, 3, 5, 12]) assert.equal(quantityStated(quantity, [text]), stated.includes(quantity), `${quantity} in ${text}`);
  }
  assert.equal(quantityStated(2, ["ok 2."]), true);
  for (const text of ["ok 2..", "take 2... how much", "ok 2. how many u have in stock", "2. also 1 of the 6 slot"]) assert.equal(quantityStated(2, [text]), true, text);
});

test("the word one counts only when it is said as a quantity", () => {
  for (const text of ["take one of each", "one enough.. wait", "just one", "i want one", "one pc", "One please"]) assert.equal(quantityStated(1, [text]), true, text);
  for (const text of ["got cheaper one or not", "that one got plate bowl all?", "the 5 dollar one la", "only one of them", "the 3 one"]) assert.equal(quantityStated(1, [text]), false, text);
});

test("one counts after a short yes or a buying word, and one of the named product counts", () => {
  const quantities = ["ok one", "yes one", "ok la one", "ok, one.", "give me one", "gimme one", "take one of the 6 slot", "also one of the 6 slot", "i want one of those", "pot x2 and one lid"];
  for (const text of quantities) assert.equal(quantityStated(1, [text]), true, text);
  for (const text of ["one of those got lid?", "ok the blue one", "i take one of them", "and one more thing, do u deliver?", "also one question", "One more question: do u deliver?", "ok one more thing", "one sec"]) {
    assert.equal(quantityStated(1, [text]), false, text);
  }
  assert.equal(quantityStated(1, ["and one more please"]), true);
});

test("adding to a line already on the enquiry needs a number typed in this message", async () => {
  const deps = fakeDeps([torch]);
  const lines = [{ item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
  const stale = await applyEnquiryAction(lines, { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ["ok thanks", "2 Safico torch"], deps, { currentText: "ok thanks" });
  assert.equal(stale.ok ? null : stale.error, "ALREADY_ON_ENQUIRY");
  const fresh = await applyEnquiryAction(lines, { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ["add 2 more", "2 Safico torch"], deps, { currentText: "add 2 more" });
  assert.equal(fresh.ok && fresh.lines[0].quantity, 4);
  const set = await applyEnquiryAction(lines, { action: "set", stock_id: "BTS-8026D", quantity: 2 }, ["ok thanks", "2 Safico torch"], deps, { currentText: "ok thanks" });
  assert.equal(set.ok && set.lines[0].quantity, 2);
});

test("re-verification checks at most 6 lines at a time", async () => {
  const items = Array.from({ length: 12 }, (_, index) => product({ stock_id: `L${index}`, name: `Line ${index}` }));
  const deps = fakeDeps(items);
  let active = 0;
  let peak = 0;
  const findByCode = deps.findByCode.bind(deps);
  deps.findByCode = async (stockId) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return findByCode(stockId);
  };
  const result = await verifyEnquiry(items.map((item) => ({ stockId: item.stock_id, quantity: 1 })), deps);
  assert.equal(result.lines.length, 12);
  assert.ok(peak <= 6, `peak concurrency ${peak}`);
});

test("statesAnyQuantity reads the customer's numbers the way quantityStated does", () => {
  for (const text of ["2 ctn pls", "same 50", "two pls", "要二十个"]) assert.equal(statesAnyQuantity([text]), true, text);
  for (const text of ["same qty", "the 5 dollar one", "option 2 pls"]) assert.equal(statesAnyQuantity([text]), false, text);
});

test("'same qty' reuses the one number the customer typed in their newest four texts", () => {
  // exam 3, c09-stress T7: the 20 was typed two messages before "same qty", outside the two-text window. Newest first.
  const typed = ["ya tht one. same qty", "wait 16 inch too long for my kitchen la. got shorter one with the lock thing? 12 inch like tht", "ok la take the 16 inch one, 20pcs"];
  assert.equal(sameQuantityText(typed[0], typed), "ok la take the 16 inch one, 20pcs");
  assert.equal(sameQuantityText(typed[0], [typed[0], "2 of the other one", ...typed.slice(1)]), null);
  const notSame = "not same qty ah, i tell u later";
  assert.equal(sameQuantityText(notSame, [notSame, ...typed.slice(1)]), null);
  assert.equal(sameQuantityText("don’t same qty la", ["don’t same qty la", ...typed.slice(1)]), null);
  // Owner question 4 covers "same qty" only: "same as before" often means the product, not the number.
  assert.equal(sameQuantityText("same as before, the red one", ["same as before, the red one", ...typed.slice(1)]), null);
  assert.equal(sameQuantityText("ya tht one", ["ya tht one", ...typed.slice(1)]), null);
  assert.equal(sameQuantityText(null, typed), null);
  // Older than the newest four texts, the number no longer counts.
  assert.equal(sameQuantityText(typed[0], [typed[0], "hmm", "ok", typed[1], typed[2]]), null);
});

// exam 3, s01 T0: the chat box is one line, so the pasted list arrives with its line breaks turned into spaces.
const s01List = [
  "Hi, can you send me a quote for the following items:", "1) Stainless Steel Pot 12QT", "2) Stainless Steel Strainer for the 12QT Pot",
  "3) Stainless Steel Ladle 4oz, 6oz, 8oz, length approximate 10inch", '4) 1/2 Stainless Steel Pan, 6" Deep', '5) 1/4 Stainless Steel Pan, 6" Deep',
  "6) Lid for 1/2 S/S Pan with notch for ladle", "7) Lid for 1/4 S/S Pan with notch for ladle", "8) Oyster Knife with Plastic Handle",
].join(" ");

test("a pasted list's items are counted, and its first item found", () => {
  assert.equal(listItemCount(s01List), 8);
  assert.equal(listItemCount("- pot\n- lid\n- ladle\n- pan"), 4);
  assert.equal(listItemCount("ok 2. also 1 of the 6 slot"), 0);
  assert.equal(listItemCount("3 unit. 2 outlet + 1 spare"), 0);
  assert.equal(firstListItem(s01List), "Stainless Steel Pot 12QT");
  assert.equal(firstListItem("1) pot x 5 2) lid"), "pot x 5");
  assert.equal(firstListItem("1) pot"), null);
  assert.equal(firstListItem("blow torch"), null);
});

test("a live page that shows no quantity leaves the line with the browser instead of dropping it for good", async () => {
  // Before, such a line got "could not be kept" and the browser deleted it.
  const unknownStock = [{ available_quantity: null }, { stock_status: "unknown", available_quantity: null }] as const;
  for (const live of unknownStock) {
    const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }, { stockId: "GAS", quantity: 48 }], fakeDeps([torch, gas], { "BTS-8026D": live }));
    assert.deepEqual(result.lines.map((line) => line.code), ["GAS"]);
    assert.deepEqual(result.unchecked, ["BTS-8026D"]);
    assert.deepEqual(result.notes, []);
  }
});

test("clearing needs a real request to clear, not a negated or describing 'clear'", async () => {
  const deps = fakeDeps([torch]);
  const lines = [{ item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }];
  for (const text of [
    "clear everything", "pls clear", "can clear all?", "clear the enquiry", "Clear enquiry", "reset", "清空",
    "clear the whole list", "clear this enquiry", "can you clear this list", "clear out everything", "ok clear lor", "can u clear?",
  ]) {
    const cleared = await applyEnquiryAction(lines, { action: "clear" }, [text], deps);
    assert.deepEqual(cleared.ok && cleared.lines, [], text);
  }
  // A phone keyboard types the curly apostrophe; "no need to" and "don't want to" put words between the negation and the verb.
  for (const text of [
    "not clear leh", "don't clear it", "no need clear", "clear glass jar 2 pcs", "Thank you", "don’t clear it", "no need to clear",
    "i don't want to clear it", "no need to reset", "no don’t reset", "is the picture clear", "all clear", "is it clear?", "crystal clear",
    "the instructions are clear, thanks", "are you clear?",
  ]) {
    const refused = await applyEnquiryAction(lines, { action: "clear" }, [text], deps);
    assert.equal(refused.ok ? null : refused.error, "CLEAR_NOT_REQUESTED", text);
  }
});

// Sold by the dozen, like the 31 active DOZ products in the catalogue.
const spoon = product({ stock_id: "100-100", name: "Zebra Chinese Spoon", list_price: 9.08, uom_id: "DOZ", available_quantity: 100 });
const plate = product({ stock_id: "PL-10", name: "Porcelain Plate 10 inch", list_price: 2, available_quantity: 200 });

test("'N dozen' states both N and N x 12 until the item's unit is known", () => {
  assert.equal(quantityStated(48, ["4 dozen"]), true);
  assert.equal(quantityStated(4, ["4 dozen"]), true);
  // exam 4, c01-stress: "5 dozen" worked out as 60 was refused.
  assert.equal(quantityStated(60, ["5 dozen. then total how much now"]), true);
  assert.equal(quantityStated(12, ["a dozen please"]), true);
  assert.equal(quantityStated(6, ["half a dozen"]), true);
  assert.equal(quantityStated(12, ["half a dozen"]), false);
  assert.equal(quantityStated(24, ["两打"]), true);
  assert.equal(quantityStated(144, ["12 dozen"]), true);
  assert.equal(statesAnyQuantity(["dozens of choices"]), false);
  // "N dozen of" is a count too; only "dozens of" with no number isn't.
  assert.equal(quantityStated(24, ["2 dozen of the plates"]), true);
  assert.equal(quantityStated(24, ["2 dozen of the plates"], "pieces"), true);
  assert.equal(quantityStated(2, ["2 dozen of the plates"], "pieces"), false);
  assert.equal(quantityStated(6, ["half dozen pls"]), true);
  assert.equal(quantityStated(6, ["half dozen pls"], "dozens"), false);
  // A whole Chinese numeral before 打: 十二打 is 12 dozen, never 12 pieces.
  assert.equal(quantityStated(144, ["十二打"]), true);
  assert.equal(quantityStated(12, ["十二打"], "pieces"), false);
  assert.equal(quantityStated(12, ["十二打"], "dozens"), true);
  assert.equal(quantityStated(240, ["要二十打"], "pieces"), true);
});

test("a dozen that is a price, a guess, a rate or a count of outlets is not a quantity in any reading", () => {
  // Both readings of the dozen go through the guess and rate rules, and the part-word rule sees the word after it.
  for (const [quantity, text] of [[48, "maybe about 4 dozen"], [4, "maybe about 4 dozen"], [24, "2 dozen a day"], [2, "2 dozen a day"],
    [12, "about a dozen"], [48, "4 dozen per outlet"], [4, "4 dozen per outlet"], [12, "we have a dozen outlets"], [12, "is it $9 a dozen?"],
    [12, "sell by a dozen?"]] as const) {
    assert.equal(quantityStated(quantity, [text]), false, text);
    assert.equal(quantityStated(quantity, [text], "pieces"), false, text);
    assert.equal(statesAnyQuantity([text]), false, text);
  }
  assert.equal(quantityStated(12, ["how much for a dozen"]), true);
});

test("an item's unit decides whether the dozens or the pieces count", () => {
  assert.equal(quantityStated(48, ["4 dozen"], "dozens"), false);
  assert.equal(quantityStated(4, ["4 dozen"], "dozens"), true);
  assert.equal(quantityStated(4, ["4 dozen"], "pieces"), false);
  assert.equal(quantityStated(48, ["4 dozen"], "pieces"), true);
  assert.equal(quantityStated(2, ["两打"], "pieces"), false);
  assert.equal(quantityStated(2, ["两打"], "dozens"), true);
  assert.equal(quantityStated(6, ["half a dozen"], "pieces"), true);
  assert.equal(quantityStated(6, ["half a dozen"], "dozens"), false);
  assert.equal(quantityStated(1, ["a dozen please"], "dozens"), true);
  assert.equal(inPieces("4 dozen spoons", "pieces"), "48 spoons");
  assert.equal(inPieces("4 dozen spoons", "dozens"), "4 spoons");
  // Texts with no dozen word read the same in every mode.
  for (const mode of ["pieces", "dozens"] as const) assert.equal(inPieces("need 50 pcs", mode), "need 50 pcs");
});

test("打 in an egg beater or a takeaway box is not a dozen", () => {
  assert.equal(quantityStated(2, ["要2打蛋器"]), true);
  assert.equal(quantityStated(2, ["要2打蛋器"], "pieces"), true);
  assert.equal(quantityStated(600, ["50打包盒"]), false);
  assert.equal(quantityStated(600, ["50打包盒"], "pieces"), false);
});

test("an item sold by the dozen takes the dozens typed, one sold by the piece takes the pieces", async () => {
  const add = (item: typeof spoon, quantity: number, text: string) => applyEnquiryAction([], { action: "add", stock_id: item.stock_id, quantity }, [text], fakeDeps([item]));
  const dozens = await add(spoon, 5, "5 dozen chinese spoon");
  assert.equal(dozens.ok && dozens.lines[0].quantity, 5);
  const sixty = await add(spoon, 60, "5 dozen chinese spoon");
  assert.deepEqual(sixty.ok ? null : [sixty.error, sixty.notice], ["UNIT_MISMATCH", "This item is sold by the dozen: use the number of dozens the customer typed."]);
  const pieces = await add(plate, 48, "4 dozen");
  assert.equal(pieces.ok && pieces.lines[0].quantity, 48);
  const four = await add(plate, 4, "4 dozen");
  assert.deepEqual(four.ok ? null : [four.error, four.notice], ["UNIT_MISMATCH", "The customer typed dozens: 1 dozen = 12 pieces."]);
  const plain = await add(spoon, 2, "2 pls");
  assert.equal(plain.ok && plain.lines[0].quantity, 2);
  // "N dozen of": 24 plates, not 2.
  const of = await add(plate, 24, "2 dozen of the plates");
  assert.equal(of.ok && of.lines[0].quantity, 24);
  const two = await add(plate, 2, "2 dozen of the plates");
  assert.equal(two.ok ? null : two.error, "UNIT_MISMATCH");
  const each = await add(plate, 12, "a dozen of each");
  assert.equal(each.ok && each.lines[0].quantity, 12);
  const spoons = await add(spoon, 2, "2 dozen of the spoons");
  assert.equal(spoons.ok && spoons.lines[0].quantity, 2);
  // "a dozen" is 1 of an item sold by the dozen: the first check reads it both ways too.
  const one = await add(spoon, 1, "a dozen please");
  assert.equal(one.ok && one.lines[0].quantity, 1);
});

test("a guessed number or a rate is never a quantity", () => {
  assert.equal(quantityStated(200, ["maybe about 200"]), false);
  assert.equal(quantityStated(1, ["1 unit per outlet opening"]), false);
  assert.equal(quantityStated(200, ["abt 200 cup a day each outlet"]), false);
  assert.equal(quantityStated(80, ["roughly 80 like that correct anot"]), false);
  // "ard" is Singlish for around: r4 c09-stress idx 13's GST follow-up (a price guess) turned on the permission check.
  const guess = ["i just need rough number tell my boss. ard 37 like that correct anot", "aiyo 9% only also cannot count? roughly lah"];
  assert.deepEqual([quantityStated(37, guess), statesAnyQuantity(guess)], [false, false]);
  assert.equal(quantityStated(3, ["hard 3 pcs"]), true);
  assert.equal(quantityStated(2, ["mika can tahan 200 cup a day meh? change to the waring 1.2k one la, same 2"]), true);
  assert.equal(quantityStated(200, ["mika can tahan 200 cup a day meh? change to the waring 1.2k one la, same 2"]), false);
  assert.equal(quantityStated(50, ["need 50 pcs"]), true);
  assert.equal(quantityStated(2, ["2 each"]), true);
  for (const [quantity, text] of [[20, "20 pcs everyday"], [200, "200 cups/day"], [2, "2 pc a day"], [1, "1 for each outlet"], [2, "2 per pax"]] as const) {
    assert.equal(quantityStated(quantity, [text]), false, text);
  }
  // A shop or outlet name ending in "a" or "per" is not a rate word.
  for (const text of ["need 2 for Sentosa outlet", "2 for boba shop", "2 for pasta shop", "2 for paper shop"]) assert.equal(quantityStated(2, [text]), true, text);
  // "how about 3" offers a number; it isn't a guess.
  assert.equal(quantityStated(3, ["ok how about 3"]), true);
  assert.equal(quantityStated(2, ["what about 2 pcs of the black one"]), true);
  assert.equal(statesAnyQuantity(["ok how about 3"]), true);
});

test("a rate rule never refuses a number said for a named outlet", async () => {
  const added = await applyEnquiryAction([], { action: "add", stock_id: "PL-10", quantity: 2 }, ["need 2 for Sentosa outlet"], fakeDeps([plate]));
  assert.equal(added.ok && added.lines[0].quantity, 2);
});

test("a number the customer didn't type comes back with a notice to ask how many", async () => {
  const refused = await applyEnquiryAction([], { action: "add", stock_id: "BTS-8026D", quantity: 2 }, ["blow torch"], fakeDeps([torch]));
  assert.deepEqual(refused.ok ? null : [refused.error, refused.notice], ["QTY_NOT_STATED", QTY_NOTICE]);
  assert.match(QTY_NOTICE, /^That number isn't one the customer typed for this item\. .*Don't say anything failed or ask them to type a code\.$/);
});

test("typedQuantities lists the distinct numbers the customer typed as quantities", () => {
  assert.deepEqual(typedQuantities(["3 and 5 pcs", "the 16 inch one, 3"]), [3, 5]);
  assert.deepEqual(typedQuantities(["maybe about 200 drinks a day"]), []);
  assert.deepEqual(typedQuantities(["4 dozen"]), [4]);
  assert.deepEqual(typedQuantities(["blow torch"]), []);
});
