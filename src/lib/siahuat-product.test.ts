import assert from "node:assert/strict";
import test from "node:test";
import { parseSiaHuatProductPage } from "./siahuat-product";

// The store page as the parser reads it: the title block with its code, and the flight data with price, stock and unit.
const flight = JSON.stringify([1, '{"stkId":"138AC-J2603","b2bPrice":8.17,"availableQty":3434,"uomId":"PC","brandName":"ARCOROC"}']);
const page = (code: string) => `<html><head><title>Hi Ball Tumbler | Sia Huat E-store</title></head><body>
<div class="MuiGrid-container"><div><h5>Arcoroc Granity Tempered Hi Ball Tumbler, 420ml-14oz</h5><span>code: ${code}</span></div>
<div><h6>Brand</h6><p>Arcoroc</p></div></div>
<script>self.__next_f.push(${flight})</script></body></html>`;

test("a store page gives its code, live price, stock and unit", () => {
  const live = parseSiaHuatProductPage(page("J2603"), "https://store.siahuat.com/product/8143483357");
  assert.deepEqual(
    [live.stock_id, live.price_ex_gst, live.available_quantity, live.stock_status, live.uom_id, live.source_stock_id, live.brand],
    ["J2603", 8.17, 3434, "in_stock", "PC", "138AC-J2603", "Arcoroc"],
  );
});

test("a page with no item code and no not-found digest is a plain parse failure", () => {
  assert.throws(() => parseSiaHuatProductPage(page(""), "https://store.siahuat.com/product/14355600983"), { message: /^ITEM_CODE_NOT_FOUND/ });
});

// A removed product's page: HTTP 200, titled "Product - <id>", with only Next's not-found digest in the flight data (r8).
const notFound = `<script>self.__next_f.push(${JSON.stringify([1, '5:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n'])})</script>`;

test("the store's not-found page is a removed listing", () => {
  const html = `<html><head><title>Product - 1 | Sia Huat E-store</title></head><body>${notFound}</body></html>`;
  assert.throws(() => parseSiaHuatProductPage(html, "https://store.siahuat.com/product/1"), { message: /^PAGE_GONE/ });
});

test("a page that parses is never gone, even with the not-found digest somewhere in it", () => {
  const live = parseSiaHuatProductPage(page("J2603").replace("</body>", `${notFound}</body>`), "https://store.siahuat.com/product/8143483357");
  assert.equal(live.stock_id, "J2603");
});
