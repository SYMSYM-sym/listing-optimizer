import type { ListingSnapshot } from '@/lib/types';
import { canonicalNameBlock, snapshotBlock } from './shared';

export function descriptionPrompt(
  snapshot: ListingSnapshot,
  hasCompliance: boolean,
  styleBlock = '',
  packRules: string[] = [],
  canonicalProductName = '',
): string {
  const headroom = hasCompliance
    ? '≤1700 chars (the system appends the verbatim compliance disclaimer and needs the headroom)'
    : `≤${2000} chars`;
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  // C8 requires the canonical product name INSIDE the description. It is chosen
  // by the title group, so it is stated here rather than left to chance.
  const canonical = canonicalNameBlock(
    canonicalProductName,
    'The description MUST contain that exact string at least once — write it out in full; do not paraphrase it or refer to it only as "this product".',
  );
  return `${snapshotBlock(snapshot)}

${styleBlock}

${canonical}
TASK: Write the product description, ${headroom}.
- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality and safety.
${packLines}- End claim paragraphs naturally; do NOT write any disclaimer text.
Return JSON: { "description" }`;
}
