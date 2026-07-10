import 'server-only';

import type { ListingSnapshot, OptimizeResult } from '@/lib/types';
import type { LlmClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory, type CategoryDetection } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';

/**
 * Composable pipeline — ONE implementation shared by the API routes AND the
 * golden E2E test, so the deterministic test exercises exactly the code the
 * app runs. The LLM client is injected (routes pass the Anthropic client;
 * tests pass the recorded-fixture mock).
 */
export async function runPipeline(
  snapshot: ListingSnapshot,
  llm: LlmClient,
  maxRepairIterations: number,
): Promise<OptimizeResult & { iterations: number; detection: CategoryDetection }> {
  const detection = detectCategory(snapshot);
  const pack = loadPack(detection.packId);
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
  return { optimized, audit, iterations, detection };
}
