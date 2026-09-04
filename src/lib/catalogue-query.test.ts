import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogueLookupOverride,
  foodPanDepthConstraintMatches,
  hasPlasticLikeHandle,
  ladleCapacityMatchQuality,
  normalizeFoodPanCatalogueQuery,
  requestedLadleCapacitiesOz,
} from "./catalogue-query";

test("preserves GN food-pan fractions, depth and slotted-lid identity", () => {
  assert.equal(
    normalizeFoodPanCatalogueQuery('1/2 Stainless Steel Pan, 6" Deep'),
    "stainless steel 1/2 6 inch Deep GN food pan",
  );
  assert.equal(
    normalizeFoodPanCatalogueQuery("Lid for 1/4 S/S Pan with notch for ladle"),
    "stainless steel 1/4 slotted GN food pan lid",
  );
});

test("matches a six-inch GN depth to 150mm, not 200mm", () => {
  const request = "stainless steel 1/2 6 inch Deep GN food pan";
  assert.equal(catalogueLookupOverride(request), "stainless steel food pan 1/2 size 150mm");
  assert.equal(foodPanDepthConstraintMatches(request, "GN 1/2 SIZE 150mm DEEP"), true);
  assert.equal(foodPanDepthConstraintMatches(request, "GN 1/2 SIZE 200mm DEEP"), false);
});

test("keeps the oyster lookup in-family and recognises POM as plastic", () => {
  assert.equal(catalogueLookupOverride("oyster knife with plastic handle"), "oyster knife");
  assert.equal(hasPlasticLikeHandle("Giesser Oyster Opener/Knife, POM Handle"), true);
  assert.equal(hasPlasticLikeHandle("Safico Oyster Knife With Wood Handle"), false);
});

test("requires every requested ladle capacity instead of accepting a generic 90cc ladle", () => {
  assert.deepEqual(
    requestedLadleCapacitiesOz("Stainless Steel Ladle 4oz, 6oz, 8oz, length approximate 10inch"),
    [4, 6, 8],
  );
  assert.equal(ladleCapacityMatchQuality("S/S ONE-PC LADLE 4.0oz", 4), 2);
  assert.equal(ladleCapacityMatchQuality("AG 18-8 Stainless Steel Ladle 180cc", 6), 1);
  assert.equal(ladleCapacityMatchQuality("AG 18-8 Stainless Steel Ladle 90cc", 4), 0);
});
