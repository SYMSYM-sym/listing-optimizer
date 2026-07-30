import type {
  AplusContent,
  CompliancePack,
  Failure,
  OptimizedListing,
  UnitRules,
} from '@/lib/types';
import {
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
    ...(l.bullets ?? []).map((b, i) => [`bullets[${i}]`, str(b)] as [string, string]),
  ];
  // Q&A + image plan (brain/02: disease terms banned on every surface including Q&A/images)
  (l.qa ?? []).forEach((item, i) => {
    out.push([`qa[${i}].q`, str(item?.q)]);
    out.push([`qa[${i}].a`, str(item?.a)]);
  });
  (l.imagePlan ?? []).forEach((slot, i) => {
    out.push([`imagePlan[${i}].purpose`, str(slot?.purpose)]);
    out.push([`imagePlan[${i}].spec`, str(slot?.spec)]);
    out.push([`imagePlan[${i}].notes`, str(slot?.notes)]);
  });
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
  (a.modules ?? []).forEach((m, idx) => {
    const id = str(m?.id) || String(idx);
    out.push([`aplus.modules[${id}].headline`, str(m?.headline)]);
    out.push([`aplus.modules[${id}].body`, str(m?.body)]);
    if (m?.subcopy) out.push([`aplus.modules[${id}].subcopy`, str(m.subcopy)]);
  });
  (a.comparison?.rows ?? []).forEach((r, i) => {
    out.push([`aplus.comparison[${i}].label`, str(r?.label)]);
    out.push([`aplus.comparison[${i}].ours`, str(r?.ours)]);
    out.push([`aplus.comparison[${i}].typical`, str(r?.typical)]);
  });
  (a.faq ?? []).forEach((f, i) => {
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

export function scanSurfacesForBanned(
  surfaces: [string, string][],
  cp: CompliancePack,
  nouns: string[],
  checkId: string,
): Failure[] {
  const out: Failure[] = [];
  const disclaimers = [cp.disclaimer, ...(cp.auditAcceptDisclaimers ?? [])].filter(Boolean);
  const neg = diseaseNegationOptions(cp);
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
        for (const verb of pass.verbs) {
          const vre = termRegex(verb);
          vre.lastIndex = 0;
          let vm: RegExpExecArray | null;
          while ((vm = vre.exec(variant)) !== null) {
            if (hasNegationContext(variant, vm.index, neg)) continue;
            const windowText = variant.slice(vm.index, vm.index + verb.length + 25);
            const nounHit = scanTerms(windowText, pass.nouns)[0]?.term;
            if (!nounHit) continue;
            if (seen.has(`v:${verb}|${nounHit}`)) continue;
            seen.add(`v:${verb}|${nounHit}`);
            out.push(fail(checkId, field, variant.slice(Math.max(0, vm.index - 30), vm.index + 60), `Drug-claim pattern '${verb} … ${nounHit}' — prohibited`));
          }
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

export type Dimension = string;

interface CompiledUnits {
  unitRe: RegExp;
  dimensionOf: Map<string, Dimension>;
  familyOf: Map<string, string>;
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

  const potency = alternationSource(units.dimensions?.potency ?? []);
  const perServing = alternationSource(units.perServingPhrases ?? []);
  const verbs = alternationSource(units.potencyVerbs ?? []);
  // A pack with no potency units or no per-dose phrasing simply has no C10/A5
  // rule — an impossible pattern is used so the check is a documented no-op.
  const never = '(?!)';

  const compiled: CompiledUnits = {
    unitRe: new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[\\s-]*(${all.length ? alternationSource(all) : never})\\b`, 'gi'),
    dimensionOf,
    familyOf,
    perServingRe: new RegExp(
      potency && perServing
        ? `(\\d[\\d,.]*)\\s*(${potency})\\b[^.]{0,40}?\\b(?:${perServing})`
        : never,
      'gi',
    ),
    deliversRe: new RegExp(
      potency && perServing && verbs
        ? `\\b(?:${verbs})\\b[^.]{0,40}?(\\d[\\d,.]*)\\s*(${potency})\\b[^.]{0,30}?\\b(?:${perServing})`
        : never,
      'gi',
    ),
  };
  UNIT_CACHE.set(units, compiled);
  return compiled;
}

export function potencyPhrasingOver(
  surfaces: [string, string][],
  units: UnitRules,
  checkId: string,
): Failure[] {
  const { perServingRe, deliversRe } = compileUnits(units);
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

export interface UnitNumber {
  value: number;
  unit: string;
  dimension: Dimension;
  raw: string;
  index: number;
}

export function extractUnitNumbers(text: string, units: UnitRules): UnitNumber[] {
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
  return out;
}

function parsePotencyFact(potency: string | undefined, units: UnitRules): UnitNumber | null {
  if (!potency) return null;
  const nums = extractUnitNumbers(potency, units).filter((n) => n.dimension === 'potency');
  return nums[0] ?? null;
}

export function factConsistencyOver(
  surfaces: [string, string][],
  l: OptimizedListing,
  units: UnitRules,
  checkId: string,
): Failure[] {
  const { familyOf } = compileUnits(units);
  const family = (unit: string): string => familyOf.get(unit) ?? unit;
  const out: Failure[] = [];
  const facts = l.facts ?? {};
  const potencyFact = parsePotencyFact(facts.potency, units);
  const allowedCounts = new Set<number>(
    [facts.unitCount, facts.servings, facts.daySupply, facts.formulaCount,
      ...(facts.servingSize ? extractUnitNumbers(facts.servingSize, units).map((n) => n.value) : []),
      1, 2, 3, 4,
    ].filter((n): n is number => typeof n === 'number'),
  );
  const allowedDays = new Set<number>(
    [facts.daySupply].filter((n): n is number => typeof n === 'number'),
  );

  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    const nums = extractUnitNumbers(text, units);

    if (potencyFact) {
      const sameUnit = nums.filter(
        (n) => n.dimension === 'potency' && family(n.unit) === family(potencyFact.unit),
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
      if (n.dimension === 'count' && allowedCounts.size > 0 && !allowedCounts.has(n.value)) {
        out.push(fail(checkId, field, n.raw, `Count '${n.raw}' matches no canonical fact (unitCount=${facts.unitCount}, servings=${facts.servings})`));
      }
      if (n.dimension === 'days' && allowedDays.size > 0 && !allowedDays.has(n.value)) {
        out.push(fail(checkId, field, n.raw, `Day figure '${n.raw}' disagrees with facts.daySupply=${facts.daySupply}`));
      }
    }
  }
  return out;
}
