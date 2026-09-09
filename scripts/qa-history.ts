import { mkdir, writeFile } from "node:fs/promises";
import { chatReplySchema, type ChatReply, type HistoryItem } from "../src/lib/chat-contract";
import { requestedQuantity } from "../src/lib/chat-turn";
import { matchesProductRequirements } from "../src/lib/product-requirements";
import { replyStyleIssues } from "../src/lib/reply-style";

// Critical customer turns from the 19 historical PDFs. These are regression
// inputs, not assertions that the old assistant's answers were correct.
const stories: Record<string, string[]> = {
  tongs: ["show me stainless steel tongs", "any one that's more suitable for cooking?", "i dont want serving tongs. i want cooking tongs", 'Stainless Steel Steak Tong 15"'],
  tongTypo: ["looking for cooking stainless steel tongsw", "show me all"],
  dining: ["Home got a new house need some sets for dining maybe 4 pax house hold", "Full sets for home dining", "Are these full sets ?", "So you guys dont have full sets la?", "1 more time recommend me wrong stuff I calling the police"],
  damascus: ["I need a damascus chef knife. 3 pcs", "Is this damascus", "Got a pic?", "Have a japanese made knife?", "No, this is taiwanese knife", "Are there others?", "Ok nevermind, got a wok? I need 4 woks for zichar", "Cancel"],
  acceptAlternative: ["I need a damascus chef knife. 3 pcs", "Show similar chef knives", "Recommend", "okie give me 5 of this"],
  noodles: ["The one we dry the noodles what is it call", "The you cook maggi mee then you need pour away the water one then you get mee goreng", "Colander/strainer", "Fine mesh", "Handheld skimmer (fine mesh)"],
  colander: ["colander (fine mesh)"],
  gold: ["I wnat to buy a mass order", "like a cutlery set", "give me the Gold,100"],
  forged: ["show me chef knives with forged premium handle", "give me the one with the Forged Premium Handle"],
  blender: ["hi got blender", "commercial ones", "what kind of blenders do you have", "actually i open a juice shop and have 8 outlets, what is the most suitable type of blender", "maybe about 200 drinks per day", "so expensive. got something cheaper? say below $1000", "can i speak to someone", "i dont want to talk to you. i want to speak to a human", "ok"],
  stockpot: ["Hi do you gusy sell pots ?", "stockpots.", "i wnat 20L", "no preference"],
  tea: ["Hi, can I have a cup of tea?", "I would like an instruction on how to make the tea.", "I would like a caffeine free tea please. Thank you."],
  sashimi: ["Hi i want a knife", "I am using it to cut fish", "I need it for like sashimi-style slicing", "I want a traditional style-bevel yangiba.", "a right handed one"],
  toaster: ["Slots toaster", "I dotn want convertor", "No conveyor type 4 or 6 slots toaster"],
  whisk: ["i need to buy a electric whisk", "i want to use it for home use, do you have some recommendations?", "give me recommendations for electric whisk, not manual", "there's no picture of the product", "yea, the listing doesnt have a picture also. why you recommending it when i dont know what the product is", "no. how about cordless 3-in-1 blender, whisk product"],
  categorySwitch: ["I need a damascus chef knife", "Ok nvm..", "I want to get fine dining plates", "Switch to tableware", "Restaurant / commercial", "I mentioned fine dining above", "Nvm now i want to buy mangoes", "Fresh"],
};
const selected = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
const label = process.argv.find(arg => arg.startsWith("--label="))?.split("=")[1] ?? "latest";
const records: unknown[] = [];
let failures = 0;
function checkReply(story: string, input: string, reply: ChatReply) {
  const errors = replyStyleIssues(reply);
  const names = reply.products.map(p => p.name).join(" ");
  if (["tongs", "tongTypo"].includes(story) && /cooking|suitable/i.test(input)) {
    if (!reply.products.length || /\b(?:serving|snail|sugar|ice)\s+tongs?\b/i.test(names)) errors.push("Cooking tongs were not returned.");
  }
  if (story === "gold" && /Gold,100/i.test(input)) {
    if (reply.selectedProduct?.stock_id !== "R-52770G81") errors.push("Wrong cutlery set selected.");
    if (/\b100\s+(?:sets|units|pieces)\b/i.test(reply.message)) errors.push("Collection 100 became an order quantity.");
  }
  if (story === "damascus" && /japanese made|taiwanese/i.test(input)) {
    if (reply.products.some(p => !matchesProductRequirements("japanese made knife",p))) errors.push("Unverified manufacturing origin.");
  }
  if (story === "noodles" && /fine mesh/i.test(input)
    && (!reply.products.length || reply.products.some(p=>!matchesProductRequirements("fine mesh",p)))) errors.push("Fine mesh requirement was lost.");
  if (story === "sashimi" && /sashimi|yangiba/i.test(input)
    && (!reply.products.length || reply.products.some(p=>!matchesProductRequirements("sashimi knife",p)))) errors.push("Sashimi request lost its product family.");
  if (story === "toaster"
    && (!reply.products.length || reply.products.some(p=>!matchesProductRequirements("4 or 6 slot toaster",p)))) errors.push("Slot toaster request failed.");
  if (story === "whisk" && /3-in-1/i.test(input)
    && !/cuisinart/i.test(reply.message) && !names.includes("Cuisinart")) errors.push("Existing cordless blender/whisk was not identified.");
  if (story === "whisk" && /electric whisk/i.test(input)
    && (!reply.products.length || reply.products.some(p=>!matchesProductRequirements("electric whisk",p)))) errors.push("Whisk request returned an unsuitable mixer/accessory.");
  if (story === "categorySwitch" && input === "Ok nvm.." && reply.products.length) errors.push("Cancellation repeated product suggestions.");
  if (story === "categorySwitch" && input === "Fresh" && reply.products.length) errors.push("Produce follow-up revived the earlier plates.");
  if (story === "forged" && reply.products.some(p=>!matchesProductRequirements("forged premium handle",p))) errors.push("Handle requirement was lost.");
  return errors;
}
async function run(name: string, turns: string[]) {
  const history: HistoryItem[] = [];
  let previous: ChatReply | undefined;
  let quantity: number | null = null;
  for (const message of turns) {
    const start = performance.now();
    try {
      const response = await fetch(`${process.env.QA_BASE_URL || "http://localhost:3017"}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: `history-${label}-${name}`, message, history: history.slice(-30),
          context: { stage: previous?.stage ?? "discover", activeProduct: previous?.selectedProduct ?? null,
            displayedProducts: previous?.products ?? [], quantity } }),
        signal: AbortSignal.timeout(35_000),
      });
      const reply = chatReplySchema.parse(await response.json());
      const issues = checkReply(name, message, reply);
      failures += issues.length;
      const record = { story: name, input: message, status: response.status, provider: response.headers.get("x-chat-provider"), usage: response.headers.get("x-ai-usage"), elapsedMs: Math.round(performance.now() - start), issues, reply };
      records.push(record);
      console.log(JSON.stringify({ ...record, reply: { ...reply, products: reply.products.map(p => ({ code: p.stock_id, name: p.name })), selectedProduct: reply.selectedProduct?.stock_id } }));
      history.push({ role: "user", content: message }, { role: "assistant", content: reply.message });
      previous = reply;
      quantity = requestedQuantity(message) ?? quantity;
    } catch (error) {
      failures++;
      const record = { story: name, input: message, error: String(error) };
      records.push(record); console.log(JSON.stringify(record));
    }
    await mkdir("tmp/qa-reports", { recursive: true });
    await writeFile(`tmp/qa-reports/history-${label}.json`, JSON.stringify(records, null, 2));
  }
}
const entries = Object.entries(stories).filter(([name]) => !selected.length || selected.includes(name));
async function main() {
  for (let i = 0; i < entries.length; i += 2) await Promise.all(entries.slice(i, i + 2).map(([name, turns]) => run(name, turns)));
  if (failures) { console.error(`${failures} historical regression issues found.`); process.exitCode = 1; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
