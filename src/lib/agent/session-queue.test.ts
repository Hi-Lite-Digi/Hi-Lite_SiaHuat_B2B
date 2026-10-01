// src/lib/agent/session-queue.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { inSessionOrder } from "./session-queue";

test("turns from one session run in order; other sessions are not blocked", async () => {
  const order: string[] = [];
  const slow = inSessionOrder("s1-aaaaaaaa", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); order.push("s1-first"); });
  const next = inSessionOrder("s1-aaaaaaaa", async () => { order.push("s1-second"); });
  const other = inSessionOrder("s2-bbbbbbbb", async () => { order.push("s2"); });
  await Promise.all([slow, next, other]);
  assert.deepEqual(order, ["s2", "s1-first", "s1-second"]);
});

test("a failed turn does not block the next one", async () => {
  await assert.rejects(inSessionOrder("s3-cccccccc", async () => { throw new Error("boom"); }));
  assert.equal(await inSessionOrder("s3-cccccccc", async () => "ok"), "ok");
});
