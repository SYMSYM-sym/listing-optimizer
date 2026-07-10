import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function bulletsPrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: Write exactly 5 bullets, each ≤240 chars (leave headroom to 255).
- Each bullet serves ONE major use-case with a distinct, quotable situational anchor line.
- Lead each bullet with a SHORT ALL-CAPS HOOK followed by a colon.
- One bullet must declare the allergen ("Contains: ...") if any allergen is present in the ingredients; if none, one bullet covers quality/testing signals instead.
- Claim-bearing bullets end with "*" (no disclaimer text in bullets — the system handles it).
- "useCaseAnchor": 2–5 word label of the use-case the bullet anchors.
Return JSON: { "bullets": [{ "text", "useCaseAnchor", "claimBearing" } ×5] }`;
}
