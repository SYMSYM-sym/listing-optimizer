import type { KeywordCoverage, KeywordTerm, OptimizedListing } from '@/lib/types';

/**
 * WS3 — the KEYWORD COVERAGE summary carried in the audit payload.
 *
 * DERIVED, never asserted — twice over. Each row's `surfaces` was COMPUTED
 * from the finished copy by `lib/engine/keywordPlacement.ts` (the model is not
 * asked where its terms landed; it was wrong ~21 times per live run when it
 * was), and gate check C28 then re-verified the whole artifact against the
 * emitted strings independently. So this summary cannot show a placement the
 * gate did not confirm: if one were false, `verified` would be false and the
 * operator would be looking at a blocking banner rather than at this table.
 *
 * It exists because the artifact itself is a flat list of up to sixty rows,
 * and the four questions an operator actually asks of it — what am I
 * targeting, what is invisible-only, what must never appear, and how is the
 * demand behind a term I cannot write still reaching me — are each a filter
 * over that list.
 */
export function keywordCoverage(l: Pick<OptimizedListing, 'keywords'>): KeywordCoverage {
  const rows: KeywordTerm[] = Array.isArray(l.keywords) ? l.keywords : [];
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const key = String(r?.status ?? '(none)');
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const of = (status: string): KeywordTerm[] => rows.filter((r) => r?.status === status);
  return {
    total: rows.length,
    byStatus,
    placed: of('placed').map((r) => ({
      term: r.term,
      tier: r.tier,
      surfaces: [...(r.surfaces ?? [])],
      why: r.why ?? '',
    })),
    backendOnly: of('backend').map((r) => ({ term: r.term, why: r.why ?? '' })),
    negatives: of('negative').map((r) => ({ term: r.term, why: r.why ?? '' })),
    recaptured: of('captured-via').map((r) => ({ term: r.term, via: r.via ?? '', why: r.why ?? '' })),
    candidates: of('candidate').map((r) => ({
      term: r.term,
      home: r.home ?? '',
      why: r.why ?? '',
      // Present when derivation DOWNGRADED the row (the copy carries the term
      // nowhere) — a downgrade the operator must be able to see.
      ...(r.note ? { note: r.note } : {}),
    })),
    notTargeted: of('not-targeted').map((r) => ({ term: r.term, why: r.why ?? '' })),
  };
}
