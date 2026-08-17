/**
 * Final customer-facing copy guard shared by every Claire response path.
 *
 * This keeps product facts intact while removing common AI-style filler and
 * preserving short WhatsApp-like paragraphs.
 */
export function normalizeClaireMessage(message: string) {
  return message
    .replace(/^certainly[,.!:\s-]*/i, "Sure. ")
    .replace(/^based on (?:your|the) (?:request|information provided)[,.!:\s-]*/i, "")
    .replace(/\bplease be advised that\b/gi, "")
    .replace(/\bit is important to note that\b/gi, "")
    .replace(/\bi apologize\b/gi, "Sorry")
    .replace(/\bi would be happy to\b/gi, "I can")
    .replace(/\bplease let me know\b/gi, "Tell me")
    .replace(/\bwould you like me to\b/gi, "Want me to")
    .replace(/\bi am unable to\b/gi, "I can’t")
    .replace(/\bi cannot\b/gi, "I can’t")
    .replace(/\s*\u2014\s*([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s*\u2014\s*/g, ". ")
    .replace(/\s+\u2013\s+([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s+\u2013\s+/g, ". ")
    .replace(/\s+-\s+([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s+-\s+/g, ", ")
    .replace(/\.\s*\./g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
