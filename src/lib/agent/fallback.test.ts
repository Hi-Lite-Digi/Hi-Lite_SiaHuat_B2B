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

test("a search outage still returns a polite reply", async () => {
  const deps = fakeDeps([torch]);
  deps.searchDirect = async () => { throw new Error("down"); };
  const reply = await buildFallbackReply({ searchText: "blow torch", lines: [], deps });
  assert.deepEqual(reply.cards, []);
  assert.match(reply.message, /trouble/);
});
