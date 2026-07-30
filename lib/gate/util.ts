/**
 * Gate utilities — pure, dependency-free, unit-tested.
 */

import { utf8Bytes as sharedUtf8Bytes } from '@/lib/shared/utf8Bytes';

/** Re-export shared implementation so gate C3 and the dashboard counter always agree. */
export { sharedUtf8Bytes as utf8Bytes };

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '-',
  '&mdash;': '-',
};

/**
 * Decode the entity set above PLUS numeric entities (`&#60;` / `&#x3C;`).
 * Exported because markup can hide behind entities on any surface: `&lt;p&gt;`
 * renders as a real tag once Amazon un-escapes it.
 */
export function decodeEntities(text: string): string {
  let t = text;
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  return t
    .replace(/&#(\d{1,7});/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

/**
 * Latin-lookalike letters (Cyrillic / Greek / Latin-extended) folded to their
 * ASCII twin.
 *
 * Unicode NFKC does NOT touch these — `Fights cаncer` (Cyrillic а) is a
 * different string from `Fights cancer` as far as every scan is concerned, which
 * is exactly how a homoglyph payload walks past a banned-term list. This is a
 * SCRIPT-confusable table, not a domain lexicon: it holds no category words.
 *
 * The table is authored as ASCII-letter -> lookalike CODEPOINTS and INVERTED
 * programmatically (including the upper-case pair of every entry), so widening
 * a script's coverage is one string edit rather than dozens of map lines.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic + Greek + Latin-extended + phonetic look-alikes, keyed by ASCII twin.
  a: '\u0430\u03b1\u0251\u1d00\u04d1',
  b: '\u0432\u03b2\u0253\u1d03\u044c',
  c: '\u0441\u03f2\u1d04\u0188\u023c',
  d: '\u0501\u0257\u1d05\u217e',
  e: '\u0435\u03b5\u04bd\u1d07\u0247',
  f: '\u0192',
  g: '\u0261\u01e5\u0581',
  h: '\u04bb\u0570\u04a3',
  i: '\u0456\u03b9\u0131\u026a\u2170\u0269',
  j: '\u0458\u0575\u0237',
  k: '\u043a\u03ba\u1d0b\u049b',
  l: '\u04cf\u217c\u0142',
  m: '\u043c\u03bc\u1d0d\u217f',
  n: '\u0578\u03b7\u1d0e\u0272',
  o: '\u043e\u03bf\u1d0f\u0585\u04e7',
  p: '\u0440\u03c1\u1d18\u01a5',
  q: '\u051b\u0563',
  r: '\u0433\u1d19\u027e',
  s: '\u0455\u03c3\u03c2\u0282',
  t: '\u0442\u03c4\u1d1b\u01ab',
  u: '\u03c5\u1d1c\u0446\u057d',
  v: '\u03bd\u1d20\u0475',
  w: '\u051d\u1d21\u0561',
  x: '\u0445\u03c7\u2179',
  y: '\u0443\u03b3\u04af',
  z: '\u1d22\u01b6\u0290',
};

/** Digit look-alikes (Cyrillic З reads as 3). */
const DIGIT_LOOKALIKES: Record<string, string> = {
  '3': '\u0417\u0437',
  '0': '\u0555',
};

function buildConfusables(): Record<string, string> {
  const map: Record<string, string> = {};
  const add = (from: string, to: string): void => {
    if (from.charCodeAt(0) < 128) return; // never remap ASCII
    if (map[from] === undefined) map[from] = to;
  };
  for (const [ascii, chars] of Object.entries(LOOKALIKES)) {
    for (const ch of chars) {
      add(ch, ascii);
      const upper = ch.toUpperCase();
      if (upper.length === 1) add(upper, ascii.toUpperCase());
    }
  }
  for (const [digit, chars] of Object.entries(DIGIT_LOOKALIKES)) {
    for (const ch of chars) {
      add(ch, digit);
      const upper = ch.toUpperCase();
      if (upper.length === 1) add(upper, digit);
    }
  }
  return map;
}

const CONFUSABLES: Record<string, string> = buildConfusables();

/**
 * Zero-width / invisible / format characters used to break up scanned words.
 *
 * The previous class covered only ZWSP-ZWJ, WORD JOINER, BOM and SOFT HYPHEN,
 * so LRM/RLM, the Arabic letter mark, the Mongolian separators, the invisible
 * math operators, the Hangul fillers and the variation selectors all walked
 * straight through. The class below covers the realistic paste-able set:
 *   U+00AD soft hyphen, U+034F combining grapheme joiner, U+061C Arabic letter
 *   mark, U+115F/U+1160 Hangul fillers, U+180B-U+180E Mongolian selectors +
 *   separator, U+200B-U+200F zero-width + bidi marks, U+202A-U+202E bidi
 *   embedding/override, U+2060-U+2064 word joiner + invisible operators,
 *   U+2066-U+2069 bidi isolates, U+3164 Hangul filler, U+FE00-U+FE0F variation
 *   selectors, U+FEFF BOM.
 * NOT covered (deliberately): ordinary whitespace and printable separators —
 * those are handled by `collapseSeparators` / `stripSeparators`, not here.
 */
const INVISIBLE_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF]/g;

/**
 * Every codepoint `INVISIBLE_RE` strips, as single-character strings.
 * Exported so the red-team suite can assert the covered set exhaustively
 * instead of hand-picking a few examples.
 */
export const INVISIBLE_CHARS: string[] = (() => {
  const ranges: [number, number][] = [
    [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
    [0x180b, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064],
    [0x2066, 0x2069], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  ];
  const out: string[] = [];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) out.push(String.fromCodePoint(cp));
  }
  return out;
})();

/** Combining diacritics — `cańcer` is `cancer` plus U+0301 and must fold to it. */
const COMBINING_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20F0\uFE20-\uFE2F]/g;

/**
 * Per-character NFKC fold, restricted to folds that yield exactly ONE letter or
 * digit (fullwidth `ｃ`, math-bold, circled digits, ...).
 *
 * Whole-string NFKC would also rewrite meaningful SYMBOLS into ASCII letter
 * pairs, which would silently blind the pack-driven banned-symbol scan — so the
 * fold is deliberately limited to single alphanumeric results.
 */
function foldCompatibility(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) {
      out += ch;
      continue;
    }
    const mapped = CONFUSABLES[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const nfkc = ch.normalize('NFKC');
    out += nfkc.length === 1 && /[\p{L}\p{N}]/u.test(nfkc) ? nfkc : ch;
  }
  return out;
}

/**
 * Curly→straight quotes, en/em dash→hyphen, entity decode, INVISIBLE-character
 * strip, COMBINING-MARK strip, compatibility/confusable fold, collapse whitespace.
 *
 * The fold is what makes the scans homoglyph-proof: without it a Cyrillic
 * `а`, a combining accent or a zero-width space inside a banned word evades
 * every check.
 */
/**
 * Bounded memo for `normalize` / `deobfuscatedVariants`.
 *
 * The same surface string is normalized by a dozen different checks in one
 * gate run, and `normalize` walks the string codepoint-by-codepoint doing an
 * NFKC fold. The cache is bounded and cleared wholesale when it fills, so it
 * cannot grow without limit in a long-running server process.
 */
const MEMO_LIMIT = 4000;
function memoized<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (cache.size >= MEMO_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

const NORMALIZE_CACHE = new Map<string, string>();

export function normalize(text: string): string {
  const key = typeof text === 'string' ? text : text == null ? '' : String(text);
  return memoized(NORMALIZE_CACHE, key, () => normalizeUncached(key));
}

function normalizeUncached(text: string): string {
  // Defensive coercion: malformed model output (a `null` bullet, a missing
  // Q&A answer) must produce a FAILURE downstream, never a TypeError that
  // escapes runGate — a thrown gate is a fail-OPEN for the caller.
  const src = typeof text === 'string' ? text : text == null ? '' : String(text);
  let t = decodeEntities(src.replace(INVISIBLE_RE, ''));
  // NFD first so an accent becomes a separate combining mark, then drop the
  // marks: `cańcer` and `cañcer` both fold onto `cancer`.
  t = t.normalize('NFD').replace(COMBINING_RE, '');
  t = foldCompatibility(t);
  return t
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2015\u2212\u2011]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Separator-padded evasion (`c-a-n-c-e-r`, `d.i.a.b.e.t.e.s`, `c a n c e r`,
 * `c*a*n*c*e*r`, `c,a,n,c,e,r`).
 *
 * ONLY runs of SINGLE letters joined by separators are collapsed, so genuine
 * hyphenated words (`5-HTP`, `L-theanine`, `third-party`, `Non-GMO`) are left
 * completely untouched. The result is scanned IN ADDITION to the normal
 * surface — it never replaces it.
 */
const PADDED_SEPARATORS = '[-\\u2011\\u2013\\u2014.\\u00b7*/,|\\s]';
const PADDED_RUN_RE = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z](?:${PADDED_SEPARATORS}+[A-Za-z])+(?![A-Za-z0-9])`,
  'g',
);
const PADDED_STRIP_RE = new RegExp(PADDED_SEPARATORS, 'g');

export function collapseSeparators(text: string): string {
  return text.replace(PADDED_RUN_RE, (run) => run.replace(PADDED_STRIP_RE, ''));
}

/**
 * PARTIAL-SPLIT obfuscation (`c ancer`, `ca ncer`, `can-cer`, `can.cer`,
 * `can'cer`, `cance r`).
 *
 * `collapseSeparators` only rebuilds runs of SINGLE letters, so ANY split that
 * leaves a multi-letter fragment walked straight through it. This pass removes
 * EVERY intra-word separator/whitespace character instead, producing one long
 * concatenated string that is scanned against a term list stripped the same
 * way (see `scanConcatenated`).
 *
 * It is ADDITIVE: the primary surface text is never rewritten.
 */
const SEPARATOR_STRIP_RE = /[\s.\-–—―−·*/,|'‘’_~+:;]+/g;

export interface StrippedText {
  /** The text with every separator removed. */
  stripped: string;
  /** `map[i]` is the index in the ORIGINAL text of `stripped[i]`. */
  map: number[];
}

/** The same character set as `SEPARATOR_STRIP_RE`, as a Set for per-char work. */
const SEPARATOR_CHARS = new Set([
  ' ', '\t', '\n', '\r', '\f', '\v', '\u00a0',
  '.', '-', '\u2013', '\u2014', '\u2015', '\u2212', '\u00b7',
  '*', '/', ',', '|', "'", '\u2018', '\u2019', '_', '~', '+', ':', ';',
]);

const WHITESPACE_RE = /\s/;

/** Remove every intra-word separator, keeping an index map back to the source. */
export function stripSeparators(text: string): StrippedText {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // Set first (fast path), then the full \s class so the two stay in sync
    // with SEPARATOR_STRIP_RE for exotic whitespace.
    if (SEPARATOR_CHARS.has(ch) || WHITESPACE_RE.test(ch)) continue;
    out.push(ch);
    map.push(i);
  }
  return { stripped: out.join(''), map };
}

interface CompiledConcat {
  re: RegExp;
  canonical: Map<string, string>;
}

const CONCAT_CACHE = new WeakMap<string[], Map<number, CompiledConcat | null>>();

/**
 * Build the boundary-FREE alternation for the concatenated pass.
 *
 * There are no word boundaries left in a concatenated surface, so matching is
 * plain substring matching — which is exactly why a MINIMUM LENGTH is enforced:
 * gluing a whole surface together can create accidental substrings, and short
 * terms (2-4 chars) are the ones that collide. Terms shorter than `minLen`
 * are therefore NOT covered by this pass; they remain covered by the ordinary
 * word-boundary scan on the untouched text.
 */
function compileConcatTerms(terms: string[], minLen: number): CompiledConcat | null {
  let byLen = CONCAT_CACHE.get(terms);
  if (!byLen) {
    byLen = new Map();
    CONCAT_CACHE.set(terms, byLen);
  }
  const hit = byLen.get(minLen);
  if (hit !== undefined) return hit;

  const canonical = new Map<string, string>();
  for (const term of terms) {
    const stripped = term.replace(SEPARATOR_STRIP_RE, '').toLowerCase();
    if (stripped.length < minLen) continue;
    if (!canonical.has(stripped)) canonical.set(stripped, term.trim());
  }
  if (canonical.size === 0) {
    byLen.set(minLen, null);
    return null;
  }
  const source = [...canonical.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const compiled: CompiledConcat = { re: new RegExp(`(?:${source})`, 'gi'), canonical };
  byLen.set(minLen, compiled);
  return compiled;
}

/**
 * Scan the separator-stripped variant of `text` for separator-stripped `terms`.
 *
 * Matches are mapped back to their index in the ORIGINAL text so the negation
 * guard and the reported context still see real clause structure — stripping
 * separators destroys both, and running the guard on the stripped string would
 * silently disable negation handling.
 */
export function scanConcatenated(
  text: string,
  terms: string[],
  minLen: number,
  neg: NegationOptions = {},
): TermMatch[] {
  const out: TermMatch[] = [];
  if (!text || terms.length === 0) return out;
  const compiled = compileConcatTerms(terms, minLen);
  if (!compiled) return out;
  const { stripped, map } = stripSeparators(text);
  if (!stripped) return out;
  compiled.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = compiled.re.exec(stripped)) !== null) {
    if (m[0].length === 0) {
      compiled.re.lastIndex += 1;
      continue;
    }
    const originalIndex = map[m.index] ?? 0;
    if (hasNegationContext(text, originalIndex, neg)) continue;
    const endIndex = (map[m.index + m[0].length - 1] ?? originalIndex) + 1;
    out.push({
      term: compiled.canonical.get(m[0].toLowerCase()) ?? m[0],
      index: originalIndex,
      context: text.slice(Math.max(0, originalIndex - 40), endIndex + 40),
    });
  }
  return out;
}

/**
 * Collapse repeated letters (`canncer` -> `cancer`). EXTRA-PASS ONLY: applying
 * this to real copy would corrupt ordinary words, so the caller scans the
 * result in addition to — never instead of — the untouched surface.
 */
export function collapseDoubles(text: string): string {
  return text.replace(/([A-Za-z])\1+/g, '$1');
}

/**
 * Leetspeak fold (`canc3r`, `d1abetes`, `0besity`). EXTRA-PASS ONLY: folding
 * digits into letters on the primary text would corrupt legitimate
 * alphanumerics, so this never touches the surface that other checks read.
 * `1` is ambiguous, so both readings are produced by `deobfuscatedVariants`.
 */
const LEET_COMMON: Record<string, string> = { '3': 'e', '0': 'o', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

export function leetFold(text: string, oneAs: 'i' | 'l'): string {
  return text.replace(/[0134579@$]/g, (ch) => {
    if (ch === '1') return oneAs;
    return LEET_COMMON[ch] ?? ch;
  });
}

/**
 * ADDITIVE de-obfuscation passes for a surface: separator collapse plus both
 * leetspeak readings, composed. The primary text is always returned first and
 * is never rewritten.
 */
const DEOBFUSCATED_CACHE = new Map<string, string[]>();
const DOUBLE_COLLAPSED_CACHE = new Map<string, string[]>();

export function deobfuscatedVariants(text: string): string[] {
  return memoized(DEOBFUSCATED_CACHE, text, () => deobfuscatedVariantsUncached(text));
}

function deobfuscatedVariantsUncached(text: string): string[] {
  const out = new Set<string>([text]);
  for (const base of [text, collapseSeparators(text)]) {
    out.add(base);
    for (const one of ['i', 'l'] as const) {
      const leet = leetFold(base, one);
      if (leet === base) continue;
      out.add(leet);
      out.add(collapseSeparators(leet));
    }
  }
  return [...out];
}

/**
 * The same passes with repeated letters collapsed (`canncer` -> `cancer`).
 *
 * These variants must be scanned against a term list that has been collapsed
 * THE SAME WAY (`collapseDoublesTerms`): collapsing only the text would break
 * every term that legitimately contains a double letter.
 */
export function doubleCollapsedVariants(text: string): string[] {
  return memoized(DOUBLE_COLLAPSED_CACHE, text, () => [
    ...new Set(deobfuscatedVariants(text).map(collapseDoubles)),
  ]);
}

const COLLAPSED_TERMS_CACHE = new WeakMap<string[], string[]>();

/** `terms` with repeated letters collapsed, cached on the array instance. */
export function collapseDoublesTerms(terms: string[]): string[] {
  const cached = COLLAPSED_TERMS_CACHE.get(terms);
  if (cached) return cached;
  const collapsed = [...new Set(terms.map(collapseDoubles))];
  COLLAPSED_TERMS_CACHE.set(terms, collapsed);
  return collapsed;
}

// Per brain/04: "never", "banned", "do not", "there is no", "avoid", "not"
// (kept close to spec — broader cues over-suppress real violations).
const NEGATION_CUES = [
  'never',
  'banned',
  'do not',
  "don't",
  'there is no',
  'avoid',
  'not ',
  'no ', // "No disease language" / "makes no claims about …"
  'cannot',
  'must not',
  'prohibited',
];

/** Legacy proximity window (A8 / potency phrasing keep the original behaviour). */
const LEGACY_WINDOW_CHARS = 90;
/**
 * Tightened window for the disease-term path. Suppression now needs POSITIVE
 * evidence that the cue negates THIS term: the cue must sit essentially on top
 * of it, with nothing but filler in between.
 */
const STRICT_WINDOW_CHARS = 16;
/** How far after a meta-phrase ("not intended to …") the term may still sit. */
const META_MAX_GAP_CHARS = 24;

/**
 * Clause boundaries. A cue cannot reach across ANY of these — sentence
 * punctuation, a comma, a dash/en-dash/em-dash, a pipe, a slash or a bracket.
 * (`normalize` has already folded en/em dashes onto '-'.)
 */
const CLAUSE_BOUNDARY_RE = /[.;:!?,\-|/()\[\]{}\n\u2013\u2014]/;

/** Function words allowed between a meta-phrase and the term it negates. */
const META_GAP_CONNECTORS = new Set([
  'or', 'and', 'to', 'any', 'a', 'an', 'the', 'of', 'for', 'nor', 'no', 'not', 'other', 'such',
]);

export interface NegationOptions {
  /**
   * `legacy` — the original ~90-char proximity guard (A8, potency phrasing).
   * `strict` — POSITIVE-evidence rule: the cue must be adjacent to the term
   *            inside the same clause, or the term must sit inside (or in the
   *            enumeration immediately after) a pack meta-phrase.
   *            Used by the disease-term path (C6/A2).
   */
  mode?: 'legacy' | 'strict';
  /** Override the proximity window in characters. */
  windowChars?: number;
  /** Strict mode only: kept for call-site clarity — commas ALWAYS break a clause. */
  commaBreaks?: boolean;
  /**
   * Terms that VETO suppression when they appear between the negation cue and
   * the matched term — "No fillers … treats cancer" is a drug claim, not a
   * disclaimer. Pack data (`compliancePack.diseaseVerbs` + the generated
   * therapeutic-action verb class + the active disease nouns).
   */
  blockingVerbs?: string[];
  /**
   * Pack-driven meta-phrases that genuinely negate ("not intended to …").
   * When the match sits inside (or immediately after) one of these, suppress.
   * Absent/empty ⇒ fall back to the tightened clause rule alone.
   */
  metaPhrases?: string[];
  /**
   * Verbs allowed inside a meta-phrase ENUMERATION ("…diagnose or treat any
   * disease"). Pack data (`compliancePack.diseaseVerbs`).
   */
  metaGapVerbs?: string[];
}

/** True when any of `terms` occurs in `text` on a word boundary. */
function containsTerm(text: string, terms: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return terms.some((t) => {
    const term = t.trim().toLowerCase();
    return term !== '' && lower.includes(term) && termRegex(t).test(text);
  });
}

/**
 * Meta-phrase suppression: the match is INSIDE a genuine meta-phrase span, or
 * sits in the ENUMERATION immediately after one — no clause boundary, no
 * disease noun, no therapeutic-action verb, and nothing but connector words or
 * the pack's own disease verbs in between.
 */
function metaPhraseSuppresses(
  lower: string,
  matchIndex: number,
  phrases: string[],
  blockingVerbs: string[],
  metaGapVerbs: string[],
): boolean {
  const allowedGapWords = new Set([
    ...META_GAP_CONNECTORS,
    ...metaGapVerbs.map((v) => v.trim().toLowerCase()).filter(Boolean),
  ]);
  for (const raw of phrases) {
    const phrase = raw.trim().toLowerCase();
    if (!phrase) continue;
    let from = 0;
    for (;;) {
      const start = lower.indexOf(phrase, from);
      if (start < 0) break;
      const end = start + phrase.length;
      from = start + 1;
      if (matchIndex >= start && matchIndex < end) return true; // inside the phrase
      if (end > matchIndex || matchIndex - end > META_MAX_GAP_CHARS) continue;
      const between = lower.slice(end, matchIndex);
      // A comma / dash / pipe / slash / sentence mark ENDS the disclaimer —
      // "Not intended to diagnose, cancer support in weeks" is a claim.
      if (CLAUSE_BOUNDARY_RE.test(between)) continue;
      if (blockingVerbs.length > 0 && containsTerm(between, blockingVerbs)) continue;
      const words = between.split(/[^a-z0-9']+/).filter(Boolean);
      if (words.length === 0) continue; // the term is the direct object, not an enumeration
      if (!words.every((w) => allowedGapWords.has(w))) continue;
      return true;
    }
  }
  return false;
}

/**
 * True when the term at `matchIndex` is actually NEGATED by its context.
 *
 * Default (`legacy`) keeps the original ~90-char proximity rule. `strict` mode
 * INVERTS the default: it suppresses only on positive evidence — the cue is
 * adjacent to the term within one clause with no blocking verb/noun between, or
 * the term sits inside a pack meta-phrase (or its enumeration).
 */
export function hasNegationContext(
  text: string,
  matchIndex: number,
  opts: NegationOptions = {},
): boolean {
  const lower = text.toLowerCase();
  if ((opts.mode ?? 'legacy') === 'legacy') {
    const windowStart = Math.max(0, matchIndex - (opts.windowChars ?? LEGACY_WINDOW_CHARS));
    const preceding = lower.slice(windowStart, matchIndex);
    return NEGATION_CUES.some((cue) => preceding.includes(cue));
  }

  const blockingVerbs = opts.blockingVerbs ?? [];
  const metaPhrases = opts.metaPhrases ?? [];
  if (
    metaPhrases.length > 0 &&
    metaPhraseSuppresses(lower, matchIndex, metaPhrases, blockingVerbs, opts.metaGapVerbs ?? [])
  ) {
    return true;
  }

  // POSITIVE EVIDENCE ONLY: a cue must sit right on top of the term.
  const windowStart = Math.max(0, matchIndex - (opts.windowChars ?? STRICT_WINDOW_CHARS));
  const preceding = lower.slice(windowStart, matchIndex);
  let cueEnd = -1;
  for (const cue of NEGATION_CUES) {
    const i = preceding.lastIndexOf(cue);
    if (i >= 0) cueEnd = Math.max(cueEnd, i + cue.length);
  }
  if (cueEnd < 0) return false;

  const gap = preceding.slice(cueEnd);
  // (a) a clause boundary between the cue and the term means the cue is talking
  // about something else — "Never any junk - relieves arthritis".
  if (CLAUSE_BOUNDARY_RE.test(gap)) return false;
  // (b) a therapeutic-action verb (or another disease term) in between means the
  // cue negates something else entirely — never suppress.
  if (blockingVerbs.length > 0 && containsTerm(gap, blockingVerbs)) return false;
  return true;
}

/**
 * TERM WORD BOUNDARIES.
 *
 * Both guards used to be `[a-z0-9]`, which meant a single trailing or leading
 * DIGIT disarmed the whole lexicon: `cancer1`, `cancer\u00b9` (NFKC-folded to
 * `cancer1`) and `1cancer` all evaded every scan. The guards are letters-only
 * now, so a digit no longer buys immunity while a real word still cannot match
 * inside a longer word (`cancerous`, `oncancer`).
 *
 * Legitimate alphanumerics are unaffected because they are not banned terms:
 * a term list containing `cancer` cannot match `B12`, `CoQ10`, `Omega-3` or
 * `5-HTP` no matter what the boundary is.
 */
const TERM_LEAD = '(?<![a-z])';
const TERM_TRAIL = '(?![a-z])';

const TERM_RE_CACHE = new Map<string, RegExp>();

/** Word-boundary regex for a term, tolerating simple plural s/es and flexible inner whitespace. */
export function termRegex(term: string): RegExp {
  const cached = TERM_RE_CACHE.get(term);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  const escaped = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(`${TERM_LEAD}${escaped}(?:e?s)?${TERM_TRAIL}`, 'gi');
  TERM_RE_CACHE.set(term, re);
  return re;
}

/**
 * Inflections of a therapeutic-action verb ROOT, generated in code so the pack
 * ships roots only and the whole verb CLASS stays covered
 * (relieve → relieves/relieved/relieving, stop → stops/stopped/stopping).
 */
export function inflect(root: string): string[] {
  const r = root.trim().toLowerCase();
  if (!r) return [];
  const forms = new Set<string>([r]);
  if (r.endsWith('e')) {
    const stem = r.slice(0, -1);
    forms.add(`${r}s`).add(`${r}d`).add(`${stem}ing`).add(`${stem}ed`);
  } else if (/(?:s|x|z|ch|sh)$/.test(r)) {
    forms.add(`${r}es`).add(`${r}ed`).add(`${r}ing`);
  } else if (/[^aeiou]y$/.test(r)) {
    const stem = r.slice(0, -1);
    forms.add(`${stem}ies`).add(`${stem}ied`).add(`${r}ing`);
  } else {
    forms.add(`${r}s`).add(`${r}ed`).add(`${r}ing`);
    if (/[^aeiou][aeiou][bdglmnprt]$/.test(r)) {
      const doubled = r + r.slice(-1);
      forms.add(`${doubled}ed`).add(`${doubled}ing`);
    }
  }
  return [...forms];
}

/** All inflections of every root, de-duplicated. */
export function inflectAll(roots: string[]): string[] {
  return [...new Set(roots.flatMap(inflect))];
}

export interface TermMatch {
  term: string;
  index: number;
  context: string;
}

interface CompiledTerms {
  re: RegExp;
  canonical: Map<string, string>;
}

/**
 * ONE alternation regex per term LIST (cached on the array instance).
 *
 * The lexicon is now the full union of every subcategory list — running 600+
 * separate regexes over every de-obfuscated variant of every surface made the
 * gate ~10x slower than it needs to be. Longest-first alternation preserves the
 * "report the most specific term" behaviour.
 */
const ALTERNATION_CACHE = new WeakMap<string[], CompiledTerms>();

function compileTerms(terms: string[]): CompiledTerms {
  const cached = ALTERNATION_CACHE.get(terms);
  if (cached) return cached;
  const canonical = new Map<string, string>();
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const term of cleaned) {
    const key = term.toLowerCase().replace(/\s+/g, ' ');
    if (!canonical.has(key)) canonical.set(key, term);
  }
  const source = cleaned
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  const compiled: CompiledTerms = {
    re: new RegExp(`${TERM_LEAD}(?:${source})(?:e?s)?${TERM_TRAIL}`, 'gi'),
    canonical,
  };
  ALTERNATION_CACHE.set(terms, compiled);
  return compiled;
}

/** Map a matched string back onto the pack term that produced it. */
function canonicalTerm(match: string, canonical: Map<string, string>): string {
  const key = match.toLowerCase().replace(/\s+/g, ' ');
  return (
    canonical.get(key) ??
    canonical.get(key.replace(/es$/, '')) ??
    canonical.get(key.replace(/s$/, '')) ??
    match
  );
}

/** All non-negated matches of `terms` in `text` (text should be normalized first). */
export function scanTerms(text: string, terms: string[], neg: NegationOptions = {}): TermMatch[] {
  const matches: TermMatch[] = [];
  if (terms.length === 0 || !text) return matches;
  const { re, canonical } = compileTerms(terms);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (hasNegationContext(text, m.index, neg)) continue;
    matches.push({
      term: canonicalTerm(m[0], canonical),
      index: m.index,
      context: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40),
    });
  }
  return matches;
}

/** Remove every occurrence of the disclaimer(s) before compliance scanning. */
export function subtractDisclaimers(text: string, disclaimers: string[]): string {
  let t = text;
  for (const d of disclaimers) {
    if (!d) continue;
    t = t.split(normalize(d)).join(' ');
    t = t.split(d).join(' ');
  }
  return t;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'with', 'in', 'on', 'to', 'or', 'per',
  'by', 'at', 'from', 'as', 'is', 'are', 'be', 'no',
]);

/** Lowercased, stemmed (trailing s stripped) content tokens. */
export function tokenSet(text: string): Set<string> {
  const tokens = normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.replace(/'s$/, '').replace(/s$/, ''));
  return new Set(tokens.filter(Boolean));
}
