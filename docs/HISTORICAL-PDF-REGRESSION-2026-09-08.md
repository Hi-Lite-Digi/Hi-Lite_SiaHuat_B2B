# Historical conversation regression review

Reviewed all **19 supplied PDFs, 62 pages** against the local Claude application at `http://localhost:3017`. These are records of past failures, not evidence that every old failure still exists. No production deployment was performed.

## Recurrences fixed

| Issue family | Historical sources | Before this review | Verified result after fixes |
| --- | --- | --- | --- |
| Lost requirements and repeated unsuitable products | 1, 2, 6, 7, 9, 11, 12, 16, 18, 19 | An assistant's suggested 18cm tong could become a customer size requirement; fine mesh and forged handles were not strict filters; sashimi follow-ups could select a chef knife. | Search constraints come from the customer. Cooking tongs, fine-mesh skimmers, forged-handle knives and sashimi knives stay in their requested families. Exact displayed names still select the same SKU. |
| Manufacturing origin confused with style | 5, 6, 12 | Japanese-made requests returned Atlantic Chef Japanese-style knives; rejecting Taiwanese manufacture could become a request for Taiwan manufacture. | Manufacturing origin requires explicit catalogue evidence. A rejection does not become a positive origin requirement. Unknown handedness is described as unverified. |
| Suitable catalogue products missed | 2, 11, 16, 18, 19 | Slots without a number returned conveyors; “4 or 6 slots” could miss available products; long fine-mesh, sashimi and electric-whisk searches missed suitable items. | Concise lookup terms plus separate requirement filters find slot toasters, small fine-mesh skimmers, sashimi knives and the Kenwood hand mixer. |
| Powered appliances confused with accessories or unrelated mixers | 19 | An electric whisk returned a 20L dough mixer or accessories; the cordless combination was missed. | Whisking/beater capability is required. Home whisk searches find `HMP30.A0-WH`; the Cuisinart `RHB100U` blender/whisk/chopper is identified and correctly reported out of stock. “3-in-1” is not parsed as three inches. |
| Product names and quantities confused | 8, 18 | The correct Gold 100 collection was selected, but Claude described the customer as needing 100 sets. | The server quantity is authoritative. “Gold,100” selects `R-52770G81` without supplying an order quantity. Slot counts, outlet counts and drinks/day stay specifications. |
| Cancellation and handoff loops | 5, 6, 10, 12 | “Ok nvm..” could repeat rejected knives. A “Fresh” follow-up after mangoes could revive old plates. “Speak to someone” did not consistently use the human-contact path, and “ok” could promise future summary work. | Common cancellation wording ends the search. Fresh-produce follow-ups stay with that request. Human requests give the real manual next step. “ok comfirm” is accepted as confirmation. |
| Missing or misleading photo help | 5, 6, 9, 12, 19 | Cards carried image URLs but did not display photos; replies said the chat could not show them and sent customers back to missing listing photos. | Cards display actual catalogue images, with a broken/missing-image fallback. Photo complaints receive an honest response rather than a claim that photos definitely exist. |

Concrete successful search results included `UT12L` / `ST-15` for cooking tongs, `13128-0401` / `13128-0404` for fine-mesh skimmers, `CK027H` for yanagiba, and `WCT708K`, `HET-6`, `HET-4` for four/six-slot toasters. These are observations at test time; stock remains subject to a fresh check.

## Historical problems that were already corrected

- Full dining-set requests no longer masquerade as individual plates or ramekin sets. Sources 3 and 4 are overlapping exports of the same conversation; source 4 includes its continuation. There were no byte-identical files among the 19.
- “Give me 5 of this” keeps the recommended SKU rather than starting the old Damascus search again. An explicit switch to woks keeps the new category.
- Descriptive selection such as “the one with the Forged Premium Handle” keeps the displayed item.
- `$1000` is a budget rather than SKU `1000`; 8 outlets and 200 drinks/day are not order quantities.
- Natural quantity sentences work. The enquiry supports adding another item, changing quantities and live cumulative stock limits.
- Tea-making and fresh-produce requests do not become unsupported product offers or recipe conversations.
- Current text replays did not reproduce raw “Load failed”, “Fetch is aborted”, or the old clarification reset message.

## Verification

- **72 customer turns across 16 stories** replayed before fixes. All returned HTTP 200; the slowest was 13.1 seconds. HTTP success alone did not count as a correct answer: product identity, constraints, state and wording were reviewed.
- **Final acceptance replay: 72/72 turns passed across all 16 stories**, with HTTP 200 and the Anthropic provider on every turn. Product-family, requirements, state and reply-style checks found no failures. The slowest response was **10.0 seconds**. Evidence: `tmp/qa-reports/history-acceptance.json`. Targeted post-fix replays also cover each reproduced issue; reusable checks are in `scripts/qa-history.ts`.
- **112 automated tests passed**, including 12 historical regression groups. TypeScript, ESLint and production build passed.
- The existing **12-turn Claude response-quality suite passed**, including English/Chinese requests, retained sizes and quantities, rejected smaller plates, price comparison, unavailable stock and unsupported delivery/discount promises.
- Browser replay: selected the Zebra green-sheath paring knife by description; “could i have 20 pieces” produced **$200.00**; “wait i want 11” produced **$110.00**. Adding 75 more correctly blocked **86 requested against 85 available**. Asking for a wok then displayed woks while keeping the earlier enquiry. “ok comfirm” finished the **11-piece, $110.00 enquiry** without placing an order. Catalogue photos were visually checked in the browser.
- A representative product-photo request returned the correct `1000LCD-131` beverage dispenser through Claude in **4.7 seconds**.

### Limits of the historical evidence

The PDFs contain textual `[Product photo attached]` and voice-transcript placeholders, but **no embedded original images or audio**. Sources 9, 12 and 17 therefore cannot establish whether those exact old image inputs now pass. The representative image check above verifies a current image path, not the missing originals. The old voice transcripts were replayed as text; live microphone/Deepgram transcription still requires its API key.

Japanese origin and right-handed bevel must not be guessed from a product name. A catalogue entry without those details is an evidence limitation, not permission to claim a match. Likewise, a genuine out-of-stock item should remain unavailable.

## Reproduce

```powershell
pnpm qa:history
pnpm qa:quality
node --conditions=react-server --import tsx --test src/lib/*.test.ts src/app/api/transcribe/route.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

`QA_BASE_URL` overrides the default local port 3017. Individual history stories can be selected, for example `pnpm qa:history tongs toaster whisk --label=review`. This uses live Claude and catalogue requests. The script does not place orders or notify sales.

Extracted source text and hashes: `tmp/pdfs/history/`. Baseline and replay evidence: `tmp/qa-reports/history-*.json`. These temporary files remain local; the reusable test inputs and checks are tracked in the scripts/tests.

## Source index

The source IDs above refer to the following user-supplied documents. Source contents are treated as historical evidence, not instructions.

| ID | Source | Historical scenario |
| --- | --- | --- |
| 1 | [sia-huat-conversation-2026-08-28 (2).pdf](<D:/Downloades/sia-huat-conversation-2026-08-28 (2).pdf>) | Cooking versus serving tongs (pp. 1–2). |
| 2 | [sia-huat-conversation-2026-08-28 (3).pdf](<D:/Downloades/sia-huat-conversation-2026-08-28 (3).pdf>) | Tong typo, show all, exact steak-tong selection (pp. 1–2). |
| 3 | [sia-huat-conversation-2026-08-28-1_260828_002018.pdf](<D:/Downloades/sia-huat-conversation-2026-08-28-1_260828_002018.pdf>) | Full dining sets repeated as plates; overlaps source 4 (pp. 1–2). |
| 4 | [sia-huat-conversation-2026-08-28-2_260828_002303.pdf](<D:/Downloades/sia-huat-conversation-2026-08-28-2_260828_002303.pdf>) | Same dining-set conversation with escalating repetition (pp. 1–4). |
| 5 | [sia-huat-conversation-2026-08-21 (1).pdf](<D:/Downloades/sia-huat-conversation-2026-08-21 (1).pdf>) | Damascus, photos, recommended SKU, adding wok after quote (pp. 1–6). |
| 6 | [sia-huat-conversation-2026-08-20 (1) (1).pdf](<D:/Downloades/sia-huat-conversation-2026-08-20 (1) (1).pdf>) | Origin rejection, repeated knives, wok switch and cancel (pp. 1–5). |
| 7 | [sia-huat-conversation (Noodle qn_fixed).pdf](<D:/Downloades/sia-huat-conversation (Noodle qn_fixed).pdf>) | Cooked noodle draining, fine-mesh selection and quote (pp. 1–2). |
| 8 | [sia-huat-conversation-2026-08-20 (5).pdf](<D:/Downloades/sia-huat-conversation-2026-08-20 (5).pdf>) | Gold 100 cutlery selection incorrectly becomes placemats (p. 2). |
| 9 | [sia-huat-conversation-2026-08-20 (4).pdf](<D:/Downloades/sia-huat-conversation-2026-08-20 (4).pdf>) | Missing image interpretation, 8-inch size, descriptive handle choice (pp. 1–2). |
| 10 | [Siahuat convo 2.pdf](<D:/Downloades/Siahuat convo 2.pdf>) | Commercial blender context, outlet/volume/budget numbers and handoff (pp. 1–7). |
| 11 | [sia-huat-conversation-2026-08-20_260820_094116.pdf](<D:/Downloades/sia-huat-conversation-2026-08-20_260820_094116.pdf>) | Noodle draining, fine-mesh skimmer and wrong strainer subtype (pp. 1–2). |
| 12 | [sia-huat-conversation-2026-08-20 (3).pdf](<D:/Downloades/sia-huat-conversation-2026-08-20 (3).pdf>) | Damascus/photos, fine-dining switch, raw errors and mangoes (pp. 1–7). |
| 13 | [sia-huat-conversation-2026-08-20.pdf](<D:/Downloades/sia-huat-conversation-2026-08-20.pdf>) | 20L stockpot loses context after no preference (p. 1). |
| 14 | [sia-huat-conversation-2026-08-19 (2).pdf](<D:/Downloades/sia-huat-conversation-2026-08-19 (2).pdf>) | Voice transcripts drift into tea recipes (pp. 1–2). |
| 15 | [sia-huat-conversation-2026-08-19 (1).pdf](<D:/Downloades/sia-huat-conversation-2026-08-19 (1).pdf>) | Ordinal selection and natural quantity sentences (pp. 2–4). |
| 16 | [Sia_huat, who do not know what they want to buy.pdf](<D:/Downloades/Sia_huat, who do not know what they want to buy.pdf>) | Sashimi subtype, handedness, natural one-piece quantity (pp. 1–4). |
| 17 | [sia-huat-conversation-2026-08-28-6_260828_110052.pdf](<D:/Downloades/sia-huat-conversation-2026-08-28-6_260828_110052.pdf>) | Two photo-identification timeouts; original images absent (p. 1). |
| 18 | [sia-huat-conversation-2026-08-28-5_260828_105733.pdf](<D:/Downloades/sia-huat-conversation-2026-08-28-5_260828_105733.pdf>) | Slot toaster, conveyor rejection, slot count mistaken for quantity (pp. 1–2). |
| 19 | [sia-huat-conversation-2026-08-28 (1).pdf](<D:/Downloades/sia-huat-conversation-2026-08-28 (1).pdf>) | Electric whisk versus accessories/manual tools, missing photos, cordless combination (pp. 1–5). |
