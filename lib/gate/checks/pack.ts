import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { inflectAll, normalize } from '../util';
import type { GateContext } from './types';
import { fail } from './shared';

const UNION_CACHE = new WeakMap<CompliancePack, string[]>();
const ACTION_VERB_CACHE = new WeakMap<CompliancePack, string[]>();

/**
 * EVERY disease noun the pack knows: core ∪ the union of ALL subcategory lists.
 *
 * A drug claim is illegal whatever the product is — a probiotic listing may no
 * more claim to cure an eye condition than an eye supplement may. Scoping the
 * lexicon to the DETECTED subcategories therefore under-enforced by design; the
 * gate now always scans the whole union. Detection survives only for the
 * fail-closed PACK rule and for ordering the prompt injection.
 */
export function allDiseaseNouns(cp: CompliancePack): string[] {
  const cached = UNION_CACHE.get(cp);
  if (cached) return cached;
  const union = [
    ...new Set([
      ...cp.coreDiseaseNouns,
      ...Object.values(cp.diseaseNounsBySubcategory).flat(),
    ]),
  ];
  UNION_CACHE.set(cp, union);
  return union;
}

/**
 * The SAME full union, ordered so the detected subcategories come first.
 * Ordering only — never a filter: prompt injection uses it so the most relevant
 * terms lead the list, and the generator is still shown everything the gate
 * enforces.
 */
export function activeDiseaseNouns(cp: CompliancePack, subcategories: string[]): string[] {
  const relevant = new Set(subcategories.flatMap((s) => cp.diseaseNounsBySubcategory[s] ?? []));
  const union = allDiseaseNouns(cp);
  return [...union.filter((n) => relevant.has(n)), ...union.filter((n) => !relevant.has(n))];
}

/**
 * Therapeutic-ACTION verbs (relieves / eases / reverses / shrinks …).
 *
 * The pack ships ROOTS; every inflection is generated in code, so the class is
 * covered without the pack (or the gate) carrying a hand-written word list.
 * These never create a failure on their own — they VETO negation suppression:
 * "Never any junk - relieves arthritis" is a drug claim, not a disclaimer.
 */
export function diseaseActionVerbs(cp: CompliancePack): string[] {
  const cached = ACTION_VERB_CACHE.get(cp);
  if (cached) return cached;
  const verbs = [...new Set([...cp.diseaseVerbs, ...inflectAll(cp.diseaseActionVerbRoots ?? [])])];
  ACTION_VERB_CACHE.set(cp, verbs);
  return verbs;
}

/** Fail-closed rule — an empty disease-noun pack must never launder a pass. */
export function packFailClosed(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (cp) {
    // The always-on lexicons must be populated: emptying EITHER of them
    // silently disarms every disease scan, so both are blocking.
    if (cp.coreDiseaseNouns.length === 0 || cp.diseaseVerbs.length === 0) {
      return [
        fail(
          'PACK',
          'compliance',
          `core nouns: ${cp.coreDiseaseNouns.length}, verbs: ${cp.diseaseVerbs.length}`,
          'compliance pack incomplete for this category — populate disease nouns before trusting a pass',
        ),
      ];
    }
    const nonEmptySubs = ctx.subcategories.filter(
      (s) => (cp.diseaseNounsBySubcategory[s] ?? []).length > 0,
    );
    if (ctx.subcategories.length === 0 || nonEmptySubs.length === 0) {
      return [
        fail(
          'PACK',
          'compliance',
          `detected subcategories: [${ctx.subcategories.join(', ') || 'none'}]`,
          'compliance pack incomplete for this category — populate disease nouns before trusting a pass',
        ),
      ];
    }
    return [];
  }
  const hay = normalize(
    `${ctx.snapshotText ?? ''} ${l.title} ${l.description}`,
  ).toLowerCase();
  const hit = pack.suspicionLexicon.find((t) => hay.includes(t.toLowerCase()));
  if (hit) {
    return [
      fail(
        'PACK',
        'compliance',
        `pack '${pack.id}' has no compliance module but product matches suspicion term '${hit}'`,
        'compliance pack incomplete for this category — route to a pack with a compliance module before trusting a pass',
      ),
    ];
  }
  return [];
}
