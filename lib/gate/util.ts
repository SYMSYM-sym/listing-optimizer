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
 * Latin-lookalike letters (Cyrillic / Greek) folded to their ASCII twin.
 *
 * Unicode NFKC does NOT touch these — `Fights cаncer` (Cyrillic а) is a
 * different string from `Fights cancer` as far as every scan is concerned, which
 * is exactly how a homoglyph payload walks past a banned-term list. This is a
 * SCRIPT-confusable table, not a domain lexicon: it holds no category words.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lowercase
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x',
  'і': 'i', 'ѕ': 's', 'у': 'y', 'ј': 'j', 'һ': 'h', 'ԁ': 'd',
  'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'к': 'k', 'м': 'm', 'т': 't',
  'н': 'n', 'в': 'b', 'г': 'r',
  // Cyrillic uppercase
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
  'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
  'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'З': '3',
  // Greek lowercase
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y', 'σ': 'o',
  // Greek uppercase
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I',
  'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
  'Υ': 'Y', 'Χ': 'X',
};

/** Zero-width / invisible formatting characters used to break up scanned words. */
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

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
 * strip, compatibility/confusable fold, collapse whitespace.
 *
 * The fold is what makes the scans homoglyph-proof: without it a Cyrillic
 * `а` or a zero-width space inside a banned word evades every check.
 */
export function normalize(text: string): string {
  let t = text.replace(INVISIBLE_RE, '');
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  t = foldCompatibility(t);
  return t
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—―−]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Separator-padded evasion (`c-a-n-c-e-r`, `d.i.a.b.e.t.e.s`, `c a n c e r`).
 *
 * ONLY runs of SINGLE letters joined by a single separator are collapsed, so
 * genuine hyphenated words (`5-HTP`, `L-theanine`, `third-party`, `Non-GMO`)
 * are left completely untouched. The result is scanned IN ADDITION to the
 * normal surface — it never replaces it.
 */
const PADDED_RUN_RE = /(?<![A-Za-z0-9])[A-Za-z](?:[-.·\s][A-Za-z])+(?![A-Za-z0-9])/g;

export function collapseSeparators(text: string): string {
  return text.replace(PADDED_RUN_RE, (run) => run.replace(/[-.·\s]/g, ''));
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
 * Tightened window for the disease-term path. Compliant supplement copy is full
 * of "No fillers", "Not a drug" — a cue 90 chars back was laundering real drug
 * claims, so a cue now has to sit right on top of the term to suppress it.
 */
const STRICT_WINDOW_CHARS = 28;
/** How far after a meta-phrase ("not intended to …") the term may still sit. */
const META_MAX_GAP_CHARS = 40;
const SENTENCE_BOUNDARY_RE = /[.;:!?]/;

export interface NegationOptions {
  /**
   * `legacy` — the original ~90-char proximity guard (A8, potency phrasing).
   * `strict` — clause-scoped + tight window + verb veto + pack meta-phrases.
   *            Used by the disease-term path (C6/A2).
   */
  mode?: 'legacy' | 'strict';
  /** Override the proximity window in characters. */
  windowChars?: number;
  /** Strict mode only: treat a comma as a clause break. */
  commaBreaks?: boolean;
  /**
   * Terms that VETO suppression when they appear between the negation cue and
   * the matched term — "No fillers … treats cancer" is a drug claim, not a
   * disclaimer. Pack data (`compliancePack.diseaseVerbs`).
   */
  blockingVerbs?: string[];
  /**
   * Pack-driven meta-phrases that genuinely negate ("not intended to …").
   * When the match sits inside (or immediately after) one of these, suppress.
   * Absent/empty ⇒ fall back to the tightened clause rule alone.
   */
  metaPhrases?: string[];
}

/** True when any of `terms` occurs in `text` on a word boundary. */
function containsTerm(text: string, terms: string[]): boolean {
  return terms.some((t) => t.trim() && termRegex(t).test(text));
}

/**
 * Meta-phrase suppression: the match is INSIDE a genuine meta-phrase span, or
 * sits just after one with no sentence break and no disease verb in between.
 */
function metaPhraseSuppresses(
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
      const end = start + phrase.length;
      from = start + 1;
      if (matchIndex >= start && matchIndex < end) return true; // inside the phrase
      if (end <= matchIndex && matchIndex - end <= META_MAX_GAP_CHARS) {
        const between = lower.slice(end, matchIndex);
        if (SENTENCE_BOUNDARY_RE.test(between)) continue;
        if (blockingVerbs.length > 0 && containsTerm(between, blockingVerbs)) continue;
        return true;
      }
    }
  }
  return false;
}

/**
 * True when the term at `matchIndex` is actually NEGATED by its context.
 *
 * Default (`legacy`) keeps the original ~90-char proximity rule. `strict` mode
 * requires the cue to negate THE TERM: same clause, tight window, no disease
 * verb in between — plus a pack-driven allowlist of real meta-phrases.
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
  if (metaPhrases.length > 0 && metaPhraseSuppresses(lower, matchIndex, metaPhrases, blockingVerbs)) {
    return true;
  }

  // (a) cut the preceding window at the nearest clause boundary
  const before = lower.slice(0, matchIndex);
  const boundaryRe = opts.commaBreaks ? /[.;:!?,]/g : /[.;:!?]/g;
  let clauseStart = 0;
  let bm: RegExpExecArray | null;
  while ((bm = boundaryRe.exec(before)) !== null) clauseStart = bm.index + 1;
  const windowStart = Math.max(clauseStart, matchIndex - (opts.windowChars ?? STRICT_WINDOW_CHARS));
  const preceding = lower.slice(windowStart, matchIndex);

  let cueEnd = -1;
  for (const cue of NEGATION_CUES) {
    const i = preceding.lastIndexOf(cue);
    if (i >= 0) cueEnd = Math.max(cueEnd, i + cue.length);
  }
  if (cueEnd < 0) return false;

  // (b) a disease verb between the cue and the term means the cue negates
  // something else entirely — never suppress.
  if (blockingVerbs.length > 0 && containsTerm(preceding.slice(cueEnd), blockingVerbs)) {
    return false;
  }
  return true;
}

/** Word-boundary regex for a term, tolerating simple plural s/es and flexible inner whitespace. */
export function termRegex(term: string): RegExp {
  const escaped = term
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${escaped}(?:e?s)?(?![a-z0-9])`, 'gi');
}

export interface TermMatch {
  term: string;
  index: number;
  context: string;
}

/** All non-negated matches of `terms` in `text` (text should be normalized first). */
export function scanTerms(text: string, terms: string[], neg: NegationOptions = {}): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const term of terms) {
    if (!term.trim()) continue;
    const re = termRegex(term);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!hasNegationContext(text, m.index, neg)) {
        matches.push({
          term,
          index: m.index,
          context: text.slice(Math.max(0, m.index - 40), m.index + term.length + 40),
        });
      }
    }
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
