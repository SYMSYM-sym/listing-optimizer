import type {
  ListingSnapshot,
  ProhibitedContentRules,
  ProhibitedMarketingRules,
  StyleRules,
} from '@/lib/types';

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
