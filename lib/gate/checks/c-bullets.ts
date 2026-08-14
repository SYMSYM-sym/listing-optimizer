import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { arr } from '../util';
import { fail } from './shared';

/**
 * C25 — CLAIM-MARKER DISCIPLINE on bullets (WS4).
 *
 * The generator returns each bullet with a `claimBearing` flag beside its
 * text, and the contract is that a claim-bearing bullet is emitted with the
 * trailing claim marker (`rules.style.claimMarker`, pack data) so the reader
 * can see which line the disclaimer belongs to. Nothing verified that the
 * emitted STRING actually kept the marker: the Zod refinement runs at the LLM
 * boundary, before deterministic assembly (`sanitizeBullets` truncates every
 * bullet), and the gate never saw the flags at all — so a bullet that lost its
 * marker between the model's JSON and the stored run was invisible.
 *
 * WHICH DIRECTION IS ENFORCED, and why only one.
 *
 *   ENFORCED — `claimBearing === true` implies the emitted bullet ENDS with
 *   the marker. This is the SAFE direction: the model has told us this line
 *   makes a structure/function claim, so the marker is owed. Failing it can
 *   only ever demand MORE disclosure than shipped.
 *
 *   NOT ENFORCED — marker implies `claimBearing`. A bullet that carries the
 *   marker while its flag says false is over-disclosure, and the flag is the
 *   model's own self-report: failing that direction would pressure the
 *   generator to DROP markers to make the gate green, which is the one outcome
 *   a compliance check must never incentivise. It is reported as an advisory
 *   P2 audit gap (`lib/audit/diff.ts`) instead.
 *
 * SCOPE. `bulletClaimBearing` is optional on the contract: a listing submitted
 * to the stateless audit route may carry no flags at all, and a check cannot
 * enforce a declaration that was never made. When the array is absent the
 * check has nothing to compare and returns nothing; `optimize()` always
 * populates it, and `tests/bulletArchitecture.test.ts` asserts that, so the
 * absence path cannot become the normal path unnoticed.
 */
export function c25BulletClaimMarker(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const marker = pack.rules?.style?.claimMarker?.trim();
  // Pack-driven: no marker declared, no rule. `REQUIRED_PACK_PIECES` ('rules.style')
  // raises a blocking PACK failure when it is missing, so this is never silent.
  if (!marker) return [];
  const flags = l.bulletClaimBearing;
  if (!Array.isArray(flags)) return [];
  const bullets = arr<unknown>(l.bullets);
  const out: Failure[] = [];
  bullets.forEach((raw, i) => {
    if (flags[i] !== true) return;
    // `String(...)`: malformed structural input (a numeric bullet) must be
    // reported, never thrown on.
    const text = String(raw ?? '').trimEnd();
    if (text.endsWith(marker)) return;
    out.push(
      fail(
        'C25',
        `bullets[${i}]`,
        text.slice(-60),
        `This bullet was generated as claim-bearing, so it must END with the claim marker '${marker}'. Either restore the marker or write the bullet so it makes no structure/function claim.`,
      ),
    );
  });
  return out;
}
