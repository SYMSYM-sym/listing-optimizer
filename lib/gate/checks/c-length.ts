import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize, tokenSet, utf8Bytes } from '../util';
import { fail } from './shared';

export function c1TitleLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return l.title.length <= pack.rules.titleMaxLegacy
    ? []
    : [fail('C1', 'title', `${l.title.length} chars`, `Shorten title to ≤${pack.rules.titleMaxLegacy} chars`)];
}

export function c2Bullets(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (l.bullets.length !== pack.rules.bulletCount) {
    out.push(fail('C2', 'bullets', `${l.bullets.length} bullets`, `Exactly ${pack.rules.bulletCount} bullets required`));
  }
  l.bullets.forEach((b, i) => {
    if (b.length > pack.rules.bulletMax) {
      out.push(fail('C2', `bullets[${i}]`, `${b.length} chars`, `Shorten bullet to ≤${pack.rules.bulletMax} chars`));
    }
  });
  return out;
}

export function c3BackendBytes(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const bytes = utf8Bytes(l.backendSearchTerms);
  return bytes <= pack.rules.backendMaxBytes
    ? []
    : [fail('C3', 'backendSearchTerms', `${bytes} UTF-8 bytes`, `Reduce to ≤${pack.rules.backendMaxBytes} bytes — exceeding de-indexes the whole field`)];
}

export function c4DescriptionLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return l.description.length <= pack.rules.descriptionMax
    ? []
    : [fail('C4', 'description', `${l.description.length} chars`, `Shorten description to ≤${pack.rules.descriptionMax} chars`)];
}

export function c15NewTitlePolicy(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (l.title75.length > pack.rules.title75Max) {
    out.push(fail('C15', 'title75', `${l.title75.length} chars`, `title75 must be ≤${pack.rules.title75Max} chars`));
  }
  if (!normalize(l.title75).startsWith(normalize(l.productName))) {
    out.push(fail('C15', 'title75', l.title75.slice(0, 60), 'title75 must start with the product name'));
  }
  if (l.itemHighlights.length > pack.rules.itemHighlightsMax) {
    out.push(fail('C15', 'itemHighlights', `${l.itemHighlights.length} chars`, `itemHighlights must be ≤${pack.rules.itemHighlightsMax} chars`));
  }
  return out;
}

/** C16 (quality, deterministic): backend terms must not repeat title-surface words. */
export function c16BackendDedup(l: OptimizedListing): Failure[] {
  const titleTokens = tokenSet(`${l.title} ${l.title75} ${l.itemHighlights}`);
  const backendTokens = tokenSet(l.backendSearchTerms);
  const overlap = [...backendTokens].filter((t) => titleTokens.has(t));
  return overlap.length === 0
    ? []
    : [fail('C16', 'backendSearchTerms', overlap.join(', '), 'Backend search terms must not repeat any title/title75/itemHighlights word — replace with synonyms/misspellings/other-language variants')];
}
