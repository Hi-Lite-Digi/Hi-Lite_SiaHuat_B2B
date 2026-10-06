// src/lib/enquiry-pdf.ts
import type { Product } from "@/lib/chat-contract";
import { jpegOf } from "@/lib/agent/photo";
import {
  conversationPdfText,
  enquiryReceiptTotals,
  needsUnicodePdfRendering,
  receiptPdfText,
  wrapMeasuredText,
  type EnquiryReceiptLine,
} from "@/lib/conversation-export";

export type PdfTranscriptItem = {
  role: "user" | "assistant";
  time: string;
  text: string;
  cards?: Product[];
  /** The customer's photo (the chat's data URL), drawn where it was sent so sales see it (r8 F3). */
  imageUrl?: string;
};

/** The photo's longest side in the PDF, and the most room it takes on the page. */
const PHOTO_EDGE_PX = 1200;
const PHOTO_MAX_MM = { width: 120, height: 100 };

function stockLabel(product: Product) {
  if (product.stock_status === "in_stock") return "Website: in stock";
  if (product.stock_status === "out_of_stock") return "Website: out of stock";
  return "Live check needed";
}

/** Builds and downloads the enquiry receipt + conversation transcript. Throws on failure. */
export async function downloadEnquiryPdf(input: { lines: EnquiryReceiptLine[]; transcript: PdfTranscriptItem[] }) {
  const { jsPDF } = await import("jspdf");
  await document.fonts.ready;
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const boxWidth = pageWidth - margin * 2;
  const textWidth = boxWidth - 10;
  const lineHeight = 4.8;
  let y = 18;

  const addHeader = (title: string) => {
    pdf.setTextColor(21, 54, 47);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(title, margin, y);
    y += 7;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.setTextColor(102, 122, 116);
    const generated = new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" }).format(new Date());
    pdf.text(`Generated ${generated} - Times shown in Singapore time`, margin, y);
    y += 5;
    pdf.setDrawColor(23, 104, 83);
    pdf.setLineWidth(0.6);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 8;
  };
  const addPage = () => {
    pdf.addPage();
    y = 18;
  };

  const totals = enquiryReceiptTotals(input.lines);
  addHeader("Sia Huat Enquiry Receipt");
  pdf.setFillColor(238, 247, 243);
  pdf.setDrawColor(188, 214, 204);
  pdf.rect(margin, y, boxWidth, 26, "FD");
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(10);
  pdf.setTextColor(21, 54, 47);
  pdf.text(`Confirmed line items: ${totals.lineCount}`, margin + 5, y + 7);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9.5);
  const quantitySummary = totals.quantitiesByUom.length ? totals.quantitiesByUom.map(({ quantity, uom }) => `${quantity} ${uom}`).join(" + ") : "0";
  pdf.text(`Total requested quantity: ${quantitySummary}`, margin + 5, y + 14);
  pdf.setFont("helvetica", "bold");
  pdf.text(`Grand total: $${totals.grandTotal.toFixed(2)} (ex GST)`, margin + 5, y + 21);
  y += 32;

  if (input.lines.length === 0) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(51, 75, 68);
    pdf.text("No items on the enquiry yet; the conversation below shows what was asked.", margin, y);
    y += 12;
  } else {
    input.lines.forEach((line, index) => {
      const detailLines = pdf.splitTextToSize(receiptPdfText([
        `${index + 1}. ${line.item}`,
        `Code: ${line.code}  |  Quantity: ${line.quantity} ${line.uom}`,
        `Unit price: $${line.pricePerItem.toFixed(2)} / ${line.uom}  |  Line total: $${line.total.toFixed(2)} (ex GST)`,
        ...(line.sourceUrl ? [line.sourceUrl] : []),
      ].join("\n")), textWidth) as string[];
      const itemHeight = 9 + detailLines.length * lineHeight;
      if (y + itemHeight > pageHeight - margin - 12) {
        addPage();
        addHeader("Sia Huat Enquiry Receipt (continued)");
      }
      pdf.setFillColor(247, 247, 245);
      pdf.setDrawColor(210, 220, 216);
      pdf.rect(margin, y, boxWidth, itemHeight, "FD");
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9.5);
      pdf.setTextColor(51, 75, 68);
      pdf.text(detailLines, margin + 5, y + 7, { lineHeightFactor: 1.25 });
      y += itemHeight + 4;
    });
  }
  if (y + 18 > pageHeight - margin) addPage();
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9.5);
  pdf.setTextColor(21, 54, 47);
  pdf.text("Status: Enquiry only - no purchase has been placed.", margin, y + 4);

  addPage();
  addHeader("Sia Huat Conversation Transcript");
  for (const item of input.transcript) {
    const cardText = (item.cards ?? []).map((card) => [
      card.name,
      `code: ${card.stock_id}`,
      // Same rule as the chat screen: a card whose live check failed shows no price.
      card.stock_status === "unknown" ? "Price to be confirmed" : `Price: $${Number(card.list_price).toFixed(2)} / ${card.uom_id}`,
      stockLabel(card),
      card.source_url ?? "",
    ].filter(Boolean).join("\n")).join("\n\n");
    // A photo that can't be drawn keeps the old line, so sales still know one was sent.
    const photo = item.imageUrl ? await jpegOf(item.imageUrl, PHOTO_EDGE_PX).catch(() => null) : null;
    const body = conversationPdfText([item.imageUrl && !photo ? "[Product photo attached]" : "", item.text, cardText].filter(Boolean).join("\n\n"));
    const needsCanvasText = needsUnicodePdfRendering(body);
    const canvasScale = 2;
    const pixelsPerMm = 96 / 25.4;
    const fontSizePixels = 9.5 * (96 / 72) * canvasScale;
    const fontStack = `${fontSizePixels}px "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Heiti SC", Arial, sans-serif`;
    const measureContext = needsCanvasText ? document.createElement("canvas").getContext("2d") : null;
    if (needsCanvasText && !measureContext) throw new Error("Unicode PDF renderer is unavailable.");
    if (measureContext) measureContext.font = fontStack;
    const lines = needsCanvasText && measureContext
      ? wrapMeasuredText(body, textWidth * pixelsPerMm * canvasScale, (value) => measureContext.measureText(value).width)
      : pdf.splitTextToSize(body, textWidth) as string[];
    // The photo goes in the message's first box, as large as PHOTO_MAX_MM allows.
    let photoWidth = 0;
    let photoHeight = 0;
    if (photo) {
      const { width, height } = pdf.getImageProperties(photo);
      const scale = Math.min(PHOTO_MAX_MM.width / width, PHOTO_MAX_MM.height / height);
      photoWidth = width * scale;
      photoHeight = height * scale + 3;
    }
    const label = `${item.role === "user" ? "You (customer)" : "Claire (assistant)"} - ${item.time}`;
    let lineIndex = 0;
    while (lineIndex < lines.length) {
      if (pageHeight - margin - y < 30 + photoHeight) addPage();
      const linesOnPage = Math.max(1, Math.floor((pageHeight - margin - y - 15 - photoHeight) / lineHeight));
      const chunk = lines.slice(lineIndex, lineIndex + linesOnPage);
      const boxHeight = 15 + photoHeight + chunk.length * lineHeight;
      pdf.setFillColor(item.role === "user" ? 223 : 247, item.role === "user" ? 243 : 247, item.role === "user" ? 233 : 245);
      pdf.setDrawColor(210, 220, 216);
      pdf.rect(margin, y, boxWidth, boxHeight, "FD");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.setTextColor(23, 104, 83);
      pdf.text(lineIndex === 0 ? label : `${label} (continued)`, margin + 5, y + 6);
      if (photo && photoHeight) pdf.addImage(photo, "JPEG", margin + 5, y + 9, photoWidth, photoHeight - 3);
      if (needsCanvasText) {
        const lineHeightPixels = lineHeight * pixelsPerMm * canvasScale;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(textWidth * pixelsPerMm * canvasScale));
        canvas.height = Math.max(1, Math.ceil(chunk.length * lineHeightPixels));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Unicode PDF renderer is unavailable.");
        context.font = fontStack;
        context.fillStyle = "#334b44";
        context.textBaseline = "alphabetic";
        chunk.forEach((line, index) => {
          context.fillText(line, 0, (index + 1) * lineHeightPixels - (lineHeightPixels - fontSizePixels) * 0.45);
        });
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", margin + 5, y + 9 + photoHeight, textWidth, chunk.length * lineHeight);
      } else {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9.5);
        pdf.setTextColor(51, 75, 68);
        // lineHeight apart, as the box heights assume and the picture path draws (1.25 left a gap under long card lists).
        pdf.text(chunk, margin + 5, y + 12 + photoHeight, { lineHeightFactor: lineHeight / (9.5 * 25.4 / 72) });
      }
      y += boxHeight + 5;
      lineIndex += chunk.length;
      photoHeight = 0;
      if (lineIndex < lines.length) addPage();
    }
  }

  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(120, 135, 130);
    pdf.text(`Page ${page} of ${pageCount}`, pageWidth / 2, pageHeight - 8, { align: "center" });
  }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(new Date());
  const blob = pdf.output("blob");
  if (blob.size === 0) throw new Error("Generated PDF was empty.");
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `sia-huat-enquiry-${date}.pdf`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
}
