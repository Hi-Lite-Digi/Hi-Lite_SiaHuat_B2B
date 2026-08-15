"use client";

import Image from "next/image";
import { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ExternalLink, FileDown, ImagePlus, LoaderCircle, RotateCcw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type {
  ChatReply,
  ImageAttachment,
  Product,
} from "@/lib/chat-contract";
import { requestedProductIndex, requestedQuantity } from "@/lib/chat-turn";

type QuoteSummary = {
  item: string;
  code: string;
  pricePerItem: number;
  quantity: number;
  total: number;
  uom: string;
  sourceUrl?: string | null;
};

type ChatMessage = { id: number; role: "user" | "assistant"; text: string; imageUrl?: string; products?: Product[]; selectedProduct?: Product; needsConfirmation?: boolean; quoteSummary?: QuoteSummary };

type LiveStockCheck = {
  inStock: boolean;
  availableQuantity: number | null;
  stockStatus: "in_stock" | "out_of_stock" | "unknown";
  priceExGst: number;
  checkedAt: string;
  sourceUrl: string;
};

function productStockLabel(product: Product) {
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

function singaporeTime() {
  return new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Singapore",
  }).format(new Date());
}

function pdfSafeText(value: string) {
  return value
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

  return <p aria-label={`${status} at ${time}`} className={`mt-2 min-h-4 text-[10px] leading-4 text-[#667a74]/80 ${role === "user" ? "text-right" : "text-left"}`}>
    <span suppressHydrationWarning>{status} · {time}</span>
  </p>;
}

const welcome: ChatMessage = { id: 1, role: "assistant", text: "Hey! I’m Claire from Sia Huat 👋\n\nLooking for something? Just tell me the item, brand or SKU. I’ll show you the closest matches and prices, then help prepare the enquiry once we’ve got the right one." };
const initialSuggestions = ["Chef knives", "Glassware", "Coffee beans", "Search by SKU"];

export function ChatDemo() {
  const [messages, setMessages] = useState<ChatMessage[]>([welcome]);
  const [query, setQuery] = useState("");
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
  const nextId = useRef(2);
  const sessionId = useRef(crypto.randomUUID());
  const conversationEnd = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const queuedMessages = useRef<string[]>([]);
  const messagesRef = useRef(messages);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageTimes = useRef(new Map<number, string>());
  const brainTurnQueue = useRef<Promise<void>>(Promise.resolve());

  function contentForBrain(message: ChatMessage) {
    const productOptions = message.products?.map(
      (product, index) => `Option ${index + 1}: ${product.name} (code: ${product.stock_id}, $${Number(product.list_price).toFixed(2)}/${product.uom_id})`,
    ) ?? [];
    const selected = message.selectedProduct
      ? [`Selected item shown: ${message.selectedProduct.name} (code: ${message.selectedProduct.stock_id})`]
      : [];
    const quote = message.quoteSummary
      ? [`Order summary: ${message.quoteSummary.quantity} ${message.quoteSummary.uom} of ${message.quoteSummary.item} (code: ${message.quoteSummary.code})`]
      : [];
    return [message.text, ...productOptions, ...selected, ...quote].filter(Boolean).join("\n");
  }

  function brainHistory() {
    return messagesRef.current.slice(1).map((message) => ({
      role: message.role,
      content: contentForBrain(message),
    }));
  }

  function syncHandledTurnWithN8n(message: string) {
    const requestSession = sessionId.current;
    const history = brainHistory();
    brainTurnQueue.current = brainTurnQueue.current.then(async () => {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: requestSession, message, history, brain: "n8n" }),
      });
      if (!response.ok) {
        console.error("[chat] n8n handled-turn sync failed", { status: response.status, message });
      }
    }).catch((error) => {
      console.error("[chat] n8n handled-turn sync failed", { message, error });
    });
  }

  function timeForMessage(messageId: number) {
    const existing = messageTimes.current.get(messageId);
    if (existing) return existing;
    const time = singaporeTime();
    messageTimes.current.set(messageId, time);
    return time;
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

  useEffect(() => {
    messagesRef.current = messages;
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading, suggestions]);

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

  function showOrderReview(quantity: number, product: Product, userText?: string) {
    const quote = quoteFor(quantity, product);
    setMessages((current) => [...current,
      ...(userText ? [{ id: nextId.current++, role: "user" as const, text: userText }] : []),
      {
        id: nextId.current++, role: "assistant" as const,
        text: "Please review this enquiry. If everything is correct, choose Confirm order request. No purchase has been placed yet.",
        quoteSummary: quote,
      },
    ]);
    setPendingQuantity(null);
    setPendingQuote(quote);
    setQuery("");
    setStage("clarify");
    setSuggestions(["Confirm order request", "Change quantity", "Choose another item"]);
  }

  function showQuantityLimit(userText: string, quantity: number, product: Product, limit: number) {
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      {
        id: nextId.current++, role: "assistant", selectedProduct: product,
        text: `The live Sia Huat Add to cart check shows only ${limit} ${product.uom_id} available, so I can’t prepare ${quantity}.\n\nWould you like ${limit} ${product.uom_id}, or would you prefer another option instead?`,
      },
    ]);
    setQuery(""); setStage(limit > 0 ? "quantity" : "clarify");
    setSuggestions(limit > 0 ? [String(limit), "Choose another item"] : ["Choose another item", "No, thank you"]);
  }

  function showRememberedQuantityLimit(quantity: number, product: Product, limit: number) {
    setMessages((current) => [...current, {
      id: nextId.current++, role: "assistant", selectedProduct: product,
      text: `Only ${limit} ${product.uom_id} of ${product.name} ${limit === 1 ? "is" : "are"} currently available, but you requested ${quantity} ${product.uom_id}.\n\nWould you like all ${limit} ${product.uom_id}, or would you prefer another option?`,
    }]);
    setPendingQuantity(null); setStage(limit > 0 ? "quantity" : "clarify");
    setSuggestions(limit > 0 ? [String(limit), "Choose another item"] : ["Choose another item", "No, thank you"]);
  }

  async function submit(value: string) {
    const clean = value.trim() || (attachment ? "What product is this?" : "");
    if (!clean) return;
    if (/^\/\/reset sia huat$/i.test(clean)) {
      resetByCommand();
      return;
    }
    if (loadingRef.current) {
      queuedMessages.current.push(clean);
      setQuery("");
      return;
    }

    if (pendingQuote && /^(?:yes[,.!\s]*)?(?:confirm|confirmed|confirm order request|place the enquiry|submit for review)([.!\s]*)$/i.test(clean)) {
      syncHandledTurnWithN8n(clean);
      const confirmedQuote = pendingQuote;
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        {
          id: nextId.current++, role: "assistant",
          text: "Thank you for confirming. I’ve recorded this as an enquiry for Sia Huat staff review. No purchase has been placed yet; the sales team will confirm the final order with you.",
          quoteSummary: confirmedQuote,
        },
      ]);
      setPendingQuote(null);
      setStage("submitted");
      setSuggestions(["Choose another item"]);
      setQuery("");
      return;
    }

    if (pendingProduct && /^(yes|yes please|yup|yeah|correct|this is it|confirm|(?:yes[,\s-]*)?(?:that's|thats) the one)([.!\s]*)$/i.test(clean)) {
      syncHandledTurnWithN8n(clean); setQuery(""); confirmProduct(clean); return;
    }

    if (pendingProduct && /^(no|nope|wrong item|not this|(?:no[,\s-]*)?(?:that's|thats) not it|no[,\s-]*(?:show|give)( me)? (the )?(other|others|alternatives|options))([.!\s]*)$/i.test(clean)) {
      syncHandledTurnWithN8n(clean); setQuery(""); rejectProduct(clean); return;
    }

    const requestedIndex = requestedProductIndex(clean, lastProducts.length);
    if (!pendingProduct && requestedIndex !== null) {
      const product = lastProducts[requestedIndex];
      if (product) {
        syncHandledTurnWithN8n(clean);
        setQuery("");
        chooseProduct(product, clean);
        return;
      }
    }

    if (clean === "Change quantity" && confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      setPendingQuote(null);
      setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean }, { id: nextId.current++, role: "assistant", text: `Sure. How many ${confirmedProduct.uom_id} of ${confirmedProduct.name} do you need?`, selectedProduct: confirmedProduct }]);
      setStage("quantity"); setSuggestions(["1", "6", "12", "24"]); return;
    }

    if (clean === "Choose another item") {
      syncHandledTurnWithN8n(clean);
      const excludedStockId = confirmedProduct?.stock_id ?? pendingProduct?.stock_id;
      const alternatives = lastProducts.filter((product) => product.stock_id !== excludedStockId);
      setPendingProduct(null); setPendingQuantity(null); setPendingQuote(null); setConfirmedProduct(null); setStage("clarify");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        {
          id: nextId.current++, role: "assistant",
          text: alternatives.length > 0
            ? "Of course. Here are the other catalogue options. Which one would you like?"
            : "Of course. Tell me another style, size, brand or item code and I’ll find a different option for you.",
          products: alternatives,
        },
      ]);
      setSuggestions(alternatives.length > 0 ? [] : ["Search again", "Search by SKU"]); return;
    }

    if (confirmedProduct?.stock_status === "out_of_stock" && /^(no|no thanks|no thank you|not now)$/i.test(clean)) {
      syncHandledTurnWithN8n(clean);
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: "No problem. Thank you for checking with Sia Huat. If you need another item later, I’ll be happy to help." },
      ]);
      setQuery(""); setSuggestions([]); setStage("complete"); return;
    }

    if (clean === "Continue for staff review" && confirmedProduct) {
      syncHandledTurnWithN8n(clean);
      if (pendingQuantity) {
        const quantity = pendingQuantity;
        setMessages((current) => [...current,
          { id: nextId.current++, role: "user", text: clean },
          { id: nextId.current++, role: "assistant", text: `I’ve recorded ${quantity} ${confirmedProduct.uom_id} of ${confirmedProduct.name} for staff to verify. They will confirm the available quantity and final price.`, selectedProduct: confirmedProduct },
        ]);
        setPendingQuantity(null); setStage("submitted"); setSuggestions(["Choose another item"]); return;
      }
      setStage("quantity");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: `Okay. The website does not confirm stock for this item, so the final quantity will require staff verification. How many ${confirmedProduct.uom_id} do you need?`, selectedProduct: confirmedProduct },
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
      const quantity = quantityText ? Number.parseInt(quantityText, 10) : Number.NaN;

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100_000) {
        setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean }, { id: nextId.current++, role: "assistant", text: `Please enter a whole-number quantity in ${confirmedProduct.uom_id}, for example 6 or 12.`, selectedProduct: confirmedProduct }]);
        setQuery("");
        setSuggestions(["1", "6", "12", "24"]); return;
      }

      const limit = availableLimit(confirmedProduct);
      if (limit !== null && quantity > limit) {
        showQuantityLimit(clean, quantity, confirmedProduct, limit); return;
      }

      showOrderReview(quantity, confirmedProduct, clean); return;
    }

    if (pendingQuote) {
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: clean },
        { id: nextId.current++, role: "assistant", text: "I haven’t submitted this enquiry yet. Please choose Confirm order request, Change quantity, or Choose another item." },
      ]);
      setQuery("");
      setSuggestions(["Confirm order request", "Change quantity", "Choose another item"]);
      return;
    }

    await brainTurnQueue.current;
    const history = brainHistory();
    const attachedImage = attachment;

    const requestSession = sessionId.current;
    setMessages((current) => [...current, { id: nextId.current++, role: "user", text: clean, imageUrl: attachedImage?.dataUrl }]);
    setQuery(""); setAttachment(null); setAttachmentError(""); setSuggestions([]); loadingRef.current = true; setLoading(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: requestSession,
          message: clean,
          history,
          ...(attachedImage ? { image: attachedImage } : {}),
        }),
      });
      const reply = await response.json() as ChatReply & { error?: string };
      if (sessionId.current !== requestSession) return;
      if (!response.ok) throw new Error(reply.error ?? "The assistant could not answer right now.");
      const products = reply.products ?? [];
      setLastProducts(products);

      if (reply.selectedProduct) {
        const product = reply.selectedProduct;
        const quantity = requestedQuantity(clean);
        setPendingProduct(product); setPendingQuantity(quantity); setConfirmedProduct(null); setStage("clarify"); setSuggestions([]);
        setLastProducts((current) => current.some((item) => item.stock_id === product.stock_id) ? current : [product, ...current]);
        setMessages((current) => [...current, {
          id: nextId.current++, role: "assistant", needsConfirmation: true, selectedProduct: product,
          text: quantity
            ? `Please confirm this is the correct item.\n\nQuantity requested: ${quantity} ${product.uom_id}.`
            : "I found this item in the catalogue. Is this the exact item you want?",
        }]);
        return;
      }

      setStage(reply.stage); setSuggestions(reply.suggestions ?? []);
      setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: reply.message, products }]);
    } catch (reason) {
      if (sessionId.current !== requestSession) return;
      setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: reason instanceof Error ? reason.message : "The assistant could not answer right now." }]);
    } finally {
      if (sessionId.current !== requestSession) return;
      loadingRef.current = false;
      setLoading(false);
      const queued = queuedMessages.current.shift();
      if (queued) {
        setTimeout(() => void submit(queued), 0);
      }
    }
  }

  function chooseProduct(product: Product, userText = `This one: ${product.name}`) {
    if (loading) return;
    if (product.stock_status === "out_of_stock") {
      setPendingProduct(null); setPendingQuantity(null); setConfirmedProduct(product); setStage("clarify");
      setMessages((current) => [...current,
        { id: nextId.current++, role: "user", text: userText },
        {
          id: nextId.current++, role: "assistant", selectedProduct: product,
          text: `This item is currently out of stock. The live Sia Huat Add to cart check shows Available: 0 ${product.uom_id}.\n\nWould you like me to show you another option instead?`,
        },
      ]);
      setSuggestions(["Choose another item", "No, thank you"]); return;
    }
    const quantity = requestedQuantity(userText);
    setPendingProduct(product); setPendingQuantity(quantity); setPendingQuote(null); setConfirmedProduct(null); setStage("clarify"); setSuggestions([]);
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      {
        id: nextId.current++, role: "assistant",
        text: quantity
          ? `Please confirm this is the correct item.\n\nQuantity requested: ${quantity} ${product.uom_id}.`
          : "Just to confirm, is this the exact item you want?",
        selectedProduct: product,
        needsConfirmation: true,
      },
    ]);
  }

  async function confirmProduct(userText = "Yes, this is the item.") {
    if (!pendingProduct || checkingStock) return;
    const product = pendingProduct;
    setPendingProduct(null); setPendingQuote(null); setConfirmedProduct(product); setStage("clarify"); setSuggestions([]); setCheckingStock(true);
    const quantity = pendingQuantity;
    setMessages((current) => [...current, { id: nextId.current++, role: "user", text: userText }]);

    try {
      const response = await fetch("/api/stock-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stockId: product.stock_id }),
      });
      const check = await response.json() as LiveStockCheck & { error?: string };
      if (!response.ok) throw new Error(check.error ?? "Live stock check failed.");
      const liveProduct: Product = { ...product, list_price: check.priceExGst, in_stock: check.inStock, available_quantity: check.availableQuantity, stock_status: check.stockStatus, source_url: check.sourceUrl };
      setConfirmedProduct(liveProduct);
      if (check.stockStatus === "in_stock") {
        if (quantity !== null && check.availableQuantity === null) {
          setStage("clarify");
          setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `I have your request for ${quantity} ${product.uom_id}, but the available quantity could not be confirmed. Would you like another option, or should Sia Huat staff verify it?`, selectedProduct: liveProduct }]);
          setSuggestions(["Continue for staff review", "Choose another item"]);
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
        const availableText = check.availableQuantity === null
          ? "The website shows it as in stock, but did not return an exact quantity."
          : `Available: ${check.availableQuantity} ${product.uom_id}.`;
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `${availableText}\n\nHow many ${product.uom_id} do you need?`, selectedProduct: liveProduct }]);
        setSuggestions(quantitySuggestions(check.availableQuantity));
      } else if (check.stockStatus === "out_of_stock") {
        setStage("clarify");
        setPendingQuantity(null);
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `${product.name} is currently out of stock. Would you like me to show you another option instead?`, selectedProduct: liveProduct }]);
        setSuggestions(["Choose another item", "No, thank you"]);
      } else {
        setStage("clarify");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: quantity
          ? `I have your request for ${quantity} ${product.uom_id}, but the available quantity could not be confirmed. Would you like another option, or should Sia Huat staff verify it?`
          : "The available quantity could not be confirmed. Would you like another option, or should Sia Huat staff verify this item?", selectedProduct: liveProduct }]);
        setSuggestions(["Choose another item", "Continue for staff review"]);
      }
    } catch (error) {
      if (quantity !== null) {
        setStage("clarify");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `I have your request for ${quantity} ${product.uom_id}, but the available quantity and price could not be confirmed. Would you like Sia Huat staff to verify it?`, selectedProduct: product }]);
        setSuggestions(["Continue for staff review", "Choose another item"]);
      } else {
        setStage("quantity");
        setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: `${error instanceof Error ? error.message : "Stock could not be confirmed."}\n\nHow many ${product.uom_id} do you need for staff verification?`, selectedProduct: product }]);
        setSuggestions(["1", "6", "12", "24"]);
      }
    } finally {
      setCheckingStock(false);
    }
  }

  function rejectProduct(userText = "No, that’s not the item.") {
    if (!pendingProduct) return;
    const alternatives = lastProducts.filter((product) => product.stock_id !== pendingProduct.stock_id);
    setPendingProduct(null); setPendingQuantity(null); setPendingQuote(null); setStage("clarify");
    setMessages((current) => [...current,
      { id: nextId.current++, role: "user", text: userText },
      { id: nextId.current++, role: "assistant", text: alternatives.length > 0 ? "No problem. Here are the other catalogue options and prices. Which one is closer?" : "No problem. Tell me another name, brand or detail and I’ll search again.", products: alternatives },
    ]);
    setSuggestions(alternatives.length > 0 ? [] : ["Search again", "Search by SKU"]);
  }

  function resetConversation(firstMessage: ChatMessage) {
    nextId.current = 2;
    messageTimes.current.clear();
    sessionId.current = crypto.randomUUID();
    loadingRef.current = false;
    queuedMessages.current = [];
    brainTurnQueue.current = Promise.resolve();
    setMessages([firstMessage]);
    setStage("discover");
    setSuggestions(initialSuggestions);
    setQuery("");
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
          message.text,
          productText,
          message.quoteSummary ? [
            `Item: ${message.quoteSummary.item}`,
            `Code: ${message.quoteSummary.code}`,
            `Price per item (ex GST): $${message.quoteSummary.pricePerItem.toFixed(2)} / ${message.quoteSummary.uom}`,
            `Quantity: ${message.quoteSummary.quantity}`,
            `Total (ex GST): $${message.quoteSummary.total.toFixed(2)}`,
          ].join("\n") : "",
        ].filter(Boolean).join("\n\n"));
        const lines = pdf.splitTextToSize(body, textWidth) as string[];
        const label = `${message.role === "user" ? "You (customer)" : "Claire (assistant)"} - ${timeForMessage(message.id)}`;
        let lineIndex = 0;

        while (lineIndex < lines.length) {
          if (pageHeight - margin - y < 30) addPage();
          const availableHeight = pageHeight - margin - y - 15;
          const linesOnPage = Math.max(1, Math.floor(availableHeight / lineHeight));
          const chunk = lines.slice(lineIndex, lineIndex + linesOnPage);
          const boxHeight = 15 + chunk.length * lineHeight;

          pdf.setFillColor(message.role === "user" ? 223 : 247, message.role === "user" ? 243 : 247, message.role === "user" ? 233 : 245);
          pdf.setDrawColor(210, 220, 216);
          pdf.roundedRect(margin, y, boxWidth, boxHeight, 3, 3, "FD");
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
      const url = URL.createObjectURL(pdf.output("blob"));
      const download = document.createElement("a");
      download.href = url;
      download.download = filename;
      document.body.appendChild(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      console.error("[chat] PDF download failed", error);
      setExportError("The PDF could not be downloaded. Please try again.");
    } finally {
      setExportingPdf(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(query); }

  return <div onPaste={handleImagePaste} className="conversation-export min-w-0 w-full max-w-[490px] rounded-[2.5rem] bg-[#112f29] p-2 shadow-[0_35px_90px_rgba(21,54,47,.24)] sm:rounded-[3.3rem] sm:p-3">
    <div className="chat-phone flex h-[70dvh] min-h-[540px] min-w-0 flex-col overflow-hidden rounded-[2rem] bg-[#f8f5ee] sm:rounded-[2.55rem] lg:h-[min(720px,calc(100dvh-3rem))] lg:min-h-[560px]">
      <header className="chat-screen-header flex min-w-0 items-center gap-2 bg-[#176853] px-3 py-4 text-white sm:gap-3 sm:px-5 sm:py-5"><div className="grid size-10 shrink-0 place-items-center rounded-full bg-[#efad3f] text-sm font-bold text-[#15362f] sm:size-11">C</div><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold sm:text-base">Claire · Sia Huat</h2><p className="flex items-center gap-1.5 text-xs text-white/75"><span className="size-2 rounded-full bg-[#5be08f]" /> online</p></div><div className="print-hide flex shrink-0 items-center gap-0.5 sm:gap-1"><Button aria-label="Download conversation PDF" title="Download conversation PDF" disabled={exportingPdf} variant="ghost" className="h-9 rounded-full px-2 text-white hover:bg-white/10 hover:text-white sm:px-2.5" onClick={() => void saveConversationAsPdf()}>{exportingPdf ? <LoaderCircle className="size-4 animate-spin" /> : <FileDown className="size-4" />}<span className="hidden text-[11px] font-semibold min-[350px]:inline">PDF</span></Button><Button aria-label="Reset conversation" size="icon" variant="ghost" className="size-9 rounded-full text-white hover:bg-white/10 hover:text-white" onClick={reset}><RotateCcw className="size-4" /></Button></div></header>
      <div className="chat-transcript chat-grid flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
        {messages.map((message) => <div key={`${sessionId.current}-${message.id}`} className={`chat-message min-w-0 overflow-hidden ${message.role === "user" ? "ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-[#dff3e9] p-3 text-sm shadow-sm sm:max-w-[82%]" : "max-w-full rounded-2xl rounded-tl-sm bg-white p-3 text-sm shadow-sm sm:max-w-[94%] sm:p-4"}`}>
          {message.imageUrl && <Image src={message.imageUrl} alt="Uploaded product" width={320} height={220} unoptimized className="mb-3 max-h-48 w-full rounded-xl bg-white/60 object-contain" />}
          <p className="whitespace-pre-line leading-6 text-[#334b44]">{message.text}</p>
          {message.quoteSummary && <div className="mt-3 overflow-hidden rounded-xl border border-[#176853]/15 bg-[#f8f5ee]">
            <div className="bg-[#176853] px-3 py-2 text-xs font-semibold uppercase tracking-[.12em] text-white">Order summary</div>
            <dl className="divide-y divide-[#15362f]/10 px-3 text-xs text-[#526861]">
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-2.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3"><dt>Item</dt><dd className="min-w-0 break-words font-semibold leading-5 text-[#15362f]">{message.quoteSummary.item}<span className="mt-0.5 block break-all text-[11px] font-normal text-[#667a74]">code: {message.quoteSummary.code}</span></dd></div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-2.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3"><dt>Price per item</dt><dd className="min-w-0 break-words font-semibold text-[#15362f]">${message.quoteSummary.pricePerItem.toFixed(2)} / {message.quoteSummary.uom}<span className="ml-1 text-[10px] font-normal text-[#667a74]">ex GST</span></dd></div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-2.5 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3"><dt>Quantity</dt><dd className="font-semibold text-[#15362f]">{message.quoteSummary.quantity} {message.quoteSummary.uom}</dd></div>
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 py-3 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3"><dt className="font-semibold text-[#15362f]">Total</dt><dd className="min-w-0 break-words text-base font-bold text-[#176853]">${message.quoteSummary.total.toFixed(2)}<span className="ml-1 text-[10px] font-normal text-[#667a74]">ex GST</span></dd></div>
            </dl>
            {message.quoteSummary.sourceUrl && <a href={message.quoteSummary.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 border-t border-[#15362f]/10 px-3 py-2.5 text-[11px] font-semibold text-[#176853]">View Sia Huat listing <ExternalLink className="size-3" /></a>}
          </div>}
          {message.products && message.products.length > 0 && <div className="mt-3 space-y-2 border-t border-[#15362f]/10 pt-3">{message.products.map((product) => <div key={product.stock_id} className="rounded-xl bg-[#f5f1e8] p-3"><button type="button" onClick={() => chooseProduct(product)} className="block w-full text-left"><p className="break-words font-semibold leading-5">{product.name}</p><p className="mt-2 text-xs text-[#667a74]">code: {product.stock_id}</p><div className="mt-1 flex flex-wrap items-center gap-2"><p className="text-xs text-[#667a74]">Price: ${Number(product.list_price).toFixed(2)} / {product.uom_id}</p><Badge className={`shrink-0 whitespace-nowrap ${product.stock_status === "out_of_stock" ? "bg-[#a94732]" : "bg-[#176853]"}`}>{productStockLabel(product)}</Badge></div></button>{product.source_url && <a href={product.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-[11px] font-semibold text-[#176853]">{product.source_url} <ExternalLink className="size-3 shrink-0" /></a>}</div>)}</div>}
          {message.selectedProduct && <div className="mt-3 rounded-xl bg-[#f5f1e8] p-3"><p className="break-words font-semibold">{message.selectedProduct.name}</p><p className="mt-2 text-xs text-[#667a74]">code: {message.selectedProduct.stock_id}</p><p className="mt-1 text-xs text-[#667a74]">Price: ${Number(message.selectedProduct.list_price).toFixed(2)} / {message.selectedProduct.uom_id}</p>{message.selectedProduct.source_url && <a href={message.selectedProduct.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1 break-all text-[11px] font-semibold text-[#176853]">{message.selectedProduct.source_url} <ExternalLink className="size-3 shrink-0" /></a>}</div>}
           {message.needsConfirmation && pendingProduct?.stock_id === message.selectedProduct?.stock_id && <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" disabled={checkingStock} onClick={() => void confirmProduct()} className="rounded-full bg-[#176853] hover:bg-[#125441]">{checkingStock ? <LoaderCircle className="size-4 animate-spin" /> : "Yes, this is it"}</Button><Button type="button" disabled={checkingStock} onClick={() => rejectProduct()} variant="outline" className="rounded-full border-[#176853]/25 text-[#176853]">No, show others</Button></div>}
          <MessageTimestamp role={message.role} time={timeForMessage(message.id)} />
        </div>)}
        {loading && <div aria-label="Sia Huat is typing" aria-live="polite" className="flex w-fit items-center gap-1.5 rounded-2xl bg-white px-4 py-3 shadow-sm"><i className="typing-dot" /><i className="typing-dot" /><i className="typing-dot" /></div>}
        {!loading && suggestions.length > 0 && <div className="chat-suggestions flex flex-wrap gap-2">{suggestions.map((item) => <button key={item} onClick={() => void submit(item)} className="rounded-full border border-[#176853]/20 bg-white/90 px-3 py-2 text-xs font-medium text-[#176853] hover:bg-white">{item}</button>)}</div>}
        <div ref={conversationEnd} />
      </div>
      <div className="chat-composer border-t border-[#15362f]/10 bg-white p-3">
        {exportError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{exportError}</p>}
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageInput} className="sr-only" aria-label="Choose product image" />
        {attachment ? <div className="mb-2 flex items-center gap-3 rounded-2xl border border-[#176853]/20 bg-[#f3f7f4] p-2">
          <Image src={attachment.dataUrl} alt="Selected product preview" width={56} height={56} unoptimized className="size-14 rounded-xl object-cover" />
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[#334b44]">{attachment.name}</p><p className="text-[11px] text-[#667a74]">Ready to send</p></div>
          <Button type="button" size="icon" variant="ghost" aria-label="Remove product image" onClick={() => setAttachment(null)} className="size-8 rounded-full"><X className="size-4" /></Button>
        </div> : <button type="button" aria-label="Paste, drop, or choose a product image" onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDraggingImage(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDraggingImage(false)} onDrop={handleImageDrop} className={`mb-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed px-3 py-2 text-xs transition ${draggingImage ? "border-[#176853] bg-[#e8f4ee] text-[#176853]" : "border-[#176853]/25 bg-[#fafaf8] text-[#667a74] hover:bg-[#f3f7f4]"}`}>
          <ImagePlus className="size-4" /> Paste, drop, or click to add a product photo
        </button>}
        {attachmentError && <p role="alert" className="mb-2 px-2 text-xs text-red-600">{attachmentError}</p>}
        <form onSubmit={handleSubmit} className="flex min-w-0 gap-2"><Input aria-label="Product question" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(query); } }} placeholder={stage === "quantity" ? `Enter quantity in ${confirmedProduct?.uom_id ?? "units"}…` : attachment ? "Add a note, or send the photo…" : "Ask about a product…"} className="h-12 min-w-0 rounded-full border-0 bg-[#f3f3f0] px-4 sm:px-5" /><Button type="submit" aria-label="Send question" disabled={(!query.trim() && !attachment) || loading} size="icon" className="size-12 shrink-0 rounded-full bg-[#ef6b3b] hover:bg-[#da592d]"><Send className="size-4" /></Button></form>
      </div>
    </div>
  </div>;
}
