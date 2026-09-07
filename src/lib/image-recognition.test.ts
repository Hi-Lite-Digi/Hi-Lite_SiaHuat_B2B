import assert from "node:assert/strict";
import test from "node:test";
import { recognizedPhotoReply } from "./image-recognition";
import type { ChatReply, ChatRequest } from "./chat-contract";

const input: ChatRequest = { sessionId: "photo-recognition", message: "you have this ?", history: [] };
const vision = (message: string): ChatReply => ({ message, products: [], selectedProduct: null, stage: "clarify", suggestions: [] });

test("a recognised knife survives a missing exact match without inventing a purchasable item", () => {
  const reply = recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT\nThe image shows a chef's knife with a wide blade and black handle. The brand name is unreadable."), "product-like");
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
  ]) assert.equal(recognizedPhotoReply({ ...input, message: "I want a knife" }, vision(message), "product-like"), null, message);
  for (const raster of ["flat-graphic", "document-like", "unknown"] as const) {
    assert.equal(recognizedPhotoReply(input, vision("IMAGE_KIND=PRODUCT\nA knife"), raster), null);
  }
});

test("recognition retains a supplied quantity without reading dimensions as quantities", () => {
  const description = vision("IMAGE_KIND=PRODUCT\nA chef knife with a dark handle");
  assert.match(recognizedPhotoReply({ ...input, message: "I need 3 of this" }, description, "product-like")!.message, /quantity of 3/);
  assert.doesNotMatch(recognizedPhotoReply({ ...input, message: "20cm like this" }, description, "product-like")!.message, /quantity of 20/);
});
