import {
  createFastReply as reply,
  catalogueHistoryWithClarification,
  extractExplicitShoeSize,
  extractShoeStyle,
  isCatalogueRequest,
  productCategories,
  productCategory,
  productWords,
  rememberedActiveCategories,
  rememberedPurpose,
  simplifyMessage,
  type FastChatInput,
  type FastReply,
} from "@/lib/chat-intent";

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
  const currentCategory = productCategory(message);
  const correctsPreviousCategory = /\b(?:i\s+)?(?:was\s+)?thinking\s+(?:more\s+)?of\b|\b(?:i\s+)?meant\b|\bmore\s+like\b/i.test(message);
  let currentCategories = productCategories.filter((category) => category.pattern.test(message)).map((category) => category.label);
  if (currentCategories.includes("utensil") && currentCategories.includes("blender")
    && /\b(?:3[ -]?in[ -]?1|three[ -]?in[ -]?one|blender[\s,/-]+whisk|whisk[\s,/-]+blender)\b/i.test(message)) {
    currentCategories = ["utensil"];
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
  const asksOperationalFollowup = /\b(?:quote|quotation|invoice|email|e-mail|payment|bank\s+transfer|payment\s+advice|delivery|order)\b/i.test(message)
    && /\b(?:status|update|check|follow\s*up|not\s+(?:received|arrived)|no\s+(?:email|reply)|has\s+not|hasn['’]?t|haven['’]?t|still\s+waiting|when\s+will|when\s+is|approved|arranged|overdue|pending|where\s+is)\b/i.test(message);

  if (/\b(?:call(?:ing)?|contact|get)\s+(?:the\s+)?police\b|\bhello\s+police\b/i.test(message)) {
    return reply(
      "I’m sorry we kept showing the wrong items. I’ll stop the product suggestions and hand this to a human colleague for review. They’ll be here in about 5–10 minutes.",
      ["Speak to a human"],
    );
  }

  if (requestsHuman && !asksAboutIdentity) {
    return reply("I’ve alerted a human colleague. They’ll be here in about 5–10 minutes.", []);
  }

  if (asksOperationalFollowup) {
    const suppliedReference = message.match(/\b(?:SQ|SO|INV|PO)(?:-[A-Z0-9]+)+\b/i)?.[0] ?? null;
    return reply(
      suppliedReference
        ? `I’ve recorded reference ${suppliedReference} and alerted a human colleague to check it. They’ll be here in about 5–10 minutes.`
        : "I’ve alerted a human colleague to check this. They’ll be here in about 5–10 minutes. Please share the quotation, invoice or order number if you have it.",
      suppliedReference ? ["Continue product enquiry"] : ["Share reference number", "Continue product enquiry"],
    );
  }

  const followsAmbiguousPhotoClarification = input.history.slice(-4).some((item) =>
    item.role === "assistant"
    && /received the photo/i.test(item.content)
    && /identify the item confidently/i.test(item.content),
  );
  const specifiesToasterStyle = /\b(?:pop[ -]?up|non[ -]?conveyor|slots?|conveyor)\b/i.test(message);
  if (followsAmbiguousPhotoClarification && currentCategory === "toaster" && !specifiesToasterStyle) {
    const savedQuantity = input.context?.quantity
      ? ` I’ve kept quantity ${input.context.quantity}.`
      : "";
    return reply(
      `Thanks—that’s a toaster.${savedQuantity} Which style do you need? For the pictured pop-up type, choose 4 or 6 slots. I’ll then check the closest catalogue option, availability and price.`,
      ["4-slot pop-up toaster", "6-slot pop-up toaster", "Conveyor toaster"],
    );
  }

  // If the customer attached an image, references to "this picture" describe
  // their buying request; they are not asking Claire to send another photo.
  const asksClaireForProductPhoto = !input.image && (
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
      `No problem—I won’t request human follow-up.${activeTask ? ` Your ${activeTask.replace(/^your /, "")} enquiry is still here.` : " What else can I help you find?"}`,
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

  const requestsPairedPotAndStrainer = (currentCategories.includes("stockpot") || currentCategories.includes("pot"))
    && currentCategories.includes("strainer")
    && /\b(?:both|matching|fit|inside|same)\b/i.test(message);
  if (requestsPairedPotAndStrainer) {
    const pairQuantity = /\b(?:two|2)\b/i.test(message) ? 2 : input.context?.quantity ?? null;
    const requestedSize = message.match(/\b\d+(?:\.\d+)?\s*QT\b/i)?.[0]?.replace(/\s+/g, "") ?? null;
    const specification = [
      requestedSize,
      /\bstainless(?:\s+steel)?\b/i.test(message) ? "stainless steel" : null,
    ].filter(Boolean).join(" ");
    return reply(
      `I’ve kept both items${pairQuantity ? ` at quantity ${pairQuantity} each` : ""}: ${specification ? `${specification} ` : ""}stockpots and strainers that fit those exact pots. I can’t verify the fit safely from the catalogue alone, so I’ve alerted a human colleague to source and confirm the compatible pair. They’ll be here in about 5–10 minutes.`,
      ["Share pot dimensions", "Continue product enquiry"],
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
      "Yes, I’m Sia Huat’s AI chat assistant. I can help with the catalogue and enquiries; the sales team reviews everything before it’s confirmed.",
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
      "I’m Claire, Sia Huat’s AI chat assistant. The sales team reviews enquiries before anything is confirmed.",
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

  // Keep unrecognised open-ended conversation inside the Sia Huat product
  // scope. Passing it to a general conversational model can produce a fluent
  // but unrelated answer (for example, travel-planning help).
  return reply(
    `I can only help with Sia Huat products and enquiries here.${activeTask ? ` Shall we get back to ${activeTask}?` : " What product are you looking for?"}`,
    activeTask ? ["Yes, continue", "Start something else"] : ["Find a product", "Browse products"],
  );
}
