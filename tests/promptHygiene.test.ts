import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGroupPrompts, buildSystemPrompt } from '@/lib/engine/prompts';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import type { GateContext } from '@/lib/gate/checks';
import { customerSurfaces } from '@/lib/gate/checks/shared';
import {
  crossPackActionPairedNouns,
  crossPackDiseaseNouns,
  diseaseActionVerbs,
  reachableCompliancePacks,
} from '@/lib/gate/checks/pack';
import { runGate } from '@/lib/gate/runGate';
import { termRegex } from '@/lib/gate/util';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type {
  CompliancePack,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
  SemanticTargetEntry,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * PROMPT HYGIENE — an instruction must never forbid a term BY NAMING IT.
 *
 * ---------------------------------------------------------------------------
 * ROUND 1 (the original file). A production run on an ordinary probiotic
 * listing came back `verified:false` with `[C6] imagePlan[3].notes … Remove
 * banned term 'disease'`: the generated image brief read "…avoid disease words
 * or clinical claims…". The gate was right — an image brief is customer-adjacent
 * copy and is scanned exactly like a bullet — but the text it flagged was OUR
 * OWN compliance instruction, echoed back by the model. The remedy was to
 * reword prompts as POSITIVE constraints and to add this file.
 *
 * ROUND 2 (why this file was rewritten). A live run of B00WNDG7V8 reproduced
 * the SAME class and this guard was green throughout:
 *
 *   C6 | imagePlan[1].notes | "…rather than a single capsule, avoid any disease
 *                              or symptom wording, keep the layout air…"
 *   C6 | videoBrief.notes   | "…rather than a single capsule, avoid any disease
 *                              or symptom wording throughout, end on a…"
 *
 * The sentence the model paraphrased was traced to PACK DATA rendered into the
 * shared SYSTEM preamble — `compliancePack.promptRules.compliance[0]`:
 *
 *   "NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or
 *    symptom."
 *
 * WHY THE ROUND-1 GUARD MISSED IT — two independent reasons, both recorded
 * because only the first is the one people guess:
 *
 *  1. SCOPE (the operative miss). The guard scanned ONE corpus: the slice of
 *     each group prompt AFTER `TASK:`. The system prompt was exempted wholesale,
 *     and the exemption's stated justification covered only the LEXICON
 *     ENUMERATIONS inside it ("enumerations of DATA, not sentences of the form
 *     'avoid <banned word>'"). The implementation exempted the prose as well —
 *     and the defect was a prose sentence. Pack guidance rendered BEFORE `TASK:`
 *     (the style block, the hero-spec block, the keyword vocabulary block) was
 *     unscanned for the same reason. Note the arithmetic: `disease` is in
 *     `coreDiseaseNouns`, so the round-1 `bannedHits` WOULD have flagged that
 *     sentence had it ever been shown it.
 *  2. VOCABULARY. The scanned set was the disease-noun union + `superlativeBans`
 *     + the C18/C19 patterns. It did not include the C22 abnormality markers or
 *     symptom nouns, the C21 domain nouns, `noAllergenPhrases`, the C17 title
 *     bans, the C27 AI tells, or the regulatory META vocabulary — and the
 *     therapeutic-verb tier existed but was applied to the one corpus that was
 *     already clean.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE NOW ASSERTS. Everything WE AUTHOR that reaches the model is
 * scanned, in three corpora that between them cover every rendered prompt:
 *
 *   A. TASK INSTRUCTIONS — the post-`TASK:` slice of every group prompt.
 *   B. PACK GUIDANCE — every string anywhere in the pack that is rendered
 *      verbatim into a prompt (this is where the round-2 defect lived).
 *      Includes `promptRules.*`, the image-architecture slot and video
 *      guidance, the bullet architecture, the positioning anchor, the keyword
 *      rules, the approved claim shapes and the attribute-schema examples.
 *   C. AUTHORED LITERALS — every string literal in `lib/engine/prompts/*.ts`
 *      AND in every other module measured to contribute text to a rendered
 *      prompt (C.2), extracted from source. `${…}` interpolations are dropped,
 *      which is what makes the DELIBERATE lexicon enumerations legal without a
 *      carve-out list: an enumeration is an interpolation of pack data, a
 *      prohibition is a literal. Comments are dropped too (they discuss the
 *      defect freely).
 *
 * ---------------------------------------------------------------------------
 * ROUND 3 — THE TWO FORWARD-LOOKING ESCAPES A REVIEWER FOUND WHILE THE TREE
 * WAS CLEAN. Neither had a live defect behind it; both were holes the next one
 * would have walked through.
 *
 *  1. CORPUS B CLASSIFIED BY LENGTH. A pack string counted as "guidance-shaped"
 *     at EIGHT WORDS OR MORE, so a prohibition of seven words or fewer —
 *     "avoid any disease wording" — was never shown to the scan. The classifier
 *     is INVERTED: every rendered pack string is scanned, and an exemption must
 *     be PROVED from the pack's own data (it is the term; it is a sibling in an
 *     array proved to be a gate-scanned lexicon; it is a pattern label its own
 *     regex matches). See `exemptions`. §B.1 asserts the change is a pure
 *     widening — nothing the old rule scanned may be exempt now — and a
 *     six-word canary asserts the new rule catches what the old one could not.
 *
 *  2. CORPUS C WAS A DIRECTORY. It read `lib/engine/prompts/*.ts` and nothing
 *     else, so a prohibition constant defined anywhere else and rendered into a
 *     prompt escaped all three corpora. Membership is now MEASURED: §C.2 runs
 *     the real generator (a plain round, a repair round and a reparse), catches
 *     every prompt at the LLM boundary, and enrols every module under `lib/`
 *     and `app/` one of whose own string literals is rendered verbatim into
 *     one. That immediately found two modules the directory could not:
 *     `lib/engine/optimize.ts` (the repair-round header) and `lib/engine/llm.ts`
 *     (the reparse instruction).
 *
 * Nothing operator-owned is scanned in A/B/C: the corpora are rendered from an
 * EMPTY snapshot / empty facts / no panel / no buyer phrases, so the only text
 * present is text this project wrote.
 *
 * D. the OUTPUT scan (round 1) is kept: the image plan and video brief produced
 *    by `optimize()` are measured against the same set.
 *
 * THE FORBIDDEN SET IS DERIVED, never hand-listed — see `gateReactiveTerms`.
 *
 * DELIBERATE EXCEPTION, unchanged: the lexicon ENUMERATIONS injected into the
 * system prompt and the style block. `tests/redteam3.gate.test.ts` and
 * `tests/redteam4.gate.test.ts` assert those injected sets are SUPERSETS of
 * what the gate enforces — a generator that is not shown the lexicon is failed
 * on a rule it was never told. They survive corpus C by construction (they are
 * `${…}`) and corpus B by MEMBERSHIP: an entry is exempt because the pack's own
 * data proves it is an entry, not because it is short. That distinction is the
 * whole of round 3's first half.
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;

/** An empty emitted-surface view for the WS3 keyword prompt (see below). */
const EMPTY_SURFACES = {
  title: '',
  title75: '',
  itemHighlights: '',
  bullets: [] as string[],
  description: '',
  backendSearchTerms: '',
  attributes: {} as Record<string, string>,
};

/**
 * The snapshot used for corpus A, exactly as in round 1: a REAL listing, whose
 * own copy is excluded from the scan by the `TASK:` split.
 */
const snapshot: ListingSnapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);

/**
 * The snapshot used to RENDER corpora B and C: empty, so no operator text
 * exists anywhere in the assembled prompt and every character left is ours.
 */
const EMPTY_SNAPSHOT: ListingSnapshot = {
  asin: '', url: '', title: '', bullets: [], description: '', images: [],
  attributes: {}, category: '', subcategory: [], raw: null,
};

// ---------------------------------------------------------------------------
// THE FORBIDDEN SET — derived from what the GATE ACTUALLY REACTS TO
// ---------------------------------------------------------------------------

interface Term {
  /** The check whose reaction makes this term dangerous in an instruction. */
  label: string;
  term: string;
}

const targetTerm = (e: SemanticTargetEntry): string =>
  typeof e === 'string' ? e : String((e as { term?: unknown } | null)?.term ?? '');

/**
 * The REGULATORY META-VOCABULARY, derived rather than listed.
 *
 * The gate compiles `compliancePack.negationMetaPhrases` — the disclaimer
 * sentences whose presence SUPPRESSES a disease-term hit ("not intended to
 * diagnose, treat, cure, or prevent any disease", "is not a drug"). Those
 * phrases are the regulator's own meta-vocabulary. A word of theirs counts as
 * meta-vocabulary here when it ALSO appears inside an entry of a lexicon the
 * gate scans with — which is what makes it a word the checks react to rather
 * than an ordinary English word that happens to sit in a disclaimer.
 *
 * On the shipped packs this yields exactly: diagnose, treat, cure, prevent,
 * disease, medical, drug, medicine. It rots with the pack, not against it: add
 * a meta-phrase or a lexicon entry and the set follows.
 */
function regulatoryMetaTerms(cp: CompliancePack, lexiconEntries: string[]): string[] {
  const lexTokens = new Set<string>();
  for (const entry of lexiconEntries) {
    for (const w of entry.toLowerCase().split(/[^a-z]+/)) if (w.length > 3) lexTokens.add(w);
  }
  const out = new Set<string>();
  for (const phrase of cp.negationMetaPhrases ?? []) {
    for (const w of phrase.toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 3 && lexTokens.has(w)) out.add(w);
    }
  }
  return [...out];
}

/**
 * SURFACE TIER — every term whose bare presence on a generated surface is,
 * or contributes to, a deterministic failure. An instruction may never name
 * one, on any corpus.
 *
 * NOT INCLUDED, and why (each exclusion is a PROXIMITY rule, not an oversight):
 *  - C21's `pathologicalActionVerbs`, `functionRestorationVerbs` and
 *    `replacementCues`. C21 fails a verb/cue only NEXT TO one of its domain
 *    nouns, and those verb lists are ordinary English — `return`, `clear`,
 *    `replace`, `instead of`. Forbidding them everywhere would fail
 *    "Return JSON:" in every group prompt. The DOMAIN halves (devices,
 *    lost functions, anatomical targets) are included, and they are what makes
 *    "shrinks the lump / clears the plaque / melts the growth" catchable.
 *  - `naturalStates` and `lawfulQualifiers`. These are LAWFUL to write — C22
 *    fails a therapeutic action ON a natural state, never the state itself —
 *    and the prompts must be able to say "menopause" and "mild".
 *  - `outputHygiene.instructionFragments`. Those strings ("TASK:",
 *    "Return JSON", "APPROVED CLAIM SHAPES", "deterministically checked") are
 *    the prompt scaffolding BY DESIGN; C27 catches them in the OUTPUT, which
 *    is the only place they are a defect.
 */
function baseSurfaceTerms(pack: KnowledgePack): Term[] {
  const out: Term[] = [];
  const add = (label: string, list: readonly (string | undefined)[] | undefined): void => {
    for (const t of list ?? []) if (t && t.trim()) out.push({ label, term: t.trim() });
  };
  add('C6 disease noun', crossPackDiseaseNouns(pack));
  add('C6 action-paired noun', crossPackActionPairedNouns(pack));
  for (const cp of reachableCompliancePacks(pack)) {
    add('C22 abnormality marker', cp.abnormalityMarkers);
    add('C22 symptom noun', [
      ...(cp.normalSymptomologyNouns ?? []),
      ...(cp.abnormalOnlySymptomNouns ?? []),
    ]);
    add('C19 superlative ban', cp.superlativeBans);
    add('C9 no-allergen phrase', cp.noAllergenPhrases);
    const s = cp.semanticDrugClaims;
    add('C21 device/therapy noun', s?.medicalDeviceOrTherapyNouns);
    add('C21 lost-function noun', s?.lostFunctionNouns);
    add('C21 anatomical target', [
      ...(s?.anatomicalTargets ?? []),
      ...(s?.determinerScopedTargets ?? []),
    ].map(targetTerm));
  }
  add('C17 title term ban', pack.rules.style?.titleTermBans);
  add('C27 AI-tell phrase', pack.rules.outputHygiene?.aiTellPhrases);
  return out;
}

/**
 * VERB TIER — the therapeutic-action verbs (`diseaseVerbs` + every inflection
 * of `diseaseActionVerbRoots`, cross-pack).
 *
 * Applied to the TASK INSTRUCTION corpus only, which is the round-1 scope and
 * is unchanged. The roots are ordinary English (`end`, `fix`, `improve`,
 * `reduce`, `stop`, `clear`, `target`) and the gate fails one only when a
 * disease noun sits within the same window, so a bare verb in a prose
 * paragraph is not a gate reaction. The instruction the model paraphrases is
 * the one place the project has decided to hold the stricter line. The four
 * REGULATORY verbs — diagnose / treat / cure / prevent — are in the surface
 * tier via `regulatoryMetaTerms`, so they are forbidden on every corpus.
 */
function verbTierTerms(pack: KnowledgePack): Term[] {
  const out: Term[] = [];
  for (const cp of reachableCompliancePacks(pack)) {
    for (const v of diseaseActionVerbs(cp)) {
      if (v.trim()) out.push({ label: 'therapeutic verb', term: v.trim() });
    }
  }
  return out;
}

/** The two `[regex source, human-readable label]` blocks C18/C19 compile. */
const patternBlocks = (pack: KnowledgePack): [string, readonly (readonly [string, string])[]][] =>
  [
    ['C19', (pack.rules.prohibitedMarketing?.patterns ?? []) as readonly (readonly [string, string])[]],
    ['C18', (pack.rules.prohibitedContent?.patterns ?? []) as readonly (readonly [string, string])[]],
  ];

/** C18/C19 are REGEXES, so they are matched as regexes rather than as terms. */
function patternHits(pack: KnowledgePack, text: string): string[] {
  const out: string[] = [];
  for (const [check, patterns] of patternBlocks(pack)) {
    for (const [source, label] of patterns) {
      const m = source ? new RegExp(source, 'i').exec(text) : null;
      if (m) out.push(`${check} ${label}: '${m[0]}'`);
    }
  }
  return out;
}

const TERM_CACHE = new WeakMap<KnowledgePack, { surface: Term[]; verb: Term[] }>();
function tiers(pack: KnowledgePack): { surface: Term[]; verb: Term[] } {
  const cached = TERM_CACHE.get(pack);
  if (cached) return cached;
  const base = baseSurfaceTerms(pack);
  const verb = verbTierTerms(pack);
  // The META basis is the two tiers themselves — i.e. exactly the lexicons this
  // gate compiles into a TERM scan. Using anything wider (the C21 replacement
  // cues, say) would drag ordinary English like "substitute" into the set.
  const basis = [...base, ...verb].map((t) => t.term);
  const meta: Term[] = [];
  for (const cp of reachableCompliancePacks(pack)) {
    for (const term of regulatoryMetaTerms(cp, basis)) {
      meta.push({ label: 'regulatory meta-term', term });
    }
  }
  const built = { surface: [...base, ...meta], verb };
  TERM_CACHE.set(pack, built);
  return built;
}

/** Every surface-tier term (and C18/C19 pattern) this text names. */
function surfaceHits(pack: KnowledgePack, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { label, term } of tiers(pack).surface) {
    const re = termRegex(term);
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    const key = `${label} '${term}'`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return [...out, ...patternHits(pack, text)];
}

/** Every bare therapeutic verb this text names. */
function verbHits(pack: KnowledgePack, text: string): string[] {
  const seen = new Set<string>();
  for (const { term } of tiers(pack).verb) {
    const re = termRegex(term);
    re.lastIndex = 0;
    if (re.test(text)) seen.add(`therapeutic verb '${term}'`);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// THE CORPORA
// ---------------------------------------------------------------------------

/** The attribute schema exactly as `optimize()` renders it into the prompt. */
const schemaFieldsOf = (pack: KnowledgePack): string =>
  pack.attributeSchema
    .filter((f) => f.source !== 'operator')
    .map((f) => `${f.field} | ${f.required ? 'required' : 'optional'} | ${f.example}`)
    .join('\n');

/**
 * Every prompt this engine renders, from an EMPTY snapshot and empty facts.
 *
 * `schemaFields` is the ATTRIBUTE TEMPLATE, and it is DATA in exactly the sense
 * the lexicon enumerations are: the field keys are the marketplace's own
 * (`target_gender`, `target_audience` — `target` is a therapeutic-action verb
 * root and cannot be renamed), and the examples are pack rows. Corpus A is
 * therefore rendered with a STUB template, as it was in round 1; corpus B
 * renders the REAL one, so every guidance-shaped schema example is scanned as
 * pack guidance — which is how the `allergen_information` example that spelled
 * out the banned no-allergen phrase was found.
 */
function renderedPrompts(
  pack: KnowledgePack,
  s: ListingSnapshot,
  schemaFields: string,
): [string, string][] {
  const g = buildGroupPrompts(pack);
  return [
    ['system', buildSystemPrompt(pack, {}, [])],
    ['title', g.title(s)],
    ['bullets', g.bullets(s)],
    ['description', g.description(s)],
    ['backend', g.backend(s)],
    ['attributes', g.attributes(s, schemaFields)],
    ['aplus', g.aplus(s)],
    ['images', g.images(s)],
    ['qa', g.qa(s)],
    // WS3 — the keyword prompt is handed an EMPTY surface view on purpose: the
    // finished copy it normally embeds is the listing's own (already
    // gate-scanned) text, and what this suite is about is the INSTRUCTION.
    ['keywords', g.keywords(s, EMPTY_SURFACES)],
  ];
}

/**
 * The instruction half of a group prompt: everything AFTER `TASK:`.
 *
 * What precedes it is the SOURCE listing (`snapshotBlock` — the operator's own
 * copy, which we do not author) and, in some groups, the style block.
 */
const taskInstruction = (prompt: string): string => prompt.split('TASK:').slice(1).join('TASK:');

/** Every string leaf in the pack, with its path. */
function walkStrings(node: unknown, path: string, out: [string, string][]): void {
  if (typeof node === 'string') {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkStrings(v, path ? `${path}.${k}` : k, out);
  }
}

/**
 * THE OLD CLASSIFIER, kept for ONE purpose: proving the new one only ever
 * widens. It called a pack string "guidance-shaped" at eight words or more, so
 * a prohibition of SEVEN words or fewer — "avoid any disease wording", "never
 * name a condition" — was never shown to the scan at all. The threshold was the
 * only thing standing between corpus B and that sentence, and a threshold is
 * not a reason.
 */
const isGuidanceShaped = (s: string): boolean => s.trim().split(/\s+/).length >= 8;

const normTerm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * THE TERMS THE SCAN ITSELF REACTS TO — i.e. every entry of every pack lexicon
 * `tiers()` compiles. Derived from the same two functions the offender scan
 * uses, so it cannot drift away from them by construction.
 *
 * A pack lexicon that `tiers()` deliberately leaves out (the C21 proximity
 * verbs, `naturalStates`, `lawfulQualifiers`, `instructionFragments` — see the
 * exclusion notes on `baseSurfaceTerms`) needs no exemption: the scan does not
 * react to those words, so their entries produce no offender to exempt.
 */
function scannedTerms(pack: KnowledgePack): Set<string> {
  const t = tiers(pack);
  return new Set([...t.surface, ...t.verb].map((x) => normTerm(x.term)));
}

/** `a.b.c[7]` -> `a.b.c[]`; anything not ending in an index -> `null`. */
const arrayOf = (path: string): string | null =>
  /\[\d+\]$/.test(path) ? `${path.replace(/\[\d+\]$/, '')}[]` : null;

/**
 * Is `s` rendered into `rendered` AS ITSELF, rather than as a coincidental
 * substring of a longer word?
 *
 * Bare containment is not enough once the corpus stops being length-filtered: a
 * three-letter pack value is a substring of a hundred rendered words it had
 * nothing to do with. The occurrence must be bounded by a non-word character on
 * each side, which every real rendering is (a template puts `- `, a newline, a
 * comma or a quote around it) and a mid-word coincidence never is. This is a
 * PRECISION rule, not a scope rule: it cannot hide a string the pack actually
 * renders.
 */
function renderedVerbatim(rendered: string, s: string): boolean {
  const word = /[A-Za-z0-9]/;
  for (let i = rendered.indexOf(s); i >= 0; i = rendered.indexOf(s, i + 1)) {
    const before = rendered[i - 1];
    const after = rendered[i + s.length];
    if ((before === undefined || !word.test(before)) && (after === undefined || !word.test(after))) {
      return true;
    }
  }
  return false;
}

/**
 * THE THREE PROVABLE EXEMPTIONS, and nothing else. Each is decided from the
 * pack's OWN DATA — never from a length, a name or a shape.
 *
 * (1) THE STRING IS THE TERM. `normTerm(s)` is itself one of the terms the scan
 *     reacts to. `'plaque'` in `semanticDrugClaims.anatomicalTargets[40].term`
 *     is the C21 lexicon entry, not a sentence naming one, and injecting the
 *     lexicon is the deliberate decision `tests/redteam3.gate.test.ts` and
 *     `tests/redteam4.gate.test.ts` defend (a generator not shown the lexicon
 *     is failed on a rule it was never told).
 *
 * (2) A SIBLING IN A GATE-SCANNED LEXICON ARRAY. An array in the pack counts as
 *     a lexicon the gate term-scans when at least one of its OWN elements
 *     satisfies (1) — data proving what the array is. Every element of such an
 *     array is then exempt, which is what makes `naturalStates[9] =
 *     'post-menopause'` legal (its sibling `'menopause'` is an enforced
 *     action-paired noun) without a hand-written row. A guidance array can
 *     never qualify: no sentence of guidance equals a lexicon entry, so
 *     `promptRules.compliance` — where the round-2 defect lived — stays fully
 *     scanned however short its sentences are.
 *
 * (3) A SELF-DESCRIBING PATTERN LABEL. `prohibited{Content,Marketing}.patterns`
 *     ships `[regex source, label]` pairs and the prompt renders the LABELS
 *     (the regexes are deliberately not shown — see the header of
 *     `lib/engine/prompts/system.ts`), so `'"buy now" CTA'` reaches the model
 *     and C19 reacts to it. A label is exempt only when its OWN pattern matches
 *     it: that is what makes it an EXAMPLE of the thing it names rather than an
 *     instruction that happens to occupy the label slot. This one has already
 *     paid for itself — `'discount claim'` on the `\d{1,3}% off` pattern is not
 *     matched by that pattern, it is matched by the NEXT one, so the prompt was
 *     handing the model the word `discount` (a C18 promotional-claim term) in
 *     order to forbid a different thing. The label was rewritten to describe
 *     its own regex, which is what it was supposed to do.
 */
function exemptions(pack: KnowledgePack): {
  terms: Set<string>;
  lexiconArrays: Set<string>;
  selfDescribingLabels: Set<string>;
} {
  const all: [string, string][] = [];
  walkStrings(pack, '', all);
  const terms = scannedTerms(pack);
  const lexiconArrays = new Set<string>();
  for (const [path, s] of all) {
    const array = arrayOf(path);
    if (array && terms.has(normTerm(s))) lexiconArrays.add(array);
    // An entry may be an OBJECT (`{ term, … }`), so the array is proved by the
    // entry's own string leaf too — `anatomicalTargets[i].term`.
    const objectArray = arrayOf(path.replace(/\.[^.[\]]+$/, ''));
    if (objectArray && terms.has(normTerm(s))) lexiconArrays.add(objectArray);
  }
  const selfDescribingLabels = new Set<string>();
  for (const [, patterns] of patternBlocks(pack)) {
    for (const [source, label] of patterns) {
      if (source && label && new RegExp(source, 'i').test(label)) selfDescribingLabels.add(label);
    }
  }
  return { terms, lexiconArrays, selfDescribingLabels };
}

/** Every exemption that applies to one pack string, for the assertions below. */
function exemptionOf(
  ex: ReturnType<typeof exemptions>,
  path: string,
  s: string,
): 'term' | 'lexicon-array' | 'pattern-label' | null {
  if (ex.terms.has(normTerm(s))) return 'term';
  const array = arrayOf(path);
  const objectArray = arrayOf(path.replace(/\.[^.[\]]+$/, ''));
  if ((array && ex.lexiconArrays.has(array)) || (objectArray && ex.lexiconArrays.has(objectArray))) {
    return 'lexicon-array';
  }
  if (ex.selfDescribingLabels.has(s)) return 'pattern-label';
  return null;
}

/**
 * EVERY pack string rendered verbatim into a prompt — the safe direction is now
 * the DEFAULT — minus the three provable exemptions above.
 *
 * WHAT THIS REPLACED. The old corpus was "pack strings of EIGHT WORDS OR MORE",
 * so a prohibition of seven words or fewer ("avoid any disease wording", "never
 * name a condition") was never shown to the scan at all. A word count was the
 * only thing between corpus B and that sentence, and a word count is not a
 * reason. The logic is inverted: scanning is the default and an exemption has
 * to be PROVED from the pack's own data, so the failure direction is the safe
 * one at every string length. §B.1 below asserts the widening really is a
 * widening — nothing the old rule scanned may be exempt now.
 */
function packGuidance(pack: KnowledgePack, rendered: string): [string, string][] {
  const all: [string, string][] = [];
  walkStrings(pack, '', all);
  const ex = exemptions(pack);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const [path, s] of all) {
    if (!s.trim() || seen.has(s) || !renderedVerbatim(rendered, s)) continue;
    if (exemptionOf(ex, path, s) !== null) continue;
    seen.add(s);
    out.push([path, s]);
  }
  return out;
}

/**
 * Every STRING LITERAL in a TypeScript source, with code and comments removed.
 *
 * A single stack-based scan: characters are emitted only while inside a quoted
 * or template literal, and a `${` inside a template literal pushes a CODE frame
 * (so the interpolated pack lexicon disappears while any nested template
 * literal inside the expression is still collected). `//` and `/*` are handled
 * in code frames only, so an apostrophe in a comment cannot open a string.
 *
 * REGEX LITERALS are skipped in code frames. `lib/engine/prompts` happens to
 * contain none, which is why the scan could ignore them while it only ever ran
 * over that directory; corpus C now runs over every module that CONTRIBUTES to
 * a prompt, and elsewhere in `lib` a character class like `/[^a-z0-9']+/`
 * carries an apostrophe that would otherwise open a string frame and swallow
 * the rest of the file as "authored text". A `/` starts a regex when the last
 * meaningful code character cannot end an expression (the standard heuristic),
 * and the literal must close on the same line — so a division never opens one.
 */
export function stringLiteralsOf(src: string): string {
  const out: string[] = [];
  interface Frame { kind: 'code' | 'sq' | 'dq' | 'tpl'; depth: number; interp: boolean }
  const stack: Frame[] = [{ kind: 'code', depth: 0, interp: false }];
  /** Last non-whitespace character seen in a CODE frame. */
  let lastCode = '';
  /** The end index of the regex literal starting at `at`, or -1. */
  const regexEnd = (at: number): number => {
    let j = at + 1;
    let inClass = false;
    while (j < src.length) {
      const ch = src[j]!;
      if (ch === '\n') return -1;
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        j++;
        while (j < src.length && /[a-z]/.test(src[j]!)) j++;
        return j;
      }
      j++;
    }
    return -1;
  };
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;
    if (top.kind === 'code') {
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(lastCode)) {
        const end = regexEnd(i);
        if (end > 0) {
          lastCode = '/';
          i = end;
          continue;
        }
      }
      if (!/\s/.test(c)) lastCode = c;
      if (c === "'" || c === '"' || c === '`') {
        stack.push({ kind: c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl', depth: 0, interp: false });
        i++;
        continue;
      }
      if (top.interp) {
        if (c === '{') { top.depth++; i++; continue; }
        if (c === '}') {
          if (top.depth === 0) { stack.pop(); i++; continue; }
          top.depth--; i++; continue;
        }
      }
      i++;
      continue;
    }
    if (c === '\\') { out.push(src.slice(i, i + 2)); i += 2; continue; }
    const closer = top.kind === 'sq' ? "'" : top.kind === 'dq' ? '"' : '`';
    if (c === closer) { stack.pop(); out.push('\n'); i++; continue; }
    if (top.kind === 'tpl' && c === '$' && src[i + 1] === '{') {
      stack.push({ kind: 'code', depth: 0, interp: true });
      i += 2;
      out.push(' ');
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

const PROMPT_DIR = join(process.cwd(), 'lib', 'engine', 'prompts');
const promptSourceFiles = (): string[] => readdirSync(PROMPT_DIR).filter((f) => f.endsWith('.ts'));
const authoredLiterals = (file: string): string =>
  stringLiteralsOf(readFileSync(join(PROMPT_DIR, file), 'utf8'));

// ---------------------------------------------------------------------------
// C.2 — EVERY MODULE THAT CONTRIBUTES TEXT TO A RENDERED PROMPT
// ---------------------------------------------------------------------------

/**
 * Corpus C used to be "`lib/engine/prompts/*.ts`", a DIRECTORY — and a
 * directory is a guess about where prompt text lives, not a property of it.
 * Three modules outside it already write into a prompt:
 *
 *   `lib/engine/optimize.ts`  the repair-round header the loop wraps a prompt
 *                             in ("PREVIOUS ATTEMPT FAILED THESE DETERMINISTIC
 *                             CHECKS …");
 *   `lib/engine/llm.ts`       the reparse instruction appended when a group's
 *                             first answer will not parse;
 *   `lib/engine/backendSanitize.ts` and friends, wherever a helper's own
 *                             literal reaches a rendered block.
 *
 * A prohibition constant defined in any of them, or in a module that does not
 * exist yet, was outside all three corpora. Membership is now a MEASURED
 * property: a module is scanned when one of its own string literals is rendered
 * verbatim into a prompt this engine actually produced. Nothing is listed.
 */
const SOURCE_ROOTS = ['lib', 'app'];

function tsSourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) tsSourcesUnder(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The literal SEGMENT of `source` that proves it contributes to `rendered`, or
 * `null`.
 *
 * The three-word floor is a PRECISION floor on DISCOVERY, not a scope filter on
 * scanning: it stops a two-word helper string from enrolling a module by
 * coincidence. It cannot hide a prohibition — a prohibition is a clause, and
 * once a module is enrolled, EVERY literal in it is scanned regardless of
 * length. The always-scanned `lib/engine/prompts/*.ts` set is unioned in on top,
 * so this can only ever add modules.
 *
 * `packText` rules out the other coincidence: a phrase that is in the prompt
 * BECAUSE THE PACK PUT IT THERE proves nothing about the module that happens to
 * contain the same words (`lib/ingest/labelMap.ts` maps scraped attribute
 * labels, so it holds `country of origin` — which reaches the prompt from the
 * attribute schema, not from it). Text whose origin is the pack is corpus B's
 * job, and corpus B scans all of it.
 *
 * Escapes are split as well as real newlines: a source template writes `\n`,
 * and that IS a line break in the rendered prompt.
 */
function contributedSegment(source: string, rendered: string, packText: string): string | null {
  for (const raw of stringLiteralsOf(source).split(/\\n|\n/)) {
    const segment = raw.trim();
    if (segment.length < 10 || segment.split(/\s+/).length < 3) continue;
    if (!renderedVerbatim(rendered, segment)) continue;
    if (renderedVerbatim(packText, segment)) continue;
    return segment;
  }
  return null;
}

/**
 * Every prompt this engine really sends, captured at the LLM boundary — the
 * plain generation round, a REPAIR round (so `optimize`'s failure-context
 * header is present) and a REPARSE (so `llm.ts`'s retry instruction is).
 *
 * The failure-context PAYLOAD is a marker, not real gate text, and that is the
 * one deliberate boundary of this corpus: `[C6] bullets[2]: … → FIX: Remove
 * banned disease term 'x'` is a REACTION to copy the model already wrote and
 * was already failed for. It names the offending term because a repair
 * instruction cannot be expressed otherwise, it exists only in a round that has
 * already failed, and the gate re-runs afterwards, so an echo is caught
 * deterministically instead of shipping. What corpora A/B/C are about is the
 * STANDING text every prompt carries whatever the model wrote — which is what
 * a model paraphrases into house style, and which is where both live defects
 * were found.
 */
const PAYLOAD_MARKER = 'ZZFAILURECONTEXTPAYLOADZZ';

async function capturedPrompts(pack: KnowledgePack): Promise<string> {
  const seen: string[] = [];
  let reparsed = false;
  const spy: LlmClient = async (req) => {
    seen.push(req.system, req.user);
    if (!reparsed && req.groupName === 'qa') {
      reparsed = true;
      return 'this is not JSON';
    }
    return mockLlm(req);
  };
  const base = await optimize(EMPTY_SNAPSHOT, pack, spy);
  await optimize(EMPTY_SNAPSHOT, pack, spy, {
    groups: ['bullets', 'description', 'title', 'aplus', 'images', 'qa', 'attributes', 'backend', 'keywords'],
    base,
    failureContext: {
      bullets: PAYLOAD_MARKER, description: PAYLOAD_MARKER, title: PAYLOAD_MARKER,
      aplus: PAYLOAD_MARKER, images: PAYLOAD_MARKER, qa: PAYLOAD_MARKER,
      attributes: PAYLOAD_MARKER, backend: PAYLOAD_MARKER, keywords: PAYLOAD_MARKER,
    },
  });
  return seen.join('\n');
}

// ===========================================================================
// A — TASK INSTRUCTIONS (round-1 scope, round-2 vocabulary)
// ===========================================================================

describe.each(PACK_IDS)('A — %s task instructions name no term the gate reacts to', (packId) => {
  const pack = loadPack(packId);
  const prompts = renderedPrompts(pack, snapshot, 'field | required | example').filter(
    ([name]) => name !== 'system',
  );

  it.each(prompts)('the %s task instruction carries no banned vocabulary', (_group, prompt) => {
    const instruction = taskInstruction(prompt);
    expect(instruction.length).toBeGreaterThan(0);
    expect(surfaceHits(pack, instruction)).toEqual([]);
  });

  it.each(prompts)('the %s task instruction names no bare therapeutic verb', (_group, prompt) => {
    const instruction = taskInstruction(prompt);
    expect(instruction.length).toBeGreaterThan(0);
    expect(verbHits(pack, instruction)).toEqual([]);
  });
});

// ===========================================================================
// B — PACK GUIDANCE RENDERED INTO A PROMPT  (where the round-2 defect lived)
// ===========================================================================

describe.each(PACK_IDS)('B — %s pack guidance rendered into a prompt', (packId) => {
  const pack = loadPack(packId);
  const rendered = renderedPrompts(pack, EMPTY_SNAPSHOT, schemaFieldsOf(pack))
    .map(([, p]) => p)
    .join('\n');
  const guidance = packGuidance(pack, rendered);

  it('the corpus is real (this test cannot pass by scanning nothing)', () => {
    expect(guidance.length).toBeGreaterThanOrEqual(20);
    const paths = guidance.map(([p]) => p);
    // The exact path the round-2 defect lived at, plus one from each of the
    // other pack areas that reach a prompt.
    // Path SUFFIX: the supplements compliance module is reachable both as
    // `compliancePack` and as `crossCheckCompliancePacks[0]` (same object), and
    // the walk records whichever it reaches first.
    expect(paths.some((p) => p.endsWith('promptRules.compliance[0]'))).toBe(true);
    expect(paths.some((p) => p.startsWith('rules.imageArchitecture.slots'))).toBe(true);
    expect(paths.some((p) => p.startsWith('rules.bulletArchitecture'))).toBe(true);
    expect(paths.some((p) => p.startsWith('attributeSchema'))).toBe(true);
  });

  it('no rendered guidance string names a term the gate reacts to', () => {
    const offenders = guidance.flatMap(([path, s]) =>
      surfaceHits(pack, s).map((h) => `${path}: ${h} — ${s.slice(0, 120)}`),
    );
    expect(offenders).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // B.1 — THE INVERSION IS A WIDENING, AND IT CATCHES THE SHORT PROHIBITION
  // -------------------------------------------------------------------------

  it('every string the OLD eight-word rule scanned is STILL scanned', () => {
    const ex = exemptions(pack);
    const all: [string, string][] = [];
    walkStrings(pack, '', all);
    const lost = all
      .filter(([, s]) => isGuidanceShaped(s) && renderedVerbatim(rendered, s))
      .filter(([path, s]) => exemptionOf(ex, path, s) !== null)
      .map(([path, s]) => `${path} (${exemptionOf(ex, path, s)}): ${s.slice(0, 80)}`);
    expect(
      lost,
      'an exemption is hiding a string the previous, weaker rule scanned — the change must only ever widen the corpus',
    ).toEqual([]);
  });

  it('the corpus now contains strings the OLD rule could not see', () => {
    const short = guidance.filter(([, s]) => !isGuidanceShaped(s));
    expect(
      short.length,
      'if nothing under eight words is scanned, the inversion bought nothing',
    ).toBeGreaterThan(0);
  });

  /**
   * THE CANARY FOR EDGE (1). A SIX-word prohibition, planted at the exact path
   * the round-2 defect lived at, rendered through the real prompt builders.
   *
   * It is asserted BOTH ways: invisible to the old eight-word classifier (so
   * the escape was real, not hypothetical) and caught by the new one.
   */
  it('a SIX-word prohibition in the pack escapes the old rule and FAILS the new one', () => {
    const SHORT_PROHIBITION = 'Never mention any disease or symptom';
    expect(SHORT_PROHIBITION.split(/\s+/).length).toBe(6);
    expect(isGuidanceShaped(SHORT_PROHIBITION), 'the old rule could not see this').toBe(false);

    const mutated = JSON.parse(JSON.stringify(loadPack(packId))) as KnowledgePack;
    mutated.compliancePack!.promptRules = {
      ...mutated.compliancePack!.promptRules,
      compliance: [...(mutated.compliancePack!.promptRules?.compliance ?? []), SHORT_PROHIBITION],
    };
    const mutatedRender = renderedPrompts(mutated, EMPTY_SNAPSHOT, schemaFieldsOf(mutated))
      .map(([, p]) => p)
      .join('\n');
    expect(mutatedRender, 'the sentence must really reach a prompt').toContain(SHORT_PROHIBITION);

    const offenders = packGuidance(mutated, mutatedRender).flatMap(([path, s]) =>
      surfaceHits(mutated, s).map((h) => `${path}: ${h}`),
    );
    // The path it was planted at — the last row of the compliance rules.
    expect(offenders.join(' ')).toContain('promptRules.compliance[');
    expect(offenders.join(' ')).toContain("'disease'");
  });
});

// ===========================================================================
// C — AUTHORED STRING LITERALS IN lib/engine/prompts/*.ts
// ===========================================================================

describe('C — the prompt modules author no sentence that names a reacted term', () => {
  const pack = loadPack('supplements');

  it('the extractor really extracts (non-vacuity)', () => {
    const files = promptSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);
    const system = authoredLiterals('system.ts');
    // A sentence that IS in the prompt survives …
    expect(system).toContain('Write every benefit as a structure/function state');
    // … the interpolated lexicon does NOT (that is the whole mechanism) …
    expect(system).not.toContain('diabetes');
    // … and neither does the comment prose, which discusses the defect freely.
    expect(system).not.toContain('NO cap on the injected disease-noun list');
  });

  it.each(promptSourceFiles())('%s names no term the gate reacts to', (file) => {
    expect(surfaceHits(pack, authoredLiterals(file))).toEqual([]);
  });

  it('the extractor skips REGEX literals (an apostrophe in a character class)', () => {
    // Before corpus C left `lib/engine/prompts`, this construct did not exist in
    // anything it read; the widened set below is full of it. The `'` inside the
    // class must not open a string frame and swallow the code after it.
    const src = "const RE = /[^a-z0-9']+/g;\nconst KEEP = 'real authored text';\n";
    const out = stringLiteralsOf(src);
    expect(out).toContain('real authored text');
    expect(out).not.toContain(']+/g;');
  });
});

// ===========================================================================
// C.2 — EVERY MODULE THAT CONTRIBUTES TEXT TO A RENDERED PROMPT (derived)
// ===========================================================================

describe('C.2 — prompt text has no home outside the scanned set', () => {
  const pack = loadPack('supplements');
  let corpus = '';
  let contributors: [string, string][] = [];

  beforeAll(async () => {
    corpus = await capturedPrompts(pack);
    const packStrings: [string, string][] = [];
    walkStrings(pack, '', packStrings);
    const packText = packStrings.map(([, s]) => s).join('\n');
    contributors = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of tsSourcesUnder(join(process.cwd(), root))) {
        const segment = contributedSegment(readFileSync(file, 'utf8'), corpus, packText);
        if (segment !== null) {
          contributors.push([file.slice(process.cwd().length + 1).replace(/\\/g, '/'), segment]);
        }
      }
    }
  });

  it('the capture is real: it holds a plain prompt, a REPAIR header and a REPARSE line', () => {
    expect(corpus).toContain('TASK:');
    expect(corpus).toContain('PREVIOUS ATTEMPT FAILED THESE DETERMINISTIC CHECKS');
    expect(corpus).toContain('your previous output was invalid');
    // …and the failure payload is the marker, so no gate `fix` text is in here.
    expect(corpus).toContain(PAYLOAD_MARKER);
  });

  it('discovery finds the prompt modules AND the contributors outside them', () => {
    const files = contributors.map(([f]) => f);
    expect(files.some((f) => f.startsWith('lib/engine/prompts/'))).toBe(true);
    // The two modules the old directory-shaped corpus could never have covered.
    expect(files, 'the repair-round header lives here').toContain('lib/engine/optimize.ts');
    expect(files, 'the reparse instruction lives here').toContain('lib/engine/llm.ts');
  });

  it('every discovered contributor names no term the gate reacts to', () => {
    const offenders = contributors.flatMap(([file, segment]) => {
      const literals = stringLiteralsOf(readFileSync(join(process.cwd(), file), 'utf8'));
      return surfaceHits(pack, literals).map((h) => `${file}: ${h} (enrolled by: ${segment.slice(0, 60)})`);
    });
    expect(offenders).toEqual([]);
  });

  /**
   * THE CANARY FOR EDGE (2), run through the same two functions the real sweep
   * uses: a prohibition constant in a module that is NOT under
   * `lib/engine/prompts` is discovered by its rendered literal and then flagged.
   */
  it('a prohibition constant in a NON-prompt module is discovered and FAILS', () => {
    const SENTENCE = 'Never name a disease anywhere in the copy';
    const source = `export const RULE = '${SENTENCE}';\nexport const N = 5 / 2;\n`;
    const renderedSomewhere = `TASK: write the bullets.\n- ${SENTENCE}\nReturn JSON.`;

    expect(
      contributedSegment(source, renderedSomewhere, ''),
      'the module must be ENROLLED by its own rendered literal',
    ).toBe(SENTENCE);
    expect(surfaceHits(pack, stringLiteralsOf(source)).join(' ')).toContain("'disease'");

    // …and the same constant, NOT rendered, enrolls nothing (no false positives).
    expect(contributedSegment(source, 'TASK: write the bullets.\nReturn JSON.', '')).toBeNull();
  });
});

// ===========================================================================
// D — THE GENERATED BRIEF (round-1 output scan, kept)
// ===========================================================================

describe('D — the generated image plan and video brief carry no banned vocabulary', () => {
  it.each(PACK_IDS)('%s: imagePlan + videoBrief are clean', async (packId) => {
    const pack = loadPack(packId);
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.imagePlan.length).toBeGreaterThanOrEqual(8);
    const offenders: string[] = [];
    const scan = (field: string, text: string): void => {
      for (const hit of surfaceHits(pack, text)) offenders.push(`${field}: ${hit} — ${text}`);
    };
    for (const [i, t] of (listing.videoBrief?.onScreenText ?? []).entries()) {
      scan(`videoBrief.onScreenText[${i}]`, t);
    }
    for (const [i, t] of (listing.videoBrief?.shots ?? []).entries()) scan(`videoBrief.shots[${i}]`, t);
    scan('videoBrief.notes', String(listing.videoBrief?.notes ?? ''));
    listing.imagePlan.forEach((slot, i) => {
      for (const key of ['purpose', 'spec', 'notes', 'altText'] as const) {
        scan(`imagePlan[${i}].${key}`, String(slot?.[key] ?? ''));
      }
    });
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// E — THE GUARD MUST BE ABLE TO FAIL
// ===========================================================================

/** The two sentences the live runs actually produced / were traced to. */
const ROUND2_PROMPT_SENTENCE =
  'NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or symptom.';
const ROUND2_IMAGE_NOTE =
  'Hold the whole bottle in frame rather than a single capsule, avoid any disease or symptom wording, keep the layout airy';
const ROUND2_VIDEO_NOTE =
  'Shoot the bottle rather than a single capsule, avoid any disease or symptom wording throughout, end on a clean pack shot';

describe('E — non-vacuity: every tier rejects the text that provoked it', () => {
  const pack = loadPack('supplements');

  it('the derived set contains the regulatory meta-vocabulary (not hand-listed)', () => {
    const terms = new Set(tiers(pack).surface.map((t) => t.term.toLowerCase()));
    for (const w of ['disease', 'diagnose', 'treat', 'cure', 'prevent', 'drug', 'medical']) {
      expect(terms, `derived set must contain '${w}'`).toContain(w);
    }
    const meta = tiers(pack).surface.filter((t) => t.label === 'regulatory meta-term');
    expect(meta.length).toBeGreaterThanOrEqual(6);
  });

  it('the ROUND-2 prompt sentence is caught by the surface scan', () => {
    const hits = surfaceHits(pack, ROUND2_PROMPT_SENTENCE);
    expect(hits.join(' ')).toContain("'disease'");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * END-TO-END MUTATION. Put the old sentence back into the pack, re-render
   * every prompt through the real builders, and assert corpus B catches it.
   * This is the proof that the extension closes the hole through the actual
   * rendering path rather than against a hard-coded string.
   */
  it('re-introducing the old sentence into the pack FAILS corpus B', () => {
    const mutated = JSON.parse(JSON.stringify(loadPack('supplements'))) as KnowledgePack;
    mutated.compliancePack!.promptRules = {
      ...mutated.compliancePack!.promptRules,
      compliance: [ROUND2_PROMPT_SENTENCE],
    };
    const rendered = renderedPrompts(mutated, EMPTY_SNAPSHOT, schemaFieldsOf(mutated))
      .map(([, p]) => p)
      .join('\n');
    expect(rendered).toContain(ROUND2_PROMPT_SENTENCE);
    const offenders = packGuidance(mutated, rendered).flatMap(([path, s]) =>
      surfaceHits(mutated, s).map((h) => `${path}: ${h}`),
    );
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders.join(' ')).toContain('promptRules.compliance[0]');
    expect(offenders.join(' ')).toContain("'disease'");
  });

  it('a prohibition sentence in a prompt MODULE would fail corpus C', () => {
    // The literal `system.ts` used to carry, run through the same scan the
    // per-file test uses.
    const old = '- NEVER use disease/condition nouns anywhere. The deterministic gate scans for ALL of these on EVERY surface: ';
    expect(surfaceHits(pack, stringLiteralsOf('const x = `' + old + '`;')).join(' ')).toContain("'disease'");
  });

  it('the ROUND-1 instruction that provoked the echoed verb IS caught', () => {
    const hits = verbHits(pack, 'describe what each ingredient is, not what it treats');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join(' ')).toContain('treat');
    // …and it is now ALSO caught by the surface tier, on every corpus, because
    // `treat` is derived regulatory meta-vocabulary.
    expect(surfaceHits(pack, 'not what it treats').join(' ')).toContain("'treat'");
  });

  it('the ROUND-1 brief that started this ("avoid disease words") IS caught', () => {
    const hits = surfaceHits(
      pack,
      'Show brand history in neutral factual terms, avoid disease words or clinical claims',
    );
    expect(hits.join(' ')).toContain("C6 disease noun 'disease'");
    expect(hits.join(' ')).toContain("C22 abnormality marker 'clinical'");
  });

  it.each([
    ['imagePlan[1].notes', ROUND2_IMAGE_NOTE],
    ['videoBrief.notes', ROUND2_VIDEO_NOTE],
  ])('the ROUND-2 %s IS caught by the output scan', (_field, text) => {
    expect(surfaceHits(pack, text).join(' ')).toContain("'disease'");
  });
});

// ===========================================================================
// F — THE TWO FAILING SHAPES, RE-RUN THROUGH THE REAL GATE
// ===========================================================================

/**
 * ARE `imagePlan[].notes` AND `videoBrief.notes` THE RIGHT SURFACES FOR C6?
 * Decided here rather than left implicit, because the cheap way to make this
 * defect disappear would have been to stop scanning them.
 *
 * THEY STAY FULLY SCANNED. Three reasons, in order of weight:
 *
 *  1. They are not internal. `lib/export/markdown.ts` renders every
 *     `imagePlan[].notes` cell and `videoBrief.notes` into the ship sheet the
 *     operator hands to a photographer or an agency, and `notes` is defined by
 *     the prompt itself as "copy and layout guidance" — the field that says
 *     what the OVERLAY says. A condition name in a production note is the
 *     instruction that puts that word on the image, and marketplace
 *     enforcement OCRs images. The word does not become safe by sitting one
 *     step upstream of the pixels.
 *  2. The project already answered this question the same way, for the same
 *     pair of fields, one check over. `rules.outputHygiene._asciiExemptSurfacesComment`
 *     records the N1 decision verbatim: "videoBrief.shots / .notes are
 *     production direction rendered INTO those display strings, so exempting
 *     them would just move the same character one field upstream." Answering
 *     it differently for C6 would leave the gate incoherent about what a
 *     production note is.
 *  3. Narrowing a checker so a defect stops being reported is mutating the
 *     checker to pass. The defect was in the PROMPT, and the prompt is what
 *     changed.
 *
 * So C6 is untouched, and these tests pin the surfaces so a future narrowing
 * has to delete an explicit assertion rather than quietly drop a field.
 */
describe('F — the live-run shapes of B00WNDG7V8, re-run', () => {
  const pack = loadPack('supplements');
  const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
  let clean: OptimizedListing;

  beforeAll(async () => {
    clean = await optimize(snapshot, pack, mockLlm);
  });

  const withNotes = (fn: (l: OptimizedListing) => void): OptimizedListing => {
    const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
    fn(copy);
    return copy;
  };

  it('BEFORE: the echoed imagePlan[1].notes fails C6 on that exact field', () => {
    const l = withNotes((x) => {
      x.imagePlan[1]!.notes = ROUND2_IMAGE_NOTE;
    });
    const hit = runGate(l, pack, ctx).failures.find(
      (f) => f.checkId === 'C6' && f.field === 'imagePlan[1].notes',
    );
    expect(hit, 'C6 must still see a production note').toBeDefined();
    expect(hit!.context).toContain('disease');
  });

  it('BEFORE: the echoed videoBrief.notes fails C6 on that exact field', () => {
    const l = withNotes((x) => {
      x.videoBrief!.notes = ROUND2_VIDEO_NOTE;
    });
    const hit = runGate(l, pack, ctx).failures.find(
      (f) => f.checkId === 'C6' && f.field === 'videoBrief.notes',
    );
    expect(hit, 'C6 must still see a video production note').toBeDefined();
    expect(hit!.context).toContain('disease');
  });

  it('AFTER: the brief the current prompts produce carries no C6 failure at all', () => {
    const failures = runGate(clean, pack, ctx).failures.filter((f) => f.checkId === 'C6');
    expect(failures).toEqual([]);
    // …and the two fields really exist to have been scanned (non-vacuity).
    expect(String(clean.imagePlan[1]?.notes ?? '').length).toBeGreaterThan(0);
    expect(String(clean.videoBrief?.notes ?? '').length).toBeGreaterThan(0);
  });

  it('the notes fields are pinned as C6 customer surfaces (decision, not accident)', () => {
    const fields = customerSurfaces(clean).map(([f]) => f);
    expect(fields).toContain('videoBrief.notes');
    expect(fields).toContain('imagePlan[0].notes');
    // The surfaces that unambiguously ship stay pinned in the same breath.
    expect(fields).toContain('imagePlan[0].altText');
    expect(fields.some((f) => f.startsWith('videoBrief.onScreenText'))).toBe(true);
    expect(fields.some((f) => f.startsWith('videoBrief.shots'))).toBe(true);
  });
});
