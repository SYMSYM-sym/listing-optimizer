import type { OptimizedListing } from '@/lib/types';
import { keywordSurfaceText } from '@/lib/gate/checks';
import { normalize, termRegex } from '@/lib/gate/util';

/**
 * Re-derive the SURFACE LIST of every `placed` keyword row from the emitted copy.
 *
 * `OptimizedListing.keywords[i].surfaces` is the generator's declaration about
 * where a term sits, and gate C28 holds the emitted strings to it. A test
 * helper that REWRITES a bullet, a Q&A block or an A+ FAQ is standing in for a
 * regeneration — and the engine regenerates the keyword reference in the same
 * repair round for exactly this reason (see the coupling note in
 * `lib/engine/repair.ts`). Leaving a stale declaration beside rewritten copy is
 * an artifact of the harness, and C28 would then fire in suites that are
 * testing something else entirely.
 *
 * SCOPE, deliberately narrow: only `placed` rows are touched, and only by
 * INTERSECTING their declared surfaces with the surfaces the term is actually
 * on. Nothing is added, no status is rewritten, and the `backend`, `negative`
 * and `candidate` rows are left exactly as they are — so a rewrite that puts a
 * negative term into copy, or leaks a backend-only term onto a visible
 * surface, still FAILS through this helper.
 *
 * C28's own coverage does NOT come through here — see
 * `tests/keywordPlacement.gate.test.ts`, which sets copy and declarations
 * independently in both directions.
 */
export function withCoherentKeywords(listing: OptimizedListing): OptimizedListing {
  if (!Array.isArray(listing.keywords)) return listing;
  listing.keywords = listing.keywords.flatMap((row) => {
    if (!row || row.status !== 'placed') return [row];
    const surfaces = (row.surfaces ?? []).filter((name) => {
      const text = keywordSurfaceText(listing, name);
      return text !== null && termRegex(row.term).test(normalize(text));
    });
    // A placed row with nothing left to point at is no longer a placement.
    return surfaces.length > 0 ? [{ ...row, surfaces }] : [];
  });
  return listing;
}
