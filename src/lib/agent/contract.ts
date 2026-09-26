// src/lib/agent/contract.ts
import { z } from "zod";
import { imageAttachmentSchema, productSchema } from "@/lib/chat-contract";
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
  enquiry: z.array(enquiryEchoLineSchema).max(200).default([]),
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
