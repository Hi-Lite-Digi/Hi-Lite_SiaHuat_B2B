// src/components/agent-chat.tsx
"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ExternalLink, FileDown, ImagePlus, LoaderCircle, Mic, RotateCcw, Send, Square, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImageAttachment, Product } from "@/lib/chat-contract";
import { SALES_CONTACT } from "@/lib/agent/contact";
import { agentReplySchema, type AgentEvent, type AgentReply } from "@/lib/agent/contract";
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
};

const GREETING = "Hi, I'm Claire from Sia Huat 👋 What are you looking for today? You can send me a photo too.";
const EMPTY_ENQUIRY: AgentReply["enquiry"] = { lines: [], totals: { lineCount: 0, quantitiesByUom: [], grandTotal: 0 } };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const timeLabel = () => new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" }).format(new Date());
const newSessionId = () => `agent-${crypto.randomUUID()}`;

function stockLabel(card: Product) {
  if (card.stock_status === "in_stock") return "Website: in stock";
  if (card.stock_status === "out_of_stock") return "Website: out of stock";
  return "Stock unconfirmed";
}

function historyFor(items: ChatItem[]) {
  return items.slice(-30).map((item) => ({
    role: item.role,
    content: (item.role === "user"
      ? item.tap ? `[tap] ${item.text}` : item.chip ? `[chip] ${item.text}` : item.imageUrl ? `[photo] ${item.text || "(no caption)"}` : item.text
      : `${item.text}${item.cards?.length ? `\n[cards shown: ${item.cards.map((card) => `${card.stock_id} ${card.name}`).join("; ")}]` : ""}`
    ).slice(0, 2_000),
  })).filter((item) => item.content.trim().length > 0);
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
  const itemsRef = useRef(items);
  const enquiryRef = useRef(enquiry);
  const loadingRef = useRef(false);
  const sessionId = useRef(newSessionId());
  const nextId = useRef(2);
  const shownIds = useRef(new Set<string>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { enquiryRef.current = enquiry; }, [enquiry]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [items, loading]);

  const latestAssistantId = [...items].reverse().find((item) => item.role === "assistant")?.id;

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
        signal: AbortSignal.timeout(50_000),
      });
      const json: unknown = await response.json().catch(() => null);
      if (sessionId.current !== session) return;
      if (!response.ok) throw new Error("REQUEST_FAILED");
      const reply = agentReplySchema.parse(json);
      reply.cards.forEach((card) => shownIds.current.add(card.stock_id));
      setEnquiry(reply.enquiry);
      setItems((current) => [...current, {
        id: nextId.current++, role: "assistant", time: timeLabel(),
        text: reply.message, cards: reply.cards, chips: reply.chips, showContact: reply.showContact,
      }]);
    } catch {
      if (sessionId.current !== session) return;
      setItems((current) => [...current, {
        id: nextId.current++, role: "assistant", time: timeLabel(), showContact: true,
        text: `Sorry, something went wrong on my side. Please try again, or reach Sia Huat sales at ${SALES_CONTACT.phone} or ${SALES_CONTACT.email}.`,
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
    void send({ type: "text", text }, { text });
  }

  function pickCard(card: Product) {
    void send({ type: "select_product", stockId: card.stock_id }, { text: `Picked: ${card.name} (code ${card.stock_id})`, tap: true });
  }

  function acceptImage(file: File | undefined | null) {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) return setNotice("Please use a JPG, PNG or WebP photo.");
    if (file.size > 5 * 1024 * 1024) return setNotice("Please use a photo under 5 MB.");
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setAttachment({ dataUrl: reader.result, mimeType: file.type as ImageAttachment["mimeType"], name: file.name });
    };
    reader.readAsDataURL(file);
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
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setRecording(false);
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (audio.size === 0 || audio.size > 4 * 1024 * 1024) return setNotice("That voice note couldn't be used. Please type your message.");
        const extension = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
        const session = sessionId.current;
        const form = new FormData();
        form.append("audio", audio, `voice-note.${extension}`);
        form.append("sessionId", session);
        setTranscribing(true);
        try {
          const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: AbortSignal.timeout(40_000) });
          const body = await response.json().catch(() => null) as { transcript?: string } | null;
          const transcript = body?.transcript?.trim().slice(0, 500) ?? "";
          if (!response.ok || !transcript) throw new Error("VOICE_FAILED");
          if (sessionId.current !== session) return;
          await send({ type: "text", text: transcript, voice: true }, { text: `🎤 ${transcript}` });
        } catch {
          setNotice("That voice note couldn't be transcribed. Please type your message.");
        } finally {
          setTranscribing(false);
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

  function reset() {
    sessionId.current = newSessionId();
    shownIds.current = new Set();
    loadingRef.current = false;
    setLoading(false);
    setEnquiry(EMPTY_ENQUIRY);
    setAttachment(null);
    setQuery("");
    setNotice("");
    setShowLines(false);
    setItems([{ id: nextId.current++, role: "assistant", text: GREETING, time: timeLabel() }]);
  }

  return <div className="flex h-[min(860px,calc(100dvh-2rem))] w-full max-w-[460px] flex-col overflow-hidden rounded-[2rem] border-8 border-[#15362f] bg-[#f7f4ec] shadow-2xl">
    <header className="flex items-center gap-3 bg-[#176853] px-4 py-4 text-white">
      <div className="grid size-10 shrink-0 place-items-center rounded-full bg-[#efad3f] text-sm font-bold text-[#15362f]">C</div>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold sm:text-base">Claire · Sia Huat</h2>
        <p className="flex items-center gap-1.5 text-xs text-white/75"><span className="size-2 rounded-full bg-[#efad3f]" /> new version (test)</p>
      </div>
      <Button aria-label="Download enquiry PDF" variant="ghost" className="h-9 rounded-full px-2 text-white hover:bg-white/10 hover:text-white" onClick={() => void savePdf()}><FileDown className="size-4" /><span className="text-[11px] font-semibold">PDF</span></Button>
      <Button aria-label="Reset conversation" size="icon" variant="ghost" className="size-9 rounded-full text-white hover:bg-white/10 hover:text-white" onClick={reset}><RotateCcw className="size-4" /></Button>
    </header>

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
            <p className="text-xs font-medium text-[#176853]">Tap a product to choose it.</p>
          </div> : null}
          {item.showContact && <div className="mt-3 rounded-xl border border-[#176853]/20 bg-[#eef7f3] p-3 text-xs text-[#15362f]">
            <p className="font-semibold">Sia Huat sales</p>
            <p>{SALES_CONTACT.phone} · {SALES_CONTACT.email}</p>
            <button type="button" onClick={() => void savePdf()} className="mt-2 font-semibold text-[#176853] underline">Download your enquiry PDF to send along</button>
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
        <Input aria-label="Product question" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} onPaste={handlePaste} placeholder={recording ? "Recording… tap stop when done" : "Type a message…"} disabled={recording || transcribing} className="h-12 min-w-0 rounded-full border-0 bg-[#f3f3f0] px-4" />
        {query.trim() || attachment
          ? <Button type="submit" aria-label="Send question" disabled={loading} size="icon" className="size-12 shrink-0 rounded-full bg-[#ef6b3b] hover:bg-[#da592d]"><Send className="size-4" /></Button>
          : <Button type="button" aria-label={recording ? "Stop voice recording" : "Record voice note"} disabled={loading || transcribing} onClick={() => void toggleRecording()} size="icon" className="size-12 shrink-0 rounded-full bg-[#176853] hover:bg-[#125441]">{transcribing ? <LoaderCircle className="size-4 animate-spin" /> : recording ? <Square className="size-4 fill-current" /> : <Mic className="size-5" />}</Button>}
      </form>
    </div>
  </div>;
}
