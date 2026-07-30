import type { Facts, KnowledgePack } from '@/lib/types';
import { promptDiseaseNouns } from '@/lib/gate/checks/pack';
import { prohibitedContentBlock, prohibitedMarketingBlock, styleRulesBlock } from './shared';

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
  // Full CROSS-PACK union, ordered so the DETECTED subcategories lead (ranking
  // only — never a filter: the gate scans the whole union whatever the product
  // is, across every compliance module the pack assembler attached).
  const activeNouns = promptDiseaseNouns(pack, subcategories);
  const principleLines = pack.principles
    .filter((p) => p.scorable)
    .map((p) => `- [${p.id}] ${p.text}`)
    .join('\n');

  // Category-specific instruction lines are PACK DATA (`compliancePack.promptRules`)
  // — this module renders them, it never authors them.
  const packLines = (cp?.promptRules?.system ?? []).map((line) => `- ${line}`).join('\n');
  // The COMPLIANCE headline rules are PACK DATA too (`promptRules.compliance`)
  // — this module renders them, it no longer authors them.
  const complianceLines = (cp?.promptRules?.compliance ?? []).map((line) => `- ${line}`).join('\n');
  // ALLERGEN DECLARATION RULES — pack data (`compliancePack.allergenRules` +
  // `allergenFields`). The gate enforces an EXACT `canonicalString` match, and
  // this block is the only place the generator is ever told what those strings
  // are; without it the model was failed on a rule it had never been shown.
  const af = cp?.allergenFields;
  const allergenLines =
    cp && af && (cp.allergenRules ?? []).length > 0
      ? `
ALLERGEN DECLARATIONS (exact strings — the gate compares them character for character):
${(cp.allergenRules ?? [])
  .map((r) => `- If the ${af.labelList} contain any of (${r.source}), then attributes.${af.declaration} must be EXACTLY "${r.canonicalString}".`)
  .join('\n')}
- The same declaration must also appear in at least one bullet and in the description, phrased with "${af.declarationVerb}" plus the allergen class or source.
- Never write ${(cp.noAllergenPhrases ?? []).map((x) => `"${x}"`).join(' / ')} when a declarable allergen is present.`
      : '';
  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
${complianceLines}
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- NEVER use disease/condition nouns anywhere. The deterministic gate scans for ALL of these on EVERY surface: ${activeNouns.join(', ')} — plus any other condition name. Reframe as a structure/function state ("supports healthy [system] function", "[parameter] balance").
- Banned marketing phrases: ${cp.superlativeBans.join(', ')}.
${packLines}
${allergenLines}`
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
${prohibitedMarketingBlock(r.prohibitedMarketing)}

STRUCTURE:
- Product name comes FIRST in both titles; the primary keyword immediately after it (never displace the name).
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}
