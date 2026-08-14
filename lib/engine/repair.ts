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
import { optimize, pinProductName, type GroupName, type OptimizeOptions } from './optimize';

/**
 * Bounded repair loop. Maps each failure to the prompt group that OWNS it and
 * regenerates ONLY the owning groups, feeding the Failure objects verbatim
 * into the regeneration prompt. NEVER edits content to force a pass — a
 * persistent failure is returned to the caller and surfaced in the UI.
 */

/**
 * Explicit ownership table: gate failure field → prompt group that owns repair.
 * PACK failures are intentionally absent — they are not repairable by regeneration.
 * The disclaimer field is absent too: it is CODE-inserted verbatim, never
 * LLM-owned, so regenerating the title group could not repair it.
 */
export const FIELD_TO_GROUP: ReadonlyArray<{ match: (field: string, checkId: string) => boolean; group: GroupName }> = [
  { match: (f) => f === 'title' || f === 'title75' || f === 'itemHighlights' || f === 'productName' || f === 'primaryKeyword', group: 'title' },
  { match: (f) => f.startsWith('bullets'), group: 'bullets' },
  { match: (f) => f === 'description', group: 'description' },
  { match: (f) => f === 'backendSearchTerms', group: 'backend' },
  { match: (f) => f === 'attributes' || f.startsWith('attributes.'), group: 'attributes' },
  // `facts.*` is now a scanned surface (C6). The facts block is produced
  // deterministically from the snapshot alongside the attribute group, so the
  // attributes group owns any repair round a facts failure triggers.
  { match: (f) => f === 'facts' || f.startsWith('facts.'), group: 'attributes' },
  { match: (f) => f.startsWith('aplus') || f === 'aplusContent', group: 'aplus' },
  { match: (f) => f.startsWith('imagePlan'), group: 'images' },
  { match: (f) => f.startsWith('qa'), group: 'qa' },
  // WS3 — C28 reports against `keywords[i]`; the keyword group owns the repair.
  { match: (f) => f === 'keywords' || f.startsWith('keywords['), group: 'keywords' },
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
  /** WS9 — per-run operator context, carried into EVERY regeneration round. */
  operator?: OptimizeOptions['operator'],
): Promise<RepairOutcome> {
  let listing = initial ?? (await optimize(snapshot, pack, llm, { operator }));
  let gateResult = runGate(listing, pack, ctx);
  let iterations = 0;
  // The FIRST pass chooses the canonical product name; every later round reuses
  // it. `productName` is an identifier that C8/C15 (title surfaces) and A4 (A+
  // modules) all cross-reference, so letting a title-only repair round rename
  // the product invalidates copy written in an earlier round and the loop
  // oscillates. `optimize` already pins against its `base`; re-asserting the
  // loop's own canonical value here keeps the invariant true even if a group
  // ever regenerates without one. It changes NO other generated copy, and the
  // gate below still validates every surface independently.
  const canonicalProductName = listing.productName;

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
      if (!g) {
        // Nothing regenerable owns this failure — say so instead of dropping it
        // silently, so an unmapped field surfaces in the logs.
        logServer('repair.unowned_failure', {
          checkId: failure.checkId,
          field: failure.field,
        });
        continue;
      }
      groups.add(g);
      const line = `[${failure.checkId}] ${failure.field}: ${failure.context} → FIX: ${failure.fix}`;
      failureContext[g] = failureContext[g] ? `${failureContext[g]}\n${line}` : line;
    }
    // WS3 — COUPLING, stated explicitly rather than left to a second round.
    // The keyword reference DECLARES where each term sits, so the moment any
    // copy group is rewritten every declaration about it is stale. Regenerating
    // the copy without re-reading it would make C28 fail on the NEXT round for
    // a reason the current round already created, burning an iteration on a
    // self-inflicted failure. The reference is re-read in the same round.
    if (groups.size > 0 && [...groups].some((g) => g !== 'keywords')) {
      groups.add('keywords');
    }
    if (groups.size === 0) {
      // Nothing regenerable owns ANY of the remaining failures. That is a
      // legitimate terminal state (a PACK failure has no owning generator),
      // but it used to exit the loop silently — so the run looked like it had
      // simply converged. Say so.
      logServer('repair.no_owner_exit', {
        iteration: iterations,
        failures: gateResult.failures.map((f) => `${f.checkId}:${f.field}`),
      });
      break;
    }
    logServer('repair.round', {
      iteration: iterations,
      groups: [...groups],
      failureIds: gateResult.failures.map((f) => f.checkId),
    });
    listing = pinProductName(
      await optimize(snapshot, pack, llm, {
        groups: [...groups],
        base: listing,
        failureContext,
        operator,
      }),
      canonicalProductName,
    );
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
