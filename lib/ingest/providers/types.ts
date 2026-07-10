import 'server-only';

/** Provider-normalized intermediate — one shape regardless of transport. */
export interface RawAttribute {
  name: string;
  value: string;
}

export interface RawListing {
  asin: string;
  url: string;
  title: string;
  bullets: string[];
  description: string;
  images: string[];
  /** Display-label pairs as shown on the PDP (mapped to underscore_case later). */
  attributesRaw: RawAttribute[];
  price?: string;
  rating?: number;
  categories: string[];
  categoryIds: string[];
  /** Extracted A+ text if available (audit principle 10). */
  aplusText?: string;
  /** "Important information" sections (often carries the current disclaimer). */
  importantInformation?: string;
  brand?: string;
  raw: unknown;
}

export interface ListingProvider {
  fetch(asin: string): Promise<RawListing>;
}

export class ProviderError extends Error {
  constructor(
    public code:
      | 'PROVIDER_BLOCKED'
      | 'PROVIDER_TIMEOUT'
      | 'PROVIDER_ERROR'
      | 'RATE_LIMITED'
      | 'ASIN_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
