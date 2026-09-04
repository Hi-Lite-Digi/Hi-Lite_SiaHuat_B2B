function centimetres(value: string, unit: string) {
  const numeric = Number.parseFloat(value);
  if (/^mm$/i.test(unit)) return numeric / 10;
  if (/^(?:inch|inches|in|\")$/i.test(unit)) return numeric * 2.54;
  return numeric;
}

/** Keep GN pan/lid identity and fit details out of the generic frying-pan query path. */
export function normalizeFoodPanCatalogueQuery(message: string) {
  const fraction = message.match(/\b1\s*\/\s*(?:2|4)\b/)?.[0]?.replace(/\s+/g, "") ?? "";
  const isFoodPan = /\b(?:gn|gastronorm|food)\s*pan\b/i.test(message)
    || Boolean(fraction && /\bpans?\b/i.test(message) && /\b(?:deep|lids?|covers?)\b/i.test(message));
  if (!isFoodPan) return null;

  const material = /\b(?:stainless(?:\s+steel)?|s\s*\/\s*s)\b/i.test(message) ? "stainless steel" : "";
  const isLid = /\b(?:lids?|covers?)\b/i.test(message);
  const slotted = /\b(?:slot(?:ted)?|notch(?:ed)?|cut[ -]?out)\b/i.test(message) ? "slotted" : "";
  const depth = message.match(/\b\d+(?:\.\d+)?\s*(?:inch|inches|in|\")\s*deep\b/i)?.[0]?.replace(/\"/g, " inch") ?? "";

  return isLid
    ? `${material} ${fraction} ${slotted} GN food pan lid`.replace(/\s+/g, " ").trim()
    : `${material} ${fraction} ${depth} GN food pan`.replace(/\s+/g, " ").trim();
}

/** Match a requested food-pan depth against the catalogue's mm/cm/inch depth label. */
export function foodPanDepthConstraintMatches(requested: string, candidate: string) {
  const request = requested.match(/\b(\d+(?:\.\d+)?)\s*(mm|cm|inch|inches|in|\")\s*deep\b/i);
  if (!request) return null;
  const requestedCm = centimetres(request[1], request[2]);
  const candidateDepths = [
    ...candidate.matchAll(/\b(\d+(?:\.\d+)?)\s*(mm|cm|inch|inches|in|\")\s*deep\b/gi),
    ...candidate.matchAll(/\bdeep\s*(?:[:=-]\s*)?(\d+(?:\.\d+)?)\s*(mm|cm|inch|inches|in|\")\b/gi),
  ].map((match) => centimetres(match[1], match[2]));
  return candidateDepths.some((depth) => Math.abs(depth - requestedCm) <= 0.6);
}

/** Lexical search should find the oyster family first; handle material is filtered afterwards. */
export function catalogueLookupOverride(query: string) {
  if (/\boyster\s+kn(?:ife|ives)\b/i.test(query)) return "oyster knife";
  const foodPanFraction = query.match(/\b1\s*\/\s*(?:2|4)\b/)?.[0]?.replace(/\s+/g, "");
  if (foodPanFraction
    && /\b(?:gn|gastronorm|food)\s*pan\b/i.test(query)
    && !/\b(?:lids?|covers?)\b/i.test(query)
    && /\b6\s*(?:inch|inches|in|\")\s*deep\b/i.test(query)) {
    const material = /\bstainless(?:\s+steel)?\b/i.test(query) ? "stainless steel " : "";
    return `${material}food pan ${foodPanFraction} size 150mm`;
  }
  return null;
}

export function hasPlasticLikeHandle(value: string) {
  return /\b(?:plastic|pom)\b[\s\S]*\bhandle\b|\bhandle\b[\s\S]*\b(?:plastic|pom)\b/i.test(value);
}

export function requestedLadleCapacitiesOz(message: string) {
  if (!/\bladles?\b/i.test(message)) return [];
  return [...new Set(
    [...message.matchAll(/\b(\d+(?:\.\d+)?)\s*oz\b/gi)].map((match) => Number.parseFloat(match[1])),
  )];
}

/** 2 = explicitly labelled ounces, 1 = a close ml/cc equivalent, 0 = wrong capacity. */
export function ladleCapacityMatchQuality(candidate: string, requestedOz: number) {
  const ounceMatch = [...candidate.matchAll(/\b(\d+(?:\.\d+)?)\s*oz\b/gi)]
    .some((match) => Math.abs(Number.parseFloat(match[1]) - requestedOz) <= 0.05);
  if (ounceMatch) return 2;
  const metricMatch = [...candidate.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:ml|cc)\b/gi)]
    .some((match) => Math.abs((Number.parseFloat(match[1]) / 29.5735) - requestedOz) <= 0.15);
  return metricMatch ? 1 : 0;
}
