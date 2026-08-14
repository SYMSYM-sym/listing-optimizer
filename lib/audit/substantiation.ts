import type {
  CompliancePack,
  ListingSnapshot,
  OptimizedListing,
  SubstantiationClaim,
} from '@/lib/types';
import { aplusSurfaces, customerSurfaces } from '@/lib/gate/checks/shared';
import { normalize } from '@/lib/gate/util';

/**
 * R33/R38 — THE SUBSTANTIATION REGISTER.
 *
 * Every other check in this project asks "is this phrasing allowed?". This one
 * asks the question the marketplace actually asks: CAN YOU PROVE IT? A
 * certification, an origin statement, a testing claim or a units-sold figure is
 * lawful phrasing and unlawful marketing at the same time — the difference is
 * an artifact in the seller's filing cabinet, which no app can see.
 *
 * So the register never fails a run. It ENUMERATES: every claim the generated
 * listing makes, the surfaces it makes it on, and — the part that matters —
 * whether the SOURCE listing was already making it.
 *
 * ECHO-ONLY IS THE WHOLE POINT. A generator writing plausible trust copy will
 * happily add "Made in USA" to a listing that never said it: the phrase fits
 * the category, the tone and the gap in the bullet. Nothing in the copy marks
 * it as invented. Comparing against the SOURCE SNAPSHOT is the only signal
 * available: a claim present in the source is one the seller was already
 * publishing (`HELD` — confirm it), and a claim that appears only in the
 * generated copy is one this run introduced (`PENDING` — evidence it or cut
 * it).
 *
 * The token list is PACK DATA (`compliancePack.substantiationTokens`).
 */

/** Everything a shopper can see in the SOURCE listing. */
function snapshotText(current: ListingSnapshot): string {
  const raw = current.raw as { aplusText?: string } | null | undefined;
  return normalize(
    [
      current.title ?? '',
      ...(current.bullets ?? []),
      current.description ?? '',
      ...Object.values(current.attributes ?? {}),
      raw?.aplusText ?? '',
    ].join(' \n '),
  ).toLowerCase();
}

export function buildSubstantiationRegister(
  proposed: OptimizedListing,
  current: ListingSnapshot,
  cp: CompliancePack | null | undefined,
): SubstantiationClaim[] {
  const rows = (cp?.substantiationTokens ?? []).filter(
    (row) => Array.isArray(row) && String(row[0] ?? '').trim() !== '',
  );
  if (rows.length === 0) return [];
  const source = snapshotText(current);
  // Attribute values are deliberately included: a certification parked in an
  // attribute publishes exactly as loudly as one in a bullet.
  const surfaces: [string, string][] = [
    ...customerSurfaces(proposed),
    ...aplusSurfaces(proposed.aplusContent),
    ...Object.entries(proposed.attributes ?? {}).map(
      ([k, v]) => [`attributes.${k}`, String(v ?? '')] as [string, string],
    ),
  ];

  const out: SubstantiationClaim[] = [];
  for (const row of rows) {
    const [pattern, display] = [String(row[0]), String(row[1] ?? row[0])];
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue; // a malformed pack row must not break the audit
    }
    const hits = surfaces
      .filter(([, text]) => text.trim() !== '' && re.test(normalize(text)))
      .map(([field]) => field);
    if (hits.length === 0) continue;
    const evidenced = re.test(source);
    out.push({
      claim: display,
      // One row per CLAIM, not per surface: the operator signs off on the
      // claim once and needs to see everywhere it would publish.
      surface: hits.join(', '),
      status: evidenced ? 'HELD' : 'PENDING',
      note: evidenced
        ? 'echoed from the source listing — confirm the artifact is still on file'
        : 'not evidenced in source listing — name the artifact behind it or remove the claim before publishing',
    });
  }
  return out;
}

/**
 * The HEADER surfaces an UNEVIDENCED claim must stay off (title, published
 * title, Item Highlights).
 *
 * Header fields are what a moderator reads first and what every downstream
 * surface quotes, so an invented certification there is the one that travels.
 * Reported as a P1 audit gap by `lib/audit/diff.ts`; the prompt tells the
 * generator the same thing (`promptRules.title`).
 */
export const HEADER_SURFACES = ['title', 'title75', 'itemHighlights'];

export function unevidencedHeaderClaims(register: SubstantiationClaim[]): SubstantiationClaim[] {
  return register.filter(
    (r) =>
      r.status === 'PENDING' &&
      r.surface.split(',').some((s) => HEADER_SURFACES.includes(s.trim())),
  );
}
