import type {
  CompetitorBenchmark,
  CompetitorBenchmarkRow,
  CompetitorIngestion,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';

/**
 * WS9 — the COMPETITOR BENCHMARK (playbook Phase 4).
 *
 * WHAT IT IS. Four structural facts about each rival's live listing, measured
 * the same way on every row including our own proposal: how long the title is,
 * how many bullets they use, how many structured attributes they fill, and
 * whether they run A+ at all. That is the attribute-level comparison the
 * playbook's Phase 4 is for, and it is deliberately the part that can be
 * MEASURED rather than judged.
 *
 * WHAT IT IS NOT, and why. It carries no rival copy, no rival phrasing and no
 * rival brand name beyond the ASIN the operator typed. Two reasons, both hard:
 * a rival's non-compliant framing is takedown risk to copy and never
 * inspiration, and their brand name is exactly what the keyword reference puts
 * on the NEGATIVE list (R50). A benchmark that quoted their copy would be a
 * feature that hands an operator the two things they must not use.
 *
 * DEGRADES GRACEFULLY BY CONSTRUCTION. Ingestion of someone else's ASIN fails
 * routinely — blocked, rate-limited, retired listing. A failed row is RENDERED
 * as failed, with its reason, and it never affects `verified`: the benchmark is
 * advisory in the strictest sense, because it is a fact about a page we do not
 * control.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** True when the provider payload shows A+ content on the page. */
function hasAplus(snapshot: ListingSnapshot): boolean {
  const raw = snapshot.raw as { aplusText?: unknown } | null;
  return str(raw?.aplusText).trim().length > 0;
}

function rowFor(asin: string, snapshot: ListingSnapshot): CompetitorBenchmarkRow {
  return {
    asin,
    status: 'ok',
    titleLength: str(snapshot.title).length,
    bulletCount: Array.isArray(snapshot.bullets) ? snapshot.bullets.length : 0,
    attributeCount: Object.keys(snapshot.attributes ?? {}).length,
    aplusPresent: hasAplus(snapshot),
  };
}

/**
 * Build the benchmark. `competitors` carries one entry per ASIN the operator
 * asked for, each either ingested or carrying the reason it was not.
 */
export function buildBenchmark(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  competitors: CompetitorIngestion[] | undefined,
): CompetitorBenchmark | undefined {
  if (!Array.isArray(competitors) || competitors.length === 0) return undefined;

  const rows: CompetitorBenchmarkRow[] = competitors.map((c) => {
    if (!c?.snapshot) {
      return {
        asin: str(c?.asin) || '(unknown)',
        status: 'failed',
        note: str(c?.error) || 'Ingestion failed — nothing was measured for this ASIN.',
      };
    }
    return rowFor(str(c.asin) || c.snapshot.asin, c.snapshot);
  });

  return {
    // OUR row is measured the same way, from the PROPOSED listing (title75 is
    // what publishes) so the comparison is like for like.
    subject: {
      asin: current.asin,
      status: 'ok',
      titleLength: str(proposed.title75).length || str(proposed.title).length,
      bulletCount: Array.isArray(proposed.bullets) ? proposed.bullets.length : 0,
      attributeCount: Object.keys(proposed.attributes ?? {}).length,
      aplusPresent: (proposed.aplusContent?.modules ?? []).length > 0,
    },
    // The CURRENT listing too: the benchmark is only useful next to where we
    // are starting from.
    current: rowFor(current.asin, current),
    rows,
    requested: competitors.length,
    ingested: rows.filter((r) => r.status === 'ok').length,
  };
}
