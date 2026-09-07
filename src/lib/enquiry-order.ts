import type { Product } from "@/lib/chat-contract";
import type { EnquiryReceiptLine } from "@/lib/conversation-export";
import { productCategory } from "@/lib/chat-intent";

/** Resolve only an unambiguous reference to an existing enquiry line. */
export function referencedEnquiryLine(message: string, lines: EnquiryReceiptLine[]) {
  const text = message.toLowerCase();
  const codes = lines.filter((line) => text.includes(line.code.toLowerCase()));
  if (codes.length === 1) return codes[0];
  const category = productCategory(message);
  const matches = lines.filter((line) => category && productCategory(line.item) === category);
  if (matches.length === 1) return matches[0];
  const words = text.match(/[a-z0-9]+/g) ?? [];
  const distinctive = words.filter((word) => word.length > 3 && !["remove", "delete", "cancel", "please", "change", "quantity", "keep", "only", "more", "same", "item", "this", "that"].includes(word));
  const named = lines.filter((line) => distinctive.some((word) => line.item.toLowerCase().includes(word)));
  return named.length === 1 ? named[0] : null;
}

export function removalTarget(message: string): string | null {
  return message.match(/\b(?:remove|delete|drop|cancel|don['’]?t\s+(?:want|need)|do\s+not\s+(?:want|need))\s+(?:the\s+)?(.+?)(?:[,;]|\s+(?:and|but)?\s*keep\b|$)/i)?.[1]?.trim()
    ?? message.match(/(?:删除|移除|不要|取消)\s*(.+?)(?:[，,。]|保留|$)/u)?.[1]?.trim()
    ?? null;
}

export function clearsEnquiry(message: string) {
  return /^(?:cancel(?:\s+(?:my|the|this))?\s+(?:order|enquiry)|(?:remove|delete|clear)\s+(?:all(?:\s+items)?|everything|(?:the\s+)?(?:order|enquiry)))[.!\s]*$/i.test(message.trim())
    || /^(?:取消(?:整个)?(?:订单|询价)|删除全部|清空询价)[。！\s]*$/u.test(message.trim());
}

/** The final quote boundary never accepts unverified or excessive stock. */
export function checkedEnquiryLine(quantity: number, product: Product): EnquiryReceiptLine | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000
    || product.stock_status !== "in_stock"
    || typeof product.available_quantity !== "number"
    || quantity > product.available_quantity
    || !Number.isFinite(product.list_price) || product.list_price < 0) return null;
  return {
    item: product.name, code: product.stock_id, pricePerItem: product.list_price,
    quantity, total: Math.round(product.list_price * 100) * quantity / 100,
    uom: product.uom_id, sourceUrl: product.source_url,
  };
}

export function mergedEnquiryQuantity(lines: EnquiryReceiptLine[], code: string, quantity: number, additive: boolean) {
  return quantity + (additive ? lines.find((line) => line.code === code)?.quantity ?? 0 : 0);
}
