import assert from "node:assert/strict";
import test from "node:test";
import { quantityBesidesProductChoice } from "./chat-turn";

test("live 26 Sep: picking option 2 is a choice, not an order for 2 pieces", () => {
  for (const choice of ["2", "Choose option 2", "option 2", "no. 2", "the second one", "2nd option", "item 2"]) {
    assert.equal(quantityBesidesProductChoice(choice), null, choice);
  }
});

test("a quantity stated alongside the choice is still kept", () => {
  assert.equal(quantityBesidesProductChoice("option 2, 5 pcs"), 5);
  assert.equal(quantityBesidesProductChoice("the second one, 3 units"), 3);
  assert.equal(quantityBesidesProductChoice("I'll take 4 of option 1"), 4);
});
