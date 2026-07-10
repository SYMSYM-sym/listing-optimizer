import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function descriptionPrompt(snapshot: ListingSnapshot, hasCompliance: boolean): string {
  const headroom = hasCompliance
    ? '≤1700 chars (the system appends the verbatim FDA disclaimer and needs the headroom)'
    : `≤${2000} chars`;
  return `${snapshotBlock(snapshot)}

TASK: Write the product description, ${headroom}.
- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality/safety (including "Contains: [Allergen]" if applicable and a short safety note: pregnancy/nursing/physician consult/keep from children).
- End claim paragraphs naturally; do NOT write any FDA disclaimer text.
Return JSON: { "description" }`;
}
