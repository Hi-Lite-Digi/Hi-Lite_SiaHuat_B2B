# Extensive Conversational Stress Test

Date: 20 August 2026  
Target: `http://localhost:3002/`  
Method: End-to-end testing through the visible chat interface, using long and intentionally messy customer conversations.

## Executive result

The chatbot is fast enough, but it is not yet reliable enough for an unsupervised sales demonstration.

- 29 measured response cycles; every measured cycle completed in under 30 seconds.
- Average measured time: 6.2 seconds.
- Median measured time: 1.8 seconds.
- Slowest measured time: 18.2 seconds.
- 18 of 29 measured cycles completed in under 5 seconds.
- Casual chat, prompt-injection resistance, basic invalid-quantity handling, and one detailed noodle-strainer search passed.
- Long-conversation memory, alternative selection, Chinese product search, strict product-type relevance, and correction recovery failed in repeatable ways.
- Browser console recorded repeated `n8n handled-turn sync failed` errors during the run.

## Conversation 1 — Commercial plates, quantity and alternatives

Customer:

> eh hi, opening small zichar stall next month. need around 30 white dinner plates, commercial use, 25cm-ish. got anything not too expensive?

The bot correctly asked for a material preference. After the customer answered:

> no preference lah, as long can survive restaurant use and close to 25cm. show me 3 different choices

the bot returned only one product. When the customer requested two more products with at least 30 pieces available, the bot treated that request as confirmation of the single displayed product. After the explicit rejection:

> no, show others. i haven't picked yet. i want options first

the bot repeated the same plate again.

Result: **FAIL — critical option/rejection loop**

Expected behavior: Return up to three different 25 cm commercial dinner plates that satisfy the requested quantity. A rejection must exclude the rejected item from the next result set.

## Conversation 2 — Damascus/Japanese knife, then switch to woks

Customer:

> boss i need 3 damascus chef knives, Japanese made if have, around 20cm blade. can recommend a few?

The bot correctly disclosed that it could not confirm a Damascus match, but it returned only one ordinary Atlantic knife and did not satisfy the Japanese-made preference. The customer then said:

> Japanese-made is more important than damascus. show Japanese chef knives only, still need 3 pieces

The bot tried to confirm the previously displayed Atlantic knife instead of performing the Japanese-only refinement.

The customer explicitly changed category:

> no lah forget knives already. now i need 4 carbon steel woks for zichar, around 36cm. show proper woks only

The bot asked whether the customer wanted both a knife and a wok. Even after:

> only wok. 4 pieces, carbon steel, 36cm. knife cancelled

it repeated the same knife-or-wok question.

Result: **FAIL — critical stale-product and category-switch memory**

Expected behavior: Replace the earlier knife intent with the explicit wok request and search only for 36 cm carbon-steel woks with at least four units.

## Conversation 3 — Absurd requests and recovery to a real product

Customer deliberately asked for 40 kg of fresh banana peels to wear as a hat. The bot asked whether the customer wanted fresh or novelty banana peels instead of first checking whether that category existed in the catalogue. After being forced to answer directly, it rejected banana peels but suggested 40 kg of whole bananas, another ungrounded category.

The bot correctly rejected a subsequent condom request and explained the Sia Huat product scope.

The customer then made a genuine request:

> okay serious now. need something handheld to drain maggi mee water, fine mesh, not cocktail bar strainer. bamboo handle can

The bot returned three genuine noodle strainers and did not include bar/cocktail strainers. This part passed.

When asked to recommend one for five packets of noodles, it repeated the same three products without making a recommendation. The customer selected:

> 3 seems biggest, take that one. need 6 pieces

The bot said it did not know which item. After `number 3 lah`, it unexpectedly returned three plates. When corrected, it tried to confirm one of those plates.

Result: **PARTIAL PASS, then FAIL — selection recovery caused a cross-category jump**

## Conversation 4 — Chinese product search

Tested with:

> 你好，我开餐厅，需要10个黑色的晚餐盘，大约27厘米。请给我三个不同选择。

The bot returned a generic request for product details even though the product, colour, size, use case and quantity were all supplied. A mixed Chinese/English retry and then a plain English retry in the same conversation returned the same generic response.

Result: **FAIL — Chinese product discovery is non-functional in this flow**

Expected behavior: Search the same catalogue and reply in Chinese, preserving `黑色`, `晚餐盘`, `27厘米`, `餐厅用`, and quantity `10`.

## Conversation 5 — Full serving-spoon purchase journey

The detailed first serving-spoon request returned a lookup failure. A simpler retry reported that no matching item had five units. When the customer requested similar serving spoons with at least five units, the bot returned:

1. A self-levelling measuring spoon
2. A measuring-spoon set
3. A plastic measuring cup

After the customer explained that those were not serving spoons, the bot returned an out-of-stock measuring-cup set.

Result: **FAIL — critical product-type relevance problem**

Expected behavior: Results must remain within serving spoons/buffet serving utensils. If no relevant item meets the quantity, say so without substituting measuring products.

## Conversation 6 — Casual, security and invalid quantities

Passed checks:

- Casual Singlish-style greeting received a short natural reply in 0.4 seconds.
- A request to reveal Supabase keys, n8n credentials and environment variables was refused.
- `2.5 chef knives` was rejected as a fractional quantity.
- `999999999999 plates` was rejected as exceeding the allowed range.

Weak check:

- `minus 4 knives` was not treated as an invalid negative quantity; the bot continued into a knife search.

Result: **MOSTLY PASS**

## Conversation 7 — Rapid consecutive WhatsApp-style messages

The customer quickly sent:

1. `need 10 black dinner plates`
2. `27cm round, commercial restaurant use`

The message queue preserved both messages and responded within 17.3 seconds. However, the first result set included a cast-iron octopus-ball cooking plate, which is not a dinner plate. The heading also said all options had at least `10 PKT`, although later products used `PC` as their unit.

Result: **PARTIAL PASS — queue works, catalogue relevance and UOM labelling fail**

## Existing conversation observed before reset

The pre-existing conversation showed another repeatable context loss:

1. Customer requested 30 cutlery sets.
2. Bot asked whether any material was acceptable.
3. Customer answered `any material is ok`.
4. Bot replied `I missed that. What product are you looking for?`

Result: **FAIL — clarification answer lost the active cutlery-set category**

## Console/runtime evidence

The browser console recorded repeated:

> [chat] n8n handled-turn sync failed

These failures did not always prevent a visible reply, but they mean the n8n brain synchronization is unreliable and may contribute to memory divergence between handled client turns and later AI turns.

## Priority fixes

1. Make explicit correction and rejection commands override any pending single-product confirmation.
2. Keep the last displayed option set addressable until the customer requests a new search; parse phrases such as `3 seems biggest, take that one` as option 3.
3. Replace old product categories when the customer says `forget`, `cancel`, `only`, `instead`, or `now I need`.
4. Enforce product-family constraints after every search and alternative lookup; serving spoon must not degrade into measuring spoon/cup, and dinner plate must not include cooking plates.
5. Validate unsupported categories against Supabase before asking follow-up questions or inventing alternatives.
6. Fix Chinese intent extraction and allow Chinese follow-ups to reach the same grounded catalogue search.
7. Preserve product/category context when the user answers a clarification such as material, size or use case.
8. Resolve n8n handled-turn synchronization errors and add a visible fallback metric/log that records which brain produced each answer.
9. Format stock headers per product UOM instead of using the first result's UOM for the whole result set.

