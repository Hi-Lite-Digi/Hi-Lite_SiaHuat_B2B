import assert from "node:assert/strict";
import fs from "node:fs";

const workflowPath = new URL("../tmp/n8n-backups/web-chat-with-image-fix.json", import.meta.url);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));

const node = (name) => {
  const match = workflow.nodes.find((candidate) => candidate.name === name);
  assert(match, `Missing workflow node: ${name}`);
  return match;
};

const normalizeCode = node("Normalize Response").parameters.jsCode;
const normalize = new Function("$json", normalizeCode);

const answerOne = {
  message: "Here are the cleavers we have.",
  stage: "discover",
  products: [
    {
      stock_id: "119XX-100-254",
      name: "JAP CLEAVER CHEF KNIFE 6.5\"",
      status: "Active",
      list_price: "20.09",
      uom_id: "PC",
    },
  ],
  selectedProduct: null,
  suggestions: ["Choose this cleaver"],
};

const answerTwo = {
  message: "Which Chinese-style cleaver would you like?",
  stage: "discover",
  products: [
    {
      stock_id: "417-BE-0405",
      name: "CHINESE CLEAVER L16cm, SEKI MANJU, KAI",
      status: "Active",
      list_price: "32.94",
      uom_id: "PC",
    },
    {
      stock_id: "417-BE-0549",
      name: "CHINESE CLEAVER KNIFE L17.5cm, SEKI MANJU, KAI",
      status: "Active",
      list_price: "45.78",
      uom_id: "PC",
    },
  ],
  selectedProduct: null,
  suggestions: ["Choose first one", "Choose second one"],
};

const duplicateJsonOutput = `${JSON.stringify(answerOne)}\n${JSON.stringify(answerTwo)}`;
const normalized = normalize({ output: duplicateJsonOutput });

assert.equal(normalized.message, answerTwo.message);
assert.equal(normalized.products.length, 2);
assert.equal(normalized.products[0].stock_id, "417-BE-0405");
assert.equal(normalized.products[1].list_price, 45.78);

const plainClarification = normalize({
  output: "Sure — what size do you need? Small, medium or large?\nstage: clarify\n\n(Note: I'll ask only one question before I search the catalogue.)",
});
assert.equal(plainClarification.stage, "clarify");
assert.equal(plainClarification.products.length, 0);
assert.equal(plainClarification.message, "Sure, what size do you need? Small, medium or large?");
assert.doesNotMatch(plainClarification.message, /trouble processing|Note:/i);

const imageCode = node("Build Grounded Image Enquiry").parameters.jsCode;
for (const required of [
  "const isCleaver",
  "'CLEAVER'",
  "'CHINESE CLEAVER'",
  "'JAP CLEAVER CHEF KNIFE'",
  "'dessert knife'",
  "'machine spare or cutting blade'",
]) {
  assert(imageCode.includes(required), `Missing cleaver image rule: ${required}`);
}

const systemMessage = node("Sales Assistant").parameters.options.systemMessage;
assert(systemMessage.includes("search the generic CLEAVER family"));
assert(systemMessage.includes('text such as "any cleaver"'));
assert(systemMessage.includes("CLOSEST-OPTION FALLBACKS"));
assert(systemMessage.includes("the core fallback query is COFFEE BEANS"));

console.log("PASS: response recovery, catalogue fallbacks and cleaver image/text rules are present.");
