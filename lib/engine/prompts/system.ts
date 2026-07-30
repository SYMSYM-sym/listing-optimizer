import type { Facts, KnowledgePack } from '@/lib/types';
import { activeDiseaseNouns } from '@/lib/gate/checks/pack';
import { prohibitedContentBlock, styleRulesBlock } from './shared';

/**
 * NO cap on the injected disease-noun list — deliberately.
 *
 * The generator must be told EVERY term the gate will fail it on (prevention
 * layer). The old 250-term ceiling silently dropped ~440 of the 687 enforced
 * terms, so the model was blind to two thirds of the lexicon and only found out
 * via repair rounds. `tests/redteam3.gate.test.ts` asserts the injected set is a
 * SUPERSET of the gate-enforced set, so re-introducing truncation fails CI.
 */

/**
 * Shared system preamble — identical across groups for prompt caching.
 * `subcategories` are the DETECTED subcategories: they only ORDER the injected
 * disease-noun set, which is exactly the union the gate scans (core ∪ EVERY
 * subcategory list).
 */
export function buildSystemPrompt(
  pack: KnowledgePack,
  facts: Facts,
  subcategories: string[] = [],
): string {
  const r = pack.rules;
  const cp = pack.compliancePack;
  // Full union, ordered so the DETECTED subcategories lead (ranking only —
  // never a filter: the gate scans the whole union whatever the product is).
  const activeNouns = cp ? activeDiseaseNouns(cp, subcategories) : [];
  const principleLines = pack.principles
    .filter((p) => p.scorable)
    .map((p) => `- [${p.id}] ${p.text}`)
    .join('\n');

  // Category-specific instruction lines are PACK DATA (`compliancePack.promptRules`)
  // — this module renders them, it never authors them.
  const packLines = (cp?.promptRules?.system ?? []).map((line) => `- ${line}`).join('\n');
  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
- NEVER claim to diagnose, treat, cure, prevent, or mitigate any disease or symptom.
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- NEVER use disease/condition nouns anywhere. The deterministic gate scans for ALL of these on EVERY surface: ${activeNouns.join(', ')} — plus any other condition name. Reframe as a structure/function state ("supports healthy [system] function", "[parameter] balance").
- Banned marketing phrases: ${cp.superlativeBans.join(', ')}. No star-rating or review-count claims. No price in copy.
${packLines}`
    : `
No category compliance module is active. Write factual, non-medical copy. No superlatives, no price, no review claims. Do not write any disclaimer text.`;

  const disclaimerHeadroom = cp
    ? `- Description ≤${r.descriptionMax} chars (leave ~250 chars headroom — the system appends the verbatim compliance disclaimer).`
    : `- Description ≤${r.descriptionMax} chars.`;

  const dosePhrasing = (r.units?.perServingPhrases ?? []).length > 0
    ? `\n- Potency figures attach to the blend/formula, NEVER phrased ${(r.units.perServingPhrases).map((x) => `"${x}"`).join(' / ')}.`
    : '';

  return `You are an Amazon listing copy engine. You write ONE JSON object per request, matching the requested schema exactly. No prose outside JSON.

HARD LIMITS (checked by deterministic code — leave headroom):
- Legacy title ≤${r.titleMaxLegacy} chars. New title ≤${r.title75Max} chars (policy eff. Jul 27 2026). Item Highlights ≤${r.itemHighlightsMax} chars.
- Exactly ${r.bulletCount} bullets, each ≤${r.bulletMax} chars.
${disclaimerHeadroom}
- Backend search terms ≤${r.backendMaxBytes} UTF-8 BYTES, lowercase, space-separated, no punctuation.
- No word more than ${r.titleWordRepetition.max}× in the title. Banned title chars: ${r.style.bannedChars.join(' ')} (use hyphen/comma/&/parentheses).

OPTIMIZATION PRINCIPLES (ground copy in these):
${principleLines}

CANONICAL FACTS (every number you write MUST match these exactly; if a fact is absent, do not invent one):
${JSON.stringify(facts, null, 2)}${dosePhrasing}
${compliance}

${styleRulesBlock(r.style)}
${prohibitedContentBlock(r.prohibitedContent)}

STRUCTURE:
- Product name comes FIRST in both titles; the primary keyword immediately after it (never displace the name).
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}
