// src/components/agent-chat.tsx
"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ExternalLink, FileDown, ImagePlus, LoaderCircle, Mic, Send, Square, SquarePen, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import { SALES_CONTACT } from "@/lib/agent/contact";
import { agentReplySchema, cardsToPick, historyFor, nextEnquiry, type AgentEvent, type AgentReply } from "@/lib/agent/contract";
import { abortAfter, isNewChatCommand, newChatWarning } from "@/lib/agent/new-chat";
import { MAX_PHOTO_BYTES, photoAttachment } from "@/lib/agent/photo";
import { downloadEnquiryPdf } from "@/lib/enquiry-pdf";

type ChatItem = {
  id: number;
  role: "user" | "assistant";
  text: string;
  time: string;
  cards?: Product[];
  chips?: string[];
  showContact?: boolean;
  imageUrl?: string;
  tap?: boolean;
  chip?: boolean;
  /** false hides the contact block's PDF link and the "Tap a product" line (exam 3: both judged templated). */
  pdf?: boolean;
  pickHint?: boolean;
  /** What Claude reads in the history instead of text (a failed photo's line). */
  historyText?: string;
};

const GREETING = "Hi, I'm Claire from Sia Huat 👋 What are you looking for today? You can send me a photo too.";
const NEW_CHAT_GREETING = "New chat started. What are you looking for today? You can send me a photo too.";
const EMPTY_ENQUIRY: AgentReply["enquiry"] = { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const timeLabel = () => new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" }).format(new Date());
const newSessionId = () => `agent-${crypto.randomUUID()}`;

function stockLabel(card: Product) {
  if (card.stock_status === "in_stock") return "Website: in stock";
  if (card.stock_status === "out_of_stock") return "Website: out of stock";
  return "Stock unconfirmed";
}

export function AgentChat() {
  const [items, setItems] = useState<ChatItem[]>([{ id: 1, role: "assistant", text: GREETING, time: timeLabel() }]);
  const [enquiry, setEnquiry] = useState<AgentReply["enquiry"]>(EMPTY_ENQUIRY);
  const [query, setQuery] = useState("");
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const itemsRef = useRef(items);
  const enquiryRef = useRef(enquiry);
  const loadingRef = useRef(false);
  const sessionId = useRef(newSessionId());
  // Aborted by New chat: the old chat's reply and voice-note transcription stop (the server then stops its Claude calls).
  const chatAbort = useRef(new AbortController());
  const nextId = useRef(2);
  const shownIds = useRef(new Set<string>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newChatRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { enquiryRef.current = enquiry; }, [enquiry]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [items, loading]);

  const latestAssistantId = [...items].reverse().find((item) => item.role === "assistant")?.id;
  const resetWarning = newChatWarning(items.some((item) => item.role === "user"), enquiry.totals);

  async function send(event: AgentEvent, bubble: Omit<ChatItem, "id" | "role" | "time">) {
    if (loadingRef.current) {
      setNotice("Please wait for my reply, then send that again.");
      return;
    }
    const session = sessionId.current;
    const history = historyFor(itemsRef.current);
    setItems((current) => [...current, { id: nextId.current++, role: "user", time: timeLabel(), ...bubble }]);
    loadingRef.current = true;
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session,
          event,
          history,
          enquiry: enquiryRef.current.lines.map((line) => ({ stockId: line.code, quantity: line.quantity })),
          shownProductIds: [...shownIds.current].slice(-100),
        }),
        signal: abortAfter(50_000, chatAbort.current.signal),
      });
      const json: unknown = await response.json().catch(() => null);
      if (sessionId.current !== session) return;
      if (!response.ok) throw new Error("REQUEST_FAILED");
      const reply = agentReplySchema.parse(json);
      reply.cards.forEach((card) => shownIds.current.add(card.stock_id));
      const next = nextEnquiry(enquiryRef.current, reply.enquiry);
      setEnquiry(next);
      setItems((current) => [...current, {
        id: nextId.current++, role: "assistant", time: timeLabel(),
        text: reply.message, cards: reply.cards, chips: reply.chips, showContact: reply.showContact,
        // The PDF link once the enquiry has lines or Claire's words point to it (78 of 124 contact blocks came before any add);
        // "Tap a product" only while a card isn't on the enquiry, not under "Got it: 2 ... added".
        pdf: next.lines.length > 0 || /\bPDF\b/i.test(reply.message), pickHint: cardsToPick(reply.cards, next.lines),
      }]);
    } catch {
      if (sessionId.current !== session) return;
      // A photo that didn't get through gets its own line (owner, 2 Oct). Claire reads it as a plain statement, not a question,
      // so the PHOTO_AGAIN guard can't stop her own resend ask next turn, and user and assistant turns keep alternating.
      const photo = event.type === "image";
      setItems((current) => [...current, {
        id: nextId.current++, role: "assistant", time: timeLabel(), showContact: true, pdf: enquiryRef.current.lines.length > 0,
        // No error tone (owner, 2026-09-30: a reply that gives up looks like a broken system): ask for a resend; the contact block shows below.
        text: photo
          ? "Sorry, that photo didn't come through. Could you send it again? Sia Huat sales can also help (details below)."
          : "Sorry, my reply didn't come through. Could you send that again? Sia Huat sales can also help (details below).",
        ...(photo ? { historyText: "That photo didn't come through on my side." } : {}),
      }]);
    } finally {
      if (sessionId.current === session) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = query.trim().slice(0, 500);
    if (attachment) {
      const image = attachment;
      setAttachment(null);
      setQuery("");
      void send({ type: "image", image, ...(text ? { caption: text } : {}) }, { text, imageUrl: image.dataUrl });
      return;
    }
    if (!text) return;
    setQuery("");
    // "start over", "reset", "new chat" typed on their own do what the New chat button does, asking first when there's anything to lose.
    if (isNewChatCommand(text)) return resetWarning ? setConfirmingReset(true) : reset();
    void send({ type: "text", text }, { text });
  }

  function pickCard(card: Product) {
    void send({ type: "select_product", stockId: card.stock_id }, { text: `Picked: ${card.name} (code ${card.stock_id})`, tap: true });
  }

  function acceptImage(file: File | undefined | null) {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) return setNotice("Please use a JPG, PNG or WebP photo.");
    if (file.size > MAX_PHOTO_BYTES) return setNotice("Please use a photo under 15 MB.");
    const session = sessionId.current;
    void photoAttachment(file).then(
      (image) => { if (sessionId.current === session) setAttachment(image); },
      () => { if (sessionId.current === session) setNotice("That photo couldn't be opened. Please try another one."); },
    );
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const file = [...event.clipboardData.items].find((entry) => entry.kind === "file" && entry.type.startsWith("image/"))?.getAsFile();
    if (file) {
      event.preventDefault();
      acceptImage(file);
    }
  }

  async function toggleRecording() {
    if (recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The note belongs to the chat it was recorded in: after New chat it is dropped, not sent into the new chat.
      const session = sessionId.current;
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (recorderRef.current === recorder) recorderRef.current = null;
        if (sessionId.current !== session) return;
        setRecording(false);
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (audio.size === 0 || audio.size > 4 * 1024 * 1024) return setNotice("That voice note couldn't be used. Please type your message.");
        const extension = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
        const form = new FormData();
        form.append("audio", audio, `voice-note.${extension}`);
        form.append("sessionId", session);
        setTranscribing(true);
        try {
          const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: abortAfter(40_000, chatAbort.current.signal) });
          const body = await response.json().catch(() => null) as { transcript?: string } | null;
          const transcript = body?.transcript?.trim().slice(0, 500) ?? "";
          if (sessionId.current !== session) return;
          if (!response.ok || !transcript) throw new Error("VOICE_FAILED");
          await send({ type: "text", text: transcript, voice: true }, { text: `🎤 ${transcript}` });
        } catch {
          if (sessionId.current === session) setNotice("That voice note couldn't be transcribed. Please type your message.");
        } finally {
          if (sessionId.current === session) setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      window.setTimeout(() => { if (recorderRef.current === recorder) recorder.stop(); }, 60_000);
    } catch {
      setNotice("Microphone access is needed for voice notes.");
    }
  }

  async function savePdf() {
    try {
      await downloadEnquiryPdf({
        lines: enquiryRef.current.lines,
        transcript: itemsRef.current.map((item) => ({ role: item.role, time: item.time, text: item.text, cards: item.cards, image: Boolean(item.imageUrl) })),
      });
    } catch {
      setNotice("The PDF could not be downloaded. Please try again.");
    }
  }

  function askReset() {
    if (!resetWarning) return reset();
    setConfirmingReset((open) => !open);
  }

  function reset() {
    setConfirmingReset(false);
    sessionId.current = newSessionId(); // before the aborts, so the old handlers see a new chat and stay quiet
    chatAbort.current.abort();
    chatAbort.current = new AbortController();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") recorder.stop(); // its onstop turns the mic off and drops the note
    setRecording(false);
    setTranscribing(false);
    shownIds.current = new Set();
    loadingRef.current = false;
    setLoading(false);
    setEnquiry(EMPTY_ENQUIRY);
    setAttachment(null);
    setQuery("");
    setNotice("");
    setShowLines(false);
    setItems([{ id: nextId.current++, role: "assistant", text: NEW_CHAT_GREETING, time: timeLabel() }]);
    // With a mouse, back to the message box; on a phone that would pop the keyboard up, so back to New chat instead
    // (the confirm bar's buttons are gone, and focus would otherwise fall to the top of the page).
    window.setTimeout(() => { (window.matchMedia("(pointer: fine)").matches ? inputRef : newChatRef).current?.focus(); }, 0);
  }

  return <div className="flex h-[min(860px,calc(100dvh-2rem))] w-full max-w-[460px] flex-col overflow-hidden rounded-[2rem] border-8 border-[#15362f] bg-[#f7f4ec] shadow-2xl">
    <header className="flex items-center gap-3 bg-[#176853] px-4 py-4 text-white">
      <div className="grid size-10 shrink-0 place-items-center rounded-full bg-[#efad3f] text-sm font-bold text-[#15362f]">C</div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold sm:text-base">Claire · Sia Huat</h2>
        <p className="flex items-center gap-1.5 text-xs text-white/75"><span className="size-2 shrink-0 rounded-full bg-[#efad3f]" /> AI assistant</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button aria-label="Download enquiry PDF" variant="ghost" className="h-11 min-w-11 flex-col gap-0.5 rounded-xl px-1.5 text-white hover:bg-white/10 hover:text-white" onClick={() => void savePdf()}><FileDown className="size-4" /><span className="text-[10px] font-semibold leading-3">PDF</span></Button>
        <Button ref={newChatRef} aria-expanded={confirmingReset} variant="ghost" className="h-11 min-w-11 flex-col gap-0.5 rounded-xl px-1.5 text-white hover:bg-white/10 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white" onClick={askReset}><SquarePen className="size-4" /><span className="text-[10px] font-semibold leading-3">New chat</span></Button>
      </div>
    </header>
    {confirmingReset && resetWarning && <div id="new-chat-confirm" role="group" aria-labelledby="new-chat-title" className="border-b border-[#15362f]/10 bg-white px-4 py-3 text-xs text-[#15362f]">
      <p id="new-chat-title" className="text-sm font-semibold">Start a new chat?</p>
      <p className="mt-0.5 leading-5 text-[#334b44]">{resetWarning}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => { setConfirmingReset(false); newChatRef.current?.focus(); }} className="h-10 rounded-full border border-[#176853]/30 px-4 text-xs font-semibold text-[#176853] hover:bg-[#eef7f3]">Cancel</Button>
        <Button type="button" onClick={reset} className="h-10 rounded-full bg-[#176853] px-4 text-xs font-semibold text-white hover:bg-[#125441]">Start new chat</Button>
      </div>
    </div>}

    <div className="chat-transcript flex-1 space-y-4 overflow-y-auto p-3 sm:p-4">
      {items.map((item) => <div key={item.id} className={`min-w-0 ${item.role === "user" ? "ml-auto max-w-[85%]" : "max-w-[94%]"}`}>
        <div className={`chat-message min-w-0 overflow-hidden rounded-2xl p-3 text-sm shadow-sm ${item.role === "user" ? "rounded-tr-sm bg-[#dff3e9]" : "rounded-tl-sm bg-white"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {item.imageUrl && <img src={item.imageUrl} alt="Your product photo" className="mb-2 max-h-48 w-full rounded-xl object-contain" />}
          {item.text && <p className="whitespace-pre-wrap leading-6 text-[#334b44]">{item.text}</p>}
          {item.cards?.length ? <div className="mt-3 space-y-2">
            {item.cards.map((card, index) => <div key={card.stock_id} className="rounded-xl bg-[#f5f1e8] p-3">
              <button type="button" data-card-index={index + 1} disabled={loading || card.stock_status === "out_of_stock"} onClick={() => pickCard(card)} className="block w-full text-left disabled:opacity-70">
                <p className="break-words font-semibold leading-5">{card.name}</p>
                <p className="mt-1 text-xs text-[#667a74]">code: {card.stock_id}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <p className="text-xs text-[#667a74]">{card.stock_status === "unknown" ? "Price to be confirmed" : `Price: $${Number(card.list_price).toFixed(2)} / ${card.uom_id}`}</p>
                  <Badge className={card.stock_status === "out_of_stock" ? "bg-[#a94732]" : "bg-[#176853]"}>{stockLabel(card)}</Badge>
                </div>
              </button>
              {card.source_url && <a href={card.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-[11px] font-semibold text-[#176853]">{card.source_url} <ExternalLink className="size-3 shrink-0" /></a>}
            </div>)}
            {item.pickHint !== false && <p className="text-xs font-medium text-[#176853]">Tap a product to choose it.</p>}
          </div> : null}
          {item.showContact && <div className="mt-3 rounded-xl border border-[#176853]/20 bg-[#eef7f3] p-3 text-xs text-[#15362f]">
            <p className="font-semibold">Sia Huat sales</p>
            <p>{SALES_CONTACT.phone} · {SALES_CONTACT.email}</p>
            {item.pdf !== false && <button type="button" onClick={() => void savePdf()} className="mt-2 font-semibold text-[#176853] underline">Download your enquiry PDF to send along</button>}
          </div>}
          <p className={`mt-2 text-[10px] text-[#667a74]/80 ${item.role === "user" ? "text-right" : ""}`}>{item.role === "user" ? "Sent" : "Received"} · {item.time}</p>
        </div>
        {item.role === "assistant" && item.id === latestAssistantId && item.chips?.length ? <div className="mt-2 flex flex-wrap gap-2">
          {item.chips.map((chip) => <button key={chip} type="button" disabled={loading} onClick={() => void send({ type: "text", text: chip, chip: true }, { text: chip, chip: true })} className="rounded-full border border-[#176853]/30 bg-white px-3 py-1.5 text-xs font-semibold text-[#176853] hover:bg-[#eef7f3] disabled:opacity-50">{chip}</button>)}
        </div> : null}
      </div>)}
      {loading && <div aria-label="Sia Huat is typing" aria-live="polite" className="flex w-fit items-center gap-1.5 rounded-2xl bg-white px-4 py-3 shadow-sm"><i className="typing-dot" /><i className="typing-dot" /><i className="typing-dot" /></div>}
      <div ref={endRef} />
    </div>

    {enquiry.lines.length > 0 && <div className="border-t border-[#15362f]/10 bg-[#eef7f3] px-3 py-2 text-xs text-[#15362f]">
      <button type="button" onClick={() => setShowLines((open) => !open)} className="flex w-full items-center justify-between font-semibold">
        <span>Your enquiry: {enquiry.totals.lineCount} item{enquiry.totals.lineCount === 1 ? "" : "s"} · ${enquiry.totals.grandTotal.toFixed(2)}</span>
        <span>{showLines ? "Hide" : "View"}</span>
      </button>
      {showLines && <ul className="mt-2 space-y-1">
        {enquiry.lines.map((line) => <li key={line.code}>{line.quantity} {line.uom} × {line.item} ({line.code}) = ${line.total.toFixed(2)}</li>)}
      </ul>}
    </div>}

    <div className="border-t border-[#15362f]/10 bg-white p-3">
      {notice && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{notice}</p>}
      {attachment && <div className="mb-2 flex items-center gap-2 rounded-xl bg-[#f3f3f0] p-2 text-xs">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.dataUrl} alt="Photo to send" className="size-10 rounded-lg object-cover" />
        <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
        <Button type="button" size="icon" variant="ghost" aria-label="Remove photo" onClick={() => setAttachment(null)} className="size-8 rounded-full"><X className="size-4" /></Button>
      </div>}
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose product image" onChange={(event: ChangeEvent<HTMLInputElement>) => { acceptImage(event.target.files?.[0]); event.target.value = ""; }} />
      <form onSubmit={submit} className="flex min-w-0 gap-2">
        <Button type="button" size="icon" variant="ghost" aria-label="Add a product photo" onClick={() => fileInputRef.current?.click()} className="size-12 shrink-0 rounded-full"><ImagePlus className="size-5" /></Button>
        <Input ref={inputRef} aria-label="Product question" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} onPaste={handlePaste} placeholder={recording ? "Recording… tap stop when done" : "Type a message…"} disabled={recording || transcribing} className="h-12 min-w-0 rounded-full border-0 bg-[#f3f3f0] px-4" />
        {query.trim() || attachment
          ? <Button type="submit" aria-label="Send question" disabled={loading} size="icon" className="size-12 shrink-0 rounded-full bg-[#ef6b3b] hover:bg-[#da592d]"><Send className="size-4" /></Button>
          : <Button type="button" aria-label={recording ? "Stop voice recording" : "Record voice note"} disabled={loading || transcribing} onClick={() => void toggleRecording()} size="icon" className="size-12 shrink-0 rounded-full bg-[#176853] hover:bg-[#125441]">{transcribing ? <LoaderCircle className="size-4 animate-spin" /> : recording ? <Square className="size-4 fill-current" /> : <Mic className="size-5" />}</Button>}
      </form>
    </div>
  </div>;
}
