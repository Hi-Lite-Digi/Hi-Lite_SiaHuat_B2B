import assert from "node:assert/strict";
import test from "node:test";
import type { Product } from "./chat-contract";
import { displayedPriceComparison } from "./displayed-comparison";
import { catalogueMessageWithContext, productCategory } from "./chat-intent";
import { requestedQuantity } from "./chat-turn";
import { getFastChatReply } from "./fast-chat";

const glasses: Product[] = [
  { stock_id: "GLASS-1", name: "Red wine glass 550ml", status: "ACTIVE", list_price: 35.69, uom_id: "PC", stock_status: "in_stock" },
  { stock_id: "GLASS-2", name: "Allround wine glass 430ml", status: "ACTIVE", list_price: 20.09, uom_id: "PC", stock_status: "in_stock" },
];

test("a first broad plate enquiry asks for purpose before listing arbitrary products", () => {
  const reply = getFastChatReply({ sessionId: "broad-plate-quality", message: "Hi, I'm opening a cafe and have no idea what plates to get.", history: [] });
  assert.ok(reply);
  assert.deepEqual(reply.products, []);
  assert.match(reply.message, /serve/);
});

test("price follow-ups compare the displayed items without replacing them with a new search", () => {
  for (const message of ["Which of those is cheapest?", "Which has the lowest price?", "哪个最便宜？"]) {
    const reply = displayedPriceComparison(message, glasses);
    assert.deepEqual(reply?.products.map(product => product.stock_id), ["GLASS-2"]);
    assert.match(reply!.message, /20.09/);
    assert.equal(reply?.selectedProduct, null, "An information question must not silently buy an item.");
  }
  assert.equal(displayedPriceComparison("Show me cheaper alternatives", glasses), null);
  assert.equal(displayedPriceComparison("What is your cheapest pan?", glasses), null);
});

test("piece and set prices cannot be ranked as equivalent units", () => {
  const reply = displayedPriceComparison("Which is cheapest?", [glasses[0], { ...glasses[1], uom_id: "SET" }]);
  assert.equal(reply?.products.length, 2);
  assert.match(reply!.message, /different units/);
});

test("Chinese catalogue requests retain product, dimensions, colour and quantity", () => {
  const request = "你好，我开餐厅，需要三把20厘米厨师刀。";
  assert.equal(productCategory(request), "knife");
  assert.equal(requestedQuantity(request), 3);
  const query = catalogueMessageWithContext("黑色手柄。", [request]);
  assert.match(query, /20cm/);
  assert.match(query, /chef knife/);
  assert.match(query, /black/);
  assert.equal(getFastChatReply({ sessionId: "zh-refinement", message: "黑色手柄。", history: [{ role: "user", content: request }] }), null);
});
