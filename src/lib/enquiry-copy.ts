import type { EnquiryReceiptLine } from "./conversation-export";

type Language = "en" | "zh";

export function confirmationMessage(quantity: number | null, unit: string, language: Language) {
  return language === "zh"
    ? quantity ? `这款要 ${quantity} ${unit}，对吗？` : "是这款吗？"
    : quantity ? `Shall we go with ${quantity} ${unit} of this one?` : "Is this the one you had in mind?";
}

export function stockLimitMessage(quantity: number, limit: number, unit: string, language: Language) {
  if (limit === 0) return language === "zh"
    ? "这款目前缺货。要看看其他选择吗？"
    : "This one is out of stock right now. Would you like to see another option?";
  return language === "zh"
    ? `目前只有 ${limit} ${unit}，不够您要的 ${quantity} ${unit}。\n\n改成 ${limit} ${unit} 可以吗？`
    : `There are only ${limit} ${unit} available, so I can't cover ${quantity} ${unit}.\n\nWould ${limit} ${unit} work for you?`;
}

export function stockUnconfirmedMessage(quantity: number | null, unit: string, language: Language) {
  return language === "zh"
    ? `暂时确认不了${quantity ? `您要的 ${quantity} ${unit} 是否有足够` : "这款的"}库存。要看看其他选择吗？`
    : `I couldn't confirm ${quantity ? `enough stock for ${quantity} ${unit}` : "stock for this one"} just now. Would you like another option?`;
}

export function enquirySummaryMessage(order: EnquiryReceiptLine | EnquiryReceiptLine[], confirmed = false, language: Language = "en") {
  const quotes = Array.isArray(order) ? order : [order];
  const total = quotes.reduce((sum, line) => sum + Math.round(line.total * 100), 0) / 100;
  const lines = [language === "zh"
    ? confirmed ? "询价摘要准备好了：" : "目前的询价是："
    : confirmed ? "Your enquiry is ready to share:" : "Here's your enquiry so far:", ""];
  quotes.forEach((line, index) => {
    lines.push(
      `${index + 1}. ${line.item}`,
      `${line.quantity} ${line.uom} × $${line.pricePerItem.toFixed(2)} = $${line.total.toFixed(2)}`,
      `${language === "zh" ? "代码" : "Code"}: ${line.code}`,
      "",
    );
  });
  lines.push(language === "zh" ? `*总计：$${total.toFixed(2)}（未含 GST）*` : `*Total: $${total.toFixed(2)} (ex GST)*`, "",
    language === "zh"
      ? confirmed ? "尚未下单。下载 PDF 后，您可以发给 Sia Huat 销售人员确认。" : "还要加其他商品吗？"
      : confirmed ? "Nothing has been ordered yet. Download the PDF and share it with Sia Huat sales to confirm." : "Anything else you'd like to add?");
  return lines.join("\n");
}

export function suggestionLabel(value: string) {
  if (/^(?:Prepare staff review summary|Continue for staff review)$/i.test(value)) return "Prepare sales summary";
  if (/^(?:准备人工审核摘要|交由人员确认)$/u.test(value)) return "准备询价摘要";
  return value;
}
