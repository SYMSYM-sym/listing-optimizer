/**
 * WS4 — the TAGS that mark a bullet-architecture lint.
 *
 * The lints are AUDIT GAPS, not gate failures (see `lib/audit/bulletLints.ts`
 * for why), so they travel in the same `audit.gaps` array as every other gap.
 * The results panel renders them as their own advisory section, which means
 * both sides need one agreed answer to "is this gap a bullet-architecture
 * lint?".
 *
 * This module is that answer, and it lives in `lib/shared` — imported by the
 * audit module AND by a client component, so it must stay free of server
 * imports. The producer builds its `why` strings FROM these constants and the
 * consumer partitions on them, so the two cannot drift apart silently;
 * `tests/bulletArchitecture.test.ts` asserts every produced lint is recognised
 * and that no other gap is.
 */
export const BULLET_LINT_TAGS = {
  /** A declared slot job that is empty or does not read as filled. */
  slot: 'Bullet architecture:',
  /** AM-3 — the allergen declaration opens the bullet instead of closing it. */
  allergenPosition: 'AM-3:',
  /** A claim marker on a bullet that was not generated as claim-bearing. */
  claimMarker: 'Claim-marker discipline:',
} as const;

export const BULLET_LINT_PREFIXES: readonly string[] = Object.values(BULLET_LINT_TAGS);

/** True when this audit gap came from the bullet-architecture lints. */
export function isBulletArchitectureGap(gap: { why?: unknown }): boolean {
  const why = typeof gap?.why === 'string' ? gap.why : '';
  return BULLET_LINT_PREFIXES.some((prefix) => why.startsWith(prefix));
}
