# Claire's response standard

Benchmark reviewed on 8 September 2026: the user's Roborock agent instructions, workflow notes, and the live [Roborock Care demo](https://roborock-care-demo.vercel.app/). The target is its short, attentive WhatsApp conversation style, adapted to Sia Huat product enquiries.

## Acceptance criteria

- Ordinary assistant replies fit within 600 characters, usually 1–4 short sentences.
- Ask one focused question. Combining size, colour, material and a sales handoff into one question mark does not qualify.
- Acknowledge briefly, then move forward. Do not repeat the entire request or ask for specifications already supplied.
- Ask a useful clarifying question before listing arbitrary products for a broad initial request.
- Treat a correction as a new requirement. Do not keep offering a smaller product after the customer says the original size is essential.
- Compare the choices already displayed when the customer asks which of them is cheapest. Do not replace that context with an unrelated search, or compare per-piece and per-set prices as equivalent.
- Keep the selected quantity and specifications across English and supported Chinese catalogue refinements. A discount percentage is not an item quantity.
- Show text product details and website links for choosing and confirming an item. Catalogue photos are omitted from replies at the user's request; customer reference-photo uploads remain supported. Follow-up stock messages do not repeat the full product card.
- Keep totals, codes and units in enquiry summaries, but avoid repeated process explanations. The completed summary explains that nothing has been ordered and the customer shares the PDF with sales.
- Never claim the demo has contacted sales, placed an order, guaranteed delivery or approved a discount.
- Preserve a confidently recognised photo category when an exact catalogue match cannot be verified. Say that the pictured item is a knife, for example, while keeping its exact model, availability and price unconfirmed. Do not describe a recognised product as an unreadable photo.

## Implementation

Claude receives the conversation and catalogue evidence. Observable style violations trigger one repair within the existing request deadline, with the chosen product IDs fixed. Catalogue fields and workflow state remain under application control. A dropped connection gets one retry within the same deadline; HTTP errors and cancelled requests are not retried.

The client uses short shared wording for confirmations, stock limits and summaries. Numeric stock limits and monetary totals still come from verified product data. Quantity questions no longer offer an arbitrary row of numeric suggestions. Sales-summary buttons use customer-facing language.

## Verification

The final `pnpm qa:quality` run passed 12 live Claude turns across seven stories:

1. Broad cafe plate enquiry, explicit specifications, then rejection of smaller sizes.
2. Wine glasses followed by a cheapest-of-those comparison.
3. A misspelled 20cm chef-knife request followed by a black-handle preference.
4. A frustrated customer's specific frying-pan request.
5. Chinese 20cm chef-knife request followed by a black-handle preference.
6. A sold-out black cutlery set with a strict finish requirement.
7. An unsupported delivery guarantee and discount request.

Review found and corrected lost comparison context, Chinese refinement routing, mixed size/colour questions and a percentage parsed as an item quantity. The final transcripts are saved locally at `tmp/qa-reports/response-quality.json`.

The browser verified the short confirmation, compact $89.00 enquiry for 2 knives, and cumulative overstock response for 18 requested against 17 available. The latter now reads:

> There are only 17 PC available, so I can't cover 18 PC.
>
> Would 17 PC work for you?

All 100 automated tests, type checking, ESLint and the production build passed. Structured multi-item summaries may exceed 600 characters because they must retain each line's quantities, units, prices and codes. This benchmark evaluates tested behaviours; conversational wording remains variable. Changes are local, with no public deployment performed.

## Quick replies — 8 September 2026

The opening greeting has no buttons. Once a customer sends a message, the latest assistant reply has full-width response buttons beneath its bubble. Old response buttons disappear as the conversation advances. Buttons are disabled during requests, stock checks, voice input and PDF generation.

Claude can supply short answers grounded in its final question, such as “Home baking” / “Commercial use”. Workflow commands stay separately controlled. Summary offers always provide “Prepare sales summary” / “Choose another item”, including indirect wording such as “Want me to do that?”. Product-index labels and quantity labels remain distinct, and quantity presets do not exceed known stock. Customers can still type other answers.

Verified locally: all 118 automated tests passed; the final affected tests, type checking, ESLint and production build passed. All 12 live quality turns used Anthropic and returned buttons. Browser checks covered a clean/reset greeting without buttons; choosing home baking, product and quantity entirely by buttons; blocking 2 mixers against 1 available; restoring the 1-piece $73.30 enquiry; and finishing it. A rejected 12cm pizza-cutter request exposed the summary buttons, and clicking Prepare sales summary produced the requirements summary and PDF action. No order or sales notification was sent. These additions have not been deployed.

## Conversation memory — 24 September 2026

Reported symptom: the replies read like a robot and kept looping back to the
question they had already asked. A four-turn cafe-plate enquiry reproduced it on
the second turn. The customer answered "for a cafe" and Claire replied with
"What kind of dishes are you mostly plating, mains or desserts?" — the same
question as her opening "main courses, desserts, or small bites?", in new words.

The cause was missing state rather than wording. The wording model receives the
recent history and a short server guidance line such as "Here are 3 options:",
but nothing marked which questions the conversation had already put to the
customer, so each turn re-derived the next move and often re-derived the same
one.

### Added

`src/lib/conversation-memory.ts` derives, deterministically from the history:

- `asked` — question topics already put to the customer (use case, size, colour,
  material, shape, brand, quantity, budget), taken only from assistant question
  sentences.
- `answered` / `settled` — topics the customer has supplied, including in the
  message being handled now, so the very next reply cannot ask for them again.
- `loopingQuestionIssues` — a repeated topic, or a question whose meaningful
  words mostly coincide with an earlier one after light stemming ("main courses"
  → "mains", "small bites" → "smaller bites").

These reach the model as `alreadyAsked`, `alreadySettled` and
`conversationGuidance` in the evidence, and reach `replyStyleIssues` as an
observable fault, so a circling reply is repaired by the existing single repair
pass with the chosen product IDs fixed.

### Exemptions

Offering a concrete alternative is progress, not a repeat, and the standard
above requires it. Questions that propose a different value — "I couldn't find a
25cm match. Would a 23cm plate work?", or "Would 17 PC work for you?" after an
overstock — are never treated as looping. A bare unit mention ("$13.12 per PC")
does not count as asking the quantity.

### Fallback

When the repair still circles, the reply no longer falls back to the bare server
guidance line. The written reply is kept and only the circling question is
removed, with its answer buttons. A short statement of what was found reads far
better than "Here are 3 options:".

### Prompt

`CLAIRE_INSTRUCTIONS` was reorganised into sections with the conversational
rules first and every existing accuracy constraint preserved. The new section is
KEEP MOVING: never re-ask a topic in `alreadyAsked`; when an answer is vague,
assume, say what was assumed, and move on; prefer showing results over asking a
second question; drop requirements that no longer apply after a product switch.

### Verification

185 automated tests, type checking and ESLint pass. The same four-turn cafe
enquiry now answers "for a cafe" with three suitable plates and a reason for
each, and no repeated question. Stock and pricing remain server-derived: 30 ×
$13.12 = $393.60 against verified availability.

Known issue, unchanged by this work: a size given for one product family can
still carry into the next. After "20cm" for chef knives and a switch to paring
knives, the search reports "no 20cm paring knife" rather than dropping the size.
That lives in the catalogue search path, not the reply layer.

## Abandoned requirements — 24 September 2026

The known issue noted above is fixed. `catalogueMessageWithContext` already
started a fresh search when the customer named a different product family, but
chef knife to paring knife is one family, so the comparison could not see the
switch and the abandoned "20cm" was searched against the new item.

`replacesEarlierRequest` in `src/lib/chat-intent.ts` recognises an explicit
replacement that names a product — "actually make it a paring knife instead",
"switch to a bread knife" — and the remembered request restarts from that
message. A named product is required, so "I'd rather have the smaller one
instead" still refers to the cards on screen and keeps its context, and an
ordinary refinement such as "black handle" after "20cm chef knife" still keeps
the size.

Before: "I don't have a 20cm paring knife in stock right now."
After: three paring knives with 48, 67 and 68 in stock.
