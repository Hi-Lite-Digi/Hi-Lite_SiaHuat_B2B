"use client";

import Image from "next/image";
import { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, SetStateAction, useEffect, useRef, useState } from "react";
import { ExternalLink, FileDown, ImagePlus, LoaderCircle, Mic, Pause, Play, RotateCcw, Send, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type {
  ChatReply,
  ImageAttachment,
  Product,
} from "@/lib/chat-contract";
import {
  asksForRecommendation,
  confirmsDisplayedProduct,
  confirmsOrderRequest,
  isGenericAddAnotherItem,
  isProductRefinementOnly,
  parseRequestedQuantity,
  referencesSingleDisplayedProduct,
  requestedDisplayedProductIndex,
  requestedQuantity,
  requestsAdditionalProduct,
  requestsAnotherOption,
  splitMultipleProductRequest,
} from "@/lib/chat-turn";
import { productCategory } from "@/lib/chat-intent";

type QuoteSummary = {
  item: string;
  code: string;
  pricePerItem: number;
  quantity: number;
  total: number;
  uom: string;
  sourceUrl?: string | null;
};

type ChatLanguage = "en" | "zh";

function hasChineseText(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function languageForMessage(value: string, current: ChatLanguage): ChatLanguage {
  if (hasChineseText(value)) return "zh";
  if (/[A-Za-z]/.test(value)) return "en";
  return current;
}

function safeChatFailureMessage(language: ChatLanguage, timedOut = false, hasProductContext = false) {
  if (language === "zh") {
    if (hasProductContext) {
      return timedOut
        ? "刚才的查询超时了，不过我还记得目前的商品要求。请再发送最后一个要求，我会继续。"
        : "刚才的查询没有完成，不过目前的商品要求仍然保留。请再发送最后一个要求。";
    }
    return timedOut
      ? "刚才的查询超时了。请再试一次，或发送商品名称。"
      : "刚才的查询没有完成。请再试一次，或发送商品名称。";
  }
  if (hasProductContext) {
    return timedOut
      ? "That lookup took too long, but I still have the current product details. Send the last requirement once more and I’ll continue."
      : "That lookup didn’t finish, but I still have the current product details. Send the last requirement once more and I’ll continue.";
  }
  return timedOut
    ? "That lookup took too long. Please try again, or send the product name."
    : "That lookup didn’t finish. Please try again, or send the product name.";
}

function whatsAppQuoteMessage(order: QuoteSummary | QuoteSummary[], confirmed = false, language: ChatLanguage = "en") {
  const quotes = Array.isArray(order) ? order : [order];
  const grandTotal = quotes.reduce((total, quote) => total + quote.total, 0);
  if (language === "zh") {
    const lines = [
      confirmed
        ? "您的询价摘要已准备好。此演示不会自动发送给销售人员。"
        : quotes.length > 1 ? `请检查以下 ${quotes.length} 件商品。` : "请检查以下询价内容。",
      "",
      "*订单摘要*",
    ];
    quotes.forEach((quote, index) => {
      lines.push(
        ...(index > 0 ? [""] : []),
        `*${quotes.length > 1 ? `${index + 1}. ` : ""}商品：* ${quote.item}`,
        `*商品代码：* ${quote.code}`,
        `*单价：* $${quote.pricePerItem.toFixed(2)} / ${quote.uom}（未含 GST）`,
        `*数量：* ${quote.quantity} ${quote.uom}`,
        `*${quotes.length > 1 ? "小计" : "总价"}：* $${quote.total.toFixed(2)}（未含 GST）`,
      );
      if (quote.sourceUrl) lines.push("*商品链接：*", quote.sourceUrl);
    });
    if (quotes.length > 1) lines.push("", `*总计：* $${grandTotal.toFixed(2)}（未含 GST）`);
    lines.push("", confirmed
      ? "目前尚未正式下单。请使用上方 PDF 按钮下载摘要，并手动发给 Sia Huat 销售人员以确认报价、库存、付款和送货。"
      : "目前尚未正式下单。您可以继续添加商品，或完成询价摘要。");
    return lines.join("\n");
  }

  const lines = [
    confirmed
      ? "Your enquiry summary is ready. This demo has not sent it to Sia Huat sales staff."
      : quotes.length > 1 ? `Please review these ${quotes.length} items.` : "Please review this enquiry.",
    "",
    "*ORDER SUMMARY*",
  ];
  quotes.forEach((quote, index) => {
    lines.push(
      ...(index > 0 ? [""] : []),
      `*${quotes.length > 1 ? `${index + 1}. ` : ""}Item:* ${quote.item}`,
      `*Code:* ${quote.code}`,
      `*Price per item:* $${quote.pricePerItem.toFixed(2)} / ${quote.uom} (ex GST)`,
      `*Quantity:* ${quote.quantity} ${quote.uom}`,
      `*${quotes.length > 1 ? "Line total" : "Total"}:* $${quote.total.toFixed(2)} (ex GST)`,
    );
    if (quote.sourceUrl) lines.push("*Item link:*", quote.sourceUrl);
  });
  if (quotes.length > 1) lines.push("", `*GRAND TOTAL:* $${grandTotal.toFixed(2)} (ex GST)`);
  lines.push("", confirmed
    ? "No purchase has been placed. Download the PDF above and share it with your Sia Huat sales contact for quotation and order confirmation."
    : "No purchase has been placed yet. Use the buttons below to add another item or finish this enquiry summary.");
  return lines.join("\n");
}

function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|https?:\/\/\S+)/g);
  return <p className="whitespace-pre-wrap leading-6 text-[#334b44]">{parts.map((part, index) => {
    if (/^\*[^*\n]+\*$/.test(part)) return <strong key={`${index}-${part}`} className="font-semibold text-[#15362f]">{part.slice(1, -1)}</strong>;
    if (/^https?:\/\//.test(part)) return <a key={`${index}-${part}`} href={part} target="_blank" rel="noreferrer" className="break-all font-semibold text-[#176853] underline decoration-[#176853]/35 underline-offset-2">{part}</a>;
    return part;
  })}</p>;
}

type VoiceNote = { audioUrl: string; durationSeconds: number; transcript: string };

type ChatMessage = { id: number; role: "user" | "assistant"; text: string; time?: string; imageUrl?: string; voiceNote?: VoiceNote; products?: Product[]; selectedProduct?: Product; needsConfirmation?: boolean; quoteSummary?: QuoteSummary; quoteSummaries?: QuoteSummary[] };

type SpeechRecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type LiveStockCheck = {
  inStock: boolean;
  availableQuantity: number | null;
  stockStatus: "in_stock" | "out_of_stock" | "unknown";
  priceExGst: number;
  checkedAt: string;
  sourceUrl: string;
};

function productStockLabel(product: Product, language: ChatLanguage = "en") {
  if (language === "zh") {
    if (product.stock_status === "in_stock") return "网站：有货";
    if (product.stock_status === "out_of_stock") return "网站：缺货";
    return "需要实时查询";
  }
  if (product.stock_status === "in_stock") return "Website: in stock";
  if (product.stock_status === "out_of_stock") return "Website: out of stock";
  return "Live check needed";
}

function availableLimit(product: Product) {
  const quantity = product.available_quantity;
  return typeof quantity === "number" && Number.isInteger(quantity) && quantity >= 0
    ? quantity
    : null;
}

function quantitySuggestions(limit: number | null) {
  const suggestions = [1, 6, 12, 24].filter((quantity) => limit === null || quantity <= limit);
  return suggestions.length > 0 ? suggestions.map(String) : ["Choose another item"];
}

function productOptionSuggestions(products: Product[]) {
  return products.flatMap((product, index) =>
    product.stock_status === "out_of_stock" ? [] : [String(index + 1)],
  );
}

function productOptionPrompt(products: Product[], language: ChatLanguage = "en") {
  const options = products.flatMap((product, index) =>
    product.stock_status === "out_of_stock" ? [] : [String(index + 1)],
  );
  if (language === "zh") {
    if (options.length === 0) return "这些缺货商品仅供参考。尚未发送采购请求；请下载 PDF 并手动联系 Sia Huat 销售人员。";
    if (options.length < 2) return "回复 1 即可选择这件商品。";
    return `请回复 ${options.join("、")} 选择商品。`;
  }
  if (options.length === 0) return "These out-of-stock matches are shown for reference only. No sourcing request has been sent; download the PDF and contact Sia Huat sales for manual sourcing.";
  if (options.length < 2) return "Reply with 1 to choose this item.";
  return `Reply with ${options.slice(0, -1).join(", ")} or ${options.at(-1)}.`;
}

function singaporeTime() {
  return new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Singapore",
  }).format(new Date());
}

function voiceTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function VoiceNotePlayer({ note }: { note: VoiceNote }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }

  return <div className="min-w-[210px] max-w-[290px]">
    <div className="flex items-center gap-3 rounded-2xl bg-[#cfeadf] px-3 py-2.5 text-[#176853]">
      <button type="button" aria-label={playing ? "Pause voice note" : "Play voice note"} onClick={togglePlayback} className="grid size-9 shrink-0 place-items-center rounded-full bg-[#176853] text-white">
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <input aria-label="Voice note progress" type="range" min={0} max={Math.max(note.durationSeconds, 1)} step={0.1} value={Math.min(currentTime, note.durationSeconds)} onChange={(event) => seek(Number(event.target.value))} className="h-1 w-full cursor-pointer accent-[#176853]" />
        <div className="mt-1 flex items-center justify-between text-[10px] text-[#526861]"><span>{voiceTime(currentTime)}</span><span>{voiceTime(note.durationSeconds)}</span></div>
      </div>
      <Mic className="size-4 shrink-0" />
      <audio ref={audioRef} src={note.audioUrl} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} />
    </div>
  </div>;
}

function pdfSafeText(value: string) {
  return value
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\n]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function MessageTimestamp({ role, time }: { role: ChatMessage["role"]; time: string }) {
  const status = role === "user" ? "Sent" : "Received";

  return <p suppressHydrationWarning aria-label={`${status} at ${time}`} className={`mt-2 min-h-4 text-[10px] leading-4 text-[#667a74]/80 ${role === "user" ? "text-right" : "text-left"}`}>
    <span suppressHydrationWarning>{status} · {time}</span>
  </p>;
}

const welcome: ChatMessage = { id: 1, role: "assistant", text: "Hi, I’m Claire from Sia Huat 👋\n\nWhat are you looking for? Send me the item name, brand or a photo." };
const initialSuggestions = ["Chef knives", "Glassware", "Black dinner plates"];

export function ChatDemo() {
  const [messages, setMessageState] = useState<ChatMessage[]>(() => [{ ...welcome, time: singaporeTime() }]);
  const [conversationLanguage, setConversationLanguage] = useState<ChatLanguage>("en");
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState("");
  const [stage, setStage] = useState<ChatReply["stage"]>("discover");
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [loading, setLoading] = useState(false);
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [draggingImage, setDraggingImage] = useState(false);
  const [pendingProduct, setPendingProduct] = useState<Product | null>(null);
  const [pendingQuantity, setPendingQuantity] = useState<number | null>(null);
  const [pendingQuote, setPendingQuote] = useState<QuoteSummary | null>(null);
  const [confirmedProduct, setConfirmedProduct] = useState<Product | null>(null);
  const [lastProducts, setLastProducts] = useState<Product[]>([]);
  const [checkingStock, setCheckingStock] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState("");
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceDraft, setVoiceDraft] = useState<VoiceNote | null>(null);
  const [voiceError, setVoiceError] = useState("");
  const [transcribingVoice, setTranscribingVoice] = useState(false);
  const nextId = useRef(2);
  const sessionId = useRef(crypto.randomUUID());
  const conversationEnd = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const [queuedMessages, setQueuedMessages] = useState<Array<{ value: string; voiceNote?: VoiceNote }>>([]);
  const submitRef = useRef<((value: string, voiceNote?: VoiceNote) => Promise<void>) | null>(null);
  const orderLinesRef = useRef<QuoteSummary[]>([]);
  const pendingOrderRequestsRef = useRef<string[]>([]);
  const awaitingAdditionalProductRef = useRef(false);
  const lastQuotedProductRef = useRef<Product | null>(null);
  const queuedAdditionalProductRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const finalTranscriptRef = useRef("");
  const latestTranscriptRef = useRef("");
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingElapsedSecondsRef = useRef(0);
  const recordingActiveRef = useRef(false);
  const discardRecordingRef = useRef(false);
  const voiceDraftRef = useRef<VoiceNote | null>(null);

  function setMessages(update: SetStateAction<ChatMessage[]>) {
    const time = singaporeTime();
    setMessageState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      return next.map((message) => message.time ? message : { ...message, time });
    });
  }

  function contentForBrain(message: ChatMessage) {
    const productOptions = message.products?.map(
      (product, index) => `Option ${index + 1}: ${product.name} (code: ${product.stock_id}, $${Number(product.list_price).toFixed(2)}/${product.uom_id})`,
    ) ?? [];
    const selected = message.selectedProduct
      ? [`Selected item shown: ${message.selectedProduct.name} (code: ${message.selectedProduct.stock_id})`]
      : [];
    const summaries = message.quoteSummaries
      ?? (message.quoteSummary ? [message.quoteSummary] : []);
    const quote = summaries.map(
      (summary) => `Order summary line: ${summary.quantity} ${summary.uom} of ${summary.item} (code: ${summary.code})`,
    );
    return [message.text, ...productOptions, ...selected, ...quote].filter(Boolean).join("\n");
  }

  function brainHistory() {
    return messagesRef.current.slice(1).slice(-30).map((message) => ({
      role: message.role,
      content: contentForBrain(message),
    }));
  }

  function syncHandledTurnWithN8n(message: string) {
    void message;
    // The next conversational request sends the complete browser transcript to
    // the normal n8n-backed /api/chat path. A second fire-and-forget request
    // created a different session for every handled click, added latency, and
    // surfaced harmless sync failures in the console. No extra request is
    // needed to retain these turns.
  }

  function selectImage(file: File | undefined) {
    if (!file) return;
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"] as const;
    if (!allowedTypes.includes(file.type as (typeof allowedTypes)[number])) {
      setAttachmentError("Please use a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAttachmentError("Please choose an image smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setAttachment({ dataUrl: reader.result, mimeType: file.type as ImageAttachment["mimeType"], name: file.name });
      setAttachmentError("");
    };
    reader.onerror = () => setAttachmentError("I couldn't read that image. Please try another one.");
    reader.readAsDataURL(file);
  }

  function handleImageInput(event: ChangeEvent<HTMLInputElement>) {
    selectImage(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleImageDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDraggingImage(false);
    selectImage(event.dataTransfer.files?.[0]);
  }

  function handleImagePaste(event: ClipboardEvent<HTMLElement>) {
    const imageItem = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) {
      setAttachmentError("I couldn't read that pasted image. Please try again.");
      return;
    }

    event.preventDefault();
    selectImage(file);
  }

  function clearRecordingResources() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    try { recognitionRef.current?.stop(); } catch { /* Recognition may already be stopped by the browser. */ }
    recognitionRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingActiveRef.current = false;
    setRecordingVoice(false);
  }

  function discardVoiceDraft() {
    if (voiceDraftRef.current) URL.revokeObjectURL(voiceDraftRef.current.audioUrl);
    voiceDraftRef.current = null;
    setVoiceDraft(null);
    setVoiceTranscript("");
    latestTranscriptRef.current = "";
    setVoiceError("");
    setTranscribingVoice(false);
  }

  function stopVoiceRecording(discard = false) {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      clearRecordingResources();
      return;
    }
    discardRecordingRef.current = discard;
    recorder.stop();
  }

  async function startVoiceRecording() {
    if (loading || recordingActiveRef.current || attachment) return;
    setVoiceError("");
    discardVoiceDraft();

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("Voice recording is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const supportedType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = supportedType ? new MediaRecorder(stream, { mimeType: supportedType }) : new MediaRecorder(stream);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      finalTranscriptRef.current = "";
      latestTranscriptRef.current = "";
      discardRecordingRef.current = false;
      recordingElapsedSecondsRef.current = 0;
      recordingActiveRef.current = true;
      setRecordingSeconds(0);
      setVoiceTranscript("");
      setRecordingVoice(true);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceError("The recording stopped unexpectedly. Please try again.");
        clearRecordingResources();
      };
      recorder.onstop = () => {
        const durationSeconds = Math.max(1, recordingElapsedSecondsRef.current);
        const chunks = [...audioChunksRef.current];
        const mimeType = recorder.mimeType || supportedType || "audio/webm";
        const discard = discardRecordingRef.current;
        setTranscribingVoice(!discard);
        clearRecordingResources();
        audioChunksRef.current = [];

        window.setTimeout(() => {
          if (discard || chunks.length === 0) {
            setVoiceTranscript("");
            setVoiceError("");
            setTranscribingVoice(false);
            return;
          }
          const audioUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
          const transcript = finalTranscriptRef.current.trim() || latestTranscriptRef.current.trim();
          const note = { audioUrl, durationSeconds, transcript };
          voiceDraftRef.current = note;
          setVoiceDraft(note);
          setVoiceTranscript(transcript);
          setTranscribingVoice(false);
        }, 900);
      };

      const speechWindow = window as typeof window & {
        SpeechRecognition?: BrowserSpeechRecognitionConstructor;
        webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
      };
      const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = conversationLanguage === "zh" ? "zh-SG" : navigator.language || "en-SG";
        recognition.onresult = (event) => {
          let interim = "";
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const transcript = result[0]?.transcript ?? "";
            if (result.isFinal) finalTranscriptRef.current = `${finalTranscriptRef.current} ${transcript}`.trim();
            else interim += transcript;
          }
          const latestTranscript = `${finalTranscriptRef.current} ${interim}`.trim();
          latestTranscriptRef.current = latestTranscript;
          setVoiceTranscript(latestTranscript);
        };
        recognition.onerror = (event) => {
          if (event.error === "not-allowed" || event.error === "service-not-allowed") recognitionRef.current = null;
        };
        recognitionRef.current = recognition;
        try { recognition.start(); } catch { recognitionRef.current = null; }
      }

      recorder.start(250);
      recordingTimerRef.current = setInterval(() => {
        recordingElapsedSecondsRef.current += 1;
        const elapsed = recordingElapsedSecondsRef.current;
        setRecordingSeconds(elapsed);
        if (elapsed >= 60) stopVoiceRecording();
      }, 1_000);
    } catch (error) {
      clearRecordingResources();
      const blocked = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      setVoiceError(blocked ? "Please allow microphone access to record a voice note." : "I couldn’t start the microphone. Please try again.");
    }
  }

  async function sendVoiceDraft() {
    const draft = voiceDraftRef.current;
    if (!draft || transcribingVoice || loading) return;
    setVoiceError("");
    setTranscribingVoice(true);
    const browserTranscript = draft.transcript.trim()
      || finalTranscriptRef.current.trim()
      || latestTranscriptRef.current.trim()
      || voiceTranscript.trim();
    let transcript = "";

    try {
      const audioResponse = await fetch(draft.audioUrl);
      const audio = await audioResponse.blob();
      const extension = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
      const formData = new FormData();
      formData.append("audio", audio, `voice-note.${extension}`);
      formData.append("sessionId", sessionId.current);

      const response = await fetch("/api/transcribe", { method: "POST", body: formData });
      const body = await response.json().catch(() => null) as { transcript?: string; error?: string } | null;
      transcript = body?.transcript?.trim() ?? "";

      if (!response.ok || !transcript) throw new Error(body?.error ?? "VOICE_TRANSCRIPTION_FAILED");
    } catch (error) {
      console.error("[voice] multilingual transcription failed", error);
      transcript = browserTranscript;
      if (!transcript) {
        setVoiceError(conversationLanguage === "zh"
          ? "这段语音没有成功转成文字。录音仍然保留，您可以重试，或在下方输入商品名称。"
          : "That voice note wasn’t transcribed. The recording is still here, so you can retry or type the product name below.");
        setTranscribingVoice(false);
        return;
      }
    }

    const understoodVoiceNote = { ...draft, transcript };
    voiceDraftRef.current = null;
    setVoiceDraft(null);
    setVoiceTranscript("");
    latestTranscriptRef.current = "";
    setQuery("");
    await submit(transcript, understoodVoiceNote);
    setTranscribingVoice(false);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const time = singaporeTime();
      setMessageState((current) => current.map((message, index) =>
        index === 0 ? { ...message, time } : message,
      ));
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading, suggestions]);

  useEffect(() => {
    voiceDraftRef.current = voiceDraft;
  }, [voiceDraft]);

  useEffect(() => () => {
    recognitionRef.current?.abort();
    if (mediaRecorderRef.current?.state === "recording") {
      discardRecordingRef.current = true;
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    if (voiceDraftRef.current) URL.revokeObjectURL(voiceDraftRef.current.audioUrl);
    messagesRef.current.forEach((message) => {
      if (message.voiceNote) URL.revokeObjectURL(message.voiceNote.audioUrl);
    });
  }, []);

  function quoteFor(quantity: number, product: Product): QuoteSummary {
    const estimate = product.list_price * quantity;
    return {
      item: product.name,
      code: product.stock_id,
      pricePerItem: product.list_price,
      quantity,
      total: estimate,
      uom: product.uom_id,
      sourceUrl: product.source_url,
    };
  }

  function queuedRequestLabel(request: string) {
    return request.replace(/^I need\s+/i, "").replace(/[.!]\s*$/, "").trim();
  }

  function showOrderReview(quantity: number, product: Product, userText?: string) {
    const quote = quoteFor(quantity, product);
    const nextOrder = [
      ...orderLinesRef.current.filter((line) => line.code !== quote.code),
      quote,
    ];
    orderLinesRef.current = nextOrder;
    lastQuotedProductRef.current = product;
    const nextQueuedRequest = pendingOrderRequestsRef.current[0] ?? null;
    const nextQueuedLabel = nextQueuedRequest ? queuedRequestLabel(nextQueuedRequest) : null;
    setMessages((current) => [...current,
      ...(userText ? [{ id: nextId.current++, role: "user" as const, text: userText }] : []),
      {
        id: nextId.current++, role: "assistant" as const,
        text: `${whatsAppQuoteMessage(nextOrder, false, conversationLanguage)}${nextQueuedRequest
          ? conversationLanguage === "zh"
            ? `\n\n接下来：${nextQueuedRequest}`
            : `\n\nNext up: ${nextQueuedLabel}. Tap Continue below—you don’t need to type it again.`
          : ""}`,
        quoteSummary: quote,
        quoteSummaries: nextOrder,
      },
    ]);
    setPendingQuantity(null);
    setPendingQuote(quote);
    setQuery("");
    setStage("clarify");
    setSuggestions(nextQueuedRequest
      ? [conversationLanguage === "zh" ? nextQueuedRequest : `Continue: ${nextQueuedLabel}`, conversationLanguage === "zh" ? "完成询价摘要" : "Finish enquiry summary"]
      : conversationLanguage === "zh"
        ? ["完成询价摘要", "再加一件商品", "更改数量"]
        : ["Finish enquiry summary", "Add another item", "Change quantity"]);
  }

  function showQuantityLimit(userText: string, quantity: number, product: Product, limit: number) {
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      {
        id: nextId.current++, role: "assistant", selectedProduct: product,
        text: conversationLanguage === "zh"
          ? `Sia Huat 网站的实时库存只有 ${limit} ${product.uom_id}，无法提供您要的 ${quantity}。\n\n您要现有的 ${limit} ${product.uom_id}，还是查看其他选择？`
          : `The live Sia Huat Add to cart check shows only ${limit} ${product.uom_id} available, so I can’t prepare ${quantity}.\n\nWould you like ${limit} ${product.uom_id}, or would you prefer another option instead?`,
      },
    ]);
    setPendingQuantity(quantity); setQuery(""); setStage(limit > 0 ? "quantity" : "clarify");
    setSuggestions(limit > 0
      ? [String(limit), conversationLanguage === "zh" ? "选择其他商品" : "Choose another item"]
      : conversationLanguage === "zh" ? ["选择其他商品", "不用了，谢谢"] : ["Choose another item", "No, thank you"]);
  }

  function showRememberedQuantityLimit(quantity: number, product: Product, limit: number) {
    setMessages((current) => [...current, {
      id: nextId.current++, role: "assistant", selectedProduct: product,
      text: conversationLanguage === "zh"
        ? `${product.name} 目前只有 ${limit} ${product.uom_id}，但您需要 ${quantity} ${product.uom_id}。\n\n您要现有的 ${limit} ${product.uom_id}，还是查看其他选择？`
        : `Only ${limit} ${product.uom_id} of ${product.name} ${limit === 1 ? "is" : "are"} currently available, but you requested ${quantity} ${product.uom_id}.\n\nWould you like all ${limit} ${product.uom_id}, or would you prefer another option?`,
    }]);
    setPendingQuantity(quantity); setStage(limit > 0 ? "quantity" : "clarify");
    setSuggestions(limit > 0
      ? [String(limit), conversationLanguage === "zh" ? "选择其他商品" : "Choose another item"]
      : conversationLanguage === "zh" ? ["选择其他商品", "不用了，谢谢"] : ["Choose another item", "No, thank you"]);
  }

  async function submit(value: string, voiceNote?: VoiceNote) {
    const clean = value.trim() || (attachment ? "What product is this?" : "");
    if (!clean) return;
    const replyLanguage = languageForMessage(clean, conversationLanguage);
    if (replyLanguage !== conversationLanguage) setConversationLanguage(replyLanguage);
    if (clean.length > 500) {
      setQueryError(replyLanguage === "zh"
        ? "消息不能超过 500 个字符。请缩短后再发送。"
        : "Please keep your message to 500 characters or fewer.");
      return;
    }
    setQueryError("");
    if (/^\/\/reset sia huat$/i.test(clean)) {
      resetByCommand();
      return;
    }
    if (loadingRef.current) {
      setQueuedMessages((current) => [...current, { value: clean, voiceNote }]);
      setQuery("");
      return;
    }

    let messageForApi = clean;
    let newlyQueuedRequests: string[] = [];
    let queuedRequestToConsume: string | null = null;
    const consumeQueuedRequest = () => {
      if (!queuedRequestToConsume) return;
      const index = pendingOrderRequestsRef.current.indexOf(queuedRequestToConsume);
      if (index >= 0) {
        pendingOrderRequestsRef.current = pendingOrderRequestsRef.current.filter(
          (_, requestIndex) => requestIndex !== index,
        );
      }
      queuedAdditionalProductRef.current = null;
    };
    const multiProductRequests = orderLinesRef.current.length === 0
      && pendingOrderRequestsRef.current.length === 0
      ? splitMultipleProductRequest(clean)
      : [];
    if (multiProductRequests.length > 1) {
      messageForApi = multiProductRequests[0];
      newlyQueuedRequests = multiProductRequests.slice(1);
      pendingOrderRequestsRef.current = newlyQueuedRequests;
    }

    const queuedRequestNotice = newlyQueuedRequests.length > 0
      ? replyLanguage === "zh"
        ? `\n\n我也记住了下一项：${newlyQueuedRequests.join("；")}。完成当前商品后会继续处理。`
        : `\n\nI’ve also kept your next request: ${newlyQueuedRequests
            .map((request) => request.replace(/[.!?]+$/g, ""))
            .join("; ")}. We’ll handle it after this item.`
      : "";

    const cleanCategory = productCategory(clean);
    const canMatchQueuedCategory = newlyQueuedRequests.length === 0;
    const queuedRequestIndex = pendingOrderRequestsRef.current.findIndex(
      (request) => request.toLocaleLowerCase() === clean.toLocaleLowerCase()
        || (canMatchQueuedCategory && cleanCategory !== null && productCategory(request) === cleanCategory),
    );
    const awaitingAdditionalProduct = awaitingAdditionalProductRef.current;
    const hasExistingOrderSummary = pendingQuote !== null || orderLinesRef.current.length > 0;
    const returnsToExistingSummary = awaitingAdditionalProduct
      && hasExistingOrderSummary
      && (confirmsOrderRequest(clean) || clean === "Change quantity" || clean === "更改数量");
    if (returnsToExistingSummary) awaitingAdditionalProductRef.current = false;

    const cancelsAdditionalProduct = hasExistingOrderSummary
      && (awaitingAdditionalProduct || pendingQuote === null)
      && /^(?:cancel(?:\s+(?:the\s+)?additional\s+item)?|never\s*mind|no thanks|no thank you|不用了|取消|算了)[.!。！\s]*$/iu.test(clean);
    if (cancelsAdditionalProduct) {
      awaitingAdditionalProductRef.current = false;
      const queuedRequestToCancel = queuedAdditionalProductRef.current;
      if (queuedRequestToCancel) {
        const queuedIndex = pendingOrderRequestsRef.current.indexOf(queuedRequestToCancel);
        if (queuedIndex >= 0) {
          pendingOrderRequestsRef.current = pendingOrderRequestsRef.current.filter(
            (_, requestIndex) => requestIndex !== queuedIndex,
          );
        }
      }
      queuedAdditionalProductRef.current = null;
      const latestQuote = orderLinesRef.current.at(-1) ?? pendingQuote;
      const latestProduct = lastQuotedProductRef.current;
      syncHandledTurnWithN8n(clean);
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: replyLanguage === "zh"
          ? "好的，我已保留现有询价摘要。您可以完成摘要、更改数量或稍后再添加商品。"
          : "No problem. I’ve kept the existing enquiry summary. You can finish it, change the quantity, or add another item later." },
      ]);
      setPendingProduct(null);
      setPendingQuantity(null);
      setPendingQuote(latestQuote);
      setConfirmedProduct(latestProduct);
      setLastProducts(latestProduct ? [latestProduct] : []);
      setStage("complete");
      setSuggestions(replyLanguage === "zh" ? ["完成询价摘要", "更改数量", "选择其他商品"] : ["Finish enquiry summary", "Change quantity", "Add another item"]);
      setQuery("");
      return;
    }

    const consumesAwaitingAdditionalProduct = awaitingAdditionalProduct && !returnsToExistingSummary;
    const startingAdditionalProduct = !returnsToExistingSummary && (awaitingAdditionalProduct
      || queuedRequestIndex >= 0
      || ((pendingQuote !== null || stage === "submitted" || orderLinesRef.current.length > 0)
        && requestsAdditionalProduct(clean)));
    if (startingAdditionalProduct) {
      if (queuedRequestIndex >= 0) {
        queuedRequestToConsume = pendingOrderRequestsRef.current[queuedRequestIndex];
        queuedAdditionalProductRef.current = queuedRequestToConsume;
        messageForApi = queuedRequestToConsume;
      }
      if (isGenericAddAnotherItem(clean)) {
        awaitingAdditionalProductRef.current = true;
        setMessages((current) => [...current,
          { id: nextId.current++, role: "user", text: clean },
          { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? "好的，您还要找什么商品？" : "Sure, what else would you like to add?" },
        ]);
        setSuggestions([]);
        setQuery("");
        return;
      }

    }

    if (hasExistingOrderSummary && !startingAdditionalProduct && confirmsOrderRequest(clean)) {
      syncHandledTurnWithN8n(clean);
      const confirmedQuotes = orderLinesRef.current.length > 0
        ? orderLinesRef.current
        : pendingQuote ? [pendingQuote] : [];
      const latestQuote = pendingQuote ?? confirmedQuotes.at(-1);
      if (!latestQuote || confirmedQuotes.length === 0) return;
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        {
          id: nextId.current++, role: "assistant",
          text: whatsAppQuoteMessage(confirmedQuotes, true, replyLanguage),
          quoteSummary: latestQuote,
          quoteSummaries: confirmedQuotes,
        },
      ]);
      setPendingQuote(null);
      setPendingProduct(null);
      setPendingQuantity(null);
      setConfirmedProduct(null);
      setLastProducts([]);
      pendingOrderRequestsRef.current = [];
      orderLinesRef.current = [];
      lastQuotedProductRef.current = null;
      queuedAdditionalProductRef.current = null;
      setStage("submitted");
      setSuggestions(replyLanguage === "zh" ? ["下载询价 PDF", "开始新的询价"] : ["Download enquiry PDF", "Start another enquiry"]);
      setQuery("");
      return;
    }

    const parsedQuantity = parseRequestedQuantity(messageForApi);
    const confirmedQuantity = parsedQuantity.kind === "valid" ? parsedQuantity.value : null;
    if (parsedQuantity.kind === "invalid") {
      if (startingAdditionalProduct && hasExistingOrderSummary) {
        awaitingAdditionalProductRef.current = true;
        consumeQueuedRequest();
        setMessages((current) => [...current,
          { id: nextId.current++, role: "user", text: clean, voiceNote },
          {
            id: nextId.current++, role: "assistant",
            text: replyLanguage === "zh"
              ? parsedQuantity.reason === "fractional"
                ? "请使用整数数量，并再次写出完整的商品要求，例如“3 个红酒杯”。我已保留现有询价摘要。"
                : "请输入 1 到 100,000 之间的数量，并再次写出完整的商品要求。我已保留现有询价摘要。"
              : parsedQuantity.reason === "fractional"
                ? "Please use a whole-number quantity and include the product again, for example “3 wine glasses”. I’ve kept your existing enquiry summary."
                : "Please use a quantity from 1 to 100,000 and include the product again. I’ve kept your existing enquiry summary.",
          },
        ]);
        setQuery("");
        setSuggestions(replyLanguage === "zh" ? ["完成询价摘要", "取消"] : ["Finish enquiry summary", "Cancel additional item"]);
        return;
      }
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean, voiceNote },
        {
          id: nextId.current++, role: "assistant",
          text: replyLanguage === "zh"
            ? parsedQuantity.reason === "fractional"
              ? "请输入整数数量，例如 2 或 3。"
              : "请输入 1 到 100,000 之间的数量。"
            : parsedQuantity.reason === "fractional"
              ? "Please use a whole-number quantity, for example 2 or 3."
              : "Please enter a quantity from 1 to 100,000.",
          selectedProduct: confirmedProduct ?? pendingProduct ?? undefined,
        },
      ]);
      setQuery("");
      setSuggestions(confirmedProduct || pendingProduct ? ["1", "6", "12", "24"] : []);
      return;
    }
    if (pendingQuote && !startingAdditionalProduct && confirmedProduct && confirmedQuantity !== null) {
      syncHandledTurnWithN8n(clean);
      setPendingQuote(null);
      setQuery("");
      await confirmProduct(clean, confirmedProduct, confirmedQuantity);
      return;
    }

    if (pendingProduct && confirmsDisplayedProduct(clean)) {
      syncHandledTurnWithN8n(clean);
      setQuery("");
      await confirmProduct(clean, pendingProduct, confirmedQuantity ?? undefined);
      return;
    }

    if (pendingProduct && confirmedQuantity !== null && referencesSingleDisplayedProduct(clean, 1)) {
      syncHandledTurnWithN8n(clean);
      setQuery("");
      await confirmProduct(clean, pendingProduct, confirmedQuantity);
      return;
    }

    if (pendingProduct && (/^(no|nope|wrong item|not this|(?:no[,\s-]*)?(?:that's|thats) not it|no[,\s-]*(?:show|give)( me)? (the )?(other|others|alternatives|options))([.!\s]*)$/i.test(clean)
      || /^(?:不是|不对|不是这个|查看其他|显示其他)[。.!\s]*$/u.test(clean))) {
      syncHandledTurnWithN8n(clean); setQuery(""); rejectProduct(clean); return;
    }

    if (!pendingProduct && lastProducts.length === 1 && confirmsDisplayedProduct(clean) && confirmedQuantity !== null) {
      syncHandledTurnWithN8n(clean);
      setQuery("");
      await confirmProduct(clean, lastProducts[0], confirmedQuantity);
      return;
    }

    const canSelectDisplayedProduct = !startingAdditionalProduct && stage !== "quantity" && !pendingQuote && !pendingProduct;
    if (canSelectDisplayedProduct && lastProducts.length > 0 && asksForRecommendation(clean)) {
      const recommended = [...lastProducts].sort((left, right) => {
        const stockScore = (product: Product) => product.stock_status === "in_stock" ? 1 : 0;
        return stockScore(right) - stockScore(left)
          || Number(right.available_quantity ?? 0) - Number(left.available_quantity ?? 0);
      })[0];
      setQuery("");
      chooseProduct(recommended, clean);
      return;
    }
    const requestedIndex = canSelectDisplayedProduct && !requestsAnotherOption(clean) && !isProductRefinementOnly(clean)
      ? requestedDisplayedProductIndex(clean, lastProducts)
      : null;
    if (!pendingProduct && requestedIndex !== null) {
      const product = lastProducts[requestedIndex];
      if (product) {
        syncHandledTurnWithN8n(clean);
        setQuery("");
        chooseProduct(product, clean);
        return;
      }
    }

    if ((clean === "Change quantity" || clean === "更改数量") && confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      setPendingQuote(null);
      setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean }, { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? `好的，您需要多少 ${confirmedProduct.uom_id} 的 ${confirmedProduct.name}？` : `Sure. How many ${confirmedProduct.uom_id} of ${confirmedProduct.name} do you need?`, selectedProduct: confirmedProduct }]);
      setStage("quantity"); setSuggestions(["1", "6", "12", "24"]); return;
    }

    if (clean === "Choose another item" || clean === "选择其他商品") {
      syncHandledTurnWithN8n(clean);
      const currentProduct = confirmedProduct ?? pendingProduct ?? lastProducts[0] ?? null;
      const excludedStockIds = new Set(lastProducts.map((product) => product.stock_id));
      if (currentProduct) excludedStockIds.add(currentProduct.stock_id);
      const minimumQuantity = pendingQuantity;
      let alternatives = currentProduct
        ? []
        : lastProducts.filter(
            (product) => !excludedStockIds.has(product.stock_id)
              && product.stock_status === "in_stock"
              && (minimumQuantity === null
                || (typeof product.available_quantity === "number" && product.available_quantity >= minimumQuantity)),
          );
      setPendingProduct(null); setPendingQuote(null); setConfirmedProduct(null); setStage("clarify");
      setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean }]);
      setQuery("");

      if (currentProduct && alternatives.length < 3) {
        setLoading(true);
        loadingRef.current = true;
        try {
          const response = await fetch("/api/alternatives", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              stockId: currentProduct.stock_id,
              ...(minimumQuantity !== null ? { quantity: minimumQuantity } : {}),
            }),
            signal: AbortSignal.timeout(12_000),
          });
          const result = await response.json() as { products?: Product[]; error?: string };
          if (!response.ok) throw new Error(result.error ?? "Alternative lookup failed.");
          alternatives = [...new Map(
            [...alternatives, ...(result.products ?? [])]
              .filter((product) => !excludedStockIds.has(product.stock_id))
              .map((product) => [product.stock_id, product]),
          ).values()].slice(0, 3);
        } catch (error) {
          console.error("[chat] alternative lookup failed", error);
        } finally {
          loadingRef.current = false;
          setLoading(false);
        }
      }

      if (alternatives.length > 0) setLastProducts(alternatives);
      setPendingQuantity(minimumQuantity);
      const alternativeUom = alternatives.length > 0
        && alternatives.every((product) => product.uom_id === alternatives[0].uom_id)
        ? alternatives[0].uom_id
        : replyLanguage === "zh" ? "件" : "units";
      setMessages((current) => [...current, {
        id: nextId.current++, role: "assistant",
        text: replyLanguage === "zh"
          ? alternatives.length > 0
            ? minimumQuantity !== null
              ? `好的，这里有 ${alternatives.length} 个相关选择，每个都有至少 ${minimumQuantity} ${alternativeUom} 库存。您想要哪一个？`
              : `好的，这里有 ${alternatives.length} 个有货的替代选择。您想要哪一个？`
            : minimumQuantity !== null
              ? `抱歉，我找不到同类商品能满足 ${minimumQuantity} 件的实时库存。您要减少数量吗？`
              : "抱歉，目前无法确认其他有货的选择。请告诉我您偏好的尺寸、款式或品牌，我会扩大查询范围。"
          : alternatives.length > 0
            ? minimumQuantity !== null
              ? `Here ${alternatives.length === 1 ? "is" : "are"} ${alternatives.length} relevant option${alternatives.length === 1 ? "" : "s"} with at least ${minimumQuantity} ${alternativeUom} available. Which one would you like?`
              : `Sure—here ${alternatives.length === 1 ? "is" : "are"} ${alternatives.length} available alternative${alternatives.length === 1 ? "" : "s"}. Which one would you like?`
            : minimumQuantity !== null
              ? `Sorry, I couldn’t confirm another matching item with at least ${minimumQuantity} units available. Would you like a smaller quantity?`
              : "Sorry, I couldn’t confirm another available option right now. Tell me what size, style or brand you prefer and I’ll widen the search.",
        products: alternatives,
      }]);
      setSuggestions(alternatives.length > 0
        ? productOptionSuggestions(alternatives)
        : minimumQuantity !== null
          ? replyLanguage === "zh" ? ["减少数量", "重新查询"] : ["Try a smaller quantity", "Search again"]
          : replyLanguage === "zh" ? ["重新查询", "浏览商品"] : ["Search again", "Browse products"]); return;
    }

    if (confirmedProduct?.stock_status === "out_of_stock" && /^(no|no thanks|no thank you|not now)$/i.test(clean)) {
      syncHandledTurnWithN8n(clean);
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: "No problem. Thank you for checking with Sia Huat. If you need another item later, I’ll be happy to help." },
      ]);
      setQuery(""); setSuggestions([]); setStage("complete"); return;
    }

    const preparesStaffReview = clean === "Prepare staff review summary"
      || clean === "Continue for staff review"
      || clean === "准备人工审核摘要"
      || clean === "交由人员确认";
    if (preparesStaffReview && !confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: replyLanguage === "zh"
          ? "已在本对话中保留您的要求。此演示不会自动联系销售人员。请下载 PDF 并手动发给您的 Sia Huat 销售联系人。"
          : "I’ve kept your requirements in this conversation. This demo does not contact sales automatically. Download the PDF and share it with your Sia Huat sales contact to continue." },
      ]);
      setStage("submitted");
      setSuggestions(replyLanguage === "zh" ? ["下载询价 PDF", "选择其他商品"] : ["Download enquiry PDF", "Choose another item"]);
      setQuery("");
      return;
    }
    if (preparesStaffReview && confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      if (pendingQuantity) {
        const quantity = pendingQuantity;
        setMessages((current) => [...current,
          { id: nextId.current++, role: "user", text: clean },
          { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? `已在本对话中保留您需要 ${quantity} ${confirmedProduct.uom_id} 的 ${confirmedProduct.name}。此演示不会自动联系销售人员。请下载 PDF 并手动发给 Sia Huat 销售联系人，以确认库存和最终价格。` : `I’ve kept ${quantity} ${confirmedProduct.uom_id} of ${confirmedProduct.name} in this conversation. This demo does not contact sales automatically. Download the PDF and share it with your Sia Huat sales contact so they can verify availability and final price.`, selectedProduct: confirmedProduct },
        ]);
        setPendingQuantity(null); setStage("submitted"); setSuggestions(replyLanguage === "zh" ? ["下载询价 PDF", "选择其他商品"] : ["Download enquiry PDF", "Choose another item"]); return;
      }
      setStage("quantity");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? `好的，网站无法确认这件商品的库存，最终数量需要销售人员核实。您需要多少 ${confirmedProduct.uom_id}？` : `Okay. The website does not confirm stock for this item, so the final quantity will require staff verification. How many ${confirmedProduct.uom_id} do you need?`, selectedProduct: confirmedProduct },
      ]);
      setSuggestions(["1", "6", "12", "24"]); return;
    }

    const changedItem = clean.match(/\b(?:actually|instead|switch|change|rather|different|another).*?\b(knife|pan|glassware|tableware|coffee)\b/i);
    if (confirmedProduct && changedItem) {
      syncHandledTurnWithN8n(clean);
      const item = changedItem[1].toLowerCase();
      setPendingProduct(null); setPendingQuantity(null); setPendingQuote(null); setConfirmedProduct(null); setStage("discover"); setQuery("");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: `No problem. We’ll stop the ${confirmedProduct.name} enquiry. What kind of ${item} do you want instead?` },
      ]);
      setSuggestions(item === "pan" ? ["Frying pan", "Non-stick pan", "Sauce pan"] : [`Search for ${item}`]);
      return;
    }

    const naturalQuantity = clean.match(/^(?:actually\s+)?(?:make it|change(?: the)? quantity to|quantity)\s*(\d+)$/i)?.[1];
    if (confirmedProduct && (stage === "complete" || pendingQuote) && naturalQuantity) {
      syncHandledTurnWithN8n(clean);
      const quantity = Number.parseInt(naturalQuantity, 10);
      const limit = availableLimit(confirmedProduct);
      if (quantity >= 1 && quantity <= 100_000) {
        if (limit !== null && quantity > limit) showQuantityLimit(clean, quantity, confirmedProduct, limit);
        else showOrderReview(quantity, confirmedProduct, clean);
      }
      return;
    }

    if (stage === "quantity" && confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      const quantityText = clean.match(/^\d+$/)?.[0] ?? naturalQuantity;
      const quantity = confirmedQuantity
        ?? (quantityText ? Number.parseInt(quantityText, 10) : Number.NaN);

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
        setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean }, { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? `请输入 ${confirmedProduct.uom_id} 的整数数量，例如 6 或 12。` : `Please enter a whole-number quantity in ${confirmedProduct.uom_id}, for example 6 or 12.`, selectedProduct: confirmedProduct }]);
        setQuery("");
        setSuggestions(["1", "6", "12", "24"]); return;
      }

      const limit = availableLimit(confirmedProduct);
      if (limit !== null && quantity > limit) {
        showQuantityLimit(clean, quantity, confirmedProduct, limit); return;
      }

      showOrderReview(quantity, confirmedProduct, clean); return;
    }

    if (pendingQuote && !startingAdditionalProduct) {
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: replyLanguage === "zh" ? "这份询价摘要尚未完成。请使用下方按钮，或输入下一件商品的名称。" : "This enquiry summary is still open. Use a button below, or type the name of the next product you need." },
      ]);
      setQuery("");
      setSuggestions(replyLanguage === "zh" ? ["完成询价摘要", "更改数量", "选择其他商品"] : ["Finish enquiry summary", "Change quantity", "Add another item"]);
      return;
    }

    const history = brainHistory();
    const attachedImage = attachment;

    const requestSession = sessionId.current;
    setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean, imageUrl: attachedImage?.dataUrl, voiceNote }]);
    setQuery(""); setAttachment(null); setAttachmentError(""); setSuggestions([]); loadingRef.current = true; setLoading(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: requestSession,
          message: messageForApi,
          history: startingAdditionalProduct ? [] : history,
          context: {
            stage: startingAdditionalProduct ? "discover" : stage,
            activeProduct: startingAdditionalProduct ? null : confirmedProduct ?? pendingProduct,
            quantity: startingAdditionalProduct ? null : pendingQuantity,
            displayedProducts: startingAdditionalProduct ? [] : lastProducts.slice(0, 5),
          },
          ...(attachedImage ? { image: attachedImage } : {}),
        }),
        signal: AbortSignal.timeout(32_000),
      });
      const reply = await response.json() as ChatReply & { error?: string };
      if (sessionId.current !== requestSession) return;
      if (!response.ok) {
        if (response.status === 400) {
          setMessages((current) => [...current, {
            id: nextId.current++,
            role: "assistant",
            text: reply.error ?? (replyLanguage === "zh" ? "请求内容无效。请检查后再试。" : "That request is not valid. Please check it and try again."),
          }]);
          if (startingAdditionalProduct && hasExistingOrderSummary) {
            awaitingAdditionalProductRef.current = true;
            setSuggestions(replyLanguage === "zh" ? ["完成询价摘要", "更改数量", "选择其他商品"] : ["Finish enquiry summary", "Change quantity", "Add another item"]);
          }
          return;
        }
        throw new Error(reply.error ?? "The assistant could not answer right now.");
      }
      consumeQueuedRequest();
      if (consumesAwaitingAdditionalProduct) awaitingAdditionalProductRef.current = false;
      if (startingAdditionalProduct) {
        setPendingProduct(null);
        setPendingQuantity(null);
        setPendingQuote(null);
        setConfirmedProduct(null);
        setLastProducts([]);
      }
      const products = reply.products ?? [];
      // Product cards remain the active choices until Claire displays a new
      // list. A clarification-only reply must not erase option memory.
      if (products.length > 0) setLastProducts(products);
      const requested = requestedQuantity(messageForApi);
      if (requested !== null) setPendingQuantity(requested);

      if (reply.selectedProduct) {
        const product = reply.selectedProduct;
        const quantity = requestedQuantity(messageForApi) ?? (startingAdditionalProduct ? null : pendingQuantity);
        setPendingProduct(product); setPendingQuantity(quantity); setConfirmedProduct(null); setStage("clarify"); setSuggestions([]);
        setLastProducts((current) => current.some((item) => item.stock_id === product.stock_id) ? current : [product, ...current]);
        setMessages((current) => [...current, {
          id: nextId.current++, role: "assistant", needsConfirmation: true, selectedProduct: product,
          text: `${replyLanguage === "zh"
            ? quantity
              ? `请确认这是您要的商品。\n\n您需要的数量：${quantity} ${product.uom_id}。`
              : "我在目录中找到了这件商品。请确认是否是您要的商品。"
            : quantity
              ? `Please confirm this is the correct item.\n\nQuantity requested: ${quantity} ${product.uom_id}.`
              : "I found this item in the catalogue. Is this the exact item you want?"}${queuedRequestNotice}`,
        }]);
        return;
      }

      setStage(reply.stage);
      setSuggestions(products.length > 0 ? productOptionSuggestions(products) : reply.suggestions ?? []);
      setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `${reply.message}${queuedRequestNotice}`, products }]);
    } catch (reason) {
      if (sessionId.current !== requestSession) return;
      const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
      const hasProductContext = Boolean(confirmedProduct || pendingProduct || pendingQuantity !== null || lastProducts.length > 0);
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: "assistant",
        text: safeChatFailureMessage(replyLanguage, timedOut, hasProductContext),
      }]);
      if (startingAdditionalProduct && hasExistingOrderSummary) {
        awaitingAdditionalProductRef.current = true;
        setSuggestions(replyLanguage === "zh" ? ["完成询价摘要", "更改数量", "选择其他商品"] : ["Finish enquiry summary", "Change quantity", "Add another item"]);
      }
    } finally {
      if (sessionId.current !== requestSession) return;
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    if (loading || loadingRef.current) return;
    const queued = queuedMessages[0];
    if (!queued) return;
    const timer = window.setTimeout(() => {
      setQueuedMessages((current) => current.slice(1));
      void submitRef.current?.(queued.value, queued.voiceNote);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, queuedMessages]);

  function chooseProduct(product: Product, userText = conversationLanguage === "zh" ? `我要这个：${product.name}` : `This one: ${product.name}`) {
    if (loading) return;
    if (product.stock_status === "out_of_stock") {
      const quantity = requestedQuantity(userText) ?? pendingQuantity;
      setPendingProduct(null); setPendingQuantity(quantity); setConfirmedProduct(null); setStage("clarify");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: userText },
        {
          id: nextId.current++, role: "assistant",
          text: conversationLanguage === "zh"
            ? `这件商品无法选择，因为 Sia Huat 网站显示完全缺货。${quantity ? `已在本对话中保留数量 ${quantity}。` : ""}尚未发送人工采购请求。您可以选择其他有库存的商品、更改规格，或准备摘要手动发给销售人员。`
            : `That result cannot be selected because the Sia Huat website shows it is completely out of stock. ${quantity ? `I’ve kept your requested quantity of ${quantity} in this conversation. ` : ""}No sourcing request has been sent. Choose another available item, change a specification, or prepare a summary to share with sales manually.`,
        },
      ]);
      setSuggestions(conversationLanguage === "zh" ? ["选择其他商品", "准备人工审核摘要"] : ["Choose another item", "Prepare staff review summary"]); return;
    }
    const quantity = requestedQuantity(userText) ?? pendingQuantity;
    setPendingProduct(product); setPendingQuantity(quantity); setPendingQuote(null); setConfirmedProduct(null); setStage("clarify"); setSuggestions([]);
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      {
        id: nextId.current++, role: "assistant",
        text: conversationLanguage === "zh"
          ? quantity
            ? `请确认：您要 ${quantity} ${product.uom_id} 的 ${product.name}，对吗？`
            : "请确认，这是您要的商品吗？"
          : quantity
            ? `Just to confirm—do you want ${quantity} ${product.uom_id} of ${product.name}?`
            : "Just to confirm, is this the exact item you want?",
        selectedProduct: product,
        needsConfirmation: true,
      },
    ]);
  }

  async function confirmProduct(userText = conversationLanguage === "zh" ? "是的，就是这件商品。" : "Yes, this is the item.", productOverride?: Product, quantityOverride?: number | null) {
    const product = productOverride ?? pendingProduct;
    if (!product || checkingStock) return;
    setPendingProduct(null); setPendingQuote(null); setConfirmedProduct(product); setStage("clarify"); setSuggestions([]); setCheckingStock(true);
    const quantity = quantityOverride === undefined ? pendingQuantity : quantityOverride;
    setMessages((current) => [...current, { id: nextId.current++, role: "user", text: userText }]);

    try {
      const response = await fetch("/api/stock-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stockId: product.stock_id }),
        signal: AbortSignal.timeout(25_000),
      });
      const check = await response.json() as LiveStockCheck & { error?: string };
      if (!response.ok) throw new Error(check.error ?? "Live stock check failed.");
      const liveProduct: Product = { ...product, list_price: check.priceExGst, in_stock: check.inStock, available_quantity: check.availableQuantity, stock_status: check.stockStatus, source_url: check.sourceUrl };
      setConfirmedProduct(liveProduct);
      if (check.stockStatus === "in_stock") {
        if (quantity !== null && check.availableQuantity === null) {
          setStage("clarify");
          setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh"
            ? `已在本对话中保留您需要 ${quantity} ${product.uom_id}，但网站无法确认确切库存。您要查看其他选择，还是准备摘要手动发给 Sia Huat 销售人员？`
            : `I have your request for ${quantity} ${product.uom_id}, but the available quantity could not be confirmed. Would you like another option, or should I prepare the details for you to share with Sia Huat sales manually?`, selectedProduct: liveProduct }]);
          setSuggestions(conversationLanguage === "zh" ? ["准备人工审核摘要", "选择其他商品"] : ["Prepare staff review summary", "Choose another item"]);
          return;
        }
        if (quantity !== null && check.availableQuantity !== null && quantity > check.availableQuantity) {
          showRememberedQuantityLimit(quantity, liveProduct, check.availableQuantity);
          return;
        }
        if (quantity !== null) {
          showOrderReview(quantity, liveProduct);
          return;
        }
        setStage("quantity");
        const availableText = conversationLanguage === "zh"
          ? check.availableQuantity === null
            ? "网站显示有货，但没有提供确切数量。"
            : `现有库存：${check.availableQuantity} ${product.uom_id}。`
          : check.availableQuantity === null
            ? "The website shows it as in stock, but did not return an exact quantity."
            : `Available: ${check.availableQuantity} ${product.uom_id}.`;
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh" ? `${availableText}\n\n您需要多少 ${product.uom_id}？` : `${availableText}\n\nHow many ${product.uom_id} do you need?`, selectedProduct: liveProduct }]);
        setSuggestions(quantitySuggestions(check.availableQuantity));
      } else if (check.stockStatus === "out_of_stock") {
        setStage("clarify");
        setPendingQuantity(null);
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh" ? `${product.name} 目前缺货。要我为您显示其他选择吗？` : `${product.name} is currently out of stock. Would you like me to show you another option instead?`, selectedProduct: liveProduct }]);
        setSuggestions(conversationLanguage === "zh" ? ["选择其他商品", "不用了，谢谢"] : ["Choose another item", "No, thank you"]);
      } else {
        setStage("clarify");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh"
          ? quantity
            ? `已在本对话中保留您需要 ${quantity} ${product.uom_id}，但网站无法确认库存。您要查看其他选择，还是准备摘要手动发给 Sia Huat 销售人员？`
            : "网站无法确认库存。您要查看其他选择，还是准备摘要手动发给 Sia Huat 销售人员？"
          : quantity
            ? `I have your request for ${quantity} ${product.uom_id}, but the available quantity could not be confirmed. Would you like another option, or should I prepare the details for you to share with Sia Huat sales manually?`
            : "The available quantity could not be confirmed. Would you like another option, or should I prepare the details for you to share with Sia Huat sales manually?", selectedProduct: liveProduct }]);
        setSuggestions(conversationLanguage === "zh" ? ["选择其他商品", "准备人工审核摘要"] : ["Choose another item", "Prepare staff review summary"]);
      }
    } catch {
      if (quantity !== null) {
        setStage("clarify");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh" ? `已在本对话中保留您需要 ${quantity} ${product.uom_id}，但无法确认库存和价格。要准备摘要手动发给 Sia Huat 销售人员吗？` : `I have your request for ${quantity} ${product.uom_id}, but the available quantity and price could not be confirmed. Would you like me to prepare the details for you to share with Sia Huat sales manually?`, selectedProduct: product }]);
        setSuggestions(conversationLanguage === "zh" ? ["准备人工审核摘要", "选择其他商品"] : ["Prepare staff review summary", "Choose another item"]);
      } else {
        setStage("quantity");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh" ? `暂时无法确认库存，但我仍保留了已选商品。\n\n您需要多少 ${product.uom_id}？完成摘要后，请手动发给销售人员确认。` : `I couldn’t confirm the live stock just now, but I still have the selected item.\n\nHow many ${product.uom_id} do you need? After the summary is ready, share it with sales manually for verification.`, selectedProduct: product }]);
        setSuggestions(["1", "6", "12", "24"]);
      }
    } finally {
      setCheckingStock(false);
    }
  }

  function rejectProduct(userText = conversationLanguage === "zh" ? "不是，我要看其他商品。" : "No, that’s not the item.") {
    if (!pendingProduct) return;
    const alternatives = lastProducts.filter((product) => product.stock_id !== pendingProduct.stock_id);
    setPendingProduct(null); setPendingQuantity(null); setPendingQuote(null); setStage("clarify");
    setLastProducts(alternatives);
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      { id: nextId.current++, role: "assistant", text: conversationLanguage === "zh"
        ? alternatives.length > 0 ? "好的，以下是其他商品和价格。请选择较接近您需求的选项。" : "好的，请告诉我其他商品名称、品牌或细节，我会重新查询。"
        : alternatives.length > 0 ? "No problem. Here are the other catalogue options and prices. Which one is closer?" : "No problem. Tell me another name, brand or detail and I’ll search again.", products: alternatives },
    ]);
    setSuggestions(alternatives.length > 0 ? productOptionSuggestions(alternatives) : conversationLanguage === "zh" ? ["重新查询", "浏览商品"] : ["Search again", "Browse products"]);
  }

  function resetConversation(firstMessage: ChatMessage) {
    if (recordingActiveRef.current) stopVoiceRecording(true);
    messagesRef.current.forEach((message) => {
      if (message.voiceNote) URL.revokeObjectURL(message.voiceNote.audioUrl);
    });
    discardVoiceDraft();
    nextId.current = 2;
    sessionId.current = crypto.randomUUID();
    loadingRef.current = false;
    setQueuedMessages([]);
    orderLinesRef.current = [];
    pendingOrderRequestsRef.current = [];
    awaitingAdditionalProductRef.current = false;
    lastQuotedProductRef.current = null;
    queuedAdditionalProductRef.current = null;
    setMessages([firstMessage]);
    setConversationLanguage("en");
    setStage("discover");
    setSuggestions(initialSuggestions);
    setQuery("");
    setQueryError("");
    setAttachment(null);
    setAttachmentError("");
    setLoading(false);
    setPendingProduct(null);
    setPendingQuantity(null);
    setPendingQuote(null);
    setConfirmedProduct(null);
    setLastProducts([]);
    setCheckingStock(false);
    setExportError("");
    setRecordingSeconds(0);
    setVoiceTranscript("");
    setVoiceError("");
  }

  function reset() {
    resetConversation(welcome);
  }

  function resetByCommand() {
    resetConversation({
      id: 1,
      role: "assistant",
      text: "Memory cleared. We’re starting fresh with Sia Huat. What product are you looking for?",
    });
  }

  async function saveConversationAsPdf() {
    if (exportingPdf) return;
    setExportingPdf(true);
    setExportError("");

    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 16;
      const boxWidth = pageWidth - margin * 2;
      const textWidth = boxWidth - 10;
      const lineHeight = 4.8;
      let y = 18;

      const addHeader = () => {
        pdf.setTextColor(21, 54, 47);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(18);
        pdf.text("Sia Huat Conversation Transcript", margin, y);
        y += 7;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(102, 122, 116);
        const generated = new Intl.DateTimeFormat("en-SG", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Singapore",
        }).format(new Date());
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

      addHeader();

      for (const message of messages) {
        const products = [
          ...(message.products ?? []),
          ...(message.selectedProduct ? [message.selectedProduct] : []),
        ];
        const productText = products.map((product) => [
          product.name,
          `code: ${product.stock_id}`,
          `Price: $${Number(product.list_price).toFixed(2)} / ${product.uom_id}`,
          productStockLabel(product),
          product.source_url ?? "",
        ].filter(Boolean).join("\n")).join("\n\n");
        const body = pdfSafeText([
          message.imageUrl ? "[Product photo attached]" : "",
          message.voiceNote ? `[Voice note - ${voiceTime(message.voiceNote.durationSeconds)}]\nTranscript: ${message.text}` : message.text,
          productText,
        ].filter(Boolean).join("\n\n"));
        const lines = pdf.splitTextToSize(body, textWidth) as string[];
        const label = `${message.role === "user" ? "You (customer)" : "Claire (assistant)"} - ${message.time ?? ""}`;
        let lineIndex = 0;

        while (lineIndex < lines.length) {
          if (pageHeight - margin - y < 30) addPage();
          const availableHeight = pageHeight - margin - y - 15;
          const linesOnPage = Math.max(1, Math.floor(availableHeight / lineHeight));
          const chunk = lines.slice(lineIndex, lineIndex + linesOnPage);
          const boxHeight = 15 + chunk.length * lineHeight;

          pdf.setFillColor(message.role === "user" ? 223 : 247, message.role === "user" ? 243 : 247, message.role === "user" ? 233 : 245);
          pdf.setDrawColor(210, 220, 216);
          pdf.rect(margin, y, boxWidth, boxHeight, "FD");
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(9);
          pdf.setTextColor(23, 104, 83);
          pdf.text(lineIndex === 0 ? label : `${label} (continued)`, margin + 5, y + 6);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(9.5);
          pdf.setTextColor(51, 75, 68);
          pdf.text(chunk, margin + 5, y + 12, { lineHeightFactor: 1.25 });

          y += boxHeight + 5;
          lineIndex += chunk.length;
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
      const filename = `sia-huat-conversation-${date}.pdf`;
      const blob = pdf.output("blob");
      if (blob.size === 0) throw new Error("Generated PDF was empty.");

      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
    } catch (error) {
      console.error("[chat] PDF download failed", error);
      setExportError("The PDF could not be downloaded. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  }

  function handleSuggestion(item: string) {
    if (item === "Download enquiry PDF" || item === "下载询价 PDF") {
      void saveConversationAsPdf();
      return;
    }
    void submit(item);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(query); }

  return <div onPaste={handleImagePaste} className="conversation-export min-w-0 w-full max-w-[490px] rounded-[2.5rem] bg-[#112f29] p-2 shadow-[0_35px_90px_rgba(21,54,47,.24)] sm:rounded-[3.3rem] sm:p-3">
    <div className="chat-phone flex h-[70dvh] min-h-[540px] min-w-0 flex-col overflow-hidden rounded-[2rem] bg-[#f8f5ee] sm:rounded-[2.55rem] lg:h-[min(720px,calc(100dvh-3rem))] lg:min-h-[560px]">
      <header className="chat-screen-header flex min-w-0 items-center gap-2 bg-[#176853] px-3 py-4 text-white sm:gap-3 sm:px-5 sm:py-5"><div className="grid size-10 shrink-0 place-items-center rounded-full bg-[#efad3f] text-sm font-bold text-[#15362f] sm:size-11">C</div><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold sm:text-base">Claire · Sia Huat</h2><p className="flex items-center gap-1.5 text-xs text-white/75"><span className="size-2 rounded-full bg-[#efad3f]" /> demo assistant</p></div><div className="print-hide flex shrink-0 items-center gap-0.5 sm:gap-1"><Button aria-label="Download conversation PDF" title="Download conversation PDF" disabled={exportingPdf} variant="ghost" className="h-9 rounded-full px-2 text-white hover:bg-white/10 hover:text-white sm:px-2.5" onClick={() => void saveConversationAsPdf()}>{exportingPdf ? <LoaderCircle className="size-4 animate-spin" /> : <FileDown className="size-4" />}<span className="hidden text-[11px] font-semibold min-[350px]:inline">PDF</span></Button><Button aria-label="Reset conversation" size="icon" variant="ghost" className="size-9 rounded-full text-white hover:bg-white/10 hover:text-white" onClick={reset}><RotateCcw className="size-4" /></Button></div></header>
      <div className="chat-transcript chat-grid flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
        {messages.map((message) => <div key={message.id} className={`chat-message min-w-0 overflow-hidden ${message.role === "user" ? "ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-[#dff3e9] p-3 text-sm shadow-sm sm:max-w-[82%]" : "max-w-full rounded-2xl rounded-tl-sm bg-white p-3 text-sm shadow-sm sm:max-w-[94%] sm:p-4"}`}>
          {message.imageUrl && <Image src={message.imageUrl} alt="Uploaded product" width={320} height={220} unoptimized className="mb-3 max-h-48 w-full rounded-xl bg-white/60 object-contain" />}
          {message.voiceNote ? <VoiceNotePlayer note={message.voiceNote} /> : <WhatsAppText text={message.text} />}
          {message.products && message.products.length > 0 && <div className="mt-3 space-y-2 border-t border-[#15362f]/10 pt-3">{message.products.map((product, index) => <div key={product.stock_id} className="rounded-xl bg-[#f5f1e8] p-3"><button type="button" disabled={product.stock_status === "out_of_stock"} onClick={() => chooseProduct(product, String(index + 1))} className={`block w-full text-left ${product.stock_status === "out_of_stock" ? "cursor-not-allowed opacity-80" : ""}`}><p className="break-words font-semibold leading-5"><span className="mr-1 text-[#176853]">{index + 1}.</span>{product.name}</p><p className="mt-2 text-xs text-[#667a74]">{conversationLanguage === "zh" ? "商品代码" : "code"}: {product.stock_id}</p><div className="mt-1 flex flex-wrap items-center gap-2"><p className="text-xs text-[#667a74]">{conversationLanguage === "zh" ? "价格" : "Price"}: ${Number(product.list_price).toFixed(2)} / {product.uom_id}</p><Badge className={`shrink-0 whitespace-nowrap ${product.stock_status === "out_of_stock" ? "bg-[#a94732]" : "bg-[#176853]"}`}>{productStockLabel(product, conversationLanguage)}</Badge></div></button>{product.source_url && <a href={product.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-[11px] font-semibold text-[#176853]">{product.source_url} <ExternalLink className="size-3 shrink-0" /></a>}</div>)}<p className="pt-1 text-xs font-medium text-[#176853]">{productOptionPrompt(message.products, conversationLanguage)}</p></div>}
          {message.selectedProduct && <div className="mt-3 rounded-xl bg-[#f5f1e8] p-3"><p className="break-words font-semibold">{message.selectedProduct.name}</p><p className="mt-2 text-xs text-[#667a74]">{conversationLanguage === "zh" ? "商品代码" : "code"}: {message.selectedProduct.stock_id}</p><p className="mt-1 text-xs text-[#667a74]">{conversationLanguage === "zh" ? "价格" : "Price"}: ${Number(message.selectedProduct.list_price).toFixed(2)} / {message.selectedProduct.uom_id}</p>{message.selectedProduct.source_url && <a href={message.selectedProduct.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-[11px] font-semibold text-[#176853]">{message.selectedProduct.source_url} <ExternalLink className="size-3 shrink-0" /></a>}</div>}
           {message.needsConfirmation && pendingProduct?.stock_id === message.selectedProduct?.stock_id && <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" disabled={checkingStock} onClick={() => void confirmProduct()} className="rounded-full bg-[#176853] hover:bg-[#125441]">{checkingStock ? <LoaderCircle className="size-4 animate-spin" /> : conversationLanguage === "zh" ? "是的，就是这个" : "Yes, this is it"}</Button><Button type="button" disabled={checkingStock} onClick={() => rejectProduct()} variant="outline" className="rounded-full border-[#176853]/25 text-[#176853]">{conversationLanguage === "zh" ? "不是，查看其他" : "No, show others"}</Button></div>}
          {message.time && <MessageTimestamp role={message.role} time={message.time} />}
        </div>)}
        {loading && <div aria-label="Sia Huat is typing" aria-live="polite" className="flex w-fit items-center gap-1.5 rounded-2xl bg-white px-4 py-3 shadow-sm"><i className="typing-dot" /><i className="typing-dot" /><i className="typing-dot" /></div>}
        {!loading && suggestions.length > 0 && <div className="chat-suggestions flex flex-wrap gap-2">{suggestions.map((item) => <button key={item} onClick={() => handleSuggestion(item)} className="rounded-full border border-[#176853]/20 bg-white/90 px-3 py-2 text-xs font-medium text-[#176853] hover:bg-white">{item}</button>)}</div>}
        <div ref={conversationEnd} />
      </div>
      <div className="chat-composer border-t border-[#15362f]/10 bg-white p-3">
        {exportError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{exportError}</p>}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageInput} className="sr-only" aria-label="Choose product image" />
        {!recordingVoice && !voiceDraft && (attachment ? <div className="mb-2 flex items-center gap-3 rounded-2xl border border-[#176853]/20 bg-[#f3f7f4] p-2">
          <Image src={attachment.dataUrl} alt="Selected product preview" width={56} height={56} unoptimized className="size-14 rounded-xl object-cover" />
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[#334b44]">{attachment.name}</p><p className="text-[11px] text-[#667a74]">Ready to send</p></div>
          <Button type="button" size="icon" variant="ghost" aria-label="Remove product image" onClick={() => setAttachment(null)} className="size-8 rounded-full"><X className="size-4" /></Button>
        </div> : <button type="button" aria-label="Paste, drop, or choose a product image" onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDraggingImage(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDraggingImage(false)} onDrop={handleImageDrop} className={`mb-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed px-3 py-2 text-xs transition ${draggingImage ? "border-[#176853] bg-[#e8f4ee] text-[#176853]" : "border-[#176853]/25 bg-[#fafaf8] text-[#667a74] hover:bg-[#f3f7f4]"}`}>
          <ImagePlus className="size-4" /> Paste, drop, or click to add a product photo
        </button>)}
        {attachmentError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{attachmentError}</p>}
        {voiceError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{voiceError}</p>}
        {queryError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{queryError}</p>}
        {recordingVoice && <div className="flex min-w-0 items-center gap-2 rounded-full bg-[#f3f3f0] p-1.5 pl-2">
          <Button type="button" aria-label="Cancel voice recording" title="Cancel" onClick={() => stopVoiceRecording(true)} size="icon" variant="ghost" className="size-9 shrink-0 rounded-full text-[#a94732]"><Trash2 className="size-4" /></Button>
          <div className="flex min-w-0 flex-1 items-center gap-2"><span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" /><div className="min-w-0"><p className="truncate text-xs font-semibold text-[#334b44]">Recording {voiceTime(recordingSeconds)}</p><p className="truncate text-[10px] text-[#667a74]">{voiceTranscript || "Speak now…"}</p></div></div>
          <Button type="button" aria-label="Stop voice recording" title="Stop recording" onClick={() => stopVoiceRecording()} size="icon" className="size-10 shrink-0 rounded-full bg-[#176853] hover:bg-[#125441]"><Square className="size-3.5 fill-current" /></Button>
        </div>}
        {transcribingVoice && !voiceDraft && !loading && <div role="status" className="flex items-center justify-center gap-2 rounded-2xl border border-[#176853]/15 bg-[#f3f7f4] px-4 py-3 text-sm font-medium text-[#176853]"><LoaderCircle className="size-4 animate-spin" />Finishing voice message…</div>}
        {voiceDraft && <div className="rounded-2xl border border-[#176853]/15 bg-[#f3f7f4] p-2.5">
          <div className="flex min-w-0 items-center gap-2"><div className="min-w-0 flex-1"><VoiceNotePlayer note={voiceDraft} /></div><Button type="button" aria-label="Delete voice note" title="Delete voice note" disabled={transcribingVoice} onClick={discardVoiceDraft} size="icon" variant="ghost" className="size-9 shrink-0 rounded-full text-[#a94732]"><Trash2 className="size-4" /></Button><Button type="button" aria-label="Send voice note" title="Send voice note" disabled={loading || transcribingVoice} onClick={() => void sendVoiceDraft()} size="icon" className="size-10 shrink-0 rounded-full bg-[#ef6b3b] hover:bg-[#da592d]">{transcribingVoice ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}</Button></div>
          {transcribingVoice && <p role="status" className="mt-2 px-2 text-xs font-medium text-[#176853]">Understanding voice message…</p>}
        </div>}
        {!recordingVoice && !voiceDraft && !transcribingVoice && <form onSubmit={handleSubmit} className="flex min-w-0 gap-2"><Input aria-label="Product question" value={query} maxLength={500} onChange={(event) => { setQuery(event.target.value); if (queryError) setQueryError(""); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(query); } }} placeholder={stage === "quantity" ? `Enter quantity in ${confirmedProduct?.uom_id ?? "units"}…` : attachment ? "Add a note, or send the photo…" : "Ask about a product…"} className="h-12 min-w-0 rounded-full border-0 bg-[#f3f3f0] px-4 sm:px-5" />{query.trim() || attachment ? <Button type="submit" aria-label="Send question" disabled={loading} size="icon" className="size-12 shrink-0 rounded-full bg-[#ef6b3b] hover:bg-[#da592d]"><Send className="size-4" /></Button> : <Button type="button" aria-label="Record voice note" title="Record voice note" disabled={loading} onClick={() => void startVoiceRecording()} size="icon" className="size-12 shrink-0 rounded-full bg-[#176853] hover:bg-[#125441]"><Mic className="size-5" /></Button>}</form>}
      </div>
    </div>
  </div>;
}
