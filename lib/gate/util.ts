/**
 * Gate utilities — pure, dependency-free, unit-tested.
 */

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

/** Curly→straight quotes, en/em dash→hyphen, entity decode, collapse whitespace. */
export function normalize(text: string): string {
  let t = text;
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  return t
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
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
  'cannot',
  'must not',
  'prohibited',
];

/** True when ~90 preceding chars contain a negation cue (term prohibits itself). */
export function hasNegationContext(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - 90);
  const preceding = text.slice(windowStart, matchIndex).toLowerCase();
  return NEGATION_CUES.some((cue) => preceding.includes(cue));
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
export function scanTerms(text: string, terms: string[]): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const term of terms) {
    if (!term.trim()) continue;
    const re = termRegex(term);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!hasNegationContext(text, m.index)) {
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
