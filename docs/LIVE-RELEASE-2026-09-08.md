# Live release — 8 September 2026

The user authorized publishing to GitHub and Vercel, and requested a WhatsApp Web completion message after live-site testing. Releases `6ee4aae` and `2427e88` were pushed to `main` and successfully deployed to the production alias. The completion message remains pending the final shopping/PDF check.

## Prepared candidate

Claude migration, shopping-state fixes, contextual reply buttons, historical-PDF regressions, and the knife-recognition fallback are ready locally. Product photos have been removed from assistant replies at the user's request; customer photo uploads remain supported. The release run passed all 121 automated tests. Earlier acceptance passed 72 live Claude turns across 16 historical stories and the 12-turn reply-quality suite; the subsequent image fix passed live API and browser checks, type checking, lint and the production build. See `HISTORICAL-PDF-REGRESSION-2026-09-08.md` and `IMAGE-RECOGNITION-FIX-2026-09-08.md` for evidence and limitations.

## Verified release target

- Production: https://hi-lite-sia-huat-b2-b.vercel.app/
- Dashboard: https://vercel.com/hi-lite-website/hi-lite-sia-huat-b2-b
- Repository: `Hi-Lite-Digi/Hi-Lite_SiaHuat_B2B`; production branch `main`.
- Production commit observed before the final shopping patch: `2427e888625b9c150b4e5067f6e434fe4f4d1fb7`.
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

## Production verification

- Historical regression replay: 72 turns, zero reported issues, against the production API. The 12-turn reply-quality suite also passed with Anthropic provider responses.
- Customer photo recognition: the knife crop from the supplied screenshot was identified as a knife in both the production browser and API. Quantity 3 was retained; no exact model or catalogue availability was invented. An unrelated image correctly requested clarification. The structured vision category fix in `2427e88` prevents unclear branding from erasing a clearly recognized item type.
- Browser shopping: selected the Kenwood HMP30.A0-WH mixer, observed stock 1, rejected quantity 2, accepted quantity 1, and rejected adding another unit cumulatively. Enquiry remained 1 × $73.30 excluding GST.
- The additional-item test exposed two lookup problems: `15 inch` missed a listing using `15"`, and an explicit ST-15 code correction retained an old search. The final patch retrieves the steak-tong family before applying dimensions and preserves positive code-selection commands. Both contextual API lookups returned ST-15 locally; 32 affected regression tests, type checking, lint and the production build passed.
- Remaining release verification at this commit: deploy the final lookup patch, finish the live multi-item enquiry/PDF, then send the WhatsApp completion message. Voice still requires a Deepgram key. No purchases or automatic sales enquiries were submitted.
