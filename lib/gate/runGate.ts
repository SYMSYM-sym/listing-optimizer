import 'server-only';

import type { Failure, GateResult, KnowledgePack, OptimizedListing } from '@/lib/types';
import {
  a1AplusDisclaimer,
  a2AplusBannedTerms,
  a3AplusBrandLeakage,
  a4AplusProductName,
  a5AplusPotencyPhrasing,
  a6AplusFictionPhrases,
  a7AplusAllergen,
  a8AplusProhibitedMarketing,
  a9AplusComparisonAndAudience,
  c1TitleLength,
  c2Bullets,
  c3BackendBytes,
  c4DescriptionLength,
  c5Disclaimer,
  c6BannedTerms,
  c7BrandLeakage,
  c8ProductNameLead,
  c9Allergen,
  c10PotencyPhrasing,
  c11FictionPhrases,
  c12FactConsistency,
  c15NewTitlePolicy,
  c16BackendDedup,
  c17Style,
  c18ProhibitedContent,
  c19ProhibitedMarketing,
  c20Structure,
  c21SemanticDrugClaims,
  c22NaturalState,
  c23AttributeCompleteness,
  c24DosageAttributeGuard,
  c25BulletClaimMarker,
  c26ActiveIngredientSubset,
  c27OutputHygiene,
  c28KeywordPlacement,
  c29ImagePlanContent,
  c30ImageAltText,
  c31BulletFormat,
  genDegradedGroups,
  packFailClosed,
  type GateContext,
} from './checks';

/**
 * The verify gate: C1–C12 + C15–C31 + A1–A9 + PACK (C13/C14 are
 * source-project-only and intentionally omitted). PASS only if zero failures.
 * The gate REPORTS — it never mutates content to force a pass.
 */
/**
 * WS10 — THE CRASH-VS-DETECTION CONTRACT, made structural.
 *
 * Law 2 of the source project: a green gate proves only what the ORACLE can
 * distinguish, and three different events used to satisfy "the gate stopped" —
 * the named guard fired, an unrelated check co-fired, or the gate CRASHED. A
 * crash is the worst of the three because it impersonates a detection while
 * discarding every finding, and a thrown `runGate` is worse still: the caller
 * receives an exception, not `verified:false`, so nothing downstream can even
 * report the run as unverified. That is a fail-OPEN.
 *
 * Every check therefore runs inside its own boundary. A throw becomes a
 * BLOCKING `GATE` failure that NAMES the check and carries the error, so:
 *   - the run can never come back `pass:true` because a check died;
 *   - the failure is visibly a GATE defect, not a copy defect, so nobody
 *     tries to "fix the copy" in response to a bug in the checker;
 *   - the remaining checks still run, so one broken check does not blind the
 *     other thirty.
 *
 * The individual checks are still written to be null-safe (see the `arr`
 * helper and the `str` coercions): this boundary is the backstop, not the
 * plan. A `GATE` failure in a run is a bug report.
 */
function guarded(
  checkId: string,
  run: () => Failure[],
): Failure[] {
  try {
    return run();
  } catch (e) {
    return [
      {
        checkId: 'GATE',
        field: checkId,
        context: (e instanceof Error ? e.message : String(e)).slice(0, 220),
        fix: `Check ${checkId} threw instead of returning a verdict. This run is UNVERIFIED and the failure is in the gate, not in the copy — fix the check and re-run.`,
      },
    ];
  }
}

export function runGate(
  listing: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): GateResult {
  const failures = [
    // Fail-closed first: an empty/missing disease-noun pack is blocking.
    ...guarded('PACK', () => packFailClosed(listing, pack, ctx)),
    // D1 — fail-closed second: a group the engine could not produce is a
    // BLOCKING failure, so a degraded run can never come back verified.
    ...guarded('GEN', () => genDegradedGroups(listing)),
    ...guarded('C1', () => c1TitleLength(listing, pack)),
    ...guarded('C2', () => c2Bullets(listing, pack)),
    ...guarded('C3', () => c3BackendBytes(listing, pack)),
    ...guarded('C4', () => c4DescriptionLength(listing, pack)),
    ...guarded('C5', () => c5Disclaimer(listing, pack)),
    ...guarded('C6', () => c6BannedTerms(listing, pack)),
    ...guarded('C7', () => c7BrandLeakage(listing)),
    ...guarded('C8', () => c8ProductNameLead(listing)),
    ...guarded('C9', () => c9Allergen(listing, pack)),
    ...guarded('C10', () => c10PotencyPhrasing(listing, pack)),
    ...guarded('C11', () => c11FictionPhrases(listing, pack)),
    ...guarded('C12', () => c12FactConsistency(listing, pack)),
    ...guarded('C15', () => c15NewTitlePolicy(listing, pack)),
    ...guarded('C16', () => c16BackendDedup(listing)),
    ...guarded('C17', () => c17Style(listing, pack)),
    ...guarded('C18', () => c18ProhibitedContent(listing, pack)),
    ...guarded('C19', () => c19ProhibitedMarketing(listing, pack)),
    ...guarded('C20', () => c20Structure(listing, pack)),
    ...guarded('C21', () => c21SemanticDrugClaims(listing, pack)),
    ...guarded('C22', () => c22NaturalState(listing, pack)),
    ...guarded('C23', () => c23AttributeCompleteness(listing, pack)),
    ...guarded('C24', () => c24DosageAttributeGuard(listing, pack)),
    ...guarded('C25', () => c25BulletClaimMarker(listing, pack)),
    ...guarded('C26', () => c26ActiveIngredientSubset(listing, pack)),
    ...guarded('C27', () => c27OutputHygiene(listing, pack)),
    ...guarded('C28', () => c28KeywordPlacement(listing, pack, ctx)),
    ...guarded('C29', () => c29ImagePlanContent(listing, pack)),
    ...guarded('C30', () => c30ImageAltText(listing, pack)),
    ...guarded('C31', () => c31BulletFormat(listing, pack)),
    ...guarded('A1', () => a1AplusDisclaimer(listing, pack)),
    ...guarded('A2', () => a2AplusBannedTerms(listing, pack)),
    ...guarded('A3', () => a3AplusBrandLeakage(listing)),
    ...guarded('A4', () => a4AplusProductName(listing, pack)),
    ...guarded('A5', () => a5AplusPotencyPhrasing(listing, pack)),
    ...guarded('A6', () => a6AplusFictionPhrases(listing, pack)),
    ...guarded('A7', () => a7AplusAllergen(listing, pack)),
    ...guarded('A8', () => a8AplusProhibitedMarketing(listing, pack)),
    ...guarded('A9', () => a9AplusComparisonAndAudience(listing, pack)),
  ];
  return { pass: failures.length === 0, failures };
}
