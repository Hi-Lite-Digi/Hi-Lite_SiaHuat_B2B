# Claude restoration — 2026-09-10

The web application uses Anthropic Messages with `claude-sonnet-5` for customer replies and product-photo inspection. `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are server-only settings. The former Luna adapter has been removed; legacy client `brain` values remain accepted but cannot select a different provider. Deepgram remains the voice-transcription provider.

The model writes the reply and may omit unsuitable catalogue candidates. Existing catalogue matching, stock checks, carton conversions, selected-product state, and quote totals remain controlled by application code. Seeing a product type in a photo does not confirm its exact catalogue model.

Replies use structured JSON, local schema validation, and one bounded style repair. The common instructions use Anthropic prompt caching. The usage log counts Anthropic's uncached input, cache reads and writes, and output separately. Unknown model prices are reported as unavailable instead of guessed.

The route allows 45 seconds across catalogue/vision and wording, within a 60-second function limit. The browser waits 50 seconds to include network overhead. Individual Anthropic calls still have an 18-second timeout. This leaves wording time after a slow image lookup instead of cancelling at the former 30-second turn limit.

Successful model responses expose `x-chat-provider: anthropic` and `x-chat-model: claude-sonnet-5`. A provider outage can return a verified deterministic reply labelled `deterministic-fallback`; acceptance tests must not count that as a successful Claude response. No request falls back to OpenAI.

## Verification

Run the unit suite, lint, and build. With a running application, `pnpm qa:claude` checks real Sonnet responses, language, relevance, and response style. Set `QA_BASE_URL` to test production. Set `QA_IMAGE_PATH` to a local JPEG of an outdoor stove to also test image identification; the upload uses a neutral filename. `QA_REPORT_PATH` can separate local and production evidence.

Browser acceptance covers photo upload and similar-product follow-up, purchasing two different products, converting 12 cartons of GAS cartridges into 576 pieces, rejecting quantities above available stock, and changing back to 10 cartons without changing the torch line. Confirm the displayed quote and PDF summary agree.

## Release

The production project is `hi-lite-website/hi-lite-sia-huat-b2-b`, connected to `Hi-Lite-Digi/Hi-Lite_SiaHuat_B2B` on GitHub. Configure the production Anthropic settings before pushing the release. The local `.vercel/project.json` refers to a legacy project and must not be used for this release. Verify the GitHub Vercel deployment status and exercise the public application after deployment.

Historical migration notes describe earlier providers and are not the current configuration. Keep credentials and generated QA transcripts out of Git.
