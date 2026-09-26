// src/lib/agent/contract.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import { agentReplySchema, agentRequestSchema } from "./contract";

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

test("reply schema accepts the server's reply shape", () => {
  const reply = agentReplySchema.parse({
    message: "Noted.", cards: [], chips: [], showContact: false, provider: "anthropic",
    enquiry: { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } },
  });
  assert.equal(reply.provider, "anthropic");
});

test("sales contact stays a placeholder until Sia Huat confirms it", () => {
  assert.equal(SALES_CONTACT.phone, "[SALES PHONE]");
  assert.equal(SALES_CONTACT.email, "[SALES EMAIL]");
});
