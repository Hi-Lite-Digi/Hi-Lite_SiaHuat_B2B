import type { Product } from "./chat-contract";

export type PackagingUnit = "carton" | "packet";

export function requestedPackagingUnit(message: string): PackagingUnit | null {
  if (/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:cartons?|ctns?)\b/i.test(message)) return "carton";
  if (/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:packets?|pkts?|packs?)\b/i.test(message)) return "packet";
  return null;
}

// Pack sizes must come from the selected catalogue item, never from another
// conversation line or a model-generated claim.
export function resolveProductQuantity(count: number | null, unit: PackagingUnit | null, product: Product, language: "en" | "zh" = "en") {
  if (count === null || unit === null) return { quantity: count, notice: "" };
  const unitPattern = unit === "carton" ? "(?:cartons?|ctns?)" : "(?:packets?|pkts?|packs?)";
  if (new RegExp(`^${unitPattern}$`, "i").test(product.uom_id)) return { quantity: count, notice: "" };
  const evidence = `${product.name} ${product.description ?? ""}`;
  const sizes = [...evidence.matchAll(new RegExp(`\\b(\\d+)\\s*(?:pcs?|pieces?|cans?)\\s*(?:/|per\\s+)\\s*${unitPattern}\\b`, "gi"))].map(match => Number(match[1]));
  const distinctSizes = [...new Set(sizes)].filter(size => size > 0);
  const factor = distinctSizes.length === 1 && /^(?:pcs?|pieces?|cans?)$/i.test(product.uom_id) ? distinctSizes[0] : null;
  if (factor === null) return {
    quantity: null,
    notice: language === "zh" ? `这件商品按 ${product.uom_id} 计价，目录没有明确每包/箱数量。请提供所需的 ${product.uom_id} 数量。` : `This item is priced per ${product.uom_id}, but its ${unit} size isn't confirmed in the catalogue. Please give the quantity in ${product.uom_id}.`,
  };
  const quantity = count * factor;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) return {
    quantity: null,
    notice: language === "zh" ? `换算后的数量超过限制。请输入 1 至 100,000 ${product.uom_id}。` : `That pack quantity exceeds the limit. Please enter 1 to 100,000 ${product.uom_id}.`,
  };
  return { quantity, notice: `${count} ${unit}${count === 1 ? "" : "s"} × ${factor} ${product.uom_id} = ${quantity} ${product.uom_id}.` };
}
