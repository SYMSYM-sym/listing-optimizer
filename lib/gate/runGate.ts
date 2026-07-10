import 'server-only';

import type { GateResult, KnowledgePack, OptimizedListing } from '@/lib/types';
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
  packFailClosed,
  type GateContext,
} from './checks';

/**
 * The verify gate: C1–C12 + C15 + C16 + A1–A8 (C13/C14 are source-project-only
 * and intentionally omitted). PASS only if zero failures.
 * The gate REPORTS — it never mutates content to force a pass.
 */
export function runGate(
  listing: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): GateResult {
  const failures = [
    // Fail-closed first: an empty/missing disease-noun pack is blocking.
    ...packFailClosed(listing, pack, ctx),
    ...c1TitleLength(listing, pack),
    ...c2Bullets(listing, pack),
    ...c3BackendBytes(listing, pack),
    ...c4DescriptionLength(listing, pack),
    ...c5Disclaimer(listing, pack),
    ...c6BannedTerms(listing, pack, ctx),
    ...c7BrandLeakage(listing),
    ...c8ProductNameLead(listing),
    ...c9Allergen(listing, pack),
    ...c10PotencyPhrasing(listing),
    ...c11FictionPhrases(listing, pack),
    ...c12FactConsistency(listing),
    ...c15NewTitlePolicy(listing, pack),
    ...c16BackendDedup(listing),
    ...a1AplusDisclaimer(listing, pack),
    ...a2AplusBannedTerms(listing, pack, ctx),
    ...a3AplusBrandLeakage(listing),
    ...a4AplusProductName(listing),
    ...a5AplusPotencyPhrasing(listing),
    ...a6AplusFictionPhrases(listing, pack),
    ...a7AplusAllergen(listing, pack),
    ...a8AplusProhibitedMarketing(listing),
    ...a9AplusComparisonAndAudience(listing, pack),
  ];
  return { pass: failures.length === 0, failures };
}
