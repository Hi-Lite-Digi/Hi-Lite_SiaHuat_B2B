# Hi-Lite × Sia Huat Product Assistant

Phase 1 is a conversational product-enquiry web application backed by n8n Cloud, OpenAI, and a Sia Huat catalogue in Supabase Postgres.

## Live demo

[Open the Hi-Lite × Sia Huat Product Assistant](https://hi-lite-sia-huat-b2-b.vercel.app/)

Current release: `V_3.1.2`

The website catalogue is discovered from Sia Huat's public sitemap and imported with the displayed item code as the unique identifier. Product discovery uses the cached Supabase catalogue; after the customer confirms an exact item, the app performs a fresh website check for the displayed price and stock status.

The assistant clarifies broad requests, searches real catalogue data, asks for quantity, calculates an estimated total deterministically, and prepares the result for human sales review. It never confirms an order or sends a customer message automatically.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system design, trust boundaries, security model, and remaining production work.

## Local setup

1. Copy `.env.example` to `.env.local` and add the server-only n8n values.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. Open `http://localhost:3000` or the port printed by Next.js.

Required application variables:

```text
N8N_WEBHOOK_URL=https://your-n8n-instance.example/webhook/sia-huat-web-chat
N8N_WORKFLOW_KEY=server-only-secret
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The catalogue import scripts additionally require `SIA_HUAT_PROJECT_REF` and `SIA_HUAT_POSTGRES_PASSWORD`. Those administrative values are for local import/migration work and should not be configured in the deployed web application.

## Catalogue sync

The public sitemap currently exposes more than 19,000 product pages. The crawler is resumable and writes sorted results plus a failure report under `tmp/siahuat-crawl/`.

```bash
pnpm catalogue:crawl -- --concurrency=8
pnpm catalogue:crawl -- --concurrency=8 --import
```

Use a small `--limit=10` while testing. The checked-in n8n workflow export is `n8n/sia-huat-b2b-phase-1.json`; import it into n8n and configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in that n8n environment.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm db:verify
pnpm qa:all
```

`pnpm qa:text` runs the Sia Huat conversation, relevance, memory, safety and
handoff regression suite derived from the chatbot SOP. `pnpm qa:image` checks
the two supplied product-photo fixtures. Both commands write machine-readable
evidence to `tmp/qa-reports/`.

The local test flow should cover:

1. Ask for a broad product such as a knife.
2. Answer the clarification.
3. Confirm that displayed products match Supabase.
4. Select a product and enter a quantity.
5. Verify the calculated total and human-review wording.
6. Upload a product photo. A SKU-like source filename is verified against
   Supabase; otherwise the request is passed to the n8n vision workflow.

## Deployment policy

Development and acceptance testing stay local. GitHub is the source repository. Vercel should be connected and deployed only once the user explicitly approves a release candidate, avoiding unnecessary builds during development.
