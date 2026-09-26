// src/lib/agent/prompt.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { replyStyleIssues } from "@/lib/reply-style";
import { CLAIRE_AGENT_PROMPT } from "./prompt";

test("Claire's agent prompt carries the sales voice and the hard rules", () => {
  assert.match(CLAIRE_AGENT_PROMPT, /SIA HUAT SALES VOICE/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never take a quantity from an option number/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never say staff have been notified/);
  assert.match(CLAIRE_AGENT_PROMPT, /customer's own words/);
});

test("Claire summarises the enquiry in one line instead of listing it", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("When asked what's in the enquiry, give a one-line summary (item count and total from the context); the enquiry bar shows the lines, so don't list them."));
});

test("the update_enquiry errors Claude must explain are named in the prompt, clearing included", () => {
  for (const code of ["OUT_OF_STOCK", "OVER_STOCK", "STOCK_UNVERIFIED", "PACK_SIZE_UNKNOWN", "QTY_NOT_STATED", "CLEAR_NOT_REQUESTED"]) {
    assert.ok(CLAIRE_AGENT_PROMPT.includes(code), code);
  }
});

test("Claire never claims an item isn't carried or a list is complete without two searches", () => {
  assert.ok(CLAIRE_AGENT_PROMPT.includes("Never say an item isn't carried, or that a list is complete ('that's all', 'full range', 'complete list'), unless you ran at least two different searches (different words, including the broader product type or a category) and none fit. When more_available is true, the list is not complete: say there are more and offer to narrow down, or show the next few. When the customer says 'show me all/more', show new options you haven't shown."));
});

test("the old engine's one-item-at-a-time queue rule is not in the agent prompt", () => {
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /the app works through them one at a time/);
});

test("the example replies in the Choosing rule pass the reply style guard", () => {
  const choosing = CLAIRE_AGENT_PROMPT.split("\n").find((line) => line.startsWith("- Choosing:")) ?? "";
  const examples = [...choosing.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(examples.length > 0);
  for (const message of examples) {
    assert.deepEqual(replyStyleIssues({ message, products: [], selectedProduct: null }), [], message);
  }
});
