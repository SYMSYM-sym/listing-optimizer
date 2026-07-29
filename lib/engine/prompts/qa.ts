import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function qaPrompt(snapshot: ListingSnapshot, packRules: string[] = []): string {
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  return `${snapshotBlock(snapshot)}

TASK: 12–18 accurate Q&A pairs seeding the AI-answer layer.
- Mirror EXACTLY the same facts as the bullets and A+ FAQ (counts, potency, serving size — from the canonical facts).
- Cover the buyer questions this category actually gets: usage, timing, who it's for, storage, what makes it different, results expectations (compliant phrasing).
${packLines}- Mark "claimBearing": true on benefit-claim answers; do NOT write disclaimer text (system appends it).
Return JSON: { "qa": [{ "q", "a", "claimBearing" }] }`;
}
