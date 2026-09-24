import type { ChatRequest } from "./chat-contract";

/**
 * What the conversation has already covered.
 *
 * The wording model receives the recent history, but nothing in it marks which
 * questions were already put to the customer. Left to infer that on its own the
 * model re-asks a question it has just asked, or asks a second preference
 * question the moment the first one is answered, which reads like a form rather
 * than a person. This module derives that memory deterministically so the
 * prompt can state it, and so a repeated question is a detectable style fault
 * with a repair pass, exactly like the existing length and one-question rules.
 */

export const QUESTION_TOPICS = [
  "use_case",
  "size",
  "colour",
  "material",
  "shape",
  "brand",
  "quantity",
  "budget",
] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

const TOPIC_PATTERNS: Array<{ topic: QuestionTopic; pattern: RegExp }> = [
  // "What will you serve on them", "what's it for", "home or commercial"
  {
    topic: "use_case",
    // Customers are asked what something is for in endlessly varied words, so
    // this covers the food and setting vocabulary those questions reach for.
    pattern: /\b(?:serve|serving|serve on|plating|plate up|use (?:it|them|these)|using (?:it|them)|used for|what(?:'s| is) it for|purpose|home (?:use|baking)|commercial|cafe|café|restaurant|bakery|hawker|catering|kitchen setup|menu|dishes|mains|main courses|courses|starters|appetisers|appetizers|desserts|bites|snacks|soups|salads|drinks|beverages)\b|用途|做什么用|用来/i,
  },
  { topic: "size", pattern: /\b(?:size|sizes|how (?:big|large|wide|deep|long)|diameter|dimensions?|\d+\s?(?:cm|mm|inch|inches|")|smaller|larger|bigger)\b|尺寸|多大/i },
  { topic: "colour", pattern: /\b(?:colou?r|colou?rs|white|black|grey|gray|blue|red|green)\b|颜色|白色|黑色|灰色/i },
  { topic: "material", pattern: /\b(?:material|porcelain|stoneware|melamine|stainless|steel|plastic|glass|ceramic|wood(?:en)?|finish)\b|材质|材料/i },
  { topic: "shape", pattern: /\b(?:shape|round|square|rectangular|oval|style|design)\b|形状|款式/i },
  { topic: "brand", pattern: /\bbrand|brands|make\b|品牌/i },
  { topic: "quantity", pattern: /\b(?:how many|quantity|qty|how much do you need|number of|pieces|pcs)\b|数量|多少个/i },
  { topic: "budget", pattern: /\b(?:budget|price range|how much (?:are you|were you) (?:looking|hoping) to spend|spend)\b|预算/i },
];

/**
 * Offering a concrete alternative is progress, not a repeat. "I couldn't find a
 * 25cm. Would 23cm work?" names the same topic as the size the customer gave,
 * yet it moves the enquiry on and the reply standard requires it, so these
 * questions are never treated as looping.
 */
const OFFERS_ALTERNATIVE = /\b(?:instead|flexible|any\s+flexibility|work for you|work instead|be (?:ok|okay|fine)|still work|suit you|do the job|acceptable)\b|\b(?:would|could|will|can|does|is)\b[^?？]*\b(?:work|suit|help|do)\b[^?？]*[?？]/i;

/** Every question sentence in a message, without their trailing punctuation. */
export function questionSentences(message: string) {
  return (message.match(/[^.!?。！？\n]*[?？]/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Topics a single piece of text asks or supplies. A sentence can cover several. */
export function topicsIn(text: string): QuestionTopic[] {
  return TOPIC_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);
}

/** Topics the assistant has already put to the customer as a question. */
export function askedTopics(history: ChatRequest["history"]): QuestionTopic[] {
  const asked = new Set<QuestionTopic>();
  for (const turn of history) {
    if (turn.role !== "assistant") continue;
    for (const sentence of questionSentences(turn.content)) {
      for (const topic of topicsIn(sentence)) asked.add(topic);
    }
  }
  return [...asked];
}

/**
 * Topics the customer has since supplied. A detail counts as answered wherever
 * they state it, including in the message being handled now, so the very next
 * reply cannot ask for it again.
 */
export function answeredTopics(history: ChatRequest["history"], currentMessage = ""): QuestionTopic[] {
  const answered = new Set<QuestionTopic>();
  const customerTurns = [...history.filter((turn) => turn.role === "user").map((turn) => turn.content), currentMessage];
  for (const turn of customerTurns) {
    if (!turn.trim()) continue;
    for (const topic of topicsIn(turn)) answered.add(topic);
  }
  return [...answered];
}

const QUESTION_FILLER = new Set(
  ("a an and are be can could do does for from have how i in is it me my of on or should so that the their them there these this those to want we what when which will with would you your"
    + " your'e youre us give need like looking prefer any some one more just please thanks ok okay right after mainly mostly kind sort type").split(" "),
);

/**
 * A rephrased question reuses the same nouns in a different number or degree:
 * "main courses" becomes "mains", "small bites" becomes "smaller bites". Light
 * stemming is what lets the repeat be recognised at all.
 */
function stem(word: string) {
  return word
    .replace(/(?:ies)$/, "y")
    .replace(/(?:es|s)$/, "")
    .replace(/(?:er|est)$/, "")
    .replace(/(?:ing)$/, "");
}

function questionFingerprint(question: string) {
  const words = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !QUESTION_FILLER.has(word))
    .map(stem)
    .filter((word) => word.length > 1);
  return new Set(words);
}

/** Two questions are the same question when their meaningful words mostly coincide. */
export function questionsOverlap(first: string, second: string, threshold = 0.6) {
  const left = questionFingerprint(first);
  const right = questionFingerprint(second);
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const smaller = Math.min(left.size, right.size);
  return shared / smaller >= threshold;
}

export type ConversationMemory = {
  asked: QuestionTopic[];
  answered: QuestionTopic[];
  /** Asked and then supplied: these must never be asked again. */
  settled: QuestionTopic[];
  previousQuestions: string[];
  clarifyingQuestionsAsked: number;
};

export function conversationMemory(history: ChatRequest["history"], currentMessage = ""): ConversationMemory {
  const asked = askedTopics(history);
  const answered = answeredTopics(history, currentMessage);
  const previousQuestions = history
    .filter((turn) => turn.role === "assistant")
    .flatMap((turn) => questionSentences(turn.content));
  return {
    asked,
    answered,
    settled: asked.filter((topic) => answered.includes(topic)),
    previousQuestions,
    clarifyingQuestionsAsked: previousQuestions.length,
  };
}

/**
 * Style faults that make the conversation circle. Reported alongside the other
 * observable reply rules so the existing single repair pass can fix the wording
 * without touching any catalogue fact.
 */
export function loopingQuestionIssues(message: string, history: ChatRequest["history"], currentMessage = "") {
  const issues: string[] = [];
  const questions = questionSentences(message).filter((question) => !OFFERS_ALTERNATIVE.test(question));
  if (!questions.length) return issues;
  const memory = conversationMemory(history, currentMessage);

  // A repeated topic is the loop the customer notices, whatever words it wears.
  const settledTopic = questions
    .flatMap((question) => topicsIn(question))
    .find((topic) => memory.settled.includes(topic));
  if (settledTopic) {
    return [
      `The customer has already given you the ${settledTopic.replace("_", " ")}. Do not ask for it again; use it and move on.`,
    ];
  }

  const askedTopic = questions
    .flatMap((question) => topicsIn(question))
    .find((topic) => memory.asked.includes(topic));
  if (askedTopic) {
    return [
      `You already asked about ${askedTopic.replace("_", " ")} earlier in this conversation. Asking it again in different words is the loop customers complain about.`
        + " If their answer was vague, make a sensible assumption, say what you assumed, and take the next step instead.",
    ];
  }

  for (const question of questions) {
    const repeated = memory.previousQuestions.find((previous) => questionsOverlap(previous, question));
    if (repeated) {
      return [
        `You already asked this: "${repeated}". Do not ask it again in different words.`
          + " Use what the customer has told you and take the next step instead.",
      ];
    }
  }

  return issues;
}

/**
 * Last resort before the route falls back to raw server guidance: keep the
 * model's natural prose and drop only the question that circles. A shorter
 * reply that states what was found reads far better than the bare draft line.
 */
export function withoutLoopingQuestion(
  message: string,
  history: ChatRequest["history"],
  currentMessage = "",
) {
  const circling = questionSentences(message)
    .filter((question) => loopingQuestionIssues(question, history, currentMessage).length > 0);
  if (!circling.length) return message;
  let remainder = message;
  for (const question of circling) remainder = remainder.split(question).join(" ");
  return remainder
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
