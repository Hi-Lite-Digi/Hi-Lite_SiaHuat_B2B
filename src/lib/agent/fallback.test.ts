// src/lib/agent/fallback.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { SALES_CONTACT } from "./contact";
import { buildFallbackReply } from "./fallback";
import { fakeDeps, product } from "./testing";

const torch = product({ stock_id: "970S", name: "KITCHEN BLOW TORCH 970S" });

test("the backup reply still shows matching live-checked products and the sales contact", async () => {
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps: fakeDeps([torch]) });
  assert.equal(reply.provider, "fallback");
  assert.equal(reply.showContact, true);
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
  assert.match(reply.message, new RegExp(SALES_CONTACT.email.replace(/[[\]]/g, "\\$&")));
});

test("the backup reply retries a failed search once", async () => {
  const deps = fakeDeps([torch]);
  const search = deps.searchDirect;
  let attempts = 0;
  deps.searchDirect = async (query, limit) => {
    attempts += 1;
    if (attempts === 1) throw new Error("timeout");
    return search(query, limit);
  };
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps });
  assert.equal(attempts, 2);
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

test("the backup reply does not search on a no-need or cancel message, or a very short one", async () => {
  const glove = product({ stock_id: "GL1", name: "NITRILE GLOVE NO NEED HERE STILL HAVE" });
  for (const searchText of ["glove no need, here still have", "nvm", "不用了", "ok"]) {
    const deps = fakeDeps([glove]);
    const reply = await buildFallbackReply({ searchText, lines: [], deps });
    assert.deepEqual(deps.calls, [], searchText);
    assert.deepEqual(reply.cards, [], searchText);
  }
});

test("a search outage still returns a polite reply", async () => {
  const deps = fakeDeps([torch]);
  deps.searchDirect = async () => { throw new Error("down"); };
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps });
  assert.deepEqual(reply.cards, []);
  assert.match(reply.message, /trouble/);
});

test("a pasted list's backup reply searches its first item", async () => {
  // exam 3, s01-B T0: the backup reply searched the list's first 80 characters and showed a can opener and pot lids.
  const deps = fakeDeps([torch]);
  const reply = await buildFallbackReply({ searchText: "pls quote: 1) kitchen blow torch 2) gas cans 3) pot lids 4) ladles", lines: [], deps });
  assert.equal(deps.calls[0], "search:kitchen blow torch");
  assert.deepEqual(reply.cards.map((card) => card.stock_id), ["970S"]);
});

test("labels with nothing between them don't make the backup reply search for nothing", async () => {
  const deps = fakeDeps([torch]);
  await buildFallbackReply({ searchText: "1) 2) kitchen blow torch", lines: [], deps });
  assert.equal(deps.calls[0], "search:1) 2) kitchen blow torch");
});
