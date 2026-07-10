import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function aplusPrompt(snapshot: ListingSnapshot): string {
  return `${snapshotBlock(snapshot)}

TASK: A+ content — real extractable text (AI/voice engines read it).
- 5–7 modules including: id "brand-story" (brand story; product name must appear), id "hero" (hero module; product name must appear), an ingredients/feature module (declare "Contains: [Allergen]" here if applicable), a how-to-use module, and a who-it's-for module.
- "comparison": ≥3 rows framing ours vs a typical alternative, compliant and factual (no competitor names, no superlatives).
- "faq": 5–10 Q&A pairs mirroring the same facts as the bullets.
- Mark "claimBearing": true on any module/answer making a benefit claim; do NOT write disclaimer text (system appends it).
- No price, no "buy now"/"subscribe & save", no urgency, no guarantees, no review claims.
Return JSON: { "modules": [...], "comparison": { "rows": [...] }, "faq": [...] }`;
}
