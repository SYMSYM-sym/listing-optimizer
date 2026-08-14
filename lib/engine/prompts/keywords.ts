import type { KeywordRules, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { demandRecaptureBlock, keywordVocabularyBlock, snapshotBlock } from './shared';

/**
 * WS3 — the KEYWORD REFERENCE prompt (playbook Phase 7).
 *
 * WHY IT RUNS LAST (phase 3, after every copy group). The reference declares
 * WHERE each term sits, and gate C28 verifies every one of those declarations
 * against the emitted strings. A declaration written BEFORE the copy exists
 * could only ever be a guess — exactly the hand-written "all placed"
 * checkmarks the playbook names as the pattern that failed nine times. So the
 * model is shown the FINISHED surfaces and asked to READ them; the gate then
 * independently verifies the reading. Worker != checker, one more time.
 *
 * QUALITATIVE BY MANDATE. The playbook forbids search-volume tools, and this
 * system calls none: a term earns its tier from evidence that can be pointed
 * at, never from a number an API returned. The instruction says so explicitly
 * so the model does not invent one.
 */
export interface KeywordSurfacesView {
  title: string;
  title75: string;
  itemHighlights: string;
  bullets: string[];
  description: string;
  backendSearchTerms: string;
  attributes: Record<string, string>;
}

export function keywordSurfacesOf(l: {
  title: string;
  title75: string;
  itemHighlights: string;
  bullets: string[];
  description: string;
  backendSearchTerms: string;
  attributes: Record<string, string>;
}): KeywordSurfacesView {
  return {
    title: l.title,
    title75: l.title75,
    itemHighlights: l.itemHighlights,
    bullets: l.bullets,
    description: l.description,
    backendSearchTerms: l.backendSearchTerms,
    attributes: l.attributes,
  };
}

/** The A+/FAQ/Q&A text a term may also be declared on. */
function extraSurfaces(l: Partial<OptimizedListing>): string {
  const a = l.aplusContent;
  const aplus = (a?.modules ?? [])
    .map((m) => `${m.headline} ${m.body}${m.subcopy ? ` ${m.subcopy}` : ''}`)
    .join(' | ');
  const faq = (a?.faq ?? []).map((f) => `${f.q} ${f.a}`).join(' | ');
  const qa = (l.qa ?? []).map((f) => `${f.q} ${f.a}`).join(' | ');
  const lines: string[] = [];
  if (aplus.trim()) lines.push(`aplus: ${aplus.slice(0, 1600)}`);
  if (faq.trim()) lines.push(`faq: ${faq.slice(0, 1200)}`);
  if (qa.trim()) lines.push(`qa: ${qa.slice(0, 1200)}`);
  return lines.join('\n');
}

export function keywordsPrompt(
  snapshot: ListingSnapshot,
  emitted: KeywordSurfacesView & Partial<OptimizedListing>,
  kr: KeywordRules | undefined,
): string {
  const vocabulary = keywordVocabularyBlock(kr);
  const recapture = demandRecaptureBlock(kr);
  // D1 — the artifact is a LIST, and a list with no stated end is what ran the
  // group into the output-token ceiling on every live run (truncated JSON, then
  // a truncated retry, then a 502). Both caps are pack data and BOTH are stated
  // here, because the schema that enforces them and the budget that pays for
  // them are computed from the same two numbers.
  const budget =
    typeof kr?.maxTerms === 'number' && kr.maxTerms > 0
      ? `- SIZE: at most ${kr.maxTerms} rows in total, across every status. This is a hard limit — a reference that runs past it is cut off mid-row and cannot be read at all.`
      : '';
  const whyLimit =
    typeof kr?.whyMaxChars === 'number' && kr.whyMaxChars > 0
      ? `, at most ${kr.whyMaxChars} characters`
      : '';
  const surfaces = [
    'THE FINISHED COPY (read it — every placement you declare is machine-verified against these exact strings):',
    `title: ${emitted.title}`,
    `title75: ${emitted.title75}`,
    `itemHighlights: ${emitted.itemHighlights}`,
    ...(emitted.bullets ?? []).map((b, i) => `bullet${i + 1}: ${b}`),
    `description: ${(emitted.description ?? '').slice(0, 1800)}`,
    `backend: ${emitted.backendSearchTerms}`,
    `attributes: ${JSON.stringify(emitted.attributes ?? {}).slice(0, 1600)}`,
    extraSurfaces(emitted),
  ]
    .filter((s) => s.trim() !== '')
    .join('\n');

  return `${snapshotBlock(snapshot)}

${surfaces}

${vocabulary}

TASK: The keyword reference for this listing — one row per term.

${budget}
${recapture}
- QUALITATIVE ONLY. Never cite, invent or imply a search-volume figure: a row earns its tier from evidence you can point at (what the category leaders lead with, what the label states, what a shopper would type), never from a number.
- Read the finished copy above and declare the truth about it. A row whose declared surfaces do not match the strings above is a hard failure, so declare only what you can see.
- Use the surface names from the vocabulary above, exactly as written.
- "why" is required on every row: ONE short sentence of evidence${whyLimit}. It is evidence, not an essay.
- A row that says a rival's brand name, or any term the compliance rules above forbid, belongs on the negative list. Every negative row states its reason in "why".
- Cover the listing properly WITHIN THAT BUDGET: the head terms, the named entities, the qualifier and trust terms, the buyer-language phrases, the invisible-only variants, and the terms this listing deliberately leaves alone. Spend the rows on the terms that decide the listing; a near-duplicate of a row you have already written earns nothing.

Return JSON: { "keywords": [{ "term", "tier", "status", "surfaces": [], "why", "via", "home" } ...] }
"via" is required for recaptured demand; "home" is required for a future-cycle row; both are omitted elsewhere. "surfaces" is [] for rows that sit on none.`;
}
