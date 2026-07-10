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
import { logServer } from '@/lib/server/log';
import type { LlmClient } from './llm';
import { optimize, type GroupName } from './optimize';

/**
 * Bounded repair loop. Maps each failure to the prompt group that OWNS it and
 * regenerates ONLY the owning groups, feeding the Failure objects verbatim
 * into the regeneration prompt. NEVER edits content to force a pass — a
 * persistent failure is returned to the caller and surfaced in the UI.
 */

/**
 * Explicit ownership table: gate failure field → prompt group that owns repair.
 * PACK failures are intentionally absent — they are not repairable by regeneration.
 */
export const FIELD_TO_GROUP: ReadonlyArray<{ match: (field: string, checkId: string) => boolean; group: GroupName }> = [
  { match: (f) => f === 'title' || f === 'title75' || f === 'itemHighlights' || f === 'fdaDisclaimer', group: 'title' },
  { match: (f) => f.startsWith('bullets'), group: 'bullets' },
  { match: (f) => f === 'description', group: 'description' },
  { match: (f) => f === 'backendSearchTerms', group: 'backend' },
  { match: (f) => f.startsWith('attributes.') || f === 'compliance', group: 'attributes' },
  { match: (f) => f.startsWith('aplus') || f === 'aplusContent', group: 'aplus' },
  { match: (f) => f.startsWith('qa'), group: 'qa' },
];

export function fieldToGroup(failure: Failure): GroupName | null {
  if (failure.checkId === 'PACK') return null;
  const row = FIELD_TO_GROUP.find((r) => r.match(failure.field, failure.checkId));
  return row?.group ?? null;
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
    logServer('repair.pack_short_circuit', {
      failures: gateResult.failures.map((f) => f.checkId),
    });
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
    logServer('repair.round', {
      iteration: iterations,
      groups: [...groups],
      failureIds: gateResult.failures.map((f) => f.checkId),
    });
    listing = await optimize(snapshot, pack, llm, {
      groups: [...groups],
      base: listing,
      failureContext,
    });
    gateResult = runGate(listing, pack, ctx);
    if (gateResult.failures.some((f) => f.checkId === 'PACK')) break;
  }
  logServer('repair.done', {
    iterations,
    verified: gateResult.pass,
    failureIds: gateResult.failures.map((f) => f.checkId),
  });
  return { listing, gateResult, iterations };
}
