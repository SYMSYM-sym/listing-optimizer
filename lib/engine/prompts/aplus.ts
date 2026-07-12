import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function aplusPrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: A+ content — real extractable text (AI/voice engines read it).
- 5–7 modules. EVERY module MUST include a non-empty "headline" string (min ~3 chars) — including id "brand-story" and id "hero". Never omit "headline"; do not rename it to title/heading/header.
- Required module ids: "brand-story" (product name must appear in headline or body), "hero" (product name must appear), an ingredients/feature module (declare "Contains: [Allergen]" here if applicable), a how-to-use module, and a who-it's-for module.
- "comparison": { "rows": [ { "label": "...", "ours": "...", "typical": "..." } × ≥3 ] } — keys MUST be exactly label/ours/typical.
- "faq": 5–10 Q&A pairs mirroring the same facts as the bullets.
- Mark "claimBearing": true on any module/answer making a benefit claim; do NOT write disclaimer text (system appends it).
- No price, no "buy now"/"subscribe & save", no urgency, no guarantees, no review claims.

Return JSON with this exact module shape (headline is REQUIRED on every module):
{
  "modules": [
    { "id": "brand-story", "headline": "...", "body": "...", "claimBearing": false },
    { "id": "hero", "headline": "...", "body": "...", "claimBearing": true },
    { "id": "ingredients", "headline": "...", "body": "...", "claimBearing": false },
    { "id": "how-to-use", "headline": "...", "body": "...", "claimBearing": false },
    { "id": "who-its-for", "headline": "...", "body": "...", "claimBearing": true }
  ],
  "comparison": { "rows": [{ "label": "...", "ours": "...", "typical": "..." }] },
  "faq": [{ "q": "...", "a": "...", "claimBearing": false }]
}`;
}
