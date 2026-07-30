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
  fallbackSubcategory: string;
};

const routingSupplements = routingSupplementsJson as Routing;
const routingCosmetics = routingCosmeticsJson as Routing;

function matchMarkers(routing: Routing, category: string, title: string, attrText: string): boolean {
  return (
    routing.categoryMarkers.some((m) => m && category.includes(m)) ||
    routing.titleMarkers.some((m) => m && title.includes(m)) ||
    // NEVER `includes(markers[0] ?? '')`: an emptied marker list made
    // ''.includes('') true and routed EVERY product here (fail-open).
    routing.categoryMarkers.some((m) => m && attrText.includes(m))
  );
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
    .filter(([sub, terms]) => sub !== fallback && terms.some((t) => haystack.includes(t.toLowerCase())))
    .map(([sub]) => sub);
  return subcategories.length > 0 ? subcategories : [fallback];
}

/**
 * Map a snapshot to a pack id AND the SET of matching subcategories.
 * Detection reads pack data — routing markers live in knowledge/, not hard-coded.
 * Order: supplements first (regulated), then cosmetics, else generic.
 */
export function detectCategory(snapshot: ListingSnapshot): CategoryDetection {
  const category = snapshot.category.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const attrText = Object.values(snapshot.attributes).join(' ').toLowerCase();

  // 100% pack data: the hard-coded `attrText.includes('supplement')` that used
  // to sit here is now the routing marker 'supplement' in
  // knowledge/routing.supplements.json, which `matchMarkers` already tests
  // against BOTH the category string and the attribute text.
  if (matchMarkers(routingSupplements, category, title, attrText)) {
    return {
      packId: 'supplements',
      subcategories: detectSubcategories(
        'supplements',
        title,
        attrText,
        routingSupplements.fallbackSubcategory,
      ),
    };
  }

  if (matchMarkers(routingCosmetics, category, title, attrText)) {
    return {
      packId: 'cosmetics',
      subcategories: detectSubcategories(
        'cosmetics',
        title,
        attrText,
        routingCosmetics.fallbackSubcategory,
      ),
    };
  }

  return { packId: 'generic', subcategories: [] };
}
