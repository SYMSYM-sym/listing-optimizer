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
    routing.categoryMarkers.some((m) => category.includes(m)) ||
    routing.titleMarkers.some((m) => title.includes(m)) ||
    attrText.includes(routing.categoryMarkers[0] ?? '')
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

  const isSupplement =
    matchMarkers(routingSupplements, category, title, attrText) ||
    attrText.includes('supplement');

  if (isSupplement) {
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
