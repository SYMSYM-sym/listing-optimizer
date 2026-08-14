import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

/**
 * WS6 — project the PROPOSED listing into the shape the principle scorer reads.
 *
 * WHY THIS EXISTS. Until now only the CURRENT listing was scored, so a run
 * that came back `verified:true` displayed a number describing the listing the
 * operator was about to REPLACE. The obvious reading of "score: 55" beside a
 * green verify banner is "the new copy scores 55", which is not what it meant.
 * Scoring both sides with the SAME scorer is the fix; this module is the only
 * new code the fix needs.
 *
 * THE PROJECTION, and why each field is what it is:
 *
 *  - `title` is `title75`, NOT the ≤200 keyword-source title. `title75` is
 *    what actually publishes (policy eff. Jul 27 2026), and the current
 *    listing's `title` is likewise its published one — so this is the
 *    like-for-like comparison. Scoring the keyword-source title instead would
 *    grade a string the customer never sees.
 *  - `attributes` are the generated set, which is exactly what P4 measures.
 *  - `raw.aplusText` is the proposed A+ text flattened the same way the
 *    ingester flattens a scraped one, so P10 measures the same property on
 *    both sides.
 *  - `category`, `subcategory`, `price`, `rating`, `url`, `asin` and `images`
 *    are carried from the CURRENT snapshot unchanged: none of them is
 *    something this app proposes. P5 (browse-node depth) therefore scores the
 *    same on both sides, which is honest — the app can only ever suggest a
 *    node, and it says so on the sheet.
 *
 * It rewrites nothing and is used only for scoring.
 */
export function proposedAsSnapshot(
  current: ListingSnapshot,
  proposed: OptimizedListing,
): ListingSnapshot {
  const a = proposed.aplusContent;
  const aplusText = [
    ...(a?.modules ?? []).map((m) => `${m?.headline ?? ''} ${m?.body ?? ''} ${m?.subcopy ?? ''}`),
    ...(a?.comparison?.rows ?? []).map((r) => `${r?.label ?? ''} ${r?.ours ?? ''} ${r?.typical ?? ''}`),
    ...(a?.faq ?? []).map((f) => `${f?.q ?? ''} ${f?.a ?? ''}`),
  ]
    .join(' \n ')
    .trim();
  return {
    ...current,
    title: proposed.title75 || proposed.title || '',
    bullets: [...(proposed.bullets ?? [])],
    description: proposed.description ?? '',
    attributes: { ...(proposed.attributes ?? {}) },
    raw: { ...(typeof current.raw === 'object' && current.raw !== null ? current.raw : {}), aplusText },
  };
}
