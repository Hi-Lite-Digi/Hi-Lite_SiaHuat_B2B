import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { classifyImageRaster, imageSimilarity, matchKnownComparisonReference, matchKnownProductReference } from "./image-evidence";

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

test("reads the verified rice-dispenser comparison without a remote vision round trip", async () => {
  const comparison = await encoded("rice-dispenser-comparison.png");
  const random = await encoded("random-non-product.png");
  const sharedBytes = await sharp(comparison.bytes).resize({ width: 520 }).jpeg({ quality: 50 }).toBuffer();
  const sharedImage = { dataUrl: `data:image/jpeg;base64,${sharedBytes.toString("base64")}`, mimeType: "image/jpeg" };
  const recognised = await matchKnownComparisonReference(comparison.image);
  assert.match(recognised ?? "", /WF-RD-10/);
  assert.match(recognised ?? "", /WF-RD-30/);
  assert.match(recognised ?? "", /10 kg cooked rice/i);
  assert.match(recognised ?? "", /30 kg cooked rice/i);
  assert.match(await matchKnownComparisonReference(sharedImage) ?? "", /WF-RD-10/);
  assert.equal(await matchKnownComparisonReference(random.image), null);
});

test("does not mistake a pale chat layout for the rice comparison sheet", async () => {
  const chatScreenshot = await sharp({
    create: { width: 740, height: 1500, channels: 3, background: "#f5f0e8" },
  })
    .composite([
      { input: Buffer.from('<svg width="600" height="320"><rect width="600" height="320" rx="30" fill="#ffffff"/><rect y="210" width="420" height="18" fill="#dedad2"/></svg>'), left: 55, top: 100 },
      { input: Buffer.from('<svg width="520" height="260"><rect width="520" height="260" rx="30" fill="#d9f4e7"/><rect x="45" y="70" width="390" height="18" fill="#547068"/></svg>'), left: 165, top: 500 },
      { input: Buffer.from('<svg width="600" height="360"><rect width="600" height="360" rx="30" fill="#ffffff"/><rect x="45" y="70" width="470" height="18" fill="#547068"/></svg>'), left: 55, top: 850 },
    ])
    .png()
    .toBuffer();
  const image = { dataUrl: `data:image/png;base64,${chatScreenshot.toString("base64")}`, mimeType: "image/png" };
  assert.equal(await matchKnownComparisonReference(image), null);
});
