# Screenshot recognition correction

An Iwatani torch screenshot exposed two gaps in the photo route. The isolated product photo matched CB-TC-CKWH at 0.981654, below the unchanged 0.985 direct-match threshold. Including the surrounding chat panel dropped the best library score below 0.8. Claude identified the full screenshot as a "torch lighter", but that phrase was absent from the search taxonomy, so the previous recognition fallback returned null.

The initial cropped-photo browser retest succeeded before these changes; the historical live failure was not reproduced on every call. The discarded "torch lighter" result and screenshot-frame similarity loss were reproduced independently.

Changes:

- Preserve confidently identified generic product types even when they are outside the catalogue search taxonomy. Normalize common torch descriptions to the same search family.
- Ask the existing Claude vision pass to distinguish one product inside a screenshot from a document/comparison and locate the photograph in pixel coordinates.
- Pre-size the vision input within the API image budget, normalize coordinates in code, validate the crop, and remove pale frame margins. No uploaded image is stored.
- Retry the existing catalogue image lookup on the isolated product. Keep direct-match, candidate and variant-ambiguity thresholds unchanged. Prefer a vision-supported image candidate over a new text search.
- Still require catalogue evidence and customer confirmation. Identifying a torch does not independently establish its exact model, price or stock.

Local verification:

- Browser: full torch/chat screenshot with "what is this item in my screenshot?" returned CB-TC-CKWH. Cropped library score 0.975619; secondary visual comparison 0.979382. Response presented an unconfirmed similar model rather than claiming an exact identity.
- Browser: its confirmation button refreshed live stock and advanced to quantity.
- Browser: rice dispenser comparison retained the two models and requested quantity, without invented product cards.
- Automated coverage includes torch synonyms, types outside the taxonomy, screenshot crop recovery, pale frames, invalid boxes, image coordinate scaling, provider schema, candidate confirmation and comparison separation.

The crop is a retrieval aid, not an identity assertion. Screenshots with multiple products, unreadable details or nearly identical variants can still require clarification.

Coordinate handling follows the provider's documented pixel-coordinate guidance: https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
