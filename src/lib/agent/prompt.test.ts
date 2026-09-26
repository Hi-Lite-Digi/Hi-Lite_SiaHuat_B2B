// src/lib/agent/prompt.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { CLAIRE_AGENT_PROMPT } from "./prompt";

test("Claire's agent prompt carries the sales voice and the hard rules", () => {
  assert.match(CLAIRE_AGENT_PROMPT, /SIA HUAT SALES VOICE/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never take a quantity from an option number/);
  assert.match(CLAIRE_AGENT_PROMPT, /Never say staff have been notified/);
  assert.match(CLAIRE_AGENT_PROMPT, /customer's own words/);
});

test("the old engine's one-item-at-a-time queue rule is not in the agent prompt", () => {
  assert.doesNotMatch(CLAIRE_AGENT_PROMPT, /the app works through them one at a time/);
});
