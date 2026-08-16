import { identityKey } from '@/lib/engine/keywordPlacement';
import type {
  BrandFieldDisagreement,
  BrandParityAdvisory,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';

export type { BrandFieldDisagreement, BrandParityAdvisory };

/**
 * N3 — SNAPSHOT-FIDELITY FOR BRAND IDENTITY. **ADVISORY, never a gate failure.**
 *
 * ===========================================================================
 * THE GAP THIS FILLS
 * ===========================================================================
 * `runGate` never receives the source snapshot. Every identity check it runs is
 * therefore INTERNAL-CONSISTENCY only:
 *
 *   - C7  brand leakage        — backend strings vs the customer surfaces
 *   - C8/C15 product-name lead — the titles vs `productName`
 *   - A3/A4 A+ brand/name      — the A+ copy vs `productName`
 *
 * A meta review confirmed the consequence, and it is a real one: tamper with a
 * SINGLE field and those checks catch it, because the listing then disagrees
 * with ITSELF. Rename the product CONSISTENTLY — `brand_name`, `manufacturer`,
 * `productName`, every title, every A+ module — and the listing is perfectly
 * self-consistent, so **nothing in the gate objects**. The only thing that could
 * object is the scraped page, and the gate cannot see it.
 *
 * ===========================================================================
 * WHY IT IS ADVISORY AND NOT A CHECK — this is the whole design decision
 * ===========================================================================
 * A brand-name CORRECTION is a legitimate, common use case. Sellers ingest a
 * page whose `brand_name` attribute is wrong, stale, mis-cased, missing a legal
 * suffix, or carries a marketplace's own mangling of it; re-branding and
 * acquisitions happen; an operator running the optimizer on a listing they are
 * about to fix is exactly the intended user. Failing the run would make that
 * user's job impossible and would be **unwinnable** — no amount of regeneration
 * clears a disagreement that the operator INTENDED.
 *
 * Over-blocking is treated in this project as exactly as severe as a bypass. So
 * this states the disagreement and asks the operator to CONFIRM it. It is one
 * P1 gap: high enough that nobody scrolls past it, non-blocking so a legitimate
 * correction still ships.
 *
 * ===========================================================================
 * THE BOUNDS
 * ===========================================================================
 *  1. STRUCTURAL BRAND FIELDS ONLY (`brand_name`, `manufacturer`) — the same two
 *     keys `ownBrandIdentity`, `rivalBrandNames` and C7 read. The TITLE is
 *     deliberately not mined: guessing where a brand ends inside a title is the
 *     unreliable step, and this is a report an operator reads, so a noisy one is
 *     a report nobody reads.
 *  2. A FIELD THE SNAPSHOT DOES NOT CARRY IS NOT A DISAGREEMENT. Many scraped
 *     pages have no `manufacturer` at all. There is nothing to compare, so
 *     nothing is said — silence here is correct, not a miss.
 *  3. A BLANK PROPOSED VALUE IS NOT A DISAGREEMENT EITHER. "Missing" is a
 *     different statement from "different", and C23 already owns the blank
 *     (required + filter-facet fields hard-fail the gate). Reporting it twice,
 *     in two different vocabularies, is how an operator learns to skim.
 *  4. EQUALITY IS THE APP'S ONE DEFINITION OF BRAND EQUALITY — `identityKey`,
 *     the same normalisation the own-brand identity and the rival-brand set
 *     match on. So `BrandX Labs, LLC.` and `brandx labs llc` agree here exactly
 *     as they agree there, and the three cannot drift apart.
 *  5. EXACTLY ONE GAP, whatever disagrees. Two fields renamed together is ONE
 *     event — a rename — not two findings.
 *
 * It holds NO domain vocabulary: two structural marketplace field names and no
 * category lexicon (`tests/category.literals.test.ts`).
 */

/**
 * The two structural brand fields, and only those (bound 1). The tuple type is
 * pinned against `BrandFieldDisagreement['field']` in `lib/types.ts`, so the
 * shipped payload shape and this list cannot drift apart.
 */
const BRAND_FIELDS: readonly BrandFieldDisagreement['field'][] = ['brand_name', 'manufacturer'];

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Compare the proposed listing's brand identity against the SCRAPED snapshot.
 *
 * Returns `null` when they agree, when the snapshot carries neither field, or
 * when the proposed listing leaves the field blank (see bounds 2 and 3). Never
 * throws: every accessor is null-safe, because an advisory that can take the
 * audit down is worse than no advisory.
 */
export function brandParity(
  current: ListingSnapshot | null | undefined,
  proposed: OptimizedListing | null | undefined,
): BrandParityAdvisory | null {
  const scrapedAttrs = current?.attributes ?? {};
  const proposedAttrs = proposed?.attributes ?? {};

  const disagreements: BrandFieldDisagreement[] = [];
  for (const field of BRAND_FIELDS) {
    const scraped = str(scrapedAttrs[field]).trim();
    const proposedValue = str(proposedAttrs[field]).trim();
    if (!scraped) continue; // bound 2 — nothing to compare against
    if (!proposedValue) continue; // bound 3 — C23 owns the blank
    if (identityKey(scraped) === identityKey(proposedValue)) continue; // bound 4
    disagreements.push({ field, scraped, proposed: proposedValue });
  }
  if (disagreements.length === 0) return null;

  // Bound 5 — one event, one note, however many fields moved.
  const detail = disagreements
    .map((d) => `${d.field}: scraped '${d.scraped}' -> proposed '${d.proposed}'`)
    .join('; ');
  return {
    disagreements,
    note:
      `The proposed listing's brand identity does not match the page it was scraped from (${detail}). ` +
      'CONFIRM this before publishing. The gate cannot decide it for you: it never sees the source page, ' +
      'so a consistent rename across every field is invisible to every check. ' +
      'If you are correcting the brand on purpose this is expected and you may ship it; ' +
      'if you did not intend it, you are about to publish someone else\'s brand.',
  };
}
