import type { ListingSnapshot } from '@/lib/types';
import { loadPack, type PackId } from './loadPack';

export interface CategoryDetection {
  packId: PackId;
  /** ALL matched subcategory labels — the gate scans the UNION of their noun lists. */
  subcategories: string[];
}

const SUPPLEMENT_CATEGORY_MARKERS = [
  'vitamins & dietary supplements',
  'dietary supplements',
  'vitamins',
  'supplements',
  'herbal supplements',
  'minerals',
  'sports nutrition',
];

const SUPPLEMENT_TITLE_MARKERS = [
  'supplement',
  'vitamin',
  'probiotic',
  'capsule',
  'capsules',
  'gummies',
  'softgel',
  'softgels',
  'multivitamin',
  'cfu',
];

/**
 * Map a snapshot to a pack id AND the SET of matching subcategories.
 * Detection reads pack data (subcategoryKeywords) — nothing category-specific
 * is hard-coded beyond the supplements-pack routing markers.
 */
export function detectCategory(snapshot: ListingSnapshot): CategoryDetection {
  const category = snapshot.category.toLowerCase();
  const title = snapshot.title.toLowerCase();
  const attrText = Object.values(snapshot.attributes).join(' ').toLowerCase();

  const isSupplement =
    SUPPLEMENT_CATEGORY_MARKERS.some((m) => category.includes(m)) ||
    SUPPLEMENT_TITLE_MARKERS.some((m) => title.includes(m)) ||
    attrText.includes('supplement');

  if (!isSupplement) {
    return { packId: 'generic', subcategories: [] };
  }

  const pack = loadPack('supplements');
  const keywords = pack.compliancePack?.subcategoryKeywords ?? {};
  const haystack = `${title} ${category} ${attrText}`;
  const subcategories = Object.entries(keywords)
    .filter(([, terms]) => terms.some((t) => haystack.includes(t.toLowerCase())))
    .map(([sub]) => sub);

  return { packId: 'supplements', subcategories };
}
