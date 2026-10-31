// src/lib/agent/buying-guides.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { catalogueRanges } from "@/lib/catalogue-ranges";
import { BUYING_GUIDES, guideOf, guidesFor, type BuyingGuide } from "./buying-guides";
import { chipAllowed } from "./guards";

const names = new Set(catalogueRanges.flatMap(([, sections]) => sections.flatMap(([section, types]) => [section, ...types])).map((name) => name.toLowerCase()));

test("every buying guide names real catalogue types and keeps Claire's chip rules (round 11)", () => {
  assert.ok(BUYING_GUIDES.length >= 30, `${BUYING_GUIDES.length} guides`);
  const covered = new Set<string>();
  for (const guide of BUYING_GUIDES) {
    const label = guide.types[0];
    for (const name of [...guide.types, ...(guide.goes_with ?? [])]) assert.ok(names.has(name.toLowerCase()), `${label}: ${name} is not a catalogue type`);
    for (const type of guide.types) {
      assert.ok(!covered.has(type.toLowerCase()), `two guides cover ${type}`);
      covered.add(type.toLowerCase());
    }
    assert.ok(guide.ask.length >= 1 && guide.ask.length <= 2, `${label}: 1-2 asks`);
    assert.equal(guide.chips.length, guide.ask.length, `${label}: chips for each ask`);
    for (const chips of guide.chips) {
      assert.ok(chips.length >= 2 && chips.length <= 3, `${label}: 2-3 chips`);
      // A chip chipAllowed rejects drops every chip of that reply.
      for (const chip of chips) assert.ok(chipAllowed(chip), `${label}: chip ${chip}`);
    }
    assert.ok(guide.fit.length >= 2, `${label}: fit lines`);
    const words = [...guide.ask, ...guide.fit, ...(guide.watch ?? [])].join(" ").split(/\s+/).length;
    assert.ok(words <= 100, `${label}: ${words} words`);
    // The repo is public and a guide is know-how, never a fact: no prices, item codes or sales talk.
    assert.doesNotMatch(JSON.stringify(guide), /\$\s?\d|\b[A-Z]{1,4}-?\d{3,}[A-Z]?\b|best-?sell|\bsold\b|\bunits\b/i, label);
  }
});

test("a product's guide is its type's (its section's when it has no type); a result gets at most two, a turn three, once each", () => {
  const [a, b, c, d] = BUYING_GUIDES;
  const of = (type: string) => ({ third_category: type, subcategory: "Some section" });
  assert.equal(guideOf(of(a.types[0])), a);
  assert.equal(guideOf({ third_category: a.types[0].toUpperCase(), subcategory: null }), a);
  assert.equal(guideOf(of("No such type")), null);
  assert.equal(guideOf({ third_category: null, subcategory: a.types[0] }), a);
  const sent = new Set<BuyingGuide>();
  assert.deepEqual(guidesFor([of(a.types[0]), of(a.types[0]), of(b.types[0]), of(c.types[0])], sent), [a, b]);
  assert.deepEqual(guidesFor([of(a.types[0]), of(c.types[0]), of(d.types[0])], sent), [c]);
  assert.deepEqual(guidesFor([of(d.types[0])], sent), []);
});
