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
  /**
   * Allow-listed tokens that can NEVER read as emphasis, however many of them
   * sit together (certification / standards marks). A run made entirely of
   * these is not a shouting run at any length — `IFOS BSCG HACCP SQF` written
   * without commas is a certification list, not shouting. Every OTHER
   * all-allow-listed run still needs `allCapsRunMin + 1` members, which is what
   * keeps `SAME NON USA GABA blend` failing.
   */
  allCapsRunExempt?: string[];
  /**
   * Surface GROUPS the ALL-CAPS rules (per-word and shouting-run) do NOT apply
   * to — N1.
   *
   * A FALSE-POSITIVE REDUCER, and only that: it can subtract a group, never add
   * one, so an absent or empty list means every surface is checked, which is the
   * stricter behaviour and the one that shipped before this key existed. It is
   * therefore deliberately NOT a `REQUIRED_PACK_PIECES` row (emptying it cannot
   * disarm a check), on the same reasoning that excludes `benignContextPhrases`
   * and `outputHygiene.asciiExemptSurfaces` from the manifest.
   *
   * The shipped supplements pack names one group, `video`: capitals are the
   * conventional register in BOTH halves of a video brief — typography in an
   * on-screen title card, slug lines in a shot list — and C17 cannot distinguish
   * either from emphasis. See the N1 partition in `lib/gate/checks/c-style.ts`.
   */
  allCapsExemptSurfaces?: string[];
  /** Every bullet must open with a capital letter. */
  bulletMustStartCapital: boolean;
  /**
   * A RUN of this many consecutive ALL-CAPS word tokens counts as shouting
   * regardless of word length (gate C17).
   *
   * The allowlist IS honoured inside a run, in two graded ways: a run made
   * entirely of allow-listed acronyms needs `allCapsRunMin + 1` members before
   * it is reported, and a run made entirely of `allCapsRunExempt` certification
   * marks is never reported at any length. A run containing even one
   * non-allow-listed token is measured against this number unchanged.
   */
  allCapsRunMin: number;
  /** Bullets must not end with sentence punctuation. */
  bulletNoTrailingPunctuation: boolean;
  /** Trailing markers that are allowed and stripped before the punctuation check (e.g. the '*' claim marker). */
  bulletTrailingAllowed: string[];
  /**
   * The trailing marker a CLAIM-BEARING bullet must carry (gate C25). Pack
   * data so the gate holds no marker literal; it is also listed in
   * `bulletTrailingAllowed`, so C17 already tolerates it in final position.
   */
  claimMarker?: string;
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
  /**
   * Cues that make a DAY figure a supply statement ("90 day supply", "lasts 30
   * days"). C12 only measures a day figure against `facts.daySupply` when one of
   * these sits next to it — without the gate, ordinary copy ("Give it 90 days")
   * failed as a contradicted supply claim.
   */
  daySupplyCues?: string[];
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

/**
 * WS10 / R4+R6 — BULLET FORMAT rules (pack data, gate C31).
 *
 * Only the two rules a machine can decide without guessing. Title Case per
 * word and the write-out-numbers rule stay prompt-guided: each has a lawful
 * exception (registered ingredient marks, measurements) that a check cannot
 * tell from a violation, and over-blocking is as severe as a bypass.
 */
export interface BulletFormatRules {
  /** Require the documented "Header fragment: body" pattern. */
  requireColonHeader: boolean;
  /** The colon must fall inside this many leading characters. */
  headerMaxChars: number;
  /** Minimum length of the header fragment itself. */
  headerMinChars: number;
  /**
   * Max occurrences of one stemmed content word WITHIN one bullet.
   * See `knowledge/rules.json` for why the shipped value is the stuffing
   * floor rather than the title rule's stricter cap.
   */
  wordRepetitionMax: number;
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

/**
 * OPERATOR CHECKLIST (pack data) — the publish-time procedure the ship sheet
 * renders. It is DOCUMENTATION, not enforcement: nothing here can fail a
 * check, which is why it is not a `REQUIRED_PACK_PIECES` row. It lives in the
 * pack (not in `lib/export`) so the sheet holds no marketplace procedure of
 * its own and a change of procedure is a data edit.
 */
export interface OperatorChecklist {
  /** The publish ORDER, step by step. The browse node is deliberately LAST. */
  publishOrder: string[];
  /** Propagation window + the do-not-re-submit warning. */
  propagationNote: string;
  /** Why the recommended browse node is a suggestion, not an answer. */
  browseNodeNote: string;
  /**
   * OPS items the app cannot generate — the operator supplies them from their
   * own records. Rendered verbatim as placeholders (WS7 extends this list).
   */
  opsPlaceholders: string[];
}

/**
 * WS6/WS7 — the POST-PUBLISH phase (pack data, GUIDANCE tier).
 *
 * Everything here is rendered by the ship sheet and enforced by nothing: these
 * are account-side actions the app can only ever surface. That is why this is
 * not a `REQUIRED_PACK_PIECES` row — emptying it disarms no check, it just
 * removes a note. It lives in the pack so `lib/export` holds no marketplace
 * procedure of its own.
 */
/**
 * WS7 — one row of the MARKETPLACE / OPS checklist (pack data, guidance tier).
 *
 * Each row names an account-side action the app cannot perform, states WHY it
 * matters, and — where the rule carries an effective date or a list that moves
 * — says so, because a cached copy of a moving rule is a liability.
 */
export interface MarketplaceChecklistItem {
  id: string;
  title: string;
  detail: string;
  /** 'survival' | 'discovery' | 'growth' | 'hygiene' — rendered as a lane label. */
  lane: string;
  /** Present when the rule carries a date the operator must re-verify. */
  dated?: string;
  /** True when the underlying list/rule is refreshed on a cadence — never trust a cache. */
  volatile?: boolean;
}

export interface TimingAdvisory {
  /** The principle this advisory implements (P15). */
  id: string;
  headline: string;
  notes: string[];
}

/**
 * The seeded-Q&A POLICY note the ship sheet prints beside the pairs.
 *
 * The playbook states this rule three times and says, in as many words, to
 * "encode this rule on the ship sheet itself so no operator can miss it" — and
 * it has TWO halves, not one. The answers-only half is an account-level policy
 * violation (creating content about your own products). The CADENCE half —
 * answers spread over the first two weeks — is what stops a day-one burst of
 * seller answers from reading as manufactured Q&A. The sheet used to carry a
 * hand-written copy of the first half only; both now live here, as PACK DATA,
 * so the exporter holds no domain literal and the wording is edited in one
 * place.
 */
export interface QaPolicyNote {
  /** Short bolded lead ("Answers only."). */
  headline: string;
  /** Sentences printed after the lead, in order, joined by a space. */
  notes: string[];
}

/**
 * WS5.5 — how the OPERATOR-CONFIRMED PANEL is announced to the generator.
 *
 * The engine may hold no category vocabulary (`tests/category.literals.test.ts`),
 * and "the panel" is a category noun — so the sentence that tells the model the
 * confirmed values outrank the scraped ones is PACK DATA, exactly like every
 * other instruction the prompt renders.
 */
export interface OperatorPanelRules {
  /** Rendered verbatim above the confirmed values in the system prompt. */
  promptHeadline: string;
  /** Operator-facing label for the input, rendered by the UI. */
  inputLabel?: string;
  /** One-line explanation of what confirming does, rendered by the UI. */
  inputHelp?: string;
}

export interface PostPublishRules {
  /** P15 — the reindex/patience windows. */
  timingAdvisory?: TimingAdvisory;
  /** The ANSWERS-ONLY + two-week-cadence note printed beside the seeded Q&A. */
  qaPolicy?: QaPolicyNote;
  /** WS7 — the marketplace/ops checklist (see `MarketplaceChecklistItem`). */
  marketplaceChecklist?: MarketplaceChecklistItem[];
  /** Operator-facing preamble for the marketplace checklist. */
  marketplaceChecklistNote?: string;
}

/**
 * WS4 — one BULLET SLOT JOB (pack data).
 *
 * The playbook's copy phase assigns each of the five bullets a JOB; a bullet
 * with no declared job is written to whatever the model felt like saying, and
 * five bullets with the same job are one bullet repeated five times. `cues`
 * are the vocabulary the AUDIT lint uses to ask whether the slot looks filled
 * — an ADVISORY question (a P2 gap), never a gate failure.
 */
export interface BulletSlotJob {
  /** Stable slot id ('B1'..'B5'). */
  id: string;
  /** One-line statement of what this bullet is FOR. */
  job: string;
  /** How to write it — rendered verbatim into the bullets prompt. */
  guidance: string;
  /** Vocabulary that suggests the slot job was actually attempted (audit lint only). */
  cues: string[];
}

/**
 * AM-3 — where an allergen declaration may sit INSIDE a bullet.
 *
 * The triple declaration itself (attribute + description + >=1 bullet) is
 * C9's, is unchanged, and is NOT weakened by anything here. This adds only a
 * POSITION rule for the bullet leg: the declaration must be a trailing clause,
 * never the bullet's lead. Enforced as a prompt instruction plus a P1 AUDIT
 * gap — deliberately not a gate check, because a bullet whose declaration
 * merely sits early is compliant copy written in the wrong order, and blocking
 * publication over word order would be over-blocking.
 */
export interface BulletAllergenPosition {
  /** When false the position lint is switched off entirely. */
  mustTrail: boolean;
  /** A declaration STARTING inside this many leading characters reads as the lead. */
  leadWindow: number;
  /** Rendered verbatim into the bullets prompt. */
  rule: string;
}

/** WS4 — the bullet architecture the copy phase writes to (pack data). */
export interface BulletArchitecture {
  slots: BulletSlotJob[];
  /** The distinct-anchor doctrine, rendered into the prompt. */
  anchorRule: string;
  /** AM-3 allergen POSITION rule (never the triple-declaration requirement). */
  allergenPosition?: BulletAllergenPosition;
}

/**
 * R48 — the POSITIONING anchor (pack data, advisory).
 *
 * Playbook 8.20: a per-serving arms race against a rival's number invites a
 * compliance mismatch and a losing comparison; completeness and heritage are
 * defensible because they cannot be copied by reformulating. Injected into the
 * copy prompts and rendered as a strategy note in the ship-sheet header.
 */
export interface PositioningAnchor {
  id: string;
  headline: string;
  guidance: string[];
  /** The operator-facing note rendered in the ship-sheet header. */
  sheetNote: string;
}

/**
 * AM-1 / C24 — the DOSAGE-ATTRIBUTE guard (pack data).
 *
 * Structured data is filter-fed: a strength/potency figure sitting in an
 * attribute whose KEY names a dose states the number AS a dose, which is an
 * overstatement even when the number itself is canonical. `keyPattern` is the
 * attribute-key regex; `unitDimensions` names which `units.dimensions` lists
 * count as the hero units the value may not assert.
 */
export interface AttributeGuardRules {
  /** Regex (case-insensitive) matched against the attribute KEY. */
  keyPattern: string;
  /** Which `units.dimensions` keys supply the guarded unit tokens. */
  unitDimensions: string[];
  /**
   * N2 — the SPELLED-OUT number vocabulary, a FLAGGED DIVERGENCE from the
   * harness kit (see CONFORMANCE-DEVIATIONS.md item 2).
   *
   * The kit's `checkC24` value shape is digit-anchored, so `"50 Billion CFU"`
   * in a dosage-keyed attribute fails and `"Fifty Billion CFU"` passes. The
   * figure is the same assertion in either script, and the attribute is
   * filter-fed either way, so this app now reads both — deliberately, and
   * recorded, rather than silently.
   *
   * TWO lists, not one, and the split is the false-positive control:
   *   `cardinals`   — the counting words (one … ninety). A match must BEGIN
   *                   with one of these.
   *   `magnitudes`  — the scale words (hundred … trillion). They may only
   *                   appear AFTER a cardinal, so a bare unit-declaring value
   *                   like "Billion CFU" is not read as a figure.
   *
   * ABSENT OR EMPTY = EXACT KIT PARITY. The leg is a WIDENER, so emptying it
   * cannot disarm C24 — it only narrows the check back to the digit-anchored
   * port. That is why it is deliberately NOT a `REQUIRED_PACK_PIECES` row, on
   * the same reasoning that excludes `diseaseActionVerbRoots`.
   */
  spelledOutNumbers?: {
    cardinals: string[];
    magnitudes?: string[];
  };
}

/**
 * C27 — OUTPUT HYGIENE (pack data).
 *
 * Three properties of machine-written copy that no other check looks at: it
 * must be pure ASCII once the engine has normalized typography at emit, it
 * must contain none of the model's own stock phrases, and it must never carry
 * a fragment of its own instructions.
 */
export interface OutputHygieneRules {
  /** Fail non-ASCII characters in generated copy. */
  asciiOnly: boolean;
  /** Stock LLM phrasing that marks copy as machine-written. */
  aiTellPhrases: string[];
  /** Fragments of the app's own prompt scaffolding that must never be echoed. */
  instructionFragments: string[];
  /** Which surface groups C27 scans. */
  surfaces: string[];
  /**
   * Surface GROUPS exempt from the ASCII rule (the phrase scans still cover
   * them). A false-positive reducer, never a manifest piece: emptying it makes
   * the gate stricter. Backend search terms live here because other-language
   * variants are that field's entire purpose.
   */
  asciiExemptSurfaces?: string[];
}

/**
 * WS3 — the KEYWORD SYSTEM rules (pack data, read by gate check C28).
 *
 * The playbook's Phase 7 builds a keyword reference listing every term the
 * listing targets, deliberately avoids, or captures indirectly, and a gate
 * check machine-verifies every placement and every negative — so "all content
 * is based on the keyword reference" is an ENFORCED invariant rather than a
 * description. Everything the check reads lives here, so `lib/gate` holds no
 * surface name, status word or threshold of its own.
 *
 * NOTE ON VOLUME TOOLS: the playbook forbids them, and nothing here calls one.
 * The model is QUALITATIVE (tier + status + evidence); no search-volume API is
 * consulted anywhere in this system.
 */
export interface KeywordRules {
  /** Surface names a term may declare that a CUSTOMER can read. Closed world. */
  visibleSurfaces: string[];
  /** Surface names that are indexed but invisible (the backend field). Closed world. */
  backendSurfaces: string[];
  /** The six statuses a term may carry. A status outside this set is a failure. */
  statuses: string[];
  /**
   * Minimum number of `negative` rows. A keyword reference with no negative
   * list is the shape the playbook's negative-keyword doctrine exists to
   * prevent: the banned vocabulary stops being recorded and the next copy
   * cycle "helpfully" adds a banned term back because it has volume.
   */
  minNegatives: number;
  /**
   * D1 — the MAXIMUM number of rows the reference may carry.
   *
   * The artifact is a LIST, and a list with no stated end is what truncated
   * every live run: the keywords group came back `stopReason: "max_tokens"`,
   * the JSON was cut mid-row and `JSON.parse` threw on the retry as well. The
   * cap is stated in the prompt, enforced by the group schema AND used to
   * derive the group's output budget (`keywordsMaxTokens`), so the three can
   * never drift into a budget that is smaller than the artifact it allows.
   */
  maxTerms: number;
  /**
   * D1 — the character budget for one row's `why`. It is the only free-prose
   * field on a row, so it is the only one that can make a row unboundedly
   * large. Stated in the prompt and enforced by the group schema.
   */
  whyMaxChars: number;
  /**
   * K4 — the DEMAND-RECAPTURE guidance rendered into the keyword and copy
   * prompts. Each line states one mapping pattern from banned demand to a
   * compliant capture route. Prompt-only: nothing here is enforced, which is
   * why it is not a `REQUIRED_PACK_PIECES` row.
   */
  demandRecapture?: { headline: string; mappings: string[] };
  /**
   * The line that tells the model its OWN brand is never a negative term.
   *
   * A live run classified the subject product's own brand name as `negative`
   * ("must appear nowhere"), and C28 then correctly failed it for appearing in
   * `brand_name`/`manufacturer` — where a compliant listing MUST carry it. Code
   * rejects that classification at the derivation boundary
   * (`lib/engine/keywordPlacement.ts`); this line stops it being PROPOSED.
   * Prompt-only, like `demandRecapture`: nothing here is enforced, so it is not
   * a `REQUIRED_PACK_PIECES` row — what is enforced is the reclassification and
   * the negative floor that counts only surviving negatives.
   */
  ownBrandNote?: string;
  /** Operator-facing note rendered above the keyword section of the ship sheet. */
  sheetNote?: string;
}

/**
 * WS8 — a TOKEN GROUP a slot's brief must satisfy (pack data, gate C29).
 *
 * `anyOf` is an OR-list of accepted spellings of ONE requirement; ALL groups
 * on a slot must be satisfied. The list is spellings, not synonyms of intent:
 * "pure white" and "rgb 255" are the same requirement written two ways, and a
 * brief that says neither has not stated the requirement at all.
 */
export interface ImageSpecTokenGroup {
  /** What the group is checking, used verbatim in the failure text. */
  label: string;
  anyOf: string[];
}

/** WS8 — one slot of the image architecture (pack data). */
export interface ImageSlotSpec {
  slot: number;
  /** Canonical purpose label, rendered into the images prompt. */
  purpose: string;
  /** How to brief the slot — rendered verbatim into the prompt. */
  guidance: string;
  /**
   * Requirements the EMITTED brief must actually carry (gate C29). Empty or
   * absent means the slot's content is unchecked — which is why the manifest
   * requires at least one slot to carry tokens.
   */
  requiredTokens?: ImageSpecTokenGroup[];
}

/** WS8 — the 9:16 video brief spec (pack data). */
export interface VideoBriefSpec {
  aspect: string;
  minSeconds: number;
  maxSeconds: number;
  /** Rendered verbatim into the images prompt. */
  guidance: string[];
}

/**
 * WS8 — A+ notes the sheet renders (pack data).
 *
 * These are DISCLOSURES rather than instructions: what the brand-story card
 * needs beyond its text, that banner images carry their own ALT, that the
 * carousel is trimmed, and where the scope of this app stops.
 */
export interface AplusNotes {
  brandStoryCard: string;
  bannerAlt: string;
  carouselTrim: string;
  premiumScope: string;
}

/**
 * WS10 — notes about HOW a surface RENDERS, rather than about what it says.
 *
 * Neither the gate nor the generator can act on these: they are facts about
 * the reader (mobile truncation) and about the indexing model (A+ body text is
 * not indexed by classic search), so they are rendered beside the field they
 * are about and read where they are acted on.
 */
export interface CopySurfaceNotes {
  /** R12 — keep the description filled even once A+ is live. */
  descriptionWithAplus: string;
  /** R11 — mobile renders the description above the bullets and truncates it. */
  mobileFrontLoad: string;
  /** WS10 — the scraped-brand confirmation marker. */
  brandConfirm: string;
}

/** WS8 — the visual production architecture (pack data). */
export interface ImageArchitecture {
  slots: ImageSlotSpec[];
  /** ALT-text character cap per image (gate C30). */
  altMax: number;
  video: VideoBriefSpec;
  aplusNotes?: AplusNotes;
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
  /** WS10 bullet colon-header + word-repetition rules (gate C31). */
  bulletFormat?: BulletFormatRules;
  /** Required A+ module ids (rendered into the A+ prompt). */
  aplusModuleIds: string[];
  /** Id cues gate A4 locates the required A+ modules with. */
  aplusModuleCues: AplusModuleCues;
  /** Amazon-prohibited detail-page content (price/availability/condition/contact). Pack data. */
  prohibitedContent?: ProhibitedContentRules;
  /** Amazon-prohibited marketing claims (urgency/guarantee/rank/review). Pack data. */
  prohibitedMarketing?: ProhibitedMarketingRules;
  /** Publish-time operator procedure rendered by the ship sheet (pack data). */
  operatorChecklist?: OperatorChecklist;
  /** WS4 bullet slot jobs + anchor doctrine (prompt + audit lint; never a gate rule). */
  bulletArchitecture?: BulletArchitecture;
  /** WS5.5 operator panel-confirmation wording (prompt + UI). */
  operatorPanel?: OperatorPanelRules;
  /** WS3 keyword-system rules (gate C28 + the keyword/copy prompts). */
  keywordRules?: KeywordRules;
  /** WS6/WS7 post-publish guidance rendered by the ship sheet. */
  postPublish?: PostPublishRules;
  /** WS8 image/video architecture (images prompt + gate C29/C30 + the sheet). */
  imageArchitecture?: ImageArchitecture;
  /** WS10 rendering notes the sheet prints beside the field they are about. */
  copySurfaceNotes?: CopySurfaceNotes;
  /** R48 positioning anchor (prompt + ship-sheet strategy note). */
  positioningAnchor?: PositioningAnchor;
  /** AM-1 / C24 dosage-attribute guard. */
  attributeGuard?: AttributeGuardRules;
  /** C27 output-hygiene rules. */
  outputHygiene?: OutputHygieneRules;
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
  /**
   * The COMPLIANCE headline rules rendered at the top of the compliance block
   * ("never claim to diagnose/treat/cure…", "no star-rating or review-count
   * claims", "no price in copy"). These used to be hard-coded English
   * sentences inside `lib/engine/prompts/system.ts`; they are pack data now.
   */
  compliance?: string[];
  system?: string[];
  /** Injected into the TITLE/Item-Highlights task instruction. */
  title?: string[];
  attributes?: string[];
  bullets?: string[];
  description?: string[];
  qa?: string[];
  aplus?: string[];
}

/**
 * PACK DATA behind gate C21 (semantic drug claims).
 *
 * Three PROXIMITY rules are compiled from these lists at load time, plus the
 * literal `patterns`:
 *  1. a `pathologicalActionVerbs` verb followed within `proximityWindow`
 *     characters by an `anatomicalTargets` term (or a `determinerScopedTargets`
 *     term that a determiner points at) — "shrinks the lump", "melts the growth";
 *  2. a `replacementCues` cue followed within the same window by a
 *     `medicalDeviceOrTherapyNouns` noun — "throw away your inhaler",
 *     "ends the need for dialysis";
 *  3. a `functionRestorationVerbs` verb followed within the same window by a
 *     `lostFunctionNouns` noun — "restores sight to failing eyes".
 *
 * `safeContextPhrases` are blanked out of the surface BEFORE any of the above
 * runs, so genuine safety copy ("do not stop taking your medication", "not a
 * substitute for prescription medication") is never reported.
 *
 * COVERAGE, stated plainly: C21 runs over the SAME additive de-obfuscation
 * variant set the prohibited-content scans use (confusable/homoglyph fold,
 * both leetspeak readings, separator collapse, the doubled-letter pass and the
 * separator-STRIPPED variant), so `shr1nks the lump` and `sh rinks the lump`
 * are caught. The untouched text is always variant #1.
 */

/**
 * A target term that is only a body structure IN CONTEXT.
 *
 * Some target nouns are ordinary English in one domain and a pathology in
 * another — the same word can head lawful copy and a drug claim. A plain
 * string stays an unconditional target; this object form adds ONE of two
 * qualifications (both may be given, both are pack data):
 *
 *  - `requiresContext` — the term counts ONLY when one of these words appears
 *    within the proximity window either side of it. Use when the LAWFUL sense
 *    is the common one and the pathological sense always names its system.
 *  - `benignContext` — the term is CLEARED when one of these words appears in
 *    that window. Use when the pathological sense is the default and the
 *    lawful senses are a short, closed list of qualifiers.
 */
export interface SemanticTarget {
  term: string;
  requiresContext?: string[];
  benignContext?: string[];
}

/** A target list entry: a bare term, or a context-qualified one. */
export type SemanticTargetEntry = string | SemanticTarget;

export interface SemanticDrugClaims {
  /** Max characters between the end of a verb/cue match and the start of its noun. */
  proximityWindow: number;
  /** Device/therapy nouns whose REPLACEMENT is a drug claim. */
  medicalDeviceOrTherapyNouns: string[];
  /** Cues that announce replacing/abandoning a therapy. */
  replacementCues: string[];
  /** Body structures that only a drug or a device acts on. */
  anatomicalTargets: SemanticTargetEntry[];
  /** Targets that are ordinary English unless a determiner points at one instance. */
  determinerScopedTargets: SemanticTargetEntry[];
  /** Verbs that describe acting ON a pathology. */
  pathologicalActionVerbs: string[];
  /** Functions whose RESTORATION is a drug claim ("restores sight"). */
  lostFunctionNouns: string[];
  /** Verbs that describe giving a lost function back. */
  functionRestorationVerbs: string[];
  /** Spans in which a cue/verb is SAFETY copy; blanked before the scan. */
  safeContextPhrases: string[];
  /**
   * Literal patterns as `[regexSource, humanLabel]` rows. Typed as `string[][]`
   * (not a tuple) so the shipped JSON assigns without a double cast; the gate
   * reads `[0]`/`[1]` defensively and skips a row with an empty source.
   */
  patterns: string[][];
}

export interface CompliancePack {
  /** Verbatim FDA disclaimer constant (21 CFR 101.93). */
  disclaimer: string;
  /**
   * Disclaimer VARIANTS (e.g. the CFR singular form) accepted in place of
   * `disclaimer` wherever a scan must not read required legal text as copy.
   *
   * SCOPE, stated precisely: these are subtracted from the scanned text on the
   * CURRENT-LISTING audit path (`lib/audit/diff.ts`) AND from generated output
   * in C6/C17/C18/C19 — the old name `auditAcceptDisclaimers` implied an
   * audit-only scope the field never had. That is safe because they are only
   * ever used to EXEMPT the disclaimer sentence from a content scan, never to
   * satisfy the disclaimer requirement itself: C5 and A1 compare
   * `fdaDisclaimer` and the description against `disclaimer` VERBATIM, so
   * generated output that carries a variant instead still hard-fails
   * (`tests/redteam7.gate.test.ts` asserts both directions).
   */
  acceptedDisclaimerVariants: string[];
  /** Drug/action verbs always banned as product claims. */
  diseaseVerbs: string[];
  /**
   * ROOTS of the therapeutic-ACTION verb class (relieve, ease, reverse, …).
   * Inflections are generated in code (`inflect`), so the pack stays short and
   * a synonym of "treats" cannot slip past the negation guard. These veto
   * negation suppression; they never create a failure on their own.
   */
  diseaseActionVerbRoots?: string[];
  /** Always-on disease/infection nouns scanned for EVERY product in this pack. */
  coreDiseaseNouns: string[];
  /**
   * Terms that are NOT a claim on their own and only fail when a
   * therapeutic-ACTION verb sits in the same sentence.
   *
   * Two kinds live here: enumerated NATURAL STATES (menopause, perimenopause —
   * 21 CFR 101.93(g)), where "formulated for women in menopause" is a lawful
   * structure/function claim but "cures menopause" is not; and short names that
   * collide with a surname or place. They are NOT part of `allDiseaseNouns`, so
   * the plain noun scan never sees them.
   */
  actionPairedNouns?: string[];
  /**
   * Prescription-drug brand/generic names. Claiming a supplement replaces or
   * acts like a prescription drug IS a drug claim, so these are scanned by
   * exactly the same C6/A2 path (and the same de-obfuscation passes) as the
   * disease nouns.
   */
  prescriptionDrugNames?: string[];
  /**
   * NATURAL STATES (C22). Ageing, menopause, the menstrual cycle, adolescence
   * and pregnancy are natural states or processes, NOT diseases — 21 CFR
   * 101.93(f)/(g) and the FDA Small Entity Compliance Guide for the
   * structure/function rule. A term listed here is never a violation on its
   * own; it becomes a disease claim only when an `abnormalityMarkers` entry
   * sits within `naturalStateProximityWindow` characters of it, or when a
   * therapeutic-ACTION verb sits in the same sentence with no
   * `lawfulQualifiers` entry to keep it inside the safe harbour.
   */
  naturalStates?: string[];
  /**
   * NORMAL SYMPTOMOLOGY of a natural state (C22) — the mild, everyday form of
   * a symptom, which FDA treats as permissible ("the mild memory loss
   * associated with aging") and whose ABNORMAL form is a disease claim
   * ("clinical memory loss"). Rides exactly the same C22 rules as
   * `naturalStates`.
   */
  normalSymptomologyNouns?: string[];
  /**
   * NORMAL SYMPTOMOLOGY a structure/function claim MAY lawfully address (C22).
   * Scanned by the abnormality-marker rule ONLY: "severe hot flashes" is a
   * disease claim, "helps with hot flashes" is not. Applying the
   * therapeutic-action rule here would block exactly the copy the safe harbour
   * exists to permit.
   */
  abnormalOnlySymptomNouns?: string[];
  /**
   * ABNORMALITY MARKERS (C22): severe / chronic / clinical / disorder /
   * diagnosed … Two rules use them — one marker beside a natural state or a
   * normal symptom, and two DIFFERENT markers beside each other ("diagnosed
   * medical condition"). A `lawfulQualifiers` entry never rescues a marker.
   */
  abnormalityMarkers?: string[];
  /**
   * The SAFE-HARBOUR qualifiers (C22 + prompt): mild / occasional / normal /
   * already within the normal range / associated with … They suppress C22's
   * therapeutic-action rule when no abnormality marker is present, and they
   * are injected into the generation prompt. They are NOT a licence to name a
   * disease: a listed disease noun is failed by C6 whatever qualifier
   * surrounds it. PRECEDENCE: disease noun > abnormality marker > lawful
   * qualifier.
   */
  lawfulQualifiers?: string[];
  /**
   * FALSE-POSITIVE REDUCER for C22: spans blanked (length-preserving) before
   * the natural-state scan, the same technique `semanticDrugClaims.safeContextPhrases`
   * uses for C21. Research vocabulary and consult-a-professional warnings live
   * here. Emptying it makes the gate stricter.
   */
  naturalStateSafePhrases?: string[];
  /** Character window C22 measures proximity over (default 40). */
  naturalStateProximityWindow?: number;
  /**
   * ADVISORY-SENTENCE escape for C22's therapeutic-action rule (R3) — a
   * FALSE-POSITIVE REDUCER, never a manifest piece (emptying it makes the
   * gate stricter). A sentence that pairs one of these cue verbs with one of
   * `advisoryProfessionalNouns` (cue first, professional within the adjacency
   * gap) is the mandated consult-a-professional safety warning, not a product
   * claim: "Women who are pregnant or nursing … should talk with a physician"
   * must never be flagged. The escape covers R3 ONLY — abnormality markers
   * (R1/R2), the C6 noun scan and the C6 action-paired tier are untouched —
   * and it is DENIED when a therapeutic-action verb shares the state's own
   * comma-bounded clause segment, so "reverses aging, talk to your doctor"
   * still fails.
   */
  advisoryCueVerbs?: string[];
  /** Professional nouns the advisory cue must be followed by. See `advisoryCueVerbs`. */
  advisoryProfessionalNouns?: string[];
  /**
   * APPROVED structure/function claim SHAPES injected into the system prompt —
   * the PREVENTION half of the natural-state doctrine. Bracketed slots are
   * placeholders the generator fills from the product's own facts.
   */
  approvedClaimTemplates?: string[];

  /**
   * Genuine meta-phrases that SHOULD suppress a nearby disease term
   * ("not intended to diagnose, treat, cure, or prevent any disease").
   * Pack data — the negation guard holds no lexicon of its own.
   */
  negationMetaPhrases?: string[];
  /**
   * BENIGN SPANS: fixed retail phrases in which a disease word is a
   * calendar/seasonal reference rather than a claim ("cold and flu season").
   * A match INSIDE one of these spans is suppressed, UNLESS a
   * therapeutic-action verb sits in the same clause in front of it — so
   * "prevents colds during cold and flu season" still fails. Pack data.
   */
  benignContextPhrases?: string[];
  /**
   * Attribute keys carrying the per-ingredient breakdown (C12).
   *
   * A potency figure ATTRIBUTED to a named ingredient is accepted only when the
   * same number+unit also appears in one of these attributes; an attributed
   * figure that appears in none of them is still measured against
   * `facts.potency`. Pack data — the gate names no attribute key.
   */
  ingredientAttributeKeys?: string[];
  /**
   * SEMANTIC drug-claim heuristics (gate C21) — see `SemanticDrugClaims`.
   * A drug claim needs neither a disease noun nor a banned verb, so this tier
   * catches the claim SHAPE instead of its vocabulary.
   */
  semanticDrugClaims?: SemanticDrugClaims;
  /** Subcategory label -> that subcategory's disease/infection nouns (non-empty). */
  diseaseNounsBySubcategory: Record<string, string[]>;
  allergenRules: AllergenRule[];
  /**
   * Attribute keys + phrasing the allergen checks (C9/A7) read. Pack data, so
   * the gate holds no attribute-key or allergen-phrase literal.
   */
  allergenFields: AllergenFields;
  /**
   * AM-3 — which SURFACES C9 requires the allergen declaration on.
   *
   * The default (this key absent) is the full triple declaration: attribute
   * AND description AND at least one bullet. The key exists ONLY so an
   * operator whose category genuinely cannot carry the bullet leg can drop
   * THAT leg for their pack, and it ships with every leg ON — the override is
   * documented and DEFAULT OFF. `attribute` and `description` may never be
   * switched off: the pack manifest raises a blocking PACK failure if either
   * is, so this flag can never become a way to disarm C9 wholesale.
   */
  allergenDeclarationSurfaces?: {
    attribute?: boolean;
    description?: boolean;
    bullet?: boolean;
  };
  /**
   * C26 — the ACTIVE-vs-FULL ingredient attribute pair. Every token of
   * `subsetKey` must be present in `supersetKey`: an active ingredient that
   * appears nowhere in the full label list is either a copy error or an
   * undeclared ingredient, and both are label-mismatch enforcement risks.
   */
  ingredientSubsetRule?: { subsetKey: string; supersetKey: string };
  /**
   * R33/R38 — the SUBSTANTIATION REGISTER vocabulary. `[regexSource, display]`
   * rows naming every trust/origin/certification claim that needs an artifact
   * behind it. ADVISORY: it builds `audit.substantiationRegister` for operator
   * sign-off and can never fail a run.
   */
  substantiationTokens?: string[][];
  /**
   * brain/02 — the CANDIDATE-NOUN proposer (advisory). Heuristics for spotting
   * condition-like terms in the SOURCE listing that this pack's lexicon does
   * not yet know about (the dental blind spot). Never a failure.
   */
  candidateTermHeuristics?: {
    /** Morphological endings that mark a medical noun ('itis', 'osis', ...). */
    medicalSuffixes: string[];
    /** Verbs whose OBJECT is worth proposing as a candidate condition noun. */
    therapeuticVerbCues: string[];
    /** Words that are never candidates however they are shaped/capitalized. */
    stopwords: string[];
  };
  /** Phrases that must never appear when a declarable allergen is present (C9). */
  noAllergenPhrases: string[];
  /**
   * AM-4a — the CANONICAL none-style allergen declaration.
   *
   * When the label carries NO declarable allergen the declaration attribute
   * must still say something, and it must say the SAME thing every time: an
   * empty field reads as "not answered" and free-text variants ("none",
   * "N/A", "no allergens") are both unverifiable and, in one phrasing, banned.
   * C23 requires the declaration attribute to equal this string EXACTLY
   * whenever `presentAllergens` is empty. Independent of C9, which bans
   * `noAllergenPhrases` when an allergen IS present.
   */
  noAllergenCanonical?: string;
  /**
   * Compounds whose NAME contains an allergen source word but which are not that
   * allergen ("milk thistle", "wheatgrass", "eggshell"). Blanked out of the
   * label text before the allergen-source scan, so the gate never tells an
   * operator to print "Contains: Milk" on a milk-thistle label.
   */
  allergenCompoundExclusions?: string[];
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

/**
 * WHO OWNS a schema field's value.
 *
 * `generated` — the model produces it from the listing's own facts.
 * `operator`  — it is a SELLER-ACCOUNT fact the app cannot know (price, SKU,
 *               product id, model number, condition). The app must never
 *               invent one: an invented price is a wrong price on a live
 *               listing. Operator fields are filtered out of the attributes
 *               prompt, deleted from generated output if the model volunteers
 *               them anyway, and exempt from the C23 completeness rule.
 *
 * A field with NO `source` reads as `generated` — the stricter reading, since
 * that is the one the gate can enforce.
 */
export type AttributeSource = 'generated' | 'operator';

export interface AttributeField {
  field: string; // underscore_case
  label: string;
  filterFacet: boolean; // ⭐ powers a customer-facing filter
  required: boolean;
  valueType: 'string' | 'number' | 'enum' | 'list';
  example: string;
  /** Value owner. Missing ⇒ 'generated'. See `AttributeSource`. */
  source?: AttributeSource;
  /**
   * CLOSED value set. Present ONLY where `valueType === 'enum'` and the set is
   * genuinely closed; the invariant `valueType === 'enum'` ⟺ non-empty `enum`
   * is asserted by `tests/attributeSchema.test.ts` and by the pack manifest.
   * An over-tight enum on an open-ended field would block lawful values, which
   * is why several enum-LOOKING fields deliberately carry none.
   */
  enum?: string[];
  /** Operator-facing note rendered beside the field in the ship sheet. */
  note?: string;
  /** The produced value is a SUGGESTION for operator confirmation, not an answer. */
  suggestOnly?: boolean;
  /**
   * AM-7: this key is outside the operational census we have actually
   * confirmed against a shipped listing. It is still produced and still
   * checked; the flag says the exact template key must be confirmed against
   * the category's Listing Report before the operator relies on it.
   */
  pendingTemplateConfirm?: boolean;
}

/**
 * The on-disk attribute schema file: a dated snapshot, not a bare list.
 *
 * Attribute templates move (Amazon retires keys and renames others), so the
 * schema carries the same `verifiedAsOf` / `staleAfterDays` discipline the
 * rule snapshot does. Staleness is ADVISORY — see `attributeSchemaStaleness`.
 */
export interface AttributeSchemaFile {
  verifiedAsOf: string;
  staleAfterDays: number;
  fields: AttributeField[];
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
  /**
   * SAFETY CROSS-CHECK for a pack that ships NO compliance module.
   *
   * Such a pack switches off C5/C6/C9/C10/C11/A1/A2 wholesale, so the gate
   * additionally asks whether the generated listing names a disease or a
   * prescription drug AT ALL, using the regulated packs' lexicons. Assembled in
   * `loadPack` (knowledge/), so the gate itself still names no category.
   */
  crossCheckCompliancePacks?: CompliancePack[];
  rules: RuleSet;
  /**
   * TRUE for every category that is regulated enough to need a compliance
   * module. Declared by the pack ASSEMBLER, never inferred by the gate: it is
   * what turns "compliancePack is null" from a silent no-op into a blocking
   * PACK failure (a supplements pack whose compliance module went missing must
   * never return `pass:true`).
   */
  requiresCompliance: boolean;
  /** null for packs without a compliance module (e.g. 'generic'). */
  compliancePack: CompliancePack | null;
  attributeSchema: AttributeField[];
  /**
   * The attribute schema's own verification snapshot (from the schema file).
   * Absent for packs that ship no schema. Feeds the ADVISORY
   * `audit.attributeSchemaStale` signal only — it never touches `verified`.
   */
  attributeSchemaMeta?: { verifiedAsOf: string; staleAfterDays: number };
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
  /**
   * WS8 — ALT text for this module's banner image (≤ `rules.imageArchitecture.altMax`).
   *
   * A+ banners carry ALT exactly as gallery images do, and a live listing's
   * ALT is where an old agency template's competitor names sit: invisible on
   * the page and a real trademark exposure. Optional because a text-only
   * module has no banner; when present it is length-checked by C30 and scanned
   * for banned vocabulary like any other customer surface.
   */
  bannerAltText?: string;
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
  /**
   * WS8 — the paste-ready ALT string for this slot (≤ `rules.imageAltMax`).
   *
   * Optional on the TYPE so a run stored before ALT text existed still parses;
   * gate check C30 treats a missing/over-length ALT on a freshly generated plan
   * as a FAILURE, so optionality here is backward compatibility, never a skip.
   */
  altText?: string;
}

/**
 * WS8 — the 9:16 VIDEO BRIEF.
 *
 * PROMPTS, NOT ASSETS: the app writes the brief and the operator controls the
 * render and the spend. Every string here is customer-adjacent — the on-screen
 * text is read by the same OCR that reads the images — so `shots` and
 * `onScreenText` are scanned by the gate exactly like a bullet.
 */
export interface VideoBrief {
  /** e.g. '9:16 vertical'. */
  aspect: string;
  durationSeconds: number;
  /** Beat-by-beat outline, problem to solution. */
  shots: string[];
  /** Every string that appears ON SCREEN. Scanned like copy, because it is. */
  onScreenText: string[];
  notes: string;
}

export interface QAItem {
  q: string;
  a: string;
  claimBearing: boolean; // claim-bearing answers carry the verbatim disclaimer
}

/**
 * WS3 — one row of the KEYWORD REFERENCE (playbook Phase 7 / §7.2).
 *
 * Ported from the harness kit's `content/keywords.json` schema, field for
 * field, because that artifact is what the gate check verifies against. The
 * model is QUALITATIVE by design — the playbook forbids volume tools, so a
 * term earns its tier from evidence ("both category leaders title with it"),
 * never from a number an API returned.
 */
export type KeywordTier = 1 | 2 | 3 | 4 | 'backend' | 'demand' | 'strategy' | 'candidate' | 'negative';

/**
 * The SIX statuses, exactly as `content/keywords.json` defines them:
 *
 *  placed       — must appear on every surface it declares.
 *  backend      — indexed invisibly: must be in the backend field and NOWHERE visible.
 *  captured-via — banned demand recaptured through a compliant cluster: the term
 *                 itself must appear NOWHERE, and the compliant route MUST be
 *                 documented in `via` (K4). DERIVED on the first half — it
 *                 claims the term is absent, so the derivation measures that and
 *                 corrects the row when the copy carries the term; `via` is a
 *                 fact about the ROW rather than about the copy, so it survives
 *                 derivation and C28 still enforces it.
 *  not-targeted — a deliberate strategy call; not scanned by C28. DERIVED: it
 *                 claims the term is absent, so the derivation checks that and
 *                 corrects the row when the copy carries the term.
 *  candidate    — future PPC / off-site / next copy cycle; must NOT be in current copy.
 *                 DERIVED for the same reason, and by the same rule.
 *  negative     — must appear NOWHERE, visible or backend. Competitor brand names
 *                 live here (R50), as do banned terms and unverifiable superlatives.
 *                 THE ONLY MODEL-OWNED STATUS: its falsification by the copy IS
 *                 the R50 violation, so it is never derived away.
 */
export type KeywordStatus =
  | 'placed'
  | 'backend'
  | 'captured-via'
  | 'not-targeted'
  | 'candidate'
  | 'negative';

export interface KeywordTerm {
  /** The term itself (`t` in the kit's schema). */
  term: string;
  tier: KeywordTier;
  status: KeywordStatus;
  /**
   * DERIVED, never declared. The surfaces the FINISHED COPY actually carries
   * this term on, computed by `lib/engine/keywordPlacement.ts` through C28's
   * own pack-driven surface readers.
   *
   * The model used to be asked for this and was wrong ~21 times per live run
   * ("declared placed on 'title' but does not appear there"), which no repair
   * round could converge on because each regeneration produced a fresh set of
   * confident wrong claims. It is a fact code can compute exactly, so code
   * computes it — worker != checker. Empty for the one INTENT-bearing status
   * (`negative`), which places nothing by definition, and for any absence-claim
   * row (`candidate` / `not-targeted` / `captured-via`) whose absence claim
   * derivation confirmed — see `MODEL_OWNED_STATUSES` /
   * `ABSENCE_CLAIM_STATUSES`.
   */
  surfaces: string[];
  /** The evidence/rationale (`evidence` or `why` in the kit's schema). */
  why: string;
  /**
   * `captured-via` ONLY: the compliant cluster this demand reaches us through.
   * Written by the model, never derived — no reading of the copy can supply or
   * refute it — and preserved through derivation so C28's route leg still has
   * something to enforce on a row whose absence claim held.
   */
  via?: string;
  /** `candidate` ONLY: where the term lives until it enters copy (PPC / off-site). */
  home?: string;
  /**
   * DERIVED. Set only when derivation CHANGED the row: a term the copy carries
   * nowhere downgraded to `candidate`, a `negative` row naming the subject's
   * OWN brand reclassified, or an absence-claim row (`candidate` /
   * `not-targeted` / `captured-via`) whose term turned out to be IN the copy
   * corrected to its real placement. It exists so
   * a correction is visible in the deliverable rather than a silent edit.
   */
  note?: string;
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
  /** 8 slots + ALT text per amazon-rules; no price/ratings/CTAs. */
  imagePlan: ImageSlot[];
  /**
   * WS8 — the 9:16 video brief that accompanies the still slots.
   * Optional on the TYPE so a run stored before it existed still parses; gate
   * C29 treats a missing brief on a freshly generated listing as a FAILURE.
   */
  videoBrief?: VideoBrief;
  /**
   * WS3 — the KEYWORD REFERENCE for this listing (playbook Phase 7).
   *
   * Optional on the TYPE so a run stored before the artifact existed still
   * parses; gate check C28 treats a missing/empty artifact as a FAILURE on a
   * freshly generated listing, so optionality here is backward compatibility,
   * never a way to skip the check.
   */
  keywords?: KeywordTerm[];
  /** ~15 accurate pairs mirroring bullets + A+ FAQ facts. */
  qa: QAItem[];
  /** Primary keyword the engine chose — enables the deterministic front-load lint. */
  primaryKeyword: string;
  /** Per-bullet situational anchors (parallel to bullets) — feeds the quality lint. */
  bulletAnchors?: string[];
  /**
   * Per-bullet CLAIM-BEARING flags (parallel to `bullets`), carried from the
   * generation group so gate C25 can enforce the claim-marker discipline the
   * generator declared: a bullet the model flagged as claim-bearing MUST be
   * emitted with the trailing '*'. Optional because a listing submitted to the
   * stateless audit route may not carry it; when it is absent C25 has no flag
   * to enforce and says so rather than guessing.
   */
  bulletClaimBearing?: boolean[];
  /** Customer-facing product name (leads title/title75 per C8/C15). */
  productName: string;
  /**
   * D1 — the generation groups whose LLM output could NOT be validated, even
   * after the boundary's own reparse retry.
   *
   * A truncated or unparseable group used to throw all the way out of the
   * route, which returned 502 and lost the entire run — every live attempt
   * ended that way. The group is now degraded instead: the run completes and
   * says which part of it is missing. That is only safe because the marker is
   * BLOCKING — gate check `GEN` turns every entry here into a failure, so
   * `verified` (=== `gateResult.pass`, computed only in the audit) can never
   * be true on a run where a group crashed, and a missing keyword artifact can
   * never quietly disable C28.
   *
   * Optional and ABSENT when nothing degraded, so a healthy run is
   * byte-for-byte the object it was before.
   */
  degradedGroups?: string[];
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

/**
 * One REPAIR-ROUTING GAP: a gate failure whose `field` the repair loop could
 * not attribute to any generation group. Structurally identical to (and kept
 * in sync with) `RoutingGap` in `lib/engine/fieldRouting.ts`; declared here so
 * the shipped `Audit` contract does not import from the engine.
 */
export interface RoutingGap {
  /** The check that emitted the failure (e.g. a C- or A- id). */
  checkId: string;
  /** The output-contract field path nothing owns. */
  field: string;
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
/**
 * PACK-INTEGRITY report surfaced in the audit payload.
 *
 * `problems` is non-empty exactly when the gate raised a blocking `PACK`
 * failure (a missing/empty required pack piece, or a category that needs a
 * compliance module and has none). It is derived from the gate result, so it
 * can never disagree with `verified`.
 */
export interface PackIntegrity {
  ok: boolean;
  problems: string[];
}

/**
 * R33/R38 — ONE ROW of the substantiation register.
 *
 * Every trust/origin/certification claim the generated listing makes, with the
 * surfaces it appears on and whether the SOURCE listing already evidenced it.
 * The register is for OPERATOR SIGN-OFF: the app cannot hold a certificate, so
 * it can only ever say "this claim is being made, here, and here is whether
 * the seller was already making it".
 */
export interface SubstantiationClaim {
  /** Display name of the claim (pack data). */
  claim: string;
  /** Surfaces it appears on, in generation order. */
  surface: string;
  /**
   * HELD    — the claim is ECHOED from the source listing: the seller was
   *           already publishing it, so the artifact is presumed to exist and
   *           the operator is confirming, not sourcing, it.
   * PENDING — the claim appears ONLY in the generated copy. Nothing in the
   *           source listing evidences it, so it must not publish until the
   *           operator names the artifact behind it. This is the "Made in USA"
   *           problem: a plausible claim the generator introduced by itself.
   */
  status: 'PENDING' | 'HELD';
  /** Human-readable reason for the status. */
  note?: string;
}

/**
 * WS3 — the KEYWORD COVERAGE summary (audit payload).
 *
 * A DERIVED view of `optimized.keywords`, which gate C28 has already verified
 * against the emitted copy. Advisory in the sense that it adds no verdict of
 * its own; it can never disagree with `verified`, because a false declaration
 * makes the gate fail before this is ever read.
 */
export interface KeywordCoverage {
  total: number;
  byStatus: Record<string, number>;
  /**
   * Terms machine-verified to appear on every surface they declare. `note` is
   * present when derivation CORRECTED the row into this list — an own-brand
   * `negative`, or a `candidate` / `not-targeted` row whose absence claim the
   * finished copy contradicted. A correction is never silent, so it travels
   * into the deliverable with the row it changed.
   */
  placed: { term: string; tier: KeywordTier; surfaces: string[]; why: string; note?: string }[];
  /** Indexed invisibly: in the backend field and nowhere a customer reads. */
  backendOnly: { term: string; why: string; note?: string }[];
  /** Verified to appear NOWHERE — rival brand names included (R50). */
  negatives: { term: string; why: string }[];
  /** K4 — banned demand and the compliant cluster it reaches the listing through. */
  recaptured: { term: string; via: string; why: string }[];
  /**
   * Held back for a later cycle; verified NOT to be in the current copy.
   * `note` is present when the row was DOWNGRADED here by derivation (the copy
   * carries the term on no surface) rather than proposed as a candidate.
   */
  candidates: { term: string; home: string; why: string; note?: string }[];
  /** Deliberate strategy calls — recorded so a later session can tell them from an oversight. */
  notTargeted: { term: string; why: string }[];
}

/**
 * WS9 — one row of the competitor benchmark.
 *
 * STRUCTURAL FACTS ONLY. There is no rival copy here and no rival brand name:
 * their non-compliant framing is takedown risk rather than inspiration, and
 * their brand belongs on the keyword NEGATIVE list, not in our deliverable.
 */
export interface CompetitorBenchmarkRow {
  asin: string;
  status: 'ok' | 'failed';
  titleLength?: number;
  bulletCount?: number;
  attributeCount?: number;
  aplusPresent?: boolean;
  /** Why a `failed` row was not measured. */
  note?: string;
}

export interface CompetitorBenchmark {
  /** The PROPOSED listing, measured the same way. */
  subject: CompetitorBenchmarkRow;
  /** The CURRENT listing, measured the same way. */
  current: CompetitorBenchmarkRow;
  rows: CompetitorBenchmarkRow[];
  requested: number;
  ingested: number;
}

/**
 * WS9 — one competitor ASIN as it reached the audit: ingested, or carrying the
 * reason it was not. Ingesting someone else's listing fails routinely, so the
 * failure is a first-class value rather than an exception that loses the run.
 */
export interface CompetitorIngestion {
  asin: string;
  snapshot?: ListingSnapshot;
  error?: string;
}

export interface Audit {
  /** The CURRENT (scraped) listing, scored against the pack principles. */
  scorecard: Scorecard;
  /**
   * WS6 — the PROPOSED listing, scored by the SAME scorer.
   *
   * Optional so a run stored before the before/after view existed still
   * parses. It is never a verdict: `verified` is still exactly
   * `gateResult.pass`, and a listing can score well and still be blocked.
   */
  scorecardProposed?: Scorecard;
  gaps: AuditGap[];
  gateResult: GateResult;
  verified: boolean; // === gateResult.pass
  /** Blocking pack-integrity problems (empty + ok:true when the pack is complete). */
  packIntegrity: PackIntegrity;
  /**
   * NON-BLOCKING signal: the pack's rule snapshot is older than
   * rules.staleAfterDays. Never a gate failure and never affects `verified`.
   */
  rulesStale: boolean;
  /** Human-readable staleness notice, present only when `rulesStale` is true. */
  rulesStaleNotice?: string;
  /**
   * NON-BLOCKING signal: the pack's ATTRIBUTE SCHEMA snapshot is older than
   * its own `staleAfterDays`. Advisory exactly like `rulesStale` — never a
   * gate failure, never part of `verified`.
   */
  attributeSchemaStale: boolean;
  /** Human-readable notice, present only when `attributeSchemaStale` is true. */
  attributeSchemaStaleNotice?: string;
  /**
   * R33/R38 — every trust/origin/certification claim in the generated listing,
   * for operator sign-off. ADVISORY: a PENDING row never affects `verified`,
   * because whether an artifact exists is a fact about the seller's filing
   * cabinet, not about the copy. Optional on the type so a stored run written
   * before the register existed still parses.
   */
  substantiationRegister?: SubstantiationClaim[];
  /**
   * brain/02 — condition-like terms found in the SOURCE listing that the
   * pack's lexicon does not know. ADVISORY proposals for the lexicon owner
   * (the dental blind spot: the pack had no oral-health nouns for months and
   * nothing in the system could say so). Never a failure.
   */
  candidateTerms?: string[];
  /**
   * WS3 — the keyword-coverage summary derived from `optimized.keywords`.
   * Optional so a run stored before the artifact existed still parses.
   */
  keywordCoverage?: KeywordCoverage;
  /**
   * WS9 — the competitor benchmark, present only when the operator supplied
   * competitor ASINs. ADVISORY in the strictest sense: it is a set of facts
   * about pages we do not control, and a failed row never affects `verified`.
   */
  benchmark?: CompetitorBenchmark;
  /**
   * WS9 — review fragments the compliance filter DROPPED, with the reason.
   * Recorded so an operator can see WHY their review text seemed to do
   * nothing, rather than guessing. Never copy; never a failure.
   */
  reviewLanguageRejected?: { fragment: string; why: string }[];
  /**
   * REPAIR-ROUTING GAPS — gate failures the repair loop could not route to any
   * generation group and that are not one of the documented non-regenerable
   * classes (see `lib/engine/fieldRouting.ts`).
   *
   * WHY IT IS ON THE AUDIT. A live run on B00EEEITVA ended `verified:false`
   * with two C10/A5 potency findings the model could trivially have fixed: the
   * `videoBrief.*` fields had no row in the routing table, so the loop dropped
   * them silently and spent every round on nothing. The run looked like a hard
   * compliance failure and was actually a one-line hole in the router — and
   * the only way to find that out was to grep the source.
   *
   * It is DERIVED from `gateResult.failures`, in the same module that owns
   * `verified`, so it can never disagree with the verdict and no route has to
   * remember to thread it. It is NOT a softening of anything: every entry here
   * is ALSO a blocking gate failure, so `verified` is already false whenever
   * this key is present. The key is omitted entirely when there are none, so a
   * healthy run's payload is byte-identical to what it was.
   */
  routingGaps?: RoutingGap[];
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
