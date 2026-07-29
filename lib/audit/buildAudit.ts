import 'server-only';

import type {
  Audit,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { diff } from './diff';
import { rulesStaleness } from './staleness';
import { scoreAgainstPrinciples } from './scoreAgainstPrinciples';

/**
 * The audit module — SEPARATE from the generator (worker ≠ checker holds
 * structurally). It RE-RUNS the gate itself on the proposed listing and sets
 * `verified` as exactly `gateResult.pass`. It never trusts a gate result
 * carried in from a client or from the engine.
 *
 * It also attaches the NON-BLOCKING rule-staleness signal (`rulesStale`),
 * which is advisory and deliberately excluded from `verified`.
 */
export function buildAudit(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Audit {
  const gateResult = runGate(proposed, pack, ctx);
  const scorecard = scoreAgainstPrinciples(current, pack);
  const gaps = diff(current, proposed, pack, ctx.subcategories);
  // Advisory only: staleness never enters `verified` and never becomes a failure.
  const staleness = rulesStaleness(pack.rules);
  return {
    scorecard,
    gaps,
    gateResult,
    verified: gateResult.pass,
    rulesStale: staleness.stale,
    ...(staleness.notice ? { rulesStaleNotice: staleness.notice } : {}),
  };
}
