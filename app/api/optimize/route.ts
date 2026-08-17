import { NextResponse } from 'next/server';
import {
  anthropicClient,
  describeError,
  recordedGenerationFailure,
  recordUpstreamFailures,
  withTransientRetry,
} from '@/lib/engine/llm';
import { ALL_GROUPS } from '@/lib/engine/optimize';
import { ingestCompetitors } from '@/lib/ingest/competitors';
import { normalizePanelFacts } from '@/lib/knowledge/panelFacts';
import { runPipeline } from '@/lib/pipeline/run';
import { checkAccess } from '@/lib/server/guard';
import { logServer } from '@/lib/server/log';
import { saveRun } from '@/lib/store/runs';
import { env } from '@/lib/env';
import type { ListingSnapshot } from '@/lib/types';

/**
 * WS9 — competitor ingestion moved to `lib/ingest/competitors.ts` (N4) so the
 * regenerate route can run the IDENTICAL code rather than a second copy of it.
 * The cap and the never-lose-the-run behaviour are unchanged; see that module.
 */

export const maxDuration = 300;

/**
 * D5 — the share of `maxDuration` the pipeline may spend before it must stop
 * starting repair rounds.
 *
 * The platform kills the function at `maxDuration` and a killed function
 * answers 502, which loses the whole run: every generated surface and every
 * gate finding. The reserve pays for what happens AFTER the last round — the
 * audit, the persist, and serializing a large payload — and for a round that
 * runs longer than the longest one measured so far. Stopping early returns a
 * complete, honest `verified:false` report; being killed returns nothing.
 */
const RUN_BUDGET_FRACTION = 0.8;

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
    /** WS5.5 — operator-confirmed label values; product truth for this run. */
    panelFacts?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing snapshot.' }, { status: 400 });
  }
  const startedAt = Date.now();
  // D5 — ONE deadline for the run, read by everything that can spend time:
  // the repair loop (which will not start a round it cannot finish) and the
  // transient-retry layer (which will not take a retry that would land past
  // it). Computed once here so the two can never disagree.
  const deadline = startedAt + maxDuration * 1000 * RUN_BUDGET_FRACTION;
  try {
    // WS9 — competitor ingestion runs BEFORE generation and can never fail the
    // request: a rejected ASIN becomes a failed benchmark row.
    const competitors = await ingestCompetitors(body.competitorAsins);

    // OBSERVABILITY ONLY. The wrapper records the first transport/API failure of
    // the run and rethrows it unchanged, so degrade routing, gate `GEN` and
    // `verified` behave exactly as they did without it. It exists so that an
    // operator looking at a fully-degraded run is TOLD the upstream API
    // rejected the request, instead of being handed nine gate failures and left
    // to infer the cause from a log line that is not there.
    //
    // U2 — the retry layer sits INSIDE the recorder, and that order is the
    // whole point: the recorder must only ever see a failure that actually
    // escaped. Inside-out would record a 429 that was then successfully
    // retried, and the response would carry `generationFailure` — and so the
    // operator would get U1's "generation failed upstream" banner on a run
    // that completed perfectly.
    const generation = recordUpstreamFailures(
      withTransientRetry(anthropicClient(), { deadline }),
    );

    const { optimized, audit, detection, iterations } = await runPipeline(
      body.snapshot,
      generation.llm,
      env.maxRepairIterations(),
      {
        // R45: per-run operator input, merged into the pack's C11 list for this
        // run only and never persisted (lib/knowledge/operatorInputs.ts).
        fictionPhrases: body.fictionPhrases,
        // WS9: mined for compliant PHRASING, never used verbatim.
        reviewsText: typeof body.reviewsText === 'string' ? body.reviewsText : undefined,
        // WS5.5 — normalized here and never persisted to the pack.
        panelFacts: normalizePanelFacts(body.panelFacts),
        // D5 — measured from the moment the request arrived, so the ingestion
        // above is spent out of the same budget the repair loop is checking.
        deadline,
        ...(competitors ? { competitors } : {}),
      },
    );

    // Present ONLY when an upstream call actually failed AND cost this run a
    // group, so a healthy response is byte-for-byte the object it was.
    // `message` is deliberately NOT included: a response body is held to a
    // stricter standard than a server log, and the summary plus the
    // status/type/request id are everything an operator can act on. The
    // redacted message stays in the `llm.error` line.
    //
    // U3 — computed BEFORE the save, because the run record now carries it too.
    // The live response and the stored row therefore get the SAME value from
    // the SAME builder, which is what makes re-opening this run from History
    // show the same banner instead of eleven unexplained gate failures.
    //
    // V1 — and it is now CROSS-CHECKED against what actually degraded. This
    // line used to attach `generation.firstFailure()` unconditionally, and a
    // failure the group RECOVERED from — a one-shot blip that the reparse call
    // answered — was still latched, so a run that came back `verified:true`
    // with zero degraded groups could carry the notice, render U1's banner and
    // be persisted amber forever. On a run with GENUINE compliance failures the
    // banner then told the operator those failures were not a judgement of
    // their listing, which is the exact conditioning hazard U1 exists to
    // prevent. `recordedGenerationFailure` intersects the unrecovered call
    // failures with `optimized.degradedGroups` — the same list `GEN` and
    // therefore `verified` are computed from — and the notice can claim
    // nothing outside it.
    const generationFailure = recordedGenerationFailure(
      generation,
      optimized.degradedGroups,
      ALL_GROUPS.length,
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
        // Omitted on a healthy run — see `SaveRunInput.generationFailure`.
        ...(generationFailure ? { generationFailure } : {}),
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
      ...(generationFailure ? { generationFailure } : {}),
    });
  } catch (e) {
    // Redacted: this message is built from a thrown error that may be an SDK
    // error echoing request context, and it is returned to a browser.
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: describeError(e).message ?? 'Generation failed.' },
      { status: 502 },
    );
  }
}
