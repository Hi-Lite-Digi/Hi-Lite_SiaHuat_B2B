import type { Product } from "./chat-contract";

/** Requirements that keyword overlap alone cannot safely establish. */
export function matchesProductRequirements(request: string, product: Pick<Product, "name" | "description" | "size" | "dimensions">) {
  const text = [product.name, product.description, product.size, product.dimensions].filter(Boolean).join(" ");
  const origin = request.match(/\b(japanese|taiwanese)[ -]?made\b|\bmade\s+in\s+(japan|taiwan)\b/i);
  if (origin) {
    const country = /japan/i.test(origin[0]) ? "Japan" : "Taiwan";
    // A Japanese blade shape or imported steel does not establish manufacture.
    if (!new RegExp(`\\b(?:made|manufactured|crafted|produced)\\s+in\\s+${country}\\b|\\bcountry\\s+of\\s+origin\\s*[:=-]?\\s*${country}\\b`, "i").test(text)) return false;
  }
  if (/\bfine[ -]?mesh\b/i.test(request) && !/\bfine[ -]?mesh\b/i.test(text)) return false;
  if (/\bforged\s+premium\s+handle\b/i.test(request) && !/\bforged\s+premium\s+handle\b/i.test(product.name)) return false;
  if (/\b(?:sashimi|yanagiba|yanagi)\b/i.test(request)
    && (!/\b(?:sashimi|yanagiba|yanagi)\b/i.test(product.name) || /\b(?:plate|stand|tray)\b/i.test(product.name))) return false;
  if (/\byanagiba\b/i.test(request) && !/\b(?:yanagiba|yanagi)\b/i.test(product.name)) return false;
  if (/\btoasters?\b/i.test(request) && /\b(?:slots?|pop[ -]?up)\b/i.test(request)) {
    if (/\bconveyor\b/i.test(product.name)) return false;
    const choice = request.match(/\b(\d+)\s*(?:or|\/)\s*(\d+)\s*[ -]?slots?\b/i);
    const counts = choice ? [Number(choice[1]), Number(choice[2])] : [Number(request.match(/\b(\d+)[ -]?slots?\b/i)?.[1])].filter(Boolean);
    const actual = [...text.matchAll(/\b(\d+)[ -]?slots?\b/gi)].map(match => Number(match[1]));
    if (!actual.length && !/\bpop[ -]?up\b/i.test(text)) return false;
    if (counts.length && !actual.some(count => counts.includes(count))) return false;
  }
  if (/\b(?:electric|cordless|powered)\b[\s\S]*\bwhisk\b/i.test(request)) {
    if (/\b(?:accs|accessor(?:y|ies)|attachment|manual\s+whisk)\b/i.test(product.name)) return false;
    if (!/\b(?:mixer|blender|electric\s+whisk)\b/i.test(product.name)) return false;
    if (!/\b(?:whisks?|whisking|beaters?)\b/i.test(text)) return false;
    if (/\bcordless\b/i.test(request) && !/\bcordless\b/i.test(text)) return false;
    if (/\b(?:3[ -]?in[ -]?1|three[ -]?in[ -]?one)\b/i.test(request)
      && !/\b3[ -]?in[ -]?1\b/i.test(text)
      && !(/\bblender\b/i.test(text) && /\bwhisk\b/i.test(text) && /\bchopp(?:er|ing)\b/i.test(text))) return false;
    if (/\b(?:home|handheld)\b/i.test(request) && /\b(?:planetary|dough|stand)\s+mixer\b/i.test(product.name)) return false;
  }
  return true;
}

/** Search concise catalogue terms; enforce the full requirements afterwards. */
export function requirementLookupQuery(request: string) {
  // Retrieve the family before enforcing dimensions: listings commonly use
  // the inch symbol while customers type "inch" or "inches".
  if (/\bsteak\s+tongs?\b/i.test(request)) return "steak tong";
  if (/\bcooking\s+tongs?\b/i.test(request)) return "tong";
  if (/\btoasters?\b/i.test(request) && /\b(?:slots?|pop[ -]?up)\b/i.test(request)) return "toaster";
  if (/\b(?:cordless)\b[\s\S]*\bwhisks?\b/i.test(request)) return "cordless";
  if (/\b(?:electric|powered)\b[\s\S]*\bwhisks?\b/i.test(request)) return "hand mixer";
  if (/\bfine[ -]?mesh\b/i.test(request) && /\b(?:strainer|skimmer|colander)\b/i.test(request)) return "fine mesh";
  if (/\b(?:sashimi|yanagiba|yanagi)\b/i.test(request)) return "sashimi knife";
  return null;
}
