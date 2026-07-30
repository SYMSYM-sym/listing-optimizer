import type { ListingSnapshot } from '@/lib/types';
import type { TitlePolicy } from '@/lib/env';
import { snapshotBlock } from './shared';

/** Prompt emphasis controlled by TITLE_POLICY (both titles are always produced + gated). */
const POLICY_EMPHASIS: Record<TitlePolicy, string> = {
  dual: 'EMPHASIS: optimize the legacy title and title75 equally \u2014 both are primary surfaces.',
  legacy: 'EMPHASIS: the legacy \u2264200 title is the primary surface today \u2014 make it the strongest; still return a valid title75 + itemHighlights.',
  new75: 'EMPHASIS: the \u226475 title + itemHighlights are the primary surfaces (Jul 27 2026 policy) \u2014 make them the strongest; still return a valid legacy title.',
};

/**
 * PINNED product name block (repair rounds only).
 *
 * `productName` is a canonical identifier that OTHER groups embed (C8 wants it
 * in the description, A4 wants it in the A+ brand-story and hero modules). Once
 * the first pass has chosen one, a repair round that regenerates ONLY the title
 * group must not invent a different one — that would silently invalidate copy
 * generated in an earlier round. So the pinned value is stated as a hard
 * constraint here, and re-asserted in code after assembly.
 */
function pinnedBlock(pinnedProductName: string): string {
  if (!pinnedProductName.trim()) return '';
  return `PINNED product name: ${pinnedProductName}
You MUST use this exact string as "productName" and as the leading characters of
BOTH "title" and "title75". Do not shorten, expand, re-order or rephrase it — not
even by one character. It was already embedded in the description and the A+
modules by an earlier round, so changing it here would break those surfaces.
If "title75" is too long, cut the KEYWORD TAIL, never the product name.
`;
}

export function titlePrompt(
  snapshot: ListingSnapshot,
  policy: TitlePolicy = 'dual',
  styleBlock = '',
  pinnedProductName = '',
): string {
  return `${snapshotBlock(snapshot)}

${styleBlock}

${pinnedBlock(pinnedProductName)}
TASK: Generate the title group.
- "productName": the customer-facing product name (not the backend brand string if it differs).
  CRITICAL: "title" AND "title75" must both START with this EXACT string, character for character.
  Because title75 is capped at \u226475 chars, choose a productName SHORT enough to lead it and still
  leave room for the keyword cluster (roughly \u226445 chars). Do NOT invent a longer name and then
  abbreviate it in title75 \u2014 pick the short form once and use it verbatim in both titles.
  Any extra brand words that do not fit belong in itemHighlights, never dropped silently.
- "primaryKeyword": the single category-defining term you are front-loading.
- "title": legacy \u2264200 chars. Product name first, then primary keyword, then supporting terms. No word >2\u00d7.
- "title75": \u226475 chars. Product name first + the single highest-value keyword cluster. Ruthlessly prioritized.
- "itemHighlights": \u2264125 chars, searchable. Every important term that no longer fits title75 (audience qualifiers, form/count/diet tags). Do NOT duplicate title75 words.
${POLICY_EMPHASIS[policy]}
Return JSON: { "productName", "primaryKeyword", "title", "title75", "itemHighlights" }`;
}
