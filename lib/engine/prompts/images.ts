import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function imagesPrompt(snapshot: ListingSnapshot, pack: KnowledgePack): string {
  const r = pack.rules;
  const [wr, wg, wb] = r.imageMainWhiteRgb;
  return `${snapshotBlock(snapshot)}

TASK: A 7-slot image/creative plan.
Slots: (1) main image on pure white RGB ${wr}/${wg}/${wb}, product ≥${r.imageMainProductFillPct}% of frame, longest side ≥${r.imageMainMinLongSidePx}px; (2) value-prop infographic; (3) REAL PHOTOGRAPH of any regulated facts panel on the label — never AI-generated or altered; (4) ingredient/feature story; (5) how-to-use routine; (6) trust/heritage (substantiated signals only); (7) lifestyle/outcome.
- "spec": concrete requirements per slot. "notes": copy/layout guidance. No price, ratings, guarantees, or promotional CTAs on any image.
Return JSON: { "imagePlan": [{ "slot", "purpose", "spec", "notes" } ×7] }`;
}
