export function requestedProductIndex(message: string, productCount: number) {
  const numbered = message.match(/\b(?:option|choice|item|number|no\.?)\s*#?\s*(\d+)\b/i)?.[1]
    ?? message.match(/\b(\d+)(?:st|nd|rd|th)\s+(?:option|choice|item)\b/i)?.[1];
  if (numbered) {
    const index = Number.parseInt(numbered, 10) - 1;
    return index >= 0 && index < productCount ? index : null;
  }

  const ordinal = message.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|last|top|bottom)(?:\s+one)?\b/i)?.[1].toLowerCase();
  if (!ordinal) return null;
  const indexes: Record<string, number> = {
    first: 0, "1st": 0, top: 0,
    second: 1, "2nd": 1,
    third: 2, "3rd": 2,
    fourth: 3, "4th": 3,
    last: productCount - 1, bottom: productCount - 1,
  };
  const index = indexes[ordinal];
  return index >= 0 && index < productCount ? index : null;
}

export function requestedQuantity(message: string) {
  const quantityText = message.match(/\b(\d+)\s*(?:pieces?|pcs?|units?|sets?)\w*\b/i)?.[1]
    ?? message.match(/\b(?:get|want|need|order|buy|take|qty|quantity(?:\s+of)?)(?:\s+(?:no\.?|number))?\s*(\d+)\b/i)?.[1];
  if (!quantityText) return null;
  const quantity = Number.parseInt(quantityText, 10);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 100_000 ? quantity : null;
}
