/**
 * Shared contract types — single source of truth for engine, gate, audit, and UI.
 * Mirrors brain/05-output-contract.md + ARCHITECTURE.md exactly.
 * No `any` anywhere in this file (enforced by strict TS).
 */

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** Normalized current listing as ingested from a provider or paste fallback. */
export interface ListingSnapshot {
  asin: string;
  url: string;
  title: string;
  bullets: string[];
  description: string;
  images: string[];
  /**
   * Normalized underscore_case attributes (via lib/ingest/labelMap).
   * Unmapped provider labels are preserved in `raw`.
   * NOTE: backend search terms are seller-private and are NEVER ingested —
   * audits must treat them as `unknown`, not empty.
   */
  attributes: Record<string, string>;
  price?: string;
  rating?: number;
  category: string;
  /** Subcategory labels detected from browse node + title keywords (may be several). */
  subcategory: string[];
  /** Provider-shaped original payload (display-label attributes, A+ body, etc.). */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/** One hard limit / formatting rule compiled from brain/01. */
export interface Rule {
  id: string;
  description: string;
  value: number | string | boolean;
  /** ⏳ rules that must be re-confirmed against live Amazon policy. */
  timeSensitive: boolean;
  verifiedAsOf?: string;
}

/**
 * Amazon STYLE rules (capitalization/punctuation/symbols/promo terms).
 * PACK DATA ONLY — gate C17 reads every threshold and list from here so the
 * gate itself stays category-agnostic and free of hard-coded lexicons.
 */
export interface StyleRules {
  /** Only ALL-CAPS words of at least this length are flagged (keeps mg/IU/CFU safe). */
  allCapsMinWordLen: number;
  /** Uppercase tokens that are legitimate even at/above the min length (exact, case-sensitive). */
  allCapsAllowlist: string[];
  /** Every bullet must open with a capital letter. */
  bulletMustStartCapital: boolean;
  /**
   * A RUN of this many consecutive ALL-CAPS word tokens counts as shouting
   * regardless of word length, and the acronym allowlist is NOT honoured inside
   * such a run (gate C17, FIX D).
   */
  allCapsRunMin: number;
  /** Bullets must not end with sentence punctuation. */
  bulletNoTrailingPunctuation: boolean;
  /** Trailing markers that are allowed and stripped before the punctuation check (e.g. the '*' claim marker). */
  bulletTrailingAllowed: string[];
  /** Characters that count as a trailing-punctuation violation. */
  bulletTrailingPunctuation: string;
  /** Symbols banned on every customer surface. */
  bannedSymbols: string[];
  /** Characters banned on the title/bullet surfaces listed in `bannedCharsSurfaces`. */
  bannedChars: string[];
  /** Surface groups the bannedChars scan applies to ('$'/'?' are legitimate elsewhere). */
  bannedCharsSurfaces: string[];
  /** Scan customer copy for ASINs. */
  noAsinInCopy: boolean;
  /** ASIN detection pattern (source string, compiled by the gate). */
  asinPattern: string;
  /** Promotional/ranking terms banned from title surfaces. */
  titleTermBans: string[];
  /** Surface groups the titleTermBans scan applies to. */
  titleTermBanSurfaces: string[];
  /** Scan customer copy for emoji. */
  emojiCheck: boolean;
  /** Emoji detection pattern (unicode ranges; compiled with the 'u' flag). */
  emojiPattern: string;
  /**
   * The ONLY HTML tags Amazon still honours in the description field.
   * Everything else (<p>, <b>, <ul>, ...) has been deprecated since July 2021
   * and can suppress the listing or render as raw text.
   */
  descriptionAllowedHtml: string[];
  /** Belt-and-braces UTF-8 BYTE cap on the description (enforced alongside descriptionMax chars). */
  descriptionMaxBytes: number;
  /** HTML tag detection pattern (source string, compiled by the gate). */
  htmlTagPattern: string;
}

/**
 * Unit lexicon (pack data). The gate compiles every unit-anchored regex from
 * this — C10/A5 potency phrasing and C12 fact consistency hold no unit,
 * dosage-form or "per serving" literal of their own.
 */
export interface UnitRules {
  /** Dimension name -> the unit tokens (all surface forms, singular AND plural). */
  dimensions: Record<string, string[]>;
  /** Units of the SAME dimension that must compare against each other; entry[0] is the canonical family name. */
  families: string[][];
  /** Phrases that make a potency figure a per-dose claim (gate C10/A5). */
  perServingPhrases: string[];
  /** Verbs that introduce a potency figure (gate C10/A5 second pattern). */
  potencyVerbs: string[];
  /** Dosage-form tokens the facts producer parses "take N <form> daily" with. */
  dosageForms: string[];
}

/** Snapshot attribute keys the deterministic facts producer reads (pack data). */
export interface FactFieldRules {
  unitCount: string;
  servings: string;
  servingSize: string;
  directions: string;
  weight: string;
  price: string;
  potencySources: string[];
  formulaCountSources: string[];
}

/** Title word-repetition rule (pack data, read by gate check C1). */
export interface TitleWordRepetitionRules {
  /** Maximum times one stemmed content word may appear in the title. */
  max: number;
  /** Short function words exempt from the count. */
  stopwords: string[];
}

/** Substring cues gate A4 uses to find the required A+ modules by id (pack data). */
export interface AplusModuleCues {
  brandStory: string;
  hero: string;
}

/** Prohibited detail-page content patterns (pack data, read by gate check C18). */
export interface ProhibitedContentRules {
  /** [regexSource, humanLabel] pairs. */
  patterns: [string, string][];
  /** Which surfaces to scan. */
  surfaces: string[];
}

/**
 * Prohibited MARKETING patterns (urgency / guarantees / rank + review claims).
 * Pack data read by gate checks A8 (A+) and C19 (every surface) — the gate
 * itself holds no literal marketing lexicon.
 */
export interface ProhibitedMarketingRules {
  /** [regexSource, humanLabel] pairs. */
  patterns: [string, string][];
  /** Which surfaces C19 scans. */
  surfaces: string[];
}

export interface RuleSet {
  titleMaxLegacy: number; // 200
  title75Max: number; // 75
  itemHighlightsMax: number; // 125
  bulletCount: number; // 5
  bulletMax: number; // 255
  descriptionMax: number; // 2000
  backendMaxBytes: number; // 249 (UTF-8 bytes)
  aplusModuleMaxBasic: number; // 5
  aplusModuleMaxPremium: number; // 7
  imageGalleryMax: number; // 9
  /** Main image: pure white RGB 255/255/255, product ≥85% fill, longest side ≥1000px. */
  imageMainMinLongSidePx: number;
  imageMainWhiteRgb: [number, number, number];
  imageMainProductFillPct: number;
  /** Minimum A+ comparison rows (gate A9). Category-agnostic quality floor. */
  aplusComparisonMinRows: number;
  /** Phrasing cues that count as a who-it's-for statement (gate A9). */
  whoItsForCues: string[];
  /** Amazon STYLE rules — the data behind gate C17. */
  style: StyleRules;
  /** Unit/dosage-form/potency-phrasing lexicon behind C10, C12, A5 and the facts producer. */
  units: UnitRules;
  /** Snapshot attribute keys the facts producer reads. */
  factFields: FactFieldRules;
  /** Title word-repetition limit + stopwords (gate C1). */
  titleWordRepetition: TitleWordRepetitionRules;
  /** Required A+ module ids (rendered into the A+ prompt). */
  aplusModuleIds: string[];
  /** Id cues gate A4 locates the required A+ modules with. */
  aplusModuleCues: AplusModuleCues;
  /** Amazon-prohibited detail-page content (price/availability/condition/contact). Pack data. */
  prohibitedContent?: ProhibitedContentRules;
  /** Amazon-prohibited marketing claims (urgency/guarantee/rank/review). Pack data. */
  prohibitedMarketing?: ProhibitedMarketingRules;
  /** ISO date the rule snapshot was last re-verified against live policy. */
  verifiedAsOf: string;
  /** Non-blocking staleness horizon in days for `verifiedAsOf`. */
  staleAfterDays: number;
  rules: Rule[];
}

export interface AllergenRule {
  class: string; // e.g. 'Tree Nuts'
  source: string; // e.g. the specific nut
  canonicalString: string; // e.g. 'Contains: Tree Nuts ([nut])'
}

/** Attribute keys + phrasing behind the allergen checks (pack data). */
export interface AllergenFields {
  /** Attribute key holding the full label / component list. */
  labelList: string;
  /** Attribute key holding the canonical allergen declaration. */
  declaration: string;
  /** Verb that makes a sentence an allergen DECLARATION ("contains"). */
  declarationVerb: string;
  /** Substring cue identifying the A+ module that must carry the declaration. */
  aplusModuleIdCue: string;
}

/** Category-specific prompt guidance (pack data — the engine holds no lexicon). */
export interface PromptRules {
  system?: string[];
  attributes?: string[];
  bullets?: string[];
  description?: string[];
  qa?: string[];
  aplus?: string[];
}

export interface CompliancePack {
  /** Verbatim FDA disclaimer constant (21 CFR 101.93). */
  disclaimer: string;
  /**
   * Additional variants accepted ONLY when auditing the CURRENT listing
   * (e.g. the CFR singular form). Generated output must match `disclaimer` exactly.
   */
  auditAcceptDisclaimers: string[];
  /** Drug/action verbs always banned as product claims. */
  diseaseVerbs: string[];
  /** Always-on disease/infection nouns scanned for EVERY product in this pack. */
  coreDiseaseNouns: string[];
  /**
   * Genuine meta-phrases that SHOULD suppress a nearby disease term
   * ("not intended to diagnose, treat, cure, or prevent any disease").
   * Pack data — the negation guard holds no lexicon of its own.
   */
  negationMetaPhrases?: string[];
  /** Subcategory label -> that subcategory's disease/infection nouns (non-empty). */
  diseaseNounsBySubcategory: Record<string, string[]>;
  allergenRules: AllergenRule[];
  /**
   * Attribute keys + phrasing the allergen checks (C9/A7) read. Pack data, so
   * the gate holds no attribute-key or allergen-phrase literal.
   */
  allergenFields: AllergenFields;
  /** Phrases that must never appear when a declarable allergen is present (C9). */
  noAllergenPhrases: string[];
  /** Category-specific generation guidance injected into the prompts. */
  promptRules?: PromptRules;
  superlativeBans: string[];
  /** Operator-supplied known-false descriptors; empty by default (C11 no-op). */
  fictionPhrases: string[];
  /** Unit tokens that anchor C12 numeric fact matching (mg, mcg, CFU, ...). */
  factUnits: string[];
  /** Subcategory label -> detection keywords (drives detectCategory). */
  subcategoryKeywords: Record<string, string[]>;
}

export interface AttributeField {
  field: string; // underscore_case
  label: string;
  filterFacet: boolean; // ⭐ powers a customer-facing filter
  required: boolean;
  valueType: 'string' | 'number' | 'enum' | 'list';
  example: string;
}

export interface Principle {
  id: string; // 'P1'..'P16'
  text: string;
  weight: number; // weights of scorable principles sum to 100
  /** P15/P16 are process rules — not scorable against a snapshot. */
  scorable: boolean;
  /** True when the principle is deterministically checkable in code. */
  autoCheck: boolean;
  /** Rubric guidance for LLM-judged principles. */
  rubric?: string;
}

export interface KnowledgePack {
  id: string; // 'supplements' | 'generic' | future packs
  rules: RuleSet;
  /** null for packs without a compliance module (e.g. 'generic'). */
  compliancePack: CompliancePack | null;
  attributeSchema: AttributeField[];
  principles: Principle[];
  /**
   * Category-smell terms shipped as PACK DATA (never hard-coded in the gate).
   * If a pack has no compliancePack but the snapshot matches this lexicon,
   * the gate emits the blocking PACK failure (fail closed).
   */
  suspicionLexicon: string[];
}

// ---------------------------------------------------------------------------
// Output contract (brain/05)
// ---------------------------------------------------------------------------

/**
 * Canonical numeric truths every surface must agree with (C12).
 * Deterministically produced from the snapshot — never LLM-guessed.
 */
export interface Facts {
  /** Headline strength attached to the blend/formula, never "per serving". */
  potency?: string;
  unitCount?: number; // pieces per container
  servings?: number; // servings per container
  servingSize?: string; // e.g. "[N] Capsules"
  daySupply?: number; // days per container
  weight?: string; // e.g. "[N] Ounces"
  price?: string; // standard price (attributes-only; never scanned in copy)
  formulaCount?: number; // e.g. "N-in-1" count, if applicable
}

export interface AplusModule {
  id: string;
  headline: string;
  body: string;
  subcopy?: string;
  claimBearing: boolean;
}

export interface AplusContent {
  /** Verbatim constant; repeated in each claim-bearing module/FAQ answer. */
  fdaDisclaimer: string;
  /** ≤7 (Premium); includes brand-story + hero. Real text, never image-only. */
  modules: AplusModule[];
  comparison: { rows: { label: string; ours: string; typical: string }[] };
  faq: { q: string; a: string; claimBearing: boolean }[];
}

export interface ImageSlot {
  slot: number; // 1-based
  purpose: string; // e.g. 'main-white-background', 'value-prop-infographic'
  spec: string; // requirements per amazon-rules (white bg, ≥85% fill, real photo for regulated panels…)
  notes: string;
}

export interface QAItem {
  q: string;
  a: string;
  claimBearing: boolean; // claim-bearing answers carry the verbatim disclaimer
}

/** Element lifecycle: advances to 'verified' only when the gate is green. */
export type ElementState = 'draft' | 'verified' | 'published';

/** The full generated deliverable for one ASIN — the Output Contract. */
export interface OptimizedListing {
  /** Legacy title: ≤200 chars; product name first; word ≤2×; no banned chars/promo/price. */
  title: string;
  /** ⏳ ≤75 chars (policy eff. Jul 27 2026); product name first; highest-value keyword cluster. REQUIRED. */
  title75: string;
  /** ⏳ ≤125 chars, searchable; terms not in title75; no title-word duplication. REQUIRED. */
  itemHighlights: string;
  /** Exactly 5; ≤255 chars each; one situational anchor per use-case; claim-bearing bullets end with '*'. */
  bullets: string[];
  /** ≤2000 chars; product name present; verbatim disclaimer appended; allergen + safety; blank-line paragraphs. */
  description: string;
  /** ≤249 UTF-8 BYTES; synonyms/misspellings/other-language only; zero title repeats; no brands/ASINs/disease terms. */
  backendSearchTerms: string;
  /** Full structured attribute set; active_ingredients ⊆ ingredients. */
  attributes: Record<string, string>;
  /** Canonical numeric facts backing C12. */
  facts: Facts;
  /** Verbatim category disclaimer constant. */
  fdaDisclaimer: string;
  aplusContent: AplusContent;
  /** ~7 slots per amazon-rules; no price/ratings/CTAs. */
  imagePlan: ImageSlot[];
  /** ~15 accurate pairs mirroring bullets + A+ FAQ facts. */
  qa: QAItem[];
  /** Primary keyword the engine chose — enables the deterministic front-load lint. */
  primaryKeyword: string;
  /** Per-bullet situational anchors (parallel to bullets) — feeds the quality lint. */
  bulletAnchors?: string[];
  /** Customer-facing product name (leads title/title75 per C8/C15). */
  productName: string;
  state: ElementState;
}

// ---------------------------------------------------------------------------
// Gate + audit
// ---------------------------------------------------------------------------

export interface Failure {
  checkId: string; // 'C1'..'C16', 'A1'..'A9', 'PACK'
  field: string;
  context: string;
  fix: string;
}

export interface GateResult {
  pass: boolean; // true only if zero failures
  failures: Failure[];
}

export type GapSeverity = 'P0' | 'P1' | 'P2';

export interface AuditGap {
  field: string;
  /** 'unknown' when the value is not publicly visible (e.g. current backend terms). */
  current: string | 'unknown';
  proposed: string;
  why: string;
  severity: GapSeverity;
}

export interface PrincipleScore {
  id: string;
  score: 'full' | 'partial' | 'none' | 'unknown';
  rationale: string;
}

export interface Scorecard {
  /** 0–100, renormalized over scorable+known principles (unknowns excluded from denominator). */
  total: number;
  perPrinciple: PrincipleScore[];
}

/**
 * Produced by the audit module (worker ≠ checker).
 * `verified` is EXACTLY gateResult.pass, re-derived server-side by re-running
 * the gate — never trusted from client-carried state.
 */
export interface Audit {
  scorecard: Scorecard;
  gaps: AuditGap[];
  gateResult: GateResult;
  verified: boolean; // === gateResult.pass
  /**
   * NON-BLOCKING signal: the pack's rule snapshot is older than
   * rules.staleAfterDays. Never a gate failure and never affects `verified`.
   */
  rulesStale: boolean;
  /** Human-readable staleness notice, present only when `rulesStale` is true. */
  rulesStaleNotice?: string;
}

// ---------------------------------------------------------------------------
// Pipeline results
// ---------------------------------------------------------------------------

export interface OptimizeResult {
  optimized: OptimizedListing;
  audit: Audit;
}

/** Typed ingestion errors — surfaced to the UI, never opaque 500s. */
export type IngestErrorCode =
  | 'INVALID_URL'
  | 'ASIN_NOT_FOUND'
  | 'PROVIDER_BLOCKED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'PASTE_UNPARSEABLE';

export interface IngestError {
  code: IngestErrorCode;
  message: string;
  /** When true the UI should suggest the paste fallback. */
  suggestPaste: boolean;
}
