import type { AllergenRule, CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { arr, normalize, packPatternSource, phraseSource } from '../util';
import {
  aplusFactSurfaces,
  attributeComplianceSurfaces,
  customerSurfaces,
  fail,
  factConsistencyOver,
  fictionOver,
  potencyPhrasingOver,
  spelledOutFigureReader,
} from './shared';


/**
 * Which attribute holds the label/ingredient list, which one holds the canonical
 * declaration, and what a declaration sounds like — ALL pack data
 * (`compliancePack.allergenFields`). The gate names no attribute key itself.
 */
function allergenFields(cp: CompliancePack) {
  return cp.allergenFields;
}

/**
 * NEGATION cues around an allergen source word.
 *
 * `free` is only a cue in FRONT of a source when it introduces an exclusion
 * ("free of milk", "free from soy") — otherwise "free-range egg" would silently
 * suppress a real egg declaration. AFTER a source, a bare `free` is always the
 * exclusion form ("soy free", "gluten-free").
 *
 * These are structural English words, not a category lexicon.
 */
const ALLERGEN_NEGATION_BEFORE = new Set(['no', 'without', 'zero', 'non', 'sans', 'excludes', 'excluding']);
const ALLERGEN_NEGATION_AFTER_RE = /^[\s)\],;:.\-]*free\b/i;
/**
 * Words that may sit BETWEEN an exclusion cue and the source it excludes
 * ("free from milk AND soy", "no ADDED sesame"). Another allergen SOURCE word is
 * allowed there too, so a list of exclusions negates every item in the list.
 */
const ALLERGEN_NEGATION_GAP = new Set([
  'and', 'or', 'of', 'from', 'added', 'any', 'all', 'the', 'a', 'an', 'major',
  'declared', 'other', 'artificial', 'known', 'is', 'are',
]);
/** How far back an exclusion cue may sit, in words. */
const ALLERGEN_LOOKBACK_WORDS = 6;
/** Clause marks: an exclusion cue cannot reach across one. */
const ALLERGEN_CLAUSE_RE = /[;:.()[\]]/;

/**
 * True when the source match at [start,end) is NEGATED rather than declared.
 *
 * Two shapes, both taken from real label copy:
 *  - trailing:  "soy free", "gluten-free", "(soy free)";
 *  - leading:   "no added fragrance", "without soy", "zero dairy",
 *               "free from milk and soy" (which negates BOTH items).
 * `free` on its own in FRONT of a source is deliberately NOT a cue — otherwise
 * "free-range egg powder" would silently suppress a real egg declaration.
 */
function allergenNegated(text: string, start: number, end: number, isSource: (w: string) => boolean): boolean {
  if (ALLERGEN_NEGATION_AFTER_RE.test(text.slice(end, end + 12))) return true;
  const before = text.slice(Math.max(0, start - 80), start);
  const clause = before.split(ALLERGEN_CLAUSE_RE).pop() ?? before;
  const words = clause.split(/[^a-z0-9'-]+/i).filter(Boolean).map((w) => w.toLowerCase().replace(/-$/, ''));
  for (let i = words.length - 1; i >= 0 && words.length - i <= ALLERGEN_LOOKBACK_WORDS; i--) {
    const word = words[i]!;
    if (ALLERGEN_NEGATION_BEFORE.has(word)) return true;
    if (word === 'free' && (words[i + 1] === 'of' || words[i + 1] === 'from')) return true;
    if (ALLERGEN_NEGATION_GAP.has(word) || isSource(word)) continue;
    return false;
  }
  return false;
}

/**
 * Allergens present = any declaration rule whose source pattern matches the
 * label list in a way that actually DECLARES the allergen.
 *
 * Two filters sit in front of the raw pattern match, because without them this
 * function produced actively harmful advice: it read "Gluten free, dairy free,
 * soy free" as three declarable allergens and demanded the operator print
 * "Contains: Wheat" on a listing that says gluten free, and it read
 * "Milk Thistle Extract" as milk.
 *
 *  (a) NEGATION — a source preceded/followed by an exclusion cue is not present.
 *  (b) COMPOUND EXCLUSIONS — `compliancePack.allergenCompoundExclusions` (PACK
 *      DATA) names compounds that merely contain a source word; they are blanked
 *      out of the text before the scan, with the length preserved so the
 *      negation window still lines up.
 */
export function presentAllergens(l: OptimizedListing, cp: CompliancePack) {
  const f = allergenFields(cp);
  const attrs = l.attributes ?? {};
  let labelText = normalize(
    `${attrs[f.labelList] ?? ''} ${attrs[f.declaration] ?? ''}`,
  ).toLowerCase();
  for (const compound of cp.allergenCompoundExclusions ?? []) {
    const c = compound.trim().toLowerCase();
    if (!c) continue;
    labelText = labelText.replace(
      new RegExp(phraseSource(c), 'gi'),
      (m) => ' '.repeat(m.length),
    );
  }
  // "free from milk and soy" excludes BOTH, so an allergen NAME is an allowed
  // gap word between the cue and the source it negates.
  // BOTH SIDES read the separator class (`util.packPatternSource` /
  // `phraseSource`): a source spelled `tree-nut` must be detected AND excludable
  // as `tree-nut`, or widening one side alone would manufacture a false
  // declaration failure.
  const sourceRes = (cp.allergenRules ?? []).map(
    (r) => new RegExp(`^(?:${packPatternSource(r.source)})$`, 'i'),
  );
  const isSource = (word: string): boolean => sourceRes.some((re) => re.test(word));
  return (cp.allergenRules ?? []).filter((r) => {
    const re = new RegExp(`\\b(?:${packPatternSource(r.source)})\\b`, 'gi');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(labelText)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (!allergenNegated(labelText, m.index, m.index + m[0].length, isSource)) return true;
    }
    return false;
  });
}

/** Order-independent matcher: the pack's declaration verb + class-or-source tokens co-occur. */
export function allergenMentioned(text: string, rule: AllergenRule, cp: CompliancePack): boolean {
  const t = normalize(text).toLowerCase();
  const classRe = new RegExp(`\\b${phraseSource(rule.class.toLowerCase())}\\b`, 'i');
  const sourceRe = new RegExp(`\\b(?:${packPatternSource(rule.source)})\\b`, 'i');
  const verbRe = new RegExp(phraseSource(allergenFields(cp).declarationVerb.toLowerCase()), 'i');
  return verbRe.test(t) && (classRe.test(t) || sourceRe.test(t));
}

export function c9Allergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const f = allergenFields(cp);
  const declarationField = `attributes.${f.declaration}`;
  const out: Failure[] = [];
  const attrs = l.attributes ?? {};
  const all = `${l.title ?? ''} ${l.description ?? ''} ${arr<unknown>(l.bullets).map((b) => b ?? '').join(' ')} ${Object.values(attrs).join(' ')}`;
  const present = presentAllergens(l, cp);
  if (present.length === 0) return [];
  const normalizedAll = normalize(all).toLowerCase();
  for (const phrase of cp.noAllergenPhrases ?? []) {
    if (!phrase.trim()) continue;
    if (normalizedAll.includes(phrase.trim().toLowerCase())) {
      out.push(fail('C9', declarationField, `"${phrase}" used`, `Never use "${phrase}" when a declarable allergen is present`));
    }
  }
  // AM-3 — which LEGS of the triple declaration are required. The default is
  // ALL THREE, and that is what every shipped pack declares: `surfaces` reads
  // `true` for a leg unless the pack explicitly sets it to `false`, so an
  // absent key, an absent object and an absent compliance field all mean
  // ENFORCED. The attribute and description legs additionally cannot be
  // switched off at all — `REQUIRED_PACK_PIECES` fails the pack closed if
  // either is set false — so the override reaches the bullet leg only.
  const surfaces = cp.allergenDeclarationSurfaces ?? {};
  const requires = (leg: 'attribute' | 'description' | 'bullet'): boolean => surfaces[leg] !== false;
  for (const rule of present) {
    if (requires('attribute') && attrs[f.declaration] !== rule.canonicalString) {
      out.push(fail('C9', declarationField, attrs[f.declaration] ?? '(empty)', `${f.declaration} must equal exactly '${rule.canonicalString}'`));
    }
    if (requires('bullet') && !arr<unknown>(l.bullets).some((b) => allergenMentioned(String(b ?? ''), rule, cp))) {
      out.push(fail('C9', 'bullets', `no bullet declares ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in at least one bullet — as a TRAILING clause, never the bullet's opening`));
    }
    if (requires('description') && !allergenMentioned(l.description ?? '', rule, cp)) {
      out.push(fail('C9', 'description', `description does not declare ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in the description`));
    }
  }
  return out;
}

export function c10PotencyPhrasing(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return potencyPhrasingOver(customerSurfaces(l), pack.rules.units, 'C10', pack.rules.attributeGuard);
}

export function c11FictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return [];
  return fictionOver(customerSurfaces(l), cp, 'C11');
}

/**
 * C12 — every unit-anchored figure must agree with the canonical facts, on
 * EVERY first-person surface: customer copy, A+ content and attribute values.
 * The scan stays unit-anchored, so bare numbers ("10 strains", "3774321") are
 * ignored; only figures carrying a pack unit are measured.
 *
 * ---------------------------------------------------------------------------
 * N3 — FLAGGED DIVERGENCE FROM THE KIT: a SPELLED-OUT hero figure is read too.
 * ---------------------------------------------------------------------------
 * The kit's scan — and this port, until now — was DIGIT-anchored, so a bullet
 * reading "Fifty Billion CFU per serving" against a different canonical potency
 * was invisible: an overstated potency claim shipping in customer-facing copy,
 * which is the exact class C12 exists to prevent. CONFORMANCE-DEVIATIONS.md
 * item 2 recorded that as a remaining limitation when C24 was widened; it is
 * now closed, as a flagged addition, and item 2 says so.
 *
 * The vocabulary is the SAME PACK DATA C24 uses
 * (`rules.attributeGuard.spelledOutNumbers`) compiled by the SAME function
 * (`spelledOutFigureReader` / `spelledOutRunSource` in `./shared`) — one source
 * of truth, no second copy, and no number word anywhere in `lib/gate`.
 *
 * THE FALSE-POSITIVE CONTROL. C12's scope is the whole listing rather than one
 * pack-matched attribute key, so ordinary supplement prose is the real risk:
 *   1. A HERO UNIT IS STILL REQUIRED, and the hero dimension is pack data
 *      (`attributeGuard.unitDimensions`, i.e. potency). "one capsule daily",
 *      "two servings", "thirty day supply", "sixty capsules", "ten strains"
 *      and "one hundred percent plant based" name a dosage form, a serving, a
 *      day, a container count and no unit at all — none of them a hero unit —
 *      so a bare number word can never trip this leg. Count and day figures
 *      stay digit-only.
 *   2. A CARDINAL MUST LEAD, so "Billion CFU" is not read as a figure. Y1
 *      admits one further lead: an inert pack CONNECTOR in front of a
 *      magnitude that is not also a unit here, which is how "A Hundred Billion
 *      CFU" reads as 100 while "a Billion CFU" stays the unit.
 *   3. THE SEPARATOR IS REQUIRED and both sides are word-bounded.
 *   4. THE VALUE IS COMPOSED THE SAME WAY THE DIGITS ARE — "Fifty Billion CFU"
 *      is fifty of the compound unit, exactly as "50 Billion CFU" is, so
 *      TRUTHFUL word-form copy passes.
 *   5. ABSENT PACK DATA = EXACT PRIOR BEHAVIOUR. The reader is a widener:
 *      emptying the lists narrows C12 back to the digit-anchored scan, it
 *      never disarms it.
 *
 * Y1 — AND THE ONE THING THIS CHECK MUST NEVER DO. It measures, so a figure it
 * reads WRONG is worse than one it does not read at all: "One Hundred and Fifty
 * Billion CFU" once resolved to the sub-run "Fifty Billion CFU" and was
 * reported as AGREEING with a canonical 50. The reader now either reads a
 * figure whole or returns nothing for it — see `hasUnreadFigureBefore` in
 * `./shared` and CONFORMANCE-DEVIATIONS.md item 2.4.8. The residue that costs
 * (a figure nobody measures) is picked up as a DETECTION by C24 on attributes
 * and by C10/A5 on copy, neither of which needs a composed value.
 */
export function c12FactConsistency(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const surfaces = [
    ...customerSurfaces(l),
    ...aplusFactSurfaces(l.aplusContent),
    ...attributeComplianceSurfaces(l),
  ];
  // The ingredient-attribute keys are PACK DATA: a potency figure attributed to
  // a named ingredient is accepted only when the ingredient breakdown actually
  // declares that number+unit.
  return factConsistencyOver(
    surfaces,
    l,
    pack.rules.units,
    'C12',
    pack.compliancePack?.ingredientAttributeKeys,
    spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard),
  );
}
