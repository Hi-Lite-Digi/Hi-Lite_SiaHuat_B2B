// src/lib/agent/contract.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import { agentReplySchema, agentRequestSchema, nextEnquiry } from "./contract";

test("a card tap is a product choice, never text", () => {
  const parsed = agentRequestSchema.parse({ sessionId: "session-1234", event: { type: "select_product", stockId: "BTS-8026D" } });
  assert.equal(parsed.event.type, "select_product");
  assert.deepEqual(parsed.history, []);
  assert.deepEqual(parsed.enquiry, []);
  assert.deepEqual(parsed.shownProductIds, []);
});

test("request limits are enforced", () => {
  const ok = (value: unknown) => agentRequestSchema.safeParse(value).success;
  assert.equal(ok({ sessionId: "short", event: { type: "text", text: "hi" } }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "x".repeat(501) } }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: [{ stockId: "A", quantity: 0 }] }), false);
  assert.equal(ok({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: [{ stockId: "A", quantity: 2 }] }), true);
});

test("an enquiry echo may carry up to 200 lines", () => {
  const echo = (count: number) => Array.from({ length: count }, (_, index) => ({ stockId: `A${index}`, quantity: 1 }));
  const ok = (count: number) => agentRequestSchema.safeParse({ sessionId: "session-1234", event: { type: "text", text: "hi" }, enquiry: echo(count) }).success;
  assert.equal(ok(200), true);
  assert.equal(ok(201), false);
});

test("reply schema accepts the server's reply shape", () => {
  const reply = agentReplySchema.parse({
    message: "Noted.", cards: [], chips: [], showContact: false, provider: "anthropic",
    enquiry: { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } },
  });
  assert.equal(reply.provider, "anthropic");
});

test("the browser keeps its own copy of lines the server could not re-check", () => {
  const torch = { item: "TORCH", code: "970S", pricePerItem: 31.31, quantity: 2, total: 62.62, uom: "PC" };
  const pan = { item: "PAN", code: "PAN-1", pricePerItem: 10.1, quantity: 1, total: 10.1, uom: "PC" };
  const current = { lines: [torch, pan], totals: { lineCount: 2, quantitiesByUom: [{ uom: "PC", quantity: 3 }], grandTotal: 72.72 } };
  const reply = { lines: [{ ...pan, pricePerItem: 10.2, total: 10.2 }], totals: { lineCount: 1, quantitiesByUom: [{ uom: "PC", quantity: 1 }], grandTotal: 10.2 }, unchecked: ["970s"] };
  assert.deepEqual(nextEnquiry(current, reply), {
    lines: [{ ...pan, pricePerItem: 10.2, total: 10.2 }, torch],
    totals: { lineCount: 2, quantitiesByUom: [{ uom: "PC", quantity: 3 }], grandTotal: 72.82 },
  });
  const checked = { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } };
  assert.equal(nextEnquiry(current, checked), checked);
});

test("sales contact stays a placeholder until Sia Huat confirms it", () => {
  assert.equal(SALES_CONTACT.phone, "[SALES PHONE]");
  assert.equal(SALES_CONTACT.email, "[SALES EMAIL]");
});
