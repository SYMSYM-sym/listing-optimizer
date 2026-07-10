import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function qaPrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: 12–18 accurate Q&A pairs seeding the AI-answer layer.
- Mirror EXACTLY the same facts as the bullets and A+ FAQ (counts, potency, serving size — from the canonical facts).
- Cover: usage, timing, who it's for, dietary/allergen, storage, what makes it different, results expectations (compliant phrasing).
- Mark "claimBearing": true on benefit-claim answers; do NOT write disclaimer text (system appends it).
Return JSON: { "qa": [{ "q", "a", "claimBearing" }] }`;
}
