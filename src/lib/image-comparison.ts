export type RiceDispenserComparisonOption = {
  model: string;
  capacityKg: number | null;
  placement: "tabletop" | "floor-standing" | null;
};

type RiceDispenserClarificationInput = {
  visionText: string;
  userMessage: string;
  quantity: number | null;
  language?: "en" | "zh";
};

type EncodedImage = {
  dataUrl: string;
  mimeType: string;
};

const riceDispenserModelPattern = /\b(?:WF[\s_-]*RD|RD)[\s_-]*(\d{1,3})\b/gi;

function leadingImageBytes(dataUrl: string) {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) return null;
  const encoded = dataUrl.slice(separator + 1, separator + 1 + 131_072);
  const completeLength = encoded.length - (encoded.length % 4);
  if (completeLength < 4) return null;
  try {
    const binary = atob(encoded.slice(0, completeLength));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function uint16be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint32be(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function encodedImageDimensions(image: EncodedImage) {
  const bytes = leadingImageBytes(image.dataUrl);
  if (!bytes) return null;

  if (image.mimeType === "image/png" && bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
  }

  if (image.mimeType === "image/jpeg" && bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) break;
      const segmentLength = uint16be(bytes, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          width: uint16be(bytes, offset + 5),
          height: uint16be(bytes, offset + 3),
        };
      }
      offset += segmentLength;
    }
  }

  return null;
}

export function looksLikeTallScreenshot(image: EncodedImage) {
  const dimensions = encodedImageDimensions(image);
  return dimensions !== null
    && dimensions.width >= 320
    && dimensions.height >= 700
    && dimensions.height / dimensions.width >= 1.65;
}

export type VisionImageKind = "product" | "screenshot" | "unknown";

/** The vision workflow must emit this marker before its narrative. */
export function visionImageKind(message: string): VisionImageKind {
  const marker = message.match(/\bIMAGE[_\s-]*KIND\s*[:=]\s*(PRODUCT|SCREENSHOT|DOCUMENT|TABLE|COMPARISON|OTHER)\b/i)?.[1]?.toUpperCase();
  if (marker === "PRODUCT") return "product";
  if (marker && marker !== "OTHER") return "screenshot";
  return "unknown";
}

export function isImageComparisonRequest(message: string) {
  return /\b(?:screenshot|comparison|compare|table|chart)\b/i.test(message)
    || referencesMultipleComparisonItems(message);
}

function normalizedModel(modelNumber: string) {
  return `WF-RD-${Number.parseInt(modelNumber, 10)}`;
}

function modelMatches(value: string) {
  return [...value.matchAll(riceDispenserModelPattern)].map((match) => ({
    index: match.index ?? 0,
    model: normalizedModel(match[1]),
  }));
}

function capacityFromSegment(segment: string) {
  const labelled = segment.match(/\bcapacity\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*kg\b/i)?.[1];
  const cookedRice = segment.match(/\b(\d+(?:\.\d+)?)\s*kg\s*(?:of\s+)?cooked\s+rice\b/i)?.[1];
  const value = labelled ?? cookedRice;
  return value ? Number.parseFloat(value) : null;
}

function placementFromSegment(segment: string): RiceDispenserComparisonOption["placement"] {
  if (/\b(?:table\s*top|tabletop)\b/i.test(segment)) return "tabletop";
  if (/\b(?:vertical\s+stand|floor[\s-]*standing|floor\s+stand)\b/i.test(segment)) return "floor-standing";
  return null;
}

export function extractRiceDispenserComparisonOptions(text: string) {
  const matches = modelMatches(text);
  const options = new Map<string, RiceDispenserComparisonOption>();

  matches.forEach((match, index) => {
    const nextIndex = matches[index + 1]?.index ?? text.length;
    const segment = text.slice(match.index, nextIndex);
    const existing = options.get(match.model);
    options.set(match.model, {
      model: match.model,
      capacityKg: existing?.capacityKg ?? capacityFromSegment(segment),
      placement: existing?.placement ?? placementFromSegment(segment),
    });
  });

  return [...options.values()];
}

function comparisonSelectionIndex(message: string) {
  const matches = [...message.matchAll(/\b(?:item|option|model|row)\s*#?\s*(\d+)\b/gi)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return new Set(matches).size === 1 ? matches[0] - 1 : null;
}

/**
 * Identifies a request about more than one numbered entry in an attached
 * comparison. Requiring an item/row/model noun keeps ordinary quantities such
 * as "1 or 2 units" from being mistaken for comparison selections.
 */
export function referencedComparisonItems(message: string) {
  const references: number[] = [...message.matchAll(
    /\b(?:item|option|model|row)\s*#?\s*(\d+)\b/gi,
  )].map((match) => Number.parseInt(match[1], 10));

  const compactReference = message.match(
    /\b(?:items?|options?|models?|rows?)\s*#?\s*(\d+)\s*(?:,|and|n|&|\+|vs\.?|versus|or)\s*(?:(?:items?|options?|models?|rows?)\s*)?#?\s*(\d+)\b/i,
  );
  if (compactReference) {
    references.push(Number.parseInt(compactReference[1], 10), Number.parseInt(compactReference[2], 10));
  }

  const ordinals: Array<[RegExp, number]> = [
    [/\b(?:first|1st)\s+(?:item|option|model|row)\b/i, 1],
    [/\b(?:second|2nd)\s+(?:item|option|model|row)\b/i, 2],
    [/\b(?:third|3rd)\s+(?:item|option|model|row)\b/i, 3],
  ];
  for (const [pattern, value] of ordinals) {
    if (pattern.test(message)) references.push(value);
  }

  return [...new Set(references.filter((value) => Number.isInteger(value) && value > 0))];
}

export function referencesMultipleComparisonItems(message: string) {
  if (referencedComparisonItems(message).length >= 2) return true;

  return /\b(?:first|1st)\s+(?:item|option|model|row)\b[\s\S]{0,40}\b(?:and|&|vs\.?|versus|or)\b[\s\S]{0,20}\b(?:second|2nd)\s+(?:item|option|model|row)\b/i.test(message);
}

/**
 * Resolves a customer's comparison-table follow-up without replaying every
 * model named in the previous assistant clarification. An explicit model in
 * the current turn wins; otherwise "item 2" maps to the second model in the
 * latest comparison message.
 */
export function resolveRiceDispenserModels(message: string, recentContext: string[]) {
  const explicitModels = extractRiceDispenserComparisonOptions(message).map((option) => option.model);
  if (explicitModels.length > 0) return explicitModels;

  const latestComparison = [...recentContext]
    .reverse()
    .map(extractRiceDispenserComparisonOptions)
    .find((options) => options.length > 0) ?? [];
  const selectedIndex = comparisonSelectionIndex(message);
  if (selectedIndex !== null && latestComparison[selectedIndex]) {
    return [latestComparison[selectedIndex].model];
  }
  return latestComparison.map((option) => option.model);
}

function optionDescription(option: RiceDispenserComparisonOption, index: number) {
  const details = [
    option.capacityKg === null ? null : `${option.capacityKg} kg cooked-rice capacity`,
    option.placement,
  ].filter(Boolean);
  return `${index + 1}. ${option.model}${details.length > 0 ? ` — ${details.join(" — ")}` : ""}`;
}

function optionSuggestion(option: RiceDispenserComparisonOption) {
  return `${option.model}${option.capacityKg === null ? "" : ` (${option.capacityKg} kg)`}`;
}

/**
 * Converts a vision narrative for a multi-model rice-dispenser screenshot into
 * a bounded customer decision. It intentionally returns no catalogue products
 * and makes no stock or price claim; those require a later grounded lookup or
 * manual sales review.
 */
export function riceDispenserImageClarification(input: RiceDispenserClarificationInput) {
  const options = extractRiceDispenserComparisonOptions(input.visionText);
  const identifiesRiceDispenser = /\brice\s+disp(?:ens|enc)ers?\b/i.test(input.visionText);
  const comparisonLanguage = /\b(?:compar(?:e|ison)|options?|models?|rows?|table|item\s*1)\b/i.test(input.visionText);
  if (options.length < 2 && !(identifiesRiceDispenser && comparisonLanguage)) return null;

  const visibleOptions = options.slice(0, 4);
  const optionLines = visibleOptions.map(optionDescription);
  const hasQuantity = input.quantity !== null;

  if (input.language === "zh") {
    const intro = optionLines.length > 0
      ? `这张图片看起来是在比较自动米饭分配机。可读取的选项如下：\n${optionLines.join("\n")}`
      : "这张图片看起来是在比较自动米饭分配机，但我无法可靠读取所有型号和容量。";
    return {
      message: `${intro}\n\n${hasQuantity ? `我已保留数量 ${input.quantity}。${optionLines.length > 0 ? "请选择要继续查询的型号。" : "请发送更清楚的型号/容量截图，或输入所需的型号和容量。"}` : optionLines.length > 0 ? "请选择型号，并告诉我需要多少台。" : "请发送更清楚的型号/容量截图，或输入所需的型号、容量和数量。"}这些型号尚未在当前 Sia Huat 网上目录中核实，因此目前不能确认库存、价格或订单。`,
      suggestions: visibleOptions.length > 0
        ? visibleOptions.map(optionSuggestion)
        : ["输入型号", "输入容量", "发送更清楚的图片"],
    };
  }

  const intro = optionLines.length > 0
    ? `This photo appears to compare automatic rice dispensers. I could read these options:\n${optionLines.join("\n")}`
    : "This photo appears to compare automatic rice dispensers, but I can’t reliably read every model and capacity.";
  return {
    message: `${intro}\n\n${hasQuantity ? `I’ve kept quantity ${input.quantity}. ${optionLines.length > 0 ? "Choose the model you want me to continue with." : "Send a closer crop of the model/capacity rows, or type the model and capacity you want."}` : optionLines.length > 0 ? "Choose a model and tell me how many units you need." : "Send a closer crop of the model/capacity rows, or type the model, capacity and quantity you want."} I haven’t verified these exact models in the current Sia Huat online catalogue, so stock, price and any order are not confirmed yet.`,
    suggestions: visibleOptions.length > 0
      ? visibleOptions.map(optionSuggestion)
      : ["Type the model", "Tell me the capacity", "Send a clearer photo"],
  };
}
