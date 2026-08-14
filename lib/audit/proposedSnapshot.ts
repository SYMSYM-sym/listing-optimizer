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
/**
 * NULL-SAFE coercion at the boundary.
 *
 * The scorer used to read only a SCRAPED snapshot, whose fields the ingester
 * had already normalized to strings. It now also reads a GENERATED listing,
 * and a malformed generation (a `null` bullet, a numeric one) must produce a
 * low score and a gate failure — never a TypeError, which escapes `buildAudit`
 * and takes the whole request down. A thrown audit is a fail-OPEN in practice:
 * the caller never receives `verified:false` at all.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function proposedAsSnapshot(
  current: ListingSnapshot,
  proposed: OptimizedListing,
): ListingSnapshot {
  const a = proposed.aplusContent;
  const aplusText = [
    ...(Array.isArray(a?.modules) ? a.modules : []).map(
      (m) => `${str(m?.headline)} ${str(m?.body)} ${str(m?.subcopy)}`,
    ),
    ...(Array.isArray(a?.comparison?.rows) ? a.comparison.rows : []).map(
      (r) => `${str(r?.label)} ${str(r?.ours)} ${str(r?.typical)}`,
    ),
    ...(Array.isArray(a?.faq) ? a.faq : []).map((f) => `${str(f?.q)} ${str(f?.a)}`),
  ]
    .join(' \n ')
    .trim();
  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(
    proposed.attributes && typeof proposed.attributes === 'object' ? proposed.attributes : {},
  )) {
    attributes[k] = str(v);
  }
  return {
    ...current,
    title: str(proposed.title75) || str(proposed.title),
    bullets: (Array.isArray(proposed.bullets) ? proposed.bullets : []).map(str),
    description: str(proposed.description),
    attributes,
    raw: { ...(typeof current.raw === 'object' && current.raw !== null ? current.raw : {}), aplusText },
  };
}
