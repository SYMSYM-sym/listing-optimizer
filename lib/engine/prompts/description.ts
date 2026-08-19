import type { DescriptionBudget } from '@/lib/gate/checks/c-length';
import type { ListingSnapshot, RuleSet } from '@/lib/types';
import { canonicalNameBlock, demandRecaptureBlock, positioningBlock, snapshotBlock } from './shared';

/**
 * `budget` replaced a `hasCompliance: boolean` that selected between two
 * HAND-COMPUTED constants ("≤1700 chars …" / "≤2000 chars"). Neither named
 * `rules.descriptionMax` and neither knew the length of the pack's own
 * disclaimer, so the instruction the model works to and the limit C4 enforces
 * were only ever equal by coincidence — see `descriptionBudget` in
 * `lib/gate/checks/c-length.ts` for the live run that cost.
 */
export function descriptionPrompt(
  snapshot: ListingSnapshot,
  budget: DescriptionBudget,
  styleBlock = '',
  packRules: string[] = [],
  canonicalProductName = '',
  rules?: RuleSet,
  buyerBlock = '',
): string {
  // `budget.target`, never `budget.budget`: the second is the exact character
  // count at which C4 begins to fail, and a live run (B00IO89MYA) landed 19
  // characters past it having been told it correctly. See
  // `DESCRIPTION_MARGIN_FRACTION` in `lib/gate/checks/c-length.ts`.
  // K1 — and the consequence of ignoring it is now STATED. Three live runs
  // overshot the number they were given (+88, +19, then +120 straight through a
  // margin sized against the first two), so `optimize()` clamps an over-budget
  // body at a paragraph or sentence boundary before the disclaimer is appended
  // (`lib/engine/descriptionClamp.ts`). Telling the model that is honesty, not
  // pressure: the instruction now describes what actually happens. The CLIFF is
  // still never named — naming it is what B00IO89MYA obeyed — so the sentence
  // below carries no number of its own.
  const headroom = budget.reserve > 0
    ? `≤${budget.target} chars of your own text (the system then appends the verbatim compliance disclaimer, ${budget.reserve} chars, and the finished field must be ≤${budget.max})`
    : `≤${budget.target} chars`;
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  // C8 requires the canonical product name INSIDE the description. It is chosen
  // by the title group, so it is stated here rather than left to chance.
  const canonical = canonicalNameBlock(
    canonicalProductName,
    'The description MUST contain that exact string at least once — write it out in full; do not paraphrase it or refer to it only as "this product".',
  );
  // R48 positioning anchor (pack data) \u2014 the description carries the value story.
  const positioning = positioningBlock(rules?.positioningAnchor);
  // K4 (WS3) — see bullets.ts: the compliant cluster has to be WRITTEN for the
  // recapture route recorded in the keyword reference to be real.
  const recapture = demandRecaptureBlock(rules?.keywordRules);
  return `${snapshotBlock(snapshot)}${positioning ? `\n\n${positioning}` : ''}

${styleBlock}

${canonical}
TASK: Write the product description, ${headroom}.
- Finish INSIDE that length. Anything past the limit is cut by the system at a paragraph or sentence boundary before the field is assembled, so an over-long draft ships without its final paragraph.
${recapture ? `${recapture}\n` : ''}${buyerBlock ? `${buyerBlock}\n` : ''}- Product name must appear.
- Blank-line paragraph breaks. Plain text, no HTML.
- Cover: what it is, who it's for, how to use, quality and safety.
${packLines}- Close claim paragraphs naturally; do NOT write any disclaimer text.
Return JSON: { "description" }`;
}
