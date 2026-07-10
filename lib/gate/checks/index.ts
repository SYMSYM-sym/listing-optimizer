export type { GateContext } from './types';
export { activeDiseaseNouns, packFailClosed } from './pack';
export { extractUnitNumbers } from './shared';
export type { UnitNumber, Dimension } from './shared';

export {
  c1TitleLength,
  c2Bullets,
  c3BackendBytes,
  c4DescriptionLength,
  c15NewTitlePolicy,
  c16BackendDedup,
} from './c-length';

export {
  c5Disclaimer,
  c6BannedTerms,
  c7BrandLeakage,
  c8ProductNameLead,
} from './c-compliance';

export {
  presentAllergens,
  allergenMentioned,
  c9Allergen,
  c10PotencyPhrasing,
  c11FictionPhrases,
  c12FactConsistency,
} from './c-quality';

export {
  a1AplusDisclaimer,
  a2AplusBannedTerms,
  a3AplusBrandLeakage,
  a4AplusProductName,
  a5AplusPotencyPhrasing,
  a6AplusFictionPhrases,
  a7AplusAllergen,
  a8AplusProhibitedMarketing,
  a9AplusComparisonAndAudience,
} from './a-aplus';
