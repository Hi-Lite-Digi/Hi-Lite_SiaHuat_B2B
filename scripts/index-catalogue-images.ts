import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { catalogueImageFingerprint, IMAGE_FINGERPRINT_VERSION } from "../src/lib/catalogue-image-fingerprint";

dotenv.config({ path: ".env.local", quiet: true });
const base = process.env.SUPABASE_URL!;
const key = process.env.CATALOGUE_IMAGE_ADMIN_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) throw new Error("SUPABASE_ADMIN_NOT_CONFIGURED");
const headers = { apikey: key, authorization: `Bearer ${key}` };
const bucket = "catalogue-reference-images";
const directory = "tmp/catalogue-images";
const refresh = process.argv.includes("--refresh");
const concurrency = Math.max(1, Math.min(16, Number(process.argv.find(arg => arg.startsWith("--concurrency="))?.split("=")[1] ?? 6)));
const limit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.split("=")[1] ?? Infinity);

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SUPABASE_${response.status}_${path.split("?")[0]}: ${(await response.text()).slice(0,180)}`);
  return response;
}

async function pages<T>(table: string, select: string) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({ select, order: table === "products" ? "stock_id" : "source_image_url", limit: "1000", offset: String(offset) });
    const batch = await (await request(`/rest/v1/${table}?${query}`)).json() as T[];
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

async function main() {
  await mkdir(directory, { recursive: true });
  // Check the configured admin credential belongs to this project's Storage.
  const buckets = await (await request("/storage/v1/bucket")).json() as Array<{ id: string }>;
  if (!buckets.some(entry => entry.id === bucket)) {
    await request("/storage/v1/bucket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 500_000, allowed_mime_types: ["image/webp"] }) });
  }
  const products = await pages<{ stock_id: string; name: string; image_url: string | null; source_url: string | null }>("products", "stock_id,name,image_url,source_url");
  const assets = await pages<{ source_image_url: string; fingerprint_version: string }>("catalogue_image_assets", "source_image_url,fingerprint_version");
  const existing = new Set(assets.filter(asset => asset.fingerprint_version === IMAGE_FINGERPRINT_VERSION).map(asset => asset.source_image_url));
  const imageUrls = [...new Set(products.filter(product => product.source_url && product.image_url).map(product => product.image_url!))];
  // A shared missing-image graphic must never identify a product.
  const urls = imageUrls.filter(url => new URL(url).pathname !== "/placeholder-image-square.jpg");
  // Exercise real customer failures first while the remaining catalogue builds.
  const priority = new Set(products.filter(product => /^(CSD16C|CSD24C|CB-TC-CKWH|GAS|1000LCD-131|500LCD-131)$/.test(product.stock_id)).map(product => product.image_url));
  const pending = urls.filter(url => refresh || !existing.has(url)).sort((a,b) => Number(priority.has(b)) - Number(priority.has(a))).slice(0, limit);
  console.log(JSON.stringify({ products: products.length, uniqueImages: urls.length, indexed: existing.size, pending: pending.length, concurrency }));
  await writeFile(`${directory}/products.json`, JSON.stringify(products));
  let cursor = 0;
  let completed = 0;
  let bytesStored = 0;
  const failures: Array<{ url: string; error: string }> = [];
  async function indexImage(url: string) {
    const parsed = new URL(url);
    if (parsed.origin !== "https://store.siahuat.com" || !parsed.pathname.startsWith("/image-proxy/")) throw new Error("UNTRUSTED_CATALOGUE_IMAGE_URL");
    const localId = createHash("sha256").update(url).digest("hex");
    let original: Buffer;
    try {
      if (refresh) throw new Error("REFETCH_SOURCE");
      original = await readFile(`${directory}/${localId}.source`);
    }
    catch {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
      if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
      if (Number(response.headers.get("content-length") ?? 0) > 5_000_000) throw new Error("SOURCE_IMAGE_TOO_LARGE");
      original = Buffer.from(await response.arrayBuffer());
      if (original.length > 5_000_000) throw new Error("SOURCE_IMAGE_TOO_LARGE");
      await writeFile(`${directory}/${localId}.source`, original);
    }
    const fingerprint = await catalogueImageFingerprint(original);
    const thumbnail = await sharp(original, { limitInputPixels: 40_000_000 }).rotate()
      .resize(640, 640, { fit: "inside", withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
    const storagePath = `${IMAGE_FINGERPRINT_VERSION}/${fingerprint.contentHash}.webp`;
    await request(`/storage/v1/object/${bucket}/${storagePath}`, { method: "POST", headers: { "content-type": "image/webp", "x-upsert": "true", "cache-control": "max-age=31536000" }, body: new Uint8Array(thumbnail) });
    await request("/rest/v1/catalogue_image_assets?on_conflict=source_image_url", {
      method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ source_image_url: url, storage_path: storagePath, content_sha256: fingerprint.contentHash,
        pixel_sha256: fingerprint.pixelHash, fingerprint_version: IMAGE_FINGERPRINT_VERSION, fingerprint: JSON.stringify(fingerprint.vector),
        descriptor: fingerprint.descriptor, aspect_ratio: fingerprint.aspectRatio, searchable: fingerprint.searchable, updated_at: new Date().toISOString() }),
    });
    bytesStored += thumbnail.length;
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      let error = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await indexImage(url); error = ""; break; }
        catch (caught) { error = caught instanceof Error ? caught.message : String(caught); if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
      }
      if (error) failures.push({ url, error });
      completed++;
      if (completed % 100 === 0 || completed === pending.length) console.log(JSON.stringify({ completed, total: pending.length, failed: failures.length, referenceMB: +(bytesStored / 1_000_000).toFixed(1) }));
    }
  }));
  const summary = { catalogueProducts: products.length, uniqueImageUrls: imageUrls.length, excludedPlaceholders: imageUrls.length - urls.length, existingImages: existing.size,
    attempted: pending.length, succeeded: completed - failures.length, failed: failures.length, referenceBytes: bytesStored,
    completedAt: new Date().toISOString(), failures };
  await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  if (failures.length) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "IMAGE_INDEX_FAILED"); process.exitCode = 1; });
