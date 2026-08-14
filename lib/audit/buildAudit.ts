import 'server-only';

import type {
  Audit,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { candidateTerms } from './candidateTerms';
import { diff } from './diff';
import { buildSubstantiationRegister } from './substantiation';
import { attributeSchemaStaleness, rulesStaleness } from './staleness';
import { scoreAgainstPrinciples } from './scoreAgainstPrinciples';

/**
 * The audit module — SEPARATE from the generator (worker ≠ checker holds
 * structurally). It RE-RUNS the gate itself on the proposed listing and sets
 * `verified` as exactly `gateResult.pass`. It never trusts a gate result
 * carried in from a client or from the engine.
 *
 * It also attaches the NON-BLOCKING rule-staleness signal (`rulesStale`), the
 * SUBSTANTIATION REGISTER (R33/R38 — operator sign-off) and the CANDIDATE-TERM
 * proposals (brain/02 — lexicon blind spots). All three are advisory and
 * deliberately excluded from `verified`: two of them are questions about the
 * seller's evidence and about the CHECKER, not about the copy.
 */
export function buildAudit(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Audit {
  const gateResult = runGate(proposed, pack, ctx);
  const scorecard = scoreAgainstPrinciples(current, pack);
  // R33/R38 — the substantiation register is built BEFORE the diff, because
  // the diff turns its unevidenced HEADER claims into a P1 gap.
  const substantiationRegister = buildSubstantiationRegister(proposed, current, pack.compliancePack);
  const gaps = diff(current, proposed, pack, substantiationRegister);
  // Advisory only: staleness never enters `verified` and never becomes a failure.
  const staleness = rulesStaleness(pack.rules);
  // Second, INDEPENDENT advisory snapshot: the attribute template has its own
  // verification date and its own horizon (see `attributeSchemaStaleness`).
  const schemaStaleness = attributeSchemaStaleness(pack.attributeSchemaMeta);
  // PACK-INTEGRITY is derived from the gate result, so it can never disagree
  // with `verified`: a missing/empty required pack piece raises a blocking
  // PACK failure, which makes `gateResult.pass` (and therefore `verified`)
  // false AND shows up here, named, in the audit payload.
  const packProblems = gateResult.failures
    .filter((f) => f.checkId === 'PACK')
    .map((f) => f.context);
  return {
    scorecard,
    gaps,
    gateResult,
    verified: gateResult.pass,
    packIntegrity: { ok: packProblems.length === 0, problems: packProblems },
    substantiationRegister,
    // brain/02 — ADVISORY proposals for the LEXICON owner, never about the copy.
    candidateTerms: candidateTerms(current, pack),
    rulesStale: staleness.stale,
    ...(staleness.notice ? { rulesStaleNotice: staleness.notice } : {}),
    attributeSchemaStale: schemaStaleness.stale,
    ...(schemaStaleness.notice ? { attributeSchemaStaleNotice: schemaStaleness.notice } : {}),
  };
}
