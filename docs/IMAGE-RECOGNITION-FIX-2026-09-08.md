# Image recognition fallback — 8 September 2026

The customer reported that a clear knife photo received “I can't make out the item”. Claude's image API identified a chef's knife successfully. The route then failed to verify an exact catalogue image match and replaced that identification with the generic ambiguous-photo reply.

The route now keeps a positive product-category identification independently of a purchasable catalogue match. This fallback has no product cards, no selected product and no stock or price claims. It offers a similar item or the exact model only. It also retains supplied quantities and survives a catalogue-lookup deadline. Uncertain descriptions, documents, flat graphics and unknown images retain the existing clarification handling.

The test used the knife pixels isolated from the customer's supplied screenshot, excluding surrounding chat text. The uploaded filename was neutral; the original full-resolution photo was not available. Before the change, direct Claude inspection identified a chef's knife while the local chat API returned the ambiguous-photo reply.

After the change, live API checks identified the knife, retained quantity 3 and returned no unverified products. The random non-product fixture still requested clarification. The browser upload with “you have this ?” replied:

> That's a knife in your photo, but I can't confirm the exact model on our side.
>
> Want me to look for a similar one?

Both “Find a similar knife” and “Only the exact model” buttons appeared. The 19 affected recognition, image-evidence and Claude tests passed, along with TypeScript and ESLint. Local evidence is in `tmp/qa-reports/knife-recognition-before.json` and `tmp/qa-reports/knife-recognition-after.json`. This change is local and has not been deployed.
