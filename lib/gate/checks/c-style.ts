import type { Failure, KnowledgePack, OptimizedListing, StyleRules } from '@/lib/types';
import { normalize, subtractDisclaimers, utf8Bytes } from '../util';
import { aplusSurfaces, fail } from './shared';

/**
 * C17 — style/formatting gate (capitalization, punctuation, symbols, promo terms,
 * description markup).
 *
 * Amazon prohibits ALL-CAPS emphasis, trailing sentence punctuation in bullets,
 * trademark/currency symbols and emoji, ASINs in copy, and promotional/ranking
 * terms in the title surfaces. The description field additionally accepts only
 * <br> markup and is capped in UTF-8 BYTES as well as characters.
 * Every threshold, list and pattern is PACK DATA (`pack.rules.style`) — this
 * module hard-codes no lexicon, so it stays category-agnostic.
 *
 * Pure and side-effect free: it REPORTS, it never mutates the listing.
 */

const CHECK_ID = 'C17';

/** A scannable surface plus the surface GROUP used for pack-driven scoping. */
interface StyleSurface {
  field: string;
  group: string;
  text: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** Word tokens: start with a letter, then letters/digits (hyphens split tokens). */
const WORD_RE = /[A-Za-z][A-Za-z0-9]*/g;

/** Customer surfaces + every A+ text field, tagged with their scoping group. */
export function styleSurfaces(l: OptimizedListing): StyleSurface[] {
  const out: StyleSurface[] = [
    { field: 'title', group: 'title', text: l.title },
    { field: 'title75', group: 'title75', text: l.title75 },
    { field: 'itemHighlights', group: 'itemHighlights', text: l.itemHighlights },
    ...l.bullets.map((b, i) => ({ field: `bullets[${i}]`, group: 'bullets', text: b })),
    { field: 'description', group: 'description', text: l.description },
  ];
  for (const [field, text] of aplusSurfaces(l.aplusContent)) {
    out.push({ field, group: 'aplus', text });
  }
  // Q&A and the image plan are customer-visible too — style rules apply there
  // as well (brain/02: rules apply on EVERY surface, not just the main fields).
  (l.qa ?? []).forEach((item, i) => {
    out.push({ field: `qa[${i}].q`, group: 'qa', text: item.q });
    out.push({ field: `qa[${i}].a`, group: 'qa', text: item.a });
  });
  (l.imagePlan ?? []).forEach((slot, i) => {
    out.push({ field: `imagePlan[${i}].notes`, group: 'images', text: slot.notes });
  });
  return out;
}

/** ALL-CAPS words at/over the pack minimum length that are not allow-listed. */
export function allCapsOffenders(text: string, style: StyleRules): string[] {
  const allow = new Set(style.allCapsAllowlist);
  const seen = new Set<string>();
  for (const word of text.match(WORD_RE) ?? []) {
    if (word.length < style.allCapsMinWordLen) continue;
    if (word !== word.toUpperCase()) continue; // contains a lowercase letter
    if (!/[A-Z]/.test(word)) continue; // must carry at least one letter
    if (allow.has(word)) continue; // exact, case-sensitive allowlist hit
    seen.add(word);
  }
  return [...seen];
}

/** Trailing marker(s) allowed by the pack (e.g. the '*' claim marker) stripped off. */
function stripAllowedTrailing(text: string, allowed: string[]): string {
  let t = text.trimEnd();
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of allowed) {
      if (marker && t.endsWith(marker)) {
        t = t.slice(0, -marker.length).trimEnd();
        changed = true;
      }
    }
  }
  return t;
}

export function c17Style(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const style = pack.rules.style;
  if (!style) return [];
  const out: Failure[] = [];

  // Never scan the category disclaimer constant itself — it is code-inserted
  // verbatim and must not be reported as a style violation.
  const cp = pack.compliancePack;
  const disclaimers = cp
    ? [cp.disclaimer, ...cp.auditAcceptDisclaimers].filter(Boolean).map(normalize)
    : [];
  const clean = (raw: string): string => subtractDisclaimers(normalize(raw), disclaimers);

  const bannedCharsGroups = new Set(style.bannedCharsSurfaces);
  const titleBanGroups = new Set(style.titleTermBanSurfaces);
  const asinRe = style.noAsinInCopy ? new RegExp(style.asinPattern, 'g') : null;
  const emojiRe = style.emojiCheck ? new RegExp(style.emojiPattern, 'gu') : null;

  for (const surface of styleSurfaces(l)) {
    const text = clean(surface.text);
    if (!text) continue;

    // 1 — ALL-CAPS emphasis
    const caps = allCapsOffenders(text, style);
    if (caps.length > 0) {
      out.push(
        fail(
          CHECK_ID,
          surface.field,
          caps.join(', '),
          `Rewrite in sentence case — ALL-CAPS words of ${style.allCapsMinWordLen}+ characters are prohibited (measurement acronyms are exempt)`,
        ),
      );
    }

    // 4 — banned symbols + emoji (every surface)
    const symbolHits = style.bannedSymbols.filter((sym) => text.includes(sym));
    if (symbolHits.length > 0) {
      out.push(
        fail(CHECK_ID, surface.field, symbolHits.join(' '), `Remove the symbol(s) ${symbolHits.join(' ')} — prohibited in listing copy`),
      );
    }
    if (emojiRe) {
      emojiRe.lastIndex = 0;
      const emoji = [...new Set(text.match(emojiRe) ?? [])];
      if (emoji.length > 0) {
        out.push(fail(CHECK_ID, surface.field, emoji.join(' '), 'Remove emoji — prohibited in listing copy'));
      }
    }

    // 5 — banned characters (scoped by the pack: '$'/'?' are legitimate elsewhere)
    if (bannedCharsGroups.has(surface.group)) {
      const charHits = style.bannedChars.filter((ch) => text.includes(ch));
      if (charHits.length > 0) {
        out.push(
          fail(CHECK_ID, surface.field, charHits.join(' '), `Remove the banned character(s) ${charHits.join(' ')} — use hyphen/comma/parentheses instead`),
        );
      }
    }

    // 6 — no ASIN in customer-facing copy
    if (asinRe) {
      asinRe.lastIndex = 0;
      const asins = [...new Set(text.match(asinRe) ?? [])];
      if (asins.length > 0) {
        out.push(fail(CHECK_ID, surface.field, asins.join(', '), 'Remove the ASIN — identifiers must never appear in customer-facing copy'));
      }
    }

    // 7 — promotional/ranking terms in title surfaces
    if (titleBanGroups.has(surface.group)) {
      for (const term of style.titleTermBans) {
        if (!term.trim()) continue;
        const re = new RegExp(`(?<![a-z0-9])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i');
        if (re.test(text)) {
          out.push(fail(CHECK_ID, surface.field, term, `Remove the promotional term '${term}' — prohibited in title surfaces`));
        }
      }
    }
  }

  // 8 — the description accepts ONLY <br>. Every other tag (<p>, <b>, <ul>, ...)
  // was deprecated in July 2021 and can suppress the listing or render raw.
  // The RAW description is scanned here (not the disclaimer-subtracted copy) so
  // that markup can never hide inside a stripped span.
  const rawDescription = l.description ?? '';
  const allowedHtml = new Set(style.descriptionAllowedHtml.map((t) => t.toLowerCase()));
  if (style.htmlTagPattern) {
    const tagRe = new RegExp(style.htmlTagPattern, 'g');
    const badTags = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(rawDescription)) !== null) {
      const tag = (m[1] ?? '').toLowerCase();
      if (!allowedHtml.has(tag)) badTags.add(m[0]);
    }
    if (badTags.size > 0) {
      out.push(
        fail(
          CHECK_ID,
          'description',
          [...badTags].join(' '),
          `Remove the HTML tag(s) ${[...badTags].join(' ')} — Amazon's description field accepts only ${style.descriptionAllowedHtml
            .map((t) => `<${t}>`)
            .join('/')}; use plain-text paragraphs`,
        ),
      );
    }
  }

  // 9 — description UTF-8 BYTE cap (belt-and-braces alongside the char cap)
  const descBytes = utf8Bytes(rawDescription);
  if (descBytes > style.descriptionMaxBytes) {
    out.push(
      fail(
        CHECK_ID,
        'description',
        `${descBytes} bytes`,
        `Shorten the description to ${style.descriptionMaxBytes} UTF-8 bytes or fewer (currently ${descBytes})`,
      ),
    );
  }

  // 2 + 3 — bullet-only capitalization and trailing punctuation
  l.bullets.forEach((raw, i) => {
    const text = normalize(raw);
    if (!text) return;
    if (style.bulletMustStartCapital) {
      const first = text[0] ?? '';
      if (/[a-z]/.test(first)) {
        out.push(fail(CHECK_ID, `bullets[${i}]`, text.slice(0, 40), 'Bullet must start with a capital letter'));
      }
    }
    if (style.bulletNoTrailingPunctuation) {
      const stripped = stripAllowedTrailing(text, style.bulletTrailingAllowed);
      const last = stripped.slice(-1);
      if (last && style.bulletTrailingPunctuation.includes(last)) {
        out.push(
          fail(
            CHECK_ID,
            `bullets[${i}]`,
            text.slice(-40),
            `Bullet must not end with '${last}' — drop trailing punctuation (a trailing ${style.bulletTrailingAllowed.map((m) => `'${m}'`).join(' or ')} is allowed)`,
          ),
        );
      }
    }
  });

  return out;
}
