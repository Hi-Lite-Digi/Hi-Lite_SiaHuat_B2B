// src/lib/agent/contract.ts
import { z } from "zod";
import { imageAttachmentSchema, productSchema, type Product } from "@/lib/chat-contract";
import { enquiryReceiptTotals } from "@/lib/conversation-export";

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(500), voice: z.boolean().optional(), chip: z.boolean().optional() }),
  z.object({ type: z.literal("select_product"), stockId: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal("image"), image: imageAttachmentSchema, caption: z.string().trim().max(500).optional() }),
]);

export const enquiryEchoLineSchema = z.object({
  stockId: z.string().trim().min(1).max(100),
  quantity: z.number().int().min(1).max(100_000),
});

export const agentRequestSchema = z.object({
  sessionId: z.string().trim().min(8).max(120),
  event: agentEventSchema,
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2_000),
  })).max(30).default([]),
  enquiry: z.array(enquiryEchoLineSchema).max(60).default([]),
  shownProductIds: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});

export const enquiryLineSchema = z.object({
  item: z.string(),
  code: z.string(),
  pricePerItem: z.number(),
  quantity: z.number(),
  total: z.number(),
  uom: z.string(),
  sourceUrl: z.string().nullable().optional(),
});

export const agentReplySchema = z.object({
  message: z.string(),
  cards: z.array(productSchema).max(5),
  chips: z.array(z.string()).max(3),
  enquiry: z.object({
    lines: z.array(enquiryLineSchema),
    totals: z.object({
      lineCount: z.number(),
      quantitiesByUom: z.array(z.object({ uom: z.string(), quantity: z.number() })),
      grandTotal: z.number(),
    }),
    /** Codes the server could not re-check this turn: the browser keeps its own copy of those lines. */
    unchecked: z.array(z.string()).optional(),
  }),
  showContact: z.boolean(),
  provider: z.enum(["anthropic", "fallback"]),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentReply = z.infer<typeof agentReplySchema>;

/** The browser's enquiry after a reply: the reply's lines plus its own copy of any line the server could not re-check. */
export function nextEnquiry(current: AgentReply["enquiry"], reply: AgentReply["enquiry"]): AgentReply["enquiry"] {
  const unchecked = new Set(reply.unchecked?.map((code) => code.toLowerCase()));
  const kept = current.lines.filter((line) => unchecked.has(line.code.toLowerCase()));
  if (!kept.length) return reply;
  const lines = [...reply.lines, ...kept];
  const totals = enquiryReceiptTotals(lines);
  return { lines, totals: { ...totals, grandTotal: Math.round(totals.grandTotal * 100) / 100 } };
}

/** How the browser marks a card tap, a chip tap and a photo (with its caption, or NO_CAPTION) in the chat history. */
export const TAP_PREFIX = "[tap]";
export const CHIP_PREFIX = "[chip]";
export const PHOTO_PREFIX = "[photo]";
export const NO_CAPTION = "(no caption)";

/** The words a customer history entry carries: the text, or a photo's caption. A photo sent without a caption has none. */
export function customerWords(content: string) {
  const text = content.startsWith(PHOTO_PREFIX) ? content.slice(PHOTO_PREFIX.length).trim() : content;
  return text && text !== NO_CAPTION ? text : null;
}

/** A product card as noted in the chat history. price is null when the card showed no checked price. */
export type ShownCard = { code: string; name: string; price: number | null; link: string | null };

const CARDS_NOTE = "[cards shown: ";

/** The note on Claire's history entries: "[cards shown: CODE name ($12.34) <link>; …]". An unchecked card carries no price. */
export function cardsNote(cards: Product[]) {
  if (!cards.length) return "";
  const entry = (card: Product) => `${card.stock_id} ${card.name.replace(/;\s*/g, ", ")}${card.stock_status === "unknown" ? "" : ` ($${Number(card.list_price).toFixed(2)})`}${card.source_url ? ` <${card.source_url}>` : ""}`;
  return `\n${CARDS_NOTE}${cards.map(entry).join("; ")}]`;
}

/** The cards noted on an assistant history entry. Older notes ("CODE name" or just "CODE") read with no price or link. */
export function parseCardsNote(content: string): ShownCard[] {
  const start = content.lastIndexOf(CARDS_NOTE);
  if (start < 0) return [];
  return content.slice(start + CARDS_NOTE.length).replace(/\]\s*$/, "").split("; ").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const link = entry.match(/\s<(https?:\/\/[^\s>]+)>$/);
    let rest = link ? entry.slice(0, link.index) : entry;
    const price = rest.match(/\s\(\$(\d+(?:\.\d{1,2})?)\)$/);
    if (price) rest = rest.slice(0, price.index);
    const space = rest.indexOf(" ");
    return { code: space < 0 ? rest : rest.slice(0, space), name: space < 0 ? "" : rest.slice(space + 1), price: price ? Number(price[1]) : null, link: link?.[1] ?? null };
  });
}

/** An assistant history entry's message without its cards note. */
export function withoutCardsNote(content: string) {
  const start = content.lastIndexOf(CARDS_NOTE);
  return (start < 0 ? content : content.slice(0, start)).trim();
}
