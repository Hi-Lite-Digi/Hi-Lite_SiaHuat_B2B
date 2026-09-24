import assert from "node:assert/strict";
import test from "node:test";
import {
  answeredTopics,
  askedTopics,
  conversationMemory,
  loopingQuestionIssues,
  questionsOverlap,
  questionSentences,
  topicsIn,
} from "./conversation-memory";

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

test("question sentences are extracted without surrounding statements", () => {
  assert.deepEqual(
    questionSentences("Yes, we have plates. What will you serve on them? Plenty in stock."),
    ["What will you serve on them?"],
  );
  assert.deepEqual(questionSentences("Here are three options."), []);
});

test("topics cover the details a sales conversation actually settles", () => {
  assert.deepEqual(topicsIn("What size are you after?"), ["size"]);
  assert.deepEqual(topicsIn("Round or square?"), ["shape"]);
  assert.deepEqual(topicsIn("How many would you need?"), ["quantity"]);
  assert.ok(topicsIn("Is this for a cafe or home use?").includes("use_case"));
  assert.ok(topicsIn("白色还是黑色？").includes("colour"));
});

test("asked topics come only from the assistant's questions, not its statements", () => {
  const history = [
    turn("assistant", "We have a good range of plates. What will you mainly serve on them?"),
    turn("user", "for a cafe"),
    turn("assistant", "These are 25cm porcelain plates."),
  ];
  assert.deepEqual(askedTopics(history), ["use_case"]);
});

test("a detail supplied in the message being handled now counts as answered", () => {
  const history = [turn("assistant", "What size are you after?")];
  assert.ok(answeredTopics(history, "white, about 25cm").includes("size"));
  assert.ok(answeredTopics(history, "white, about 25cm").includes("colour"));
});

test("rephrased questions are recognised as the same question", () => {
  assert.ok(questionsOverlap(
    "Which finish did you prefer, brushed or mirror?",
    "Did you prefer the brushed finish or the mirror finish?",
  ));
  // The live failure this guard was written for: same question, new nouns.
  assert.ok(questionsOverlap(
    "What will you mainly serve on them, main courses, desserts, or small bites?",
    "Are you after mains, soups, or smaller bites mainly?",
  ));
  assert.ok(!questionsOverlap("What size are you after?", "How many would you need?"));
  assert.ok(!questionsOverlap("Which colour would you like?", "How many do you need?"));
});

test("re-asking a question already put to the customer is a style fault", () => {
  const history = [
    turn("assistant", "What will you mainly serve on them, main courses, desserts, or small bites?"),
    turn("user", "for a cafe"),
  ];
  const issues = loopingQuestionIssues(
    "Nice, cafe use! What kind of dishes are you mostly plating, mains or desserts?",
    history,
    "for a cafe",
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /already given you the use case/i);
});

test("a topic asked but never answered is still not asked twice", () => {
  const history = [
    turn("assistant", "Which finish would you like?"),
    turn("user", "what do you have in stock"),
  ];
  const issues = loopingQuestionIssues("Sure. What finish are you after?", history, "what do you have in stock");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /already asked about material/i);
});

test("asking for a detail the customer already supplied is a style fault", () => {
  const history = [
    turn("assistant", "What size are you after?"),
    turn("user", "25cm please"),
  ];
  const issues = loopingQuestionIssues("Got it. What size did you want again?", history, "25cm please");
  assert.ok(issues.some((issue) => /already given you the size/i.test(issue)));
});

test("a genuinely new question is not flagged", () => {
  const history = [
    turn("assistant", "What will you mainly serve on them?"),
    turn("user", "mains for a cafe"),
  ];
  assert.deepEqual(loopingQuestionIssues("Got it. How many do you need?", history, "mains for a cafe"), []);
});

test("a reply without a question is never a looping fault", () => {
  const history = [turn("assistant", "What size are you after?"), turn("user", "25cm")];
  assert.deepEqual(loopingQuestionIssues("Here's a 25cm white plate at $13.12 each.", history, "25cm"), []);
});

test("memory reports what is settled so the prompt can state it", () => {
  const memory = conversationMemory(
    [turn("assistant", "What size are you after?"), turn("user", "25cm"), turn("assistant", "Which colour?")],
    "white",
  );
  assert.deepEqual(memory.settled.sort(), ["colour", "size"]);
  assert.equal(memory.clarifyingQuestionsAsked, 2);
});

test("offering an alternative size is progress, not a repeat", () => {
  const history = [
    turn("user", "I need 25cm plates"),
    turn("assistant", "What size are you after?"),
    turn("user", "25cm"),
  ];
  // Required by the reply standard when an explicit size cannot be matched.
  assert.deepEqual(
    loopingQuestionIssues("I couldn't find a 25cm match just now. Would a 23cm plate work?", history, "25cm"),
    [],
  );
});

test("an overstock offer is not treated as re-asking the quantity", () => {
  const history = [
    turn("assistant", "How many would you need?"),
    turn("user", "18"),
  ];
  assert.deepEqual(
    loopingQuestionIssues("There are only 17 PC available, so I can't cover 18 PC.\n\nWould 17 PC work for you?", history, "18"),
    [],
  );
});

test("a bare unit mention does not count as asking the quantity", () => {
  assert.deepEqual(topicsIn("That's $13.12 per PC."), []);
});
