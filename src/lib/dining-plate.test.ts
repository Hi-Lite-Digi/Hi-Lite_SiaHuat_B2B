import assert from "node:assert/strict";
import test from "node:test";
import { matchesDiningPlateRequest } from "./catalogue-query";

test("dinner plates exclude the unsuitable platter and starter-plate demo results", () => {
  assert.equal(matchesDiningPlateRequest("black dinner plates", 'STONEWARE RECT NARROW PLATE 20", BLACK'), false);
  assert.equal(matchesDiningPlateRequest("black dinner plates", 'Black slate plate 6.75" for sushi and canapés'), false);
  assert.equal(matchesDiningPlateRequest("black dinner plates", 'ROUND DINNER PLATE 10", BLACK'), true);
});
test("round reusable requirements reject disposable and square alternatives", () => {
  assert.equal(matchesDiningPlateRequest("reusable round plate", "Solia PS Square Plate, Black, 10Pcs/Pkt"), false);
  assert.equal(matchesDiningPlateRequest("round plate", "Cerabon Square Plate"), false);
  assert.equal(matchesDiningPlateRequest("round plate", "Cerabon Round Plate"), true);
  assert.equal(matchesDiningPlateRequest("square disposable plates", "Solia PS Square Plate"), true);
});
