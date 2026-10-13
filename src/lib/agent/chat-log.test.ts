import assert from "node:assert/strict";
import test from "node:test";
import { chatTurnRow } from "./chat-log";
import type { AgentReply, AgentRequest } from "./contract";
import { product } from "./testing";

const reply: AgentReply = {
  message: "Got it: 2 Safico torches.",
  cards: [product({ stock_id: "BTS-8026D", list_price: 23.36 })],
  chips: ["Gas", "Electric"],
  enquiry: { lines: [{ item: "Torch", code: "BTS-8026D", pricePerItem: 23.36, quantity: 2, total: 46.72, uom: "PC" }], totals: { lineCount: 1, quantitiesByUom: [{ uom: "PC", quantity: 2 }], grandTotal: 46.72 } },
  showContact: false,
  provider: "anthropic",
};
const request = (event: AgentRequest["event"]): AgentRequest => ({ sessionId: "session-1234", event, history: [], enquiry: [], shownProductIds: [] });

test("a saved chat turn keeps the customer's words, Claire's reply, the cards and the enquiry", () => {
  assert.deepEqual(chatTurnRow(request({ type: "text", text: "2 torches pls" }), reply), {
    session_id: "session-1234", customer: "2 torches pls", claire: "Got it: 2 Safico torches.", cards: ["BTS-8026D"], chips: ["Gas", "Electric"],
    show_contact: false, provider: "anthropic", enquiry: [{ code: "BTS-8026D", quantity: 2 }],
  });
});

test("a photo or a card tap is saved as a short note, never the photo itself", () => {
  const image = { dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" as const, name: "plate.png" };
  assert.equal(chatTurnRow(request({ type: "image", image, caption: "this one?" }), reply).customer, "[photo] this one?");
  assert.equal(chatTurnRow(request({ type: "image", image }), reply).customer, "[photo]");
  assert.equal(chatTurnRow(request({ type: "select_product", stockId: "BTS-8026D" }), reply).customer, "[tapped] BTS-8026D");
});
