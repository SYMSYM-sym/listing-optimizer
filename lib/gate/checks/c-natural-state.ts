import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import {
  deobfuscatedVariants,
  normalize,
  scanTerms,
  subtractDisclaimers,
  type NegationOptions,
  type TermMatch,
} from '../util';
import { diseaseActionVerbs, reachableCompliancePacks } from './pack';
import {
  allGeneratedSurfaces,
  disclaimerVariantsOf,
  diseaseNegationOptions,
  fail,
  sentenceAround,
} from './shared';

/**
 * C22 — NATURAL STATE / ABNORMALITY.
 *
 * The doctrine, taken from the FDA structure/function rule (21 CFR 101.93(f)
 * and (g)) and its Small Entity Compliance Guide, and encoded here rather than
 * approximated by a longer word list:
 *
 *  1. A structure/function claim is LAWFUL: a statement describing the role of
 *     a nutrient or ingredient in affecting the NORMAL structure or function of
 *     the body, or the mechanism by which it maintains that structure/function.
 *  2. A DISEASE claim is unlawful: any claim to diagnose, treat, cure, mitigate
 *     or prevent a disease. That half is C6's lexicon and is untouched here.
 *  3. NATURAL STATES ARE NOT DISEASES. Ageing, the menopause, the menstrual
 *     cycle, adolescence and pregnancy are natural states or processes, not
 *     diseases — though each can be ASSOCIATED with abnormal conditions that
 *     are. FDA's line is: NORMAL SYMPTOMOLOGY is permissible, an ABNORMAL
 *     condition is not.
 *  4. QUALIFIERS decide which side of that line a sentence falls on. "mild",
 *     "occasional", "normal", "already within the normal range" and the
 *     "associated with [natural state]" connector keep a claim lawful;
 *     "severe", "chronic", "clinical", "pathological", "disorder", "disease",
 *     "syndrome" and "diagnosed" push it over.
 *
 * THE THREE RULES, all pack-driven (`compliancePack.naturalStates`,
 * `normalSymptomologyNouns`, `abnormalityMarkers`, `lawfulQualifiers`,
 * `naturalStateSafePhrases`, `naturalStateProximityWindow`). This module holds
 * the window arithmetic and the precedence, never a word:
 *
 *  R1 ABNORMALITY BESIDE A NATURAL STATE — an abnormality marker within
 *     `window` characters of a natural state / normal symptom names the
 *     ABNORMAL form of that state, which is a disease claim.
 *  R2 TWO MARKERS — two DIFFERENT abnormality markers inside the same window
 *     name an abnormal condition outright, with no natural state needed.
 *  R3 THERAPEUTIC ACTION ON A NATURAL STATE — a therapeutic-action verb (the
 *     pack's own class, `diseaseVerbs` + inflected `diseaseActionVerbRoots`) in
 *     the SAME SENTENCE as a natural state is a disease claim, UNLESS a lawful
 *     qualifier sits within `window` characters of the state with no action
 *     verb between the two. That adjacency requirement is what separates
 *     FDA's own worked example from a claim that merely happens to share a
 *     sentence with a safe-harbour word.
 *
 * PRECEDENCE, which is the whole point of the check and is asserted directly in
 * `tests/naturalStates.gate.test.ts`:
 *
 *     disease noun  >  abnormality marker  >  lawful qualifier
 *
 *  - a listed DISEASE NOUN is failed by C6 whatever surrounds it. C22 never
 *    suppresses, exempts or otherwise reaches C6, so a lawful qualifier can
 *    never launder a named disease;
 *  - an ABNORMALITY MARKER (R1/R2) is evaluated BEFORE the qualifier escape and
 *    is never subject to it — a marker beats a qualifier by construction;
 *  - the LAWFUL QUALIFIER escape exists only inside R3.
 *
 * COVERAGE, stated plainly and not overstated: this is a proximity heuristic
 * over de-obfuscated text, not a parser. It cannot tell who the subject of a
 * sentence is, and a marker that sits inside a `naturalStateSafePhrases` span
 * (research vocabulary, consult-a-professional warnings) is blanked before the
 * scan the same way C21 blanks its safe context.
 *
 * THE ONE PLACE THE SUBJECT IS INFERRED STRUCTURALLY is the mandated
 * consult-a-professional SAFETY WARNING, which the attribute template REQUIRES
 * the listing to carry: see `safetyWarningRanges`. It scopes R1/R2 by
 * recognising the warning's grammatical shape from pack cues, which is what
 * replaced three rounds of enumerating one more wording of the same warning.
 */

const CHECK_ID = 'C22';

const DEFAULT_WINDOW = 40;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface NaturalStateConfig {
  /**
   * R1's noun side: every protected noun — natural states, the normal
   * symptomology whose unqualified form names a disease, and the normal
   * symptomology a structure/function claim may lawfully address.
   */
  marked: string[];
  /**
   * R3's noun side, deliberately NARROWER: natural states plus the symptom
   * words whose UNQUALIFIED form names a disease. Acting on an ordinary normal
   * symptom is exactly what a lawful structure/function claim does, so
   * `abnormalOnlySymptomNouns` are checked for abnormality (R1) and nothing
   * else.
   */
  actionable: string[];
  markers: string[];
  qualifiers: string[];
  verbs: string[];
  safe: RegExp | null;
  window: number;
  neg: NegationOptions;
  /**
   * ADVISORY-SENTENCE escape for R3 (`compliancePack.advisoryCueVerbs` /
   * `advisoryProfessionalNouns` — pack data, false-positive reducer). See
   * `advisoryEscapes` for the exact rule and its deliberate limits.
   */
  advisoryCues: string[];
  advisoryProfessionals: string[];
  /**
   * The CONDITION half of the SAFETY-WARNING CONSTRUCTION
   * (`compliancePack.advisoryConditionCues` — pack data). See
   * `safetyWarningRanges`.
   */
  conditionCues: string[];
}

const uniq = (lists: (string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => l ?? []).map((t) => t.trim()).filter(Boolean)),
];

/** Longest-first alternation over pack tokens; inner whitespace stays flexible. */
function alternation(tokens: string[]): RegExp | null {
  const cleaned = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (cleaned.length === 0) return null;
  return new RegExp(cleaned.map((t) => escapeRe(t).replace(/\s+/g, '\\s+')).join('|'), 'gi');
}

const CONFIG_CACHE = new WeakMap<KnowledgePack, NaturalStateConfig | null>();

/**
 * ONE config, unioned over every compliance module the pack can reach — its own
 * plus every cross-check module the assembler attached, exactly like the C6
 * lexicon union and the C21 shape union. The rationale is the same: the
 * doctrine does not change with the product.
 */
function configOf(pack: KnowledgePack): NaturalStateConfig | null {
  const cached = CONFIG_CACHE.get(pack);
  if (cached !== undefined) return cached;
  const packs: CompliancePack[] = reachableCompliancePacks(pack);
  const actionable = uniq([
    ...packs.map((cp) => cp.naturalStates),
    ...packs.map((cp) => cp.normalSymptomologyNouns),
  ]);
  const marked = uniq([actionable, ...packs.map((cp) => cp.abnormalOnlySymptomNouns)]);
  const markers = uniq(packs.map((cp) => cp.abnormalityMarkers));
  let config: NaturalStateConfig | null = null;
  if (marked.length > 0 || markers.length > 0) {
    config = {
      marked,
      actionable,
      markers,
      qualifiers: uniq(packs.map((cp) => cp.lawfulQualifiers)),
      verbs: uniq(packs.map((cp) => diseaseActionVerbs(cp))),
      safe: alternation(
        uniq([
          ...packs.map((cp) => cp.naturalStateSafePhrases),
          ...packs.map((cp) => cp.negationMetaPhrases),
          ...packs.map((cp) => cp.benignContextPhrases),
        ]),
      ),
      window: Math.max(
        DEFAULT_WINDOW,
        ...packs.map((cp) =>
          typeof cp.naturalStateProximityWindow === 'number' && cp.naturalStateProximityWindow > 0
            ? cp.naturalStateProximityWindow
            : 0,
        ),
      ),
      neg: diseaseNegationOptions(pack.compliancePack ?? packs[0]!),
      advisoryCues: uniq(packs.map((cp) => cp.advisoryCueVerbs)),
      advisoryProfessionals: uniq(packs.map((cp) => cp.advisoryProfessionalNouns)),
      conditionCues: uniq(packs.map((cp) => cp.advisoryConditionCues)),
    };
  }
  CONFIG_CACHE.set(pack, config);
  return config;
}

/**
 * Safety spans blanked out, LENGTH PRESERVED so every proximity window still
 * lines up with the original text — the same technique C21 and the allergen
 * compound exclusions use.
 */
function blankSafeSpans(text: string, safe: RegExp | null): string {
  if (!safe) return text;
  safe.lastIndex = 0;
  return text.replace(safe, (m) => ' '.repeat(m.length));
}

const endOf = (m: TermMatch): number => m.index + m.term.length;

/** Character gap between two matches; negative when they overlap. */
function gapBetween(a: TermMatch, b: TermMatch): number {
  return a.index <= b.index ? b.index - endOf(a) : a.index - endOf(b);
}

/**
 * How much text either side of the matched pair the reported context carries.
 */
const CONTEXT_PAD = 20;

/** A character that can sit INSIDE a word, so cutting beside it splits one. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * THE REPORTED CONTEXT IS CUT ON WORD BOUNDARIES.
 *
 * The pad is a fixed character count, so its edge lands wherever it lands — and
 * on a live run it landed one character into the first word of the sentence:
 *
 *   C22 | description | "f you are pregnant, nursing, have a known medical
 *       |             |  condition, or take medication"
 *
 * The finding was real (see the safe-phrase note in the pack) but the evidence
 * an operator was shown opened mid-word, which reads like a broken tool and
 * costs the reader a second guessing which word was cut. A context is EVIDENCE:
 * it must quote the copy, and a fragment of a word is not a quote of it. Each
 * edge is therefore pushed OUTWARD to the nearest boundary — outward, never
 * inward, so widening the quote can never drop a character the finding rests
 * on. Nothing about detection changes: this function only formats what R1/R2
 * already decided.
 */
const snapBack = (text: string, i: number): number => {
  let k = Math.max(0, i);
  while (k > 0 && WORD_CHAR.test(text[k - 1]!)) k -= 1;
  return k;
};

const snapForward = (text: string, i: number): number => {
  let k = Math.min(text.length, i);
  while (k < text.length && WORD_CHAR.test(text[k]!)) k += 1;
  return k;
};

const spanOf = (text: string, a: TermMatch, b: TermMatch): string => {
  const start = Math.min(a.index, b.index);
  const end = Math.max(endOf(a), endOf(b));
  return text.slice(snapBack(text, start - CONTEXT_PAD), snapForward(text, end + CONTEXT_PAD)).trim();
};

interface Hit {
  context: string;
  fix: string;
}

/**
 * R3's escape hatch: a lawful qualifier ADJACENT to the state — inside the
 * proximity window with no therapeutic-action verb between the two.
 *
 * Adjacency, not mere co-occurrence, is deliberate: a sentence that opens with
 * a safe-harbour word and then makes a therapeutic claim
 * ("… and cures <state>") must not be laundered by the opening word, and the
 * intervening-verb test is the same positive-evidence rule the negation guard
 * in `util.hasNegationContext` already applies.
 */
function qualifierProtects(
  text: string,
  state: TermMatch,
  qualifiers: TermMatch[],
  verbs: string[],
  window: number,
): boolean {
  for (const q of qualifiers) {
    if (gapBetween(state, q) > window) continue;
    const start = Math.min(endOf(state), endOf(q));
    const end = Math.max(state.index, q.index);
    const between = end > start ? text.slice(start, end) : '';
    if (between && scanTerms(between, verbs).length > 0) continue;
    return true;
  }
  return false;
}

/**
 * How far AFTER an advisory cue the professional noun may sit for the pair to
 * read as one advisory phrase ("talk with … a physician"). Characters.
 */
const ADVISORY_PAIR_GAP = 60;

/** Clause segmentation for the advisory DENIAL rule — commas always break. */
const CLAUSE_SEGMENT_RE = /[,;:.!?()\n\u2014\u2013]/;

/** The comma/clause-bounded segment `index` sits in. */
function clauseSegmentAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !CLAUSE_SEGMENT_RE.test(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && !CLAUSE_SEGMENT_RE.test(text[end]!)) end += 1;
  return text.slice(start, end);
}

/**
 * R3's ADVISORY escape — the mandated consult-a-professional safety warning is
 * not a product claim and must NEVER be flagged.
 *
 * "Women who are pregnant or nursing, and anyone currently taking medication
 * or managing a health concern, should talk with a physician before adding any
 * new daily capsule to their routine" pairs the natural state "nursing" with
 * the therapeutic-action verb "managing" in one sentence, which is exactly
 * R3's shape — but the sentence's main clause is an ADVISORY, not a claim.
 *
 * The rule, chosen over a literal phrase list so every paraphrase is covered:
 *
 *  1. the SENTENCE (read from the UNBLANKED text, so a safe-phrase span cannot
 *     hide the cue from this test) contains an advisory CUE
 *     (`advisoryCueVerbs`) followed within `ADVISORY_PAIR_GAP` characters by a
 *     PROFESSIONAL noun (`advisoryProfessionalNouns`) — "should talk with a
 *     physician", "please consult your healthcare provider";
 *  2. AND no therapeutic-action verb shares the STATE's own comma-bounded
 *     clause segment. This is the anti-laundering half: in the mandated
 *     warning the verb ("managing a health concern") and the state ("pregnant
 *     or nursing") sit in DIFFERENT comma segments, while in a claim the verb
 *     acts on the state directly — "reverses aging, talk to your doctor"
 *     keeps "reverses" in the same segment as "aging" and is DENIED.
 *
 * Scope, stated exactly: this escapes R3 alone. R1/R2 (abnormality markers),
 * the C6 disease-noun scan and the C6 action-paired tier never consult it, so
 * "manages menopause symptoms — talk with your physician" still fails C6.
 */
function advisoryEscapes(text: string, state: TermMatch, cfg: NaturalStateConfig): boolean {
  if (cfg.advisoryCues.length === 0 || cfg.advisoryProfessionals.length === 0) return false;
  const sentence = sentenceAround(text, state.index);
  const cues = scanTerms(sentence, cfg.advisoryCues);
  if (cues.length === 0) return false;
  const pros = scanTerms(sentence, cfg.advisoryProfessionals);
  const paired = cues.some((c) =>
    pros.some(
      (p) => p.index >= c.index && p.index - (c.index + c.term.length) <= ADVISORY_PAIR_GAP,
    ),
  );
  if (!paired) return false;
  return scanTerms(clauseSegmentAround(text, state.index), cfg.verbs).length === 0;
}

/**
 * THE SAFETY-WARNING CONSTRUCTION — the structural answer to a false positive
 * that three enumerative point-fixes failed to close.
 *
 * The mandated consult-a-professional warning is a REQUIRED field of the
 * attribute template, so the generator must emit it and it flows into the
 * customer-facing copy. It is not an open set of phrasings, it is one GRAMMATICAL
 * SHAPE: a CONDITION clause enumerating states the READER may be in, governed by
 * a RECOMMENDATION to consult a professional.
 *
 *   "Consult your healthcare provider before use IF pregnant, nursing, taking
 *    medication, or managing a MEDICAL CONDITION, and keep out of reach."
 *
 * R1 read the abnormality marker "medical condition" as naming the abnormal form
 * of the natural state "nursing" and failed the listing — an unsatisfiable pair,
 * because the attribute template forces the very text C22 rejected. Each earlier
 * fix wrote one more wording of the warning into `naturalStateSafePhrases`
 * ("have a diagnosed medical condition", then "have a known medical condition")
 * and each lost to the next ordinary paraphrase.
 *
 * THE RULE, entirely pack-driven (`advisoryCueVerbs`, `advisoryProfessionalNouns`,
 * `advisoryConditionCues`); this module holds only the sentence arithmetic:
 *
 *   A sentence is a SAFETY WARNING when it carries BOTH legs —
 *     (a) a RECOMMENDATION: an advisory cue verb followed within
 *         `ADVISORY_PAIR_GAP` characters by a professional noun (the same test
 *         `advisoryEscapes` already uses); AND
 *     (b) a CONDITION cue: a conditional subordinator or a generic-addressee
 *         relative head, which is what marks the enumeration that follows as the
 *         READER'S states rather than the product's targets.
 *
 * Inside such a sentence the markers describe the reader, so:
 *   - R2 (two markers) does not fire at all — "have been diagnosed with a
 *     medical condition", "living with a chronic medical condition" are what a
 *     warning is FOR;
 *   - R1 does not fire when the marker and the state sit in DIFFERENT items of
 *     the enumeration (`sameEnumerationItem`), because a marker in a coordinate
 *     item is a separate condition, not a modifier of the state.
 *
 * ANTI-LAUNDERING, stated exactly. A marker that MODIFIES its neighbour shares
 * its enumeration item and R1 still fires however the sentence is dressed:
 * "Consult your doctor if you want relief from severe menopause symptoms" and
 * "Anyone who has chronic menopause should talk with a physician" both fail.
 * A sentence with no condition cue is not a construction at all, so
 * "Ask your doctor about our formula for severe menopause symptoms" fails on
 * both counts. R3, the C6 disease-noun scan and the C6 action-paired tier never
 * consult this rule, so a named disease inside a warning still fails.
 */
const SENTENCE_BOUNDARY_RE = /[.!?;\n]/;

/**
 * Items of an ENUMERATION: clause punctuation OR a coordinating conjunction.
 * Function words and punctuation only — the domain vocabulary this rule needs
 * ("nursing", "medical condition", "consult", "physician", "if", "anyone who")
 * all comes from the pack.
 */
const ENUM_ITEM_BREAK_RE = /[,;:.!?()\n—–]|\b(?:and|or|nor)\b/i;

/** True when nothing between the two matches breaks the enumeration item. */
function sameEnumerationItem(text: string, a: TermMatch, b: TermMatch): boolean {
  const first = a.index <= b.index ? a : b;
  const second = a.index <= b.index ? b : a;
  const from = endOf(first);
  const to = second.index;
  if (to <= from) return true; // overlapping or adjacent
  return !ENUM_ITEM_BREAK_RE.test(text.slice(from, to));
}

/** Character ranges of every sentence in `text` that is a safety warning. */
function safetyWarningRanges(text: string, cfg: NaturalStateConfig): [number, number][] {
  const out: [number, number][] = [];
  if (
    cfg.advisoryCues.length === 0 ||
    cfg.advisoryProfessionals.length === 0 ||
    cfg.conditionCues.length === 0
  ) {
    return out;
  }
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && !SENTENCE_BOUNDARY_RE.test(text[i]!)) continue;
    const sentence = text.slice(start, i);
    if (sentence.trim() && isSafetyWarningSentence(sentence, cfg)) out.push([start, i]);
    start = i + 1;
  }
  return out;
}

function isSafetyWarningSentence(sentence: string, cfg: NaturalStateConfig): boolean {
  const cues = scanTerms(sentence, cfg.advisoryCues);
  if (cues.length === 0) return false;
  const pros = scanTerms(sentence, cfg.advisoryProfessionals);
  const paired = cues.some((c) => pros.some((p) => p.index >= c.index && p.index - endOf(c) <= ADVISORY_PAIR_GAP));
  if (!paired) return false;
  return scanTerms(sentence, cfg.conditionCues).length > 0;
}

function scanVariant(text: string, cfg: NaturalStateConfig, seen: Set<string>, out: Hit[]): void {
  const scanned = blankSafeSpans(text, cfg.safe);
  const marked = scanTerms(scanned, cfg.marked, cfg.neg);
  const markers = scanTerms(scanned, cfg.markers, cfg.neg);
  if (marked.length === 0 && markers.length < 2) return;

  // SAFETY-WARNING CONSTRUCTION spans, read from the UNBLANKED variant (blanking
  // is length-preserving, so indices line up) because the recommendation phrase
  // may itself be a blanked safe span. See `safetyWarningRanges`.
  const safetyRanges = safetyWarningRanges(text, cfg);
  const inSafetyWarning = (i: number): boolean =>
    safetyRanges.some(([lo, hi]) => i >= lo && i < hi);

  // R1 — abnormality marker beside a natural state / normal symptom.
  // Evaluated FIRST and never subject to the qualifier escape: an abnormality
  // marker beats a lawful qualifier.
  for (const s of marked) {
    for (const m of markers) {
      if (gapBetween(s, m) > cfg.window) continue;
      // Inside a safety warning a marker in a DIFFERENT enumeration item is a
      // separate reader condition, not the abnormal form of the state. A marker
      // that shares the state's item modifies it and still fails.
      if (
        inSafetyWarning(s.index) &&
        inSafetyWarning(m.index) &&
        !sameEnumerationItem(text, s, m)
      ) {
        continue;
      }
      const key = `1|${s.term}|${m.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        context: spanOf(text, s, m),
        fix: `Abnormality marker '${m.term}' next to the natural state '${s.term}' — the abnormal form of a natural state is a disease claim; describe the normal, mild form instead`,
      });
    }
  }

  // R2 — two DIFFERENT abnormality markers inside one window name an abnormal
  // condition on their own, with no natural state needed.
  for (let i = 0; i < markers.length; i += 1) {
    for (let j = i + 1; j < markers.length; j += 1) {
      const a = markers[i]!;
      const b = markers[j]!;
      if (a.term === b.term) continue;
      const gap = gapBetween(a, b);
      if (gap < 0 || gap > cfg.window) continue;
      // Inside a safety warning both markers describe the READER'S condition,
      // which is what the warning exists to ask about ("if you have been
      // diagnosed with a medical condition").
      if (inSafetyWarning(a.index) && inSafetyWarning(b.index)) continue;
      const key = `2|${[a.term, b.term].sort().join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        context: spanOf(text, a, b),
        fix: `'${a.term}' + '${b.term}' names an abnormal condition — that is a disease claim, not a structure/function claim`,
      });
    }
  }

  // R3 — therapeutic action on a natural state, with the lawful-qualifier
  // escape. Runs last: R1/R2 have already reported anything an abnormality
  // marker touches, so the escape can never reach a marker.
  const actionable = cfg.verbs.length > 0 ? scanTerms(scanned, cfg.actionable, cfg.neg) : [];
  if (actionable.length > 0) {
    // Computed once per variant, not once per state.
    const qualifiers = scanTerms(scanned, cfg.qualifiers);
    for (const s of actionable) {
      const sentence = sentenceAround(scanned, s.index);
      const verb = scanTerms(sentence, cfg.verbs)[0];
      if (!verb) continue;
      if (qualifierProtects(scanned, s, qualifiers, cfg.verbs, cfg.window)) continue;
      // Advisory escape — read from the UNBLANKED variant (blanking is
      // length-preserving, so the index lines up) because the cue phrase may
      // itself be a blanked safe span.
      if (advisoryEscapes(text, s, cfg)) continue;
      const key = `3|${s.term}|${verb.term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        context: sentence.trim().slice(0, 200),
        fix: `Therapeutic-action claim '${verb.term} … ${s.term}' — a natural state is not a disease to be acted on; describe the structure/function benefit, or qualify it as the mild/occasional form associated with that state`,
      });
    }
  }
}

export function c22NaturalState(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const cfg = configOf(pack);
  if (!cfg) return [];
  const disclaimers = disclaimerVariantsOf(cp).map(normalize);

  const out: Failure[] = [];
  for (const [field, textRaw] of allGeneratedSurfaces(l)) {
    const text = subtractDisclaimers(normalize(textRaw ?? ''), disclaimers);
    if (!text.trim()) continue;
    const seen = new Set<string>();
    const hits: Hit[] = [];
    // ADDITIVE de-obfuscation: the untouched text is always variant #1, so the
    // primary scan is never weakened by the extra passes.
    for (const variant of deobfuscatedVariants(text)) scanVariant(variant, cfg, seen, hits);
    for (const hit of hits) out.push(fail(CHECK_ID, field, hit.context, hit.fix));
  }
  return out;
}
