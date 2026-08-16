import type { Facts, KnowledgePack } from '@/lib/types';
import { descriptionBudget } from '@/lib/gate/checks/c-length';
import { promptDiseaseNouns } from '@/lib/gate/checks/pack';
import {
  approvedClaimBlock,
  prohibitedContentBlock,
  prohibitedMarketingBlock,
  semanticClaimBlock,
  styleRulesBlock,
} from './shared';

/**
 * NO cap on the injected disease-noun list — deliberately.
 *
 * The old 250-term ceiling silently dropped ~440 of the 687 enforced terms, so
 * the model was blind to two thirds of the lexicon and only found out via
 * repair rounds. `tests/redteam3.gate.test.ts` asserts the injected set is a
 * SUPERSET of the gate-enforced set, so re-introducing truncation fails CI.
 *
 * WHAT THIS PROMPT DOES AND DOES NOT COVER (precise, not aspirational — the
 * earlier wording claimed "EVERY term the gate will fail it on", which was not
 * true of several lexicons):
 *
 *  INJECTED IN FULL: the cross-pack disease/drug noun union including the
 *  action-paired tier (C6/A2), the banned verb list, `superlativeBans` (C19/A8),
 *  the pack's own compliance/system prompt rules, the ALLERGEN rules with their
 *  exact `canonicalString` values (C9/A7), the style rules and their allowlist
 *  (C17), the prohibited detail-page content and prohibited marketing LABELS
 *  (C18/C19) and — since round 7 — the semantic drug-claim shapes (C21) and the APPROVED
 *  structure/function claim shapes with the natural-state safe harbour (C22).
 *
 *  NOT INJECTED, and why: the C18/C19 REGEXES themselves (only their
 *  human-readable labels are shown — a regex is not an instruction);
 *  `fictionPhrases` (C11), which are per-run known-false descriptors supplied
 *  by the caller rather than a fixed lexicon; the negation/benign-context and
 *  false-positive-reducer lists (`negationMetaPhrases`, `benignContextPhrases`,
 *  `allergenCompoundExclusions`, `safeContextPhrases`), which only ever make
 *  the gate more permissive; and the C12 unit machinery beyond the canonical
 *  facts block above. A generated listing can therefore still be failed by C11
 *  or by a C18/C19 pattern whose label it misread — which is exactly what the
 *  repair loop exists for.
 */

/**
 * Shared system preamble — identical across groups for prompt caching.
 * `subcategories` are the DETECTED subcategories: they only ORDER the injected
 * disease-noun set, which is exactly the union the gate scans (core ∪ EVERY
 * subcategory list).
 */
/**
 * WS5.5 — the OPERATOR-CONFIRMED PANEL block.
 *
 * Returns '' when the operator confirmed nothing, so the assembled prompt is
 * byte-for-byte what it was before this existed. The heading sentence is PACK
 * DATA (`rules.operatorPanel.promptHeadline`) because it names a category
 * artifact and this module may hold no category vocabulary.
 */
function operatorPanelBlock(
  pack: KnowledgePack,
  panel?: Readonly<Record<string, string>>,
): string {
  const headline = pack.rules?.operatorPanel?.promptHeadline?.trim();
  if (!panel || Object.keys(panel).length === 0 || !headline) return '';
  return `\n\n${headline}\n${JSON.stringify(panel, null, 2)}`;
}

export function buildSystemPrompt(
  pack: KnowledgePack,
  facts: Facts,
  subcategories: string[] = [],
  /** WS5.5 — values the operator read off the label and confirmed (product truth). */
  panelFacts?: Readonly<Record<string, string>>,
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
  // The SEMANTIC claim shapes (C21). A claim needs no disease word to be
  // illegal, so the noun list above is not sufficient prevention on its own.
  const semanticBlock = semanticClaimBlock(cp?.semanticDrugClaims);
  // The PREVENTION half: the lawful structure/function shapes (and the
  // natural-state safe harbour) the generator should write BY CONSTRUCTION.
  // Pack data (`compliancePack.approvedClaimTemplates` + the C22 lists) — this
  // module renders them, it authors none.
  const approvedBlock = approvedClaimBlock(cp);
  const compliance = cp
    ? `
COMPLIANCE (structure/function claims ONLY — this is load-bearing):
${complianceLines}
- Banned verbs as product claims: ${cp.diseaseVerbs.join(', ')}.
- Write every benefit as a structure/function state ("supports healthy [system] function", "[parameter] balance"). The deterministic gate scans EVERY surface against this full enforced list, and against any other condition name — keep all of it out of your copy: ${activeNouns.join(', ')}.
- Banned marketing phrases: ${cp.superlativeBans.join(', ')}.
${packLines}
${approvedBlock}
${semanticBlock}
${allergenLines}`
    : `
No category compliance module is active. Write factual, everyday copy about what the product is and does. No superlatives, no price, no review claims. Do not write any disclaimer text.`;

  /**
   * ONE number, derived, and it is the number the model can act on.
   *
   * This line used to say "≤2000 chars (leave ~250 chars headroom)" while the
   * description group prompt said "≤1700" and C4's repair line said "≤2000" —
   * three different budgets for one field, of which the repair line was both
   * the most actionable and the wrong one, because C4 measures the string AFTER
   * the disclaimer has been appended. See `descriptionBudget` in
   * `lib/gate/checks/c-length.ts`.
   */
  const db = descriptionBudget(pack);
  const disclaimerHeadroom = db.reserve > 0
    ? `- Description: write ≤${db.budget} chars. The system then appends the verbatim compliance disclaimer (${db.reserve} chars) and the finished field must be ≤${db.max} chars, so ${db.budget} is your whole budget.`
    : `- Description ≤${db.max} chars.`;

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
${JSON.stringify(facts, null, 2)}${dosePhrasing}${operatorPanelBlock(pack, panelFacts)}
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
