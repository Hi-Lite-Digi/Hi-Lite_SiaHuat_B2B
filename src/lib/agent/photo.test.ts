// src/lib/agent/photo.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { prepareVisionPhoto } from "@/lib/product-image-crop";
import { AS_IS_FALLBACK_BYTES, SEND_AS_IS_BYTES, THUMB_EDGE, shrunkSize } from "./photo";

const png = async (width: number, height: number) => {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#f5f1e8" } }).png().toBuffer();
  return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, mimeType: "image/png" as const, name: "screenshot.png" };
};

test("a big photo is shrunk to at most 1,600 px on its longest side, and a small one is never enlarged", () => {
  assert.deepEqual(shrunkSize(1170, 2532), { width: 739, height: 1600 });
  assert.deepEqual(shrunkSize(2880, 1800), { width: 1600, height: 1000 });
  assert.deepEqual(shrunkSize(480, 480), { width: 480, height: 480 });
});

test("the enquiry PDF's copy of a photo is at most 1,200 px on its longest side", () => {
  // r8 F3: the PDF draws the customer's photo, not "[Product photo attached]" (OD-13: up to 1,200 px).
  assert.deepEqual(shrunkSize(1600, 1200, 1200), { width: 1200, height: 900 });
  assert.deepEqual(shrunkSize(480, 480, 1200), { width: 480, height: 480 });
});

test("the saved chat's thumbnail is at most 320 px on its longest side", () => {
  // r8 F1: a refresh keeps the chat in the tab's storage, which holds a long chat only with small photos.
  assert.deepEqual(shrunkSize(4000, 3000, THUMB_EDGE), { width: 320, height: 240 });
  assert.deepEqual(shrunkSize(200, 120, THUMB_EDGE), { width: 200, height: 120 });
});

test("shrinking in the browser loses nothing Claude sees", async () => {
  // The owner's screenshot (2 Oct) got a 413 before Claire saw it; the server gives Claude at most 1,400 px / 1 MP anyway.
  for (const [width, height, seen] of [[1170, 2532, [646, 1400]], [2880, 1800, [1264, 790]], [1920, 1080, [1333, 750]]] as const) {
    const small = shrunkSize(width, height);
    const [original, shrunk] = await Promise.all([prepareVisionPhoto(await png(width, height)), prepareVisionPhoto(await png(small.width, small.height))]);
    assert.deepEqual([original.width, original.height], seen, `${width}x${height}`);
    assert.deepEqual([shrunk.width, shrunk.height], seen, `${width}x${height} shrunk`);
  }
});

test("a photo sent as it is stays under the size that sent fine live", () => {
  // Live test (2 Oct): a 3 MB photo got a reply, a 4.2 MB one a 413 (Vercel's 4.5 MB request limit, base64 adds a third).
  assert.ok(SEND_AS_IS_BYTES <= AS_IS_FALLBACK_BYTES);
  assert.ok(AS_IS_FALLBACK_BYTES <= 3_000_000);
});
