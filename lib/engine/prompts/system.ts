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
  /**
   * THE OTHER HALF OF THE DECLARATION, which the model was never shown.
   *
   * AM-4a (C23 R4, `noneStyleAllergenDeclaration` in
   * `lib/gate/checks/c-attributes.ts`) requires the declaration attribute to
   * equal `compliancePack.noAllergenCanonical` EXACTLY when the label declares
   * no allergen — and that string was rendered into no prompt anywhere in this
   * engine. A live run of B00EEEITVA came back
   * `C23 | attributes.allergen_information | none`: the model answered the field
   * sensibly and was failed on an exact string it had never been given. Same
   * condition `redteam3`/`redteam4` exist to prevent for the disease lexicon —
   * a generator not shown the rule is failed on a rule it was never told. The
   * repair loop's routing and fix line were both correct and are untouched;
   * what was missing was PREVENTION on the first attempt.
   *
   * Pack data, like every line around it: empty key ⇒ empty string.
   */
  const noAllergenCanonical = cp?.noAllergenCanonical?.trim();
  const noAllergenLine =
    noAllergenCanonical && af
      ? `\n- If the ${af.labelList} declare none of them, then attributes.${af.declaration} must be EXACTLY "${noAllergenCanonical}". The field is answered either way — a blank reads as unanswered, and a wording of your own cannot be verified.`
      : '';
  const allergenLines =
    cp && af && (cp.allergenRules ?? []).length > 0
      ? `
ALLERGEN DECLARATIONS (exact strings — the gate compares them character for character):
${(cp.allergenRules ?? [])
  .map((r) => `- If the ${af.labelList} contain any of (${r.source}), then attributes.${af.declaration} must be EXACTLY "${r.canonicalString}".`)
  .join('\n')}${noAllergenLine}
- The same declaration must also appear in at least one bullet and in the description, phrased with "${af.declarationVerb}" plus the allergen class or source.
- Never write ${(cp.noAllergenPhrases ?? []).map((x) => `"${x}"`).join(' / ')} when a declarable allergen is present.`
      : '';
  /**
   * M1 — THE PREVENTION HALF of the study-endorsement ban, rendered FROM PACK
   * DATA (`compliancePack.trustFramingNote`).
   *
   * C19/A8 fail the study-endorsement row on EVERY surface, and the only thing
   * the assembled prompt said about that class was its LABEL, one of twenty in
   * the prohibited-marketing list. A label is a category name, not a substitute:
   * a live run of B00EEEITVA — whose SOURCE listing leads on exactly that
   * framing — came back with the same row failing three A+ fields under C19 and
   * the same three bodies under A8, and never converged, because every repair
   * round regenerated the A+ block from that same source with nothing else to
   * reach for in a brand-story module or a comparison column.
   *
   * This is the mirror of `approvedClaimBlock` (the prevention half for C22):
   * the ban stays exactly where it is, and the model is told what it MAY write.
   * The sentence is PACK DATA and names no banned phrase — the round-4 record in
   * `tests/promptHygiene.test.ts` is what happens when an instruction spells out
   * the form it forbids. Empty key ⇒ empty string ⇒ the prompt is byte-for-byte
   * what it was.
   */
  const trustNote = cp?.trustFramingNote?.trim();
  const trustLine = trustNote ? `\n- ${trustNote}` : '';
  /**
   * N2 — THE WORKED SHAPES for the same class (`compliancePack.trustFramingExamples`).
   *
   * The note above says what verifiable trust framing IS available, and it is
   * still a description of a form rather than the form. Against a source
   * listing that leads on the banned framing the description lost: the same row
   * came back on `aplus.modules[ingredients]` under both checks. These entries
   * are the form itself — compliant sentences with bracketed slots the model
   * fills from the canonical facts, the operator panel or the source listing —
   * and, being compliant, they name no phrase either check reacts to. Empty or
   * absent key ⇒ no line, and the assembled prompt is byte-for-byte what it was.
   */
  const trustExamples = (cp?.trustFramingExamples ?? []).map((e) => e.trim()).filter(Boolean);
  const trustExampleLine = trustExamples.length
    ? `\n- Written out — copy one of these shapes into a brand-story module or a comparison column, filling each bracketed slot from the canonical facts, the operator panel or the source listing above: ${trustExamples
        .map((e) => `"${e}"`)
        .join(' | ')}`
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
${complianceLines}${trustLine}${trustExampleLine}
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
   *
   * IT IS `db.target`, NOT `db.budget`. `budget` is the exact count at which
   * C4 starts failing; a later live run (B00IO89MYA) wrote 1861 against a
   * correctly-stated 1842 and the appended disclaimer carried the field 19
   * characters over the cap. `target` is that same arithmetic with a derived
   * safety margin taken off, so an ordinary small overshoot still lands inside
   * the limit. The margin is computed in `descriptionBudget` and nowhere else.
   */
  const db = descriptionBudget(pack);
  const disclaimerHeadroom = db.reserve > 0
    ? `- Description: write ≤${db.target} chars. The system then appends the verbatim compliance disclaimer (${db.reserve} chars) and the finished field must be ≤${db.max} chars, so ${db.target} is your whole budget.`
    : `- Description ≤${db.target} chars.`;

  /**
   * THE COMPOUND-TAIL EXEMPTION, RENDERED FROM PACK DATA.
   *
   * C1 counts stemmed title words, and a qualifier tail attached to a distinct
   * head is now exempt (`rules.titleWordRepetition.compoundTails` — see
   * `titleRepetitionCounts` in `lib/gate/checks/c-length.ts`, and the live
   * B00EEEITVA over-block recorded there). The rule STATED to the model has to
   * be the rule ENFORCED by the gate, or the generator writes to a limit that
   * is not the one it is measured against — so the exemption and its four
   * carve-outs are rendered here, from the pack, with no list of our own.
   *
   * Empty list ⇒ empty string, so a pack without the key produces the exact
   * prompt it produced before this existed.
   */
  const tails = (r.titleWordRepetition?.compoundTails ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const tailNote = tails.length > 0
    ? ` ONE exception: ${tails.map((t) => `"${t}"`).join(' / ')} does not count when each occurrence follows a DIFFERENT preceding word, i.e. a distinct compound each time ("A ${tails[0]}, B ${tails[0]}, C ${tails[0]}"). A bare one, a compound written twice, or one that follows another such qualifier all still count — and the preceding word itself always counts.`
    : '';

  // ROUND 4 — POSITIVE, and it names no phrasing.
  //
  // This line used to read "NEVER phrased <the pack's per-dose phrasings>", and
  // `heroSpecBlock` said the same thing at the image and A+ surfaces. A live run
  // of B00EEEITVA echoed our own contrast straight into `imagePlan[1].spec`
  // ("…as a property of the whole blend (not per serving") and C10 — which
  // reacts to exactly that phrase beside a potency figure — failed the listing
  // on its own instruction. Third occurrence of the class; see the header of
  // `tests/promptHygiene.test.ts`. The rule is stated as the constraint it is,
  // and the forbidden surface form is no longer written down anywhere the model
  // can read it. Still rendered only when the pack ships the rule at all.
  const dosePhrasing = (r.units?.perServingPhrases ?? []).length > 0
    ? '\n- A potency figure describes the blend/formula as a whole: write the figure together with the whole it belongs to.'
    : '';

  return `You are an Amazon listing copy engine. You write ONE JSON object per request, matching the requested schema exactly. No prose outside JSON.

HARD LIMITS (checked by deterministic code — leave headroom):
- Legacy title ≤${r.titleMaxLegacy} chars. New title ≤${r.title75Max} chars (policy eff. Jul 27 2026). Item Highlights ≤${r.itemHighlightsMax} chars.
- Exactly ${r.bulletCount} bullets, each ≤${r.bulletMax} chars.
${disclaimerHeadroom}
- Backend search terms ≤${r.backendMaxBytes} UTF-8 BYTES, lowercase, space-separated, no punctuation.
- No word more than ${r.titleWordRepetition.max}× in the title.${tailNote} Banned title chars: ${r.style.bannedChars.join(' ')} (use hyphen/comma/&/parentheses).

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
- A backend brand / manufacturer string may enter customer copy ONLY as part of the product name. If the product name you choose does not contain that string, then deterministic code bars that string from EVERY customer surface and from every other attribute — so leading the product name with it is the one choice that keeps the brand in the copy at all.
- Write for buyer situations; one distinct, quotable situational anchor per major use-case.
- Include comparative framing (vs typical alternatives) and who-it's-for, phrased compliantly.
- Backend terms: only synonyms/misspellings/other-language variants that appear NOWHERE in visible copy; never repeat title words; no brand names, no ASINs.`;
}
