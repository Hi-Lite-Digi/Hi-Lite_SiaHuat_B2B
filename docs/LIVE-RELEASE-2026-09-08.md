# Live release preparation — 8 September 2026

The user requested a WhatsApp Web completion message after the changes and live-site testing finish. No completion message has been sent; the release has not happened.

## Prepared candidate

Claude migration, shopping-state fixes, contextual reply buttons, historical-PDF regressions, and the knife-recognition fallback are ready locally. Product photos have been removed from assistant replies at the user's request; customer photo uploads remain supported. The release run passed all 121 automated tests. Earlier acceptance passed 72 live Claude turns across 16 historical stories and the 12-turn reply-quality suite; the subsequent image fix passed live API and browser checks, type checking, lint and the production build. See `HISTORICAL-PDF-REGRESSION-2026-09-08.md` and `IMAGE-RECOGNITION-FIX-2026-09-08.md` for evidence and limitations.

## Verified release target

- Production: https://hi-lite-sia-huat-b2-b.vercel.app/
- Dashboard: https://vercel.com/hi-lite-website/hi-lite-sia-huat-b2-b
- Repository: `Hi-Lite-Digi/Hi-Lite_SiaHuat_B2B`; production branch `main`.
- Current production commit observed: `4ff7cf66921b4e3016cf90b4b18331d889c3be66`.
- Current local `.vercel/project.json` points to the older `hi-lite-sia-huat-demo` in another team. Do not deploy through that link.
- The browser is signed in to the correct production project. The Vercel connector only lists the older team's projects; CLI authentication was not completed. GitHub CLI access works.
- Production environment names observed: `N8N_WEBHOOK_URL`, `N8N_WORKFLOW_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` were added as production-only Secret variables on 8 September. Deepgram remains unconfigured. Existing catalogue variables were retained.

## Release authorization and remaining steps

The user explicitly requested “push to github and vercel” on 8 September 2026. This approves the release candidate. GitHub push access and the correct production dashboard are available. The existing local Vercel link must not be used. Production Claude configuration was saved and verified through the authenticated dashboard before pushing.

1. Voice limitation: `DEEPGRAM_API_KEY` is absent locally and in production. The release retains the Deepgram integration and returns a clear not-configured error until a key is supplied. The user was informed of this remaining limitation during the release. No OpenAI transcription fallback is enabled.
2. Server-only Anthropic settings are configured for the correct production project. Configure Deepgram and test actual audio when its key is supplied. Never print or commit credentials.
3. Preserve unrelated local investor-report/PDF edits when preparing the approved release.
4. Deploy to the verified target, then replay historical and quality checks using `QA_BASE_URL=https://hi-lite-sia-huat-b2-b.vercel.app`. Test product selection, changed quantities, an additional item, cumulative stock rejection, final enquiry/PDF and customer photo recognition in the production browser. Verify provider headers and runtime failures.
5. Only after completion, send an accurate WhatsApp update with the live URL and any remaining limitations. WhatsApp Web is signed in and contains the user's self-chat explicitly marked `(You)`. Use that unless the user specifies another recipient. The screenshot's selected workshop-advertisement chat was not treated as the user's number.

At the time this release checklist was committed, production Claude settings were configured; deployment verification and the WhatsApp completion message remained pending. No purchases or automatic sales enquiries were submitted.
