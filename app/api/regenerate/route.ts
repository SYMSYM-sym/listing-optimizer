import { NextResponse } from 'next/server';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize, type GroupName, ALL_GROUPS } from '@/lib/engine/optimize';
import { anthropicClient } from '@/lib/engine/llm';
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
    const merged = await optimize(enriched, pack, anthropicClient(), {
      groups: [group],
      base: body.listing,
      panelFacts,
      ...(usedReviews ? { operator: { buyerPhrases: mined.phrases } } : {}),
    });
    const audit = buildAudit(enriched, merged, pack, ctx, {
      ...(panelFacts ? { panelFacts } : {}),
      ...(usedReviews ? { reviewTokens: mined.tokens, reviewRejected: mined.rejected } : {}),
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

    return NextResponse.json({
      optimized,
      audit,
      detection,
      gateResult: audit.gateResult,
      group,
    });
  } catch (e) {
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : 'Regenerate failed.' },
      { status: 502 },
    );
  }
}
