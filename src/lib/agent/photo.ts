// src/lib/agent/photo.ts
// The chat screen's photo picker (agent-chat.tsx). A large photo is shrunk in the browser so the request fits under Vercel's
// 4.5 MB body limit (owner, 2 Oct: a phone screenshot got a 413 before Claire saw it). Claude sees at most 1,400 px / 1 MP anyway.
import type { ImageAttachment } from "@/lib/chat-contract";

/** The longest side sent: above the 1,400 px the server gives Claude, so nothing Claude sees is lost. */
export const PHOTO_EDGE = 1600;
/** Smaller files go as they are, keeping a saved store photo's exact catalogue match. */
export const SEND_AS_IS_BYTES = 1_000_000;
/** If shrinking fails, a file up to this size still goes as it is (3 MB sent fine live; 4.2 MB got a 413). */
export const AS_IS_FALLBACK_BYTES = 3_000_000;
/** The largest photo the picker takes; anything over SEND_AS_IS_BYTES is shrunk first. */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
/** The saved chat's copy of a photo (saved-chat.ts): small enough that a tab's storage holds a long chat. */
export const THUMB_EDGE = 320;

/** The size a photo is shrunk to: at most `edge` (PHOTO_EDGE) on its longest side, never enlarged. */
export function shrunkSize(width: number, height: number, edge = PHOTO_EDGE) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const readAsIs = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("PHOTO_UNREADABLE")));
  reader.onerror = () => reject(new Error("PHOTO_UNREADABLE"));
  reader.readAsDataURL(file);
});

/** A JPEG of the image at `src`, at most `edge` px on its longest side. Also draws the photo into the enquiry PDF. */
export async function jpegOf(src: string, edge = PHOTO_EDGE, quality = 0.85) {
  // onload rather than decode(): the safer choice on older WebKit. drawImage follows EXIF orientation (Chrome 81+, iOS 13.4+).
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("PHOTO_UNREADABLE")); img.src = src; });
  const { width, height } = shrunkSize(img.naturalWidth, img.naturalHeight, edge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PHOTO_UNREADABLE");
  context.fillStyle = "#ffffff"; // a transparent PNG would otherwise turn black as a JPEG
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = "high";
  context.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function shrink(file: File, edge = PHOTO_EDGE, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    return await jpegOf(url, edge, quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The photo as the chat sends it: as it is when small, otherwise a JPEG of at most PHOTO_EDGE px. */
export async function photoAttachment(file: File): Promise<ImageAttachment> {
  const name = file.name.slice(0, 160); // the request schema caps the name at 160; a longer one got a 400 on every resend
  const asIs = async () => ({ dataUrl: await readAsIs(file), mimeType: file.type as ImageAttachment["mimeType"], name });
  if (file.size <= SEND_AS_IS_BYTES) return asIs();
  try {
    return { dataUrl: await shrink(file), mimeType: "image/jpeg", name };
  } catch (error) {
    // No photo that sends today gets worse: up to 3 MB it still goes as it is.
    if (file.size > AS_IS_FALLBACK_BYTES) throw error;
    return asIs();
  }
}

/** A small JPEG of the photo for the chat's saved copy, or undefined when it can't be drawn (the copy then shows a placeholder). */
export const photoThumbnail = (file: File) => shrink(file, THUMB_EDGE, 0.7).catch(() => undefined);
