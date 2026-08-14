import { ABSENCE_CLAIM_STATUSES, MODEL_OWNED_STATUSES } from '../keywordPlacement';
import type {
  BulletArchitecture,
  KeywordRules,
  CompliancePack,
  ListingSnapshot,
  PositioningAnchor,
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


/**
 * WS4 — the BULLET ARCHITECTURE block, rendered FROM PACK DATA
 * (`rules.bulletArchitecture`).
 *
 * WHY IT EXISTS. Five bullets written with no declared job produce five
 * paraphrases of the same benefit, and the slot that should have carried the
 * secondary use-case (or the trust facts, or the routine) is simply never
 * written. The playbook's copy phase assigns each slot a JOB; this block states
 * those jobs to the generator, demands one distinct situational anchor per
 * bullet, and states the AM-3 allergen POSITION rule.
 *
 * STRATEGY IS NOT A GATE. Nothing here is enforced by a deterministic check:
 * the audit reports an unfilled job or a repeated anchor as a P2 gap and the
 * misplaced allergen declaration as a P1 gap. The gate's hard rules (C9's
 * triple declaration, C25's claim marker) are untouched by anything in here.
 */
export function bulletArchitectureBlock(arch: BulletArchitecture | undefined): string {
  const slots = (arch?.slots ?? []).filter((s) => s?.id && s?.job);
  if (slots.length === 0) return '';
  const lines = [
    'BULLET ARCHITECTURE (each bullet has a DECLARED JOB \u2014 write to it, and give each bullet its own situational anchor):',
    ...slots.map((s) => `- ${s.id} \u2014 ${s.job}. ${s.guidance}`),
  ];
  if (arch?.anchorRule) lines.push(`- ${arch.anchorRule}`);
  const pos = arch?.allergenPosition;
  if (pos?.mustTrail && pos.rule) lines.push(`- ${pos.rule}`);
  lines.push(
    `- Return the bullets IN SLOT ORDER: bullet 1 is ${slots[0]!.id}, bullet ${slots.length} is ${slots[slots.length - 1]!.id}.`,
  );
  return lines.join('\n');
}

/**
 * R48 — the POSITIONING anchor, rendered FROM PACK DATA
 * (`rules.positioningAnchor`). Playbook 8.20: a spec race against a number a
 * rival can leapfrog by reformulating is not a position, and it invites a
 * compliance mismatch as well as a losing comparison. Advisory guidance to the
 * generator; the ship sheet renders the same anchor for the operator.
 */
export function positioningBlock(anchor: PositioningAnchor | undefined): string {
  const guidance = (anchor?.guidance ?? []).filter((g) => g.trim() !== '');
  if (!anchor?.headline || guidance.length === 0) return '';
  return [`POSITIONING (${anchor.id}) \u2014 ${anchor.headline}`, ...guidance.map((g) => `- ${g}`)].join('\n');
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
    `- Sentence case only. Do NOT use all-capital words of ${style.allCapsMinWordLen}+ characters for emphasis anywhere (no all-caps bullet hooks). These acronyms and registered ingredient/strain marks are the only exceptions: ${style.allCapsAllowlist.join(', ')}.`,
    '- Registered ingredient/strain trademarks keep their registered casing EXACTLY as printed on the label (write each such mark character for character; never convert one to sentence case or lowercase).',
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

/**
 * WS3 — the KEYWORD VOCABULARY block, rendered FROM PACK DATA
 * (`rules.keywordRules`).
 *
 * DELIBERATELY RENDERED AHEAD OF `TASK:`, for the same documented reason the
 * style block is: it is an ENUMERATION OF DATA the gate enforces (the surface
 * names and the six status words), not a sentence of the form "avoid <banned
 * word>". `tests/promptHygiene.test.ts` scans everything AFTER `TASK:`, which
 * is the part a model paraphrases into customer-adjacent output; a status word
 * echoed out of this table lands in a JSON field the customer never sees and
 * that no copy surface is built from.
 */
export function keywordVocabularyBlock(kr: KeywordRules | undefined): string {
  const visible = (kr?.visibleSurfaces ?? []).filter((s) => s.trim() !== '');
  const backend = (kr?.backendSurfaces ?? []).filter((s) => s.trim() !== '');
  const statuses = (kr?.statuses ?? []).filter((s) => s.trim() !== '');
  if (visible.length === 0 || statuses.length === 0) return '';
  // THE PARTITION HAS ONE SOURCE OF TRUTH — the two constants the derivation
  // itself reads (`lib/engine/keywordPlacement.ts`). Nothing is re-listed here,
  // so the sentence the model is given can never describe a split the code does
  // not implement.
  const modelOwnedStatuses = statuses.filter((s) =>
    (MODEL_OWNED_STATUSES as readonly string[]).includes(s),
  );
  const absenceStatuses = statuses.filter((s) =>
    (ABSENCE_CLAIM_STATUSES as readonly string[]).includes(s),
  );
  const derivedStatuses = statuses.filter(
    (s) =>
      !(MODEL_OWNED_STATUSES as readonly string[]).includes(s) &&
      !(ABSENCE_CLAIM_STATUSES as readonly string[]).includes(s),
  );
  return [
    'KEYWORD REFERENCE VOCABULARY (pack data — the gate enforces exactly this):',
    `- Visible surface names: ${visible.join(', ')}.`,
    `- Invisible (indexed) surface name: ${backend.join(', ') || '(none)'}.`,
    `- Statuses: ${statuses.join(' | ')}.`,
    '- Tiers: 1 = own-the-lane head terms for the single intent cluster this listing owns; 2 = named entities (each component by its full name, the headline spec, the formula callout) because those are what an assistant quotes back; 3 = qualifier and trust terms (diet flags, origin, count, supply) that act as filters and tie-breakers; 4 = conversational buyer-language phrases. A row that is not tier 1-4 carries one of these tier labels instead: backend, demand, strategy, candidate, negative.',
    // WS3 — the STATUS SPLIT, from pack data, in the THREE parts the derivation
    // actually implements. The placement statuses are COMPUTED from the
    // finished copy (`lib/engine/keywordPlacement.ts`); the absence-claim pair
    // is a claim ABOUT that copy and is checked against it; only the two
    // intent statuses are carried through untouched. The model used to be asked
    // which surfaces its own copy had used, and on all three live ASINs it was
    // wrong 21-22 times per run, so it is not asked.
    `- STATUS: ${derivedStatuses.join(' / ') || '(none)'} ${derivedStatuses.length === 1 ? 'is' : 'are'} COMPUTED from the finished copy after you answer — never declare one and never list surfaces; a term the copy carries visibly is recorded with the exact surfaces carrying it, and a term only in the invisible field is recorded as invisible-only.`,
    // E4 — the live 77-failure class: the model wrote `candidate` over the
    // product's OWN ingredient names while the copy above was full of them.
    // Both words describe a term that is ABSENT, so the absence is now measured
    // and the row corrected; the choice BETWEEN the two words is still the
    // model's, because no substring search can make it.
    `- ${absenceStatuses.join(' and ') || '(none)'} ${absenceStatuses.length === 1 ? 'describes a term that is' : 'both describe a term that is'} ABSENT FROM THE COPY ABOVE — a term you are naming for a later cycle, or one you are deliberately leaving alone. READ THE COPY BEFORE YOU USE EITHER: a term you can see in it (every ingredient you named, every spec you wrote) is IN the listing, and a row saying otherwise is corrected against the copy and the correction recorded. Which of the two words fits an absent term is YOUR call and is never overwritten.`,
    `- These statuses are YOURS and are never overwritten: ${modelOwnedStatuses.join(', ') || '(none)'}. A row on the negative list must appear nowhere at all, and a recaptured row names its compliant route. A row on the invisible surface must appear there and NOWHERE visible.`,
  ].join('\n');
}

/**
 * K4 — the DEMAND-RECAPTURE guidance, rendered FROM PACK DATA
 * (`rules.keywordRules.demandRecapture`).
 *
 * The playbook calls this the strategic heart of regulated-category keyword
 * work: you do not abandon the demand behind a term you may not write, you map
 * it to a compliant cluster the semantic layer bridges, and you RECORD the
 * route. The record is what stops a later cycle from "helpfully" re-adding the
 * banned term because it has volume — the volume is already being captured and
 * the map proves how.
 *
 * Injected into the keyword prompt AND the copy prompts, because the mapping
 * only works if the copy actually writes the compliant cluster. Guidance only:
 * nothing here is enforced, which is why it is not a `REQUIRED_PACK_PIECES`
 * row — what IS enforced is that a recaptured row documents its route (C28).
 */
export function demandRecaptureBlock(kr: KeywordRules | undefined): string {
  const dr = kr?.demandRecapture;
  const mappings = (dr?.mappings ?? []).filter((m) => m.trim() !== '');
  if (!dr?.headline || mappings.length === 0) return '';
  return [dr.headline, ...mappings.map((m) => `- ${m}`)].join('\n');
}

/**
 * WS9 — the BUYER-LANGUAGE block: phrasing mined from operator-supplied review
 * text, already filtered through the compliance lexicons
 * (`lib/knowledge/reviewLanguage.ts`).
 *
 * P11 asks the copy to mirror compliant buyer language so the lexical and the
 * semantic layers reinforce each other. The mirroring has to be of PHRASING,
 * never of claims: reviews may lawfully carry symptom words because that is
 * customer speech, and the copy may not. The filter runs before this block is
 * built, so what reaches the generator is the compliant half only — and the
 * gate still scans everything written from it.
 *
 * Renders NOTHING when no review text was supplied, which is why behaviour is
 * unchanged for every run that does not use the field.
 */
export function buyerLanguageBlock(phrases: string[] | undefined): string {
  const clean = (phrases ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 20);
  if (clean.length === 0) return '';
  return [
    'BUYER LANGUAGE (real phrasing from this product\'s own reviews, already screened against the compliance rules above):',
    ...clean.map((p) => `- "${p}"`),
    '- Mirror the WORDING, never the claim: use these words for the same everyday situations the reviewer described, and keep every benefit statement inside the approved shapes above.',
  ].join('\n');
}
