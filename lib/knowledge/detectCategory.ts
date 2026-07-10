import type { ListingSnapshot } from '@/lib/types';
import routingJson from '@/knowledge/routing.supplements.json';
import { loadPack, type PackId } from './loadPack';

export interface CategoryDetection {
  packId: PackId;
  /** ALL matched subcategory labels — the gate scans the UNION of their noun lists. */
  subcategories: string[];
}

const routing = routingJson as {
  categoryMarkers: string[];
  titleMarkers: string[];
  fallbackSubcategory: string;
};

/**
 * Map a snapshot to a pack id AND the SET of matching subcategories.
 * Detection reads pack data (subcategoryKeywords) — routing markers live in
 * knowledge/routing.supplements.json, not hard-coded here.
 */
export function detectCategory(snapshot: ListingSnapshot): CategoryDetection {
  const category = snapshot.category.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const attrText = Object.values(snapshot.attributes).join(' ').toLowerCase();

  const isSupplement =
    routing.categoryMarkers.some((m) => category.includes(m)) ||
    routing.titleMarkers.some((m) => title.includes(m)) ||
    attrText.includes('supplement');

  if (!isSupplement) {
    return { packId: 'generic', subcategories: [] };
  }

  const pack = loadPack('supplements');
  const keywords = pack.compliancePack?.subcategoryKeywords ?? {};
  // Title + attributes only — category breadcrumbs contain "supplements" and
  // cause false substring hits (e.g. "men" inside "supplements").
  const haystack = `${title} ${attrText}`;
  const subcategories = Object.entries(keywords)
    .filter(([sub, terms]) => sub !== routing.fallbackSubcategory && terms.some((t) => haystack.includes(t.toLowerCase())))
    .map(([sub]) => sub);

  // Fallback so a routed supplement never hits PACK with zero subcategories.
  if (subcategories.length === 0) {
    return { packId: 'supplements', subcategories: [routing.fallbackSubcategory] };
  }

  return { packId: 'supplements', subcategories };
}
