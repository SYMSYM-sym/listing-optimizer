import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function imagesPrompt(snapshot: ListingSnapshot, pack: KnowledgePack): string {
  const r = pack.rules;
  const [wr, wg, wb] = r.imageMainWhiteRgb;
  return `${snapshotBlock(snapshot)}

TASK: A 7-slot image/creative plan.
Slots: (1) main image on pure white RGB ${wr}/${wg}/${wb}, product ≥${r.imageMainProductFillPct}% of frame, longest side ≥${r.imageMainMinLongSidePx}px; (2) value-prop infographic; (3) a real photograph of any regulated facts panel on the label — never AI-generated or altered; (4) key-component/feature story; (5) how-to-use routine; (6) trust/heritage (substantiated signals only); (7) lifestyle/outcome.
- "spec": concrete requirements per slot. Write "purpose", "spec" and "notes" in sentence case — never in capitals. "notes": copy/layout guidance.
- Every field describes ONLY what the finished image SHOWS. Write it as a positive instruction ("show the printed panel, sharp and evenly lit"), keep the wording factual and non-medical, and keep the overlay text to product facts. Never restate a compliance, policy or copy rule inside a brief, and never spell out the vocabulary such a rule bans: a brief is customer-adjacent copy and is scanned exactly like a bullet, so a word you only mention in order to forbid it still lands in the listing.
- Overlays carry product facts only: no figures or symbols for cost, no rating or review marks, no promotional or urgency wording, no promise about outcomes or returns.
Return JSON: { "imagePlan": [{ "slot", "purpose", "spec", "notes" } ×7] }`;
}
