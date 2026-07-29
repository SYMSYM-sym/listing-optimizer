import type { Facts, KnowledgePack } from '@/lib/types';
import { activeDiseaseNouns } from '@/lib/gate/checks/pack';
import { prohibitedContentBlock, styleRulesBlock } from './shared';

/**
 * Upper bound on the injected disease-noun list. The generator must be told
 * every term the gate will actually fail it on (prevention layer) — truncating
 * to a handful guaranteed repair rounds on terms it was never shown.
 */
const MAX_INJECTED_NOUNS = 250;

/**
 * Shared system preamble — identical across groups for prompt caching.
 * `subcategories` are the DETECTED subcategories: the injected disease-noun set
 * is exactly the union the gate scans (core ∪ active subcategory lists).
 */
export function buildSystemPrompt(
  pack: KnowledgePack,
  facts: Facts,
  subcategories: string[] = [],
): string {
  const r = pack.rules;
  const cp = pack.compliancePack;
  const activeNouns = cp ? activeDiseaseNouns(cp, subcategories).slice(0, MAX_INJECTED_NOUNS) : [];
  const principleLines = pack.principles
    .filter((p) => p.scorable)
    .map((p) => `- [${p.id}] ${p.text}`)
    .join('\n');

  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
- NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or symptom.
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- NEVER use disease/condition nouns anywhere. The deterministic gate scans for ALL of these on EVERY surface: ${activeNouns.join(', ')} — plus any other condition name. Reframe as a structure/function state ("supports healthy [system] function", "[parameter] balance").
- Banned marketing phrases: ${cp.superlativeBans.join(', ')}. No star-rating or review-count claims. No price in copy.
- Do NOT write the FDA disclaimer anywhere — the system inserts the verbatim constant itself. Claim-bearing bullets end with a trailing "*" marker only.
- If an allergen is present, declare it exactly as "Contains: [Allergen]" consistently; never write "No Known Allergens" when one is present.`
    : `
No category compliance module is active. Write factual, non-medical copy. No superlatives, no price, no review claims. Do not write any FDA disclaimer text.`;

  const disclaimerHeadroom = cp
    ? `- Description ≤${r.descriptionMax} chars (leave ~250 chars headroom — the system appends the FDA disclaimer).`
    : `- Description ≤${r.descriptionMax} chars.`;

  return `You are an Amazon listing copy engine. You write ONE JSON object per request, matching the requested schema exactly. No prose outside JSON.

HARD LIMITS (checked by deterministic code — leave headroom):
- Legacy title ≤${r.titleMaxLegacy} chars. New title ≤${r.title75Max} chars (policy eff. Jul 27 2026). Item Highlights ≤${r.itemHighlightsMax} chars.
- Exactly ${r.bulletCount} bullets, each ≤${r.bulletMax} chars.
${disclaimerHeadroom}
- Backend search terms ≤${r.backendMaxBytes} UTF-8 BYTES, lowercase, space-separated, no punctuation.
- No word more than 2× in the title. Banned title chars: ${r.style.bannedChars.join(' ')} (use hyphen/comma/&/parentheses).

OPTIMIZATION PRINCIPLES (ground copy in these):
${principleLines}

CANONICAL FACTS (every number you write MUST match these exactly; if a fact is absent, do not invent one):
${JSON.stringify(facts, null, 2)}
- Potency figures attach to the blend/formula, NEVER phrased "per serving".
${compliance}

${styleRulesBlock(r.style)}
${prohibitedContentBlock(r.prohibitedContent)}

STRUCTURE:
- Product name comes FIRST in both titles; the primary keyword immediately after it (never displace the name).
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}
