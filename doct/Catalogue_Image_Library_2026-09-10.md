# Catalogue image lookup

Customer photos now go through catalogue-wide image comparison before the existing Claude vision/OCR flow. Claude remains the response and vision provider. Voice configuration is unchanged.

## Decision flow

1. Normalise the uploaded photo and compare it with catalogue reference fingerprints in Supabase. Exact file/pixel hashes and a compact vector shortlist are rescored for foreground colour, shape and proportions.
2. A unique near-identical result (score at least 0.985, with a 0.025 separation from a different SKU unless hashes match) can return the catalogue item and ask the customer to confirm. It does not select an item or create an order automatically.
3. Identical or near-identical pictures used by different SKUs remain ambiguous. Show the variants, or ask for a code/size when there are too many.
4. A score of 0.80 is only the candidate threshold. These candidates still go through independent Claude product recognition and the existing visual evidence check. It is not an 80% probability of a correct SKU.
5. No match, low-detail pictures, or an unavailable index retain the existing Claude vision/OCR, descriptive catalogue search and image validation. An image lookup failure is never evidence that the product is unavailable.
6. Product facts and user constraints still apply. Confirmation triggers the existing fresh stock check, quantity limits and enquiry summary flow.

The thresholds are conservative heuristics calibrated against this test set, not a measured accuracy guarantee. This first layer targets reused catalogue photos, resized copies and simple borders. Different angles, busy backgrounds, substantial crops and screenshots containing text still need vision.

## Data and coverage

Completed 10 September 2026 against project `hvnuatfxlccnmdtmhdem`:

- 19,391 catalogue products after adding 196 newly discovered item codes.
- 17,198 non-placeholder image URL records; all current non-placeholder catalogue URLs indexed successfully.
- 16,674 fingerprints eligible for visual matching. The remaining 524 low-detail references retain the vision fallback.
- 16,349 distinct content files in the private `catalogue-reference-images` bucket, approximately 157 MB. Identical content is stored once.
- 1,829 products use the website's placeholder graphic; that graphic cannot identify a SKU and is deliberately excluded.
- Four stale image links were refreshed from their current product pages.

Only public catalogue reference images are persisted by this feature. Customer uploads are processed for lookup and are not added to this library. The runtime uses the existing publishable key with SELECT-only RLS; the administrative key is used only by the local indexing worker. Supabase security advisor reported no findings after the schema changes.

## Operation

Apply the two Supabase migrations in order. Their filenames match the migration versions applied to the live project. Use the project's Supabase migration history; the legacy `db:migrate` runner targets a separate installation and its `app_schema_migrations` ledger is not present on this live project.

Save the correct project's administrative credential as `CATALOGUE_IMAGE_ADMIN_KEY` in ignored `.env.local`. Do not put this credential in the browser or the web deployment.

```sh
pnpm catalogue:images --concurrency=12
```

This command reads the current `products` table, deduplicates image URLs, stores private compact WebP references and writes fingerprints. It skips completed rows, retries failures and can safely resume. Its local cache and run summary are under ignored `tmp/catalogue-images/`.

After updating the catalogue, rerun the command to add newly referenced images. To refetch images whose content may have changed at the same URL:

```sh
pnpm catalogue:images --refresh --concurrency=8
```

Catalogue crawling/import is a separate operation; indexing does not discover new product pages or refresh prices. There is no new background schedule. The request path only accepts candidates still linked to active catalogue products. Old unused reference files are not automatically deleted.

Set `CATALOGUE_IMAGE_LOOKUP_ENABLED=false` to disable this enhancement and use the existing vision flow. Default is enabled. No administrative credential is needed in Vercel.

## Verification

- All 158 automated tests (including the four voice-route checks) passed; lint and production build passed.
- Final catalogue sample: 48/48 original, resized JPEG and bordered-image checks retrieved the expected SKU. A low-detail reference was explicitly skipped. Earlier broader sampling also retrieved 51/51 after replacing approximate retrieval with exhaustive shortlist ranking.
- Blank image produced no library match. The alternate-angle outdoor stove photo scored approximately 0.85 and required Claude validation, rather than becoming an automatic exact match.
- Final sample lookup latency: median 597 ms, p95 702 ms, max 954 ms. The much larger stove photo took about 4.4 seconds including image decoding; these timings exclude the final conversational reply.
- Local browser: customer's torch photo returned CB-TC-CKWH; typed confirmation checked 883 available; 1,000 PC was rejected; changing to 12 PC produced $692.52 ex GST.
- Local browser: copper shaker photo returned CSD16C; reused Camtainer photo offered both 5.7 L and 44.5 L variants; alternate stove photo completed the existing Claude validation flow and returned CB-ODX-1-BK.
- Live browser: correct shaker and shared Camtainer variants verified. The alternate stove photo retained its cooking-stove identification and asked for model confirmation when exact matching could not finish confidently. A follow-up quantity parsing fix accepts polite replies such as "200 please" while keeping stock limits and specification/price exclusions intact.

Run the repeatable image check after indexing (uses locally cached catalogue images):

```sh
pnpm exec tsx --conditions=react-server scripts/qa-catalogue-image-library.ts
```

Detailed calibration output is written to ignored `tmp/qa-reports/catalogue-image-library.json`. Image scores are internal evidence, not customer-facing confidence percentages.
