import { ingestByAsin } from '@/lib/ingest';
import { parseAsin } from '@/lib/ingest/parseAsin';
import { logServer } from '@/lib/server/log';
import type { CompetitorIngestion } from '@/lib/types';

/**
 * WS9 — COMPETITOR INGESTION, in ONE place.
 *
 * It lived inline in `app/api/optimize/route.ts`. N4 needs the identical
 * behaviour on `app/api/regenerate/route.ts`, and this repository has already
 * been bitten once by the alternative (CONFORMANCE-DEVIATIONS item 1: *two
 * collectors drift, and the one that drifts is the one that stops scanning a
 * surface*). Two ingesters would drift the same way, and the one that drifted
 * would be the one that stopped resolving a rival brand.
 *
 * It stays in `lib/ingest` rather than in the pipeline for the reason the
 * original comment gave: the ROUTE owns the provider, so the pipeline stays
 * injectable and deterministic for the golden E2E.
 */

/**
 * The operator may benchmark against at most this many competitors.
 *
 * The playbook's Phase 4 is 3-4 competitors (the leader, the closest spec
 * rival, one fast riser). The cap is also a spend control: each ASIN is a paid
 * provider call, and the field is free text on a public route.
 */
export const MAX_COMPETITORS = 4;

/**
 * Ingest the competitor ASINs, NEVER losing the run over one.
 *
 * Ingesting somebody else's listing fails routinely — blocked, rate-limited,
 * retired. Each failure becomes a `failed` ROW carrying its reason, which the
 * benchmark renders as failed and which the rival-brand resolver simply skips;
 * the caller itself is unaffected. Returns `undefined` — never `[]` — when the
 * operator supplied nothing, because absence and emptiness are different
 * statements and every downstream reader keys off the difference.
 */
export async function ingestCompetitors(
  input: unknown,
): Promise<CompetitorIngestion[] | undefined> {
  if (!Array.isArray(input)) return undefined;
  const asins = [
    ...new Set(
      input
        .map((v) => (typeof v === 'string' ? (parseAsin(v) ?? v.trim().toUpperCase()) : ''))
        .filter((v) => /^[A-Z0-9]{10}$/.test(v)),
    ),
  ].slice(0, MAX_COMPETITORS);
  if (asins.length === 0) return undefined;
  return Promise.all(
    asins.map(async (asin): Promise<CompetitorIngestion> => {
      try {
        return { asin, snapshot: await ingestByAsin(asin) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logServer('competitor.ingest_failed', { asin, message: message.slice(0, 200) });
        return { asin, error: message.slice(0, 200) };
      }
    }),
  );
}
