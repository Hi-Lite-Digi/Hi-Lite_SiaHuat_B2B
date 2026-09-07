import type { ChatReply, Product } from "./chat-contract";
import { productCategory } from "./chat-intent";

export function displayedPriceComparison(message: string, products: Product[]): ChatReply | null {
  if (!products.length || !/\b(?:cheapest|least expensive|most affordable|lowest.price|price difference|compare (?:their |the )?prices)\b|最便宜|价格最低|比较价格|价格差/u.test(message.toLowerCase())) return null;
  // A different product family starts a fresh search; "cheaper alternatives"
  // also remains a search rather than a comparison of the current shortlist.
  const category = productCategory(message);
  if (category && products.every(product => productCategory(product.name) !== category)) return null;
  const available = products.filter(product => product.stock_status !== "out_of_stock" && Number.isFinite(product.list_price));
  if (!available.length) return { message: "Those options are out of stock. Would you like a different option?", stage: "clarify", products: [], selectedProduct: null, suggestions: ["Choose another item"] };
  if (new Set(available.map(product => product.uom_id.toUpperCase())).size > 1) {
    return { message: "These prices use different units, so a set price and a piece price aren't directly comparable. Which unit do you need?", stage: "clarify", products: available, selectedProduct: null, suggestions: [] };
  }
  const cheapest = [...available].sort((left, right) => left.list_price - right.list_price)[0];
  return {
    message: `Among the options already shown, ${cheapest.name} has the lowest listed price at $${cheapest.list_price.toFixed(2)} per ${cheapest.uom_id}, excluding GST. Would this one suit you?`,
    stage: "clarify", products: [cheapest], selectedProduct: null, suggestions: ["1"],
  };
}
