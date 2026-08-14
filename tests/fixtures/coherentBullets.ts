import type { OptimizedListing } from '@/lib/types';

/**
 * Re-derive the PARALLEL claim-bearing flags from the emitted bullet text.
 *
 * `OptimizedListing.bulletClaimBearing[i]` is the generator's declaration about
 * `bullets[i]`, and gate C25 holds the emitted string to it. A test helper that
 * REWRITES a bullet is standing in for a regeneration, so it must produce a
 * coherent listing: leaving the old flag beside new text is a stale-flag
 * artifact of the harness, and C25 would then fire on every rewritten bullet in
 * suites that are testing something else entirely.
 *
 * The derivation is exactly the one the engine already uses when the repair
 * loop rebuilds the bullets group from a stored base
 * (`lib/engine/optimize.ts`): the flag is read off the trailing claim marker.
 *
 * C25's own coverage does NOT come through this helper — see
 * `tests/bulletArchitecture.test.ts`, which sets text and flags independently
 * in both directions.
 */
export function withCoherentBulletFlags(listing: OptimizedListing): OptimizedListing {
  if (!Array.isArray(listing.bulletClaimBearing)) return listing;
  // `String(...)` because the malformed-input suites deliberately push
  // non-strings through this path and the gate must never throw.
  listing.bulletClaimBearing = (listing.bullets ?? []).map((b) =>
    String(b ?? '').trimEnd().endsWith('*'),
  );
  return listing;
}
