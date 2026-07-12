import { utf8Bytes } from '@/lib/shared/utf8Bytes';
import { tokenSet } from '@/lib/gate/util';

export interface TitleSurfaces {
  title: string;
  title75: string;
  itemHighlights: string;
}

/**
 * Deterministic backend cleanup (generation policy, not gate laundering):
 * drop tokens that collide with title surfaces (C16) and truncate to the
 * UTF-8 byte budget (C3). The gate still re-runs independently afterwards.
 */
export function sanitizeBackendSearchTerms(
  raw: string,
  surfaces: TitleSurfaces,
  maxBytes: number,
): string {
  const forbidden = tokenSet(`${surfaces.title} ${surfaces.title75} ${surfaces.itemHighlights}`);
  const kept = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((term) => {
      const stems = tokenSet(term);
      for (const s of stems) {
        if (forbidden.has(s)) return false;
      }
      return true;
    });

  let out = kept.join(' ');
  if (utf8Bytes(out) <= maxBytes) return out;

  // Word-boundary truncate to ≤ maxBytes UTF-8 (never mid-codepoint).
  const parts: string[] = [];
  for (const term of kept) {
    const candidate = parts.length === 0 ? term : `${parts.join(' ')} ${term}`;
    if (utf8Bytes(candidate) > maxBytes) break;
    parts.push(term);
  }
  return parts.join(' ');
}

/** Human-readable forbidden stem list for backend LLM prompts. */
export function forbiddenBackendStems(surfaces: TitleSurfaces): string[] {
  return [...tokenSet(`${surfaces.title} ${surfaces.title75} ${surfaces.itemHighlights}`)].sort();
}
