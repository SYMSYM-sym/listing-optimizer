import 'server-only';

import type { CompetitorIngestion, ListingSnapshot, OptimizeResult } from '@/lib/types';
import type { LlmClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory, type CategoryDetection } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
import { mineReviewLanguage } from '@/lib/knowledge/reviewLanguage';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
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
  /**
   * WS5.5 — the Supplement-Facts-panel values the operator read off the label
   * and CONFIRMED. Product truth for this run: they overlay the scraped
   * attributes before the canonical facts are derived, they are announced to
   * the generator as authoritative, and the audit re-derives the facts block
   * from them so the gate measures every surface against the operator's
   * numbers. Never persisted to the pack. Absent => byte-identical behaviour.
   * See `lib/knowledge/panelFacts.ts`.
   */
  panelFacts?: Readonly<Record<string, string>>;
  /**
   * D5 — the absolute epoch-ms mark by which this run must be finished, when
   * the caller is running under one (the API routes are: the platform kills
   * the function at `maxDuration` and a killed function is a 502 that loses
   * the entire run). The repair loop stops starting rounds it cannot finish
   * and returns what it has, UNVERIFIED. Absent => no time limit, which is
   * what the deterministic tests use.
   */
  deadline?: number;
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
  // WS9 → R50 — the automatic rival-brand negatives are given to the REPAIR
  // LOOP as well as to the audit. The audit resolves its own set and owns
  // `verified` (see `buildAudit`); this copy exists so the loop's gate sees the
  // same failure the final audit will, and therefore gets rounds in which to
  // clear it. Without it a run that mentioned a supplied competitor's brand
  // would repair against a gate that could not see the problem and then be
  // failed by one that could — an unwinnable loop, which is the shape of defect
  // the own-brand reclassification was written to end.
  //
  // It is derived here from the SNAPSHOT and the operator's competitors, both
  // of which are fixed for the run; the per-round listing only ever changes the
  // `productName` corroboration, which is pinned after round one.
  const rivalBrands = rivalBrandNames(opts.competitors, undefined, enriched);
  const { listing, iterations } = await runRepairLoop(
    enriched,
    pack,
    llm,
    rivalBrands.length > 0 ? { ...ctx, rivalBrands } : ctx,
    maxRepairIterations,
    undefined,
    usedReviews ? { buyerPhrases: mined.phrases } : undefined,
    opts.panelFacts,
    opts.deadline,
  );
  // Worker ≠ checker: the audit module independently re-runs the gate and
  // owns `verified` (=== gateResult.pass).
  const audit = buildAudit(enriched, listing, pack, ctx, {
    // Only supplied when the operator actually pasted review text: an absent
    // input must leave P11 `unknown`, not score it zero.
    ...(usedReviews ? { reviewTokens: mined.tokens, reviewRejected: mined.rejected } : {}),
    ...(opts.competitors ? { competitors: opts.competitors } : {}),
    ...(opts.panelFacts ? { panelFacts: opts.panelFacts } : {}),
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
    // Shape only — the operator's confirmed VALUES never reach the log
    // (lib/server/log.ts contract), only how many were supplied.
    panelFactsConfirmed: opts.panelFacts ? Object.keys(opts.panelFacts).length : 0,
  });
  return { optimized, audit, iterations, detection };
}
