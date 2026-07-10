import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function titlePrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: Generate the title group.
- "productName": the customer-facing product name (not the backend brand string if it differs).
- "primaryKeyword": the single category-defining term you are front-loading.
- "title": legacy ≤200 chars. Product name first, then primary keyword, then supporting terms. No word >2×.
- "title75": ≤75 chars. Product name first + the single highest-value keyword cluster. Ruthlessly prioritized.
- "itemHighlights": ≤125 chars, searchable. Every important term that no longer fits title75 (audience qualifiers, form/count/diet tags). Do NOT duplicate title75 words.
Return JSON: { "productName", "primaryKeyword", "title", "title75", "itemHighlights" }`;
}
