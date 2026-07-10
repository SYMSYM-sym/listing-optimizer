import type { Facts, KnowledgePack } from '@/lib/types';

/** Shared system preamble — identical across groups for prompt caching. */
export function buildSystemPrompt(pack: KnowledgePack, facts: Facts): string {
  const r = pack.rules;
  const cp = pack.compliancePack;
  const principleLines = pack.principles
    .filter((p) => p.scorable)
    .slice(0, 8)
    .map((p) => `- [${p.id}] ${p.text}`)
    .join('\n');

  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
- NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or symptom.
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- NEVER use disease/condition nouns anywhere (examples: ${cp.coreDiseaseNouns.slice(0, 12).join(', ')}, and any condition name). Reframe as a structure/function state ("supports healthy [system] function", "[parameter] balance").
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
- No word more than 2× in the title. Banned title chars: ! $ ? _ { } ^ ¬ ¦ (use hyphen/comma/&/parentheses).

OPTIMIZATION PRINCIPLES (ground copy in these):
${principleLines}

CANONICAL FACTS (every number you write MUST match these exactly; if a fact is absent, do not invent one):
${JSON.stringify(facts, null, 2)}
- Potency figures attach to the blend/formula, NEVER phrased "per serving".
${compliance}

STYLE:
- Product name comes FIRST in both titles; the primary keyword immediately after it (never displace the name).
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}
