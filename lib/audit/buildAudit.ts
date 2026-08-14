import 'server-only';

import type {
  Audit,
  CompetitorIngestion,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { candidateTerms } from './candidateTerms';
import { buildBenchmark } from './benchmark';
import { diff } from './diff';
import { keywordCoverage } from './keywordCoverage';
import { buildSubstantiationRegister } from './substantiation';
import { attributeSchemaStaleness, rulesStaleness } from './staleness';
import { proposedAsSnapshot } from './proposedSnapshot';
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
/**
 * WS9 — per-run operator inputs that reach the AUDIT (as opposed to the
 * prompts). Every field is optional and every one of them defaults to the
 * behaviour that existed before it: no review tokens => P11 stays `unknown`,
 * no competitors => no benchmark key at all.
 */
export interface AuditInputs {
  /** Compliant tokens mined from operator-supplied review text (P11). */
  reviewTokens?: string[];
  /** Fragments the compliance filter dropped, for operator visibility. */
  reviewRejected?: { fragment: string; why: string }[];
  /** Competitor ASINs as they were ingested (or the reason they were not). */
  competitors?: CompetitorIngestion[];
}

export function buildAudit(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
  inputs: AuditInputs = {},
): Audit {
  const gateResult = runGate(proposed, pack, ctx);
  // WS9 — review tokens are a fact about the PRODUCT, not about one version of
  // the copy, so they are supplied to BOTH sides. That keeps P11 comparable:
  // the question "does this copy mirror how buyers talk" is asked identically
  // of the listing that exists and the one being proposed.
  const reviewInput = inputs.reviewTokens ? { reviewTokens: inputs.reviewTokens } : {};
  const scorecard = scoreAgainstPrinciples(current, pack, reviewInput);
  // WS6 — the SAME scorer, run over the proposed listing. Two principles that
  // are unknowable from a scraped page ARE known here (the backend field and
  // the seeded Q&A layer), so they are supplied; every other judge is
  // bit-for-bit the one that graded the current listing.
  const scorecardProposed = scoreAgainstPrinciples(
    proposedAsSnapshot(current, proposed),
    pack,
    { backendSearchTerms: proposed.backendSearchTerms ?? '', qa: proposed.qa ?? [], ...reviewInput },
  );
  // WS9 — advisory, and undefined when the operator supplied no competitors.
  const benchmark = buildBenchmark(current, proposed, inputs.competitors);
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
    scorecardProposed,
    gaps,
    gateResult,
    verified: gateResult.pass,
    packIntegrity: { ok: packProblems.length === 0, problems: packProblems },
    substantiationRegister,
    // brain/02 — ADVISORY proposals for the LEXICON owner, never about the copy.
    candidateTerms: candidateTerms(current, pack),
    // WS3 — a DERIVED view of the keyword artifact C28 has already verified.
    keywordCoverage: keywordCoverage(proposed),
    ...(benchmark ? { benchmark } : {}),
    ...(inputs.reviewRejected && inputs.reviewRejected.length > 0
      ? { reviewLanguageRejected: inputs.reviewRejected }
      : {}),
    rulesStale: staleness.stale,
    ...(staleness.notice ? { rulesStaleNotice: staleness.notice } : {}),
    attributeSchemaStale: schemaStaleness.stale,
    ...(schemaStaleness.notice ? { attributeSchemaStaleNotice: schemaStaleness.notice } : {}),
  };
}
