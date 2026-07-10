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
  rules: Rule[];
}

export interface AllergenRule {
  class: string; // e.g. 'Tree Nuts'
  source: string; // e.g. the specific nut
  canonicalString: string; // e.g. 'Contains: Tree Nuts ([nut])'
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
  /** Subcategory label -> that subcategory's disease/infection nouns (non-empty). */
  diseaseNounsBySubcategory: Record<string, string[]>;
  allergenRules: AllergenRule[];
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
  checkId: string; // 'C1'..'C16', 'A1'..'A8', 'PACK'
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
