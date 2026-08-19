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
import { buildFacts } from '@/lib/engine/facts';
import { unroutableFailures } from '@/lib/engine/fieldRouting';
import { candidateTerms } from './candidateTerms';
import { brandParity } from './brandParity';
import { buildBenchmark } from './benchmark';
import { rivalBrandNames } from './rivalBrands';
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
  /**
   * WS5.5 — the values the operator read off the physical label and CONFIRMED.
   *
   * When supplied they are PRODUCT TRUTH for this run, so the canonical facts
   * block is re-derived from them and the gate measures every surface against
   * the operator's numbers rather than against whatever facts arrived attached
   * to the listing. That matters most on `/api/audit`, where the listing is
   * CLIENT-SUPPLIED: worker != checker means the checker must not take the
   * worker's word for what the product is either.
   *
   * Absent => `proposed` is passed through by reference and every output is
   * byte-identical to what it was.
   */
  panelFacts?: Readonly<Record<string, string>>;
}

export function buildAudit(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
  inputs: AuditInputs = {},
): Audit {
  // WS5.5 — PANEL FIRST. A confirmed panel replaces the canonical facts block
  // before anything reads it, so C12 (and every other fact-anchored check)
  // compares copy against the label the operator actually holds. Without one,
  // this is the caller's own object, untouched.
  const listing: OptimizedListing = inputs.panelFacts
    ? { ...proposed, facts: buildFacts(current, pack, inputs.panelFacts) }
    : proposed;
  // WS9 → R50 — THE COMPETITORS THE OPERATOR SUPPLIED BECOME AN AUTOMATIC
  // RIVAL-BRAND NEGATIVE SET, resolved HERE rather than by the caller.
  //
  // `verified` is `gateResult.pass` and it is computed in this module, so this
  // is the one place where "the operator supplied competitors" and "the gate
  // knows their brand names" cannot come apart. A route that forgets to thread
  // it does not exist: there is nothing for a route to thread. When no
  // competitors were supplied the resolver returns `[]` and the key is not even
  // added, so the gate context is byte-identical to what it was.
  //
  // The listing measured is the one the gate is about to measure (panel applied),
  // and the snapshot is the CURRENT scraped page — the same two inputs the
  // own-brand identity is resolved from, so "our own brand" means one thing.
  const rivalBrands = rivalBrandNames(inputs.competitors, listing, current);
  const gateResult = runGate(
    listing,
    pack,
    rivalBrands.length > 0 ? { ...ctx, rivalBrands } : ctx,
  );
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
    proposedAsSnapshot(current, listing),
    pack,
    { backendSearchTerms: listing.backendSearchTerms ?? '', qa: listing.qa ?? [], ...reviewInput },
  );
  // WS9 — advisory, and undefined when the operator supplied no competitors.
  const benchmark = buildBenchmark(current, listing, inputs.competitors);
  // R33/R38 — the substantiation register is built BEFORE the diff, because
  // the diff turns its unevidenced HEADER claims into a P1 gap.
  const substantiationRegister = buildSubstantiationRegister(listing, current, pack);
  /**
   * N3 — SNAPSHOT FIDELITY FOR BRAND IDENTITY. Advisory; never enters
   * `verified`, which stays exactly `gateResult.pass`.
   *
   * It is resolved HERE for the same structural reason the rival-brand set is:
   * this is the module that holds both the SCRAPED snapshot and the PROPOSED
   * listing, and the gate holds only one of them. A route cannot forget to
   * thread something it is never handed.
   *
   * `null` when they agree, when the snapshot carries no brand field, or when
   * the proposal leaves one blank — so a healthy run's payload is byte-identical
   * to what it was before this existed.
   */
  const brandParityAdvisory = brandParity(current, listing);
  const gaps = diff(current, listing, pack, substantiationRegister, brandParityAdvisory);
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
  /**
   * REPAIR-ROUTING GAPS, derived from the SAME gate result `verified` is.
   *
   * A failure the repair loop cannot attribute to a generation group is
   * unrepairable however many rounds it is given, and until now it was dropped
   * silently — the operator saw a stubborn compliance failure and had no way to
   * tell it apart from one the model simply refused to fix. Naming it here
   * makes the next occurrence a one-look diagnosis.
   *
   * This ADDS a signal; it removes none. Every entry is also a blocking gate
   * failure, so `verified` is false whenever the list is non-empty, and the key
   * is omitted entirely when it is empty.
   */
  const routingGaps = unroutableFailures(gateResult.failures);
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
    keywordCoverage: keywordCoverage(listing),
    ...(benchmark ? { benchmark } : {}),
    ...(inputs.reviewRejected && inputs.reviewRejected.length > 0
      ? { reviewLanguageRejected: inputs.reviewRejected }
      : {}),
    ...(routingGaps.length > 0 ? { routingGaps } : {}),
    // N3 — omitted entirely when the brand agrees, so the common payload is
    // unchanged. Present => the ship sheet prints the confirm-before-publish
    // block, and `gaps` carries the same event as one P1 row.
    ...(brandParityAdvisory ? { brandParity: brandParityAdvisory } : {}),
    rulesStale: staleness.stale,
    ...(staleness.notice ? { rulesStaleNotice: staleness.notice } : {}),
    attributeSchemaStale: schemaStaleness.stale,
    ...(schemaStaleness.notice ? { attributeSchemaStaleNotice: schemaStaleness.notice } : {}),
  };
}
