import { NextResponse } from 'next/server';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize, type GroupName, ALL_GROUPS } from '@/lib/engine/optimize';
import {
  anthropicClient,
  describeError,
  generationFailurePayload,
  recordUpstreamFailures,
} from '@/lib/engine/llm';
import { ingestCompetitors } from '@/lib/ingest/competitors';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
import { normalizePanelFacts } from '@/lib/knowledge/panelFacts';
import { mineReviewLanguage } from '@/lib/knowledge/reviewLanguage';
import { checkAccess } from '@/lib/server/guard';
import { logServer } from '@/lib/server/log';
import { updateRun } from '@/lib/store/runs';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

export const maxDuration = 300;

const GROUP_SET = new Set<string>(ALL_GROUPS);

/**
 * Regenerate ONE engine group over an existing listing, re-run buildAudit
 * (worker ≠ checker), optionally persist back to a saved run.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  let body: {
    snapshot?: ListingSnapshot;
    listing?: OptimizedListing;
    group?: string;
    runId?: string;
    /** R45 — per-run operator known-false descriptors (C11). Never persisted. */
    fictionPhrases?: string[];
    /** WS5.5 — operator-confirmed label values; product truth for this run. */
    panelFacts?: Record<string, string>;
    /**
     * WS9 — the raw review text the operator pasted for the ORIGINAL run.
     *
     * It is the third per-run operator input and it was the only one this route
     * dropped: `fictionPhrases` and `panelFacts` were carried and this was not,
     * so regenerating one group silently rebuilt that group's copy WITHOUT the
     * buyer-language mirroring every other group had been written with — the
     * one group in the listing that no longer spoke the way the operator's
     * buyers do, with nothing anywhere saying so. Threaded exactly as the other
     * two are: mined here, given to the prompts, and given to the audit so P11
     * is scored against the same evidence. Absent => byte-identical.
     */
    reviewsText?: string;
    /**
     * N4 — THE COMPETITOR ASINS, and why this route now takes them.
     *
     * They used to be left out deliberately, and the reason recorded was that
     * "they feed the BENCHMARK, a measurement of pages a single-group
     * regeneration does not re-ingest, and their absence changes no copy."
     *
     * That reason was true when it was written and is no longer true. WS9→R50
     * (CONFORMANCE-DEVIATIONS item 7) gave the competitor set a SECOND job: it
     * is resolved by `rivalBrandNames` inside `buildAudit` into the AUTOMATIC
     * RIVAL-BRAND NEGATIVE SET that C28 enforces — and C28 is a blocking check,
     * so that set feeds `verified` directly.
     *
     * THE CONCRETE SCENARIO. The operator supplies competitors; the original
     * run is graded with the rival brands armed. They then regenerate one group
     * — which is written FROM SCRATCH by the model, i.e. exactly the moment a
     * rival brand can enter — and, without this field, that regeneration is
     * graded with the automatic set EMPTY. A rival brand the original run's gate
     * would have caught now ships `verified: true`, and the route PERSISTS that
     * verdict over the stored run. Regeneration silently became the weakest
     * grader in the app.
     *
     * "Their absence changes no copy" was also only half the story: because the
     * route re-runs `buildAudit` and persists its result, a regeneration without
     * competitors also DELETED `audit.benchmark` from the stored run.
     *
     * Ingested by the same `ingestCompetitors` the optimize route uses (one
     * implementation, so the two cannot drift), and absent => byte-identical to
     * the behaviour before this existed.
     */
    competitorAsins?: string[];
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title || !body.listing?.title) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', message: 'Missing snapshot or listing.' },
      { status: 400 },
    );
  }
  if (!body.group || !GROUP_SET.has(body.group)) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        message: `group must be one of: ${ALL_GROUPS.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const group = body.group as GroupName;
  try {
    const detection = detectCategory(body.snapshot);
    // R45: the same per-run operator input the optimize/audit routes accept —
    // a regeneration must not be a way to escape the phrases the operator set.
    const pack = withOperatorFictionPhrases(loadPack(detection.packId), body.fictionPhrases);
    const enriched: ListingSnapshot = {
      ...body.snapshot,
      subcategory: detection.subcategories,
    };
    const ctx = {
      subcategories: detection.subcategories,
      snapshotText: `${body.snapshot.title} ${body.snapshot.category}`,
    };
    // WS5.5 — the same per-run panel the optimize/audit routes accept. A
    // regeneration must not be a way to fall back to the scraped facts after
    // the operator has confirmed the label.
    const panelFacts = normalizePanelFacts(body.panelFacts);
    // WS9 — mined through the gate's OWN compliance lexicons, exactly as the
    // pipeline mines it, so a symptom word a reviewer lawfully wrote can never
    // become a line of our copy. `usedReviews` distinguishes "the operator
    // pasted nothing" from "the operator pasted text that mined to nothing":
    // an ABSENT input must leave P11 `unknown` rather than score it zero.
    const mined = mineReviewLanguage(pack, body.reviewsText);
    const usedReviews = typeof body.reviewsText === 'string' && body.reviewsText.trim() !== '';
    // N4 — re-ingest the operator's competitors so the AUTOMATIC RIVAL-BRAND
    // NEGATIVE SET (item 7) is armed for this grading exactly as it was for the
    // original run. It is resolved inside `buildAudit`, from these snapshots, by
    // the same `rivalBrandNames` with the same four bounds — so nothing here is
    // trusted that was not trusted before: every string still comes from a page
    // the operator asked for, at run time.
    //
    // COST, stated: up to `MAX_COMPETITORS` provider calls, in parallel, on an
    // explicit operator action. That is the price of grading a regenerated group
    // as strictly as the run it replaces, and a regeneration graded more weakly
    // than the original is the defect this closes. Ingestion never throws — a
    // failed ASIN becomes a `failed` row and simply contributes no brand, which
    // is precisely what it does on the optimize route.
    const competitors = await ingestCompetitors(body.competitorAsins);
    if (competitors) {
      logServer('regenerate.competitors', {
        requested: competitors.length,
        ingested: competitors.filter((c) => c.snapshot).length,
      });
    }
    // Same observability-only wrapper the optimize route uses: it records the
    // first transport/API failure and rethrows unchanged, so the degrade path
    // and `verified` are untouched. A regeneration that comes back degraded is
    // exactly as opaque as a full run was, and gets exactly the same answer.
    const generation = recordUpstreamFailures(anthropicClient());
    const merged = await optimize(enriched, pack, generation.llm, {
      groups: [group],
      base: body.listing,
      panelFacts,
      ...(usedReviews ? { operator: { buyerPhrases: mined.phrases } } : {}),
    });
    const audit = buildAudit(enriched, merged, pack, ctx, {
      ...(panelFacts ? { panelFacts } : {}),
      ...(usedReviews ? { reviewTokens: mined.tokens, reviewRejected: mined.rejected } : {}),
      // N4 — same key, same resolver, same bounds as the optimize path.
      ...(competitors ? { competitors } : {}),
    });
    const optimized: OptimizedListing = {
      ...merged,
      state: audit.verified ? 'verified' : 'draft',
    };

    if (body.runId) {
      try {
        await updateRun(body.runId, {
          optimized,
          audit,
          verified: audit.verified,
          score: audit.scorecard.total,
          gaps: audit.gaps.length,
          failureIds: audit.gateResult.failures.map((f) => f.checkId),
          productName: optimized.productName,
        });
      } catch (e) {
        logServer('store.error', {
          op: 'updateRun',
          message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      }
    }

    // Absent unless an upstream call failed — see the optimize route for why
    // the redacted `message` stays in the log rather than travelling here.
    const generationFailure = generationFailurePayload(generation.firstFailure());

    return NextResponse.json({
      optimized,
      audit,
      detection,
      gateResult: audit.gateResult,
      group,
      ...(generationFailure ? { generationFailure } : {}),
    });
  } catch (e) {
    // Redacted for the same reason as the optimize route: an SDK error message
    // can echo request context and this one is returned to a browser.
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: describeError(e).message ?? 'Regenerate failed.' },
      { status: 502 },
    );
  }
}
