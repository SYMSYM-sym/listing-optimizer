import type {
  CompliancePack,
  ListingSnapshot,
  ProhibitedContentRules,
  ProhibitedMarketingRules,
  SemanticDrugClaims,
  SemanticTargetEntry,
  StyleRules,
} from '@/lib/types';

/**
 * SEMANTIC drug-claim instructions rendered FROM PACK DATA
 * (`compliancePack.semanticDrugClaims`) — the prevention half of gate C21.
 *
 * C21 fails a claim SHAPE, not a vocabulary, so listing the disease nouns is
 * not enough: the generator has to be shown the shapes as well, or it is failed
 * on a rule it was never told about. Renders the pack's lists; authors none.
 */

/**
 * A target list entry may be a bare term or a CONTEXT-QUALIFIED object
 * (`SemanticTarget`). The generator is shown the TERM either way: the context
 * qualification narrows when the gate reports, and telling the model "plaque is
 * fine as long as you do not mention arteries" would invite exactly the
 * sentence the gate exists to stop.
 */
const targetTerm = (entry: SemanticTargetEntry): string =>
  typeof entry === 'string' ? entry : String(entry?.term ?? '');

const targetTerms = (entries: SemanticTargetEntry[] | undefined): string[] =>
  (entries ?? []).map(targetTerm).filter((t) => t.trim() !== '');
export function semanticClaimBlock(sdc: SemanticDrugClaims | undefined): string {
  if (!sdc) return '';
  const lines: string[] = [];
  if ((sdc.pathologicalActionVerbs ?? []).length > 0 && (sdc.anatomicalTargets ?? []).length > 0) {
    lines.push(
      `- NEVER write an action verb (${sdc.pathologicalActionVerbs.join(', ')}) acting on a body structure (${[...targetTerms(sdc.anatomicalTargets), ...targetTerms(sdc.determinerScopedTargets)].join(', ')}). "Shrinks the lump", "clears the plaque", "melts the growth" are drug claims even though they name no disease.`,
    );
  }
  if ((sdc.replacementCues ?? []).length > 0 && (sdc.medicalDeviceOrTherapyNouns ?? []).length > 0) {
    lines.push(
      `- NEVER say the product replaces, ends the need for, or lets the reader stop a medical therapy or device (${sdc.medicalDeviceOrTherapyNouns.join(', ')}). Banned phrasings include: ${sdc.replacementCues.join(', ')}.`,
    );
  }
  if ((sdc.functionRestorationVerbs ?? []).length > 0 && (sdc.lostFunctionNouns ?? []).length > 0) {
    lines.push(
      `- NEVER claim to give back a lost bodily function (${sdc.lostFunctionNouns.join(', ')}) with verbs such as ${sdc.functionRestorationVerbs.join(', ')}.`,
    );
  }
  if ((sdc.patterns ?? []).length > 0) {
    const labels = [...new Set(sdc.patterns.map((row) => row[1]).filter(Boolean))];
    if (labels.length > 0) {
      lines.push(`- NEVER write any of: ${labels.join('; ')}.`);
    }
  }
  if (lines.length === 0) return '';
  return `SEMANTIC DRUG CLAIMS (deterministically checked by C21 — a claim needs no disease word to be illegal):\n${lines.join('\n')}`;
}

/**
 * APPROVED CLAIM TEMPLATES — the PREVENTION half of the natural-state doctrine
 * C22 enforces, rendered FROM PACK DATA (`compliancePack.approvedClaimTemplates`).
 *
 * Telling the generator what is forbidden is only half a compliance brain. The
 * FDA structure/function rule is a SAFE HARBOUR as well as a prohibition: a
 * statement describing the role of a nutrient or ingredient in affecting the
 * normal structure or function of the body is lawful, and so is the normal
 * symptomology of a natural state when it is qualified as the mild or
 * occasional form. These shapes are the safe harbour written out, so the model
 * writes compliant copy by construction rather than being repaired into it.
 *
 * Every line is a lawful phrasing — nothing here names a banned term, which is
 * what keeps `tests/promptHygiene.test.ts` green even though this block is
 * rendered into the shared preamble.
 */
export function approvedClaimBlock(cp: CompliancePack | null | undefined): string {
  const shapes = (cp?.approvedClaimTemplates ?? []).map((t) => t.trim()).filter(Boolean);
  if (shapes.length === 0) return '';
  const clean = (v: string[] | undefined): string[] =>
    (v ?? []).map((x) => x.trim()).filter(Boolean);
  const qualifiers = clean(cp?.lawfulQualifiers);
  const states = clean(cp?.naturalStates);
  const markers = clean(cp?.abnormalityMarkers);
  const lines = [
    'APPROVED CLAIM SHAPES (write EVERY benefit claim as one of these — bracketed slots are filled from the canonical facts above):',
    ...shapes.map((t) => `- "${t}"`),
  ];
  if (states.length > 0) {
    lines.push(
      `- These are NATURAL STATES, not conditions to be acted on: ${states.join(', ')}. Write about the normal, everyday experience of one — never about acting on it.`,
    );
  }
  if (qualifiers.length > 0) {
    lines.push(
      `- Keep every such sentence inside the safe harbour with one of: ${qualifiers.join(', ')}.`,
    );
  }
  if (markers.length > 0) {
    lines.push(
      `- These words turn the same sentence into a medical claim — never pair one with a benefit: ${markers.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/**
 * CANONICAL product name block — the PREVENTION half of C8 / C15 / A4.
 *
 * `productName` is invented by the TITLE group, but three deterministic checks
 * demand that exact identifier on surfaces owned by OTHER groups: C8 (must
 * start `title` AND appear in `description`), C15 (must start `title75`) and A4
 * (must appear in the A+ brand-story and hero modules). While every group was
 * generated in ONE parallel fan-out, the description and A+ groups could not
 * possibly know which name the title group was choosing — they satisfied C8/A4
 * only by luck, when the model happened to echo the source listing's name.
 *
 * `optimize()` now resolves the name in a short first phase and states it here,
 * so the embedding groups are TOLD the identifier instead of guessing it. This
 * is instruction, not laundering: no generated copy is rewritten afterwards and
 * the gate still re-validates every surface independently and fails closed.
 *
 * `requirement` is the group-specific obligation, passed in by the caller; this
 * module hard-codes no product name and no category text.
 */
export function canonicalNameBlock(productName: string, requirement: string): string {
  const name = (productName ?? '').trim();
  if (!name) return '';
  return `CANONICAL product name: "${name}"
Use this EXACT string — character for character. Never shorten, expand, re-order,
translate or rephrase it, and never substitute the name the source listing above
uses. It is a SHARED identifier: the title leads with it, the description must
contain it verbatim, and the A+ brand-story and hero modules must each contain it
verbatim.
${requirement}
`;
}

export function snapshotBlock(snapshot: ListingSnapshot): string {
  return `CURRENT LISTING (source data — improve, don't copy mistakes):
Title: ${snapshot.title}
Bullets:
${snapshot.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}
Description: ${snapshot.description.slice(0, 1500)}
Category: ${snapshot.category}
Attributes: ${JSON.stringify(snapshot.attributes)}`;
}

/**
 * Style/formatting instructions rendered FROM PACK DATA (`rules.style`) so the
 * generator is taught exactly what gate C17 enforces. No literals here — every
 * threshold and list is read off the pack.
 */
export function styleRulesBlock(style: StyleRules): string {
  const lines: string[] = [
    `- Sentence case only. Do NOT use all-capital words of ${style.allCapsMinWordLen}+ characters for emphasis anywhere (no all-caps bullet hooks). These acronyms are the only exceptions: ${style.allCapsAllowlist.join(', ')}.`,
  ];
  if (style.bulletMustStartCapital) {
    lines.push('- Every bullet begins with a capital letter.');
  }
  if (style.bulletNoTrailingPunctuation) {
    lines.push(
      `- No bullet ends with punctuation (${style.bulletTrailingPunctuation.split('').join(' ')}). A trailing ${style.bulletTrailingAllowed.map((m) => `"${m}"`).join(' or ')} is allowed.`,
    );
  }
  lines.push(`- Never use these symbols: ${style.bannedSymbols.join(' ')}.`);
  if (style.emojiCheck) lines.push('- Never use emoji.');
  lines.push(
    `- Never use these characters in ${style.bannedCharsSurfaces.join(', ')}: ${style.bannedChars.join(' ')} (use hyphen, comma, ampersand or parentheses instead).`,
  );
  if (style.noAsinInCopy) lines.push('- Never write an ASIN (product identifier) in customer-facing copy.');
  lines.push(
    `- Never use promotional or ranking terms in ${style.titleTermBanSurfaces.join(', ')}: ${style.titleTermBans.join(', ')}.`,
  );
  lines.push(
    `- Write the description as PLAIN TEXT paragraphs separated by a blank line. Do not emit HTML: the only tag Amazon still honours there is ${style.descriptionAllowedHtml
      .map((t) => `<${t}>`)
      .join('/')}, and the export adds it for you. Keep the description under ${style.descriptionMaxBytes} UTF-8 bytes.`,
  );
  return `STYLE + FORMATTING (deterministically checked \u2014 fix the copy, never the rule):\n${lines.join('\n')}`;
}

/**
 * Prohibited detail-page content instructions rendered FROM PACK DATA
 * (`rules.prohibitedContent`) — prevention at generation time. The gate's C18
 * independently verifies afterwards (worker != checker).
 */
export function prohibitedContentBlock(rules: ProhibitedContentRules | undefined): string {
  if (!rules || rules.patterns.length === 0) return '';
  const labels = Array.from(new Set(rules.patterns.map(([, label]) => label)));
  return [
    'AMAZON PROHIBITED CONTENT — never include any of the following anywhere in the listing:',
    `- ${labels.join('\n- ')}`,
    '- This includes prices written as symbols ($19.95) AND spelled out ("thirty nine dollars and ninety five cents"). Never state, imply or reference the product price, discounts, shipping offers, stock/availability, item condition, or any email, URL or phone number.',
  ].join('\n');
}

/**
 * Prohibited MARKETING instructions rendered FROM PACK DATA
 * (`rules.prohibitedMarketing`) — the mirror of `prohibitedContentBlock`.
 *
 * C19 enforces this list on every surface, but the generator was never shown
 * it: only C18's labels were injected. `tests/redteam4.gate.test.ts` asserts
 * the rendered label set is a SUPERSET of the enforced pattern labels, so a
 * pattern cannot be added to the pack without the prompt learning about it.
 */
export function prohibitedMarketingBlock(rules: ProhibitedMarketingRules | undefined): string {
  if (!rules || rules.patterns.length === 0) return '';
  const labels = Array.from(new Set(rules.patterns.map(([, label]) => label)));
  return [
    'AMAZON PROHIBITED MARKETING CLAIMS — never include any of the following anywhere in the listing:',
    `- ${labels.join('\n- ')}`,
  ].join('\n');
}
