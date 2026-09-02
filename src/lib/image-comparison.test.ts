import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogueHistoryWithClarification,
  catalogueMessageWithContext,
  normalizeCommonProductTypos,
  productCategory,
} from "./chat-intent";
import {
  encodedImageDimensions,
  extractRiceDispenserComparisonOptions,
  isImageComparisonRequest,
  looksLikeTallScreenshot,
  referencedComparisonItems,
  referencesMultipleComparisonItems,
  resolveRiceDispenserModels,
  riceDispenserImageClarification,
  visionImageKind,
} from "./image-comparison";

function imageDataUrl(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const comparisonVisionText = `The screenshot is a comparison table for automatic rice dispensers.
WF-RD-10 Product type: Tabletop. Capacity: 10kg cooked rice.
WF-RD-30 Product type: Tabletop. Capacity: 30kg cooked rice.
WF-RD-60 Product type: Vertical stand. Capacity: 30kg cooked rice.`;

test("extracts model, capacity and placement from a rice-dispenser comparison", () => {
  assert.deepEqual(extractRiceDispenserComparisonOptions(comparisonVisionText), [
    { model: "WF-RD-10", capacityKg: 10, placement: "tabletop" },
    { model: "WF-RD-30", capacityKg: 30, placement: "tabletop" },
    { model: "WF-RD-60", capacityKg: 30, placement: "floor-standing" },
  ]);
});

test("builds a quantity-preserving clarification without availability claims", () => {
  const reply = riceDispenserImageClarification({
    visionText: comparisonVisionText,
    userMessage: "Can you check items 1 and 2? I need 2 each.",
    quantity: 2,
  });

  assert.ok(reply);
  assert.match(reply.message, /kept quantity 2/i);
  assert.match(reply.message, /WF-RD-10/);
  assert.match(reply.message, /stock, price and any order are not confirmed/i);
  assert.deepEqual(reply.suggestions.slice(0, 2), ["WF-RD-10 (10 kg)", "WF-RD-30 (30 kg)"]);
});

test("does not intercept a single-product rice-dispenser photo", () => {
  assert.equal(riceDispenserImageClarification({
    visionText: "This appears to be one WF-RD-10 rice dispenser.",
    userMessage: "Do you sell this?",
    quantity: null,
  }), null);
});

test("asks for a crop instead of implying unread options were listed", () => {
  const reply = riceDispenserImageClarification({
    visionText: "This is a comparison table for automatic rice dispensers, but the model fields are unreadable.",
    userMessage: "Can you check items 1 and 2? I need 2 each.",
    quantity: 2,
  });

  assert.ok(reply);
  assert.match(reply.message, /kept quantity 2/i);
  assert.match(reply.message, /closer crop/i);
  assert.doesNotMatch(reply.message, /options:\s*[,;]/i);
  assert.deepEqual(reply.suggestions, ["Type the model", "Tell me the capacity", "Send a clearer photo"]);
});

test("resolves item-number follow-ups and lets an explicit model win", () => {
  assert.deepEqual(resolveRiceDispenserModels("item 2", [comparisonVisionText]), ["WF-RD-30"]);
  assert.deepEqual(resolveRiceDispenserModels("WF RD 60 please", [comparisonVisionText]), ["WF-RD-60"]);
  assert.deepEqual(resolveRiceDispenserModels("Quantity 2", ["You selected rice dispenser WF-RD-30. How many units?"]), ["WF-RD-30"]);
});

test("detects numbered comparison requests without treating quantities as rows", () => {
  assert.equal(referencesMultipleComparisonItems("Can check items 1 and 2? I need 2 each."), true);
  assert.equal(referencesMultipleComparisonItems("Compare row 1 vs row 3"), true);
  assert.equal(referencesMultipleComparisonItems("the first item and the second item"), true);
  assert.equal(referencesMultipleComparisonItems("I need 1 or 2 units"), false);
});

test("retains the actual referenced comparison rows", () => {
  assert.deepEqual(referencedComparisonItems("Compare row 1 vs row 3; need 2 and 5"), [1, 3]);
  assert.deepEqual(referencedComparisonItems("items 2 and 3 please"), [2, 3]);
});

test("uses the explicit image-kind marker instead of portrait geometry", () => {
  assert.equal(visionImageKind("IMAGE_KIND=PRODUCT\nA single toaster."), "product");
  assert.equal(visionImageKind("IMAGE_KIND=SCREENSHOT\nOPTION 1: MODEL=WF-RD-10"), "screenshot");
  assert.equal(visionImageKind("This is a screenshot with OPTION 1: MODEL=WF-RD-10"), "unknown");
  assert.equal(visionImageKind("Possible black utility box."), "unknown");
});

test("recognises explicit screenshot comparison wording even when a product family is named", () => {
  assert.equal(isImageComparisonRequest("Compare the rice dispensers in this screenshot; I need 2."), true);
  assert.equal(isImageComparisonRequest("Do you have this 12QT stockpot?"), false);
});

test("detects a tall JPEG phone screenshot from encoded dimensions", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x08, 0x00,
    0x03, 0xb3,
    0x03, 0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const image = { dataUrl: imageDataUrl(jpeg, "image/jpeg"), mimeType: "image/jpeg" };
  assert.deepEqual(encodedImageDimensions(image), { width: 947, height: 2048 });
  assert.equal(looksLikeTallScreenshot(image), true);
});

test("does not treat an ordinary landscape product image as a tall screenshot", () => {
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x04, 0x00,
    0x00, 0x00, 0x03, 0x00,
  ]);
  const image = { dataUrl: imageDataUrl(png, "image/png"), mimeType: "image/png" };
  assert.deepEqual(encodedImageDimensions(image), { width: 1024, height: 768 });
  assert.equal(looksLikeTallScreenshot(image), false);
});

test("carries the latest comparison into an item-number follow-up", () => {
  const history = [
    { role: "user" as const, content: "Can you check items 1 and 2? I need 2 each." },
    {
      role: "assistant" as const,
      content: `This photo compares automatic rice dispensers.\n1. WF-RD-10 — 10 kg\n2. WF-RD-30 — 30 kg\nChoose the model you want.`,
    },
  ];
  for (const message of ["item 2", "I want item 2", "item 2 need 2", "I want item 2, need 2"]) {
    const context = catalogueHistoryWithClarification(message, history);
    assert.equal(
      catalogueMessageWithContext(message, context),
      "WF-RD-30 rice dispenser",
      `expected comparison context to resolve for: ${message}`,
    );
  }
  assert.equal(catalogueMessageWithContext("WF-RD-10 (10 kg)", []), "WF-RD-10 rice dispenser");
});

test("does not attach a fresh catalogue request to the preceding comparison", () => {
  const history = [
    { role: "user" as const, content: "Show me rice dispenser options." },
    {
      role: "assistant" as const,
      content: `This photo compares automatic rice dispensers.\n1. WF-RD-10 — 10 kg\n2. WF-RD-30 — 30 kg\nChoose the model you want.`,
    },
  ];

  for (const message of ["I need 2 bread knives", "I want item 2 bread knives"]) {
    const context = catalogueHistoryWithClarification(message, history);
    assert.doesNotMatch(context.join("\n"), /WF-RD-30/);
    assert.equal(catalogueMessageWithContext(message, context), "bread knife");
  }
});

test("normalizes common human typos without losing plate buying constraints", () => {
  const message = "i ned 2 blak dinnr plates";

  assert.equal(normalizeCommonProductTypos(message), "i need 2 black dinner plates");
  assert.equal(productCategory(message), "tableware");
  assert.equal(catalogueMessageWithContext(message, []), "black dinner plate tableware");
});
