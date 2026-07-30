import type { Failure, KnowledgePack, OptimizedListing, StyleRules } from '@/lib/types';
import { compatibilityVariant, decodeEntities, normalize, subtractDisclaimers, utf8Bytes } from '../util';
import { aplusSurfaces, disclaimerVariantsOf, fail } from './shared';

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
 * SCOPE — what "every surface" means here, stated exactly (it is the surface
 * set `styleSurfaces()` returns, nothing wider):
 *   title, title75, itemHighlights, every bullet, description, every A+ text
 *   field (module headline/body/subcopy, comparison label/ours/typical, FAQ
 *   q/a), every Q&A q/a, every image-plan purpose/spec/notes, every attribute
 *   VALUE, backendSearchTerms, and every STRING-valued `facts.*` entry.
 * NOT scanned, deliberately: the code-inserted disclaimer constants
 * (`listing.fdaDisclaimer`, `aplusContent.fdaDisclaimer` — verbatim required
 * text, and the constant is additionally subtracted from every other surface),
 * numeric `facts.*` values (a number carries no markup or symbol), and the
 * three internal/derived strings that are never published on their own:
 * `productName` (published only inside the titles, which ARE scanned),
 * `primaryKeyword` and `bulletAnchors`.
 * The ALWAYS-ON rules (ALL-CAPS, symbols, emoji, ASIN, HTML markup) run on that
 * whole set. The banned-CHARACTER and promo-TERM rules are narrower still: they
 * run only on the surface groups the pack names in `bannedCharsSurfaces` /
 * `titleTermBanSurfaces`.
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
  // Every accessor is null-safe: malformed output must yield FAILURES from the
  // other checks, never an exception that escapes runGate.
  const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const out: StyleSurface[] = [
    { field: 'title', group: 'title', text: s(l.title) },
    { field: 'title75', group: 'title75', text: s(l.title75) },
    { field: 'itemHighlights', group: 'itemHighlights', text: s(l.itemHighlights) },
    ...(l.bullets ?? []).map((b, i) => ({ field: `bullets[${i}]`, group: 'bullets', text: s(b) })),
    { field: 'description', group: 'description', text: s(l.description) },
  ];
  for (const [field, text] of aplusSurfaces(l.aplusContent)) {
    out.push({ field, group: 'aplus', text });
  }
  // Q&A and the image plan are customer-visible too — style rules apply there
  // as well (brain/02: rules apply on every published surface, not just the
  // main fields). See the module header for the exact scanned set.
  (l.qa ?? []).forEach((item, i) => {
    out.push({ field: `qa[${i}].q`, group: 'qa', text: s(item?.q) });
    out.push({ field: `qa[${i}].a`, group: 'qa', text: s(item?.a) });
  });
  // EVERY image-plan text field: purpose and spec render as on-image copy just
  // as often as notes do, so a $ price or an ALL-CAPS banner hides there too.
  (l.imagePlan ?? []).forEach((slot, i) => {
    out.push({ field: `imagePlan[${i}].purpose`, group: 'images', text: s(slot?.purpose) });
    out.push({ field: `imagePlan[${i}].spec`, group: 'images', text: s(slot?.spec) });
    out.push({ field: `imagePlan[${i}].notes`, group: 'images', text: s(slot?.notes) });
  });
  // Attribute VALUES are customer-visible (filters, detail table). The pack's
  // surface scoping keeps '$'/'?' bannedChars off this group so legitimate
  // values like '500 mg' or '60 capsules' never false-trip.
  for (const [key, value] of Object.entries(l.attributes ?? {})) {
    out.push({ field: `attributes.${key}`, group: 'attributes', text: s(value) });
  }
  // BACKEND search terms and canonical FACTS were the two surfaces this list
  // omitted entirely, so an ASIN, a banned symbol, an emoji or raw HTML in either
  // shipped as `verified`. They get their own groups: the pack's
  // `bannedCharsSurfaces` / `titleTermBanSurfaces` do NOT list them, so a legal
  // '$' in `facts.price` stays legal and only the ALWAYS-ON rules (symbols,
  // emoji, ASIN, HTML, ALL-CAPS) apply here.
  out.push({ field: 'backendSearchTerms', group: 'backend', text: s(l.backendSearchTerms) });
  for (const [key, value] of Object.entries(l.facts ?? {})) {
    if (typeof value !== 'string') continue;
    out.push({ field: `facts.${key}`, group: 'facts', text: s(value) });
  }
  return out;
}

/**
 * The allowlist, EXPANDED with the sub-tokens the tokenizer actually produces.
 *
 * `WORD_RE` splits on hyphens and leading digits, so the shipped entries
 * `L-THEANINE`, `5HTP`, `COQ10` and `KSM-66` were compared against tokens that
 * can never equal them (`THEANINE`, `HTP`, …) and were DEAD. Each entry is
 * therefore expanded into its own word tokens as well as kept verbatim.
 */
const ALLOWLIST_CACHE = new WeakMap<StyleRules, Set<string>>();
const RUN_EXEMPT_CACHE = new WeakMap<StyleRules, Set<string>>();

function expandEntries(entries: string[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    const e = entry.trim();
    if (!e) continue;
    out.add(e);
    for (const token of e.match(WORD_RE) ?? []) out.add(token);
  }
  return out;
}

function expandedAllowlist(style: StyleRules): Set<string> {
  const cached = ALLOWLIST_CACHE.get(style);
  if (cached) return cached;
  const out = expandEntries(style.allCapsAllowlist ?? []);
  ALLOWLIST_CACHE.set(style, out);
  return out;
}

/**
 * The RUN-EXEMPT subset of the allowlist (`style.allCapsRunExempt`, pack data).
 *
 * Tokens that cannot read as emphasis however many of them sit together —
 * certification and standards marks. An unpunctuated run of them
 * ("IFOS BSCG HACCP SQF") is a certification list, not shouting, and the
 * previous `min + 1` rule flagged it from the fourth token on.
 */
function runExempt(style: StyleRules): Set<string> {
  const cached = RUN_EXEMPT_CACHE.get(style);
  if (cached) return cached;
  const out = expandEntries(style.allCapsRunExempt ?? []);
  RUN_EXEMPT_CACHE.set(style, out);
  return out;
}

/**
 * RUN-NEUTRAL tokens: any all-caps token carrying a DIGIT (`D3`, `B12`, `K2`,
 * `MK7`). A measurement/ingredient designator is not emphasis, and counting it
 * as a run member failed ordinary sentence-case copy — `Vitamin D3 2000 IU, B12
 * and Zinc` produced the "run" `D3 IU B12` and `D3 K2 MK7 complex` produced
 * `D3 K2 MK7`. Neutral tokens neither count as a member nor break the run.
 *
 * Stated plainly: SHORT tokens are NOT neutral. Making every token under
 * `allCapsMinWordLen` neutral would let `NEW BIG WOW` — three 3-letter words —
 * pass, which is exactly the shouting the run rule exists to catch.
 */
function isRunNeutral(word: string): boolean {
  return /[0-9]/.test(word);
}

/**
 * Clause punctuation ENDS a run. Shouting is a contiguous phrase
 * ("BUY MORE NOW"); a comma-separated list of certification bodies
 * ("IFOS, BSCG, HACCP, SQF") is a list, and reading it as one long run was a
 * false positive on ordinary certification copy.
 */
const RUN_BREAK_RE = /[.,;:!?()[\]{}|/\n]/;

/** True for a token that is written entirely in capitals. */
const isAllCaps = (word: string): boolean =>
  word === word.toUpperCase() && /[A-Z]/.test(word);

/**
 * Runs of `style.allCapsRunMin`+ CONSECUTIVE all-caps tokens, measured PER
 * CLAUSE (see `RUN_BREAK_RE`).
 *
 * The per-word rule alone let "NEW BIG WOW gut support" through (every word is
 * under the minimum length). Shouting is a property of the RUN, not of one
 * word, so a run is reported whatever the token lengths are — with two
 * exemptions, stated exactly:
 *   - RUN-NEUTRAL tokens (digit-bearing designators like `D3`/`B12`) are
 *     skipped entirely: they neither count as a member nor break the run,
 *     because a measurement list is not emphasis;
 *   - allow-listed acronyms DO count as members, but a run made only of them
 *     needs `allCapsRunMin + 1` members, and a run made only of RUN-EXEMPT
 *     certification marks is never reported at all (see `segmentRuns`).
 */
export function allCapsRuns(text: string, style: StyleRules): string[][] {
  const min = style.allCapsRunMin;
  if (!min || min < 2) return [];
  const allow = expandedAllowlist(style);
  const exempt = runExempt(style);
  const runs: string[][] = [];
  for (const segment of text.split(RUN_BREAK_RE)) {
    runs.push(...segmentRuns(segment, min, allow, exempt));
  }
  return runs;
}

function segmentRuns(
  text: string,
  min: number,
  allow: Set<string>,
  exempt: Set<string>,
): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  // THREE tiers, in order:
  //  1. a run whose every member is RUN-EXEMPT (`style.allCapsRunExempt` —
  //     certification/standards marks) is never emphasis at any length, so an
  //     unpunctuated "IFOS BSCG HACCP SQF" is not reported;
  //  2. a run that is entirely allow-listed but not entirely run-exempt needs
  //     one MORE member than the pack minimum — the line between an ingredient
  //     list ("DHA EPA ALA trio") and acronyms used AS shouting
  //     ("SAME NON USA GABA blend", four allow-listed tokens, still fails);
  //  3. a run with even one non-allow-listed member is measured against the
  //     pack minimum unchanged, so "NEW BIG WOW" still fails.
  const flush = (): void => {
    if (current.length > 0 && current.every((w) => exempt.has(w))) {
      current = [];
      return;
    }
    const min2 = current.every((w) => allow.has(w)) ? min + 1 : min;
    if (current.length >= min2) runs.push(current);
    current = [];
  };
  for (const word of text.match(WORD_RE) ?? []) {
    if (isAllCaps(word)) {
      if (isRunNeutral(word)) continue; // digit-bearing designator, not emphasis
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return runs;
}


/**
 * ALL-CAPS words at/over the pack minimum length that are not allow-listed.
 * Tokens that already belong to a shouting RUN are left to `allCapsRuns` so the
 * same word is not reported twice.
 */
export function allCapsOffenders(text: string, style: StyleRules): string[] {
  const allow = expandedAllowlist(style);
  const inRun = new Set(allCapsRuns(text, style).flat());
  const seen = new Set<string>();
  for (const word of text.match(WORD_RE) ?? []) {
    if (word.length < style.allCapsMinWordLen) continue;
    if (!isAllCaps(word)) continue;
    if (inRun.has(word)) continue; // reported by the run rule instead
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
  const disclaimers = cp ? disclaimerVariantsOf(cp).map(normalize) : [];
  const clean = (raw: string): string =>
    subtractDisclaimers(normalize(raw), disclaimers).replace(/\s+/g, ' ').trim();

  const bannedCharsGroups = new Set(style.bannedCharsSurfaces);
  const titleBanGroups = new Set(style.titleTermBanSurfaces);
  const asinRe = style.noAsinInCopy ? new RegExp(style.asinPattern, 'g') : null;
  const emojiRe = style.emojiCheck ? new RegExp(style.emojiPattern, 'gu') : null;

  for (const surface of styleSurfaces(l)) {
    const text = clean(surface.text);
    if (!text) continue;
    // EXTRA variant for the CHARACTER/TERM rules only. `normalize` leaves
    // fullwidth/compatibility punctuation alone on purpose, so `＄24.99` and
    // `＃1 rated` evaded the banned-character and promo-term lists. The banned
    // SYMBOL and emoji rules deliberately keep reading the primary text: NFKC
    // decomposes the pack's banned symbols into ASCII letters and would blind them.
    const compat = compatibilityVariant(text);
    const charVariants = compat === text ? [text] : [text, compat];

    // 1 — ALL-CAPS emphasis: shouting RUNS first (allowlist does not apply
    // inside a run), then the per-word length rule for isolated offenders.
    const runs = allCapsRuns(text, style);
    if (runs.length > 0) {
      out.push(
        fail(
          CHECK_ID,
          surface.field,
          runs.map((r) => r.join(' ')).join(' | '),
          `Rewrite in sentence case — ${style.allCapsRunMin}+ consecutive ALL-CAPS words read as shouting (digit-bearing tokens are skipped; a run of only allow-listed acronyms needs ${style.allCapsRunMin + 1}, and a run of only certification marks is never flagged)`,
        ),
      );
    }
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

    // 4 — banned symbols + emoji (ALWAYS ON: every surface in `styleSurfaces`)
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
      const charHits = style.bannedChars.filter((ch) => charVariants.some((v) => v.includes(ch)));
      if (charHits.length > 0) {
        out.push(
          fail(CHECK_ID, surface.field, charHits.join(' '), `Remove the banned character(s) ${charHits.join(' ')} — use hyphen/comma/parentheses instead`),
        );
      }
    }

    // 6 — no ASIN in customer-facing copy
    if (asinRe) {
      const asins = [...new Set(charVariants.flatMap((v) => {
        asinRe.lastIndex = 0;
        return v.match(asinRe) ?? [];
      }))];
      if (asins.length > 0) {
        out.push(fail(CHECK_ID, surface.field, asins.join(', '), 'Remove the ASIN — identifiers must never appear in customer-facing copy'));
      }
    }

    // 7 — promotional/ranking terms in title surfaces
    if (titleBanGroups.has(surface.group)) {
      for (const term of style.titleTermBans) {
        if (!term.trim()) continue;
        const re = new RegExp(`(?<![a-z0-9])${escapeRe(term).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i');
        if (charVariants.some((v) => re.test(v))) {
          out.push(fail(CHECK_ID, surface.field, term, `Remove the promotional term '${term}' — prohibited in title surfaces`));
        }
      }
    }
  }

  // 8 — markup is prohibited on every surface in `styleSurfaces` (backend and
  // the facts block included since round 6), not just the description.
  // Amazon deprecated description HTML in July 2021, and a <b>/<ul>/<li> in a
  // BULLET or an A+ body renders raw or suppresses the listing exactly the same
  // way. Each surface is scanned RAW *and* entity-decoded, so `&lt;p&gt;` — which
  // Amazon un-escapes on render — cannot hide the tag either. NOTE this loop
  // reads `surface.text` RAW rather than `clean(...)`: the disclaimer constant
  // carries no markup, so nothing is subtracted here.
  const allowedHtml = new Set(style.descriptionAllowedHtml.map((t) => t.toLowerCase()));
  if (style.htmlTagPattern) {
    for (const surface of styleSurfaces(l)) {
      const raw = surface.text ?? '';
      if (!raw) continue;
      const decoded = decodeEntities(raw);
      const badTags = new Set<string>();
      for (const variant of decoded === raw ? [raw] : [raw, decoded]) {
        const tagRe = new RegExp(style.htmlTagPattern, 'g');
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(variant)) !== null) {
          const tag = (m[1] ?? '').toLowerCase();
          if (!allowedHtml.has(tag)) badTags.add(m[0]);
        }
      }
      if (badTags.size > 0) {
        out.push(
          fail(
            CHECK_ID,
            surface.field,
            [...badTags].join(' '),
            `Remove the HTML tag(s) ${[...badTags].join(' ')} — Amazon accepts only ${style.descriptionAllowedHtml
              .map((t) => `<${t}>`)
              .join('/')} markup in listing copy; use plain text`,
          ),
        );
      }
    }
  }

  // 9 — description UTF-8 BYTE backstop.
  //
  // Amazon's documented description limit is 2000 CHARACTERS, and that cap is
  // the authoritative one — it is enforced by C4 against `rules.descriptionMax`.
  // A byte cap set to the SAME number silently made the real limit ~1000
  // characters for accented or non-English copy (é/ü are 2 bytes, CJK 3), which
  // is over-blocking, not enforcement. `descriptionMaxBytes` is therefore raised
  // to 4x the character cap — the worst case for UTF-8 — so it can no longer
  // fire on any string that already satisfies the character cap. It survives
  // purely as a payload/backstop guard against something absurd being pasted in.
  const descBytes = utf8Bytes(l.description ?? '');
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

  // 2 + 3 — bullet-only capitalization and trailing punctuation.
  // The verbatim disclaimer is SUBTRACTED first, exactly like every other rule
  // in this check: a claim-bearing bullet that carries the required disclaimer
  // ends with the disclaimer's own full stop and used to fail the
  // trailing-punctuation rule for text the gate itself demands be there.
  (l.bullets ?? []).forEach((raw, i) => {
    const text = clean(raw);
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
