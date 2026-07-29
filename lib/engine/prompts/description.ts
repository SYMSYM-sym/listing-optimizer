import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function descriptionPrompt(
  snapshot: ListingSnapshot,
  hasCompliance: boolean,
  styleBlock = '',
  packRules: string[] = [],
): string {
  const headroom = hasCompliance
    ? '≤1700 chars (the system appends the verbatim compliance disclaimer and needs the headroom)'
    : `≤${2000} chars`;
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  return `${snapshotBlock(snapshot)}

${styleBlock}

TASK: Write the product description, ${headroom}.
- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality and safety.
${packLines}- End claim paragraphs naturally; do NOT write any disclaimer text.
Return JSON: { "description" }`;
}
