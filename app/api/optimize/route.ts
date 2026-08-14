import { NextResponse } from 'next/server';
import { anthropicClient } from '@/lib/engine/llm';
import { ingestByAsin } from '@/lib/ingest';
import { parseAsin } from '@/lib/ingest/parseAsin';
import { runPipeline } from '@/lib/pipeline/run';
import { checkAccess } from '@/lib/server/guard';
import { logServer } from '@/lib/server/log';
import { saveRun } from '@/lib/store/runs';
import { env } from '@/lib/env';
import type { CompetitorIngestion, ListingSnapshot } from '@/lib/types';

/**
 * WS9 — the operator may benchmark against at most this many competitors.
 *
 * The playbook's Phase 4 is 3-4 competitors (the leader, the closest spec
 * rival, one fast riser). The cap is also a spend control: each ASIN is a
 * paid provider call, and the field is free text on a public route.
 */
const MAX_COMPETITORS = 4;

/**
 * Ingest the competitor ASINs, NEVER losing the run over one.
 *
 * Ingesting somebody else's listing fails routinely — blocked, rate-limited,
 * retired. Each failure becomes a `failed` ROW carrying its reason, which the
 * benchmark renders as failed; the optimize call itself is unaffected. This is
 * why the ingestion lives here in the route rather than inside the pipeline:
 * the route owns the provider, and the pipeline stays injectable and
 * deterministic for the golden test.
 */
async function ingestCompetitors(input: unknown): Promise<CompetitorIngestion[] | undefined> {
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

export const maxDuration = 300;

/**
 * Full pipeline stage: snapshot -> optimize -> bounded repair loop -> audit.
 * Delegates to the ONE shared `runPipeline` (the exact code path the golden
 * E2E exercises), so the route and the deterministic test can never drift.
 * Returns { optimized, audit, detection, iterations, gateResult, runId? }.
 * `audit.verified` is derived server-side by the audit module re-running the
 * gate (worker != checker); a client-carried gate result is never trusted.
 * Persistence failures never break the optimize response.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  let body: {
    snapshot?: ListingSnapshot;
    fictionPhrases?: string[];
    reviewsText?: string;
    competitorAsins?: string[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing snapshot.' }, { status: 400 });
  }
  try {
    // WS9 — competitor ingestion runs BEFORE generation and can never fail the
    // request: a rejected ASIN becomes a failed benchmark row.
    const competitors = await ingestCompetitors(body.competitorAsins);

    const { optimized, audit, detection, iterations } = await runPipeline(
      body.snapshot,
      anthropicClient(),
      env.maxRepairIterations(),
      {
        // R45: per-run operator input, merged into the pack's C11 list for this
        // run only and never persisted (lib/knowledge/operatorInputs.ts).
        fictionPhrases: body.fictionPhrases,
        // WS9: mined for compliant PHRASING, never used verbatim.
        reviewsText: typeof body.reviewsText === 'string' ? body.reviewsText : undefined,
        ...(competitors ? { competitors } : {}),
      },
    );

    let runId: string | null = null;
    try {
      runId = await saveRun({
        asin: body.snapshot.asin,
        url: body.snapshot.url,
        productName: optimized.productName,
        packId: detection.packId,
        verified: audit.verified,
        score: audit.scorecard.total,
        gaps: audit.gaps.length,
        failureIds: audit.gateResult.failures.map((f) => f.checkId),
        snapshot: body.snapshot,
        optimized,
        audit,
      });
    } catch (e) {
      logServer('store.error', {
        op: 'saveRun',
        message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      });
    }

    return NextResponse.json({
      optimized,
      audit,
      detection,
      iterations,
      gateResult: audit.gateResult,
      runId,
    });
  } catch (e) {
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : 'Generation failed.' },
      { status: 502 },
    );
  }
}
