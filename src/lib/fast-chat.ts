import {
  createFastReply as reply,
  catalogueHistoryWithClarification,
  catalogueMessageWithContext,
  extractPotFitMeasurements,
  extractExplicitShoeSize,
  extractShoeStyle,
  explicitKnifeBrand,
  hasUnrelatedPotOrBasketMeaning,
  isAmbiguousNoodleDryingRequest,
  isCatalogueRequest,
  isCookedNoodleDrainingIntent,
  isExactStockQuestion,
  isExistingPotStrainerRequest,
  isTradePriceQuestion,
  productCategories,
  productCategory,
  productWords,
  rejectsCurrentProductReference,
  requestedProductCategory,
  rememberedActiveCategories,
  rememberedPurpose,
  simplifyMessage,
  type FastChatInput,
  type FastReply,
} from "@/lib/chat-intent";
import { metricDimensionConstraintsMatch } from "@/lib/catalogue-dimensions";
import { requestedDisplayedProductIndex, requestedQuantity } from "@/lib/chat-turn";

export { isCatalogueRequest } from "@/lib/chat-intent";

export function getFastChatReply(input: FastChatInput): FastReply | null {
  const message = input.message.trim();
  const simple = simplifyMessage(message);
  const userHistory = input.history.filter((item) => item.role === "user").map((item) => item.content);
  const hasAssistantClarificationContext = catalogueHistoryWithClarification(message, input.history).length > userHistory.length;
  const hasProductContext = Boolean(input.context?.activeProduct)
    || userHistory.slice(-6).some((content) => productWords.test(content));
  const mentionedCategories = userHistory.flatMap((content) => productCategories.filter((category) => category.pattern.test(content)).map((category) => category.label));
  const previousCategories = rememberedActiveCategories(userHistory);
  const lastCategory = previousCategories.at(-1) ?? null;
  const purposeCategory = mentionedCategories[0] ?? null;
  const rawCurrentCategory = productCategory(message);
  const positivelyRequestedCategory = requestedProductCategory(message);
  const hasExplicitCategoryCorrection = rejectsCurrentProductReference(message)
    || /\b(?:not|wrong|instead|rather\s+than|meant|switch|change|replace|but)\b/i.test(message);
  const currentCategory = positivelyRequestedCategory ?? rawCurrentCategory;
  const correctsPreviousCategory = /\b(?:i\s+)?(?:was\s+)?thinking\s+(?:more\s+)?of\b|\b(?:i\s+)?meant\b|\bmore\s+like\b/i.test(message);
  let currentCategories = productCategories.filter((category) => category.pattern.test(message)).map((category) => category.label);
  const requestsStrainerForPot = currentCategory === "strainer"
    && /\b(?:strainers?|colanders?|baskets?|inserts?)\b[^.!?;]{0,50}\bfor\b[^.!?;]{0,35}\b(?:stock\s*)?pots?\b/i.test(message);
  if (hasExplicitCategoryCorrection && currentCategory) {
    currentCategories = [currentCategory];
  } else if (positivelyRequestedCategory
    && /\b(?:also\s+(?:need|want)|add(?:\s+me)?)\b/i.test(message)) {
    currentCategories = [positivelyRequestedCategory];
  } else if (requestsStrainerForPot) {
    currentCategories = ["strainer"];
  } else if (currentCategory === "lid"
    && /\b(?:lids?|covers?)\b[^.!?;]{0,65}\b(?:notch|slot|cut[ -]?out)\b[^.!?;]{0,40}\b(?:for\s+)?(?:a\s+)?ladle\b/i.test(message)) {
    currentCategories = ["lid"];
  } else if (currentCategories.includes("utensil") && currentCategories.includes("blender")
    && /\b(?:3[ -]?in[ -]?1|three[ -]?in[ -]?one|blender[\s,/-]+whisk|whisk[\s,/-]+blender)\b/i.test(message)) {
    currentCategories = ["utensil"];
  } else if (isExistingPotStrainerRequest(message)) {
    currentCategories = ["strainer"];
  } else if (currentCategories.includes("plant pot")) {
    currentCategories = ["plant pot"];
  } else if (hasUnrelatedPotOrBasketMeaning(message) && currentCategories.includes("basket")) {
    currentCategories = ["basket"];
  } else if (positivelyRequestedCategory
    && !["pot", "stockpot", "strainer"].includes(positivelyRequestedCategory)
    && currentCategories.some((category) => ["pot", "stockpot"].includes(category))
    && currentCategories.includes("strainer")) {
    currentCategories = [positivelyRequestedCategory];
  } else if (currentCategories.includes("gas torch burner")
    && currentCategories.includes("gas cartridge")
    && /\b(?:no|not|without|don['’]?t\s+(?:need|want))\b[^.!?]{0,28}\b(?:gas\s+)?(?:can|canister|cartridge)\b/i.test(message)) {
    currentCategories = ["gas torch burner"];
  } else if (["knife sharpener", "wok lid", "shot glass", "stockpot", "rice dispenser", "trolley"].includes(currentCategories[0] ?? "")) {
    currentCategories = [currentCategories[0]];
  } else if (currentCategories.length > 1 && /\b(?:forget|never\s*mind|instead|switch|change|replace)\b/i.test(message)) {
    currentCategories = [currentCategories.at(-1)!];
  }
  const purpose = rememberedPurpose([...userHistory, message]);
  const activeTask = lastCategory ? `your ${lastCategory}${purpose && lastCategory === purposeCategory ? ` for ${purpose}` : ""}` : null;
  const awaitingItemConfirmation = [...input.history].reverse().some((item) => item.role === "assistant" && /exact item|is this.*item|confirm.*item/i.test(item.content));
  const coffeeContext = [...userHistory, message].some((content) => /\b(coffee|cofee|cofe|kopi)\b/i.test(content));
  const shoeContext = currentCategory === "shoe" || previousCategories.includes("shoe");
  const shoeMessages = [...userHistory, message];
  const shoeSize = extractExplicitShoeSize(shoeMessages);
  const shoeStyle = extractShoeStyle(shoeMessages);
  const hasShoeSize = Boolean(shoeSize);
  const hasShoeStyle = Boolean(shoeStyle);
  const prataContext = [...userHistory, message].some((content) => /\b(prata|roti prata|paratha)\b/i.test(content));
  const cookedPrataContext = [...userHistory, message].some((content) => /\b(cooked prata|cut cooked|serving prata|prata.*serving)\b/i.test(content));
  const rawPrataContext = [...userHistory, message].some((content) => /\b(raw prata|prata dough|raw dough|divide.*dough)\b/i.test(content));
  const humanHandoffContext = input.history.some((item) => /human|person|team member|sales team|colleague/i.test(item.content) && /contact|speak|handoff|follow.?up|notified|flag|alerted/i.test(item.content));
  const teaPreparationContext = [...userHistory, message].some((content) => {
    const normalized = simplifyMessage(content);
    return /\btea\b/.test(normalized)
      && (/\bcup of tea\b/.test(normalized)
        || /\b(?:make|prepare|brew|steep|recipe|instructions?|how to)\b/.test(normalized));
  });

  const asksAboutIdentity = /\b(are you|r u|am i (talking|speaking) (to|with))\b.*\b(ai|bot|robot|human|real person)\b/i.test(message);
  const requestsHuman =
    /\b(get|bring|find|send|give|connect|transfer|alert|call)\b.{0,30}\b(human|humand|humen|person|agent|representative|staff|team member|colleague)\b/i.test(message)
    || /\b(speak|talk|chat)\b.{0,20}\b(to|with)\b.{0,12}\b(human|humand|humen|person|agent|representative|staff|team member|colleague)\b/i.test(message)
    || /\b(real person|human agent|customer service)\b/i.test(message);
  const asksOperationalFollowup = /\b(?:quote|qoute|quotation|invoice|email|e-mail|payment|bank\s+transfer|payment\s+advice|delivery|order)\b/i.test(message)
    && /\b(?:status|update|check|chk|chek|follow\s*up|not\s+(?:received|arrived|here)|no\s+(?:email|reply)|has\s+not|hasn['’]?t|haven['’]?t|still\s+waiting|when\s+will|when\s+is|approved|arranged|overdue|pending|where\s+is)\b/i.test(message);
  const displayedProducts = input.context?.displayedProducts ?? [];
  const explicitlyReferencedIndex = requestedDisplayedProductIndex(message, displayedProducts);
  const referencedCandidate = (explicitlyReferencedIndex === null ? null : displayedProducts[explicitlyReferencedIndex])
    ?? (displayedProducts.length === 1 ? displayedProducts[0] : null)
    ?? input.context?.activeProduct;
  const referencedCandidateCategory = referencedCandidate ? productCategory(referencedCandidate.name) : null;
  const switchesFromDisplayedProduct = Boolean(
    rejectsCurrentProductReference(message)
    || (currentCategory
      && referencedCandidateCategory
      && currentCategory !== referencedCandidateCategory),
  );
  const referenceText = referencedCandidate ? [
    referencedCandidate.name,
    referencedCandidate.stock_id,
    referencedCandidate.brand,
    referencedCandidate.description,
    referencedCandidate.size,
    referencedCandidate.dimensions,
  ].filter(Boolean).join(" ") : "";
  const explicitCodes = message.toUpperCase().match(/\b(?=[A-Z0-9./-]*\d)[A-Z0-9]+(?:[./-][A-Z0-9]+)+\b/g) ?? [];
  const codeMismatch = Boolean(referencedCandidate && explicitCodes.length > 0
    && !explicitCodes.some((code) => code.toLowerCase() === referencedCandidate.stock_id.toLowerCase()));
  const requestedOrigin = [...message.matchAll(/\b(japan(?:ese)?|taiwan(?:ese)?)\b/gi)].at(-1)?.[1] ?? null;
  const originPattern = requestedOrigin
    ? /^japan/i.test(requestedOrigin) ? /\bjapan(?:ese)?\b/i : /\btaiwan(?:ese)?\b/i
    : null;
  const originMismatch = Boolean(referencedCandidate && originPattern && !originPattern.test(referenceText));
  const requestedColour = [...message.matchAll(/\b(red|yellow|blue|black|white|green|silver|grey|gray|brown)\b/gi)].at(-1)?.[1] ?? null;
  const colourMismatch = Boolean(referencedCandidate && requestedColour
    && !new RegExp(`\\b${/gr[ae]y/i.test(requestedColour) ? "gr(?:e|a)y" : requestedColour}\\b`, "i").test(referenceText));
  const requestedMaterials = [
    /\bstainless(?:\s+steel)?\b/i.test(message) ? /\bstainless(?:\s+steel)?\b/i : null,
    /\bcarbon\s+steel\b/i.test(message) ? /\bcarbon\s+steel\b/i : null,
    /\bcast\s+iron\b/i.test(message) ? /\bcast\s+iron\b/i : null,
    /\baluminium|aluminum\b/i.test(message) ? /\baluminium|aluminum\b/i : null,
    /\bnon[ -]?stick\b/i.test(message) ? /\bnon[ -]?stick\b/i : null,
  ].filter((pattern): pattern is RegExp => pattern !== null);
  const materialMismatch = Boolean(referencedCandidate && requestedMaterials.length > 0
    && !requestedMaterials.some((pattern) => pattern.test(referenceText)));
  const possibleKnifeBrand = explicitKnifeBrand(message);
  const brandMismatch = Boolean(referencedCandidate && possibleKnifeBrand
    && !new RegExp(`\\b${possibleKnifeBrand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(referenceText));
  const subtypeMismatch = Boolean(referencedCandidate
    && ((/\bbread\s+kn(?:ife|ives)\b/i.test(message) && !/\bbread\b[\s\S]*\bknife\b|\bknife\b[\s\S]*\bbread\b/i.test(referenceText))
      || (/\boyster\s+kn(?:ife|ives)\b/i.test(message) && !/\boyster\b[\s\S]*\bknife\b|\bknife\b[\s\S]*\boyster\b/i.test(referenceText))));
  const requestedMeasurement = [...message.matchAll(/\b(\d+(?:\.\d+)?)[\s-]*(cm|mm|inch|inches|in)\b/gi)].at(-1);
  const measurementMismatch = Boolean(referencedCandidate && requestedMeasurement && (() => {
    const requestedValue = Number.parseFloat(requestedMeasurement[1]);
    const requestedCm = /^mm$/i.test(requestedMeasurement[2]) ? requestedValue / 10
      : /^(?:inch|inches|in)$/i.test(requestedMeasurement[2]) ? requestedValue * 2.54 : requestedValue;
    const candidateMeasurements = [...referenceText.matchAll(/\b(\d+(?:\.\d+)?)\s*(cm|mm|inch|inches|in|\")/gi)].map((match) => {
      const value = Number.parseFloat(match[1]);
      return /^mm$/i.test(match[2]) ? value / 10 : /^(?:inch|inches|in|\")$/i.test(match[2]) ? value * 2.54 : value;
    });
    return !candidateMeasurements.some((value) => Math.abs(value - requestedCm) <= 1.1);
  })());
  const metricDimensionsMismatch = Boolean(referencedCandidate
    && metricDimensionConstraintsMatch(message, referenceText) === false);
  const referencedProduct = switchesFromDisplayedProduct || codeMismatch || originMismatch || colourMismatch || materialMismatch || brandMismatch || subtypeMismatch || measurementMismatch || metricDimensionsMismatch
    ? null
    : referencedCandidate;
  const hasNamedUnresolvedProduct = Boolean(currentCategory && !referencedProduct);
  const referencedIsActive = Boolean(
    referencedProduct
    && input.context?.activeProduct?.stock_id === referencedProduct.stock_id,
  );
  const referencedOptionIndex = referencedProduct
    ? displayedProducts.findIndex((product) => product.stock_id === referencedProduct.stock_id)
    : -1;
  const referencedOptionNumber = referencedOptionIndex >= 0 ? String(referencedOptionIndex + 1) : "1";
  const referencedSelectionLabel = displayedProducts.length === 1
    ? "this item"
    : `option ${referencedOptionNumber}`;

  if (isTradePriceQuestion(message) && isExactStockQuestion(message) && !input.image && !switchesFromDisplayedProduct && !hasNamedUnresolvedProduct) {
    if (!referencedProduct) {
      return reply(
        "Which product do you mean? Choose one of the displayed options first. I’ll check its current availability and explain the price basis without treating your question as an order.",
        displayedProducts.map((_, index) => String(index + 1)),
        "clarify",
      );
    }
    const requestedCount = requestedQuantity(message);
    const exactAvailable = referencedProduct.stock_status === "out_of_stock"
      ? 0
      : typeof referencedProduct.available_quantity === "number"
        ? referencedProduct.available_quantity
        : null;
    const requestedCountIsAvailable = requestedCount !== null
      && exactAvailable !== null
      && exactAvailable >= requestedCount;
    const listPrice = typeof referencedProduct.list_price === "number"
      ? `The $${referencedProduct.list_price.toFixed(2)} / ${referencedProduct.uom_id ?? "unit"} shown is the catalogue list price before GST, not a confirmed trade price.`
      : "The demo does not show a confirmed trade price.";
    const stockCopy = referencedProduct.stock_status === "out_of_stock" || referencedProduct.available_quantity === 0
      ? `${referencedProduct.name} is currently out of stock${requestedCount ? `, so ${requestedCount} are not available` : ""}.`
      : typeof referencedProduct.available_quantity === "number"
        ? `The fresh listing check shows ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available${requestedCount === null ? "." : referencedProduct.available_quantity >= requestedCount ? `, so ${requestedCount} are currently available.` : `, so the requested ${requestedCount} are not all available.`}`
        : `The current listing does not provide an exact stock count${requestedCount ? `, so I can’t confirm whether ${requestedCount} are available` : ""}.`;
    const nextStep = requestedCount !== null && referencedOptionIndex >= 0
      ? requestedCountIsAvailable
        ? `If you want to proceed with ${requestedCount}, choose “Take ${requestedCount} of option ${referencedOptionNumber}.” Trade pricing still needs Sia Huat sales to quote for your quantity and account.`
        : exactAvailable === 0
          ? `You cannot take ${requestedCount} of this option while it is out of stock. Choose another item, or prepare a staff-review summary for manual sourcing.`
          : exactAvailable !== null
            ? `Only ${exactAvailable} can be confirmed right now. Choose “Take ${exactAvailable} of option ${referencedOptionNumber}” only if that smaller quantity works, or choose another item.`
            : `I can’t safely confirm ${requestedCount} from the current listing. Prepare a staff-review summary or choose another item instead of placing an unverified request.`
      : referencedIsActive
        ? "Tell me the quantity and your business/account name so Sia Huat sales can quote manually."
        : `Select ${referencedSelectionLabel}, then tell me the quantity and your business/account name so Sia Huat sales can quote manually.`;
    const nextSuggestions = requestedCount !== null && referencedOptionIndex >= 0
      ? requestedCountIsAvailable
        ? [`Take ${requestedCount} of option ${referencedOptionNumber}`, "Prepare staff review summary"]
        : exactAvailable !== null && exactAvailable > 0
          ? [`Take ${exactAvailable} of option ${referencedOptionNumber}`, "Choose another item"]
          : ["Choose another item", "Prepare staff review summary"]
      : referencedIsActive ? ["1", "6", "12", "24"] : [referencedOptionNumber, "Prepare staff review summary"];
    return reply(
      `${referencedSelectionLabel[0].toUpperCase()}${referencedSelectionLabel.slice(1)} is ${referencedProduct.name} (code: ${referencedProduct.stock_id}). ${listPrice} ${stockCopy} ${nextStep}`,
      nextSuggestions,
      referencedIsActive ? input.context?.stage ?? "quantity" : "clarify",
    );
  }

  if (isTradePriceQuestion(message) && !input.image && !switchesFromDisplayedProduct && !hasNamedUnresolvedProduct) {
    if (!referencedProduct) {
      return reply(
        "Trade pricing depends on the exact item, quantity and customer account. Choose the product first, then tell me the quantity and business/account name. The catalogue price shown is not a confirmed trade price.",
        displayedProducts.length > 0 ? displayedProducts.map((_, index) => String(index + 1)) : ["Find a product"],
        input.context?.stage ?? "clarify",
      );
    }
    const listPrice = typeof referencedProduct.list_price === "number"
      ? `The $${referencedProduct.list_price.toFixed(2)} / ${referencedProduct.uom_id ?? "unit"} shown is the catalogue list price before GST, not a confirmed trade price. `
      : "The price shown in this demo is catalogue pricing, not a confirmed trade price. ";
    const tradeNextStep = referencedIsActive
      ? "Tell me how many you need and your business/account name"
      : `Select ${referencedSelectionLabel} first, then tell me the quantity and your business/account name`;
    return reply(
      `${listPrice}Trade pricing for ${referencedProduct.name} can depend on your quantity and customer account. ${tradeNextStep}; I’ll keep those details in the enquiry PDF for Sia Huat sales to quote manually.`,
      referencedIsActive ? ["1", "6", "12", "24"] : [referencedOptionNumber, "Prepare staff review summary"],
      referencedIsActive ? input.context?.stage ?? "quantity" : "clarify",
    );
  }

  if (isExactStockQuestion(message) && !input.image && !switchesFromDisplayedProduct && !hasNamedUnresolvedProduct) {
    const explicitlyRequestedCount = requestedQuantity(message);
    if (!referencedProduct) {
      return reply(
        "Which product do you want the stock count for? Choose one of the displayed options first, and I’ll run a fresh check on that exact Sia Huat listing.",
        displayedProducts.map((_, index) => String(index + 1)),
        input.context?.stage ?? "clarify",
      );
    }
    if (referencedProduct.stock_status === "out_of_stock" || referencedProduct.available_quantity === 0) {
      return reply(
        `${referencedProduct.name} is currently out of stock${explicitlyRequestedCount ? `, so ${explicitlyRequestedCount} are not available` : ""}. It cannot be selected. Choose another option or tell me which detail can change.`,
        ["Choose another item", "Prepare staff review summary"],
        "clarify",
      );
    }
    if (typeof referencedProduct.available_quantity === "number" && referencedProduct.available_quantity > 0) {
      if (explicitlyRequestedCount !== null) {
        const enough = referencedProduct.available_quantity >= explicitlyRequestedCount;
        const action = referencedIsActive
          ? enough
            ? String(explicitlyRequestedCount)
            : String(referencedProduct.available_quantity)
          : `Take ${enough ? explicitlyRequestedCount : referencedProduct.available_quantity} of option ${referencedOptionNumber}`;
        return reply(
          enough
            ? `The fresh listing check shows ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available for ${referencedProduct.name}, so ${explicitlyRequestedCount} are currently available. ${referencedIsActive ? `Choose “${explicitlyRequestedCount}” to use that quantity.` : `Choose “Take ${explicitlyRequestedCount} of option ${referencedOptionNumber}” to proceed with this item.`}`
            : `The fresh listing check shows only ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available for ${referencedProduct.name}, so the requested ${explicitlyRequestedCount} are not all available. Choose the available quantity only if it works, or choose another item.`,
          enough ? [action, "Change quantity"] : [action, "Choose another item"],
          referencedIsActive ? input.context?.stage ?? "quantity" : "clarify",
        );
      }
      const requested = referencedIsActive ? input.context?.quantity ?? null : null;
      if (requested !== null && requested > referencedProduct.available_quantity) {
        return reply(
          `The fresh listing check shows only ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available for ${referencedProduct.name}, which is below your requested ${requested}. Choose the available quantity or another item.`,
          [String(referencedProduct.available_quantity), "Choose another item"],
          "quantity",
        );
      }
      if (requested !== null) {
        return reply(
          `The fresh listing check shows ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available for ${referencedProduct.name}. Your requested ${requested} is within the current availability.`,
          input.context?.stage === "clarify"
            ? ["Finish enquiry summary", "Change quantity"]
            : [String(requested), "Change quantity"],
          input.context?.stage ?? "quantity",
        );
      }
      return reply(
        `The fresh listing check shows ${referencedProduct.available_quantity} ${referencedProduct.uom_id ?? "units"} available for ${referencedProduct.name}. ${referencedIsActive ? "How many do you need?" : `Select ${referencedSelectionLabel}, then tell me how many you need.`}`,
        referencedIsActive
          ? ["1", "6", "12", "24"].filter((value) => Number(value) <= Number(referencedProduct.available_quantity))
          : [referencedOptionNumber],
        referencedIsActive ? input.context?.stage ?? "quantity" : "clarify",
      );
    }
    return reply(
      `The current result for ${referencedProduct.name} does not provide an exact stock count${explicitlyRequestedCount ? `, so I can’t confirm whether ${explicitlyRequestedCount} are available` : ""}. ${referencedIsActive ? "Tell me the quantity you need and I’ll keep it for staff verification." : `Choose option ${referencedOptionNumber} and I’ll run a fresh Add to cart check on that exact listing.`}`,
      referencedIsActive ? ["1", "6", "12", "24"] : [referencedOptionNumber],
      referencedIsActive ? input.context?.stage ?? "quantity" : "clarify",
    );
  }

  if (/\b(?:call(?:ing)?|contact|get)\s+(?:the\s+)?police\b|\bhello\s+police\b/i.test(message)) {
    return reply(
      "I’m sorry the suggestions were not useful. I’ll stop the product suggestions. This demo cannot contact a person automatically; use the PDF button to save the conversation and contact Sia Huat sales directly.",
      ["Prepare staff review summary"],
    );
  }

  if (requestsHuman && !asksAboutIdentity) {
    return reply("I can’t connect you to a person from this demo. I’ve kept the enquiry details in this conversation; use the PDF button and contact Sia Huat sales directly.", ["Continue product enquiry"]);
  }

  if (asksOperationalFollowup) {
    const suppliedReferenceMatch = message.match(/\b(SQ|SO|INV|PO)\s*[-:/\s]?\s*([A-Z]{1,4})?\s*[-:/\s]*\s*(\d{5,})\b/i);
    const suppliedReference = suppliedReferenceMatch
      ? `${suppliedReferenceMatch[1]}-${suppliedReferenceMatch[2] ?? ""}${suppliedReferenceMatch[3]}`.toUpperCase()
      : null;
    return reply(
      suppliedReference
        ? `Reference ${suppliedReference} is kept in this conversation. I can’t check its status or notify staff from this demo. Please quote this reference when contacting Sia Huat sales directly.`
        : "I can’t check the status or notify staff from this demo. Please share the quotation, invoice or order number if you have it, then contact Sia Huat sales directly.",
      suppliedReference ? ["Continue product enquiry"] : ["Share reference number", "Continue product enquiry"],
    );
  }

  const followsAmbiguousPhotoClarification = input.history.slice(-4).some((item) =>
    item.role === "assistant"
    && /received the photo/i.test(item.content)
    && /identify the item confidently/i.test(item.content),
  );
  const toasterContext = [...input.history
    .filter((item) => item.role === "user")
    .slice(-4)
    .map((item) => item.content), message].join(" ");
  const specifiesToasterStyle = /\b(?:pop[ -]?up|non[ -]?conve(?:yor|yr)|slots?|conve(?:yor|yr)|(?:no|not|without)\s+(?:a\s+)?belt(?:\s+type)?|belt\s+type\s+(?:no|not))\b/i.test(toasterContext);
  const followsManualToasterNoMatch = input.history.slice(-4).some((item) =>
    item.role === "assistant"
    && /couldn['’]?t find[^.!?]{0,100}\btoaster\b/i.test(item.content)
    && /contact Sia Huat sales|manual/i.test(item.content),
  );
  if (!input.image && currentCategory === "toaster" && followsManualToasterNoMatch) {
    const savedRequirement = catalogueMessageWithContext(message, userHistory);
    const savedQuantity = input.context?.quantity ?? [...userHistory].reverse()
      .map(requestedQuantity)
      .find((value) => value !== null) ?? null;
    return reply(
      `Yes—I’ve kept this as a ${savedRequirement}${savedQuantity ? ` at quantity ${savedQuantity}` : ""}. The current online catalogue still has no safe exact match, so I won’t repeat the same search or show a conveyor/accessory. Prepare the staff-review summary if you want Sia Huat sales to source it manually.`,
      ["Prepare staff review summary", "Choose another item"],
      "clarify",
    );
  }
  const photoSuggestsYaKunToaster = Boolean(input.image)
    && /\bya\s*kun\b|\b(?:not|non[ -]?)\s*conve(?:yor|yr)\b|\b(?:no|not|without)\s+(?:a\s+)?belt(?:\s+type)?\b|\bbelt\s+type\s+(?:no|not)\b/i.test(message);
  // The customer's explicit product wording is more reliable than an uncertain
  // image label. This prevents a toaster photo from being routed to an
  // unrelated family when vision recognition guesses incorrectly.
  if (photoSuggestsYaKunToaster) {
    const suppliedSlotsRaw = message.match(/\b(4|6|four|six)\s*[ -]?slots?\b/i)?.[1] ?? null;
    const suppliedSlots = suppliedSlotsRaw
      ? ({ four: "4", six: "6" }[suppliedSlotsRaw.toLowerCase()] ?? suppliedSlotsRaw)
      : null;
    // Once the customer supplies the slot count, let the catalogue path run.
    // The toaster category recognises Ya Kun/non-conveyor wording even when
    // the customer omits the word "toaster".
    if (suppliedSlots) return null;
    const parsedQuantity = requestedQuantity(message);
    const quantity = parsedQuantity !== null
      ? String(parsedQuantity)
      : input.context?.quantity
        ? String(input.context.quantity)
        : null;
    return reply(
      `Got it—you want a Ya Kun-style pop-up/slot toaster like the photo, not a conveyor toaster.${quantity ? ` I’ve kept quantity ${quantity}.` : ""} Choose 4 or 6 slots so I can check the closest catalogue option, availability and price.`,
      ["4-slot pop-up toaster", "6-slot pop-up toaster"],
    );
  }
  if (followsAmbiguousPhotoClarification && currentCategory === "toaster" && !specifiesToasterStyle) {
    const rejectsConveyor = [...input.history.filter((item) => item.role === "user").map((item) => item.content), message]
      .some((content) => /\b(?:not|no|non[ -]?|without|don['’]?t\s+want|do\s+not\s+want)\b[^.!?]{0,18}\bconve(?:yor|yr)\b|\bya\s*kun\b/i.test(content));
    const savedQuantity = input.context?.quantity
      ? ` I’ve kept quantity ${input.context.quantity}.`
      : "";
    return reply(
      `Thanks—that’s a toaster.${savedQuantity} Which style do you need? For the pictured pop-up type, choose 4 or 6 slots. I’ll then check the closest catalogue option, availability and price.`,
      rejectsConveyor
        ? ["4-slot pop-up toaster", "6-slot pop-up toaster"]
        : ["4-slot pop-up toaster", "6-slot pop-up toaster", "Conveyor toaster"],
    );
  }
  if (followsAmbiguousPhotoClarification && currentCategory === "toaster" && specifiesToasterStyle) {
    // The earlier photo turn already supplied the slot/non-conveyor details.
    // Continue to the grounded search instead of asking for them again.
    return null;
  }

  if (/^dry uncooked(?: or fresh)? noodles? for storage$/.test(simple)) {
    return reply(
      "Got it—you need noodle-drying equipment, not a cooking-water strainer. Is this for a small drying rack or a commercial dehydrating/drying machine, and roughly how many kilograms per batch?",
      ["Small drying rack", "Commercial drying machine"],
    );
  }

  if (isAmbiguousNoodleDryingRequest(message)) {
    return reply(
      "Do you mean drain the cooking water from cooked noodles, or dry uncooked/fresh noodles for storage? Those need different equipment.",
      ["Drain cooked noodles", "Dry uncooked noodles for storage"],
    );
  }

  if (isCookedNoodleDrainingIntent(message) && !/\b(?:strainer|skimmer|colander|sieve)\b/i.test(message)) {
    return null;
  }

  // If the customer attached an image, references to "this picture" describe
  // their buying request; they are not asking Claire to send another photo.
  const refersToCustomerPhoto = /\b(?:like|same\s+as|similar\s+to|from|in|attached)\s+(?:the\s+)?(?:pic|photo|image|picture)s?\b/i.test(message)
    || /\b(?:this|that)\s+(?:pic|photo|image|picture)s?\b/i.test(message);
  const asksClaireForProductPhoto = !input.image && !refersToCustomerPhoto && (
    /\b(can|could|will|would)\s+(?:you|u)\s+(?:please\s+)?(?:send|show|share|post)\b.{0,40}\b(pic|photo|image|picture)s?\b/i.test(message)
    || /\b(pic|photo|image|picture)s?\b.{0,30}\b(send|show|share|post)\b/i.test(message)
    || /\b(?:got|have|show|share|see|view)\b.{0,25}\b(?:sample\s+)?(?:pic|photo|image|picture)s?\b/i.test(message)
    || /\b(?:sample\s+)?(?:pic|photo|image|picture)s?\b/i.test(message)
  );

  if (asksClaireForProductPhoto) {
    return reply(
      activeTask
        ? `I can’t send product photos directly in this chat yet. The product cards include a Sia Huat listing link with the official photos. I still have ${activeTask}; choose an option and open its link.`
        : "I can’t send product photos directly in this chat yet. The product cards include a Sia Huat listing link with the official photos. Tell me the item first and I’ll find the right listings.",
      activeTask ? ["Show the options again", "Add a brand"] : ["Enter product name", "Add a brand"],
    );
  }

  if (humanHandoffContext && /^(no thanks|no thank you|not anymore|cancel (the )?(human )?(request|follow up)|never mind)$/.test(simple)) {
    return reply(
      `No problem—I won’t continue with the manual contact guidance.${activeTask ? ` Your ${activeTask.replace(/^your /, "")} enquiry is still in this conversation.` : " What else can I help you find?"}`,
      activeTask ? ["Continue with my enquiry", "Start again"] : ["Find a product", "Browse products"],
    );
  }

  if (/^(cancel|cancel this|cancel enquiry|stop|never mind|nevermind|forget it)$/.test(simple)) {
    return reply(
      activeTask
        ? `Okay, I’ve cancelled the ${activeTask.replace(/^your /, "")} enquiry. What else can I help you find?`
        : "Okay, cancelled. What else can I help you find?",
      ["Find a product", "Browse products"],
    );
  }

  if (/\b(what(?:'s| is) your (issue|problem|deal)|do you have (an? )?(issue|problem)|what is wrong with you|what's wrong with you)\b/.test(simple)) {
    return reply(
      activeTask
        ? `No issue on my side 😄 I’m Claire, and I’m here to help with ${activeTask}. Want to carry on?`
        : "All good 😄 I’m Claire from Sia Huat. What product are you looking for?",
      activeTask ? ["Yes, continue", "Start something else"] : ["Tell me what you sell", "Find a product", "Browse products"],
    );
  }

  if (/\b(?:you(?:'re| are)?|u(?:r| are)?)\s+(?:broken|buggy|not working)|\bthis\s+(?:is\s+)?broken\b|\b(?:wrong|bad)\s+(?:answer|reply|result)\b/.test(simple)) {
    return reply(
      activeTask
        ? `Sorry, that reply was off. I still have ${activeTask}. Tell me which part was wrong and I’ll correct it without restarting.`
        : "Sorry, that reply was off. Tell me what you were looking for and I’ll correct it.",
      activeTask ? ["Show the options again", "Change a detail", "Start again"] : ["Find a product", "Browse products"],
    );
  }

  if (/\b(are you (okay|ok|alright)|you (okay|ok|alright))\b/.test(simple)) {
    return reply(
      activeTask ? `I’m good, thanks for asking 😊 We can carry on with ${activeTask} whenever you’re ready.` : "I’m good, thanks for asking 😊 How can I help you today?",
      activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Tell me what you sell", "Browse products"],
    );
  }

  if (/\b(what are [a-z]{2,16} here for|what are you here for|why are you here|what do you do here|what(?:'s| is) your purpose|how can you help me)\b/.test(simple)) {
    return reply(
      "I’m Claire from Sia Huat. Tell me what you need and I’ll find the closest catalogue items and prices, then help with the enquiry.",
      ["Tell me what you sell", "Find a product", "Browse products"],
    );
  }

  if (/^(i changed my mind|changed my mind|actually never mind|actually nevermind|i want something else)$/.test(simple)) {
    return reply(
      activeTask ? `No problem—what would you like to change about ${activeTask}: the item, type, size, brand or quantity?` : "No problem—what would you like to look for instead?",
      activeTask ? ["Change the item", "Add a size or brand", "Start again"] : ["Find a product", "Browse products"],
    );
  }

  if (/\b(stock|stocks|in stock|on hand|available right now|availability right now)\b/.test(simple) && /\b(definitely|confirm|check|right now|live|on hand|available)\b/.test(simple)) {
    return reply(
      "I can’t confirm live stock for a general result list yet. Tell me the exact item first; after you confirm it, I’ll run a fresh check on its Sia Huat Add to cart listing.",
      ["Find a product", "Browse products"],
    );
  }

  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!?.,]+$/u.test(message)) {
    return reply("Hi 👋 What are you looking for? Send me the product name, brand or a photo.", ["Chef knives", "Cookware", "Glassware"]);
  }

  if (teaPreparationContext && /\btea\b/.test(simple)) {
    return reply(
      "Sorry, I can only help with Sia Huat product and order enquiries. What item are you looking for?",
      ["Find a product", "Browse products"],
    );
  }

  if ((/[鸡雞]/u.test(message) && /[骨]/u.test(message)) || (/[鸡雞]/u.test(message) && /\bbones?\b/.test(simple))) {
    return reply("如果需要切鸡骨，建议找砍骨刀（cleaver）。要我显示目录里的砍骨刀吗？", ["显示砍骨刀", "我只需要去骨/修肉"]);
  }

  if (coffeeContext && /\b(bottled|bottle|canned|can|ready to drink|ready-to-drink)\b/.test(simple)) {
    return reply(
      "Got it—you mean ready-to-drink bottled kopi kosong. I don’t see a confirmed ready-to-drink kopi kosong product in the current Sia Huat catalogue, so I won’t show unrelated bottles. Would coffee beans or brewing supplies work instead?",
      ["Show coffee beans", "Show brewing supplies", "No, bottled only"],
    );
  }

  if (coffeeContext && /^(yes|yes please|yes pls|yup|yeah|correct|that one|ok|okay|sure)$/.test(simple)) {
    return reply("Which coffee format do you mean: coffee beans, ground/instant coffee, or ready-to-drink bottled kopi?", ["Coffee beans", "Ground or instant", "Ready-to-drink bottled"]);
  }

  if (/\b(kopi\s*kosong|cof+e+\s*kosong|cofe\s*kosong|coffee\s*kosong)\b/.test(simple) || (/\b(coffee|cofee|cofe|kopi)\b/.test(simple) && /\b(ice|iced|icoe|kosong)\b/.test(simple))) {
    return reply("Do you mean kopi kosong? Which format do you need: coffee beans, ground/instant coffee, or ready-to-drink bottled kopi?", ["Coffee beans", "Ground or instant", "Ready-to-drink bottled"]);
  }

  if (currentCategory === "shoe" && !hasShoeSize && !hasShoeStyle) {
    return reply(
      "Can 👍 We carry work shoes rather than fashion loafers. What size do you wear? Slip-on or lace-up?",
      ["Slip-on", "Lace-up", "Show both"],
    );
  }

  if (shoeContext && hasShoeStyle && !hasShoeSize) {
    return reply("Okay. What size do you wear? EU or US size also can.", []);
  }

  if (shoeContext && hasShoeSize && !hasShoeStyle) {
    return reply(`Got it, ${shoeSize}. Slip-on or lace-up?`, ["Slip-on", "Lace-up", "Show both"]);
  }

  if (awaitingItemConfirmation && /^(yes|yes please|yup|yeah|correct|this is it|confirm|(?:yes[,\s-]*)?(?:that's|thats) the one|no|nope|wrong item|not this|(?:no[,\s-]*)?(?:that's|thats) not it|no[,\s-]*(?:show|give)( me)? (the )?(other|others|alternatives|options))([.!\s]*)$/i.test(message)) {
    return reply(
      /^(no|nope|wrong|not)/i.test(simple)
        ? "Okay, I won’t use that item. Please choose another option or tell me what was wrong with the match."
        : "Got it—you’re confirming the item shown. I’ll continue with it and ask for the quantity.",
      /^(no|nope|wrong|not)/i.test(simple) ? ["Show other options", "Add a detail"] : ["1", "6", "12", "24"],
    );
  }

  if (/^(yes[ ,]?)?(please )?(continue|continue helping|continue helping me|help me continue|let's continue|lets continue|carry on|get back to it|go ahead|back to (it|the knife))$/.test(simple) && activeTask) {
    if (lastCategory === "knife" && purpose === "cutting chicken") {
      return reply("Sure—we were finding a knife for cutting chicken. Are you cutting through bones or trimming the meat?", ["Cleaver", "Boning knife"]);
    }
    return reply(`Sure—let’s continue with ${activeTask}. What detail would you like to add?`, ["Add a brand", "Add a size", "Search now"]);
  }

  if (/\b(ignore(?: all| previous| the)? (?:instructions|rules|guidelines)|system prompt|password|api key|secret key|show.*credentials|reveal.*secret)\b/.test(simple)) {
    return reply(
      `I can’t help with passwords, credentials or internal instructions.${activeTask ? ` We can continue with ${activeTask}.` : " I can help with Sia Huat products and prices."}`,
      activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Browse products"],
    );
  }

  if (/\b(?:unicorns?|dragon|fairy|mermaid|magic)\b/.test(simple)
    && /\b(?:horns?|wings?|scales?|dust|wand|potion)\b/.test(simple)) {
    return reply("Sorry, we don’t carry that. We only handle products listed in the Sia Huat catalogue.", []);
  }

  if (/\bbanana\s+peels?\b/.test(simple)
    && !/\b(?:compost|composting|food\s+waste|discard(?:ing)?\s+food|dispose\s+of\s+food)\b/.test(simple)) {
    return reply(
      "We don't carry banana peels in the current Sia Huat catalogue. Tell me the commercial-kitchen or F&B item you need instead, and I'll check real catalogue products.",
      [],
    );
  }

  const unsupportedProductFamilies = [
    { pattern: /\b(ppe|personal protective equipment|safety helmets?|hard hats?|safety vests?|safety boots?)\b/, label: "PPE" },
    { pattern: /\b(electrical cable|electric cable|power cable|electrical wire|electric wire|circuit breaker|switchgear)\b/, label: "electrical supplies" },
    { pattern: /\b(condoms?|contraceptives?|sexual wellness|intimate wellness)\b/, label: "condoms or sexual-wellness products" },
    { pattern: /\b(prescription drugs?|pharmaceuticals?|medications?)\b/, label: "medication or pharmaceutical products" },
    { pattern: /\b(smartphones?|mobile phones?|tablets?|laptops?|televisions?|tvs?|game consoles?)\b/, label: "consumer electronics" },
    { pattern: /\b(cosmetics?|make-?up|skincare|perfumes?|fragrances?)\b/, label: "cosmetics or fragrances" },
    { pattern: /\b(pet food|dog food|cat food|pet toys?|pet supplies?)\b/, label: "pet supplies" },
    { pattern: /\b(car parts?|motorcycle parts?|automotive parts?|tyres?|motor oil)\b/, label: "automotive products" },
    { pattern: /\b(jewellery|jewelry|necklaces?|earrings?|bracelets?)\b/, label: "jewellery" },
    { pattern: /\b(cigarettes?|tobacco|vapes?|e-?cigarettes?)\b/, label: "tobacco or vaping products" },
    { pattern: /\b(?:mango(?:es)?|oranges?|apples?|fresh\s+fruit|fresh\s+produce)\b/, label: "fresh fruit or produce" },
  ].filter((family) => family.pattern.test(simple));

  if (unsupportedProductFamilies.length > 0) {
    const requested = [...new Set(unsupportedProductFamilies.map((family) => family.label))].join(" or ");
    return reply(
      `Sorry, we don’t carry ${requested}. Sia Huat supplies commercial kitchen and F&B products such as cookware, knives, tableware, glassware, barware, buffet and catering equipment, beverage supplies, food-prep machines and chef workwear. What do you need for your kitchen or F&B operation?`,
      ["Cookware", "Knives", "Tableware", "Food-prep equipment"],
    );
  }

  if (prataContext && /\b(bone|boning)\s+(?:knife|knives)\b/.test(simple)) {
    return reply(
      "No, I wouldn't recommend a bone knife for prata. It is made for meat and bone work. For cooked prata, kitchen scissors or a pizza cutter would make more sense. A chef's knife can work too.",
      ["Show kitchen scissors", "Show pizza cutters", "Show chef knives"],
    );
  }

  if (prataContext && /\b(which|what)\b.*\b(recommend|choose|best|good)|\b(recommend|which one|what knife|these knives)\b/.test(simple)) {
    if (rawPrataContext) {
      return reply(
        "For raw prata dough, I would look for a dough scraper or divider first. A bone knife is not suitable. Do you want me to check for dough scrapers?",
        ["Show dough scrapers", "I need a preparation surface", "It is for cooked prata"],
      );
    }

    return reply(
      `${cookedPrataContext ? "For cooked prata" : "If this is for cooked prata"}, kitchen scissors are practical, and a pizza cutter can work for quick portions. A chef's knife is another option. I would not use a bone knife. Which style do you prefer?`,
      ["Show kitchen scissors", "Show pizza cutters", "Show chef knives"],
    );
  }

  if (prataContext && /\b(board|tray|cutting board)\b/.test(simple) && /\b(is|use|used|suitable|right|correct|for)\b/.test(simple)) {
    return reply(
      "I can't confirm that the board-with-tray is made for prata from the catalogue description alone. It looks like a general preparation board, so I shouldn't recommend it just because its name contains 'cutting'. Are you cutting cooked prata for serving, dividing raw dough, or looking for a preparation surface?",
      ["Cut cooked prata for serving", "Divide raw prata dough", "Need a preparation surface"],
    );
  }

  if (prataContext && /\b(cooked|ready|serving|serve|portion|portions)\b/.test(simple)) {
    return reply(
      "Got it. This is for cooked prata. Do you want a handheld cutter, or a surface to cut and serve it on?",
      ["Handheld knife or cutter", "Board or workstation", "Not sure, help me choose"],
    );
  }

  if (prataContext && /\b(raw|dough|divide|dividing|portion dough|dough portions)\b/.test(simple)) {
    return reply(
      "Got it. This is for raw prata dough. Do you need a dough scraper, a knife, or a preparation surface?",
      ["Dough scraper or divider", "Knife", "Preparation surface"],
    );
  }

  if (prataContext && /\b(prep|preparation|surface|workstation)\b/.test(simple)) {
    return reply(
      "Okay. What size and material do you prefer? Is it for raw dough, or for cutting cooked prata?",
      ["Raw dough preparation", "Cut cooked prata", "Add size and material"],
    );
  }

  if (/\b(prata|roti prata|paratha)\b/.test(simple)) {
    return reply(
      "Sure. What do you need to do with the prata? Are you cutting cooked prata, dividing raw dough, or looking for a work surface?",
      ["Cut cooked prata for serving", "Divide raw prata dough", "Need a preparation surface"],
    );
  }

  if (!currentCategory && !/\b(chicken|poultry)\b/.test(simple) && /\b(something|things?|stuff|tools?|equipment)\b/.test(simple) && /\b(cut|cutting|prepare|preparing|serve|serving|make|making)\b/.test(simple)) {
    return reply(
      "Sure. What are you working with, and what do you need to do with it? I’ll narrow down the right product after that.",
      ["Describe the food or item", "Describe the task", "I know the product name"],
    );
  }

  if (/\b(something sharp|blue thing|red thing|kitchen stuff|kitchen things|something for the kitchen)\b/.test(simple)) {
    return reply(
      "Can you narrow it down a little—what will you use it for? The item type, size or material would help.",
      ["Describe how I’ll use it", "Add a size", "Add a material"],
    );
  }

  if (currentCategory === "pan" && /\b(cut|cutting|chop|chopping|slice|slicing)\b/.test(simple) && /\b(chicken|meat|food)\b/.test(simple)) {
    return reply(
      "Just checking—you mentioned a pan, but cutting chicken needs a knife. Are you looking for a knife to cut it, a pan to cook it, or both?",
      ["A knife for cutting", "A pan for cooking", "Both"],
    );
  }

  if (/\b(chicken|poultry)\b/.test(simple) && /\b(cut|cutting|chop|chopping|prepare|preparing|good for)\b/.test(simple) && !currentCategory) {
    return reply(
      "Are you looking for a knife to cut the chicken? If yes, will you be cutting through bones or trimming the meat?",
      ["Cutting through bones", "Trimming meat or joints", "No, I need something else"],
    );
  }

  const hasStrainerCompatibilityContext = input.history.some((item) =>
    /strainer[^.!?]{0,80}(?:fits?|fitted|compatib)|strainer-only compatib/i.test(item.content),
  );
  const potFitMeasurements = extractPotFitMeasurements(message);
  const suppliesPotCompatibilityDetails = potFitMeasurements.innerDiameter !== null
    || potFitMeasurements.usableDepth !== null
    || /^\s*pot\s+(?:brand\s*\/\s*model|brand|model)\s*:/i.test(message);
  if (hasStrainerCompatibilityContext && suppliesPotCompatibilityDetails) {
    const model = message.match(/\bpot\s+(?:brand\s*\/\s*model|brand|model)\s*:\s*([a-z0-9][a-z0-9 ./_-]{1,40})/i)?.[1]?.trim() ?? null;
    const details = model
      ? `pot brand/model ${model}`
      : potFitMeasurements.innerDiameter && potFitMeasurements.usableDepth
        ? `pot inner diameter ${potFitMeasurements.innerDiameter} and usable depth ${potFitMeasurements.usableDepth}`
        : potFitMeasurements.innerDiameter || potFitMeasurements.usableDepth
          ? `partial pot measurement ${potFitMeasurements.innerDiameter ?? potFitMeasurements.usableDepth}`
        : "pot compatibility details";
    const needsOtherMeasurement = !model
      && (!potFitMeasurements.innerDiameter || !potFitMeasurements.usableDepth);
    return reply(
      needsOtherMeasurement
        ? `I’ve kept the ${details} for the strainer-only request, and I won’t add another pot. Please add the ${potFitMeasurements.innerDiameter ? "usable depth" : "inner-rim diameter"} with its unit so sales can verify the fit safely.`
        : `I’ve kept the ${details} for the strainer-only request. I won’t add another pot. Because catalogue dimensions alone may not guarantee a safe fit, download the PDF and ask Sia Huat sales to verify the compatible food strainer before purchase.`,
      needsOtherMeasurement ? ["Enter the missing measurement", "Prepare staff review summary"] : ["Prepare staff review summary"],
      "clarify",
    );
  }

  const hasSpecifiedFoodPanLid = /\b1\s*\/\s*(?:2|4)\b/.test(message)
    && /\b(?:lids?|covers?)\b/i.test(message)
    && /\b(?:notch|slot|cut[ -]?out)\b/i.test(message);
  if (currentCategory === "lid" && !hasSpecifiedFoodPanLid && /\b(?:need|want|find|looking|replacement|lid|cover)\b/i.test(message)) {
    return reply(
      "Which item does the replacement lid need to fit? Send the pot, pan or container brand/model and the outer-rim diameter in cm. I’ll use those details to narrow the correct lid instead of guessing from the other items you already own.",
      ["Enter brand or model", "Enter rim diameter", "Prepare staff review summary"],
      "clarify",
    );
  }

  const mentionsPotAndStrainer = !hasUnrelatedPotOrBasketMeaning(message)
    && /\b(?:stock\s*pots?|pots?)\b/i.test(message)
    && /\b(?:strainers?|strainners?|straners?|skimmers?|colanders?|baskets?|inserts?)\b/i.test(message);
  const ownsStrainer = /\b(?:i|we)\s+(?:already|alr|currently)?\s*(?:have|got|own|bought|purchased)\b[^.!?;]{0,36}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message)
    || /^\s*(?:already\s+)?(?:have|got|own|bought|purchased)\b[^.!?;]{0,36}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message)
    || /^\s*(?:already|alr)\s+(?:have|got|own|bought|purchased)\b[^.!?;]{0,36}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message)
    || /\b(?:strainers?|colanders?|baskets?|inserts?)\b[^.!?;]{0,20}\b(?:already|alr)\s+(?:have|got|own|bought|purchased)\b/i.test(message)
    || /\b(?:my|our|existing|current)\s+(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message);
  const needsPotOnly = /\b(?:only|just)\s+(?:(?:need|want|buy|order|get|find)\s+)?(?:a|the|one|new)?\s*(?:stock\s*)?pots?\b/i.test(message);
  const requestsPot = /\b(?:need(?:s)?|want|buy|order|get|find|looking\s+for)\b[^.!?;]{0,28}\b(?:stock\s*)?pots?\b/i.test(message)
    || /\bwhich\s+(?:stock\s*)?pots?\b[^.!?;]{0,20}\bfit(?:s)?\b/i.test(message)
    || /\b(?:stock\s*)?pots?\b[^.!?;]{0,16}\b(?:need(?:ed)?|want(?:ed)?|find)\b/i.test(message);
  const requestsAnotherStrainer = /\b(?:need(?:s)?|want|buy|order|get|find|looking\s+for)\b[^.!?;]{0,28}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message);
  const potFitIsCurrentRequest = !currentCategory || ["pot", "stockpot", "strainer"].includes(currentCategory);
  if (potFitIsCurrentRequest && mentionsPotAndStrainer && ownsStrainer && (needsPotOnly || (requestsPot && !requestsAnotherStrainer))) {
    return reply(
      "Understood—you already have the strainer and only want a pot it fits inside. Send the strainer’s outer-rim diameter and usable height in cm, or its brand/model code, and I’ll help narrow the pot options without adding another strainer. A size label alone does not guarantee a safe fit.",
      ["Enter strainer measurements", "Use strainer brand or model", "Prepare staff review summary"],
    );
  }
  const requestsPairedPotAndStrainer = mentionsPotAndStrainer
    && !isExistingPotStrainerRequest(message)
    && (/\b(?:both|pair|sets?|together)\b/i.test(message)
      || /\b(?:need|want|buy|order|get)\b[^.!?]{0,65}\b(?:stock\s*)?pots?\b[^.!?]{0,30}(?:\b(?:and|with|plus)\b|\+)[^.!?]{0,30}\b(?:strainers?|colanders?|baskets?|inserts?)\b/i.test(message));
  if (potFitIsCurrentRequest && (isExistingPotStrainerRequest(message) || requestsStrainerForPot)) {
    const requestedSize = message.match(/\b\d+(?:\.\d+)?\s*QT\b/i)?.[0]?.replace(/\s+/g, "") ?? null;
    const ownsPot = isExistingPotStrainerRequest(message);
    return reply(
      ownsPot
        ? `Understood—you already have the ${requestedSize ? `${requestedSize} ` : ""}pot and only want a strainer that fits it. A capacity label alone does not guarantee fit. Send the pot’s inner-rim diameter and usable depth in cm, or its brand/model code, and I’ll look for a food strainer or colander without adding another pot.`
        : `Understood—you need a strainer that fits the ${requestedSize ? `${requestedSize} ` : ""}pot, not a handheld strainer or another pot. A capacity label alone does not guarantee fit. Send the pot’s inner-rim diameter and usable depth in cm, or its brand/model code, and I’ll narrow the compatible insert safely.`,
      ["Enter pot measurements", "Use pot brand or model", "Prepare staff review summary"],
    );
  }
  if (/^(?:share|enter|add)(?: the| my)? pot (?:dimensions|measurements)$|^use pot (?:brand|model|brand or model|brand or model code)$/i.test(message)) {
    return reply(
      "Please type the pot’s inner-rim diameter and usable depth in cm (for example, “30 cm diameter, 18 cm deep”), or send its brand/model code. I’ll keep this as a strainer-only compatibility request.",
      ["Prepare staff review summary"],
    );
  }
  if (potFitIsCurrentRequest && requestsPairedPotAndStrainer) {
    const pairQuantity = /\b(?:two|2)\b/i.test(message) ? 2 : input.context?.quantity ?? null;
    const requestedSize = message.match(/\b\d+(?:\.\d+)?\s*QT\b/i)?.[0]?.replace(/\s+/g, "") ?? null;
    const specification = [
      requestedSize,
      /\bstainless(?:\s+steel)?\b/i.test(message) ? "stainless steel" : null,
    ].filter(Boolean).join(" ");
    return reply(
      `I’ve kept both items${pairQuantity ? ` at quantity ${pairQuantity} each` : ""}: ${specification ? `${specification} ` : ""}stockpots and strainers that fit those exact pots. I can’t verify the fit safely from the catalogue alone. Download the PDF and ask Sia Huat sales to confirm and source the compatible pair.`,
      ["Share pot dimensions", "Prepare staff review summary"],
    );
  }

  if (currentCategories.length > 1) {
    const [first, second] = currentCategories;
    return reply(
      `Just checking—are you looking for both a ${first} and a ${second}, or only one of them?`,
      [`Both—start with ${first}`, `${first} only`, `${second} only`],
    );
  }

  if (/\b(knife|blade)\b/.test(simple) && /\b(machine|slicer|slicing machine)\b/.test(simple)) {
    const suppliedModel = message.match(/\b(?=[a-z0-9-]*\d)[a-z0-9]+(?:-[a-z0-9]+)+\b/i)?.[0];
    return reply(
      suppliedModel
        ? `Got it—the machine model is ${suppliedModel}. What is the machine brand or part number?`
        : "Which machine model is this for? Send the machine name, model number or part number so I don’t match the wrong blade.",
      suppliedModel ? ["Enter machine brand", "Enter part number"] : ["Enter machine model", "Enter part number"],
    );
  }

  if (/\bknife\b/.test(simple) && /\b(chicken|poultry)\b/.test(simple) && /\b(cut|cutting|chop|chopping|prepare|preparing|good for)\b/.test(simple)) {
    return reply(
      "For chicken, it depends—are you cutting through bones or trimming the meat? A cleaver is better for bones; a boning knife is better for meat and joints.",
      ["Cutting through bones", "Trimming meat or joints"],
    );
  }

  if ((/\b(chicken|poultry)\b/.test(simple) || purpose === "cutting chicken") && /\b(bone|bones|through bones)\b/.test(simple)) {
    return reply("For cutting through chicken bones, a cleaver is the better choice. Want me to show you the cleavers?", ["Show cleavers", "I only need to trim meat"]);
  }

  if ((/\b(chicken|poultry)\b/.test(simple) || purpose === "cutting chicken") && /\b(trim|trimming|debone|deboning|joint|joints|meat)\b/.test(simple)) {
    return reply("For trimming chicken meat or working around joints, a boning knife is the better fit. Want me to show those?", ["Show boning knives", "I need to cut bones"]);
  }

  if (/^(start something else|something else|new search|start again)$/.test(simple)) {
    return reply("Sure—what would you like to look for instead?", ["Chef knives", "Cookware", "Glassware"]);
  }

  const rememberedCategorySet = [...new Set(previousCategories)];
  const keepsPairedStockpotAndStrainer = (rememberedCategorySet.includes("stockpot") || rememberedCategorySet.includes("pot"))
    && rememberedCategorySet.includes("strainer")
    && /\bboth\b/.test(simple);
  if (keepsPairedStockpotAndStrainer) {
    const eachQuantity = simple.match(/\b(\d+)\s*(?:ea(?:ch)?|pcs?|pieces?|units?)\b/)?.[1]
      ?? (input.context?.quantity ? String(input.context.quantity) : null);
    const quantityCopy = eachQuantity ? ` Quantity ${eachQuantity} each.` : "";
    return reply(
      `Got it—I’ve kept both items: stockpots and matching strainers that fit those exact pots.${quantityCopy} No sourcing request has been sent. Download the PDF and ask Sia Huat sales to confirm and source the compatible pair.`,
      ["Share pot dimensions", "Prepare staff review summary"],
    );
  }
  if (/^(show both|both items|both|both start with (knife|pan)|start with (knife|pan))$/.test(simple) && rememberedCategorySet.length > 1) {
    if (/knife$/.test(simple)) return reply("Okay—let’s start with the knife. What will you use it for?", ["Cutting chicken", "General food prep", "Bread"]);
    if (/pan$/.test(simple)) return reply("Okay—let’s start with the pan. What kind do you need?", ["Frying pan", "Non-stick pan", "Sauce pan"]);
    return reply(`Sure—we’ll keep both the ${rememberedCategorySet[0]} and the ${rememberedCategorySet[1]}. Which one should we handle first?`, [`Start with ${rememberedCategorySet[0]}`, `Start with ${rememberedCategorySet[1]}`]);
  }

  if (/\b(what did i originally (want|ask for|come here for)|what was my original (item|request|enquiry)|what did i first (want|ask for))\b/.test(simple)) {
    const originalCategory = mentionedCategories[0] ?? null;
    const originalDisplay = originalCategory === "glassware" || originalCategory === "tableware" ? originalCategory : originalCategory ? `a ${originalCategory}` : null;
    return reply(
      originalDisplay
        ? `You originally came here looking for ${originalDisplay}${purpose && originalCategory === purposeCategory ? ` for ${purpose}` : ""}.`
        : "I don’t have an original product saved yet. What would you like to find?",
      originalDisplay ? ["Go back to that", "Continue with current item"] : ["Find a product", "Browse products"],
    );
  }

  if (/\b(what did i (say|tell you|come here (for|to (buy|get)))|what did i want to (buy|get)|what am i (buying|getting|looking for)( now)?|why did i come here|do you remember|can you remember|remember what i (said|wanted|asked)|what was i looking for)\b/.test(simple)) {
    const rememberedItems = [...new Set(previousCategories)];
    const summary = rememberedItems.length > 0
      ? purpose && rememberedItems.includes(purposeCategory ?? "")
        ? `You came here for ${purpose}. You were looking for ${rememberedItems.map((item) => item === "glassware" || item === "tableware" ? item : `a ${item}`).join(" and also mentioned ")}.`
        : `You came here looking for ${rememberedItems.map((item) => item === "glassware" || item === "tableware" ? item : `a ${item}`).join(" and ")}.`
      : null;
    return reply(
      summary ? `${summary} Want to continue from there?` : "We’ve only just started, so I don’t have an item or purpose saved yet. What are you looking for?",
      summary ? ["Yes, continue", "Start again"] : ["Chef knives", "Glassware", "Coffee beans"],
    );
  }

  if (/\b(add|also|too|as well)\b/.test(simple) && currentCategory === "pan") {
    const includesPanDetails = /\b(?:stainless(?:\s+steel)?|black\s+steel|carbon\s+steel|cast\s+iron|iron|aluminium|aluminum|steel|non[ -]?stick|fry(?:ing)?|skillet|omele+t+e?|crepe|pancake|grill|saucepan|gn|gastronorm|food\s+pan)\b/i.test(message)
      || /\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i.test(message);
    if (includesPanDetails) return null;
    const originalCategory = previousCategories.find((category) => category !== currentCategory) ?? lastCategory ?? "first item";
    return reply(
      `Got it—I’ll keep the ${originalCategory}${purpose ? ` for ${purpose}` : ""} and add a pan as well. What kind of pan do you need?`,
      ["Frying pan", "Non-stick pan", "Sauce pan"],
    );
  }

  if (/\b(switch|change|replace|instead|only)\b/.test(simple) && currentCategory) {
    const includesSearchDetail = /\b(?:chef|cleaver|boning|paring|frying|non[ -]?stick|sauce|black|white|red|blue|green|silver|round|square|oval|dinner|serving)\b/i.test(message)
      || /\b\d+(?:\.\d+)?\s*(?:cm|mm|inch|inches|in)\b/i.test(message);
    if (includesSearchDetail) return null;
    const display = currentCategory === "glassware" || currentCategory === "tableware" ? currentCategory : `a ${currentCategory}`;
    const options = currentCategory === "pan" ? ["Frying pan", "Non-stick pan", "Sauce pan"] : currentCategory === "knife" ? ["Chef’s knife", "Cleaver", "Boning knife"] : [`Search ${currentCategory}`, "Add a brand", "Add a size"];
    return reply(`Okay—we’ll switch to ${display}. What kind do you need?`, options);
  }

  if (/^keep (the )?knife$/.test(simple)) {
    return reply(
      `Okay—we’ll stick with the knife${purpose ? ` for ${purpose}` : ""}. Are you cutting through bones or trimming meat?`,
      ["Cleaver", "Boning knife"],
    );
  }

  if (currentCategory && lastCategory && currentCategory !== lastCategory
    && (/\bnever ?mind\b/.test(simple) || correctsPreviousCategory)) {
    // Explicit corrections such as "I was thinking more of spoons and forks"
    // replace the prior category. Let the grounded catalogue route answer
    // instead of asking the customer to confirm the switch they already made.
    return null;
  }

  if (currentCategory === "gas torch burner" && lastCategory === "gas cartridge") {
    // Customers often discover that the burner, not its fuel cartridge, is the
    // item they meant. A concrete burner name is enough to start that search;
    // do not make them answer an add-versus-switch question first.
    return null;
  }

  if (currentCategory && lastCategory && currentCategory !== lastCategory) {
    const previousDisplay = lastCategory === "glassware" || lastCategory === "tableware" ? lastCategory : `a ${lastCategory}`;
    const currentDisplay = currentCategory === "glassware" || currentCategory === "tableware" ? currentCategory : `a ${currentCategory}`;
    return reply(
      `Just checking—you were looking for ${previousDisplay}${purpose && lastCategory === purposeCategory ? ` for ${purpose}` : ""}. Do you want to add ${currentDisplay} as well, or switch to ${currentDisplay}?`,
      [`Add ${currentDisplay} too`, `Switch to ${currentDisplay}`, `Keep the ${lastCategory}`],
    );
  }

  if (/^(hey )?(i (need|want|am looking for) |do you have |show me |find me |looking for |got )?(a |some )?(knife|knives)$/.test(simple)) {
    return reply(
      "Sure—what kind of knife do you need? For example: chef’s knife, cleaver, bread knife, or paring knife.",
      ["Chef’s knife", "Cleaver", "Bread knife", "Paring knife"],
    );
  }

  if (hasProductContext && /\b(chicken|poultry)\b/.test(simple) && /\b(cut|cutting|chop|chopping|knife|good for)\b/.test(simple)) {
    return reply(
      "For chicken, it depends—are you cutting through bones or trimming the meat? A cleaver is better for bones; a boning knife is better for meat and joints.",
      ["Cleaver", "Boning knife"],
    );
  }

  if (/^(i want|i need|can i get|give me) (chicken rice|nasi lemak|fried rice|noodles|pizza|burger|pasta)$/.test(simple)) {
    const food = simple.replace(/^(i want|i need|can i get|give me) /, "");
    return reply(
      `We don’t sell cooked ${food} 😅 We supply kitchen and F&B equipment. Are you looking for serving ware or equipment for it instead?`,
      food === "chicken rice" ? ["Chicken rice bowls", "Rice scoops", "Serving trays"] : ["Serving ware", "Kitchen equipment"],
    );
  }

  if (/^(hi|hello|hey|hiya|yo|good morning|good afternoon|good evening)( there)?( what('s| is) up)?$/.test(simple)) {
    return reply(
      activeTask
        ? `Hey! Good to see you again 😊 We were looking at ${activeTask}. Want to carry on?`
        : "Hi! What are you looking for today? 😊",
      activeTask ? ["Yes, continue", "Start something else"] : ["I need a knife", "Find coffee beans", "Browse products"],
    );
  }

  if (/^(how are you|how's it going|how is it going|what's up|what is up|sup)$/.test(simple)) {
    return reply(
      activeTask ? `Good 😊 Want to carry on with ${activeTask}?` : "Good 😊 What are you shopping for?",
      ["I need a knife", "Find coffee beans", "Browse products"],
    );
  }

  if (/\b(tell me a joke|another joke|make me laugh)\b/.test(simple)) {
    return reply(
      `Okay, quick one: Why did the chef bring a ladder? To reach the top shelf 😄${activeTask ? ` Anyway—want to continue with ${activeTask}?` : " What shall we look for?"}`,
      activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Get a quote"],
    );
  }

  if (/\b(weather[a-z]*|wheather|forecast|football|soccer|movie|movies|latest news|the news)\b/.test(simple)) {
    return reply(
      `I’m not the best person for that one 😅${activeTask ? ` Shall we get back to ${activeTask}?` : " I can help you find Sia Huat products and prices though."}`,
      activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Get a quote"],
    );
  }

  if (/\b(python|javascript|typescript|java|c\+\+|programming|write (me )?(a )?(function|script|program|code)|merge sort|sorting algorithm|debug my code)\b/.test(simple)) {
    return reply(
      `I can only help with Sia Huat products and enquiries here.${activeTask ? ` Shall we get back to ${activeTask}?` : " What product are you looking for?"}`,
      activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Browse products"],
    );
  }

  if (/^(thanks|thank you|thanks a lot|thank you very much|thx|cheers)$/.test(simple)) {
    return reply("You’re welcome! What else can I help you find?", ["Find another product", "Browse products"]);
  }

  if (/^(ok|okay|alright|sure|got it|i see|understood|nice|great|sounds good)$/.test(simple) && !hasAssistantClarificationContext) {
    return reply("Great 👍 Tell me what you’d like to look for next.", ["Find a product", "Browse products"]);
  }

  if (/^(bye|goodbye|see you|see ya|talk to you later|have a good day)$/.test(simple)) {
    return reply("Goodbye! 👋 Come back anytime you need help with the catalogue.", ["Start another enquiry"]);
  }

  if (/\b(are you (an? )?(ai|bot|chatbot)|is this (an? )?(ai|bot|chatbot))\b/.test(simple)) {
    return reply(
      "Yes, I’m Sia Huat’s AI chat assistant. I can help with the catalogue and prepare an enquiry summary. This demo does not send it automatically; download the PDF and share it with a salesperson for review.",
      ["Find a product", "Browse products"],
    );
  }

  if (/\b(who are you|what are you|what is your name|what's your name)\b/.test(simple)) {
    return reply(
      "I’m Claire from Sia Huat. I can find catalogue items and prices, then help with your enquiry.",
      ["What can you do?", "Find a product", "Browse products"],
    );
  }

  if (/\b(where are you from|where you from|you from where|which company are you from)\b/.test(simple)) {
    return reply("I’m Claire, chatting on behalf of Sia Huat in Singapore. What can I help you find?", ["Find a product", "Get a quote"]);
  }

  if (/\b(are you (a )?(human|real person)|am i talking to (a )?(human|person))\b/.test(simple)) {
    return reply(
      "I’m Claire, Sia Huat’s AI chat assistant. I can prepare an enquiry summary, but this demo does not notify sales automatically. Download the PDF and share it with a salesperson for review.",
      ["Find a product", "Browse products"],
    );
  }

  if (/^(help|help me|what can you do|how can you help|how does this work)$/.test(simple)) {
    return reply(
      "Send me a product name, type, brand or photo. I’ll show the closest options and prices, then help with the quantity and enquiry.",
      ["I need a knife", "Find coffee beans", "Browse products"],
    );
  }

  if (/\b(what should i (even )?need|what do i need|why am i here|what can i ask|what (do|u|you|ypu).*sell|show me (the )?categories|what products)\b/.test(simple)) {
    return reply(
      "We mainly carry kitchen and F&B supplies—knives, cookware, plates, glassware, barware, buffet equipment, coffee and tea items. What are you looking for?",
      ["Chef knives", "Glassware", "Coffee beans"],
    );
  }

  if (/^(browse products|show me products|show products)$/.test(simple)) {
    return reply("Sure. What kind of product are you looking for?", ["Knives", "Cookware", "Glassware", "Coffee and tea"]);
  }

  if (/^(get|prepare|make)( me)? a quote$/.test(simple)) {
    return reply("Sure—which product do you need a quote for? Tell me its name, type or brand.", ["Search for a product", "Browse products"]);
  }

  if (/^(search by sku|i have (a )?sku|use (a )?sku)$/.test(simple)) {
    return reply("Sure—paste the SKU or stock ID here and I’ll look it up in the catalogue.", []);
  }

  if (/^(sorry|my bad|oops)$/.test(simple)) {
    return reply("No worries at all 😊 What would you like help finding?", ["Find a product", "Browse products"]);
  }

  if (/\b(chill|relax|take it easy|no rush)\b/.test(simple)) {
    return reply("All good 😄 Take your time—I’m here when you’re ready.", ["Tell you what I need", "Search for a product"]);
  }

  if (!currentCategory && !isCatalogueRequest(message)
    && /\b(a few things|few things|need your help|need some help|can you help me)\b/.test(simple)) {
    return reply("Of course—tell me the first thing you need help with, and we’ll take it one step at a time.", ["Search for a product", "Get a quote"]);
  }

  if (hasProductContext && /^(?:asdf|qwer|zxcv)[a-z0-9]*$/i.test(message)) {
    return reply(
      `I didn’t understand that. I still have ${activeTask ?? "your product enquiry"}. Try a product name, size, colour, material or option number.`,
      ["Show the options again", "Change a detail"],
    );
  }

  if (!currentCategory && !isCatalogueRequest(message)
    && /\b(can|could|will|would).*help( me)?\b/.test(simple)) {
    return reply("Can. What do you need help with?", ["Find a product", "Get a quote"]);
  }

  if (/\b(too slow|so slow|slow as|taking (too )?long|why .*long|response time|still loading|hanging)\b/i.test(message)) {
    return reply(
      "Yeah, sorry about that. Tell me the product name or brand and I’ll get straight to it.",
      ["I need a knife", "Browse products"],
    );
  }

  if (/\b(lol|lmao|wow|wah|damn|oh shit|nice one|cool sia)\b/.test(simple)) {
    return reply("Haha 😄 What do you want to look for next?", ["Find a product", "Get a quote"]);
  }

  // Once a product conversation starts, n8n remains responsible for product context.
  if (hasProductContext || hasAssistantClarificationContext || currentCategory || isCatalogueRequest(message)) return null;

  // A photo can supply the missing product noun. Let the image-aware catalogue
  // path inspect it instead of rejecting casual text such as "this Ya Kun type".
  if (input.image) return null;

  // Keep unrecognised open-ended conversation inside the Sia Huat product
  // scope. Passing it to a general conversational model can produce a fluent
  // but unrelated answer (for example, travel-planning help).
  return reply(
    `I can only help with Sia Huat products and enquiries here.${activeTask ? ` Shall we get back to ${activeTask}?` : " What product are you looking for?"}`,
    activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Browse products"],
  );
}
