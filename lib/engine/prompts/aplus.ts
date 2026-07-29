import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function aplusPrompt(snapshot: ListingSnapshot, pack: KnowledgePack, styleBlock = ''): string {
  // Required module ids and the category's own module guidance are PACK DATA.
  const ids = pack.rules.aplusModuleIds;
  const packLines = (pack.compliancePack?.promptRules?.aplus ?? []).map((line) => `- ${line}\n`).join('');
  const skeleton = ids
    .map((id, i) => `    { "id": "${id}", "headline": "...", "body": "...", "claimBearing": ${i === 0 ? 'false' : 'true'} }`)
    .join(',\n');
  return `${snapshotBlock(snapshot)}

${styleBlock}

TASK: A+ content — real extractable text (AI/voice engines read it).
- 5–7 modules. EVERY module MUST include a non-empty "headline" string (min ~3 chars). Never omit "headline"; do not rename it to title/heading/header.
- Required module ids (use these ids exactly; the product name must appear in the first two): ${ids.map((id) => `"${id}"`).join(', ')}.
${packLines}
- "comparison": { "rows": [ { "label": "...", "ours": "...", "typical": "..." } × ≥3 ] } — keys MUST be exactly label/ours/typical.
- "faq": 5–10 Q&A pairs mirroring the same facts as the bullets.
- Mark "claimBearing": true on any module/answer making a benefit claim; do NOT write disclaimer text (system appends it).
- No price, no purchase or upsell CTAs, no urgency, no guarantees, no review claims.

Return JSON with this exact module shape (headline is REQUIRED on every module):
{
  "modules": [
${skeleton}
  ],
  "comparison": { "rows": [{ "label": "...", "ours": "...", "typical": "..." }] },
  "faq": [{ "q": "...", "a": "...", "claimBearing": false }]
}`;
}
