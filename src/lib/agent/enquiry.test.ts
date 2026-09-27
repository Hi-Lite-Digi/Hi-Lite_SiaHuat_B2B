// src/lib/agent/enquiry.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyEnquiryAction, enquiryTotals, quantityStated, verifyEnquiry } from "./enquiry";
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
  assert.match(result.notes[0], /stays on the enquiry/);
});

test("a line whose live re-check fails stays with the browser and its catalogue price is never used", async () => {
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }, { stockId: "GAS", quantity: 48 }], fakeDeps([torch, gas], { "BTS-8026D": "fail" }));
  assert.deepEqual(result.lines.map((line) => line.code), ["GAS"]);
  assert.deepEqual(result.unchecked, ["BTS-8026D"]);
  assert.match(result.notes.join(" "), /\(BTS-8026D\) could not be re-checked/);
  const allowed = allowedCents(result.products, result.lines, enquiryTotals(result.lines).grandTotal);
  assert.equal(allowed.has(2336), false);
  assert.equal(allowed.has(4672), false);
});

test("totals are rounded to cents", () => {
  const totals = enquiryTotals([
    { item: "a", code: "A", pricePerItem: 0.1, quantity: 1, total: 0.1, uom: "PC" },
    { item: "b", code: "B", pricePerItem: 0.2, quantity: 1, total: 0.2, uom: "PC" },
  ]);
  assert.equal(totals.grandTotal, 0.3);
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
  ];
  for (const [text, stated] of labelsOnly) {
    for (const quantity of [1, 2, 3, 5, 12]) assert.equal(quantityStated(quantity, [text]), stated.includes(quantity), `${quantity} in ${text}`);
  }
  assert.equal(quantityStated(2, ["ok 2."]), true);
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
