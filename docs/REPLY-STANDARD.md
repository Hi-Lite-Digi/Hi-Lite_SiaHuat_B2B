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
