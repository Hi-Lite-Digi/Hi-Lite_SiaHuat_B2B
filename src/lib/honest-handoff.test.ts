import assert from "node:assert/strict";
import test from "node:test";
import { withManualNextStep } from "./honest-handoff";

test("an honest sourcing offer names the PDF and Sia Huat sales", () => {
  const reply = withManualNextStep(
    "I couldn't find a 3-step steel frame folding ladder rated around 300 lb. I can put together a summary with these specs for you to send to our sales team.",
  );
  assert.match(reply, /PDF summary/);
  assert.match(reply, /Sia Huat sales/);
  assert.doesNotMatch(reply, /our sales team/);
});

test("a reply that already names the PDF is left alone", () => {
  const original = "Use the PDF button and contact Sia Huat sales directly.";
  assert.equal(withManualNextStep(original), original);
});

test("an ordinary no-match reply is never given handoff wording", () => {
  const original = "I couldn't find a 25cm match just now. Would a 23cm plate work?";
  assert.equal(withManualNextStep(original), original);
});
