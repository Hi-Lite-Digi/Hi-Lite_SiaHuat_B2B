import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "./chat-contract";
import { checkedEnquiryLine, clearsEnquiry, mergedEnquiryQuantity, referencedEnquiryLine, removalTarget } from "./enquiry-order";
import { latestEnquiryReceiptLines } from "./conversation-export";
import { parseRequestedQuantity, requestsAdditionalProduct } from "./chat-turn";

const knife: Product = { stock_id: "218455-20", name: "Giesser Chef's Knife 20cm", status: "ACTIVE", list_price: 44.5, uom_id: "PC", stock_status: "in_stock", available_quantity: 17 };
const glass: Product = { ...knife, stock_id: "H-4298032", name: "Spiegelau Allround Wine Glass 430ml", list_price: 20.09, available_quantity: 533 };
const lines = [checkedEnquiryLine(2, knife)!, checkedEnquiryLine(3, glass)!];

test("repeat additions count existing quantities toward the live stock limit", () => {
  const overLimit = mergedEnquiryQuantity(lines, knife.stock_id, 16, true);
  assert.equal(overLimit, 18);
  assert.equal(checkedEnquiryLine(overLimit, knife), null);
  const boundary = mergedEnquiryQuantity(lines, knife.stock_id, 15, true);
  assert.equal(checkedEnquiryLine(boundary, knife)?.total, 756.5);
  assert.equal(mergedEnquiryQuantity(lines, knife.stock_id, 1, false), 1);
  assert.deepEqual(lines.map((line) => line.quantity), [2, 3]);
});

test("quote boundary rejects zero, negative, fractional and excessive quantities", () => {
  for (const amount of [0, -2, 2.5, 18, 100001, NaN, Infinity]) {
    assert.equal(checkedEnquiryLine(amount, knife), null, String(amount));
  }
});

test("unknown or sold-out stock can never produce an automatic quote", () => {
  for (const product of [
    { ...knife, stock_status: "out_of_stock" as const, available_quantity: 0 },
    { ...knife, stock_status: "unknown" as const },
    { ...knife, available_quantity: null },
    { ...knife, list_price: NaN },
  ]) assert.equal(checkedEnquiryLine(1, product), null);
});

test("monetary line totals remain exact to cents", () => {
  assert.equal(checkedEnquiryLine(3, glass)?.total, 60.27);
  assert.equal(checkedEnquiryLine(3, { ...glass, list_price: 0.1 })?.total, 0.3);
});

test("remove only the named line and preserve the other product", () => {
  const target = removalTarget("Remove the knife, keep only the glasses");
  assert.equal(target, "knife");
  const removed = referencedEnquiryLine(target!, lines);
  assert.equal(removed?.code, knife.stock_id);
  assert.deepEqual(lines.filter((line) => line.code !== removed?.code).map((line) => line.code), [glass.stock_id]);
  assert.equal(referencedEnquiryLine("H-4298032", lines)?.code, glass.stock_id);
  assert.equal(referencedEnquiryLine("knife", [...lines, { ...lines[0], code: "OTHER-KNIFE" }]), null);
});

test("clearing an enquiry also clears the receipt instead of exporting an older quote", () => {
  assert.equal(clearsEnquiry("cancel the order"), true);
  assert.equal(clearsEnquiry("Cancel additional item"), false);
  assert.deepEqual(latestEnquiryReceiptLines([{ quoteSummaries: lines }, { quoteSummaries: [] }]), []);
});

test("additional quantities are understood without confusing dimensions or codes", () => {
  for (const [message, value] of [["Add 16 more of the same knife", 16], ["add two more", 2], ["add 3 PC of 218455-20", 3]] as const) {
    assert.deepEqual(parseRequestedQuantity(message), { kind: "valid", value });
  }
  assert.deepEqual(parseRequestedQuantity("add a 20cm knife"), { kind: "none" });
  assert.deepEqual(parseRequestedQuantity("add 218455-20"), { kind: "none" });
  assert.deepEqual(parseRequestedQuantity("add -2 more"), { kind: "invalid", reason: "range" });
});

test("additional product codes never become a quantity change to the current item", () => {
  for (const code of ["R-52713B81", "218455-20", "HL00900200104", "V4353"]) {
    assert.equal(requestsAdditionalProduct(`Add 1 PC of ${code}`), true, code);
  }
});

test("discount percentages are not mistaken for requested item quantities", () => {
  for (const message of ["Can you give me 30% off?", "give me thirty percent off", "I need 30 percent off"]) {
    assert.deepEqual(parseRequestedQuantity(message), { kind: "none" });
  }
  assert.deepEqual(parseRequestedQuantity("Give me 30% off for 2 knives"), { kind: "valid", value: 2 });
});
