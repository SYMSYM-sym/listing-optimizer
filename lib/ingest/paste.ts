import 'server-only';
import { looksLikeHtml, parsePdpHtml } from './parsePdpHtml';
import type { RawListing } from './providers/types';

/**
 * Paste fallback — zero automated fetch. Two first-class modes:
 *  1. raw PDP source HTML (≤4MB, scripts stripped, shared parser)
 *  2. structured manual fields (always works)
 */

export const MAX_PASTE_BYTES = 4 * 1024 * 1024;

export interface ManualFields {
  title: string;
  bullets: string[];
  description: string;
  attributes?: Record<string, string>;
  category?: string;
  price?: string;
  images?: string[];
}

export class PasteError extends Error {
  code = 'PASTE_UNPARSEABLE' as const;
}

export function fromPastedHtml(html: string, asin: string): RawListing {
  if (Buffer.byteLength(html, 'utf8') > MAX_PASTE_BYTES) {
    throw new PasteError('Pasted HTML exceeds 4MB. Paste only the page source, or use manual fields.');
  }
  if (!looksLikeHtml(html)) {
    throw new PasteError(
      'That looks like rendered text, not page source HTML. Use the manual fields form instead.',
    );
  }
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const listing = parsePdpHtml(stripped, asin, `https://www.amazon.com/dp/${asin}`);
  if (!listing.title) {
    throw new PasteError(
      'Could not find a product title in the pasted HTML. Make sure you copied the full page source (Ctrl+U), or use manual fields.',
    );
  }
  return { ...listing, raw: { source: 'paste-html' } };
}

export function fromManualFields(fields: ManualFields, asin: string): RawListing {
  if (!fields.title?.trim()) {
    throw new PasteError('Manual entry requires at least a product title.');
  }
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: fields.title.trim(),
    bullets: (fields.bullets ?? []).map((b) => b.trim()).filter(Boolean),
    description: fields.description?.trim() ?? '',
    images: fields.images ?? [],
    attributesRaw: Object.entries(fields.attributes ?? {}).map(([name, value]) => ({
      name,
      value,
    })),
    price: fields.price,
    categories: fields.category ? [fields.category] : [],
    categoryIds: [],
    raw: { source: 'paste-manual' },
  };
}
