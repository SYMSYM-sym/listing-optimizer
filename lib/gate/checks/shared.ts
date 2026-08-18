import type {
  AplusContent,
  AttributeGuardRules,
  CompliancePack,
  Failure,
  OptimizedListing,
  UnitRules,
} from '@/lib/types';
import {
  arr,
  collapseDoublesTerms,
  deobfuscatedVariants,
  doubleCollapsedVariants,
  hasNegationContext,
  normalize,
  scanConcatenated,
  scanTerms,
  subtractDisclaimers,
  termRegex,
  type NegationOptions,
} from '../util';
import { diseaseActionVerbs } from './pack';

export const fail = (checkId: string, field: string, context: string, fix: string): Failure => ({
  checkId,
  field,
  context: String(context ?? '').slice(0, 220),
  fix,
});

/**
 * NULL-SAFE surface coercion.
 *
 * Every surface builder runs it: malformed LLM output (a `null` bullet, a
 * missing `qa`, an A+ block without `comparison`) must produce FAILURES, not a
 * `TypeError` that escapes `runGate` and takes the whole request down. A thrown
 * gate is a fail-OPEN in practice — the caller never gets `verified:false`.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Minimum term length for the separator-STRIPPED pass (see `scanConcatenated`).
 *
 * It used to be 5 because that pass matched plain substrings, so anything
 * shorter collided with ordinary copy. `scanConcatenated` now anchors every
 * match on TOKEN boundaries taken from the original text, which removes the
 * collisions independently of length, so the threshold is 3 — enough to cover
 * `g out` -> `gout` and `ib s` -> `ibs`. Terms of 1-2 characters stay out of
 * this pass (they are covered by the ordinary word-boundary scan).
 */
export const CONCAT_MIN_TERM_LEN = 3;

/** Customer-surface set used by C6–C12 (buyer-facing copy). */
export function customerSurfaces(l: OptimizedListing): [string, string][] {
  const out: [string, string][] = [
    ['title', str(l.title)],
    ['title75', str(l.title75)],
    ['itemHighlights', str(l.itemHighlights)],
    ['description', str(l.description)],
    ['backendSearchTerms', str(l.backendSearchTerms)],
    ...arr<unknown>(l.bullets).map((b, i) => [`bullets[${i}]`, str(b)] as [string, string]),
  ];
  // Q&A + image plan (brain/02: disease terms banned on every surface including Q&A/images)
  arr<{ q?: unknown; a?: unknown }>(l.qa).forEach((item, i) => {
    out.push([`qa[${i}].q`, str(item?.q)]);
    out.push([`qa[${i}].a`, str(item?.a)]);
  });
  arr<{ purpose?: unknown; spec?: unknown; notes?: unknown; altText?: unknown }>(l.imagePlan).forEach((slot, i) => {
    out.push([`imagePlan[${i}].purpose`, str(slot?.purpose)]);
    out.push([`imagePlan[${i}].spec`, str(slot?.spec)]);
    out.push([`imagePlan[${i}].notes`, str(slot?.notes)]);
    // WS8: ALT text is CUSTOMER-FACING and invisible on the page — the exact
    // combination that lets a stale template's rival brand name or a banned
    // term sit there unnoticed. It is scanned like every other surface.
    out.push([`imagePlan[${i}].altText`, str(slot?.altText)]);
  });
  // WS8: the video brief's on-screen strings are read by the same OCR that
  // reads the images, so they are copy and are scanned as copy.
  //
  // P1: `aspect` was the ONE video string this collector did not read, while
  // the three other readers of the same object all do — `collectSurfaces`
  // (C18/C19/C27), `styleSurfaces` (C17) and `videoText` (C28) each read all
  // four. A reader that covers three of an object's four strings is the exact
  // shape of the `bannerAltText` bypass one level over, so the odd one out is
  // closed rather than argued: `aspect` is a short format string today
  // ('9:16 vertical'), but nothing constrains it to be, and a term parked there
  // was invisible to C6/C10/C11/C12/C21/C22 and to the fail-closed backstop
  // (`allGeneratedSurfaces`) while the identical term one field over failed.
  // `durationSeconds` is a number and carries no copy.
  const video = l.videoBrief;
  if (video && typeof video === 'object') {
    out.push(['videoBrief.aspect', str(video.aspect)]);
    arr<unknown>(video.shots).forEach((b, i) => out.push([`videoBrief.shots[${i}]`, str(b)]));
    arr<unknown>(video.onScreenText).forEach((t, i) =>
      out.push([`videoBrief.onScreenText[${i}]`, str(t)]),
    );
    out.push(['videoBrief.notes', str(video.notes)]);
  }
  return out;
}

/**
 * Canonical FACTS as a scanned surface.
 *
 * `facts.*` is echoed verbatim into every repair prompt, so a claim parked in
 * a fact string used to reach the generator without any check ever reading it.
 * Only STRING values are scanned (numbers cannot carry a claim).
 *
 * C18/C19 scan `facts.*` too (see `collectSurfaces` in c-prohibited.ts), with
 * `facts.price` exempted BY KEY — it legitimately holds the standard price,
 * which C18 would otherwise, and correctly for customer copy, report as a
 * prohibited price statement.
 */
export function factsComplianceSurfaces(l: OptimizedListing): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(l.facts ?? {})) {
    if (typeof value === 'string' && value.trim()) out.push([`facts.${key}`, value]);
  }
  return out;
}

/**
 * Attribute values scanned for banned disease terms only (C6).
 * Not folded into customerSurfaces — size/count attributes would false-trip C12.
 * EVERY attribute is scanned, brand_name/manufacturer included: a brand string
 * like "CuresCancer Labs treats diabetes" is a drug claim wherever it sits.
 * (C7 keeps its own, separate brand-LEAKAGE logic for those two fields.)
 */
export function attributeComplianceSurfaces(l: OptimizedListing): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(l.attributes ?? {})) {
    out.push([`attributes.${key}`, str(value)]);
  }
  return out;
}

/**
 * EVERY generated surface, in one list: customer copy (title/bullets/
 * description/backend/Q&A/image plan), attribute values, canonical facts and
 * every A+ text field.
 *
 * Used by the fail-closed suspicion + cross-pack backstop in `packFailClosed`,
 * which previously scanned only `snapshotText + title + description` — so a
 * listing whose BULLETS, A+ modules, Q&A or attributes were full of claims was
 * invisible to it.
 */
export function allGeneratedSurfaces(l: OptimizedListing): [string, string][] {
  return [
    ...customerSurfaces(l),
    ...attributeComplianceSurfaces(l),
    ...factsComplianceSurfaces(l),
    ...aplusSurfaces(l.aplusContent),
  ];
}

/** Every A+ text field (headlines, bodies, subcopy, comparison cells, FAQ q/a). */
export function aplusSurfaces(a: AplusContent | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!a) return out;
  arr<{ id?: unknown; headline?: unknown; body?: unknown; subcopy?: unknown; bannerAltText?: unknown }>(a.modules).forEach((m, idx) => {
    const id = str(m?.id) || String(idx);
    out.push([`aplus.modules[${id}].headline`, str(m?.headline)]);
    out.push([`aplus.modules[${id}].body`, str(m?.body)]);
    if (m?.subcopy) out.push([`aplus.modules[${id}].subcopy`, str(m.subcopy)]);
    // WS8: banner ALT is customer-facing text on a customer-facing module.
    if (m?.bannerAltText) out.push([`aplus.modules[${id}].bannerAltText`, str(m.bannerAltText)]);
  });
  arr<{ label?: unknown; ours?: unknown; typical?: unknown }>(a.comparison?.rows).forEach((r, i) => {
    out.push([`aplus.comparison[${i}].label`, str(r?.label)]);
    out.push([`aplus.comparison[${i}].ours`, str(r?.ours)]);
    out.push([`aplus.comparison[${i}].typical`, str(r?.typical)]);
  });
  arr<{ q?: unknown; a?: unknown }>(a.faq).forEach((f, i) => {
    out.push([`aplus.faq[${i}].q`, str(f?.q)]);
    out.push([`aplus.faq[${i}].a`, str(f?.a)]);
  });
  return out;
}

/**
 * A+ surfaces that must agree with OUR canonical facts (C12).
 *
 * Identical to `aplusSurfaces` minus the comparison `typical` column: that cell
 * describes a TYPICAL ALTERNATIVE product, so its figures are deliberately not
 * ours and must never be measured against `facts`. Every other A+ cell is
 * first-person product copy and is checked.
 */
export function aplusFactSurfaces(a: AplusContent): [string, string][] {
  return aplusSurfaces(a).filter(([field]) => !/^aplus\.comparison\[\d+\]\.typical$/.test(field));
}

/**
 * The disclaimer strings a CONTENT scan must never read as copy: the canonical
 * constant plus every accepted variant.
 *
 * Scope note (the field used to be called `auditAcceptDisclaimers`, which
 * implied audit-only): the variants are subtracted from GENERATED surfaces too
 * (C6/C17/C18/C19/C21). That is safe because subtracting a variant only exempts
 * required legal text from a content scan — it never satisfies the disclaimer
 * REQUIREMENT. C5 and A1 still compare `fdaDisclaimer` and the description
 * against `cp.disclaimer` verbatim, so generated output written with the
 * singular CFR variant still hard-fails.
 */
export function disclaimerVariantsOf(cp: CompliancePack): string[] {
  return [cp.disclaimer, ...(cp.acceptedDisclaimerVariants ?? [])].filter(Boolean);
}

/**
 * Negation settings for the DISEASE-TERM path (C6/A2).
 *
 * Suppression requires POSITIVE evidence that the cue negates THAT term: the
 * cue sits adjacent to it inside one clause with no therapeutic-action verb in
 * between, or the term sits inside a genuine meta-phrase
 * ("not intended to diagnose, treat, cure, or prevent any disease") — pack data
 * (`compliancePack.negationMetaPhrases`). The blocking-verb CLASS is generated
 * from `compliancePack.diseaseActionVerbRoots`, so a synonym of "treats" cannot
 * re-open the hole.
 */
export function diseaseNegationOptions(cp: CompliancePack): NegationOptions {
  return {
    mode: 'strict',
    commaBreaks: true,
    blockingVerbs: diseaseActionVerbs(cp),
    metaGapVerbs: cp.diseaseVerbs,
    metaPhrases: cp.negationMetaPhrases ?? [],
    benignPhrases: cp.benignContextPhrases ?? [],
  };
}

/** The sentence `index` sits in (sentence punctuation or a line break bounds it). */
export function sentenceAround(text: string, index: number): string {
  const before = text.slice(0, index);
  const start = Math.max(
    before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'),
    before.lastIndexOf(';'), before.lastIndexOf('\n'),
  );
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?;\n]/);
  return text.slice(start + 1, endRel < 0 ? text.length : index + endRel);
}

/**
 * ACTION-PAIRED tier (`compliancePack.actionPairedNouns`).
 *
 * These terms are not a claim on their own — an enumerated NATURAL STATE under
 * 21 CFR 101.93(g) ("formulated for women in perimenopause and menopause") or a
 * name that collides with a surname/place. They fail ONLY when a
 * therapeutic-action verb sits in the SAME SENTENCE ("cures menopause",
 * "reverses menopause").
 */
function scanActionPaired(
  text: string,
  paired: string[],
  verbs: string[],
  neg: NegationOptions,
): { term: string; context: string }[] {
  if (paired.length === 0 || verbs.length === 0) return [];
  const out: { term: string; context: string }[] = [];
  for (const variant of deobfuscatedVariants(text)) {
    for (const m of scanTerms(variant, paired, neg)) {
      const sentence = sentenceAround(variant, m.index);
      if (!verbs.some((v) => termRegex(v).test(sentence))) continue;
      out.push({ term: m.term, context: m.context });
    }
  }
  return out;
}

export function scanSurfacesForBanned(
  surfaces: [string, string][],
  cp: CompliancePack,
  nouns: string[],
  checkId: string,
  actionPairedNouns: string[] = [],
): Failure[] {
  const out: Failure[] = [];
  const disclaimers = disclaimerVariantsOf(cp);
  const neg = diseaseNegationOptions(cp);
  const actionVerbs = diseaseActionVerbs(cp);
  for (const [field, textRaw] of surfaces) {
    const text = subtractDisclaimers(normalize(textRaw ?? ''), disclaimers.map(normalize));
    // The SAME scan runs over ADDITIVE de-obfuscated copies of the surface, so
    // "c-a-n-c-e-r", "canncer" and "canc3r" are all caught without the primary
    // scan ever being weakened (the untouched text is always variant #1).
    // The doubled-letter pass compares collapsed text against a COLLAPSED term
    // list, so terms that legitimately carry a double letter still match.
    // Collapsed terms shorter than DOUBLE_COLLAPSE_MIN_TERM_LEN are dropped
    // from that pass — see `collapseDoublesTerms`.
    const passes: { variants: string[]; nouns: string[]; verbs: string[] }[] = [
      { variants: deobfuscatedVariants(text), nouns, verbs: cp.diseaseVerbs },
      {
        variants: doubleCollapsedVariants(text),
        nouns: collapseDoublesTerms(nouns),
        verbs: collapseDoublesTerms(cp.diseaseVerbs),
      },
    ];
    const seen = new Set<string>();

    // PARTIAL-SPLIT pass (additive, third variant family): every intra-word
    // separator is removed from the surface AND from the term list, so
    // `c ancer`, `ca ncer`, `can-cer`, `cance r`, `g out` and `ib s` are all
    // caught — splits `collapseSeparators` cannot rebuild because they leave a
    // multi-letter fragment. `scanConcatenated` re-imposes word boundaries from
    // the ORIGINAL text, so gluing a surface together no longer manufactures
    // accidental matches. Terms of 1-2 characters still stay out of this pass
    // (they remain covered by the ordinary word-boundary scan above), and
    // disease VERBS are not scanned here either.
    for (const m of scanActionPaired(text, actionPairedNouns, actionVerbs, neg)) {
      if (seen.has(`p:${m.term}`)) continue;
      seen.add(`p:${m.term}`);
      out.push(fail(checkId, field, m.context, `Therapeutic-action claim about '${m.term}' — describe the state, never an action on it`));
    }

    for (const m of scanConcatenated(text, nouns, CONCAT_MIN_TERM_LEN, neg)) {
      if (seen.has(`n:${m.term}`)) continue;
      seen.add(`n:${m.term}`);
      out.push(fail(checkId, field, m.context, `Remove banned term '${m.term}' — reframe as a structure/function state`));
    }

    for (const pass of passes) {
      for (const variant of pass.variants) {
        for (const m of scanTerms(variant, pass.nouns, neg)) {
          // "No disease language" / "not for diabetes" are prohibitions, not claims
          if (hasNegationContext(variant, m.index, neg)) continue;
          if (seen.has(`n:${m.term}`)) continue;
          seen.add(`n:${m.term}`);
          out.push(fail(checkId, field, m.context, `Remove banned disease term '${m.term}' — reframe as a structure/function state`));
        }
        // ONE compiled alternation over the whole verb list (`scanTerms`),
        // not one regex sweep per verb: the matches are identical (longest
        // verb wins at a given index instead of near-duplicate reports for
        // an inflection pair like treat/treats), and the full-text scans per
        // gate run drop by an order of magnitude.
        for (const vm of scanTerms(variant, pass.verbs)) {
          if (hasNegationContext(variant, vm.index, neg)) continue;
          const windowText = variant.slice(vm.index, vm.index + vm.term.length + 25);
          const nounHit = scanTerms(windowText, pass.nouns)[0]?.term;
          if (!nounHit) continue;
          if (seen.has(`v:${vm.term}|${nounHit}`)) continue;
          seen.add(`v:${vm.term}|${nounHit}`);
          out.push(fail(checkId, field, variant.slice(Math.max(0, vm.index - 30), vm.index + 60), `Drug-claim pattern '${vm.term} … ${nounHit}' — prohibited`));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit-anchored machinery — 100% PACK DATA (`rules.units`).
// Nothing below names a unit, a dosage form or a potency phrase: every token
// comes off the pack, so the gate carries no category lexicon.
// ---------------------------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest-first alternation source for pack tokens (inner whitespace flexible). */
function alternationSource(tokens: string[]): string {
  return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRe(t).replace(/\s+/g, '\\s+'))
    .join('|');
}

/**
 * The largest `count` figure that may be read as a SERVING SIZE rather than a
 * container count ("take 1 capsule daily", "2 gummies a day").
 *
 * The pack's `count` dimension covers both meanings, so these small figures are
 * accepted against any canonical fact and are never treated as an internal
 * conflict with the container count.
 */
export const SERVING_SIZE_MAX = 4;
const SERVING_SIZE_SEEDS: number[] = Array.from({ length: SERVING_SIZE_MAX }, (_, i) => i + 1);

export type Dimension = string;

interface CompiledUnits {
  unitRe: RegExp;
  dimensionOf: Map<string, Dimension>;
  familyOf: Map<string, string>;
}

/**
 * C10/A5's two phrasing patterns. They are NOT part of `CompiledUnits` because
 * they depend on the pack's number vocabulary as well as its units (Y2), and
 * `CompiledUnits` is cached on the `UnitRules` object alone. Keeping them in
 * their own cache is what let the word-form leg be added without changing the
 * key of the hot path two other checks share.
 */
interface PhrasingPatterns {
  perServingRe: RegExp;
  deliversRe: RegExp;
}

const UNIT_CACHE = new WeakMap<UnitRules, CompiledUnits>();

function compileUnits(units: UnitRules): CompiledUnits {
  const cached = UNIT_CACHE.get(units);
  if (cached) return cached;

  const dimensionOf = new Map<string, Dimension>();
  const all: string[] = [];
  for (const [dimension, tokens] of Object.entries(units.dimensions ?? {})) {
    for (const token of tokens) {
      const key = token.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key) continue;
      dimensionOf.set(key, dimension);
      all.push(token);
    }
  }
  const familyOf = new Map<string, string>();
  for (const family of units.families ?? []) {
    const canonical = family[0]?.trim().toLowerCase();
    if (!canonical) continue;
    for (const member of family) {
      familyOf.set(member.trim().toLowerCase().replace(/\s+/g, ' '), canonical);
    }
  }

  const never = '(?!)';
  const compiled: CompiledUnits = {
    unitRe: new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[\\s-]*(${all.length ? alternationSource(all) : never})\\b`, 'gi'),
    dimensionOf,
    familyOf,
  };
  UNIT_CACHE.set(units, compiled);
  return compiled;
}

const PHRASING_CACHE = new WeakMap<UnitRules, Map<string, PhrasingPatterns>>();

/**
 * Compile C10/A5's two phrasing patterns for a pack.
 *
 * `runSource` is the word-form number pattern (`spelledOutRunSource`) or `null`
 * for the DIGIT-ANCHORED behaviour these checks shipped with. It is the cache
 * sub-key, so a caller that passes no vocabulary gets byte-for-byte the old
 * pattern and a caller that passes one gets the widened pattern, with no
 * possibility of the two sharing an entry.
 */
function phrasingPatterns(units: UnitRules, runSource: string | null): PhrasingPatterns {
  let byVocabulary = PHRASING_CACHE.get(units);
  if (!byVocabulary) {
    byVocabulary = new Map<string, PhrasingPatterns>();
    PHRASING_CACHE.set(units, byVocabulary);
  }
  const key = runSource ?? '';
  const cached = byVocabulary.get(key);
  if (cached) return cached;

  const potency = alternationSource(units.dimensions?.potency ?? []);
  const perServing = alternationSource(units.perServingPhrases ?? []);
  const verbs = alternationSource(units.potencyVerbs ?? []);
  // A pack with no potency units or no per-dose phrasing simply has no C10/A5
  // rule — an impossible pattern is used so the check is a documented no-op.
  const never = '(?!)';
  // The FIGURE: digits as always, plus — only when the pack ships a vocabulary
  // — the same word run C12 and C24 read. Each alternative carries its own
  // separator rule, so "ten gummies" can no more be read as "ten g" here than
  // it can in the reader.
  const digits = '\\d[\\d,.]*\\s*';
  const figure = runSource ? `(?:${digits}|(?:${runSource})[\\s-]+)` : `(?:${digits})`;

  const compiled: PhrasingPatterns = {
    perServingRe: new RegExp(
      potency && perServing
        ? `${figure}(?:${potency})\\b[^.]{0,40}?\\b(?:${perServing})`
        : never,
      'gi',
    ),
    deliversRe: new RegExp(
      potency && perServing && verbs
        ? `\\b(?:${verbs})\\b[^.]{0,40}?${figure}(?:${potency})\\b[^.]{0,30}?\\b(?:${perServing})`
        : never,
      'gi',
    ),
  };
  byVocabulary.set(key, compiled);
  return compiled;
}

/**
 * C10 (customer copy) / A5 (A+) — the headline potency must not be attached to
 * a single dose.
 *
 * Y2 — this reads the SPELLED-OUT figure too, on the same pack vocabulary and
 * through the same compiler as C24 and C12. It is a DETECTION rule, not a
 * measurement one: it objects to the attachment whatever the number is, so it
 * needs no composed value and is unaffected by a run the reader would refuse to
 * compose. `guard` absent (or a pack with no vocabulary) = the exact
 * digit-anchored patterns these two checks shipped with.
 */
export function potencyPhrasingOver(
  surfaces: [string, string][],
  units: UnitRules,
  checkId: string,
  guard?: AttributeGuardRules,
): Failure[] {
  const { perServingRe, deliversRe } = phrasingPatterns(
    units,
    spelledOutRunSource(guard?.spelledOutNumbers, units.dimensions?.potency),
  );
  const out: Failure[] = [];
  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    for (const re of [perServingRe, deliversRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!hasNegationContext(text, m.index)) {
          out.push(fail(checkId, field, m[0], 'Attach the headline potency to the blend/formula, never to a single dose'));
        }
      }
    }
  }
  return out;
}

export function fictionOver(surfaces: [string, string][], cp: CompliancePack, checkId: string): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    for (const m of scanTerms(text, cp.fictionPhrases)) {
      out.push(fail(checkId, field, m.context, `Known-false descriptor '${m.term}' must never resurface`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPELLED-OUT figures — ONE vocabulary, shared by C24 and C12.
//
// The number words are PACK DATA (`rules.attributeGuard.spelledOutNumbers`),
// so nothing below names a number word, a magnitude or a unit. Everything that
// compiles that vocabulary into a pattern lives HERE and nowhere else: C24
// (`c24DosageAttributeGuard`) and C12 (`factConsistencyOver`) both read it
// through these two functions, so there is exactly one place a future change
// has to be made. See CONFORMANCE-DEVIATIONS.md item 2.
// ---------------------------------------------------------------------------

/**
 * The regex SOURCE for a run of number WORDS ("fifty", "twenty-five",
 * "two thousand"). `null` when the pack ships no cardinals — the callers then
 * keep their exact digit-anchored behaviour.
 *
 * THREE lists, and the split IS the false-positive control: a run must BEGIN
 * with a cardinal (or with an inert word in front of a magnitude — see below),
 * and a magnitude may only appear after one, so a string that merely names its
 * unit ("Billion CFU") is never read as a figure.
 *
 * Y1 — THE INERT CONNECTOR. `connectors` are the words English puts INSIDE a
 * numeral that carry no value of their own: "one hundred AND fifty",
 * "A hundred". They cannot live in `cardinals`/`magnitudes` because `valueMap`
 * keeps only entries whose `value > 0`, so an inert word would be dropped from
 * the value table while still widening the pattern — the two halves would
 * disagree. They are therefore a list of WORDS, not word→value pairs: being
 * valueless is what they ARE, so the shape says so and no filter can strip
 * them. Nothing here names one; the list is pack data like the other two.
 *
 * Two placement rules, both structural, both in the pattern rather than prose:
 *   - a connector INSIDE a run is glued to the value word that FOLLOWS it, so a
 *     run can never begin or end on one ("fifty and" + a unit is not a figure);
 *   - a connector may LEAD a run only in front of a magnitude, and only a
 *     magnitude the caller does not ALSO append as a unit. "A hundred" is one
 *     hundred; "a Billion CFU" is the UNIT reading the digit scan gives
 *     "1 Billion CFU", and taking `billion` as a MAGNITUDE there would report
 *     1,000,000,000 against a canonical "1 Billion CFU" and fail truthful copy.
 *     That exclusion is why `unitTokens` is a parameter: every caller passes
 *     the token list its own pattern appends after the run.
 *
 * The trailing quantifier is LAZY on purpose. The callers append
 * `[\s-]+(?:<unit alternation>)` to this source, and the unit alternation is
 * longest-first, so "Fifty Billion CFU" must be read as the figure `fifty`
 * carrying the compound unit `billion cfu` — exactly as the digit scan reads
 * "50 Billion CFU". A greedy run would instead swallow "billion" as a
 * MAGNITUDE and report 50,000,000,000 CFU, which would fail truthful copy.
 * (For C24, which only asks whether the value matches at all, greedy and lazy
 * accept precisely the same strings; the split only matters to C12.)
 */
export function spelledOutRunSource(
  vocabulary: AttributeGuardRules['spelledOutNumbers'] | undefined,
  unitTokens?: string[],
): string | null {
  const cardinals = alternationSource(Object.keys(vocabulary?.cardinals ?? {}));
  if (!cardinals) return null;
  const magnitudeWords = Object.keys(vocabulary?.magnitudes ?? {});
  const magnitudes = alternationSource(magnitudeWords);
  const connectors = alternationSource(connectorWords(vocabulary));
  const anyWord = magnitudes ? `${cardinals}|${magnitudes}` : cardinals;
  // A connector is never free-standing: it is glued to the value word after it.
  const inner = connectors
    ? `(?:(?:${connectors})[\\s-]+)?(?:${anyWord})`
    : `(?:${anyWord})`;
  // "A hundred" — an inert lead supplies the implicit one, but only in front of
  // a magnitude that is not itself one of THIS caller's unit tokens.
  const appended = new Set((unitTokens ?? []).map((t) => t.trim().toLowerCase()));
  const leadMagnitudes = alternationSource(
    magnitudeWords.filter((w) => !appended.has(w.trim().toLowerCase())),
  );
  const lead =
    connectors && leadMagnitudes
      ? `(?:${cardinals})|(?:${connectors})[\\s-]+(?:${leadMagnitudes})`
      : `(?:${cardinals})`;
  return `(?:${lead})(?:[\\s-]+${inner})*?`;
}

/** The pack's inert connector words, trimmed and de-blanked. Never a literal. */
function connectorWords(
  vocabulary: AttributeGuardRules['spelledOutNumbers'] | undefined,
): string[] {
  return (vocabulary?.connectors ?? [])
    .map((w) => String(w ?? '').trim())
    .filter(Boolean);
}

/**
 * The HERO unit alternation — the tokens of every `units.dimensions` list the
 * pack's attribute guard names (`unitDimensions`, i.e. the potency dimension on
 * the shipped packs). Empty string when the pack names none.
 *
 * This is the bound that keeps the word leg narrow on BOTH checks: a number
 * word can only be read as a figure when it is joined to one of these, so
 * "one capsule daily", "two servings", "sixty capsules" and "thirty day
 * supply" name a dosage form, a serving, a container count and a day — none of
 * them a hero unit — and cannot match however the number is written.
 */
export function heroUnitSource(
  units: UnitRules | undefined,
  guard: AttributeGuardRules | undefined,
): string {
  return alternationSource(heroUnitTokens(units, guard));
}

/**
 * The same hero tokens as a LIST. `spelledOutRunSource` needs the tokens rather
 * than the alternation, to keep an inert lead off a magnitude that is also a
 * unit at this call site (see its header).
 */
export function heroUnitTokens(
  units: UnitRules | undefined,
  guard: AttributeGuardRules | undefined,
): string[] {
  return (guard?.unitDimensions ?? []).flatMap(
    (dimension) => units?.dimensions?.[dimension] ?? [],
  );
}

/** Reads word-form hero figures out of a text. */
export interface SpelledOutFigureReader {
  read(text: string): UnitNumber[];
}

/**
 * Compose the numeric VALUE of a number-word run, or `null` when the run does
 * not compose into one. Ordinary English composition: cardinals add, `hundred`
 * multiplies what is in hand, the larger magnitudes close a group off.
 *
 * `null` IS THE SAFE ANSWER and the caller must treat it as one — see
 * `spelledOutFigureReader`. A magnitude that follows no cardinal returns `null`
 * rather than a value: the pattern already refuses to start a run on one, and
 * this keeps the two halves from disagreeing if the pattern is ever loosened.
 *
 * Y1 — CONNECTORS. An inert word carries no value, and it is only accepted
 * where English actually puts it:
 *   - LEADING the run, where it supplies the implicit one in front of a
 *     magnitude ("a hundred" == "one hundred" == 100);
 *   - directly after a MAGNITUDE, closing a group off ("one hundred AND
 *     fifty" == 150).
 * Anywhere else — "fifty and sixty" — the run is not a numeral this reader can
 * read, so it returns `null` rather than inventing an addition English does not
 * perform.
 */
function composeSpelledValue(
  run: string,
  cardinals: Map<string, number>,
  magnitudes: Map<string, number>,
  connectors: Set<string>,
): number | null {
  let total = 0;
  let current = 0;
  let sawWord = false;
  let previous: 'start' | 'cardinal' | 'magnitude' | 'connector' = 'start';
  let leadConnector = false;
  for (const token of run.toLowerCase().split(/[\s-]+/)) {
    if (!token) continue;
    if (connectors.has(token)) {
      if (previous === 'start') {
        leadConnector = true;
        previous = 'connector';
        continue;
      }
      if (previous === 'magnitude') {
        previous = 'connector';
        continue;
      }
      return null;
    }
    const cardinal = cardinals.get(token);
    if (cardinal !== undefined) {
      current += cardinal;
      sawWord = true;
      previous = 'cardinal';
      continue;
    }
    const magnitude = magnitudes.get(token);
    if (magnitude === undefined) return null;
    if (current === 0) {
      // "a hundred": a LEADING inert word supplies the implicit one. Without
      // one, a magnitude with nothing in hand is not a figure.
      if (!leadConnector || sawWord) return null;
      current = 1;
    }
    if (magnitude >= 1000) {
      total += current * magnitude;
      current = 0;
    } else {
      current *= magnitude;
    }
    sawWord = true;
    previous = 'magnitude';
  }
  if (previous === 'connector') return null;
  const value = total + current;
  return sawWord && Number.isFinite(value) && value > 0 ? value : null;
}

/** Pack tokens -> a value map, ignoring anything that is not a real number. */
function valueMap(entries: Record<string, number> | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [word, value] of Object.entries(entries ?? {})) {
    const key = word.trim().toLowerCase();
    if (key && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * Build the word-form figure reader for a pack, or `null` when the pack ships
 * no vocabulary / no hero unit. `null` is the DIGIT-ANCHORED behaviour: every
 * caller treats an absent reader as "scan digits only", so emptying the pack
 * lists is a narrowing back to kit parity and can never disarm a check.
 *
 * THE READER EITHER READS A FIGURE WHOLE OR RETURNS NOTHING FOR IT. There is no
 * third outcome and, in particular, no partial one: a run it cannot compose, or
 * one that is part of a longer figure it did not read, yields NO `UnitNumber`
 * at all rather than the value of a fragment. Y1 — a fragment that resolves to
 * a number is not a miss, it is a MIS-MEASUREMENT: the caller compares it
 * against the canonical fact and reports agreement.
 */
export function spelledOutFigureReader(
  units: UnitRules | undefined,
  guard: AttributeGuardRules | undefined,
): SpelledOutFigureReader | null {
  if (!units) return null;
  const runSource = spelledOutRunSource(
    guard?.spelledOutNumbers,
    heroUnitTokens(units, guard),
  );
  if (!runSource) return null;
  const unitSource = heroUnitSource(units, guard);
  if (!unitSource) return null;
  const cardinals = valueMap(guard?.spelledOutNumbers?.cardinals);
  if (cardinals.size === 0) return null;
  const magnitudes = valueMap(guard?.spelledOutNumbers?.magnitudes);
  const connectors = new Set(connectorWords(guard?.spelledOutNumbers).map((w) => w.toLowerCase()));
  // Every VALUE-BEARING word the vocabulary knows — the input to the
  // fragment guard below. Connectors are deliberately absent: they carry no
  // value, so one sitting in front of a run is not an unread figure.
  const valueWords = new Set<string>([...cardinals.keys(), ...magnitudes.keys()]);
  // The separator is REQUIRED and both sides are word-bounded, so "ten
  // gummies" can never be read as "ten g".
  const re = new RegExp(`\\b(${runSource})[\\s-]+(${unitSource})\\b`, 'gi');
  const { dimensionOf } = compileUnits(units);
  return {
    read(text: string): UnitNumber[] {
      const out: UnitNumber[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const runText = m[1];
        const unitStr = m[2];
        if (!runText || !unitStr) continue;
        // Y1 — REFUSE A FRAGMENT. Both of these return no reading at all
        // rather than a number: a run this reader cannot read WHOLE must never
        // resolve to part of itself and then be compared as though it were the
        // figure the copy states. See the header on `hasUnreadFigureBefore`.
        if (hasUnreadFigureBefore(text, m.index, valueWords, units)) continue;
        const value = composeSpelledValue(runText, cardinals, magnitudes, connectors);
        if (value === null) continue;
        const unit = unitStr.toLowerCase().replace(/\s+/g, ' ');
        const dimension = dimensionOf.get(unit);
        if (!dimension) continue;
        out.push({ value, unit, dimension, raw: m[0], index: m.index });
      }
      return out;
    },
  };
}

export interface UnitNumber {
  value: number;
  unit: string;
  dimension: Dimension;
  raw: string;
  index: number;
}

export function extractUnitNumbers(
  text: string,
  units: UnitRules,
  spelledOut?: SpelledOutFigureReader | null,
): UnitNumber[] {
  const { unitRe, dimensionOf } = compileUnits(units);
  const out: UnitNumber[] = [];
  unitRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = unitRe.exec(text)) !== null) {
    const numStr = m[1];
    const unitStr = m[2];
    if (!numStr || !unitStr) continue;
    const unit = unitStr.toLowerCase().replace(/\s+/g, ' ');
    const dim = dimensionOf.get(unit);
    if (!dim) continue;
    out.push({
      value: Number.parseFloat(numStr.replace(/,/g, '')),
      unit,
      dimension: dim,
      raw: m[0],
      index: m.index,
    });
  }
  // N3 — the same figures written in WORDS. Absent a reader (no pack
  // vocabulary, or a caller that deliberately does not pass one) this is a
  // no-op and the function is exactly the digit-anchored scan it always was.
  if (spelledOut) {
    out.push(...spelledOut.read(text));
    out.sort((a, b) => a.index - b.index);
  }
  return out;
}

/**
 * Words that CANNOT attribute a figure to an ingredient.
 *
 * Purely structural English (articles, prepositions, quantifiers, adverbs, the
 * verbs that introduce a figure, packaging nouns) plus every token the PACK
 * declares as a unit, a dosage form, a per-dose phrase, a potency verb or a
 * supply cue. Nothing category-specific is written here — the domain half comes
 * off `rules.units`.
 */
const NON_ATTRIBUTING_WORDS = [
  'a', 'an', 'the', 'and', 'or', 'plus', 'with', 'of', 'for', 'from', 'in', 'into', 'on', 'at',
  'to', 'by', 'per', 'each', 'every', 'all', 'only', 'just', 'about', 'approximately', 'approx',
  'around', 'nearly', 'almost', 'over', 'under', 'up', 'now', 'still', 'also', 'even', 'another',
  'other', 'our', 'your', 'their', 'its', 'this', 'that', 'these', 'those', 'is', 'are', 'be',
  'was', 'were', 'has', 'have', 'had', 'get', 'gets', 'take', 'takes', 'use', 'uses', 'offers',
  'offer', 'packed', 'loaded', 'featuring', 'features', 'boasts', 'full', 'total', 'whopping',
  'more', 'than', 'less', 'least', 'most', 'high', 'strong', 'maximum', 'minimum', 'strength',
  'potency', 'dosage', 'formula', 'formulas', 'blend', 'blends', 'complex', 'support', 'size',
  'weight', 'net', 'amount', 'bottle', 'bottles', 'jar', 'jars', 'tub', 'tubs', 'pouch', 'pack',
  'packs', 'box', 'container', 'containers', 'unit', 'units', 'count', 'daily', 'day', 'days',
];

const ATTRIBUTION_CACHE = new WeakMap<UnitRules, Set<string>>();

function nonAttributingWords(units: UnitRules): Set<string> {
  const cached = ATTRIBUTION_CACHE.get(units);
  if (cached) return cached;
  const out = new Set<string>(NON_ATTRIBUTING_WORDS);
  const packTokens = [
    ...Object.values(units.dimensions ?? {}).flat(),
    ...(units.dosageForms ?? []),
    ...(units.potencyVerbs ?? []),
    ...(units.perServingPhrases ?? []),
    ...(units.daySupplyCues ?? []),
  ];
  for (const token of packTokens) {
    for (const word of token.toLowerCase().split(/[^a-z0-9']+/)) {
      if (word) out.add(word);
    }
  }
  ATTRIBUTION_CACHE.set(units, out);
  return out;
}

/**
 * True when the figure at `index` is ATTRIBUTED to a named ingredient — i.e. the
 * token immediately in front of it (same clause, only spaces/hyphens skipped) is
 * a content word rather than a function word.
 *
 * WHY: `facts.potency` is a SINGLE scalar, so measuring every same-family figure
 * against it failed any multi-ingredient formula that states more than one
 * ("Glucosamine 1500 mg, Chondroitin 1200 mg, MSM 1000 mg" produced four
 * failures) — the whole joint / sleep / multivitamin / prenatal segment.
 *
 * COVERAGE, stated plainly: this is an ADJACENCY rule, not an ingredient
 * lexicon — it decides only whether a figure LOOKS attributed. Being attributed
 * is no longer enough to be accepted: an attributed figure is exempt from the
 * `facts.potency` comparison only when the same number+unit is actually
 * DECLARED in the pack's ingredient attributes (see `declaredFigures`), so
 * "Maximum-strength Turmeric 2000 mg" against a 500 mg canonical fact is
 * reported unless 2000 mg appears in the ingredient breakdown. Unattributed
 * figures — the ones that read as the product's headline potency ("a 90 Billion
 * CFU blend") — are measured against the canonical fact exactly as before.
 */
function isAttributed(text: string, index: number, units: UnitRules): boolean {
  const previous = previousToken(text, index);
  if (!previous) return false;
  const token = previous.token;
  if (!/[A-Za-z]/.test(token) || token.length < 2) return false;
  return !nonAttributingWords(units).has(token.toLowerCase());
}

/**
 * The token immediately in FRONT of `index`, skipping only run separators
 * (spaces and hyphens). `null` at the start of the text and at any clause
 * punctuation — a bracket, comma, colon or full stop ENDS the neighbourhood, so
 * nothing here ever reaches across one.
 */
function previousToken(text: string, index: number): { token: string; start: number } | null {
  let i = index - 1;
  while (i >= 0 && /[\s\-]/.test(text[i]!)) i--;
  if (i < 0) return null;
  if (!/[A-Za-z0-9']/.test(text[i]!)) return null; // clause punctuation / bracket
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9']/.test(text[i]!)) i--;
  return { token: text.slice(i + 1, end), start: i + 1 };
}

/**
 * Y1 — TRUE when a word-form match at `index` is a FRAGMENT of a longer figure
 * this reader did not read whole.
 *
 * THE DEFECT THIS EXISTS FOR. `"One Hundred and Fifty Billion CFU"` against a
 * canonical `50 Billion CFU` produced ZERO failures from the entire gate. The
 * run pattern could not cross `and`, so the reader fell back to the SUB-RUN
 * `"Fifty Billion CFU"`, composed 50, found it equal to the canonical figure
 * and concluded the copy AGREED with the facts. That is worse than a miss: the
 * gate affirmatively measured a threefold overstatement as truthful. Adding
 * `and` to the vocabulary fixes that one string; this fixes the CLASS, because
 * the same fallback recurs with any word a pack happens to lack.
 *
 * THE RULE, and it is deliberately vocabulary-INDEPENDENT — it must still fire
 * for a word the pack never declared:
 *
 *   - the token in front of the run is a value-bearing number word or a bare
 *     digit run that the match did NOT consume → fragment
 *     (`"Hundred Fifty Billion CFU"`: a magnitude cannot lead, so the reader
 *     would otherwise start at `Fifty`);
 *   - the token in front is a FUNCTION word (`nonAttributingWords` — structural
 *     English plus every token the pack declares as a unit, dosage form, per-
 *     dose phrase, potency verb or supply cue) and the token before THAT is a
 *     value word or digits → fragment. This is the `and` case, and it does not
 *     consult the connector list, so it catches `and`, `plus`, `or` and
 *     anything else of that shape whether or not the pack declares it.
 *
 * AND WHY IT STOPS THERE. A CONTENT word in front of the run ENDS the numeral
 * to its left: in `"Ten Strains Fifty Billion CFU"` the `Ten` belongs to
 * `Strains`, and refusing there would silently drop a real reading of ordinary
 * listing copy. `"Ten Billion CFU and Fifty Billion CFU"` is not a fragment
 * either — the function word is preceded by a UNIT token, not a value word, so
 * the left figure is complete and both are read and compared. Clause
 * punctuation ends the search (`previousToken`), so `"Ten Strains, Fifty
 * Billion CFU"` is never in scope at all.
 *
 * THE BEHAVIOUR ON A HIT IS TO REFUSE TO MEASURE, not to fail closed. A
 * failure here would be an assertion about a figure the reader has just said it
 * cannot read, and the shapes that reach this guard include lawful copy
 * (`"Ten Billion and Fifty Billion CFU"` is ambiguous prose, not a lie), so
 * emitting one would be over-blocking — which this project treats as exactly as
 * severe as a bypass. Refusing is strictly safer than the alternative it
 * replaces: it can never affirm a false figure as truthful and it can never
 * report a true one as false. What it costs is COVERAGE, and that cost is
 * bounded and stated in CONFORMANCE-DEVIATIONS.md item 2.4.8 — C24 still
 * DETECTS the same string in a dosage attribute, and Y2 gave C10/A5 the same
 * detection on customer copy, because detection needs no composed value.
 */
function hasUnreadFigureBefore(
  text: string,
  index: number,
  valueWords: Set<string>,
  units: UnitRules,
): boolean {
  const isValue = (token: string): boolean =>
    valueWords.has(token.toLowerCase()) || /^\d[\d,.]*$/.test(token);
  const first = previousToken(text, index);
  if (!first) return false;
  if (isValue(first.token)) return true;
  // A content word terminates the numeral in front of it; only a function word
  // can be the gap INSIDE one.
  if (!nonAttributingWords(units).has(first.token.toLowerCase())) return false;
  const second = previousToken(text, first.start);
  return second !== null && isValue(second.token);
}

/**
 * True when a DAY figure carries a supply cue (`rules.units.daySupplyCues`).
 *
 * Without this every day figure was measured against `facts.daySupply`, so stock
 * copy — "Give it 90 days", "results in 30 days" — failed as a contradicted
 * supply claim. When the pack ships no cues the old always-compare behaviour is
 * kept.
 */
function isSupplyClaim(text: string, n: UnitNumber, units: UnitRules): boolean {
  const cues = units.daySupplyCues ?? [];
  if (cues.length === 0) return true;
  const window = text.slice(Math.max(0, n.index - 40), n.index + n.raw.length + 40).toLowerCase();
  return cues.some((cue) => cue.trim() && window.includes(cue.trim().toLowerCase()));
}

/**
 * Every number+unit DECLARED in the pack's ingredient attributes
 * (`compliancePack.ingredientAttributeKeys` — pack data, so the gate names no
 * attribute key).
 *
 * `null` when the pack declares no ingredient attributes at all: there is then
 * nothing to verify an attributed figure against, and the previous behaviour
 * (attributed figures skipped) is kept rather than blocking every
 * multi-ingredient formula. The manifest requires the key list on any
 * compliance-bearing pack for exactly that reason.
 */
export function declaredFigures(
  l: OptimizedListing,
  keys: string[] | undefined,
  units: UnitRules,
  spelledOut?: SpelledOutFigureReader | null,
): UnitNumber[] | null {
  const list = arr<string>(keys).map((k) => String(k ?? '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  const attrs = l.attributes ?? {};
  const text = list.map((k) => normalize(attrs[k] ?? '')).join(' ; ');
  // N3: the breakdown is read with the SAME reader as the copy it exempts. A
  // one-sided reader would be over-blocking — a word-form figure in the copy
  // would be measured while the word-form declaration that licenses it stayed
  // invisible.
  return extractUnitNumbers(text, units, spelledOut);
}

function parsePotencyFact(
  potency: string | undefined,
  units: UnitRules,
  spelledOut?: SpelledOutFigureReader | null,
): UnitNumber | null {
  if (!potency) return null;
  // N3: same reader again. A canonical fact written in words used to parse to
  // nothing, which switched the potency comparison OFF for the whole listing.
  const nums = extractUnitNumbers(potency, units, spelledOut).filter(
    (n) => n.dimension === 'potency',
  );
  return nums[0] ?? null;
}

export function factConsistencyOver(
  surfaces: [string, string][],
  l: OptimizedListing,
  units: UnitRules,
  checkId: string,
  ingredientAttributeKeys?: string[],
  spelledOut?: SpelledOutFigureReader | null,
): Failure[] {
  const { familyOf } = compileUnits(units);
  const family = (unit: string): string => familyOf.get(unit) ?? unit;
  const declared = declaredFigures(l, ingredientAttributeKeys, units, spelledOut);
  /**
   * An attributed figure is EXEMPT only when it is genuinely declared: the same
   * number, in the same unit family, in one of the ingredient attributes. When
   * the pack declares no ingredient attributes (`declared === null`) there is
   * nothing to check against, so attribution alone exempts as it did before.
   */
  const isDeclared = (n: UnitNumber): boolean =>
    declared === null ||
    declared.some((d) => d.value === n.value && family(d.unit) === family(n.unit));
  const out: Failure[] = [];
  const facts = l.facts ?? {};
  const potencyFact = parsePotencyFact(facts.potency, units, spelledOut);
  /**
   * The canonical COUNT facts that are actually DEFINED.
   *
   * A figure cannot CONTRADICT a fact that does not exist. The seed values
   * 1-4 (a plausible serving size — see `SERVING_SIZE_MAX`) used to be mixed
   * into this set, which made it non-empty even when every canonical count
   * fact was `undefined`, so the `allowedCounts.size > 0` guard never fired
   * and an ordinary listing was failed with
   * "matches no canonical fact (unitCount=undefined, servings=undefined)".
   * The seeds are added ONLY once a canonical fact exists to compare against.
   *
   * `facts.formulaCount` is deliberately NOT in this set. It is an "N-in-1"
   * MARKETING number (blend/strain count), a different dimension from the
   * container count entirely: a live run whose facts were
   * `{price, formulaCount: 11}` failed the truthful attribute "120 Count"
   * because the 11 made this set non-empty, so the no-canonical-fact guard
   * below never fired. Container-count figures compare ONLY against
   * unitCount / servings / daySupply / servingSize-derived values; a defined
   * formulaCount alone arms nothing. ("11-in-1" / "11 formulas" copy carries
   * no pack unit token, so it never enters this check from the other side
   * either.)
   */
  const canonicalCounts = new Set<number>(
    [facts.unitCount, facts.servings, facts.daySupply,
      // Deliberately NOT read with the word reader: every value extracted here
      // lands in the COUNT allow-set regardless of its dimension, so feeding it
      // hero (potency) figures would widen what a count figure may claim. The
      // word leg is a hero-unit leg; it has no business in the count set.
      ...(facts.servingSize ? extractUnitNumbers(facts.servingSize, units).map((n) => n.value) : []),
    ].filter((n): n is number => typeof n === 'number'),
  );
  const allowedCounts =
    canonicalCounts.size > 0
      ? new Set<number>([...canonicalCounts, ...SERVING_SIZE_SEEDS])
      : null;
  const allowedDays = new Set<number>(
    [facts.daySupply].filter((n): n is number => typeof n === 'number'),
  );
  /**
   * INTERNAL count conflict — the rule that survives when no canonical count
   * fact exists. Two different container-count figures inside one listing
   * ("60 capsules per bottle" and "30 capsules per bottle") contradict each
   * other whether or not we hold a canonical fact, so the check stays armed.
   * Figures at or below `SERVING_SIZE_MAX` are excluded: the `count` dimension
   * carries BOTH the container count and the serving size ("take 1 capsule
   * daily" next to "60 capsules") and those two are not in conflict — the same
   * assumption the seed values above already encode.
   */
  const internalCounts = new Map<number, string>();

  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    const nums = extractUnitNumbers(text, units, spelledOut);

    if (potencyFact) {
      const sameUnit = nums.filter(
        (n) =>
          n.dimension === 'potency' &&
          family(n.unit) === family(potencyFact.unit) &&
          // A figure attributed to a named ingredient is that INGREDIENT's
          // potency, not the product's headline potency — but only if the
          // ingredient breakdown actually declares it (see `isDeclared`).
          !(isAttributed(text, n.index, units) && isDeclared(n)),
      );
      for (const n of sameUnit) {
        if (n.value !== potencyFact.value) {
          out.push(fail(checkId, field, n.raw, `Potency '${n.raw}' disagrees with canonical facts.potency '${facts.potency}'`));
        }
      }
      const distinct = new Set(sameUnit.map((n) => n.value));
      if (distinct.size > 1) {
        out.push(fail(checkId, field, [...distinct].join(' vs '), 'Two different potency figures in one surface — internal conflict'));
      }
    }

    for (const n of nums) {
      if (n.dimension === 'count') {
        if (allowedCounts) {
          if (!allowedCounts.has(n.value)) {
            out.push(fail(checkId, field, n.raw, `Count '${n.raw}' matches no canonical fact (unitCount=${facts.unitCount}, servings=${facts.servings})`));
          }
        } else if (n.value > SERVING_SIZE_MAX && !internalCounts.has(n.value)) {
          internalCounts.set(n.value, `${field}: ${n.raw}`);
        }
      }
      if (
        n.dimension === 'days' &&
        allowedDays.size > 0 &&
        isSupplyClaim(text, n, units) &&
        !allowedDays.has(n.value)
      ) {
        out.push(fail(checkId, field, n.raw, `Day figure '${n.raw}' disagrees with facts.daySupply=${facts.daySupply}`));
      }
    }
  }

  // No canonical count fact to measure against — the listing must at least
  // agree with ITSELF.
  if (!allowedCounts && internalCounts.size > 1) {
    const cited = [...internalCounts.values()];
    out.push(
      fail(
        checkId,
        cited[0]!.split(':')[0]!,
        cited.join(' vs '),
        'Two different count figures in one listing — internal conflict (no canonical count fact to arbitrate)',
      ),
    );
  }
  return out;
}
