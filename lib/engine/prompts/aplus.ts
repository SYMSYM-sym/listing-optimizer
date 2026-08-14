import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import { APLUS_BODY_MIN_CHARS, APLUS_HEADLINE_MIN_CHARS } from '../schemas';
import { canonicalNameBlock, snapshotBlock } from './shared';

export function aplusPrompt(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  styleBlock = '',
  canonicalProductName = '',
): string {
  // Required module ids and the category's own module guidance are PACK DATA.
  const ids = pack.rules.aplusModuleIds;
  const cues = pack.rules.aplusModuleCues;
  const packLines = (pack.compliancePack?.promptRules?.aplus ?? []).map((line) => `- ${line}\n`).join('');
  const skeleton = ids
    .map((id, i) => `    { "id": "${id}", "headline": "...", "body": "...", "claimBearing": ${i === 0 ? 'false' : 'true'} }`)
    .join(',\n');
  // A4 needs the canonical name verbatim in the brand-story and hero modules —
  // module cues come off the pack, so no id literal appears in this module.
  const canonical = canonicalNameBlock(
    canonicalProductName,
    `The module whose id contains "${cues.brandStory}" AND the module whose id contains "${cues.hero}" must EACH contain that exact string in their headline or body.`,
  );
  // A9 requires an explicit who-it's-for cue somewhere in the A+ content. The
  // accepted phrasings are PACK DATA (`rules.whoItsForCues`) so the generator is
  // shown exactly what the gate scans for, rather than being failed on a rule it
  // was never told about.
  const whoCues = (pack.rules.whoItsForCues ?? []).map((c) => c.trim()).filter(Boolean);
  const whoLine = whoCues.length
    ? `- AUDIENCE (deterministically checked): state plainly who the product is for, in a module or in an FAQ answer, using one of these exact phrasings verbatim: ${whoCues
        .map((c) => `"${c}"`)
        .join(', ')}. Name the actual buyer (routine, life stage, usage context) — never a vague "everyone".\n`
    : '';
  return `${snapshotBlock(snapshot)}

${styleBlock}

${canonical}
TASK: A+ content — real extractable text (AI/voice engines read it).
- 5–7 modules. EVERY module MUST include a non-empty "headline" string (at least ${APLUS_HEADLINE_MIN_CHARS} characters) AND a non-empty "body" string of at least ${APLUS_BODY_MIN_CHARS} characters — the LAST module as fully as the first. Never omit "headline" or "body"; do not rename them (no title/heading/header, no text/copy/content).
- Required module ids (use these ids exactly; the product name must appear in the first two): ${ids.map((id) => `"${id}"`).join(', ')}.
${packLines}- "comparison": { "rows": [ { "label": "...", "ours": "...", "typical": "..." } × ≥${pack.rules.aplusComparisonMinRows} ] } — keys MUST be exactly label/ours/typical.
- "faq": 5–10 Q&A pairs mirroring the same facts as the bullets.
${whoLine}- Mark "claimBearing": true on any module/answer making a benefit claim; do NOT write disclaimer text (system appends it).
- No cost figures, no purchase or upsell CTAs, no urgency wording, no promise about outcomes or returns, no rating or review claims. State what the module DOES say — never quote a banned phrase in order to forbid it.

Return JSON with this exact module shape (headline is REQUIRED on every module):
{
  "modules": [
${skeleton}
  ],
  "comparison": { "rows": [{ "label": "...", "ours": "...", "typical": "..." }] },
  "faq": [{ "q": "...", "a": "...", "claimBearing": false }]
}`;
}
