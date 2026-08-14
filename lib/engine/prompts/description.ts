import type { ListingSnapshot, RuleSet } from '@/lib/types';
import { canonicalNameBlock, demandRecaptureBlock, positioningBlock, snapshotBlock } from './shared';

export function descriptionPrompt(
  snapshot: ListingSnapshot,
  hasCompliance: boolean,
  styleBlock = '',
  packRules: string[] = [],
  canonicalProductName = '',
  rules?: RuleSet,
  buyerBlock = '',
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
  // R48 positioning anchor (pack data) \u2014 the description carries the value story.
  const positioning = positioningBlock(rules?.positioningAnchor);
  // K4 (WS3) — see bullets.ts: the compliant cluster has to be WRITTEN for the
  // recapture route recorded in the keyword reference to be real.
  const recapture = demandRecaptureBlock(rules?.keywordRules);
  return `${snapshotBlock(snapshot)}${positioning ? `\n\n${positioning}` : ''}

${styleBlock}

${canonical}
TASK: Write the product description, ${headroom}.
${recapture ? `${recapture}\n` : ''}${buyerBlock ? `${buyerBlock}\n` : ''}- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality and safety.
${packLines}- Close claim paragraphs naturally; do NOT write any disclaimer text.
Return JSON: { "description" }`;
}
