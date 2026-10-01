// src/lib/agent/new-chat.test.ts
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { abortAfter, isNewChatCommand, newChatWarning } from "./new-chat";

const totals = (lineCount: number, grandTotal: number) => ({ lineCount, quantitiesByUom: [], grandTotal });

test("New chat on a chat with nothing to lose resets at once", () => {
  assert.equal(newChatWarning(false, totals(0, 0)), null);
});

test("New chat after the customer wrote asks first, about the messages", () => {
  assert.equal(newChatWarning(true, totals(0, 0)), "This clears the messages so far.");
});

test("New chat with an enquiry names it as the enquiry bar does", () => {
  // Reset check (2026-10-01): one tap just past the PDF button cleared a 1-item enquiry ($62.62) with no way back.
  assert.equal(newChatWarning(true, totals(1, 62.62)), "This clears your enquiry (1 item · $62.62) and the messages. Tap PDF first to keep a copy.");
  assert.equal(newChatWarning(true, totals(3, 232.1)), "This clears your enquiry (3 items · $232.10) and the messages. Tap PDF first to keep a copy.");
});

test("a request signal ends when the chat is reset", () => {
  const chat = new AbortController();
  const signal = abortAfter(60_000, chat.signal);
  assert.equal(signal.aborted, false);
  chat.abort();
  assert.equal(signal.aborted, true);
});

test("a request signal ends at its time limit", async () => {
  const chat = new AbortController();
  const signal = abortAfter(5, chat.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true);
  assert.equal(chat.signal.aborted, false);
  // A request past its time limit stops listening to the chat, so a long chat does not pile up listeners.
  assert.equal(getEventListeners(chat.signal, "abort").length, 0);
});

test("a request signal for a chat already reset starts aborted", () => {
  const chat = new AbortController();
  chat.abort();
  assert.equal(abortAfter(60_000, chat.signal).aborted, true);
});

test("a short typed new-chat command does what the New chat button does; a sentence still goes to Claire", () => {
  // Reset check (2026-10-01, real turns): Claire answered a typed "start over" by pointing to the button but left the enquiry.
  for (const text of ["start over", "Start over!", "reset", "Reset chat", "reset the chat", "new chat", "New chat pls", "restart", "clear all", "clear everything", "pls start over", "start over lah", "  NEW CHAT.  "]) {
    assert.equal(isNewChatCommand(text), true, text);
  }
  for (const text of ["start over with plates instead", "can we start over? i want plates", "reset button not working", "clear the torch", "new chat about plates", "restart the blender", "how to reset", "clear", "new"]) {
    assert.equal(isNewChatCommand(text), false, text);
  }
});
