# Shopping enquiry QA — 8 September 2026

Tested the local Claude version at http://localhost:3017 using the browser, the local API, and regression tests. Catalogue prices and stock were checked against the live Sia Huat listings. No purchases or sales messages were sent. The public deployment was not changed.

## Errors found and corrected

- **Adding more lost the selected product.** “Add 16 more of the same knife” now uses the existing line and checks 2 + 16 = 18 against stock of 17. Repeated additions accumulate; a quantity correction replaces the quantity.
- **Some new product codes changed the previous item's quantity.** `Add 1 PC of R-52713B81` previously changed the current pan to 1 PC because the code's single-letter prefix was missed. It now searches the requested code. Explicit additions cannot fall into the current item's quantity shortcut.
- **Rejecting a candidate forgot the requested quantity.** Selecting another wine glass now retains the original 3 pieces.
- **Removing a line did nothing.** Named items or product codes can now remove an unambiguous existing line. Other lines remain. Clearing the enquiry records an empty receipt, so PDF receipt data cannot fall back to an older quote.
- **Changing product could discard specifications.** An explicit switch retains the supplied new size, type and quantity, and replaces the previous line when the new item is confirmed.
- **Quantity shortcuts could reuse stale stock.** Quantity changes now recheck stock and price. The final quote boundary rejects unavailable, unverified, excessive or invalid quantities.
- **Stock responses could outlive a reset.** Stock checks now respect the current conversation session and serialize subsequent messages.
- **Historical confirmation buttons could reappear.** Only the latest product confirmation displays its controls.

## Browser results

| Scenario | Observed outcome |
| --- | --- |
| Knife quantity 0, -2 or 2.5 | Rejected; no new quote |
| Knife quantity 18 with 17 available | Blocked; offered 17 or another product |
| Knife quantity 17 | $756.50, at $44.50 each |
| Existing 2 knives, add 16 more | Checked as 18 total and blocked |
| Accept 17 after the repeated-addition warning | Exactly 17, not 19; $756.50 |
| “Actually make it 2” | 2 knives; $89.00 |
| Request 3 glasses, reject one candidate, choose another | Still requested 3 glasses |
| 2 knives plus 3 glasses at $20.09 | Two lines; $149.27 total |
| Change the earlier glasses line to 4 | Knife unchanged; $169.36 total |
| “Remove the knife, keep only the glasses” | 4 glasses only; $80.36 |
| Switch to 24cm non-stick frying pan, 2 pieces | Size and quantity retained; pan-only summary, $36.70 |
| Request 26 pans with 25 available | Blocked |
| Accept 25 pans | $458.75 |
| Add sold-out `R-52713B81` | Out-of-stock response with alternatives; no automatic addition |
| Cancel additional-item search | Retained the existing pan enquiry |
| Finish summary | Included only the retained pan; no purchase claimed |
| Cancel the completed enquiry | Enquiry became empty |
| Reset immediately after beginning stock check | Remained at the fresh greeting after the response completed |

Prices above exclude GST. Stock counts are observations at test time, not reservations.

## Automated verification

- 89 tests passed with `node --conditions=react-server --import tsx --test src/lib/*.test.ts src/app/api/transcribe/route.test.ts`.
- Four live Claude acceptance turns passed with `pnpm qa:claude`, including English and Chinese. Responses used the Anthropic provider. Detailed responses are saved locally in `tmp/qa-reports/claude-migration.json`.
- Invalid negative API context quantity returned HTTP 400; an unknown stock code returned HTTP 404.
- Type checking, ESLint and the production build passed.

The stock-failure and unavailable-stock quote guards have automated coverage; an actual supplier outage was not induced. Voice transcription remains outside this shopping test: it still needs a Deepgram key for a live provider test. This is a targeted regression pass, not a claim that every possible conversation has been tested.
