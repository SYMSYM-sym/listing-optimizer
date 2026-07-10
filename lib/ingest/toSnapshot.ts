import 'server-only';
import type { ListingSnapshot } from '@/lib/types';
import { mapAttributes } from './labelMap';
import type { RawListing } from './providers/types';

/**
 * Normalize any RawListing into the shared ListingSnapshot.
 * Backend search terms are seller-private and are NEVER present here —
 * the audit renders them as 'unknown'.
 */
export function toSnapshot(rawListing: RawListing): ListingSnapshot {
  const { attributes, unmapped } = mapAttributes(rawListing.attributesRaw);
  if (rawListing.brand && !attributes.brand_name) {
    attributes.brand_name = rawListing.brand;
  }
  return {
    asin: rawListing.asin,
    url: rawListing.url,
    title: rawListing.title,
    bullets: rawListing.bullets,
    description: rawListing.description,
    images: rawListing.images,
    attributes,
    price: rawListing.price ?? attributes.standard_price,
    rating: rawListing.rating,
    category: rawListing.categories.join(' > '),
    subcategory: [], // populated by detectCategory (phase 2)
    raw: {
      provider: rawListing.raw,
      unmappedAttributes: unmapped,
      categories: rawListing.categories,
      categoryIds: rawListing.categoryIds,
      aplusText: rawListing.aplusText,
      importantInformation: rawListing.importantInformation,
    },
  };
}
