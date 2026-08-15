/**
 * Final customer-facing copy guard shared by every Claire response path.
 *
 * This intentionally makes only mechanical edits. Product facts and response
 * meaning remain untouched; the n8n prompt and deterministic handlers remain
 * responsible for the actual answer.
 */
export function normalizeClaireMessage(message: string) {
  return message
    .replace(/\s*\u2014\s*([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s*\u2014\s*/g, ". ")
    .replace(/\s+\u2013\s+([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s+\u2013\s+/g, ". ")
    .replace(/\s+-\s+([a-z])/g, (_match, letter: string) => `. ${letter.toUpperCase()}`)
    .replace(/\s+-\s+/g, ", ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

