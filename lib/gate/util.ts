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

/**
 * SMALL-CAPITAL letters (`ᴄᴀɴᴄᴇʀ`), keyed by their ASCII twin.
 *
 * These are ordinary Unicode letters with NO compatibility decomposition, so
 * neither NFKC nor the combining-mark strip touches them — `ᴄᴀɴᴄᴇʀ` was a
 * different string from `cancer` to every scan. The sweep covers the Latin
 * small-capital block U+1D00-U+1D23 plus the small capitals that live outside
 * it (U+0262 ɢ, U+026A ɪ, U+0274 ɴ, U+0280 ʀ, U+0299 ʙ, U+028F ʏ, U+029C ʜ,
 * U+029F ʟ), U+01A6 Ʀ and the LATIN-EXTENDED-D small capitals U+A730 ꜰ,
 * U+A731 ꜱ and U+A7AF ꞯ.
 *
 * The last three were missing, and ꜱ is the one that mattered: it is the
 * plural `s` of almost every payload, so `ᴅɪꜱꜱᴏʟᴠᴇꜱ` survived the fold as a
 * different string from `dissolves`.
 *
 * DELIBERATELY NOT MAPPED: U+1D26-U+1D2B are Greek/Cyrillic small capitals and
 * U+1D24/U+1D25 are phonetic symbols with no Latin twin — mapping them onto
 * Latin letters would be a guess, not a fold. Unicode has no small-capital X.
 */
const SMALL_CAPITALS: Record<string, string> = {
  a: '\u1d00\u1d01\u1d02',
  b: '\u1d03\u0299',
  c: '\u1d04',
  d: '\u1d05\u1d06',
  e: '\u1d07\u1d08',
  f: '\ua730',
  g: '\u0262',
  h: '\u029c',
  i: '\u026a\u1d09',
  j: '\u1d0a',
  k: '\u1d0b',
  l: '\u1d0c\u029f',
  m: '\u1d0d\u1d1f',
  n: '\u1d0e\u0274',
  o: '\u1d0f\u1d10\u1d11\u1d12\u1d13\u1d14\u1d15\u1d16\u1d17',
  p: '\u1d18\u1d29',
  q: '\ua7af',
  r: '\u1d19\u1d1a\u0280\u01a6',
  s: '\ua731',
  t: '\u1d1b',
  u: '\u1d1c\u1d1d\u1d1e',
  v: '\u1d20',
  w: '\u1d21',
  y: '\u028f',
  z: '\u1d22\u1d23',
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
  for (const table of [LOOKALIKES, SMALL_CAPITALS]) {
    for (const [ascii, chars] of Object.entries(table)) {
      for (const ch of chars) {
        add(ch, ascii);
        const upper = ch.toUpperCase();
        if (upper.length === 1) add(upper, ascii.toUpperCase());
      }
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
const INVISIBLE_CLASS =
  '\\u00AD\\u034F\\u061C\\u115F\\u1160\\u180B-\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F\\uFEFF';
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CLASS}]`, 'g');

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

/**
 * THE HYPHEN/DASH CLASS — a superset of the one the ENGINE folds at emit.
 *
 * Round P made the word JOIN of a banned phrase a class (`PHRASE_JOIN`,
 * `[\s-]+`), so `limited-time offer` fails exactly like `limited time offer`.
 * That leg reads text this file has already normalized, which means the set of
 * characters it can see as a hyphen is exactly the set the fold below defines —
 * and that set was spelled out by hand here, differently from the way
 * `lib/engine/typography.ts` spells it, with neither derived from the other. It
 * is the SAME defect round P fixed one level up: a class written twice.
 *
 * WHAT THAT COST. `normalize` folded U+2011/U+2013/U+2014/U+2015/U+2212 and NOT
 * U+2010 HYPHEN, U+2012 FIGURE DASH or U+2043 HYPHEN BULLET, and none of the
 * three is in any separator class either — so a phrase joined by one of them
 * reached C18/C19 as an unbroken foreign string and matched no ban row. On a
 * customer-visible surface that was covered anyway (C27's pure-ASCII rule fails
 * the raw character), but `backendSearchTerms` and `facts` are ASCII-EXEMPT
 * while C18/C19 still declare `backendSearchTerms` — so a hyphen-bullet-joined
 * `limited⁃time offer` parked there produced ZERO failures from the whole gate.
 * See §22.2.1 of CONFORMANCE-DEVIATIONS.md.
 *
 * The class below covers every hyphen-like dash the engine folds (U+2010-U+2015,
 * U+2212) PLUS U+2043, which the engine does not fold at all. The CHECKER
 * folding at least as much as the worker is the safe direction: a character the
 * engine would have turned into `-` must never be readable as something else
 * here. It cannot over-block, because the folded form matches exactly what the
 * plain ASCII `-` spelling already matched — which is why the lawful hyphenated
 * battery is asserted clean in every one of these spellings.
 *
 * DELIBERATELY NOT INCLUDED: U+2E3A/U+2E3B (two/three-em dashes) and the CJK
 * fullwidth/wavy dashes. They are not how Latin copy writes an intra-word
 * hyphen, and `compatibilityVariant` already gives the pattern scans an NFKC
 * pass for the fullwidth family.
 */
const DASH_FOLD_RE = /[‐‑‒–—―⁃−]/g;

/** Combining diacritics — `cańcer` is `cancer` plus U+0301 and must fold to it. */
const COMBINING_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20F0\uFE20-\uFE2F]/g;

/**
 * Per-character NFKC fold, restricted to folds whose result is made up ENTIRELY
 * of letters/digits (fullwidth `ｃ`, math-bold, circled digits, the ligatures
 * `ﬁ`/`ﬂ`/`ﬃ`, the squared unit `㎎`, roman numerals).
 *
 * The length-1 restriction this replaces let every LIGATURE through: U+FB01 `ﬁ`
 * NFKC-folds to the TWO characters "fi", so `ﬁbromyalgia` and `inﬂammation`
 * were kept verbatim and evaded the term scan. Multi-character results are now
 * accepted as long as every resulting character is alphanumeric.
 *
 * Whole-string NFKC would also rewrite meaningful SYMBOLS into ASCII letter
 * pairs, which would silently blind the pack-driven banned-symbol scan — so the
 * fold is still limited to purely alphanumeric results.
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
    if (nfkc === ch || !/^[\p{L}\p{N}]+$/u.test(nfkc)) {
      out += ch;
      continue;
    }
    // A MULTI-character fold is accepted only when the SOURCE is itself a
    // letter/digit. Without that guard the SYMBOLS the style gate must still
    // see would dissolve into letters — U+2122 NFKC-folds to two ASCII
    // letters, which would blind the pack-driven banned-symbol scan
    // completely.
    out += nfkc.length === 1 || /[\p{L}\p{N}]/u.test(ch) ? nfkc : ch;
  }
  return out;
}

/**
 * Curly→straight quotes, the whole `DASH_FOLD_RE` class→hyphen, entity decode, INVISIBLE-character
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
  // ORDER MATTERS. Stripping invisibles BEFORE decoding entities meant
  // `can&#8203;cer` materialised a zero-width space AFTER the only pass that
  // removes them (and `39 doll&#8203;ars` defeated C18 the same way). Decode
  // first, strip, then decode+strip once more so an entity that was itself
  // split by an invisible character (`&am&#8203;p;`) also resolves.
  let t = decodeEntities(src).replace(INVISIBLE_RE, '');
  t = decodeEntities(t).replace(INVISIBLE_RE, '');
  // NFD first so an accent becomes a separate combining mark, then drop the
  // marks: `cańcer` and `cañcer` both fold onto `cancer`.
  t = t.normalize('NFD').replace(COMBINING_RE, '');
  t = foldCompatibility(t);
  return t
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(DASH_FOLD_RE, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * COMPATIBILITY PUNCTUATION fold, produced as an EXTRA scan variant.
 *
 * `foldCompatibility` (used by `normalize`) deliberately refuses any fold whose
 * result is not purely alphanumeric, so the SYMBOLS the style gate must still
 * see are never dissolved. The cost of that rule is that fullwidth/compatibility
 * PUNCTUATION survives untouched — `＄24.99`, `50％ off`, `＃1`, `care＠brandx。com`,
 * `555・123・4567` all walked past the price / discount / contact / promo-term
 * patterns.
 *
 * This helper is therefore ADDITIVE and is only handed to the pattern scans: a
 * whole-string NFKC pass, plus the handful of CJK/compatibility dot-and-comma
 * characters NFKC does NOT decompose (U+3002, U+30FB, U+3001 and friends), which
 * are what a fullwidth email/phone payload is actually built from. The primary
 * text is never rewritten, so the trademark/currency symbol detection (which
 * reads the primary text) is unaffected.
 */
const PUNCT_COMPAT: Record<string, string> = {
  '\u3002': '.', '\uFF61': '.', '\u30FB': '.', '\uFF65': '.',
  '\u2024': '.', '\u2027': '.', '\u2219': '.', '\u22C5': '.', '\u00B7': '.',
  '\u3001': ',', '\uFF64': ',',
};

export function compatibilityVariant(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKC')) out += PUNCT_COMPAT[ch] ?? ch;
  return out;
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
const SEPARATOR_STRIP_RE = new RegExp(`[\\s.\\-\u2013\u2014\u2015\u2212\u00b7*/,|'\u2018\u2019_~+:;${INVISIBLE_CLASS}]+`, 'g');

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
  // Invisible/format characters are separators for THIS pass too, so a
  // zero-width space glued into a word cannot survive into the concatenated
  // surface when the caller hands over text that was never normalized.
  ...INVISIBLE_CHARS,
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
 * Build the alternation for the concatenated pass.
 *
 * There are no word boundaries left INSIDE a concatenated surface, so the match
 * itself is plain substring matching; the boundaries are re-imposed afterwards
 * against the ORIGINAL text (see `scanConcatenated`), which is what stops the
 * accidental substrings this pass used to manufacture
 * (`routine and` -> `routineand` -> contains `tinea`).
 *
 * A minimum term length is still enforced, but only as a cheap cost/benefit
 * filter — with token anchoring in place it can be low enough to cover
 * `g out` -> `gout` and `ib s` -> `ibs`. Terms shorter than `minLen` are NOT
 * covered by this pass; they remain covered by the ordinary word-boundary scan
 * on the untouched text.
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
  // Trailing plural is part of the match so `tum ors` still anchors on the
  // token END (see `scanConcatenated`) instead of stopping one char short.
  // The BARE term is captured in group 1 so `scanConcatenated` can re-anchor on
  // it when the optional `(?:e?s)?` swallowed the first letter of the NEXT word
  // (`can cer support` -> `cancers|upport`) — see the anchor retry there.
  const compiled: CompiledConcat = { re: new RegExp(`(${source})(?:e?s)?`, 'gi'), canonical };
  byLen.set(minLen, compiled);
  return compiled;
}

/** True when `ch` is a Latin letter — the same guard `termRegex` uses. */
export const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z]/.test(ch);

/**
 * TOKEN ANCHORING for a match found in a separator-STRIPPED variant.
 *
 * `stripSeparators` returns a map from stripped index back to the index in the
 * ORIGINAL text. A match is only real when, in that original text, the
 * character before its first character and the character after its last are
 * not letters — which is what keeps `sh rinks` (a split token) while rejecting
 * `clumps` -> `lump` (a fragment of a longer word). Extracted from
 * `scanConcatenated` so every stripped-variant scan anchors identically.
 */
export function concatAnchored(
  original: string,
  map: number[],
  start: number,
  end: number,
): boolean {
  const first = map[start];
  const last = map[end - 1];
  if (first === undefined || last === undefined) return false;
  return !isLetter(original[first - 1]) && !isLetter(original[last + 1]);
}

/**
 * Scan the separator-stripped variant of `text` for separator-stripped `terms`.
 *
 * TOKEN ANCHORING. A match is kept only when, IN THE ORIGINAL TEXT, the
 * character before its first character and the character after its last
 * character are not letters. That is exactly the word-boundary rule the
 * ordinary scan uses, evaluated on the un-glued text, and it is what separates
 * the two directions this pass has to get right:
 *   - `g out` -> `gout`  : preceded by a space, followed by a space  => KEPT
 *   - `ib s`  -> `ibs`   : ditto                                     => KEPT
 *   - `routine and` -> `routineand` contains `tinea`, but that match starts
 *     after the `u` of "routine"                                     => DROPPED
 *   - `utility` contains `uti`, but that match ends before the `l`    => DROPPED
 * Consequence (stated plainly): a split INSIDE a longer word — `cancerous`
 * written as `cancer ous` — is not reported by this pass, the same way
 * `cancerous` is not reported by the ordinary scan.
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
    // A match that fails the anchor must NOT consume the region it covered:
    // in `lu puss` -> `lupuss` the alternation matched `flu` inside
    // `relief|lupus`, that match was correctly dropped, and `lastIndex` had
    // already moved past the real `lupus`. Scanning resumes one character after
    // the rejected match instead.
    const matchStart = m.index;
    const resume = (): void => { compiled.re.lastIndex = matchStart + 1; };
    // Token anchoring, evaluated on the ORIGINAL (un-glued) text.
    if (isLetter(text[originalIndex - 1])) {
      resume();
      continue;
    }
    // TRAILING-ANCHOR RETRY. The regex ends on an OPTIONAL `(?:e?s)?`, so when
    // the word after a split term starts with `s`/`es` the optional suffix
    // swallowed it (`can cer support` -> `cancers|upport`), the anchor saw a
    // letter and the whole match was DROPPED — silently defeating this pass.
    // The same happened one level up when the term list itself ships the plural
    // (`tumors` is a term, so `tum or shrinkage` matched `tumors` and the `s`
    // came out of "shrinkage").
    //
    // A match is therefore accepted when ANY of these ends satisfies the
    // original-text anchor: the suffixed end, the bare-term end, or — when the
    // bare term itself ends in `s`/`es` and the shortened form is ALSO a known
    // term — that shorter end.
    const base = (m[1] ?? m[0]).toLowerCase();
    const fullLen = m[0].length;
    const ends: number[] = [];
    const addEnd = (len: number): void => {
      if (len >= minLen && len <= fullLen && !ends.includes(len)) ends.push(len);
    };
    addEnd(fullLen);
    addEnd(base.length);
    if (base.endsWith('es') && compiled.canonical.has(base.slice(0, -2))) addEnd(base.length - 2);
    if (base.endsWith('s') && compiled.canonical.has(base.slice(0, -1))) addEnd(base.length - 1);
    let lastIndex = -1;
    let matched = m[0];
    for (const len of ends) {
      const candidate = map[m.index + len - 1] ?? originalIndex;
      if (isLetter(text[candidate + 1])) continue;
      lastIndex = candidate;
      matched = m[0].slice(0, len);
      break;
    }
    if (lastIndex < 0) {
      resume();
      continue;
    }
    if (hasNegationContext(text, originalIndex, neg)) continue;
    const endIndex = lastIndex + 1;
    const key = matched.toLowerCase();
    out.push({
      term:
        compiled.canonical.get(key) ??
        compiled.canonical.get(key.replace(/es$/, '')) ??
        compiled.canonical.get(key.replace(/s$/, '')) ??
        matched,
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

/**
 * THE de-obfuscation variant set every pattern/shape scan runs over, split by
 * what each class preserves. ONE definition, shared by C18/C19 (which want the
 * flat list) and C21 (which compiles a different rule set per class because
 * word boundaries mean nothing in a concatenated string).
 *
 *  - `spaced`   — variants that keep word separation: the untouched text, the
 *                 separator-COLLAPSED form, both leetspeak readings and the
 *                 compatibility-punctuation fold. Word boundaries still hold.
 *  - `stripped` — the separator-STRIPPED form plus its index map back into
 *                 `clean`, so a match can be TOKEN-ANCHORED (`concatAnchored`).
 *  - `all`      — `spaced` then `stripped`, i.e. the flat set the pattern
 *                 scans have always used, in the order they have always used.
 *
 * The untouched text is always first: every class is ADDITIVE and none of them
 * ever replaces the surface other checks read.
 */
export interface ObfuscationVariants {
  spaced: string[];
  stripped: StrippedText | null;
  all: string[];
}

const OBFUSCATION_CACHE = new Map<string, ObfuscationVariants>();

export function obfuscationVariants(clean: string): ObfuscationVariants {
  return memoized(OBFUSCATION_CACHE, clean, () => {
    const spaced = new Set<string>(deobfuscatedVariants(clean));
    const all = new Set<string>(spaced);
    const strippedText = stripSeparators(clean);
    const stripped = strippedText.stripped ? strippedText : null;
    if (stripped) all.add(stripped.stripped);
    // COMPATIBILITY-PUNCTUATION variant: `normalize` deliberately leaves
    // fullwidth/CJK punctuation alone (folding it would dissolve the symbols
    // the style gate must still see), which let `＄24.99`, `50％ off`,
    // `care＠brandx。com` and `555・123・4567` walk past every pattern. Added as
    // an EXTRA variant only — variant #1 is still the untouched text.
    const compat = compatibilityVariant(clean);
    if (compat !== clean) {
      for (const v of [compat, ...deobfuscatedVariants(compat)]) {
        spaced.add(v);
        all.add(v);
      }
    }
    return { spaced: [...spaced], stripped, all: [...all] };
  });
}

const COLLAPSED_TERMS_CACHE = new WeakMap<string[], string[]>();

/**
 * Minimum length of a COLLAPSED term for it to take part in the doubled-letter
 * pass.
 *
 * `collapseDoubles('Add')` is `'Ad'` and the TERMS are collapsed too, so the
 * 3-letter noun `add` became the 2-letter fragment `ad` and matched the verb
 * "add" in every piece of ordinary copy ("Simply add water", "Add one chew to
 * your routine"). Short collapsed forms carry no signal and all of the
 * collisions, so they are excluded from this pass; they stay fully covered by
 * the ordinary word-boundary scan on the untouched text.
 */
export const DOUBLE_COLLAPSE_MIN_TERM_LEN = 5;

/**
 * `terms` with repeated letters collapsed, cached on the array instance.
 * Terms whose collapsed form is shorter than `DOUBLE_COLLAPSE_MIN_TERM_LEN`
 * are dropped — see the constant above.
 */
export function collapseDoublesTerms(terms: string[]): string[] {
  const cached = COLLAPSED_TERMS_CACHE.get(terms);
  if (cached) return cached;
  const collapsed = [
    ...new Set(
      terms
        .map(collapseDoubles)
        .filter((t) => t.trim().length >= DOUBLE_COLLAPSE_MIN_TERM_LEN),
    ),
  ];
  COLLAPSED_TERMS_CACHE.set(terms, collapsed);
  return collapsed;
}

/**
 * LEGACY cue set (A8 / potency phrasing) — the original ~90-char proximity
 * guard, unchanged.
 */
const LEGACY_NEGATION_CUES = [
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

/**
 * STRICT cue set (the DISEASE path, C6/A2).
 *
 * The bare cues `no `, `not `, `never` and `avoid` are DELIBERATELY ABSENT:
 * placed in front of a disease noun they do not negate the claim, they ARE the
 * claim — "Avoid diabetes", "No more arthritis pain", "Never depression again",
 * "No cancer worries" are all prevention claims, and every one of them used to
 * be suppressed by its own cue. Genuine disclaimers do not rely on a bare cue:
 * they are matched by the pack's `negationMetaPhrases` ("not intended to
 * diagnose, treat, cure, or prevent any disease"), which is positive evidence
 * and is checked first.
 *
 * ROUND-6 REMOVAL: `do not`, `don't`, `must not` and `cannot` are gone too.
 * They are IMPERATIVE, not prohibitive, and in front of a disease noun they are
 * the claim: "Don't let osteoporosis steal your bones", "Do not suffer
 * migraines another day", "You must not accept arthritis pain" are all
 * prevention/treatment claims that each used to suppress themselves.
 *
 * What remains are cues that cannot be read as a claim ABOUT a disease
 * ("banned", "prohibited", "there is no") — e.g. an internal note saying
 * "disease words are banned".
 */
const STRICT_NEGATION_CUES = [
  'banned',
  'there is no',
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

/**
 * Function words allowed between a meta-phrase and the term it negates.
 *
 * ROUND-6 REMOVAL: `or`, `and`, `for` and `the` are gone. They are the hinge
 * every laundering payload turned on — "Not intended to diagnose OR THE tumor
 * shrinks within two weeks", "This is not a drug FOR hypertension yet users cut
 * their pills", "Not a substitute for medical advice OR cancer care". A genuine
 * enumeration is covered by the FULL meta-phrase (the noun then sits INSIDE the
 * phrase span), which needs no connector at all.
 */
const META_GAP_CONNECTORS = new Set([
  'to', 'any', 'a', 'an', 'of', 'nor', 'no', 'not', 'other', 'such',
]);

/**
 * A RESULT claim following the noun ("shrinks within two weeks", "50% in a
 * month"). Purely structural — a time-frame or a percentage — so it carries no
 * domain lexicon. Present in the same sentence, it vetoes meta-phrase
 * suppression: a disclaimer does not promise an outcome.
 */
const RESULT_CLAIM_RE =
  /\b(?:in|within|after)\s+(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:day|week|month|year)s?\b|\b\d+(?:\.\d+)?\s*%/i;

/**
 * True when the character before `start` (skipping whitespace) is clause
 * punctuation, or `start` is the beginning of the string.
 */
function atClauseStart(lower: string, start: number): boolean {
  for (let i = start - 1; i >= 0; i--) {
    const ch = lower[i]!;
    if (/\s/.test(ch)) continue;
    return CLAUSE_BOUNDARY_RE.test(ch);
  }
  return true;
}

export interface NegationOptions {
  /**
   * `legacy` — the original ~90-char proximity guard (A8, potency phrasing).
   * `strict` — POSITIVE-evidence rule: the cue must be adjacent to the term
   *            inside the same clause, or the term must sit inside (or in the
   *            enumeration immediately after) a pack meta-phrase.
   *            Used by the disease-term path (C6/A2).
   * `none`   — NO negation handling at all. Used by the checks whose documented
   *            contract is "prohibited whatever surrounds it" (C18/C19): those
   *            used to fall through to `legacy` by default, which re-opened the
   *            very hole their own comments said they had closed.
   */
  mode?: 'legacy' | 'strict' | 'none';
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
  /**
   * Pack-driven BENIGN SPANS (`compliancePack.benignContextPhrases`): fixed
   * retail phrases in which a disease word is a calendar/seasonal reference
   * rather than a claim ("cold and flu season"). A match INSIDE such a span is
   * suppressed — unless a therapeutic-action verb sits in the same clause in
   * front of it, so "prevents colds during cold and flu season" still fails.
   */
  benignPhrases?: string[];
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
      // The ENUMERATION branch. The meta-phrase must be its OWN clause — a
      // phrase glued onto the tail of another clause ("This is not a drug for
      // hypertension …") is a fragment being used as cover, not a disclaimer.
      if (!atClauseStart(lower, start)) continue;
      const between = lower.slice(end, matchIndex);
      // A comma / dash / pipe / slash / sentence mark ENDS the disclaimer —
      // "Not intended to diagnose, cancer support in weeks" is a claim.
      if (CLAUSE_BOUNDARY_RE.test(between)) continue;
      if (blockingVerbs.length > 0 && containsTerm(between, blockingVerbs)) continue;
      const words = between.split(/[^a-z0-9']+/).filter(Boolean);
      if (words.length === 0) continue; // the term is the direct object, not an enumeration
      if (!words.every((w) => allowedGapWords.has(w))) continue;
      // A therapeutic-action verb or a RESULT claim after the noun, in the same
      // sentence, means the sentence makes a claim whatever it opened with.
      const sentence = lower.slice(matchIndex).split(/[.;!?\n]/)[0] ?? '';
      if (blockingVerbs.length > 0 && containsTerm(sentence, blockingVerbs)) continue;
      if (RESULT_CLAIM_RE.test(sentence)) continue;
      return true;
    }
  }
  return false;
}

/**
 * BENIGN-SPAN suppression: the match sits INSIDE a pack benign phrase and no
 * therapeutic-action verb precedes that phrase within the same clause.
 *
 * Scope note: this suppresses ONLY matches whose index falls inside the phrase
 * span itself. A disease word elsewhere in the same sentence is untouched.
 */
function benignPhraseSuppresses(
  lower: string,
  matchIndex: number,
  phrases: string[],
  blockingVerbs: string[],
): boolean {
  for (const raw of phrases) {
    const phrase = raw.trim().toLowerCase();
    if (!phrase) continue;
    let from = 0;
    for (;;) {
      const start = lower.indexOf(phrase, from);
      if (start < 0) break;
      from = start + 1;
      if (matchIndex < start || matchIndex >= start + phrase.length) continue;
      // A therapeutic-action verb in the clause leading up to the phrase turns
      // it back into a claim — "prevents colds during cold and flu season".
      const lead = lower.slice(Math.max(0, start - LEGACY_WINDOW_CHARS), start);
      const clauseParts = lead.split(CLAUSE_BOUNDARY_RE);
      const sameClause = clauseParts[clauseParts.length - 1] ?? '';
      if (blockingVerbs.length > 0 && containsTerm(sameClause, blockingVerbs)) continue;
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
  if (opts.mode === 'none') return false;
  if ((opts.mode ?? 'legacy') === 'legacy') {
    const windowStart = Math.max(0, matchIndex - (opts.windowChars ?? LEGACY_WINDOW_CHARS));
    const preceding = lower.slice(windowStart, matchIndex);
    return LEGACY_NEGATION_CUES.some((cue) => preceding.includes(cue));
  }

  const blockingVerbs = opts.blockingVerbs ?? [];
  const metaPhrases = opts.metaPhrases ?? [];
  if (
    metaPhrases.length > 0 &&
    metaPhraseSuppresses(lower, matchIndex, metaPhrases, blockingVerbs, opts.metaGapVerbs ?? [])
  ) {
    return true;
  }
  const benign = opts.benignPhrases ?? [];
  if (benign.length > 0 && benignPhraseSuppresses(lower, matchIndex, benign, blockingVerbs)) {
    return true;
  }

  // POSITIVE EVIDENCE ONLY: a cue must sit right on top of the term.
  const windowStart = Math.max(0, matchIndex - (opts.windowChars ?? STRICT_WINDOW_CHARS));
  const preceding = lower.slice(windowStart, matchIndex);
  let cueEnd = -1;
  for (const cue of STRICT_NEGATION_CUES) {
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

/**
 * THE SEPARATOR BETWEEN THE WORDS OF A MULTI-WORD PHRASE — one class, one place.
 *
 * A hyphen is how English WRITES a compound, not a trick for hiding one.
 * `limited-time offer`, `Doctor-recommended`, `As-Seen-On-TV` and `number-one
 * rated` are the STANDARD spellings of phrases the packs ban, and every one of
 * them produced ZERO failures while its spaced twin failed, because BOTH legs of
 * the matcher joined the words of a phrase with whitespace alone: this file's
 * term compilers (`\s+`) and the pack-authored REGEX SOURCES (`\s+` or a literal
 * space). `maximum-strength`, `clinically-proven` and `Today-only` were caught
 * only by the accident that they ALSO sit in a term list whose separator-
 * STRIPPED variant covers hyphens — an accident that was mistaken for coverage
 * and written down as one.
 *
 * The fix is a CLASS, applied wherever a BAN phrase becomes a regex: the words
 * of a phrase are joined by whitespace OR a hyphen. It is a pure narrowing of
 * the evasion surface — a single-word term has no join to widen, and a widened
 * join still has to match every other character the phrase already required, so
 * it cannot reach copy the spaced form would not have reached.
 *
 * THE ONE PLACE IT IS DELIBERATELY NOT APPLIED is the generic term compiler
 * (`termRegex` / `compileTerms`), which also answers PRESENCE questions where a
 * wider join is more permissive rather than stricter. That direction argument is
 * written out on `termRegex`, and the ban side of that leg is already covered by
 * the separator-STRIPPED variant scan.
 */
export const PHRASE_JOIN = '[\\s-]+';

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * A LITERAL phrase as a regex source: regex metacharacters escaped, every inner
 * run of whitespace compiled to the separator class.
 *
 * `join` exists for the callers that deliberately allow an EMPTY separator (the
 * concatenated-variant scans, which have already stripped separators out of the
 * text); it must always be a class that contains whitespace.
 */
export function phraseSource(phrase: string, join: string = PHRASE_JOIN): string {
  return phrase.trim().replace(REGEX_META_RE, '\\$&').replace(/\s+/g, join);
}

/**
 * A pack-authored REGEX SOURCE made separator-agnostic between words.
 *
 * Pack patterns are hand-written regex, so the join between two words appears as
 * `\s`, `\s+`, `\s*` or a literal space, and several rows already spell it as a
 * class (`money[- ]back`, `top[- ]?rated`, `clinically[\s-]+studied`). Rewriting
 * the class row-by-row is what produced the mixed list this fixes: the rows that
 * were remembered are hyphen-proof and the rows that were not are bypasses.
 *
 * The rewrite is deliberately CONSERVATIVE and structural:
 *   - `\s` (with any quantifier that follows it) becomes `[\s-]`, so `\s+` →
 *     `[\s-]+`, `\s*` → `[\s-]*` and `\s{2,}` → `[\s-]{2,}` — the quantifier is
 *     never touched, only the atom;
 *   - a LITERAL space likewise becomes `[\s-]`;
 *   - anything inside a CHARACTER CLASS is left exactly as written, so `[^\s]`
 *     (bare-URL row) and `[\s.-]` (phone rows) keep their meaning;
 *   - an escaped character (`\\`, `\[`, `\$`) is copied with its backslash, so
 *     an escaped literal is never re-read as a metacharacter.
 * A row that already writes the class is therefore left alone, and no row can
 * gain a match that did not already require the same words in the same order.
 */
export function packPatternSource(source: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) {
        out += ch;
        break;
      }
      // `\s` OUTSIDE a class is the word join this fix is about. Only the ATOM
      // is replaced; a quantifier after it is copied by the next iterations.
      out += !inClass && next === 's' ? PHRASE_JOIN.slice(0, -1) : ch + next;
      i += 1;
      continue;
    }
    if (!inClass && ch === '[') inClass = true;
    else if (inClass && ch === ']') inClass = false;
    else if (!inClass && ch === ' ') {
      out += PHRASE_JOIN.slice(0, -1);
      continue;
    }
    out += ch;
  }
  return out;
}

const PACK_PATTERN_CACHE = new Map<string, RegExp>();

/**
 * THE ONE COMPILER for a pack-authored regex source, so the separator class is
 * applied to every pattern list rather than to the lists someone remembered.
 * Cached by source+flags; `lastIndex` is reset because `g` makes it stateful.
 * A malformed pack row throws here exactly as it did when each check compiled
 * its own — callers that must survive one (the substantiation register) keep
 * their `try`.
 */
export function packPattern(source: string, flags: string): RegExp {
  const key = `${flags} ${source}`;
  let re = PACK_PATTERN_CACHE.get(key);
  if (!re) {
    re = new RegExp(packPatternSource(source), flags);
    if (PACK_PATTERN_CACHE.size >= MEMO_LIMIT) PACK_PATTERN_CACHE.clear();
    PACK_PATTERN_CACHE.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

const TERM_RE_CACHE = new Map<string, RegExp>();

/**
 * Word-boundary regex for a term, tolerating simple plural s/es and flexible
 * inner whitespace.
 *
 * THIS LEG DELIBERATELY DOES NOT USE `PHRASE_JOIN`, and the reason is a
 * DIRECTION, not an oversight. `termRegex`/`compileTerms` serve BOTH kinds of
 * question: "is this BANNED phrase present?" (where a wider join is stricter)
 * and "is this DECLARED keyword really on the surface it claims?" (C28's
 * placement leg, where a wider join is more PERMISSIVE — it would accept a
 * declaration the copy spells differently). One helper cannot widen in both
 * directions at once, so the ban side is covered where it is unambiguous: the
 * pack PATTERN leg (`packPatternSource`), the ban-lexicon alternations in the
 * individual checks, and the separator-STRIPPED variant scan, which is what
 * already caught the hyphenated spelling of a `superlativeBans` phrase.
 */
export function termRegex(term: string): RegExp {
  const cached = TERM_RE_CACHE.get(term);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  const escaped = term
    .trim()
    .replace(REGEX_META_RE, '\\$&')
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
    const key = canonicalKey(term);
    if (!canonical.has(key)) canonical.set(key, term);
  }
  // Whitespace only, NOT `PHRASE_JOIN` — see the direction argument on
  // `termRegex`: this compiler also answers PRESENCE questions.
  const source = cleaned
    .map((t) => t.replace(REGEX_META_RE, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  const compiled: CompiledTerms = {
    re: new RegExp(`${TERM_LEAD}(?:${source})(?:e?s)?${TERM_TRAIL}`, 'gi'),
    canonical,
  };
  ALTERNATION_CACHE.set(terms, compiled);
  return compiled;
}

/** The lookup key a phrase is filed under: lowercased, whitespace collapsed. */
const canonicalKey = (phrase: string): string => phrase.toLowerCase().replace(/\s+/g, ' ');

/** Map a matched string back onto the pack term that produced it. */
function canonicalTerm(match: string, canonical: Map<string, string>): string {
  const key = canonicalKey(match);
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
/**
 * NULL-SAFE array coercion.
 *
 * `(x ?? [])` guards `null`/`undefined` and NOTHING else: a field the model
 * emitted as an object or a string still reaches `.forEach` and throws, and a
 * thrown gate is a fail-OPEN in practice because the caller never receives
 * `verified:false` at all. Every surface builder and every exporter walks
 * LLM-shaped data, so they all go through this.
 */
export function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function tokenSet(text: string): Set<string> {
  const tokens = normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.replace(/'s$/, '').replace(/s$/, ''));
  return new Set(tokens.filter(Boolean));
}
