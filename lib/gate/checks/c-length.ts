import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { arr, normalize, tokenSet, utf8Bytes } from '../util';
import { fail } from './shared';

/**
 * Stemmed lowercase content tokens of a title, minus the pack's stopwords.
 * Exported for the repetition test; holds no lexicon of its own.
 */
export function titleContentTokens(title: string, stopwords: string[]): string[] {
  const stop = new Set(stopwords.map((w) => w.toLowerCase()));
  return normalize(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w.length > 1 && !stop.has(w))
    .map((w) => w.replace(/'s$/, '').replace(/s$/, ''))
    .filter(Boolean);
}

/**
 * C1 — title length PLUS the pack's title word-repetition rule.
 *
 * `rules.titleWordRepetition` documents "no word appears more than 2x in the
 * title" but nothing enforced it, so a keyword-stuffed title passed the gate.
 * Limit and stopwords are PACK DATA.
 */
export function c1TitleLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (!normalize(l.title ?? '')) {
    out.push(fail('C1', 'title', '(empty)', 'Title is empty — a blank surface can never be verified'));
  }
  if ((l.title ?? '').length > pack.rules.titleMaxLegacy) {
    out.push(fail('C1', 'title', `${(l.title ?? '').length} chars`, `Shorten title to ≤${pack.rules.titleMaxLegacy} chars`));
  }
  const repetition = pack.rules.titleWordRepetition;
  if (repetition && repetition.max > 0) {
    const counts = new Map<string, number>();
    for (const token of titleContentTokens(l.title, repetition.stopwords ?? [])) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const over = [...counts.entries()].filter(([, n]) => n > repetition.max);
    for (const [word, n] of over) {
      out.push(
        fail(
          'C1',
          'title',
          `'${word}' x${n}`,
          `No word may appear more than ${repetition.max}x in the title — replace the repeats of '${word}' with distinct keywords`,
        ),
      );
    }
  }
  return out;
}

/**
 * C2 — bullet count, length AND structural validity.
 *
 * STRUCTURE is checked because the count/length rules alone accepted a
 * "5 bullets" listing that was really 2: an empty string, a whitespace-only
 * string, a bullet consisting only of the claim marker, a `null`, and a
 * duplicate of another bullet all counted as content. Each of those ships an
 * empty or repeated bullet slot to the customer, so each is a failure now.
 * The comparison for duplicates is done on NORMALIZED, case-folded text, so
 * re-casing or re-spacing a bullet does not launder the repeat.
 */
export function c2Bullets(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  // Array.isArray, not `?? []`: a `bullets` field the model emitted as a
  // string or an object must FAIL, never throw (a thrown gate is a fail-OPEN).
  const bullets = arr<unknown>(l.bullets);
  if (!Array.isArray(l.bullets)) {
    out.push(fail('C2', 'bullets', '(not a list)', 'The bullet block is not a list of strings — the contract requires exactly five'));
  }
  if (bullets.length !== pack.rules.bulletCount) {
    out.push(fail('C2', 'bullets', `${bullets.length} bullets`, `Exactly ${pack.rules.bulletCount} bullets required`));
  }
  const seen = new Map<string, number>();
  bullets.forEach((raw, i) => {
    const b = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    if (b.length > pack.rules.bulletMax) {
      out.push(fail('C2', `bullets[${i}]`, `${b.length} chars`, `Shorten bullet to ≤${pack.rules.bulletMax} chars`));
    }
    const text = normalize(b);
    if (!text) {
      out.push(fail('C2', `bullets[${i}]`, '(empty)', 'Bullet is empty or whitespace-only — write real copy or remove the slot'));
      return;
    }
    // A LETTER is required, not merely an alphanumeric: `"*"`, `"---"` and a
    // bare `42` are all empty bullet slots as far as a customer is concerned.
    if (!/[a-z]/i.test(text)) {
      out.push(
        fail(
          'C2',
          `bullets[${i}]`,
          text.slice(0, 40),
          'Bullet has no words (markers, punctuation or digits only) — write real copy or remove the slot',
        ),
      );
      return;
    }
    const key = text.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      out.push(
        fail(
          'C2',
          `bullets[${i}]`,
          text.slice(0, 60),
          `Bullet duplicates bullets[${first}] — every bullet must cover a distinct use case`,
        ),
      );
      return;
    }
    seen.set(key, i);
  });
  return out;
}

export function c3BackendBytes(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const terms = l.backendSearchTerms ?? '';
  // An EMPTY backend field is not "compliant", it is an unfilled deliverable —
  // it used to pass silently because only the upper byte bound was checked.
  if (!normalize(terms)) {
    out.push(fail('C3', 'backendSearchTerms', '(empty)', 'Backend search terms are empty — fill the field with synonyms/misspellings/other-language variants'));
    return out;
  }
  const bytes = utf8Bytes(terms);
  if (bytes > pack.rules.backendMaxBytes) {
    out.push(fail('C3', 'backendSearchTerms', `${bytes} UTF-8 bytes`, `Reduce to ≤${pack.rules.backendMaxBytes} bytes — exceeding de-indexes the whole field`));
  }
  return out;
}

export function c4DescriptionLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const description = l.description ?? '';
  const out: Failure[] = [];
  if (!normalize(description)) {
    out.push(fail('C4', 'description', '(empty)', 'Description is empty — a blank surface can never be verified'));
  }
  if (description.length > pack.rules.descriptionMax) {
    out.push(fail('C4', 'description', `${description.length} chars`, `Shorten description to ≤${pack.rules.descriptionMax} chars`));
  }
  return out;
}

export function c15NewTitlePolicy(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const title75 = l.title75 ?? '';
  const itemHighlights = l.itemHighlights ?? '';
  if (!normalize(title75)) {
    out.push(fail('C15', 'title75', '(empty)', 'title75 is empty — a blank surface can never be verified'));
  }
  if (title75.length > pack.rules.title75Max) {
    out.push(fail('C15', 'title75', `${title75.length} chars`, `title75 must be ≤${pack.rules.title75Max} chars`));
  }
  if (!normalize(title75).startsWith(normalize(l.productName ?? ''))) {
    out.push(fail('C15', 'title75', title75.slice(0, 60), 'title75 must start with the product name'));
  }
  if (!normalize(itemHighlights)) {
    out.push(fail('C15', 'itemHighlights', '(empty)', 'itemHighlights is empty — a blank surface can never be verified'));
  }
  if (itemHighlights.length > pack.rules.itemHighlightsMax) {
    out.push(fail('C15', 'itemHighlights', `${itemHighlights.length} chars`, `itemHighlights must be ≤${pack.rules.itemHighlightsMax} chars`));
  }
  return out;
}

/** C16 (quality, deterministic): backend terms must not repeat title-surface words. */
export function c16BackendDedup(l: OptimizedListing): Failure[] {
  const titleTokens = tokenSet(`${l.title ?? ''} ${l.title75 ?? ''} ${l.itemHighlights ?? ''}`);
  const backendTokens = tokenSet(l.backendSearchTerms ?? '');
  const overlap = [...backendTokens].filter((t) => titleTokens.has(t));
  return overlap.length === 0
    ? []
    : [fail('C16', 'backendSearchTerms', overlap.join(', '), 'Backend search terms must not repeat any title/title75/itemHighlights word — replace with synonyms/misspellings/other-language variants')];
}
