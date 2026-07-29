import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function bulletsPrompt(snapshot: ListingSnapshot, styleBlock: string, packRules: string[] = []): string {
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  return `${snapshotBlock(snapshot)}

${styleBlock}

TASK: Write exactly 5 bullets, each ≤240 chars (leave headroom to 255).
- Each bullet serves ONE major use-case with a distinct, quotable situational anchor line.
- Lead each bullet with a short benefit label in sentence case followed by a colon (capitalize the first word only \u2014 never all caps).
${packLines}- Claim-bearing bullets end with "*" (no disclaimer text in bullets — the system handles it).
- "useCaseAnchor": 2–5 word label of the use-case the bullet anchors.
Return JSON: { "bullets": [{ "text", "useCaseAnchor", "claimBearing" } ×5] }`;
}
