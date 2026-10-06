// src/lib/agent/saved-chat.ts
// The chat screen's copy of the chat in the browser tab (agent-chat.tsx), so a refresh keeps the messages and the enquiry
// (stress test F1, 3 Oct: a refresh wiped a 1-item, $82.50 enquiry). sessionStorage: it lasts as long as the tab, each tab keeps
// its own chat, and nothing is left behind on a shared computer once the tab is closed.
import { z } from "zod";
import { productSchema, type Product } from "@/lib/chat-contract";
import { agentReplySchema, type AgentReply } from "./contract";

export const chatItemSchema = z.object({
  id: z.number().int(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  time: z.string(),
  cards: z.array(productSchema).optional(),
  chips: z.array(z.string()).optional(),
  showContact: z.boolean().optional(),
  // Only a photo's own data URL (or the saved copy's thumbnail), never a link: it goes straight into an <img>.
  imageUrl: z.string().regex(/^data:image\//).optional(),
  /** The small copy of the photo that the saved chat keeps instead of imageUrl. */
  thumbUrl: z.string().regex(/^data:image\//).optional(),
  tap: z.boolean().optional(),
  chip: z.boolean().optional(),
  /** false hides the contact block's PDF link and the "Tap a product" line (exam 3: both judged templated). */
  pdf: z.boolean().optional(),
  pickHint: z.boolean().optional(),
  /** What Claude reads in the history instead of text (a failed photo's line). */
  historyText: z.string().optional(),
});
export type ChatItem = z.infer<typeof chatItemSchema>;

export const SAVED_CHAT_KEY = "siahuat-claire-chat";
/** An older copy starts a fresh chat: its prices and stock are too old to show as they were. */
export const SAVED_CHAT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Stands in for a photo the saved copy couldn't keep (no thumbnail, or the tab's storage was full). */
export const PHOTO_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='96'%3E%3Crect width='320' height='96' fill='%23f3f3f0'/%3E%3Ctext x='160' y='53' text-anchor='middle' font-family='sans-serif' font-size='14' fill='%23667a74'%3EPhoto sent%3C/text%3E%3C/svg%3E";

const savedChatSchema = z.object({
  v: z.literal(1),
  savedAt: z.number(),
  sessionId: z.string().min(8).max(120),
  items: z.array(chatItemSchema).min(1),
  enquiry: agentReplySchema.shape.enquiry,
  shownIds: z.array(z.string()).max(100),
});

/** The parts of the chat screen's state a refresh brings back. */
export type ChatSnapshot = { sessionId: string; items: ChatItem[]; enquiry: AgentReply["enquiry"]; shownIds: string[] };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// A card keeps what the chat, the history note and the PDF show; descriptions would only fill the storage.
const slimCard = ({ stock_id, name, status, list_price, uom_id, source_url, stock_status }: Product): Product => ({ stock_id, name, status, list_price, uom_id, source_url, stock_status });

/** Saves the chat, or clears the saved copy once there's nothing to bring back (a new chat). Never throws. */
export function saveChat(store: Store | null, chat: ChatSnapshot, now: number) {
  if (!store) return;
  try {
    if (!chat.items.some((item) => item.role === "user")) return store.removeItem(SAVED_CHAT_KEY);
    const items = chat.items.map(({ imageUrl, thumbUrl, cards, ...item }) => ({
      ...item,
      ...(imageUrl ? { imageUrl: thumbUrl ?? PHOTO_PLACEHOLDER } : {}),
      ...(cards ? { cards: cards.map(slimCard) } : {}),
    }));
    const saved = { v: 1, savedAt: now, sessionId: chat.sessionId, items, enquiry: chat.enquiry, shownIds: chat.shownIds.slice(-100) };
    try {
      store.setItem(SAVED_CHAT_KEY, JSON.stringify(saved));
    } catch {
      // Storage full: the thumbnails go first.
      store.setItem(SAVED_CHAT_KEY, JSON.stringify({ ...saved, items: items.map((item) => (item.imageUrl ? { ...item, imageUrl: PHOTO_PLACEHOLDER } : item)) }));
    }
  } catch {
    try { store.removeItem(SAVED_CHAT_KEY); } catch { /* storage blocked: nothing was saved */ }
  }
}

/**
 * The saved chat, or null (none, unreadable, or older than SAVED_CHAT_MAX_AGE_MS). When the page was reloaded while Claire was
 * replying, the chat ends with the customer's message: `unanswered` is that message and `draft` its typed words to send again.
 */
export function readSavedChat(store: Store | null, now: number): (ChatSnapshot & { nextId: number; unanswered: ChatItem | null; draft: string }) | null {
  if (!store) return null;
  try {
    const raw = store.getItem(SAVED_CHAT_KEY);
    if (!raw) return null;
    const saved = savedChatSchema.safeParse(JSON.parse(raw));
    if (!saved.success || !(now - saved.data.savedAt <= SAVED_CHAT_MAX_AGE_MS)) {
      store.removeItem(SAVED_CHAT_KEY);
      return null;
    }
    // A restored photo shows its thumbnail and keeps it for the next save.
    const items = saved.data.items.map((item) => (item.imageUrl ? { ...item, thumbUrl: item.imageUrl } : item));
    const last = items.at(-1)!;
    const unanswered = last.role === "user" ? last : null;
    const draft = unanswered && !unanswered.tap && !unanswered.chip && !unanswered.imageUrl ? unanswered.text.replace(/^🎤 /u, "") : "";
    return { sessionId: saved.data.sessionId, items, enquiry: saved.data.enquiry, shownIds: saved.data.shownIds, nextId: Math.max(...items.map((item) => item.id)) + 1, unanswered, draft };
  } catch {
    return null;
  }
}
