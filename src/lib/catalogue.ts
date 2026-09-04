import "server-only";
import { z } from "zod";
import { productSchema, type Product } from "@/lib/chat-contract";
import { metricDimensionConstraintsMatch } from "@/lib/catalogue-dimensions";
import {
  catalogueLookupOverride,
  foodPanDepthConstraintMatches,
  hasPlasticLikeHandle,
  normalizeFoodPanCatalogueQuery,
} from "@/lib/catalogue-query";

const productSearchSchema = productSchema.extend({ score: z.coerce.number() });

const catalogueProductSchema = productSchema.extend({ source_url: z.string().url() });

const productSelect = [
  "stock_id",
  "name",
  "brand_id",
  "status",
  "list_price",
  "uom_id",
  "source_url",
  "image_url",
  "description",
  "size",
  "dimensions",
  "brand",
  "model",
  "in_stock",
  "available_quantity",
  "stock_status",
  "category",
  "subcategory",
  "third_category",
  "last_scraped_at",
].join(",");

const productUseCases = [
  {
    key: "food-strainer",
    label: "food or noodle strainer",
    search: "noodle strainer colander",
    request: /\b(?:noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b[\s\S]*\b(?:strainer|skimmer|colander|sieve)\b|\b(?:strainer|skimmer|colander|sieve)\b[\s\S]*\b(?:noodles?|maggi|food|kitchen|cooking|drain(?:ing)?|colander|sieve)\b/i,
    candidate: /^(?![\s\S]*\b(?:bar|cocktail|liquor|julep|hawthorne)\b)[\s\S]*\b(?:colander|sieve|noodle\s+strainer|mesh\s+(?:skimmer|strainer)|(?:food|kitchen)\s+strainer)\b/i,
  },
  { key: "omelette-pan", label: "omelette pan", search: "omelette pan", request: /\bomele+t+e?\b/i, candidate: /\bomele+t+e?\b/i },
  { key: "crepe-pan", label: "crepe pan", search: "crepe pan", request: /\bcrepes?\b/i, candidate: /\bcrepes?\b/i },
  { key: "pancake-pan", label: "pancake pan", search: "pancake pan", request: /\bpancakes?\b/i, candidate: /\bpancakes?\b/i },
  { key: "frying-pan", label: "frying pan", search: "frying pan", request: /\b(?:fry|frying)\s*pan\b/i, candidate: /\b(?:fry|frying)\s*pan\b|\bfrypan\b|\bskillet\b/i },
  { key: "grill-pan", label: "grill pan", search: "grill pan", request: /\bgrill\s*pan\b/i, candidate: /\bgrill\s*pan\b/i },
  { key: "saucepan", label: "saucepan", search: "saucepan", request: /\bsauce\s*pan\b|\bsaucepan\b/i, candidate: /\bsauce\s*pan\b|\bsaucepan\b/i },
] as const;

export function detectProductUseCase(message: string) {
  return productUseCases.find((useCase) => useCase.request.test(message)) ?? null;
}

function searchableProductText(product: Product) {
  return [
    product.name,
    product.brand,
    product.brand_id,
    product.model,
    product.description,
    product.size,
    product.dimensions,
    product.category,
    product.subcategory,
    product.third_category,
  ].filter(Boolean).join(" ");
}

export function matchesProductUseCase(product: Product, useCase: NonNullable<ReturnType<typeof detectProductUseCase>>) {
  return useCase.candidate.test(searchableProductText(product));
}

function looseToken(value: string) {
  return value.toLowerCase().replace(/([a-z0-9])\1+/g, "$1").replace(/[^a-z0-9]/g, "");
}

function brandPreferenceScore(message: string, product: Product) {
  const request = looseToken(message);
  const brandTokens = [product.brand, product.brand_id]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/[^a-z0-9]+/i))
    .map(looseToken)
    .filter((value) => value.length >= 3);
  return brandTokens.some((brand) => request.includes(brand)) ? 1 : 0;
}

export function matchesRequestedBrand(message: string, product: Product) {
  return brandPreferenceScore(message, product) > 0;
}

export function requestedBrandLabel(message: string, products: Product[]) {
  const matchedProduct = products.find((product) => matchesRequestedBrand(message, product));
  const catalogueBrand = matchedProduct?.brand ?? matchedProduct?.brand_id;
  if (catalogueBrand) return catalogueBrand.trim();

  const explicitBrand = message.match(/\b([a-z][a-z0-9-]{2,})\s+brand\b/i)?.[1];
  if (!explicitBrand) return null;
  const normalized = looseToken(explicitBrand);
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : null;
}

export function prioritizeBrand(message: string, products: Product[]) {
  return [...products].sort((a, b) => brandPreferenceScore(message, b) - brandPreferenceScore(message, a));
}

export function normalizeCatalogueQuery(message: string) {
  const ukToEuro: Record<string, string> = {
    "3": "36", "3.5": "37", "4": "37", "4.5": "38", "5": "38", "5.5": "39",
    "6": "39", "6.5": "40", "7": "41", "7.5": "41", "8": "42", "8.5": "42",
    "9": "43", "9.5": "44", "10": "44", "10.5": "45", "11": "45", "12": "46",
  };
  const corrected = message
    .replace(/\bche+f+f?\b/gi, "chef")
    .replace(/\b(?:knfie|kinife|knive)\b/gi, "knife")
    .replace(/\b(?:fryng|fryin)\b/gi, "frying")
    .replace(/\b(?:noodal|noodel|noodles?)\b/gi, "noodle")
    .replace(/\b(?:strainner|straner|strainn?er)\b/gi, "strainer")
    .replace(/\bshows\b/gi, "shoes")
    .replace(/\b(?:bananna|bannana)\b/gi, "banana")
    .replace(/\buk\s*(?:size\s*)?(\d{1,2}(?:\.5)?)\b/gi, (match, size: string) => ukToEuro[size] ? `Euro Size ${ukToEuro[size]}` : match)
    .replace(/\banot\b/gi, " ");
  const cleaned = corrected
    .replace(/\b(hey|hi|hello|sure|wait|tell me|i am|i'm|im|i|we are|we're|can you|could you|please|do you|do u|does sia huat|would you|you guys|sia huat|guys|you|your|u)\b/gi, " ")
    .replace(/\b(need|want|looking for|look for|search for|search|find me|find|show me|show|have|sell|selling|carry|stock|price|pricing|cost|how much|add|also|while|there|too|a|an|some|the|and|or|if)\b/gi, " ")
    .replace(/[^a-z0-9'\-/\s]/gi, " ")
    .replace(/\b(?:no\s+preference|any\s+material)\b/gi, " ")
    .replace(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:pieces?|pcs?|units?|sets?|pairs?)\b/gi, " ")
    .replace(/\b(?:a|one|two|three|four|five|six|half)?\s*dozen\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bknives\b/gi, "knife")
    .replace(/\bgrinders\b/gi, "grinder")
    .replace(/^\d+\s+(?=[a-z])/i, "");

  const foodPanQuery = normalizeFoodPanCatalogueQuery(cleaned);
  if (foodPanQuery) return foodPanQuery;

  if (/\bpan\b/i.test(cleaned)) {
    const kind = detectProductUseCase(cleaned)?.search ?? cleaned.match(/\b(non[ -]?stick|frying|sauce|grill)\b/i)?.[0] ?? "";
    const colour = cleaned.match(/\b(red|yellow|blue|black|white|green|silver)\b/i)?.[0] ?? "";
    const size = cleaned.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|in)\b/i)?.[0] ?? "";
    const material = cleaned.match(/\b(stainless(?:\s+steel)?|black\s+steel|carbon\s+steel|cast\s+iron|aluminium|aluminum|non[ -]?stick)\b/i)?.[0] ?? "";
    const foodPanFraction = cleaned.match(/\b1\s*\/\s*(?:2|4)\b/)?.[0]?.replace(/\s+/g, "") ?? "";
    const foodPanDepth = cleaned.match(/\b\d+(?:\.\d+)?\s*(?:inch|inches|in)\s*deep\b/i)?.[0] ?? "";
    if (/\b(?:gn|gastronorm|food)\s*pan\b/i.test(cleaned) || (foodPanFraction && /\bdeep\b/i.test(cleaned))) {
      return `${material} ${foodPanFraction} ${foodPanDepth} GN food pan`.replace(/\s+/g, " ").trim();
    }
    return `${colour} ${size} ${material} ${kind}${kind.toLowerCase().endsWith("pan") ? "" : " pan"}`.replace(/\s+/g, " ").trim();
  }

  return cleaned;
}

function catalogueLookupQuery(query: string) {
  const override = catalogueLookupOverride(query);
  if (override) return override;
  if (/\bcambox\b/i.test(query)) return "cambox";
  if (/\b(?:(?:utility|storage|dish|bus|cutlery|rectangular|multi[\s-]?purpose)\s+(?:box|boxes|bin|bins)|cambox)\b/i.test(query)) {
    return "utility box";
  }
  return query
    .replace(/\bexcluding\s+brand\s+[a-z0-9&' -]+$/i, " ")
    .replace(/\bdark\s+colou?r\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:-|to|through)\s*\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesExplicitConstraints(query: string, product: Product) {
  const requested = query.toLowerCase();
  const candidate = searchableProductText(product).toLowerCase();
  const productName = product.name.toLowerCase();
  const excludedBrand = requested.match(/\bexcluding\s+brand\s+([a-z0-9&' -]+)$/i)?.[1]?.trim();
  if (excludedBrand) {
    const excluded = looseToken(excludedBrand);
    const catalogueBrands = [product.brand, product.brand_id]
      .filter((value): value is string => Boolean(value))
      .map(looseToken);
    if (excluded && catalogueBrands.some((brand) => brand === excluded || brand.includes(excluded) || excluded.includes(brand))) {
      return false;
    }
  }
  const requestsUtensils = /\b(?:kitchen\s+)?utensils?\b/.test(requested);
  const requestsUtensilAccessory = /\b(?:storage|stand|organizer|hanger|holder|rack)\b/.test(requested);
  const requestsPoweredWhisk = /\b(?:electric|cordless|powered)\b[\s\S]*\bwhisks?\b|\bwhisks?\b[\s\S]*\b(?:electric|cordless|powered)\b|\bnot\s+manual\b/.test(requested);
  if (requestsPoweredWhisk) {
    if (/\b(?:accessor(?:y|ies)|accs|attachment|manual)\b/.test(productName)) return false;
    if (!/\b(?:electric|cordless|powered|mixer|blender)\b/.test(candidate)) return false;
    if (!/\b(?:whisks?|blenders?|mixer|3[ -]?in[ -]?1|three[ -]?in[ -]?one)\b/.test(candidate)) return false;
  }
  const requestsManualGrinder = /\bmanual\b/.test(requested)
    && /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/.test(requested)
    && !/\b(?:not|no|non[ -]?)\s*manual\b/.test(requested);
  if (requestsManualGrinder && !/\bmanual\b/.test(candidate)) return false;
  if (/\bsteak\s+tongs?\b/.test(requested) && !/\bsteak\s+tongs?\b/.test(candidate)) return false;
  if (/\bcooking\s+tongs?\b/.test(requested)) {
    if (!/\b(?:cooking|kitchen|steak)\s+tongs?\b|\btongs?\b[\s\S]*\b(?:cooking|kitchen|steak)\b/.test(candidate)) return false;
    if (/\b(?:serving|snail|sugar|ice)\s+tongs?\b/.test(productName)) return false;
  }
  if (/\bserving\s+tongs?\b/.test(requested) && !/\bserving\s+tongs?\b/.test(candidate)) return false;
  if (/\b(?:complete\s+)?dining\s+sets?\b/.test(requested)) {
    if (!/\bsets?\b/.test(productName) || !/\b(?:dining|dinnerware|tableware|plates?|bowls?)\b/.test(candidate)) return false;
    if (/\bramekins?\b/.test(productName) && !/\b(?:plates?|bowls?)\b/.test(productName)) return false;
  }
  if (/\btoasters?\b/.test(requested)) {
    const rejectsConveyor = /\b(?:pop[ -]?up|non[ -]?conveyor|not\s+(?:a\s+)?conveyor|no\s+conveyor|without\s+(?:a\s+)?conveyor|(?:\d+|four|six)(?:\s+or\s+(?:\d+|four|six))?\s*slots?)\b/.test(requested);
    if (rejectsConveyor && /\bconveyor\b/.test(candidate)) return false;
  }
  if (/\b(?:cassette\s+)?gas\s+torch(?:\s+burners?)?\b|\btorch\s+burners?\b/.test(requested)) {
    if (!/\b(?:gas\s+)?torch\s+burners?\b|\btorch\b[\s\S]*\bburner\b/.test(candidate)) return false;
    if (/\bcartridges?\b/.test(productName)) return false;
  }
  if (/\b(?:(?:utility|storage|dish|bus|cutlery|rectangular|multi[\s-]?purpose)\s+(?:box|boxes|bin|bins)|cambox)\b/.test(requested)
    && (!/\b(?:(?:utility|storage|dish|bus|cutlery|rectangular|multi[\s-]?purpose)\s+(?:box|boxes|bin|bins)|cambox)\b/.test(productName)
      || /\b(?:pail|bucket)\b/.test(productName))) return false;
  if (requestsUtensils) {
    if (!/\b(?:utensils?|spatulas?|turners?|whisks?|peelers?|tongs?|ladles?|spoons?|forks?)\b/.test(candidate)) return false;
    if (!requestsUtensilAccessory && /\b(?:storage\s+stand|counter\s+organizer|wall\s+hanger|utensil\s+(?:holder|rack)|(?:holder|rack)\s+for\s+utensils?)\b/.test(productName)) return false;
  }
  if (/\bserving\s+spoons?\b/.test(requested) && !/\bserving\s+spoons?\b/.test(productName)) return false;
  if (/\bladles?\b/.test(requested) && !/\bladles?\b/.test(productName)) return false;
  if (/\b(?:gn\s+food\s+pan\s+)?(?:lids?|covers?)\b/.test(requested)) {
    if (!/\b(?:lids?|covers?)\b/.test(productName)) return false;
    const lidFraction = requested.match(/\b1\s*\/\s*([24])\b/)?.[1];
    if (lidFraction && !new RegExp(`\\b1\\s*\\/\\s*${lidFraction}\\b`).test(candidate)) return false;
    if (/\bslotted\b/.test(requested) && !/\b(?:slot(?:ted)?|notch(?:ed)?|cut[ -]?out)\b/.test(candidate)) return false;
  }
  const foodPanRequest = /\b(?:gn|gastronorm|food)\s*pan\b/.test(requested)
    && !/\b(?:lids?|covers?)\b/.test(requested);
  if (foodPanRequest) {
    if (!/\b(?:gn|gastronorm|food)\s*pan\b|\bpan\b[\s\S]*\b(?:1\s*\/\s*[24]|100|150|200)\b/.test(candidate)) return false;
    const fraction = requested.match(/\b1\s*\/\s*([24])\b/)?.[1];
    if (fraction && !new RegExp(`\\b1\\s*\\/\\s*${fraction}\\b`).test(candidate)) return false;
    const depthMatches = foodPanDepthConstraintMatches(requested, candidate);
    if (depthMatches === false) return false;
  }
  if (/\bwok\s+(?:lid|cover)s?\b|\b(?:lid|cover)s?\s+(?:for\s+)?(?:a\s+)?wok\b/.test(requested)
    && !/\bwok\b[\s\S]*\b(?:lid|cover)\b|\b(?:lid|cover)\b[\s\S]*\bwok\b/.test(productName)) return false;
  if (/\b(?:knife\s+)?(?:sharpeners?|sharpening\s+(?:stone|steel)|whetstone|honing\s+steel)\b/.test(requested)
    && !/\b(?:sharpener|sharpening|whetstone|honing)\b/.test(productName)) return false;
  const requiredCategories = [
    { requested: /\bchef\b.*\bknife\b|\bknife\b.*\bchef\b/, candidate: /\bchef(?:'s|s)?\s+knife\b/ },
    { requested: /\bcleaver\b/, candidate: /\bcleaver\b/ },
    { requested: /\bboning\b/, candidate: /\bboning\b/ },
    { requested: /\bparing\b/, candidate: /\bparing\b/ },
    { requested: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/, candidate: /\bbread\b.*\bknife\b|\bknife\b.*\bbread\b/ },
    { requested: /\boyster\b.*\bknife\b|\bknife\b.*\boyster\b/, candidate: /\boyster\b.*\bknife\b|\bknife\b.*\boyster\b/ },
    { requested: /\bdamascus\b/, candidate: /\bdamascus\b/ },
    { requested: /\bknife\b(?!\s+(?:sharpener|sharpening|stone|steel))/, candidate: /\bknife|cleaver\b/ },
    { requested: /\b(?:knife\s+)?(?:sharpeners?|sharpening\s+(?:stone|steel)|whetstone|honing\s+steel)\b/, candidate: /\b(?:sharpener|sharpening|whetstone|honing)\b/ },
    { requested: /\bserving\s+spoons?\b/, candidate: /\bserving\s+spoons?\b/ },
    { requested: /\bwok\s+(?:lid|cover)s?\b|\b(?:lid|cover)s?\s+(?:for\s+)?(?:a\s+)?wok\b/, candidate: /\bwok\b[\s\S]*\b(?:lid|cover)\b|\b(?:lid|cover)\b[\s\S]*\bwok\b/ },
    { requested: /\bwoks?\b/, candidate: /\bwoks?\b/ },
    { requested: /\bpan\b/, candidate: /\bpan\b/ },
    { requested: /\b(?:plate|plates)\b/, candidate: /\b(?:plate|plates|platter|platters)\b/ },
    { requested: /\b(?:bowl|bowls)\b/, candidate: /\b(?:bowl|bowls)\b/ },
    { requested: /\b(?:cup|cups|mug|mugs)\b/, candidate: /\b(?:cup|cups|mug|mugs)\b/ },
    { requested: /\bwine\b.*\bglass/, candidate: /\bwine glass\b/ },
    { requested: /\bcoffee\b.*\bbeans?\b/, candidate: /\bcoffee beans\b/ },
    { requested: /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/, candidate: /\bgrinders?\b/ },
    { requested: /\b(?:stockpot|stockpots|stock\s+pots?)\b/, candidate: /\b(?:stockpot|stockpots|stock\s+pots?)\b/ },
    { requested: /\b(?:camtainer|(?:beverage|drink|tea)\s+(?:dispenser|server))\b/, candidate: /\b(?:camtainer|(?:beverage|drink|tea)\s+(?:dispenser|server))\b/ },
    { requested: /\bhelmets?\b/, candidate: /\bhelmets?\b/ },
    { requested: /\b(?:electrical|electric|power)\s+(?:cable|wire)s?\b/, candidate: /\b(?:cable|wire)s?\b/ },
    { requested: /\bsafety\s+vests?\b/, candidate: /\bvests?\b/ },
    { requested: /\bsafety\s+boots?\b/, candidate: /\bboots?\b/ },
    { requested: /\b(?:shoe|shoes|footwear)\b/, candidate: /\b(?:shoe|shoes|footwear)\b/ },
    { requested: /\b(?:pants|trousers)\b/, candidate: /\b(?:pants|trousers)\b/ },
  ];

  if (requiredCategories.some((rule) => rule.requested.test(requested) && !rule.candidate.test(candidate))) return false;
  const requestedUseCase = detectProductUseCase(query);
  if (requestedUseCase && !matchesProductUseCase(product, requestedUseCase)) return false;
  const requestsKnifeSharpening = /\b(?:knife\s+)?(?:sharpeners?|sharpening\s+(?:stone|steel)|whetstone|honing\s+steel)\b/.test(requested);
  if (/\bknife\b/.test(requested) && !requestsKnifeSharpening && /\b(bag|holder|guard|sharpener|sharpening|block|cover|case|screw|spare|machine|thermomix|mixing)\b/.test(productName)) return false;
  if (/\bplastic\s+handles?\b/.test(requested) && !hasPlasticLikeHandle(candidate)) return false;
  if (/\b(?:japan|japanese)\b/.test(requested) && !/\b(?:japan|japanese)\b/.test(candidate)) return false;

  const rejectsAllAluminium = /\b(?:not|no|don['’]?t|do\s+not|must\s+not)\b[^.!?]{0,45}\b(?:all\s+)?(?:aluminium|aluminum)\b/.test(requested);
  if (rejectsAllAluminium
    && /\b(?:aluminium|aluminum)\b/.test(candidate)
    && !/\b(?:steel|plastic|fibreglass|fiberglass|wood|rubber)\b/.test(candidate)) return false;

  const requestedMaterials = [
    /\bstainless(?:\s+steel)?\b/.test(requested) ? /\b(?:stainless(?:\s+steel)?|s\s*\/\s*s)\b/ : null,
    /\bblack\s+steel\b/.test(requested) ? /\bblack\s+steel\b/ : null,
    /\bcarbon\s+steel\b/.test(requested) ? /\bcarbon\s+steel\b/ : null,
    /\bcast\s+iron\b/.test(requested) ? /\bcast\s+iron\b/ : null,
    /\biron\b/.test(requested) && !/\bcast\s+iron\b/.test(requested) ? /\biron\b/ : null,
    /\baluminium|aluminum\b/.test(requested) && !rejectsAllAluminium ? /\baluminium|aluminum\b/ : null,
    /\bnon[ -]?stick\b/.test(requested) ? /\bnon[ -]?stick\b/ : null,
  ].filter((pattern): pattern is RegExp => pattern !== null);
  if (requestedMaterials.length > 0 && !requestedMaterials.some((pattern) => pattern.test(candidate))) return false;

  if (/\bdark\s+colou?r\b/.test(requested) && !/\b(?:black|brown|grey|gray|charcoal)\b/.test(candidate)) return false;

  const requestedColour = [...requested.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/g)].at(-1)?.[1];
  const requestedColourPattern = requestedColour && /gr[ae]y/.test(requestedColour)
    ? /\bgr(?:e|a)y\b/
    : requestedColour
      ? new RegExp(`\\b${requestedColour}\\b`)
      : null;
  if (requestedColourPattern && !requestedColourPattern.test(candidate)) return false;

  if (/\b(?:ladders?|step\s+stools?)\b/.test(requested)) {
    if (!/\b(?:ladders?|step\s+stools?|folding\s+stools?)\b/.test(candidate)) return false;
    const steps = requested.match(/\b(\d+)\s*[ -]?steps?\b/)?.[1];
    if (steps && !new RegExp(`\\b${steps}\\s*[ -]?steps?\\b`).test(candidate)) return false;
    if (/\bsafety\s+handrail\b/.test(requested) && !/\b(?:safety\s+)?handrail\b/.test(candidate)) return false;
    const load = requested.match(/\b(\d+(?:\.\d+)?)\s*(lb|lbs|pounds?|kg)\b/);
    if (load) {
      const alternateUnit = /^kg$/.test(load[2]) ? "kilograms?" : "pounds?";
      if (!new RegExp(`\\b${load[1]}\\s*(?:${load[2]}|${alternateUnit})\\b`).test(candidate)) return false;
    }
  }

  const metricDimensionsMatch = metricDimensionConstraintsMatch(requested, candidate);
  if (metricDimensionsMatch === false) return false;

  const requestedMetricSize = metricDimensionsMatch === null
    ? requested.match(/\b(\d+(?:\.\d+)?)\s*(cm|mm)\b/)
    : null;
  if (requestedMetricSize) {
    const [, size, unit] = requestedMetricSize;
    const metricPattern = unit === "cm"
      ? new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*cm|(?=\\s*[x×]))`, "i")
      : new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*mm|(?=\\s*[x×]))`, "i");
    if (!metricPattern.test(candidate)) return false;
  }

  const requestedCapacity = requested.match(/\b(\d+(?:\.\d+)?)\s*(?:l|litres?|liters?)\b/);
  if (requestedCapacity) {
    const capacity = requestedCapacity[1];
    const capacityPattern = new RegExp(`\\b${capacity}(?:\\.0+)?\\s*(?:l|litres?|liters?)\\b`, "i");
    if (!capacityPattern.test(candidate)) return false;
  }

  const requestedInchDimensions = requested.match(/\b(\d+(?:\.\d+)?)\s*(?:x|by|×)\s*(\d+(?:\.\d+)?)\s*(?:inch|inches|in)\b/);
  if (requestedInchDimensions) {
    const requestedSides = [Number.parseFloat(requestedInchDimensions[1]), Number.parseFloat(requestedInchDimensions[2])].sort((left, right) => left - right);
    const candidatePairs = [...candidate.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:x|by|×)\s*(\d+(?:\.\d+)?)\s*(?:inch|inches|in|")/gi)]
      .map((match) => [Number.parseFloat(match[1]), Number.parseFloat(match[2])].sort((left, right) => left - right));
    if (!candidatePairs.some((sides) => Math.abs(sides[0] - requestedSides[0]) <= 1 && Math.abs(sides[1] - requestedSides[1]) <= 1)) return false;
  }

  const requestedInchRange = requested.match(/\b(\d+(?:\.\d+)?)\s*(?:-|to|through)\s*(\d+(?:\.\d+)?)\s*(?:inch|inches|in)\b/);
  if (requestedInchRange) {
    const minimumCm = Math.min(Number.parseFloat(requestedInchRange[1]), Number.parseFloat(requestedInchRange[2])) * 2.54;
    const maximumCm = Math.max(Number.parseFloat(requestedInchRange[1]), Number.parseFloat(requestedInchRange[2])) * 2.54;
    const measurementsCm = [...candidate.matchAll(/\b(\d+(?:\.\d+)?)\s*(cm|mm|inch|inches|in|\")/gi)]
      .map((match) => {
        const value = Number.parseFloat(match[1]);
        if (/^mm$/i.test(match[2])) return value / 10;
        if (/^(?:inch|inches|in|\")$/i.test(match[2])) return value * 2.54;
        return value;
      });
    if (!measurementsCm.some((measurement) => measurement >= minimumCm - 1.1 && measurement <= maximumCm + 1.1)) return false;
  }

  const requestedFoodPanDepth = foodPanRequest ? foodPanDepthConstraintMatches(requested, candidate) : null;
  const requestedInchSize = requestedInchRange || requestedInchDimensions || requestedFoodPanDepth !== null
    ? null
    : requested.match(/\b(\d+(?:\.\d+)?)\s*-?\s*(?:inch|in)\b/);
  if (requestedInchSize) {
    const inches = Number.parseFloat(requestedInchSize[1]);
    const directInches = new RegExp(`\\b${requestedInchSize[1]}\\s*-?\\s*(?:inch|in|\")`, "i");
    const centimetres = inches * 2.54;
    const equivalentCm = [...new Set([
      Math.floor(centimetres),
      Math.round(centimetres),
      Math.ceil(centimetres),
    ])].some((size) => new RegExp(`(?:ø|diameter\\s*)?${size}(?:\\s*cm|(?=\\s*[x×]))`, "i").test(candidate));
    if (!directInches.test(candidate) && !equivalentCm) return false;
  }

  const requestedShoeSize = requested.match(/\b(euro|us)\s+size\s+(\d{1,2}(?:\.5)?)\b/);
  if (requestedShoeSize) {
    const [, sizingSystem, size] = requestedShoeSize;
    if (!new RegExp(`\\b${sizingSystem}\\s+size\\s+${size}\\b`, "i").test(candidate)) return false;
  }

  if (/\bslip[ -]?on\b/.test(requested) && !/\bslip\b/.test(candidate)) return false;
  if (/\blace[ -]?up\b/.test(requested) && !/\blace\b/.test(candidate)) return false;

  return true;
}

export async function searchCatalogue(
  message: string,
  options: { resultLimit?: number; outputLimit?: number } = {},
) {
  const query = normalizeCatalogueQuery(message);
  const lookupQuery = catalogueLookupQuery(query);
  if (lookupQuery.length < 2) return [];

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const response = await fetch(`${url}/rest/v1/rpc/search_products`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
    body: JSON.stringify({ search_query: lookupQuery, result_limit: options.resultLimit ?? 8 }),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });

  if (!response.ok) throw new Error(`SUPABASE_SEARCH_${response.status}`);

  const products = productSearchSchema.array().parse(await response.json());

  const eligible = prioritizeBrand(
    message,
    products.filter((product) => (product.status === "Active" || product.status === "New") && matchesExplicitConstraints(query, product)),
  );
  if (/\b(cheap|cheapest|lowest price|budget)\b/i.test(message)) {
    eligible.sort((a, b) => brandPreferenceScore(message, b) - brandPreferenceScore(message, a) || a.list_price - b.list_price);
  }
  return eligible.slice(0, options.outputLimit ?? 5);
}

export async function findProductForStockCheck(stockId: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const query = new URLSearchParams({
    stock_id: `eq.${stockId}`,
    select: productSelect,
    limit: "1",
  });
  const response = await fetch(`${url}/rest/v1/products?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_PRODUCT_${response.status}`);
  return catalogueProductSchema.array().parse(await response.json())[0] ?? null;
}

export async function findChefPantsCatalogue() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const query = new URLSearchParams({
    select: productSelect,
    or: "(name.ilike.*pants*,third_category.ilike.*pants*)",
    status: "in.(Active,New)",
    order: "name.asc",
    limit: "100",
  });
  const response = await fetch(`${url}/rest/v1/products?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_CHEF_PANTS_${response.status}`);
  return catalogueProductSchema.array().parse(await response.json());
}

function productVariantFamily(name: string) {
  return name
    .replace(/,?\s*(?:euro|us|uk)\s+size\s+\d+(?:\.5)?/gi, "")
    .replace(/,?\s*size\s+\d+(?:\.5)?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function broadProductTypePattern(product: Product) {
  const text = searchableProductText(product);
  const patterns = [
    /\b(?:chef\s+)?(?:pants|trousers)\b/i,
    /\b(?:shoe|shoes|footwear|boot|boots)\b/i,
    /\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i,
    /\bwoks?\b/i,
    /\b(?:fry|frying|omelette|crepe|grill|sauce)?\s*pan\b/i,
    /\b(?:knife|knives|cleaver)\b/i,
    /\b(?:plate|plates|platter|platters)\b/i,
    /\b(?:bowl|bowls)\b/i,
    /\b(?:glass|glasses|glassware)\b/i,
    /\b(?:cup|cups|mug|mugs)\b/i,
    /\b(?:tray|trays)\b/i,
    /\b(?:camtainer|(?:beverage|drink|tea)\s+(?:dispenser|server))\b/i,
    /\b(?:pot|pots)\b/i,
  ];
  return patterns.find((pattern) => pattern.test(text)) ?? null;
}

function strictAlternativeTypePattern(product: Product) {
  const text = searchableProductText(product);
  const patterns = [
    /\bcutlery\s+set\b/i,
    /\bchef(?:'s|s)?\s+knife\b/i,
    /\bboning\s+knife\b/i,
    /\bbread\s+knife\b/i,
    /\bparing\s+knife\b/i,
    /\bcleaver\b/i,
    /\b(?:coffee|spice)\s+grinder\b/i,
    /\bfry(?:ing)?\s+pan\b|\bfrypan\b|\bskillet\b/i,
    /\bsauce\s*pan\b/i,
    /\bgrill\s+pan\b/i,
    /\bwok\s+(?:lid|cover)\b|\b(?:lid|cover)\b[\s\S]*\bwok\b/i,
    /\bstock\s*pot\b/i,
    /\b(?:camtainer|(?:beverage|drink|tea)\s+(?:dispenser|server))\b/i,
  ];
  return patterns.find((pattern) => pattern.test(text)) ?? null;
}

function broadProductTypeSearch(product: Product) {
  const text = searchableProductText(product);
  if (/\b(?:coffee|spice)[ -]?grinders?\b|\bgrinders?\b/i.test(text)) return "coffee grinder";
  if (/\b(?:chef\s+)?(?:pants|trousers)\b/i.test(text)) return "chef pants";
  if (/\b(?:shoe|shoes|footwear|boot|boots)\b/i.test(text)) return "work shoes";
  if (/\bwoks?\b/i.test(text)) return "wok";
  if (/\b(?:fry|frying|omelette|crepe|grill|sauce)?\s*pan\b/i.test(text)) return "pan";
  if (/\b(?:knife|knives|cleaver)\b/i.test(text)) return "knife";
  if (/\b(?:pot|pots|stockpot|stockpots)\b/i.test(text)) return "pot";
  if (/\b(?:camtainer|(?:beverage|drink|tea)\s+(?:dispenser|server))\b/i.test(text)) return "beverage dispenser";
  return null;
}

export async function findAvailableCatalogueAlternatives(
  stockId: string,
  limit = 3,
  minimumQuantity = 1,
  excludedStockIds: ReadonlySet<string> = new Set(),
  requirements?: string | null,
) {
  const source = await findProductForStockCheck(stockId);
  if (!source) return [];

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("DATABASE_NOT_CONFIGURED");

  const typePattern = strictAlternativeTypePattern(source) ?? broadProductTypePattern(source);
  const sourceUom = source.uom_id.trim().toLowerCase();
  const scopes = [
    ["third_category", source.third_category],
    ["subcategory", source.subcategory],
  ] as const;
  const candidates = new Map<string, Product>();

  for (const [field, value] of scopes) {
    if (!value?.trim()) continue;
    const query = new URLSearchParams({
      select: productSelect,
      [field]: `eq.${value}`,
      status: "in.(Active,New)",
      stock_status: "eq.in_stock",
      available_quantity: `gte.${minimumQuantity}`,
      limit: "80",
    });
    const response = await fetch(`${url}/rest/v1/products?${query}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`SUPABASE_ALTERNATIVES_${response.status}`);
    for (const product of catalogueProductSchema.array().parse(await response.json())) {
      if (product.stock_id === source.stock_id
        || excludedStockIds.has(product.stock_id)
        || product.uom_id.trim().toLowerCase() !== sourceUom
        || product.available_quantity === null
        || product.available_quantity === undefined
        || product.available_quantity < minimumQuantity) continue;
      if (typePattern && !typePattern.test(searchableProductText(product))) continue;
      if (requirements && !matchesExplicitConstraints(requirements, product)) continue;
      candidates.set(product.stock_id, product);
    }
  }

  const broadSearch = broadProductTypeSearch(source);
  if (broadSearch && candidates.size < limit) {
    const broadMatches = await searchCatalogue(broadSearch, { resultLimit: 80, outputLimit: 80 });
    for (const product of broadMatches) {
      if (product.stock_id === source.stock_id
        || excludedStockIds.has(product.stock_id)
        || product.uom_id.trim().toLowerCase() !== sourceUom
        || product.stock_status !== "in_stock"
        || product.available_quantity === null
        || product.available_quantity === undefined
        || product.available_quantity < minimumQuantity) continue;
      if (typePattern && !typePattern.test(searchableProductText(product))) continue;
      if (requirements && !matchesExplicitConstraints(requirements, product)) continue;
      candidates.set(product.stock_id, product);
    }
  }

  const requestedEuroSize = source.name.match(/\beuro\s+size\s+(\d+(?:\.5)?)\b/i)?.[1];
  const sourceFamily = productVariantFamily(source.name);
  const ranked = [...candidates.values()].sort((left, right) => {
    const exactSizeScore = (product: Product) => requestedEuroSize && new RegExp(`\\beuro\\s+size\\s+${requestedEuroSize}\\b`, "i").test(product.name) ? 1 : 0;
    return exactSizeScore(right) - exactSizeScore(left)
      || Number(right.available_quantity ?? 0) - Number(left.available_quantity ?? 0);
  });

  const selected: Product[] = [];
  const seenFamilies = new Set([sourceFamily]);
  for (const product of ranked) {
    const family = productVariantFamily(product.name);
    if (seenFamilies.has(family)) continue;
    selected.push(product);
    seenFamilies.add(family);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function findCatalogueProductByCode(stockId: string) {
  return findProductForStockCheck(stockId.trim());
}
