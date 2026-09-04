import assert from "node:assert/strict";
import test from "node:test";
import { metricDimensionConstraintsMatch } from "./catalogue-dimensions";

test("enforces both sides of a 2D metric catalogue constraint", () => {
  assert.equal(
    metricDimensionConstraintsMatch("black utility box 53 x 38 cm", "Utility box dimensions: 53 x 38 x 30 cm"),
    true,
  );
  assert.equal(
    metricDimensionConstraintsMatch("black utility box 53 x 38 cm", "Utility box dimensions: 40 x 38 x 30 cm"),
    false,
  );
});

test("matches reordered and unit-converted metric dimensions", () => {
  assert.equal(
    metricDimensionConstraintsMatch("utility box 53 x 38 cm", "Product size L380 x W530 x H330 mm"),
    true,
  );
  assert.equal(
    metricDimensionConstraintsMatch("utility box 53 x 38 x 30 cm", "Product size 380 x 530 x 300 mm"),
    true,
  );
  assert.equal(
    metricDimensionConstraintsMatch("utility box 53 x 38 x 30 cm", "Product size 380 x 530 x 350 mm"),
    false,
  );
});

test("leaves single metric measurements to the existing constraint matcher", () => {
  assert.equal(metricDimensionConstraintsMatch("30 cm frying pan", "30 cm frying pan"), null);
});
