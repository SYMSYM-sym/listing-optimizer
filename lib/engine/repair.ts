import 'server-only';
import type {
  Failure,
  GateResult,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import type { LlmClient } from './llm';
import { optimize, type GroupName } from './optimize';

/**
 * Bounded repair loop. Maps each failure to the prompt group that OWNS it and
 * regenerates ONLY the owning groups, feeding the Failure objects verbatim
 * into the regeneration prompt. NEVER edits content to force a pass — a
 * persistent failure is returned to the caller and surfaced in the UI.
 */

export function fieldToGroup(failure: Failure): GroupName | null {
  const f = failure.field;
  if (failure.checkId === 'PACK') return null; // unrepairable by regeneration
  if (f === 'title' || f === 'title75' || f === 'itemHighlights' || f === 'fdaDisclaimer') return 'title';
  if (f.startsWith('bullets')) return 'bullets';
  if (f === 'description') return 'description';
  if (f === 'backendSearchTerms') return 'backend';
  if (f.startsWith('attributes.') || f === 'compliance') return 'attributes';
  if (f.startsWith('aplus')) return 'aplus';
  if (f.startsWith('qa')) return 'qa';
  // C12 conflicts: the failing SURFACE owns the repair, never facts.
  return null;
}

export interface RepairOutcome {
  listing: OptimizedListing;
  gateResult: GateResult;
  iterations: number;
}

export async function runRepairLoop(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  llm: LlmClient,
  ctx: GateContext,
  maxIterations: number,
  initial?: OptimizedListing,
): Promise<RepairOutcome> {
  let listing = initial ?? (await optimize(snapshot, pack, llm));
  let gateResult = runGate(listing, pack, ctx);
  let iterations = 0;

  // PACK fail-closed short-circuit: regeneration cannot repair a pack gap —
  // surface it immediately without burning LLM rounds.
  if (gateResult.failures.some((f) => f.checkId === 'PACK')) {
    return { listing, gateResult, iterations };
  }

  while (!gateResult.pass && iterations < maxIterations) {
    iterations++;
    const groups = new Set<GroupName>();
    const failureContext: Partial<Record<GroupName, string>> = {};
    for (const failure of gateResult.failures) {
      const g = fieldToGroup(failure);
      if (!g) continue;
      groups.add(g);
      const line = `[${failure.checkId}] ${failure.field}: ${failure.context} → FIX: ${failure.fix}`;
      failureContext[g] = failureContext[g] ? `${failureContext[g]}\n${line}` : line;
    }
    if (groups.size === 0) break; // nothing regenerable owns the failures
    listing = await optimize(snapshot, pack, llm, {
      groups: [...groups],
      base: listing,
      failureContext,
    });
    gateResult = runGate(listing, pack, ctx);
    if (gateResult.failures.some((f) => f.checkId === 'PACK')) break;
  }
  return { listing, gateResult, iterations };
}
