import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyImageRaster, imageSimilarity, matchKnownProductReference } from "./image-evidence";

const fixtureDir = path.resolve("test-fixtures", "images");

async function encoded(name: string) {
  const filePath = path.join(fixtureDir, name);
  const bytes = await fs.readFile(filePath);
  const mimeType = path.extname(name) === ".png" ? "image/png" : "image/jpeg";
  return {
    bytes,
    image: { dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType },
  };
}

test("distinguishes product photos from a comparison table and flat graphic", async () => {
  const product = await encoded("101CA-1000LCD.jpg");
  const portraitProduct = await encoded("101CA-1000LCD-portrait.jpg");
  const comparison = await encoded("rice-dispenser-comparison.png");
  const random = await encoded("random-non-product.png");
  assert.equal(await classifyImageRaster(product.image), "product-like");
  assert.equal(await classifyImageRaster(portraitProduct.image), "product-like");
  assert.equal(await classifyImageRaster(comparison.image), "document-like");
  assert.equal(await classifyImageRaster(random.image), "flat-graphic");
});

test("requires visual agreement with a proposed catalogue image", async () => {
  const product = await encoded("101CA-1520CBP-110.jpg");
  const comparison = await encoded("rice-dispenser-comparison.png");
  assert.ok(await imageSimilarity(product.bytes, product.bytes) >= 0.99);
  assert.ok(await imageSimilarity(comparison.bytes, product.bytes) < 0.68);
});

test("recognises only the verified local product references", async () => {
  const product = await encoded("101CA-1000LCD.jpg");
  const portraitProduct = await encoded("101CA-1000LCD-portrait.jpg");
  const utilityBox = await encoded("101CA-1520CBP-110.jpg");
  const comparison = await encoded("rice-dispenser-comparison.png");
  const random = await encoded("random-non-product.png");
  assert.match(await matchKnownProductReference(product.image) ?? "", /Camtainer/);
  assert.match(await matchKnownProductReference(portraitProduct.image) ?? "", /Camtainer/);
  assert.match(await matchKnownProductReference(utilityBox.image) ?? "", /utility box/);
  assert.equal(await matchKnownProductReference(comparison.image), null);
  assert.equal(await matchKnownProductReference(random.image), null);
});
