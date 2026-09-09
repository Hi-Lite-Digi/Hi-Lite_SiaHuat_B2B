import assert from "node:assert/strict";
import test from "node:test";
import { beginModelCall, calculateModelUsage, withModelUsage } from "./model-usage";

test("Luna charges cache reads and writes separately without double-counting reasoning", () => {
  const usage = calculateModelUsage("gpt-5.6-luna", { input_tokens: 5000, output_tokens: 300,
    input_tokens_details: { cached_tokens: 3000, cache_write_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 50 } });
  assert.ok(usage);
  assert.ok(Math.abs(usage.estimatedUsd! - 0.00087) < 1e-12);
  assert.equal(usage.reasoningTokens, 50);
  assert.equal(calculateModelUsage("unknown-model", { input_tokens: 10, output_tokens: 1 })?.estimatedUsd, null);
  assert.equal(calculateModelUsage("gpt-5.6-luna"), null);
  assert.equal(calculateModelUsage("gpt-5.6-luna", { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 20 } }), null);
});

test("concurrent turns isolate usage and unresolved attempts stay visibly incomplete", async () => {
  const first = withModelUsage(async () => {
    const finish = beginModelCall();
    await new Promise(resolve => setTimeout(resolve, 15));
    finish(calculateModelUsage("gpt-5.6-luna", { input_tokens: 1000, output_tokens: 100 }));
    beginModelCall(); // A dropped connection may be billed even though no usage arrived.
    return Response.json({ ok: true });
  });
  const second = withModelUsage(async () => {
    const finish = beginModelCall();
    finish(calculateModelUsage("gpt-5.6-luna", { input_tokens: 2000, output_tokens: 200 }));
    return Response.json({ ok: true });
  });
  const [a, b] = await Promise.all([first, second]);
  const ua = JSON.parse(a.headers.get("x-ai-usage")!);
  const ub = JSON.parse(b.headers.get("x-ai-usage")!);
  assert.equal(ua.attempts, 2);
  assert.equal(ua.measuredCalls, 1);
  assert.equal(ua.inputTokens, 1000);
  assert.equal(ua.complete, false);
  assert.equal(ub.inputTokens, 2000);
  assert.equal(ub.complete, true);
});
