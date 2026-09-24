const honestDenial = /\bno (?:staff member|sales(?:person| representative| staff| team)?|sourcing request)\b[^.!?]{0,60}\b(?:notified|contacted|alerted|sent|started)\b|\b(?:has|have|was|were|is|are) not (?:been )?(?:notified|contacted|alerted|sent)\b/i;

const unsupportedClaim = /\b(?:alerted|notified|contacted|flagged|informed)\s+(?:a |an |our |the )?(?:human colleague|staff member|team member|sales(?:person| representative| staff| team)?|support team|team)\b|\b(?:human colleague|staff member|team member|sales(?:person| representative| staff| team)?|support team|team)\b[^.!?]{0,35}\b(?:has|have|was|were|is|are)\s+(?:already\s+)?(?:been\s+)?(?:alerted|notified|contacted|flagged|informed)\b|\b(?:human|manual) sourcing\b[^.!?]{0,35}\b(?:in progress|underway|started)\b|\b(?:a human colleague|sales(?:person| representative| staff| team)?|support team|staff member|team member|they|someone)\b[^.!?]{0,35}\b(?:will|shall|should|can)\s+(?:contact|call|message|reply|reach out|get back to|follow up with|join)\s+(?:you|the customer|this (?:chat|conversation))\b|\b(?:hand|send|forward|escalate|pass|transfer)(?:ed|ing)?\s+(?:this|it|your (?:request|enquiry|details|case))\s+to\s+(?:a |our |the )?(?:human colleague|staff member|sales(?:person| representative| staff| team)?|support team|team member)\b|\b(?:they|someone)\b[^.!?]{0,25}\b(?:will|'ll|’ll)\b[^.!?]{0,35}\b(?:5\s*[–-]\s*10 minutes|shortly|soon)\b|(?:已|已经)(?:通知|联系|转交|交给)(?:了)?(?:销售|客服|工作人员|人工)|(?:销售|客服|工作人员)(?:会|将会)(?:联系|回复)您/i;

export function honestManualHandoff(message: string) {
  const sentences = message.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [message];
  const hasUnsupportedClaim = sentences.some((sentence) => !honestDenial.test(sentence) && unsupportedClaim.test(sentence));
  if (!hasUnsupportedClaim) return message;

  const cleaned = sentences
    .filter((sentence) => honestDenial.test(sentence) || !unsupportedClaim.test(sentence))
    .join(" ")
    .replace(/\s+([.!?。！？])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  const prefix = cleaned ? `${cleaned}${/[.!?。！？]$/.test(cleaned) ? "" : "."} ` : "";
  return `${prefix}No staff member has been notified automatically. Use the PDF button and contact Sia Huat sales directly.`;
}

/**
 * An honest offer that names the wrong destination. "I can put together a
 * summary for our sales team" is true and useful, but it leaves the customer
 * without the two things they actually need: that the summary is the PDF they
 * download, and that it goes to Sia Huat sales. Naming both is the difference
 * between a next step they can take and one they cannot.
 */
export function withManualNextStep(message: string) {
  if (!/\b(?:summary|sourcing|source (?:it|them|these)|sales team)\b/i.test(message)) return message;
  let next = message.replace(/\b(?:our|the|your) sales team\b/gi, "Sia Huat sales");
  if (!/\bPDF\b/i.test(next)) next = next.replace(/\bsummary\b/i, "PDF summary");
  return next;
}
