import 'server-only';

import type { CompetitorIngestion, ListingSnapshot, OptimizeResult } from '@/lib/types';
import type { LlmClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory, type CategoryDetection } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
import { mineReviewLanguage } from '@/lib/knowledge/reviewLanguage';
import { logServer } from '@/lib/server/log';

/**
 * Composable pipeline — ONE implementation shared by the API routes AND the
 * golden E2E test, so the deterministic test exercises exactly the code the
 * app runs. The LLM client is injected (routes pass the Anthropic client;
 * tests pass the recorded-fixture mock).
 */
export interface PipelineOptions {
  /**
   * R45 — operator-supplied known-false descriptors for THIS run only (C11).
   * Merged over the pack's own list; never persisted. See
   * `lib/knowledge/operatorInputs.ts`.
   */
  fictionPhrases?: string[];
  /**
   * WS9 — raw review text pasted by the operator. It is MINED for compliant
   * phrasing (`lib/knowledge/reviewLanguage.ts`) and never used verbatim: the
   * filter is the gate's own compliance lexicons, so a symptom word a reviewer
   * lawfully wrote can never become a line of our copy. Absent => the prompts
   * and the scorecard are byte-for-byte what they were.
   */
  reviewsText?: string;
  /**
   * WS9 — competitor ASINs, already ingested by the caller (the route owns the
   * provider). A failed entry carries its reason and is rendered as failed:
   * ingesting somebody else's listing fails routinely and must never lose the
   * run.
   */
  competitors?: CompetitorIngestion[];
}

export async function runPipeline(
  snapshot: ListingSnapshot,
  llm: LlmClient,
  maxRepairIterations: number,
  opts: PipelineOptions = {},
): Promise<OptimizeResult & { iterations: number; detection: CategoryDetection }> {
  const detection = detectCategory(snapshot);
  // The operator's per-run fiction phrases are merged into a CLONE of the pack:
  // the generator is told about them (the prompt renders the pack list) and C11
  // enforces them, and the shipped pack data is untouched for the next run.
  const pack = withOperatorFictionPhrases(loadPack(detection.packId), opts.fictionPhrases);
  const ctx = {
    subcategories: detection.subcategories,
    snapshotText: `${snapshot.title} ${snapshot.category}`,
  };
  const enriched: ListingSnapshot = { ...snapshot, subcategory: detection.subcategories };
  // WS9 — mine the operator's review text ONCE, before generation, so the same
  // compliant phrasing reaches the prompts and the P11 judge.
  const mined = mineReviewLanguage(pack, opts.reviewsText);
  const usedReviews = typeof opts.reviewsText === 'string' && opts.reviewsText.trim() !== '';
  const { listing, iterations } = await runRepairLoop(
    enriched,
    pack,
    llm,
    ctx,
    maxRepairIterations,
    undefined,
    usedReviews ? { buyerPhrases: mined.phrases } : undefined,
  );
  // Worker ≠ checker: the audit module independently re-runs the gate and
  // owns `verified` (=== gateResult.pass).
  const audit = buildAudit(enriched, listing, pack, ctx, {
    // Only supplied when the operator actually pasted review text: an absent
    // input must leave P11 `unknown`, not score it zero.
    ...(usedReviews ? { reviewTokens: mined.tokens, reviewRejected: mined.rejected } : {}),
    ...(opts.competitors ? { competitors: opts.competitors } : {}),
  });
  const optimized = {
    ...listing,
    state: audit.verified ? ('verified' as const) : ('draft' as const),
  };
  logServer('pipeline.done', {
    packId: detection.packId,
    iterations,
    verified: audit.verified,
    score: audit.scorecard.total,
    gaps: audit.gaps.length,
    failureIds: audit.gateResult.failures.map((f) => f.checkId),
    // Shape only, never the operator's text (lib/server/log.ts contract).
    reviewPhrases: usedReviews ? mined.phrases.length : 0,
    reviewRejected: usedReviews ? mined.rejected.length : 0,
    competitorsRequested: opts.competitors?.length ?? 0,
    competitorsIngested: audit.benchmark?.ingested ?? 0,
  });
  return { optimized, audit, iterations, detection };
}
