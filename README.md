# Listing Optimizer

Paste an Amazon listing URL → get an optimized, compliance-verified set of
listing inputs (title, 75-char title, item highlights, 5 bullets, description,
backend search terms, full attribute set, A+ content, image plan, ~15 Q&A)
plus a gap audit against the current listing. Supplements first; the core is
category-agnostic via pluggable knowledge packs.

## Ingestion: legal / ToS note (read this)

This app **never operates its own Amazon scraper**. It ingests listings via:

- **Rainforest API** (default) — a third-party **scraped-data** vendor
  (Traject Data, now part of ScraperAPI). It is **not affiliated with or
  licensed by Amazon**; using it outsources scraping infrastructure and its
  risk to the vendor, it does not remove Amazon ToS exposure. It is the
  default because it is the most reliable and Amazon-specialized option —
  a practical choice, not a legal safe harbor.
- **Firecrawl** — a general scraping vendor. Pointing it at Amazon PDPs
  carries the **same ToS / rate-limit exposure as scraping** and is
  frequently blocked. Best-effort, non-default.
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
```

## Deploy (Vercel)

1. Push this folder to GitHub.
2. Import the repo in [Vercel](https://vercel.com) (root directory = `listing-optimizer` if the repo contains the builder kit).
3. Set environment variables from `.env.example` in the Vercel project settings (all server-side).
4. Set `APP_ACCESS_TOKEN` on production to prevent anonymous spend.
5. Deploy — API routes run as serverless functions automatically.

## Adding a new category pack

The engine and verify gate are **category-agnostic**. Category-specific data lives only in knowledge packs:

1. Add compiled JSON under `knowledge/` (rules if needed, `compliance.<category>.json`, `attribute-schema.<category>.json`).
2. Extend `lib/knowledge/loadPack.ts` to assemble a new `KnowledgePack` id.
3. Extend `lib/knowledge/detectCategory.ts` to route snapshots to the new pack id.

No changes to `lib/engine/` or `lib/gate/` are required — they read limits, compliance terms, and schema from the active pack. The `generic` fallback pack demonstrates the seam: rules + principles only, no supplement compliance.
