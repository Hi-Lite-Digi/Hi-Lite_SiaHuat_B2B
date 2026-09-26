// src/lib/agent/enquiry.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyEnquiryAction, enquiryTotals, quantityStated, verifyEnquiry } from "./enquiry";
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
  const over = await applyEnquiryAction(first.ok ? first.lines : [], { action: "add", stock_id: "BTS-8026D", quantity: 20 }, ["20 more"], deps);
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

test("remove and clear", async () => {
  const deps = fakeDeps([torch, gas]);
  const lines = [
    { item: torch.name, code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" },
    { item: gas.name, code: "GAS", pricePerItem: 3.85, quantity: 48, total: 184.8, uom: "PC" },
  ];
  const removed = await applyEnquiryAction(lines, { action: "remove", stock_id: "bts-8026d" }, [], deps);
  assert.deepEqual(removed.ok && removed.lines.map((line) => line.code), ["GAS"]);
  const cleared = await applyEnquiryAction(lines, { action: "clear" }, [], deps);
  assert.deepEqual(cleared.ok && cleared.lines, []);
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

test("a line that cannot be re-checked keeps its catalogue price with a note", async () => {
  const result = await verifyEnquiry([{ stockId: "BTS-8026D", quantity: 2 }], fakeDeps([torch], { "BTS-8026D": "fail" }));
  assert.equal(result.lines[0].pricePerItem, 23.36);
  assert.match(result.notes[0], /could not be re-checked/);
});

test("totals are rounded to cents", () => {
  const totals = enquiryTotals([
    { item: "a", code: "A", pricePerItem: 0.1, quantity: 1, total: 0.1, uom: "PC" },
    { item: "b", code: "B", pricePerItem: 0.2, quantity: 1, total: 0.2, uom: "PC" },
  ]);
  assert.equal(totals.grandTotal, 0.3);
});
