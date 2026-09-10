import type { ChatReply } from "./chat-contract";
import { suggestionLabel } from "./enquiry-copy";

type Reply = Pick<ChatReply, "message" | "stage" | "products" | "selectedProduct" | "suggestions">;

/** Generated choices are customer answers, never new workflow commands or facts. */
export function isGroundedAnswer(answer: string, message: string) {
  const value = answer.trim();
  const question = message.match(/[^.!?。！？\n]*[?？]/g)?.at(-1) ?? "";
  if (!question || !value || value.length > 60 || /[\n?？]|https?:|\b(?:buy|pay|checkout|order now|notify|contact|call|send|download|submit|discount|free shipping)\b/i.test(value)) return false;
  // Even a bare "Yes" would be an unsupported command for a stock-check offer.
  if (/\b(?:check|confirm|verify|recheck) (?:the )?(?:live )?(?:stock|availability)\b|\bstock check\b/i.test(question)) return false;
  if (/\b(?:check|confirm|verify|recheck)\b.*\b(?:stock|availability)|\badd\b.*\b(?:enquiry|quote|cart)\b|(?:检查|查看|确认|查询)库存|加入(?:询价|报价|购物车)/i.test(value)) return false;
  // Bare numbers could be interpreted as a product index or order quantity.
  if (/^\d+$/.test(value)) return false;
  if (/^(?:yes|no)(?:,?\s+(?:please|thanks|thank you))?[.!]?$/i.test(value)) {
    return /^\s*(?:would|could|can|do|does|is|are|shall|want|will)\b/i.test(question);
  }
  if (/[\u3400-\u9fff]/.test(value)) return question.includes(value);
  const words = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const questionWords = new Set(question.toLowerCase().match(/[a-z0-9]+/g));
  const grammar = new Set("yes no i m me my the a an for of and or to both either some other another different open please thanks thank you is are would could like prefer want need keep original that this works fine okay only not use".split(" "));
  const details = words.filter(word => !grammar.has(word));
  return details.length > 0 && details.every(word => questionWords.has(word));
}

/** Keep actions tied to the final question, including when the model omits buttons. */
export function withQuickReplies<T extends Reply>(reply: T, answers: string[] = [], fallback: string[] = []): T {
  const zh = /[\u3400-\u9fff]/.test(reply.message);
  const question = reply.message.match(/[^.!?。！？\n]*[?？]/g)?.at(-1) ?? "";
  const usableAction = (value: string) => !/^(?:tell me|type (?:the|both|your)|enter (?:the|your)|send a clearer)/i.test(value);
  let choices = reply.suggestions.filter(usableAction);
  const refersToSummaryOffer = /^\s*(?:want me to|would you like me to|shall i|can i)\s+(?:do that|go ahead|prepare (?:it|that)|put that together)[?\s]*$/i.test(question)
    && /\b(?:summary|requirements|pdf)\b/i.test(reply.message) && /\b(?:sales|share)\b/i.test(reply.message);
  if (reply.selectedProduct && reply.stage === "clarify"
    && /^\s*(?:(?:just\s+)?to confirm[,—–-]?\s*)?(?:would|could|can|do|does|is|are|shall|want|will)\b/i.test(question)) {
    choices = zh ? ["是的，就是这款", "选择其他商品"] : ["Yes, this is it", "Choose another item"];
  } else if (/\b(?:summary|requirements|pdf)\b/i.test(question) && /\b(?:sales|share|prepare|put|send)\b/i.test(question)
    || /(?:摘要|需求|PDF).*(?:销售|准备|整理)|(?:准备|整理).*(?:摘要|需求)/i.test(question) || refersToSummaryOffer) {
    choices = zh ? ["准备询价摘要", "选择其他商品"] : ["Prepare sales summary", "Choose another item"];
  } else if (/\b(?:smaller|larger|different)\s+(?:size|plate|diameter)|\bsize\b.*\b(?:flexible|change)\b/i.test(question)) {
    const direction = /smaller/i.test(question) ? "smaller" : /larger/i.test(question) ? "larger" : "different";
    choices = [`A ${direction} size is fine`, "Keep the original size"];
  } else {
    const grounded = answers.filter(answer => isGroundedAnswer(answer, reply.message));
    if (grounded.length) choices = grounded;
    if (!choices.length) choices = fallback.filter(value => usableAction(value) && (!/^\d+$/.test(value) || Boolean(reply.selectedProduct)));
    if (!choices.length && reply.products.length) {
      choices = reply.products.flatMap((product, index) => product.stock_status === "out_of_stock" ? [] : [String(index + 1)]);
    }
    if (!choices.length) choices = zh ? ["帮我选择", "选择其他商品"] : ["Help me choose", "Choose another item"];
  }
  return { ...reply, suggestions: [...new Set(choices.map(suggestionLabel))].slice(0, 3) };
}

export function quickReplyLabel(value: string, products: Reply["products"], unit?: string, zh = false) {
  if (/^\d+$/.test(value)) return unit ? `${value} ${unit}` : products.length ? zh ? `选择第 ${value} 款` : `Choose option ${value}` : value;
  return suggestionLabel(value);
}

export function quickQuantityChoices(limit: number | null, zh = false) {
  const quantities = [1, 6, 12].filter(value => limit === null || value <= limit);
  return [...quantities.map(String), zh ? "选择其他商品" : "Choose another item"].slice(0, 3);
}
