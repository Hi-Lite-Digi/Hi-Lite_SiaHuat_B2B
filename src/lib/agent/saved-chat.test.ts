// src/lib/agent/saved-chat.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { PHOTO_PLACEHOLDER, SAVED_CHAT_KEY, SAVED_CHAT_MAX_AGE_MS, readSavedChat, saveChat, type ChatItem } from "./saved-chat";
import { product } from "./testing";

/** sessionStorage as the tests need it: a Map, with an optional size limit like a full tab. */
function store(limit = Infinity) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limit) throw new DOMException("full", "QuotaExceededError");
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
  };
}

const NOW = Date.UTC(2026, 9, 3, 13, 30);
const greeting: ChatItem = { id: 1, role: "assistant", text: "Hi, I'm Claire from Sia Huat", time: "9:26 pm" };
const plate = product({ stock_id: "4008-3", name: "Melamine Round Rim Plate Ø20.3xH1.9cm, Blue", list_price: 3.3, uom_id: "PC", description: "x".repeat(1_500), source_url: "https://store.siahuat.com/product/12051143860" });
const enquiry = {
  lines: [{ item: plate.name, code: "4008-3", pricePerItem: 3.3, quantity: 25, total: 82.5, uom: "PC", sourceUrl: plate.source_url }],
  totals: { lineCount: 1, quantitiesByUom: [{ uom: "PC", quantity: 25 }], grandTotal: 82.5 },
};
const chat = (items: ChatItem[]) => ({ sessionId: "agent-1234-5678", items, enquiry, shownIds: ["4008-3"] });
const answered: ChatItem[] = [
  greeting,
  { id: 2, role: "user", text: "25 of 4008-3", time: "9:27 pm" },
  { id: 3, role: "assistant", text: "Got it: 25 Melamine Round Rim Plates. Anything else?", time: "9:27 pm", cards: [plate], chips: ["Bowls too"], showContact: false, pdf: true, pickHint: false },
];

test("a refresh brings back the messages, the enquiry, the shown cards and the chat's session (F1)", () => {
  const tab = store();
  saveChat(tab, chat(answered), NOW);
  const saved = readSavedChat(tab, NOW + 60_000)!;
  assert.equal(saved.sessionId, "agent-1234-5678");
  assert.deepEqual(saved.enquiry, enquiry);
  assert.deepEqual(saved.shownIds, ["4008-3"]);
  assert.deepEqual(saved.items.map((item) => [item.id, item.role, item.text, item.time]), answered.map((item) => [item.id, item.role, item.text, item.time]));
  assert.deepEqual(saved.items[2].chips, ["Bowls too"]);
  assert.equal(saved.nextId, 4);
  assert.equal(saved.unanswered, null);
  assert.equal(saved.draft, "");
});

test("a saved card keeps what the chat, the history note and the PDF show, not its description", () => {
  const tab = store();
  saveChat(tab, chat(answered), NOW);
  const card = readSavedChat(tab, NOW)!.items[2].cards![0];
  assert.deepEqual(card, { stock_id: "4008-3", name: plate.name, status: plate.status, list_price: 3.3, uom_id: "PC", source_url: plate.source_url, stock_status: "in_stock" });
  assert.ok(tab.data.get(SAVED_CHAT_KEY)!.length < 2_000);
});

test("a chat with nothing the customer said is not kept, so New chat clears the saved copy", () => {
  const tab = store();
  saveChat(tab, chat(answered), NOW);
  saveChat(tab, { ...chat([{ ...greeting, id: 4, text: "New chat started." }]), enquiry: { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } } }, NOW);
  assert.equal(tab.data.has(SAVED_CHAT_KEY), false);
  assert.equal(readSavedChat(tab, NOW), null);
});

test("a saved chat older than a day, from another version, or unreadable starts fresh and is cleared", () => {
  const tab = store();
  saveChat(tab, chat(answered), NOW);
  assert.equal(readSavedChat(tab, NOW + SAVED_CHAT_MAX_AGE_MS + 1), null);
  assert.equal(tab.data.has(SAVED_CHAT_KEY), false);
  for (const raw of ["{not json", JSON.stringify({ v: 2, savedAt: NOW }), JSON.stringify({ v: 1, savedAt: NOW, sessionId: "agent-1234-5678", items: [{ ...greeting, imageUrl: "javascript:alert(1)" }], enquiry, shownIds: [] })]) {
    tab.data.set(SAVED_CHAT_KEY, raw);
    assert.equal(readSavedChat(tab, NOW), null, raw.slice(0, 40));
  }
});

test("reloaded while Claire was replying: the unanswered message is named and its typed words come back to send again", () => {
  const tab = store();
  const asked: ChatItem = { id: 4, role: "user", text: "Also 12 soup bowls\nunder $10 each", time: "9:28 pm" };
  saveChat(tab, chat([...answered, asked]), NOW);
  const saved = readSavedChat(tab, NOW)!;
  assert.equal(saved.unanswered?.id, 4);
  assert.equal(saved.draft, "Also 12 soup bowls\nunder $10 each");
  assert.equal(saved.nextId, 5);
  // A voice note's words come back without the mic mark; a tap, a chip or a photo can't be put back in the box.
  saveChat(tab, chat([...answered, { ...asked, text: "🎤 twelve soup bowls" }]), NOW);
  assert.equal(readSavedChat(tab, NOW)!.draft, "twelve soup bowls");
  for (const mark of [{ tap: true }, { chip: true }, { imageUrl: "data:image/jpeg;base64,AA", thumbUrl: "data:image/jpeg;base64,AA" }]) {
    saveChat(tab, chat([...answered, { ...asked, ...mark }]), NOW);
    assert.equal(readSavedChat(tab, NOW)!.draft, "", JSON.stringify(mark));
  }
});

test("a photo is kept as its thumbnail, or a placeholder; the full photo never goes into storage", () => {
  const tab = store();
  const full = `data:image/jpeg;base64,${"A".repeat(400_000)}`;
  saveChat(tab, chat([greeting, { id: 2, role: "user", text: "", time: "9:32 pm", imageUrl: full, thumbUrl: "data:image/jpeg;base64,THUMB" }, { id: 3, role: "user", text: "this one", time: "9:33 pm", imageUrl: full }, { id: 4, role: "assistant", text: "Here are some blue plates.", time: "9:33 pm" }]), NOW);
  assert.ok(tab.data.get(SAVED_CHAT_KEY)!.length < 2_000);
  const items = readSavedChat(tab, NOW)!.items;
  assert.deepEqual([items[1].imageUrl, items[1].thumbUrl], ["data:image/jpeg;base64,THUMB", "data:image/jpeg;base64,THUMB"]);
  assert.equal(items[2].imageUrl, PHOTO_PLACEHOLDER);
});

test("a full tab drops the thumbnails first, then the saved copy, and never throws", () => {
  const thumb = `data:image/jpeg;base64,${"B".repeat(30_000)}`;
  const items: ChatItem[] = [greeting, { id: 2, role: "user", text: "", time: "9:32 pm", imageUrl: thumb, thumbUrl: thumb }, answered[2]];
  const roomy = store(10_000);
  saveChat(roomy, chat(items), NOW);
  assert.equal(readSavedChat(roomy, NOW)!.items[1].imageUrl, PHOTO_PLACEHOLDER);
  const full = store(100);
  full.data.set(SAVED_CHAT_KEY, "older copy");
  assert.doesNotThrow(() => saveChat(full, chat(items), NOW));
  assert.equal(full.data.has(SAVED_CHAT_KEY), false);
  const blocked = { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("denied", "SecurityError"); }, removeItem: () => { throw new DOMException("denied", "SecurityError"); } };
  assert.doesNotThrow(() => saveChat(blocked, chat(items), NOW));
  assert.equal(readSavedChat(blocked, NOW), null);
  assert.equal(readSavedChat(null, NOW), null);
});
