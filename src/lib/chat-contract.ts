import { z } from "zod";

export const chatStageSchema = z.enum([
  "discover",
  "clarify",
  "quantity",
  "complete",
  "submitted",
]);

export const productSchema = z.object({
  stock_id: z.string(),
  name: z.string(),
  brand_id: z.string().nullable().optional(),
  status: z.string(),
  list_price: z.coerce.number(),
  uom_id: z.string(),
  source_url: z.string().url().nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  description: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  in_stock: z.boolean().nullable().optional(),
  available_quantity: z.coerce.number().nullable().optional(),
  stock_status: z.enum(["in_stock", "out_of_stock", "unknown"]).nullable().optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  third_category: z.string().nullable().optional(),
  last_scraped_at: z.string().nullable().optional(),
});

export const historyItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2_000),
});

export const imageAttachmentSchema = z.object({
  dataUrl: z
    .string()
    .max(7_500_000)
    .regex(/^data:image\/(?:jpeg|png|webp);base64,/),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  name: z.string().trim().min(1).max(160),
});

export const chatRequestSchema = z.object({
  sessionId: z.string().trim().min(8).max(120),
  message: z.string().trim().min(1).max(500),
  history: z.array(historyItemSchema).max(30).default([]),
  image: imageAttachmentSchema.optional(),
  brain: z.literal("n8n").optional(),
});

export const chatReplySchema = z.object({
  message: z.string(),
  stage: chatStageSchema,
  products: z.array(productSchema).default([]),
  selectedProduct: productSchema.nullable().default(null),
  suggestions: z.array(z.string()).default([]),
});

export type ChatStage = z.infer<typeof chatStageSchema>;
export type Product = z.infer<typeof productSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatReply = z.infer<typeof chatReplySchema>;
