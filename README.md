# Listing Optimizer

Paste an Amazon listing URL → get an optimized, compliance-verified set of
listing inputs (title, 75-char title, item highlights, 5 bullets, description,
backend search terms, full attribute set, A+ content, image plan, ~15 Q&A)
plus a gap audit against the current listing. Supplements first; the core is
category-agnostic via pluggable knowledge packs.

## Ingestion: legal / ToS note (read this)

This app **never operates its own Amazon scraper**. It ingests listings via:

- **Rainforest API** (default) — a third-party **scraped-data** API (Traject Data),
  **not affiliated with or licensed by Amazon**. Recommended default on
  reliability grounds; this does **not** reduce ToS exposure.
- **Firecrawl** — a general scraping vendor. Pointing it at Amazon PDPs carries
  the **same ToS / rate-limit exposure as scraping** (higher risk). Do not imply
  Firecrawl removes that exposure. Best-effort, non-default.
- **Paste fallback** — you paste the page source HTML or fill manual fields.
  Zero automated fetching; lowest exposure.

Current backend search terms are seller-private and are never ingested or
fabricated — the audit reports them as `unknown`.

## Setup

```bash
cp .env.example .env.local   # fill in keys (all server-side only)
npm install
npm run dev
```

Env vars: see `.env.example`. `INGEST_PROVIDER=rainforest|firecrawl|paste`.
`APP_ACCESS_TOKEN` protects the deployed API routes (recommended — runs spend
real LLM/provider credits).

## Test / build

```bash
npm test              # unit + golden E2E (deterministic, no keys needed)
npm run build
npm run check:secrets # grep client bundle for leaked API keys (run after build)
npm run verify        # build + check:secrets + all tests (CI uses this)
```

GitHub Actions runs `npm run verify` on every push/PR (see `.github/workflows/verify.yml`).

## Deploy (Vercel)

**Live app:** https://listing-optimizer-livid.vercel.app

1. Push this folder to GitHub (`listing-optimizer` is the app root).
2. Import the repo in [Vercel](https://vercel.com). Set **Root Directory** to `listing-optimizer` if the repo includes the builder kit parent folder.
3. Set environment variables from `.env.example` in the Vercel project settings (all server-side).
4. Set `APP_ACCESS_TOKEN` on production to prevent anonymous spend.
5. Deploy — API routes (`/api/ingest`, `/api/optimize`, `/api/audit`) run as serverless functions (`maxDuration: 300` in `vercel.json`).

## Adding a new category pack

The engine and verify gate are **category-agnostic**. Category-specific data lives only in knowledge packs:

1. Add compiled JSON under `knowledge/` (rules if needed, `compliance.<category>.json`, `attribute-schema.<category>.json`).
2. Extend `lib/knowledge/loadPack.ts` to assemble a new `KnowledgePack` id.
3. Extend `lib/knowledge/detectCategory.ts` to route snapshots to the new pack id.

No changes to `lib/engine/` or `lib/gate/` are required — they read limits, compliance terms, and schema from the active pack.

### Manual live smoke (after deploy)

1. Open the live URL, paste a supplement ASIN (or use **paste** mode with page HTML).
2. Confirm steps complete and all result tabs populate.
3. A `verified:false` outcome is acceptable — it must show blocking failures and lock export-final, not hide them.
