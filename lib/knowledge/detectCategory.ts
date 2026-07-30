import type { ListingSnapshot } from '@/lib/types';
import routingSupplementsJson from '@/knowledge/routing.supplements.json';
import routingCosmeticsJson from '@/knowledge/routing.cosmetics.json';
import { loadPack, type PackId } from './loadPack';

export interface CategoryDetection {
  packId: PackId;
  /** ALL matched subcategory labels — the gate scans the UNION of their noun lists. */
  subcategories: string[];
}

type Routing = {
  categoryMarkers: string[];
  titleMarkers: string[];
  /**
   * Title markers that are TRIED LAST — after every other pack's markers.
   * Ingredient words that a regulated product and a cosmetic share ('vitamin',
   * 'collagen', 'biotin'): as ordinary title markers they routed a vitamin C
   * serum into the regulated pack, which then demanded a compliance disclaimer.
   */
  categoryGatedTitleMarkers?: string[];
  fallbackSubcategory: string;
};

const routingSupplements = routingSupplementsJson as Routing;
const routingCosmetics = routingCosmeticsJson as Routing;

// NEVER `includes(markers[0] ?? '')`: an emptied marker list made ''.includes('')
// true and routed EVERY product here (fail-open). Every predicate below keeps the
// `m &&` guard for that reason.
function categoryHit(routing: Routing, category: string, attrText: string): boolean {
  return routing.categoryMarkers.some((m) => m && (category.includes(m) || attrText.includes(m)));
}

function titleHit(markers: string[] | undefined, title: string): boolean {
  return (markers ?? []).some((m) => m && title.includes(m));
}

function matchMarkers(routing: Routing, category: string, title: string, attrText: string): boolean {
  return categoryHit(routing, category, attrText) || titleHit(routing.titleMarkers, title);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const KEYWORD_RE_CACHE = new Map<string, RegExp>();

/**
 * WORD-BOUNDARY keyword match.
 *
 * Raw `includes()` matched keywords mid-word, so the attribute value
 * "Dietary Supplement" matched the subcategory keyword `men` (inside
 * "supple-MEN-t") and "formula" matched `mula`. Subcategories only ORDER the
 * prompt now that the gate scans the whole union, so the old behaviour
 * over-matched in the SAFE direction — but an over-matched subcategory still
 * pushes the wrong terms to the front of the injected list, so it is fixed
 * rather than merely documented. Boundaries are letter/digit-based (not `\b`)
 * so keywords containing hyphens or spaces still anchor correctly.
 */
function keywordRe(term: string): RegExp {
  let re = KEYWORD_RE_CACHE.get(term);
  if (!re) {
    re = new RegExp(`(?<![a-z0-9])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i');
    KEYWORD_RE_CACHE.set(term, re);
  }
  return re;
}

function detectSubcategories(
  packId: 'supplements' | 'cosmetics',
  title: string,
  attrText: string,
  fallback: string,
): string[] {
  const pack = loadPack(packId);
  const keywords = pack.compliancePack?.subcategoryKeywords ?? {};
  const haystack = `${title} ${attrText}`;
  const subcategories = Object.entries(keywords)
    .filter(
      ([sub, terms]) =>
        sub !== fallback && terms.some((t) => t.trim() && keywordRe(t.trim().toLowerCase()).test(haystack)),
    )
    .map(([sub]) => sub);
  return subcategories.length > 0 ? subcategories : [fallback];
}

/**
 * Map a snapshot to a pack id AND the SET of matching subcategories.
 * Detection reads pack data — routing markers live in knowledge/, not hard-coded.
 *
 * ORDER (four passes, not two):
 *   1. a COSMETICS category marker wins outright — a "Beauty & Personal Care"
 *      vitamin C serum is a cosmetic, not a supplement;
 *   2. the regulated pack's own category/title markers;
 *   3. cosmetics title markers;
 *   4. the regulated pack's CATEGORY-GATED title markers (`vitamin`, `collagen`,
 *      `biotin`) — tried last so they can still route a bare "Vitamin C 1000 mg"
 *      without hijacking a serum.
 * Anything else is generic.
 */
export function detectCategory(snapshot: ListingSnapshot): CategoryDetection {
  const category = snapshot.category.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const attrText = Object.values(snapshot.attributes).join(' ').toLowerCase();

  // 100% pack data: the hard-coded `attrText.includes('supplement')` that used
  // to sit here is now the routing marker 'supplement' in
  // knowledge/routing.supplements.json, which `matchMarkers` already tests
  // against BOTH the category string and the attribute text.
  const supplements = (): CategoryDetection => ({
    packId: 'supplements',
    subcategories: detectSubcategories(
      'supplements',
      title,
      attrText,
      routingSupplements.fallbackSubcategory,
    ),
  });
  const cosmetics = (): CategoryDetection => ({
    packId: 'cosmetics',
    subcategories: detectSubcategories(
      'cosmetics',
      title,
      attrText,
      routingCosmetics.fallbackSubcategory,
    ),
  });

  if (categoryHit(routingCosmetics, category, attrText)) return cosmetics();
  if (matchMarkers(routingSupplements, category, title, attrText)) return supplements();
  if (titleHit(routingCosmetics.titleMarkers, title)) return cosmetics();
  if (titleHit(routingSupplements.categoryGatedTitleMarkers, title)) return supplements();

  return { packId: 'generic', subcategories: [] };
}
