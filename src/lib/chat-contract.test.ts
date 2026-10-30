// src/lib/chat-contract.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { product } from "./agent/testing";
import { publicProduct } from "./chat-contract";

test("a product sent to a browser carries no sales fields (r10)", () => {
  // A made-up row: no real product's sales flags in this public repo.
  const plain = product({ stock_id: "T-GN65", name: "ACME GN PAN", image_url: "https://store.siahuat.com/image-proxy/ASP/SIAHUAT/NORMAL/Shell/picture/T-GN65.jpg", category: "Kitchen" });
  assert.deepEqual(publicProduct({ ...plain, popularity: 90, best_seller: true, sales_name: "ACME GN PAN 1/1 65mm" }), plain);
  assert.deepEqual(publicProduct(plain), plain);
});
