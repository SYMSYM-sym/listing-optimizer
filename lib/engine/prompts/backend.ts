import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';
import {
  forbiddenBackendStems,
  type TitleSurfaces,
} from '../backendSanitize';

export function backendPrompt(snapshot: ListingSnapshot, surfaces?: TitleSurfaces): string {
  const stems = surfaces ? forbiddenBackendStems(surfaces) : [];
  const forbidBlock =
    stems.length > 0
      ? `\nFORBIDDEN STEMS (already in title/title75/itemHighlights — never use these or close variants): ${stems.join(', ')}`
      : `\nDo NOT repeat any word that appears in the source title above (or that you would put in title/title75/itemHighlights).`;

  return `${snapshotBlock(snapshot)}

TASK: Backend search terms, ≤230 UTF-8 bytes (hard cap 249).
- ONLY synonyms, common misspellings, and other-language (e.g. Spanish) variants NOT present in title, title75, or itemHighlights.
- Lowercase, space-separated single words or short phrases, no punctuation, no brand names, no ASINs.
- Every term names what the product IS or how a shopper types it: identity, form, count, diet flags, audience, and the synonyms, misspellings and other-language variants of those. That list is exhaustive — this field is scanned exactly like a bullet, so anything outside it does not belong here.${forbidBlock}
Return JSON: { "backendSearchTerms" }`;
}
