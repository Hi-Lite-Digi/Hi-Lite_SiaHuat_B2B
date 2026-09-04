import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogueMessageWithContext,
  isAmbiguousNoodleDryingRequest,
  isCookedNoodleDrainingIntent,
  isExactStockQuestion,
  productCategory,
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
});

test("a burner name replaces stale gas-cartridge intent without another confirmation", () => {
  for (const message of [
    "CASSETTE GAS TORCH BURNER",
    "IWATANI, GAS TORCH BURNER",
    "TORCH BURNER, IWATAN",
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
