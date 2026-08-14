import type { ListingSnapshot, RuleSet } from '@/lib/types';
import { bulletArchitectureBlock, canonicalNameBlock, positioningBlock, snapshotBlock } from './shared';

export function bulletsPrompt(
  snapshot: ListingSnapshot,
  styleBlock: string,
  packRules: string[] = [],
  canonicalProductName = '',
  rules?: RuleSet,
): string {
  const packLines = packRules.map((line) => `- ${line}\n`).join('');
  // Bullets reference the product; no check forces the name here, but a bullet
  // that names a DIFFERENT product than the title reads as a different listing.
  const canonical = canonicalNameBlock(
    canonicalProductName,
    'If a bullet names the product at all, use that exact string \u2014 never a variant of it.',
  );
  // WS4: the slot jobs, the distinct-anchor doctrine and the AM-3 allergen
  // POSITION rule, all rendered from pack data (`rules.bulletArchitecture`).
  // R48 states the positioning the copy must carry. Both are PACK DATA \u2014 this
  // module authors no strategy of its own.
  const architecture = bulletArchitectureBlock(rules?.bulletArchitecture);
  const positioning = positioningBlock(rules?.positioningAnchor);
  const blocks = [architecture, positioning].filter((b) => b !== '').join('\n\n');
  return `${snapshotBlock(snapshot)}

${styleBlock}

${canonical}
TASK: Write exactly 5 bullets, each \u2264240 chars (leave headroom to 255).
${blocks ? `${blocks}\n\n` : ''}- Each bullet serves ONE major use-case with a distinct, quotable situational anchor line.
- Lead each bullet with a short benefit label in sentence case followed by a colon (capitalize the first word only \u2014 never all caps).
${packLines}- Claim-bearing bullets close with a trailing "*" (no disclaimer text in bullets \u2014 the system handles it). Set "claimBearing" true for exactly those bullets: the "*" and the flag are checked against each other.
- "useCaseAnchor": 2\u20135 word label of the use-case the bullet anchors.
Return JSON: { "bullets": [{ "text", "useCaseAnchor", "claimBearing" } \u00d75] }`;
}
