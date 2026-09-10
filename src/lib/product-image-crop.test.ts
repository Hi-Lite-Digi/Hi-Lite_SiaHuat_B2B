import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { cropProductPhoto, normalizeProductBounds, prepareVisionPhoto } from "./product-image-crop";
import { catalogueFingerprintSimilarity, catalogueImageFingerprint } from "./catalogue-image-fingerprint";
import type { ImageAttachment } from "./chat-contract";

const attachment = (bytes: Buffer): ImageAttachment => ({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, mimeType: "image/png", name: "screenshot.png" });
const decode = (image: ImageAttachment) => Buffer.from(image.dataUrl.split(",")[1], "base64");

test("isolating the product panel restores a screenshot match without lowering thresholds", async () => {
  const photo = await sharp(Buffer.from('<svg width="240" height="240"><rect width="240" height="240" fill="white"/><path d="M70 55H170L155 200H85Z" fill="#76543a"/><rect x="70" y="40" width="100" height="20" fill="#222"/></svg>')).png().toBuffer();
  const screen = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#164e43" } }).composite([{ input: photo, left: 90, top: 170 }]).png().toBuffer();
  const cropped = await cropProductPhoto(attachment(screen), normalizeProductBounds({left:90,top:170,right:330,bottom:410},600,800));
  assert.ok(cropped);
  const [reference, whole, isolated] = await Promise.all([catalogueImageFingerprint(photo), catalogueImageFingerprint(screen), catalogueImageFingerprint(decode(cropped))]);
  assert.ok(catalogueFingerprintSimilarity(reference, whole) < 0.8);
  assert.ok(catalogueFingerprintSimilarity(reference, isolated) >= 0.985);
});

test("invalid, tiny and full-frame crops leave the original pipeline available", async () => {
  const image = attachment(await sharp({ create: { width: 600, height: 800, channels: 3, background: "white" } }).png().toBuffer());
  for (const bounds of [null, {left:0,top:0,right:1000,bottom:1000}, {left:-1,top:0,right:900,bottom:900}, {left:400,top:400,right:200,bottom:900}, {left:0,top:0,right:20,bottom:20}, {left:0,top:0,right:NaN,bottom:900}]) {
    assert.equal(await cropProductPhoto(image, bounds), null);
  }
  assert.equal(await cropProductPhoto(attachment(Buffer.from("bad image")), {left:50,top:50,right:950,bottom:950}), null);
});

test("a slightly loose crop tolerates the pale chat frame around a catalogue photo", async () => {
  const photo = await sharp(Buffer.from('<svg width="240" height="240"><rect width="240" height="240" fill="white"/><path d="M70 55H170L155 200H85Z" fill="#76543a"/></svg>')).png().toBuffer();
  const screen = await sharp({create:{width:600,height:800,channels:3,background:"#e0f3ec"}}).composite([{input:photo,left:90,top:170}]).png().toBuffer();
  const crop = await cropProductPhoto(attachment(screen), normalizeProductBounds({left:70,top:150,right:350,bottom:420},600,800));
  assert.ok(crop);
  assert.ok(catalogueFingerprintSimilarity(await catalogueImageFingerprint(photo),await catalogueImageFingerprint(decode(crop))) >= 0.985);
});

test("large images use a known coordinate space within Claude's standard image budget", async () => {
  const image = attachment(await sharp({create:{width:2400,height:3200,channels:3,background:"white"}}).png().toBuffer());
  const prepared = await prepareVisionPhoto(image);
  assert.ok(Math.ceil(prepared.width / 28) * Math.ceil(prepared.height / 28) <= 1568);
  assert.ok(Math.max(prepared.width, prepared.height) <= 1400);
  assert.deepEqual(normalizeProductBounds({left:0,top:0,right:prepared.width/2,bottom:prepared.height/2},prepared.width,prepared.height),{left:0,top:0,right:500,bottom:500});
});
