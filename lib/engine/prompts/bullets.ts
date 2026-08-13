import type { ListingSnapshot } from '@/lib/types';
import { canonicalNameBlock, snapshotBlock } from './shared';

export function bulletsPrompt(
  snapshot: ListingSnapshot,
  styleBlock: string,
  packRules: string[] = [],
  canonicalProductName = '',
): string {
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  // Bullets reference the product; no check forces the name here, but a bullet
  // that names a DIFFERENT product than the title reads as a different listing.
  const canonical = canonicalNameBlock(
    canonicalProductName,
    'If a bullet names the product at all, use that exact string — never a variant of it.',
  );
  return `${snapshotBlock(snapshot)}

${styleBlock}

${canonical}
TASK: Write exactly 5 bullets, each ≤240 chars (leave headroom to 255).
- Each bullet serves ONE major use-case with a distinct, quotable situational anchor line.
- Lead each bullet with a short benefit label in sentence case followed by a colon (capitalize the first word only — never all caps).
${packLines}- Claim-bearing bullets close with a trailing "*" (no disclaimer text in bullets — the system handles it).
- "useCaseAnchor": 2–5 word label of the use-case the bullet anchors.
Return JSON: { "bullets": [{ "text", "useCaseAnchor", "claimBearing" } ×5] }`;
}
