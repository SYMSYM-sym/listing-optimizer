import type { ListingSnapshot, StyleRules } from '@/lib/types';

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
