# Luna migration — 10 September 2026

Claire now uses OpenAI `gpt-5.6-luna` for conversational wording and customer-photo recognition through the Responses API. Catalogue search, product selection, stock limits, quantity changes, enquiry totals, and PDF export remain controlled by application code.

## Configuration

- `OPENAI_API_KEY`: server-only OpenAI credential, stored in ignored `.env.local` and Vercel Production as a Secret.
- `OPENAI_MODEL`: `gpt-5.6-luna` (also the code default).
- Reasoning effort: `none`; maximum generated output: 1,200 tokens per model call; strict JSON output; `store: false`; standard service tier.
- A wording turn may make one repair call. A dropped connection may retry once within the same deadline. HTTP errors do not trigger a retry or an expensive model fallback. Verified deterministic replies remain available when wording fails.
- Images are passed as actual pixels. Filenames and uncertain branding cannot establish an exact SKU. Customer uploads remain enabled; catalogue pictures remain hidden.
- Existing Deepgram voice transcription is unchanged and still requires `DEEPGRAM_API_KEY`. Luna itself is not an audio transcription model.
- Old `brain: claude` and `brain: n8n` request values remain accepted for compatibility; they now use Luna. Anthropic credentials are no longer read by the running application.

## Usage visibility

Server `[ai/usage]` records contain request ID, model, input/output tokens, cached reads, cache writes, reasoning tokens and estimated USD cost. They do not include messages, images or credentials. Response header `x-ai-usage` sums measured calls for that customer turn, including image analysis and wording repairs. `complete: false` means a call has missing usage, an unresolved connection, or unknown pricing; the partial amount must not be treated as the full bill.

Rates checked against the [official Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6): $0.20 per million uncached input tokens, $0.02 cached input, $0.25 cache writes, and $1.20 output. Reasoning tokens are already included in output. The documented long-context multipliers apply above 272,000 input tokens. Estimates exclude infrastructure, transcription, tax, and provider billing adjustments. No test spending cap is enforced, as requested.

## Verification

Run mocked tests with `pnpm exec tsx --conditions=react-server --test src/lib/*.test.ts`, followed by `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Paid acceptance commands are `pnpm qa:luna`, `pnpm qa:quality`, and selected `pnpm qa:history` stories. These record usage in ignored `tmp/qa-reports/` files. Preserve earlier Claude reports as comparison evidence.

Migration testing also corrected excessive reply buttons, exposed internal wording, photo buttons that repeated an input instruction, and hand-mixer requests that asked the same power-rating question instead of finding the existing powered-whisk product family.

Local acceptance: 12 reply-quality turns passed; knife and unrelated-photo checks passed; 20 selected historical turns exposed button-length and collection-name issues, which were fixed and retested. All 125 mocked tests, lint and production build passed. The browser rejected 2 mixers when only 1 was available, then accepted a reduction to 1.

Release results and live browser evidence are recorded locally in `tmp/qa-reports/luna-release-2026-09-10.md` after deployment.
