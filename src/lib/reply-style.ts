import type { ChatReply } from "./chat-contract";

/** Observable WhatsApp-style requirements; catalogue truth is checked separately. */
export function replyStyleIssues(reply: Pick<ChatReply, "message" | "products" | "selectedProduct">) {
  const issues: string[] = [];
  if (reply.message.length > 600) issues.push("Keep the reply within 600 characters; product cards already contain the details.");
  if ((reply.message.match(/[?？]/g) ?? []).length > 1) issues.push("Ask only one focused question.");
  if (/\b(?:would|could|can|what|which|do|does|is|are)\b[^?？]{0,120}\b(?:size|smaller|larger)\b[^?？]{0,70}\b(?:colou?r|material)\b[^?？]*[?？]|\b(?:would|could|can|what|which|do|does|is|are)\b[^?？]{0,120}\b(?:colou?r|material)\b[^?？]{0,70}\b(?:size|smaller|larger)\b[^?？]*[?？]/i.test(reply.message)) {
    issues.push("Ask about only one missing attribute; do not bundle size with colour or material.");
  }
  if (/\b(?:Noted|Kindly|Please be advised|current online catalogue|saved requirements|staff review summary|knowledge base)\b/i.test(reply.message)) {
    issues.push("Use plain, friendly customer language without internal labels or scripted phrases.");
  }
  if (!reply.products.length && !reply.selectedProduct
    && /\b(?:these (?:are|aren['’]?t|arenot|have)|both(?: of)? (?:these|those)|these (?:two|three|options|products)|(?:options?|products?|items?|choices?|matches) (?:below|above|shown)|(?:see|choose from|pick from) (?:the )?(?:below|following))\b/i.test(reply.message)) {
    issues.push("There are no visible product cards. Do not refer to these options, both, or products below; describe the missing match directly.");
  }
  if (/\b([\p{L}\p{N}]+(?:[ \t]+[\p{L}\p{N}]+){1,6})[ \t]*\n[ \t]*\1\b/iu.test(reply.message)) {
    issues.push("Remove the repeated phrase across the line break.");
  }
  return issues;
}
