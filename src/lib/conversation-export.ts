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

export function conversationPdfText(value: string) {
  return value
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function needsUnicodePdfRendering(value: string) {
  return /[^\x20-\x7E\n]/.test(value);
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
