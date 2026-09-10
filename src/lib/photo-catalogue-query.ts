/** Search for the main object identified by vision, not a component in its description. */
export function photoCatalogueQuery(message: string, imageCategory?: string | null): string {
  const subject = imageCategory?.trim() || message;
  if (/\bshakers?\b/i.test(subject)) {
    const finish = /\bcopper\b/i.test(message) ? "copper" : "";
    const type = /\b(?:salt|pepper|sugar)\b/i.test(subject)
      ? subject.match(/\b(?:salt|pepper|sugar)\b/i)![0]
      : "cocktail";
    const style = type === "cocktail" ? message.match(/\b(?:cobbler|boston|french)\b/i)?.[0]?.toLowerCase() : "";
    return [finish, style, type, "shaker"].filter(Boolean).join(" ");
  }
  if (/\b(?:camtainer|insulated beverage (?:dispenser|server)|(?:beverage|drink|tea) (?:dispenser|server))\b/i.test(subject)) return "Cambro Camtainer insulated beverage dispenser";
  if (/\b(?:(?:utility|storage|dish|bus|cutlery|rectangular|multi[\s-]?purpose) (?:box|bin)|cambox)\b/i.test(subject)) return "plastic utility box Cambox storage box";
  if (/\b(?:coffee|spice) grinder\b/i.test(subject)) return "coffee grinder";
  if (/\b(?:shoe|shoes|footwear|boot|boots)\b/i.test(subject)) return "work shoes";
  if (/\b(?:knife|knives|cleaver)\b/i.test(subject)) return "chef knife cleaver";
  if (/\b(?:strainer|skimmer|colander|sieve)\b/i.test(subject)) return "food strainer skimmer colander";
  return subject;
}
