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
- Lowercase, space-separated single words or short phrases, no punctuation, no brand names, no ASINs, no disease terms.${forbidBlock}
Return JSON: { "backendSearchTerms" }`;
}
