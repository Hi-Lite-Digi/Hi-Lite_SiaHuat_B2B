const actionLabels = new Set([
  "prepare staff review summary",
  "continue for staff review",
  "download enquiry pdf",
  "choose another item",
  "search again",
  "browse products",
  "try a smaller quantity",
  "add another item",
  "change quantity",
  "finish enquiry summary",
  "start another enquiry",
  "yes",
  "yes this is it",
  "yes this is the item",
  "yes this is the one",
  "yes that is it",
  "yes that is the item",
  "yes that is the one",
  "yes that is correct",
  "yes that is right",
  "yes that is the right item",
  "yes correct",
  "no",
  "no show others",
  "no show me others",
  "no show other options",
  "no choose another",
  "no choose another item",
  "no that is not it",
  "no that is not the item",
  "no that is not the one",
  "no this is not it",
  "no this is not the item",
  "no this is not the one",
  "准备人工审核摘要",
  "交由人员确认",
  "下载询价 pdf",
  "选择其他商品",
  "重新查询",
  "浏览商品",
  "再加一件商品",
  "更改数量",
  "完成询价摘要",
  "开始新的询价",
  "是的就是这个",
  "是的就是这件商品",
  "不是查看其他",
  "不是我要看其他商品",
]);

export type EnquiryReceiptLine = {
  item: string;
  code: string;
  pricePerItem: number;
  quantity: number;
  total: number;
  uom: string;
  sourceUrl?: string | null;
};

type ReceiptMessage = {
  quoteSummary?: EnquiryReceiptLine;
  quoteSummaries?: EnquiryReceiptLine[];
};

export function latestEnquiryReceiptLines(messages: ReceiptMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.quoteSummaries) return message.quoteSummaries;
    if (message.quoteSummary) return [message.quoteSummary];
  }
  return [];
}

export function enquiryReceiptTotals(lines: EnquiryReceiptLine[]) {
  const quantitiesByUom = new Map<string, number>();
  let grandTotal = 0;
  for (const line of lines) {
    const uom = line.uom.trim().toUpperCase() || "UNIT";
    quantitiesByUom.set(uom, (quantitiesByUom.get(uom) ?? 0) + line.quantity);
    grandTotal += line.total;
  }
  return {
    lineCount: lines.length,
    quantitiesByUom: [...quantitiesByUom.entries()].map(([uom, quantity]) => ({ uom, quantity })),
    grandTotal,
  };
}

function normalizedActionLabel(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[‘’]/g, "'")
    .replace(/\bthat's\b/g, "that is")
    .replace(/\bthis's\b/g, "this is")
    .replace(/\bisn't\b/g, "is not")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function isConversationUiAction(value: string) {
  return actionLabels.has(normalizedActionLabel(value));
}

// What jsPDF's Helvetica can draw: WinAnsi, i.e. Latin-1 plus the cp1252 extras below. Any other character garbles the whole line.
const notWinAnsi = /[^\n\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/gu;
const emoji = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/u.source;

export function conversationPdfText(value: string) {
  return value
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/[‘’]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[\u02DA\u030A]/g, "°")
    // No PDF font has emoji (the greeting's 👋, a voice note's 🎤). Between two sentences one becomes a full stop.
    .replace(new RegExp(`([\\p{L}\\p{N}]) ${emoji}(?= \\p{Lu})`, "gu"), "$1.")
    .replace(new RegExp(` ?${emoji}`, "gu"), "")
    // Per character, not NFKC on the whole text: that turned "45ml-1½oz" into "45ml-11⁄2oz" (r8 F4). Only a character
    // Helvetica can't draw takes its NFKC form, and only when that one fits (℃ → °C, Ⅱ → II, "：" → ":").
    .normalize("NFC")
    .replace(notWinAnsi, (char) => (char.normalize("NFKC").match(notWinAnsi) ? char : char.normalize("NFKC")))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\uFE0F]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** True when Helvetica can't draw the text (Chinese, ≤): the PDF then draws that message as a picture. */
export function needsUnicodePdfRendering(value: string) {
  return value.match(notWinAnsi) !== null; // match, not test: the regex is /g
}

/** Receipt text, which has no picture fallback: a character Helvetica can't draw becomes "?" instead of garbling the line. */
export function receiptPdfText(value: string) {
  return conversationPdfText(value).replace(notWinAnsi, "?");
}

export function wrapMeasuredText(
  value: string,
  maxWidth: number,
  measure: (text: string) => number,
) {
  if (!(maxWidth > 0)) return [value];

  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let line = "";
    const tokens = paragraph.match(/\s+|[^\s]+/gu) ?? [];
    for (const token of tokens) {
      const candidate = line + token;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line.trimEnd()) {
        lines.push(line.trimEnd());
        line = "";
      }

      if (/^\s+$/u.test(token)) continue;
      if (measure(token) <= maxWidth) {
        line = token;
        continue;
      }

      let fragment = "";
      for (const character of Array.from(token)) {
        if (fragment && measure(fragment + character) > maxWidth) {
          lines.push(fragment);
          fragment = character;
        } else {
          fragment += character;
        }
      }
      line = fragment;
    }

    if (line.trimEnd()) lines.push(line.trimEnd());
  }

  return lines.length > 0 ? lines : [""];
}
