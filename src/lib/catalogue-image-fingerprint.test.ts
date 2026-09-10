import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { catalogueImageFingerprint, catalogueFingerprintSimilarity, classifyCatalogueImageMatches } from "./catalogue-image-fingerprint";
import { directCatalogueImageReply, visionValidatedLibraryReply, lookupCatalogueImage } from "./catalogue-image-library";
import type { Product } from "./chat-contract";
import { applyClaudeWording } from "./claude-client";

const photo = (colour = "#a36b3b", round = false) => sharp(Buffer.from(`<svg width="400" height="400"><defs><linearGradient id="surface"><stop stop-color="${colour}"/><stop offset="1" stop-color="#292929"/></linearGradient></defs><rect width="400" height="400" fill="white"/>${round
  ? `<circle cx="200" cy="200" r="100" fill="url(#surface)"/>`
  : `<path d="M135 95 L265 95 L245 305 L155 305 Z" fill="url(#surface)"/><rect x="142" y="65" width="116" height="30" fill="#373737"/>`}</svg>`)).png().toBuffer();
const product = (id: string, name = "Copper Cocktail Shaker 16oz"): Product => ({ stock_id: id, name, status: "Active", list_price: 19.82, uom_id: "PC" });
const match = (id: string, score = 1, exact = false) => ({ sourceImageUrl: `https://store.siahuat.com/image-proxy/${id}.jpg`, score, exact, stockIds: [id] });

test("same catalogue picture survives resizing and JPEG compression", async () => {
  const original = await photo();
  const resized = await sharp(original).resize(700, 700).jpeg({ quality: 80 }).toBuffer();
  const [a, b] = await Promise.all([catalogueImageFingerprint(original), catalogueImageFingerprint(resized)]);
  assert.ok(a.searchable);
  assert.equal(a.vector.length, 256);
  assert.ok(catalogueFingerprintSimilarity(a, b) >= 0.98);
  assert.equal(catalogueFingerprintSimilarity(a, a), 1);
  assert.notEqual(a.contentHash, b.contentHash);
});

test("white margins do not make different objects or colours strong matches", async () => {
  const a = await catalogueImageFingerprint(await photo());
  const blue = await catalogueImageFingerprint(await photo("#123bd1"));
  const circle = await catalogueImageFingerprint(await photo("#a36b3b", true));
  assert.ok(catalogueFingerprintSimilarity(a, blue) < 0.95);
  assert.ok(catalogueFingerprintSimilarity(a, circle) < 0.8);
  const blank = await catalogueImageFingerprint(await sharp({ create: { width: 400, height: 400, channels: 3, background: "white" } }).png().toBuffer());
  assert.equal(blank.searchable, false);
});

test("80 percent is a candidate threshold, not permission to claim the exact SKU", () => {
  assert.equal(classifyCatalogueImageMatches([match("A", 0.79)]).kind, "none");
  assert.equal(classifyCatalogueImageMatches([match("A", 0.8)]).kind, "candidates");
  assert.equal(classifyCatalogueImageMatches([match("A", 0.97)]).kind, "candidates");
  assert.equal(classifyCatalogueImageMatches([match("A", 0.99), match("B", 0.97)]).kind, "candidates");
  assert.equal(classifyCatalogueImageMatches([match("A", 0.995), match("B", 0.93)]).kind, "direct");
});

test("shared and nearly identical catalogue pictures preserve all SKU ambiguity", () => {
  assert.equal(classifyCatalogueImageMatches([{ ...match("A", 1, true), stockIds: ["A", "B"] }]).kind, "ambiguous");
  assert.equal(classifyCatalogueImageMatches([match("A", 1, true), match("B", 1, true)]).kind, "ambiguous");
  assert.equal(classifyCatalogueImageMatches([match("A", 1, true), match("B", 0.99)]).kind, "ambiguous");
  const reply = directCatalogueImageReply({ kind: "ambiguous", matches: [match("A")], products: [product("A"), product("B")], totalProducts: 10 });
  assert.equal(reply?.products.length, 0);
  assert.match(reply!.message, /shared|variants/);
  assert.equal(reply?.selectedProduct, null);
});

test("a direct library result still asks confirmation and never enters quantity or checkout", () => {
  const reply = directCatalogueImageReply({ kind: "direct", matches: [match("CSD16C")], products: [product("CSD16C")], totalProducts: 1 });
  assert.equal(reply?.products[0].stock_id, "CSD16C");
  assert.equal(reply?.selectedProduct, null);
  assert.equal(reply?.stage, "clarify");
  assert.match(reply!.message, /Is this the item/);
  assert.throws(() => applyClaudeWording(reply!, { message: "No match", productIds: [], suggestions: [] }), /REMOVED_VERIFIED_IMAGE_MATCH/);
});

test("a merely similar image cannot replace vision's independently recognised family", () => {
  const result = { kind: "candidates" as const, matches: [match("A", 0.86)], products: [product("A")], totalProducts: 1 };
  assert.equal(directCatalogueImageReply(result), null);
  assert.equal(visionValidatedLibraryReply(result, null, "unknown"), null);
  assert.equal(visionValidatedLibraryReply(result, "chef knife", "steel knife"), null);
});

test("a screenshot below the direct threshold keeps its torch candidate after vision confirmation", () => {
  const result = {kind: "candidates" as const, matches:[match("CB-TC-CKWH",0.9816)], products:[product("CB-TC-CKWH","Iwatani Cassette Gas Torch Burner L16cm,White")], totalProducts:1};
  const reply = visionValidatedLibraryReply(result,"torch lighter","A white handheld Iwatani torch lighter");
  assert.equal(reply!.products[0].stock_id,"CB-TC-CKWH");
  assert.equal(reply!.selectedProduct,null);
  assert.match(reply!.message,/exact model.*not confirmed/);
  assert.equal(visionValidatedLibraryReply(result,"coffee grinder","A white coffee grinder"),null);
});

test("an unavailable image index falls back without failing the photo request", async () => {
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
  process.env.SUPABASE_URL = "https://test.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-key";
  globalThis.fetch = async () => new Response("index temporarily unavailable", { status: 503 });
  try {
    const bytes = await photo();
    assert.equal(await lookupCatalogueImage({ dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, mimeType: "image/png", name: "test.png" }), null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_PUBLISHABLE_KEY", saved.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
