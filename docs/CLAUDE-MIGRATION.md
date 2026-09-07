# Claude migration

The web app now calls Anthropic directly from the server. `ANTHROPIC_MODEL` defaults to `claude-opus-5`, matching the supplied Roborock workflow. It was listed by the user's Anthropic account when the migration was prepared. Keys remain in ignored `.env.local` locally and server-only deployment variables when released.

## Reply flow

1. Validate the request and preserve per-session processing order.
2. Run the existing catalogue, compatibility, stock and quantity checks. For unfamiliar product photos, Claude reads the pixels; the catalogue must verify any eventual product match. Filenames do not count as visual evidence.
3. Give Claude the customer's recent conversation, the verified result, selected product, quantity and allowed next actions. Claude writes short, natural replies, asks one useful question and may omit unsuitable candidates. It does not create product records, change selected items or calculate prices.
4. Validate returned IDs/actions, retain the server's original product objects, and remove unsupported sales-handoff claims. Respond within the browser's existing timeout. A Claude outage uses the verified deterministic reply, with no fallback to OpenAI or n8n.

`x-chat-provider` identifies `anthropic` versus `deterministic-fallback`. Missing Anthropic configuration returns HTTP 503. Local product-selection, quote and PDF UI messages still run deterministically; this migration does not give the model control of orders, quotes or exports.

The conversation rules adapt the supplied Roborock reference for sales: brief acknowledgements, relevant options, one missing detail at a time, and PDF guidance only when useful. Dinner-plate searches also reject explicitly labelled platters/starter dishes; explicit round/reusable requests reject conflicting shapes/disposable materials.

## Voice

`/api/transcribe` sends audio directly to Deepgram (`nova-3`, language detection and smart formatting). Set `DEEPGRAM_API_KEY`. No n8n or OpenAI fallback is used. Without the key the endpoint returns `VOICE_TRANSCRIPTION_NOT_CONFIGURED`; live transcription and multilingual accuracy require acceptance testing with actual audio. The old n8n export is an optional Deepgram-based workflow, not the web app's runtime.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, and:

```sh
node --conditions=react-server --import tsx --test src/lib/claude-client.test.ts src/app/api/transcribe/route.test.ts
node --conditions=react-server --import tsx --test src/lib/*.test.ts
pnpm qa:claude
```

Verify a product enquiry, a correction, Chinese, missing matches, a selected product with quantity, image recognition and voice. Check that facts match the returned catalogue records and no unsupported staff notification is claimed. Provider request/validation tests use mocks; they do not establish model quality or live voice accuracy.

## Release

Local changes are not a production deployment. Before release, configure `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `DEEPGRAM_API_KEY` and `DEEPGRAM_MODEL` in Vercel, keeping existing catalogue configuration. Follow the repository's release-approval policy. After deployment, repeat the same browser conversations on the production URL. Previously activated n8n workflows are not deactivated by local file changes.

API references: [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create), [Deepgram prerecorded audio](https://developers.deepgram.com/docs/pre-recorded-audio).

## Recorded local verification — 8 September 2026

- Typecheck, ESLint and production build passed.
- 80 automated tests passed, including existing catalogue/intent/image/quote tests and new provider validation and transcription contract tests.
- Four live API turns used `x-chat-provider: anthropic`: café plates, the round/reusable/10-inch correction, Chinese chef-knife discovery, and a 20cm chef-knife enquiry for two pieces. Responses took approximately 3.9–9.7 seconds in this run. Evidence: `tmp/qa-reports/claude-migration.json`.
- A direct live Claude vision call identified the beverage-dispenser fixture and explicitly left brand, model and capacity unconfirmed. Evidence: `tmp/qa-reports/claude-vision.json`.
- The browser rendered the updated greeting and Claude's plate-size clarification without the unsuitable platter/starter cards.
- Deepgram was verified with mocked HTTP responses only. A live Deepgram key is still required; no live transcription claim is made.
- The public Vercel deployment has not been changed.
