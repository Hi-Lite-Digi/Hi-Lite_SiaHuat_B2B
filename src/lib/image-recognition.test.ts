import assert from "node:assert/strict";
import test from "node:test";
import { recognizedPhotoReply } from "./image-recognition";
import type { ImageInspection } from "./image-recognition";
import type { ChatRequest } from "./chat-contract";
import { photoCatalogueQuery } from "./photo-catalogue-query";

const input: ChatRequest = { sessionId: "photo-recognition", message: "you have this ?", history: [] };
const vision = (message: string, imageCategory: string | null = "knife"): ImageInspection => ({ message, imageCategory, products: [], selectedProduct: null, stage: "clarify", suggestions: [] });

test("a recognised knife survives a missing exact match without inventing a purchasable item", () => {
  const reply = recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT\nThe brand is unreadable, but this is a chef's knife with a wide blade and black handle."), "product-like");
  assert.ok(reply);
  assert.match(reply.message, /see a knife/);
  assert.match(reply.message, /couldn't confirm the exact model/);
  assert.deepEqual(reply.products, []);
  assert.equal(reply.selectedProduct, null);
  assert.equal(reply.stage, "clarify");
  assert.deepEqual(reply.suggestions, ["Find a similar knife", "Only the exact model"]);
});

test("unreadable images, comparisons, negative guesses and caption-only categories do not become recognition", () => {
  for (const message of [
    "IMAGE_KIND=OTHER\nA chef knife", "IMAGE_KIND=SCREENSHOT\nChef knife comparison",
    "IMAGE_KIND=PRODUCT\nI can't identify the object. It might be a knife.",
    "IMAGE_KIND=PRODUCT\nThis is not a knife", "IMAGE_KIND=PRODUCT\nIt could be a knife",
    "IMAGE_KIND=PRODUCT\nA dark rectangle. You asked about a knife.",
  ]) assert.equal(recognizedPhotoReply({ ...input, message: "I want a knife" }, vision(message, null), "product-like"), null, message);
  assert.equal(recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT\nA dark object", "possibly a knife"), "product-like"), null);
  for (const raster of ["flat-graphic", "document-like", "unknown"] as const) {
    assert.equal(recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT\nA knife"), raster), null);
  }
});

test("recognition retains a supplied quantity without reading dimensions as quantities", () => {
  const description = vision("IMAGE_KIND=PRODUCT\nA chef knife with a dark handle");
  assert.match(recognizedPhotoReply({ ...input, message: "I need 3 of this" }, description, "product-like")!.message, /quantity of 3/);
  assert.doesNotMatch(recognizedPhotoReply({ ...input, message: "20cm like this" }, description, "product-like")!.message, /quantity of 20/);
});

test("screenshot torch descriptions all retain recognition and use one catalogue query", () => {
  for (const category of ["torch lighter", "culinary torch", "butane torch", "kitchen blowtorch", "cooking torch", "gas torch lighter"]) {
    const reply = recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT. A handheld Iwatani torch with a white pistol grip.", category), "product-like");
    assert.match(reply!.message, /see a gas torch burner/, category);
    assert.equal(photoCatalogueQuery("A trigger handle and adjustment knob", category), "gas torch burner", category);
    assert.equal(reply!.selectedProduct, null);
  }
});

test("a confidently visible item outside the search taxonomy is not discarded", () => {
  const reply = recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT. A hand-operated cherry pitter.", "cherry pitter"), "product-like");
  assert.match(reply!.message, /see a cherry pitter/);
  assert.deepEqual(reply!.products, []);
  assert.match(reply!.message, /couldn't confirm the exact model/);
});
