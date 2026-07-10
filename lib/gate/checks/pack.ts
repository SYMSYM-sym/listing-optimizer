import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import type { GateContext } from './types';
import { fail } from './shared';

/** Disease nouns for the detected subcategories: core + union of subcategory lists. */
export function activeDiseaseNouns(cp: CompliancePack, subcategories: string[]): string[] {
  const subs = subcategories.flatMap((s) => cp.diseaseNounsBySubcategory[s] ?? []);
  return [...new Set([...cp.coreDiseaseNouns, ...subs])];
}

/** Fail-closed rule — an empty disease-noun pack must never launder a pass. */
export function packFailClosed(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (cp) {
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
