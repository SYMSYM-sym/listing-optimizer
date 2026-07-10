import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function backendPrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: Backend search terms, ≤230 UTF-8 bytes (headroom to 249).
- ONLY synonyms, common misspellings, and other-language (e.g. Spanish) variants NOT present in the title, highlights, or bullets you'd expect for this product.
- Lowercase, space-separated single words or short phrases, no punctuation, no repeats of any title word, no brand names, no ASINs, no disease terms.
Return JSON: { "backendSearchTerms" }`;
}
