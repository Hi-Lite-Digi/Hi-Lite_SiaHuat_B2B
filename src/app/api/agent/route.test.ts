// src/app/api/agent/route.test.ts
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { POST } from "./route";

function configure(t: TestContext) {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  t.mock.method(console, "warn", () => undefined);
}

// One-letter text keeps the backup reply offline (it only searches for 2+ characters).
const agentRequest = (sessionId: string, signal?: AbortSignal) => new Request("http://localhost/api/agent", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, event: { type: "text", text: "a" } }),
  signal,
});

/** A Claude call that never answers until its signal aborts. */
function hangUntilAborted(init?: RequestInit) {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test("a turn queued behind the same session only gets what is left of the route's time budget", async (t) => {
  configure(t);
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  let firstCalled!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstCalled = resolve; });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      firstCalled();
      await firstGate;
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "test" } }, { status: 400 });
    }
    return hangUntilAborted(init);
  });

  const first = POST(agentRequest("queue-budget-1"));
  const second = POST(agentRequest("queue-budget-1"));
  await firstStarted;
  clock = 39_990; // the first turn used almost the whole budget while the second one waited
  releaseFirst();

  assert.equal((await first).headers.get("x-chat-provider"), "fallback");
  const response = await within(second, 3_000);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-chat-provider"), "fallback");
  assert.equal((await response.json()).provider, "fallback");
  assert.equal(calls, 2);
});

test("a customer who leaves stops the Claude call instead of holding the session queue", async (t) => {
  configure(t);
  const browser = new AbortController();
  let claudeCalled!: () => void;
  const claudeStarted = new Promise<void>((resolve) => { claudeCalled = resolve; });
  t.mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
    claudeCalled();
    return hangUntilAborted(init);
  });

  const pending = POST(agentRequest("client-left-1", browser.signal));
  await claudeStarted;
  browser.abort();

  const response = await within(pending, 3_000);
  assert.equal(response.headers.get("x-chat-provider"), "fallback");
});
