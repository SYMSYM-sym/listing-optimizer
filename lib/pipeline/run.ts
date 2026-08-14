import 'server-only';

import type { ListingSnapshot, OptimizeResult } from '@/lib/types';
import type { LlmClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory, type CategoryDetection } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
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
  const { listing, iterations } = await runRepairLoop(
    enriched,
    pack,
    llm,
    ctx,
    maxRepairIterations,
  );
  // Worker ≠ checker: the audit module independently re-runs the gate and
  // owns `verified` (=== gateResult.pass).
  const audit = buildAudit(enriched, listing, pack, ctx);
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
  });
  return { optimized, audit, iterations, detection };
}
