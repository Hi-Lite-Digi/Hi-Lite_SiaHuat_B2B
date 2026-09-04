import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogueMessageWithContext,
  explicitKnifeBrand,
  extractPotFitMeasurements,
  isAmbiguousNoodleDryingRequest,
  isCookedNoodleDrainingIntent,
  isExactStockQuestion,
  isExistingPotStrainerRequest,
  isTradePriceQuestion,
  productCategory,
  requestedProductCategory,
} from "./chat-intent";
import { requestedQuantity } from "./chat-turn";
import { getFastChatReply } from "./fast-chat";

const gasCartridge = {
  stock_id: "GAS",
  name: "IWATANI GAS CARTRIDGE 250gm/can, 3pcs/pkt, 48pcs/ctn, IWATANI",
  status: "Active",
  list_price: 3.85,
  uom_id: "PC",
  stock_status: "in_stock" as const,
  available_quantity: 4130,
};

const torchBurner = {
  stock_id: "BTS-8026D",
  name: "CASSETTE GAS TORCH BURNER L15.6xW5.8xH5cm, BLUE, SAFICO PRO",
  status: "Active",
  list_price: 23.36,
  uom_id: "PC",
  stock_status: "in_stock" as const,
  available_quantity: 426,
};

test("turns imperfect cooked-noodle wording into a food-strainer search", () => {
  assert.equal(isAmbiguousNoodleDryingRequest("i need to dry noodles"), true);
  assert.equal(isCookedNoodleDrainingIntent("i cook my maggie then need to throw the water"), true);
  assert.equal(isCookedNoodleDrainingIntent("boil mee then pour water away"), true);
  assert.equal(productCategory("i cook my maggie then need to throw the water"), "strainer");
  assert.equal(isCookedNoodleDrainingIntent("cook meggemi already, water how to throw ah"), true);
  assert.equal(productCategory("cook meggemi already, water how to throw ah"), "strainer");
  assert.equal(
    catalogueMessageWithContext("cook meggemi already, water how to throw ah", []),
    "noodle strainer colander",
  );
  assert.equal(isCookedNoodleDrainingIntent("how to throw this water away"), false);
  assert.equal(
    catalogueMessageWithContext(
      "i cook my maggie then need to throw the water",
      ["i need to dry noodles"],
    ),
    "noodle strainer colander",
  );

  const clarification = getFastChatReply({
    sessionId: "unit-noodle-1",
    message: "i need to dry noodles",
    history: [],
  });
  assert.match(clarification?.message ?? "", /drain the cooking water/i);

  const continuation = getFastChatReply({
    sessionId: "unit-noodle-1",
    message: "i cook my maggie then need to throw the water",
    history: [
      { role: "user", content: "i need to dry noodles" },
      { role: "assistant", content: clarification?.message ?? "" },
    ],
  });
  assert.equal(continuation, null, "the grounded food-strainer lookup should handle this turn");
});

test("answers trade-price and exact-stock questions instead of replaying the card", () => {
  for (const question of ["how much stock?", "stock balance?", "stock level?", "available qty?", "quantity available?"]) {
    assert.equal(isExactStockQuestion(question), true, question);
  }
  assert.equal(isTradePriceQuestion("2nd one how much for us? got 5 or not"), true);
  assert.equal(isExactStockQuestion("2nd one how much for us? got 5 or not"), true);
  assert.equal(isExactStockQuestion("2nd one how much for us? got five or not"), true);
  assert.equal(isExactStockQuestion("have 5?"), true);
  for (const question of [
    "can you supply five",
    "can supply five?",
    "five available?",
    "got 5 left?",
    "have five on hand?",
    "got 5 stock?",
    "have 5 units left?",
    "enough for five?",
  ]) assert.equal(isExactStockQuestion(question), true, question);
  const context = {
    displayedProducts: [gasCartridge],
    activeProduct: null,
    quantity: null,
    stage: "clarify" as const,
  };
  const trade = getFastChatReply({ sessionId: "unit-gas-info-1", message: "Can I have the trade price?", history: [], context });
  assert.match(trade?.message ?? "", /\$3\.85/);
  assert.match(trade?.message ?? "", /not a confirmed trade price/i);
  assert.match(trade?.message ?? "", /quantity and (?:your )?(?:business|customer account)/i);

  const stock = getFastChatReply({ sessionId: "unit-gas-info-1", message: "how many stock you have?", history: [], context });
  assert.match(stock?.message ?? "", /4130 PC available/i);
  assert.match(stock?.message ?? "", /select this item/i);
  assert.deepEqual(stock?.suggestions, ["1"]);

  const shortCountQuestion = getFastChatReply({ sessionId: "unit-gas-info-count", message: "have 5?", history: [], context });
  assert.match(shortCountQuestion?.message ?? "", /4130 PC available/i);
  assert.match(shortCountQuestion?.message ?? "", /5 are currently available/i);
  assert.deepEqual(shortCountQuestion?.suggestions, ["Take 5 of option 1", "Change quantity"]);

  const selectedStock = getFastChatReply({
    sessionId: "unit-gas-info-2",
    message: "exact stock?",
    history: [],
    context: { ...context, activeProduct: gasCartridge, stage: "quantity" as const },
  });
  assert.match(selectedStock?.message ?? "", /How many do you need/i);
  assert.equal(selectedStock?.stage, "quantity");
  assert.deepEqual(selectedStock?.suggestions, ["1", "6", "12", "24"]);

  const unavailable = getFastChatReply({
    sessionId: "unit-gas-info-3",
    message: "how many stock left?",
    history: [],
    context: {
      ...context,
      displayedProducts: [{ ...gasCartridge, stock_status: "out_of_stock" as const, available_quantity: 0 }],
    },
  });
  assert.match(unavailable?.message ?? "", /out of stock/i);
  assert.doesNotMatch(unavailable?.message ?? "", /choose option 1/i);

  const unknown = getFastChatReply({
    sessionId: "unit-gas-info-4",
    message: "how many stock left?",
    history: [],
    context: {
      ...context,
      displayedProducts: [{ ...gasCartridge, available_quantity: null }],
    },
  });
  assert.match(unknown?.message ?? "", /does not provide an exact stock count/i);
  assert.doesNotMatch(unknown?.message ?? "", /\b0\b.*available/i);

  const optionContext = { ...context, displayedProducts: [gasCartridge, torchBurner] };
  const optionTrade = getFastChatReply({
    sessionId: "unit-gas-info-5",
    message: "trade price for option 2?",
    history: [],
    context: optionContext,
  });
  assert.match(optionTrade?.message ?? "", /BTS-8026D|CASSETTE GAS TORCH BURNER/i);
  assert.match(optionTrade?.message ?? "", /\$23\.36/);
  assert.match(optionTrade?.message ?? "", /select option 2/i);
  assert.deepEqual(optionTrade?.suggestions, ["2", "Prepare staff review summary"]);
  assert.equal(optionTrade?.stage, "clarify");

  const optionStock = getFastChatReply({
    sessionId: "unit-gas-info-6",
    message: "exact stock of item 2?",
    history: [],
    context: optionContext,
  });
  assert.match(optionStock?.message ?? "", /426 PC available/i);
  assert.match(optionStock?.message ?? "", /select option 2/i);
  assert.deepEqual(optionStock?.suggestions, ["2"]);
  assert.equal(optionStock?.stage, "clarify");

  const otherActiveProductStock = getFastChatReply({
    sessionId: "unit-gas-info-8",
    message: "exact stock of item 2?",
    history: [],
    context: { ...optionContext, activeProduct: gasCartridge, quantity: 5000, stage: "quantity" as const },
  });
  assert.match(otherActiveProductStock?.message ?? "", /426 PC available/i);
  assert.match(otherActiveProductStock?.message ?? "", /select option 2/i);
  assert.doesNotMatch(otherActiveProductStock?.message ?? "", /requested 5000|below your requested/i);
  assert.deepEqual(otherActiveProductStock?.suggestions, ["2"]);
  assert.equal(otherActiveProductStock?.stage, "clarify");

  const reducedStock = getFastChatReply({
    sessionId: "unit-gas-info-7",
    message: "how much stock now?",
    history: [],
    context: { ...context, activeProduct: gasCartridge, quantity: 5000, stage: "clarify" as const },
  });
  assert.match(reducedStock?.message ?? "", /only 4130 PC available/i);
  assert.deepEqual(reducedStock?.suggestions, ["4130", "Choose another item"]);

  const combinedHumanQuestion = getFastChatReply({
    sessionId: "unit-gas-info-combined",
    message: "2nd one how much for us? got 5 or not",
    history: [],
    context: optionContext,
  });
  assert.match(combinedHumanQuestion?.message ?? "", /BTS-8026D|CASSETTE GAS TORCH BURNER/i);
  assert.match(combinedHumanQuestion?.message ?? "", /\$23\.36/);
  assert.match(combinedHumanQuestion?.message ?? "", /catalogue list price before GST, not a confirmed trade price/i);
  assert.match(combinedHumanQuestion?.message ?? "", /426 PC available/i);
  assert.match(combinedHumanQuestion?.message ?? "", /5 are currently available/i);
  assert.deepEqual(combinedHumanQuestion?.suggestions, ["Take 5 of option 2", "Prepare staff review summary"]);
  assert.equal(combinedHumanQuestion?.selectedProduct, null);
  assert.doesNotMatch(combinedHumanQuestion?.message ?? "", /Just to confirm/i);

  const combinedWordNumberQuestion = getFastChatReply({
    sessionId: "unit-gas-info-combined-words",
    message: "2nd one how much for us? got five or not",
    history: [],
    context: optionContext,
  });
  assert.match(combinedWordNumberQuestion?.message ?? "", /426 PC available/i);
  assert.match(combinedWordNumberQuestion?.message ?? "", /5 are currently available/i);
  assert.deepEqual(combinedWordNumberQuestion?.suggestions, ["Take 5 of option 2", "Prepare staff review summary"]);

  const combinedOutOfStockQuestion = getFastChatReply({
    sessionId: "unit-gas-info-combined-oos",
    message: "2nd one how much for us? got 5 or not",
    history: [],
    context: {
      ...optionContext,
      displayedProducts: [
        gasCartridge,
        { ...torchBurner, stock_status: "out_of_stock" as const, available_quantity: 0 },
      ],
    },
  });
  assert.match(combinedOutOfStockQuestion?.message ?? "", /out of stock/i);
  assert.doesNotMatch((combinedOutOfStockQuestion?.suggestions ?? []).join(" "), /Take \d+/i);
  assert.deepEqual(combinedOutOfStockQuestion?.suggestions, ["Choose another item", "Prepare staff review summary"]);
});

test("a burner name replaces stale gas-cartridge intent without another confirmation", () => {
  for (const message of [
    "CASSETTE GAS TORCH BURNER",
    "IWATANI, GAS TORCH BURNER",
    "TORCH BURNER, IWATAN",
    "actually need the torch head also got?",
    "burner head, not gas can",
    "not gas can, burner head",
    "not cartridge. need burner head",
    "i don't need cartridge, give burner head",
    "no lah. i want the metal torch burner attachment, not cartridge",
  ]) {
    assert.equal(productCategory(message), "gas torch burner", message);
    assert.equal(
      getFastChatReply({
        sessionId: "unit-gas-switch-1",
        message,
        history: [
          { role: "user", content: "GAS CARTRIDGE" },
          { role: "assistant", content: "This looks like the closest match." },
        ],
        context: { displayedProducts: [gasCartridge], activeProduct: null, quantity: null },
      }),
      null,
      message,
    );
  }
  assert.notEqual(productCategory("need replacement burner head for my commercial stove"), "gas torch burner");
  assert.equal(
    catalogueMessageWithContext("TORCH BURNER, IWATAN", ["GAS CARTRIDGE"]),
    "Iwatani gas torch burner",
  );
  assert.equal(
    catalogueMessageWithContext("SAFICO PRO TORCH BURNER", ["GAS CARTRIDGE"]),
    "SAFICO PRO gas torch burner",
  );
});

test("uses an existing pot only as a compatibility reference", () => {
  const reply = getFastChatReply({
    sessionId: "unit-pot-reference-1",
    message: "I already have a 12QT pot. I only need a fitted strainer.",
    history: [],
  });
  assert.match(reply?.message ?? "", /already have the 12QT pot/i);
  assert.match(reply?.message ?? "", /only want a strainer/i);
  assert.match(reply?.message ?? "", /inner-rim diameter/i);
  assert.doesNotMatch(reply?.message ?? "", /matching pot and strainer/i);

  for (const details of [
    "Pot inner diameter: 30 cm; usable depth: 18 cm",
    "Pot brand/model: ABC-123",
  ]) {
    const continuation = getFastChatReply({
      sessionId: "unit-pot-reference-1",
      message: details,
      history: [
        { role: "user", content: "I already have a 12QT pot. I only need a fitted strainer." },
        { role: "assistant", content: reply?.message ?? "" },
      ],
    });
    assert.match(continuation?.message ?? "", /strainer-only request/i);
    assert.match(continuation?.message ?? "", /won.?t add another pot/i);
    assert.doesNotMatch(continuation?.message ?? "", /add.*pot.*enquiry|switch.*pot/i);
  }
});

test("understands human existing-pot insert wording and labelled fit dimensions", () => {
  const first = "got 12qt pot alr. only need the basket inside fit one";
  const correction = "no pot i have. need strainer fit inside";
  const justNeed = "got pot already just need basket";
  const measurements = "inside 30cm, deep 18. strainer only ok";

  assert.equal(isExistingPotStrainerRequest(first), true);
  assert.equal(isExistingPotStrainerRequest(correction), true);
  assert.equal(isExistingPotStrainerRequest(justNeed), true);
  assert.equal(productCategory(first), "strainer");
  assert.equal(productCategory(correction), "strainer");
  assert.deepEqual(extractPotFitMeasurements(measurements), {
    innerDiameter: "30 cm",
    usableDepth: "18 cm",
  });
  assert.equal(productCategory("bread basket"), "basket");
  assert.equal(productCategory("storage basket"), "basket");
  assert.equal(isExistingPotStrainerRequest("I do not have a pot. I need a pot and basket that fits inside."), false);
  assert.equal(isExistingPotStrainerRequest("I already have the strainer; only need the pot it fits inside."), false);
  assert.equal(productCategory("I already have the strainer; only need the pot it fits inside."), "pot");
  assert.equal(isExistingPotStrainerRequest("Do you have a pot with a basket that fits inside?"), false);
  assert.equal(isExistingPotStrainerRequest("I have a strainer and need a pot that fits it"), false);
  assert.equal(isExistingPotStrainerRequest("I already have an old pot but I need a new pot and a strainer that fits it"), false);
  assert.equal(isExistingPotStrainerRequest("I have 12qt pot. basket only."), true);
  assert.equal(isExistingPotStrainerRequest("12qt pot alr, insert only"), true);
  for (const humanRequest of [
    "I need a strainer for my 12qt pot",
    "strainer for my existing pot",
    "got pot already. need basket",
    "need basket for pot i already have",
    "I have 12qt pot. don't want another pot, need strainer fits inside",
    "got pot already. do not need new pot, basket only",
    "got my pot already, just find basket",
    "I have the 12 qt stock pot; can find colander for it?",
    "already own pot. basket?",
    "pot already got. strainer pls",
    "my pot needs a basket",
    "got pot already, no more pot, just basket",
    "no pot needed, basket only",
  ]) {
    assert.equal(isExistingPotStrainerRequest(humanRequest), true, humanRequest);
    assert.equal(productCategory(humanRequest), "strainer", humanRequest);
    const humanReply = getFastChatReply({ sessionId: `unit-pot-${humanRequest}`, message: humanRequest, history: [] });
    assert.match(humanReply?.message ?? "", /already have the (?:12QT )?pot/i, humanRequest);
    assert.match(humanReply?.message ?? "", /only want a strainer/i, humanRequest);
    assert.doesNotMatch(humanReply?.message ?? "", /both items|switch to a pot/i, humanRequest);
  }

  for (const unrelatedBasket of [
    "I have a pot and need a storage basket",
    "I have a pot and need a bread basket",
    "I have a pot and need a knife basket",
    "I want a plant pot with basket stand",
    "I have pot stickers and need bamboo basket",
    "I have a coffee pot and need a filter basket",
    "I have a pot and need a fruit basket",
    "I have a pot and need a shopping basket",
    "I have a pot and need a fryer basket",
    "I have a pot and need a wire basket",
    "I have a pot and need a dish basket",
    "I have a stockpot and need a basket of knives",
    "I have a pot and need a basket for bread",
    "I have a pot and need a basket to store knives",
    "I have a pot and need a basket for the deep fryer",
  ]) {
    assert.equal(isExistingPotStrainerRequest(unrelatedBasket), false, unrelatedBasket);
    assert.notEqual(productCategory(unrelatedBasket), "strainer", unrelatedBasket);
    const unrelatedReply = getFastChatReply({ sessionId: `unit-unrelated-${unrelatedBasket}`, message: unrelatedBasket, history: [] });
    assert.doesNotMatch(unrelatedReply?.message ?? "", /food strainer|strainer that fits|both a pot and a strainer/i, unrelatedBasket);
  }

  const inverseReply = getFastChatReply({
    sessionId: "unit-pot-inverse",
    message: "I already have the strainer; only need the pot it fits inside.",
    history: [],
  });
  assert.match(inverseReply?.message ?? "", /already have the strainer/i);
  assert.match(inverseReply?.message ?? "", /only want a pot/i);
  assert.doesNotMatch(inverseReply?.message ?? "", /already have (?:a |the |my |our )?(?:12QT )?pot|only want a strainer/i);

  const inverseWithoutOnlyReply = getFastChatReply({
    sessionId: "unit-pot-inverse-human",
    message: "I have a strainer and need a pot that fits it",
    history: [],
  });
  assert.match(inverseWithoutOnlyReply?.message ?? "", /already have the strainer/i);
  assert.match(inverseWithoutOnlyReply?.message ?? "", /only want a pot/i);

  for (const inverseHumanRequest of [
    "strainer already have, pot need",
    "already got basket. find pot for it",
    "my basket needs a matching pot",
    "I own a colander; which pot fits?",
    "have strainer, only pot please",
    "I got insert already, can you find pot",
    "I bought the strainer already, now need pot",
  ]) {
    const inverseHumanReply = getFastChatReply({ sessionId: `unit-pot-inverse-${inverseHumanRequest}`, message: inverseHumanRequest, history: [] });
    assert.match(inverseHumanReply?.message ?? "", /already have the strainer/i, inverseHumanRequest);
    assert.match(inverseHumanReply?.message ?? "", /only want a pot/i, inverseHumanRequest);
  }

  const togetherReply = getFastChatReply({
    sessionId: "unit-pot-pair-together",
    message: "can I buy pot + strainer together",
    history: [],
  });
  assert.match(togetherReply?.message ?? "", /kept both items/i);

  const firstReply = getFastChatReply({ sessionId: "unit-pot-human", message: first, history: [] });
  assert.match(firstReply?.message ?? "", /already have the 12QT pot/i);
  assert.match(firstReply?.message ?? "", /only want a strainer/i);
  assert.doesNotMatch(firstReply?.message ?? "", /switch to a pot|both items/i);

  const correctionReply = getFastChatReply({
    sessionId: "unit-pot-human",
    message: correction,
    history: [
      { role: "user", content: first },
      { role: "assistant", content: firstReply?.message ?? "" },
    ],
  });
  assert.match(correctionReply?.message ?? "", /only want a strainer/i);
  assert.doesNotMatch(correctionReply?.message ?? "", /both items|switch to a pot/i);

  const measurementReply = getFastChatReply({
    sessionId: "unit-pot-human",
    message: measurements,
    history: [
      { role: "user", content: first },
      { role: "assistant", content: firstReply?.message ?? "" },
      { role: "user", content: correction },
      { role: "assistant", content: correctionReply?.message ?? "" },
    ],
  });
  assert.match(measurementReply?.message ?? "", /inner diameter 30 cm/i);
  assert.match(measurementReply?.message ?? "", /usable depth 18 cm/i);
  assert.match(measurementReply?.message ?? "", /strainer-only/i);
  assert.match(measurementReply?.message ?? "", /verify the compatible food strainer/i);
  assert.doesNotMatch(measurementReply?.message ?? "", /both items|switch to a pot/i);

  const explicitPair = getFastChatReply({
    sessionId: "unit-pot-pair",
    message: "I need both a 12QT pot and matching strainer",
    history: [],
  });
  assert.match(explicitPair?.message ?? "", /kept both items/i);

  const explicitPluralPair = getFastChatReply({
    sessionId: "unit-pot-pair-plural",
    message: "I need two 12QT stainless steel stockpots and matching strainers that fit inside them.",
    history: [],
  });
  assert.match(explicitPluralPair?.message ?? "", /kept both items/i);
  assert.match(explicitPluralPair?.message ?? "", /quantity 2 each/i);

  const customerNeedsBoth = getFastChatReply({
    sessionId: "unit-pot-pair-no-pot",
    message: "I do not have a pot. I need a pot and strainer that fits inside.",
    history: [],
  });
  assert.match(customerNeedsBoth?.message ?? "", /kept both items/i);
  assert.doesNotMatch(customerNeedsBoth?.message ?? "", /already have the pot/i);
});

test("routes rejected displayed products to the newly requested category", () => {
  const pan = {
    stock_id: "PAN-28",
    name: "FRYING PAN 28CM",
    status: "Active",
    list_price: 25,
    uom_id: "PC",
    stock_status: "in_stock" as const,
    available_quantity: 12,
  };

  assert.equal(productCategory("ATLANTIC CHEF CHEF KNIFE"), "knife");
  assert.equal(requestedProductCategory("not this pan, need toaster"), "toaster");
  assert.equal(requestedProductCategory("not cartridge. need burner head. got five or not"), "gas torch burner");
  assert.equal(requestedProductCategory("i do not need cartridge, give burner head"), "gas torch burner");
  assert.equal(requestedProductCategory("need toaster, not this pan"), "toaster");
  assert.equal(requestedProductCategory("give me toaster not pan"), "toaster");
  assert.equal(requestedProductCategory("wrong pan. toaster please"), "toaster");
  assert.equal(requestedProductCategory("not this pan need toaster"), "toaster");
  assert.equal(requestedProductCategory("not pan but toaster"), "toaster");
  assert.equal(requestedProductCategory("wrong pan toaster please"), "toaster");
  assert.equal(requestedProductCategory("need toaster, not ATLANTIC CHEF KNIFE"), "toaster");

  const panCorrection = getFastChatReply({
    sessionId: "unit-stale-pan",
    message: "not this pan, need toaster",
    history: [],
    context: { activeProduct: null, displayedProducts: [pan], quantity: null },
  });
  assert.doesNotMatch(panCorrection?.message ?? "", /FRYING PAN 28CM|12 PC available/i);

  const cartridgeCorrection = getFastChatReply({
    sessionId: "unit-stale-cartridge",
    message: "not cartridge. need burner head. got five or not",
    history: [],
    context: { activeProduct: null, displayedProducts: [gasCartridge], quantity: null },
  });
  assert.doesNotMatch(cartridgeCorrection?.message ?? "", /IWATANI GAS CARTRIDGE|4130 PC available|Take 5/i);
});

test("does not answer fresh stock questions from a stale same-category card", () => {
  const staleKnife = {
    stock_id: "OLD-KNIFE",
    name: "ATLANTIC CHEF TAIWANESE CHEF KNIFE 20CM, RED HANDLE",
    brand: "ATLANTIC CHEF",
    status: "Active",
    list_price: 20,
    uom_id: "PC",
    stock_status: "in_stock" as const,
    available_quantity: 99,
  };
  const stalePan = {
    stock_id: "PAN-28",
    name: "ALUMINIUM FRYING PAN 28CM, RED",
    status: "Active",
    list_price: 25,
    uom_id: "PC",
    stock_status: "in_stock" as const,
    available_quantity: 88,
  };
  for (const message of [
    "need a JAPANESE KNIFE, got five or not?",
    "Victorinox chef knife have 5?",
    "blue chef knife have 5?",
    "not this knife, need BREAD KNIFE. got five or not",
  ]) {
    const reply = getFastChatReply({
      sessionId: `unit-stale-${message}`,
      message,
      history: [],
      context: { activeProduct: staleKnife, displayedProducts: [staleKnife], quantity: null },
    });
    assert.doesNotMatch(reply?.message ?? "", /99 PC available|ATLANTIC CHEF TAIWANESE/i, message);
  }
  for (const message of [
    "not this 28cm pan, need 24cm pan. got five or not",
    "stainless steel pan have 5?",
  ]) {
    const reply = getFastChatReply({
      sessionId: `unit-stale-${message}`,
      message,
      history: [],
      context: { activeProduct: stalePan, displayedProducts: [stalePan], quantity: null },
    });
    assert.doesNotMatch(reply?.message ?? "", /88 PC available|ALUMINIUM FRYING PAN 28CM/i, message);
  }
});

test("does not mistake ordinary stock phrasing or option words for a knife brand", () => {
  for (const message of [
    "does this chef knife have five?",
    "exact stock for this chef knife?",
    "please confirm this chef knife have 5?",
    "first chef knife have 5?",
    "second chef knife have 5?",
    "option 2 chef knife have 5?",
    "same chef knife have 5?",
    "third chef knife have 5?",
    "fourth chef knife have 5?",
    "last chef knife have 5?",
    "top chef knife have 5?",
    "bottom chef knife have 5?",
    "does my chef knife have five?",
    "does our chef knife have five?",
    "does the current chef knife have five?",
    "does the selected chef knife have five?",
    "does the displayed chef knife have five?",
    "does the shown chef knife have five?",
  ]) {
    assert.equal(explicitKnifeBrand(message), null, message);
  }
  assert.equal(explicitKnifeBrand("Victorinox red chef knife have 5?"), "Victorinox");
  assert.equal(explicitKnifeBrand("got this Victorinox red chef knife?"), "Victorinox");
});

test("preserves the functional requirements in the real eight-line quote", () => {
  const rows = [
    "Stainless Steel Strainer for the 12QT Pot",
    "Stainless Steel Ladle 4oz, 6oz, 8oz, length approximate 10inch",
    '1/2 Stainless Steel Pan, 6" Deep',
    '1/4 Stainless Steel Pan, 6" Deep',
    "Lid for 1/2 S/S Pan with notch for ladle",
    "Lid for 1/4 S/S Pan with notch for ladle",
    "Oyster Knife with Plastic Handle",
  ];
  assert.equal(requestedProductCategory(rows[0]), "strainer");
  assert.equal(requestedProductCategory(rows[4]), "lid");
  assert.equal(requestedProductCategory(rows[5]), "lid");

  const queries = rows.map((row) => catalogueMessageWithContext(row, []));
  for (const detail of ["stainless steel", "4oz", "6oz", "8oz", "10inch", "ladle"]) assert.match(queries[1], new RegExp(detail, "i"));
  for (const [query, fraction] of [[queries[2], "1/2"], [queries[3], "1/4"]] as const) {
    assert.match(query, /GN food pan/i);
    assert.match(query, new RegExp(fraction.replace("/", "\\/")));
    assert.match(query, /6 inch deep/i);
  }
  for (const [query, fraction] of [[queries[4], "1/2"], [queries[5], "1/4"]] as const) {
    assert.match(query, /GN food pan lid/i);
    assert.match(query, new RegExp(fraction.replace("/", "\\/")));
    assert.match(query, /slotted/i);
  }
  assert.match(queries[6], /oyster knife/i);
  assert.match(queries[6], /plastic handle/i);
});

test("treats the Daniel 12QT strainer row as a compatibility request, not a hand-strainer search", () => {
  const message = "Stainless Steel Strainer for the 12QT Pot";
  const reply = getFastChatReply({ sessionId: "unit-daniel-strainer", message, history: [] });
  assert.equal(requestedProductCategory(message), "strainer");
  assert.match(reply?.message ?? "", /strainer that fits the 12QT pot/i);
  assert.match(reply?.message ?? "", /capacity label alone does not guarantee fit/i);
  assert.match(reply?.message ?? "", /inner-rim diameter and usable depth/i);
  assert.doesNotMatch(reply?.message ?? "", /both a pot and a strainer|Chinese strainer|skimmer/i);
});

test("routes an owned pot-and-strainer replacement request only to lid fit clarification", () => {
  const message = "I already have a pot and strainer; need replacement lid";
  const reply = getFastChatReply({ sessionId: "unit-owned-pair-lid", message, history: [] });
  assert.equal(requestedProductCategory(message), "lid");
  assert.match(reply?.message ?? "", /Which item does the replacement lid need to fit/i);
  assert.doesNotMatch(reply?.message ?? "", /both a pot and a strainer|only want a strainer|only want a pot/i);
});

test("prioritises a newly requested third item over owned pot and insert context", () => {
  for (const [message, expectedCategory] of [
    ["I have a pot and basket but need a ladle", "utensil"],
    ["I have a pot and basket but need a lid", "lid"],
    ["I already have a pot and strainer; need replacement lid", "lid"],
    ["I have pot + strainer. need 2 ladles", "utensil"],
  ] as const) {
    const reply = getFastChatReply({ sessionId: `unit-third-${message}`, message, history: [] });
    assert.equal(requestedProductCategory(message), expectedCategory, message);
    assert.doesNotMatch(reply?.message ?? "", /already have the (?:pot|strainer).*only want/i, message);
    assert.doesNotMatch(reply?.message ?? "", /both a pot and a strainer/i, message);
  }
});

test("recognises natural word-count stock questions with an option after the count", () => {
  for (const message of [
    "got five of option 2 or not?",
    "do you have five of the second one?",
    "do you have five of the second option?",
    "got 5 of 2nd option or not?",
    "option two have 5?",
    "have 5, option 2?",
  ]) {
    assert.equal(isExactStockQuestion(message), true, message);
    assert.equal(requestedQuantity(message), 5, message);
  }

  const reply = getFastChatReply({
    sessionId: "unit-word-stock-option",
    message: "got five of option 2 or not?",
    history: [],
    context: { activeProduct: null, displayedProducts: [gasCartridge, torchBurner], quantity: null },
  });
  assert.match(reply?.message ?? "", /426 PC available/i);
  assert.match(reply?.message ?? "", /5 are currently available/i);
  assert.deepEqual(reply?.suggestions, ["Take 5 of option 2", "Change quantity"]);
});

test("keeps non-conveyor photo guidance on the buying path", () => {
  const reply = getFastChatReply({
    sessionId: "unit-toaster-image-1",
    message: "ya kun type, need 2, not conveyor",
    history: [],
    image: { dataUrl: "data:image/png;base64,AA==", mimeType: "image/png", name: "toaster.png" },
    context: { activeProduct: null, displayedProducts: [], quantity: null },
  });
  assert.match(reply?.message ?? "", /kept quantity 2/i);
  assert.deepEqual(reply?.suggestions, ["4-slot pop-up toaster", "6-slot pop-up toaster"]);

  const humanFollowup = getFastChatReply({
    sessionId: "unit-toaster-image-2",
    message: "ya kun kind, need 2",
    history: [
      { role: "user", content: "Do you have this toaster?" },
      { role: "assistant", content: "Is this a toaster?" },
    ],
    image: { dataUrl: "data:image/png;base64,AA==", mimeType: "image/png", name: "toaster.png" },
    context: { activeProduct: null, displayedProducts: [], quantity: null },
  });
  assert.deepEqual(humanFollowup?.suggestions, ["4-slot pop-up toaster", "6-slot pop-up toaster"]);
  assert.match(
    catalogueMessageWithContext("No conveyor type. I need a 4 or 6 slot toaster.", []),
    /4 or 6 slot commercial pop-up toaster/i,
  );

  const screenshotPrompt = "got this kind? 4 slot, no belt type. 2 pcs";
  const wordNumberPrompt = "got this kind? four slot, no belt type. two pcs";
  assert.equal(productCategory(screenshotPrompt), "toaster");
  assert.equal(productCategory(wordNumberPrompt), "toaster");
  assert.equal(productCategory("I need chef trousers without a belt"), "chef pants");
  assert.notEqual(productCategory("I need an apron without a belt"), "toaster");
  assert.doesNotMatch(catalogueMessageWithContext("I need chef trousers without a belt", []), /toaster/i);
  assert.match(catalogueMessageWithContext(screenshotPrompt, []), /4-slot commercial pop-up toaster/i);
  assert.match(catalogueMessageWithContext(wordNumberPrompt, []), /4-slot commercial pop-up toaster/i);
  assert.notEqual(productCategory("I need a 4-slot power extension socket"), "toaster");
  assert.notEqual(productCategory("got 4 slots in tray"), "toaster");
  assert.equal(productCategory("I need a 4-slot toaster"), "toaster");
  const screenshotFollowup = getFastChatReply({
    sessionId: "unit-toaster-image-human",
    message: "toaster lah",
    history: [
      { role: "user", content: screenshotPrompt },
      { role: "assistant", content: "I couldn’t find 4-slot commercial pop-up toaster 2 units. Download the PDF and contact Sia Huat sales for manual sourcing." },
    ],
    context: { activeProduct: null, displayedProducts: [], quantity: 2 },
  });
  assert.match(screenshotFollowup?.message ?? "", /4-slot commercial pop-up toaster/i);
  assert.match(screenshotFollowup?.message ?? "", /quantity 2/i);
  assert.match(screenshotFollowup?.message ?? "", /won.?t repeat the same search/i);
  assert.match(
    catalogueMessageWithContext("toaster lah", [screenshotPrompt]),
    /4-slot commercial pop-up toaster/i,
  );
});

test("retains utility-box details supplied across imperfect follow-ups", () => {
  const query = catalogueMessageWithContext("another option", [
    "I need a rectangular utility box",
    "black please",
    "plastic",
    "about 53 x 38 cm",
  ]);
  for (const detail of ["black", "rectangular", "plastic", "53 x 38 cm", "utility box"]) {
    assert.match(query, new RegExp(detail, "i"));
  }
});

test("retains an image-matched beverage-dispenser family for alternatives", () => {
  const query = catalogueMessageWithContext("Choose another item", [
    "What product is this?",
    "CAMBRO CAMTAINER INSULATED BEVERAGE DISPENSER 9.5L, BROWN",
  ]);
  for (const detail of ["Cambro", "insulated", "9.5L", "brown", "beverage dispenser", "Camtainer"]) {
    assert.match(query, new RegExp(detail, "i"));
  }
});

test("retains the full ladder sourcing specification", () => {
  const query = catalogueMessageWithContext(
    "Need a 3-step folding ladder with safety handrail, 300 lb, grey, like COSCO 11839GGO; not all aluminium. Quantity 1.",
    [],
  );
  for (const detail of ["3 step", "folding", "safety handrail", "300 lb", "grey", "COSCO 11839GGO", "not all aluminium"]) {
    assert.match(query, new RegExp(detail, "i"));
  }
  assert.equal(requestedQuantity(query), null, "300 lb is a load rating, not an order quantity");
});
