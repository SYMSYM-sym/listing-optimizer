import type { Audit, OptimizedListing } from '@/lib/types';

/**
 * Pure Markdown export builder — used by the UI download and the golden test.
 * Export-final semantics are enforced by the CALLER (disabled when
 * audit.verified is false); this builder labels the state honestly.
 */
export function toMarkdown(listing: OptimizedListing, audit: Audit): string {
  const lines: string[] = [];
  const status = audit.verified
    ? '✅ VERIFIED — all gate checks passed'
    : `⛔ NOT VERIFIED — ${audit.gateResult.failures.length} blocking gate failure(s); do not publish`;
  lines.push(`# Optimized Listing — ${listing.productName}`);
  lines.push('');
  lines.push(`> ${status}`);
  lines.push('');
  lines.push('## Title (legacy ≤200)');
  lines.push(listing.title);
  lines.push('');
  lines.push('## Title 75 (policy eff. Jul 27 2026)');
  lines.push(listing.title75);
  lines.push('');
  lines.push('## Item Highlights (≤125, searchable)');
  lines.push(listing.itemHighlights);
  lines.push('');
  lines.push('## Bullets');
  listing.bullets.forEach((b, i) => lines.push(`${i + 1}. ${b}`));
  lines.push('');
  lines.push('## Description');
  lines.push(listing.description);
  lines.push('');
  lines.push('## Backend Search Terms (≤249 UTF-8 bytes)');
  lines.push('```');
  lines.push(listing.backendSearchTerms);
  lines.push('```');
  lines.push('');
  lines.push('## Attributes');
  for (const [k, v] of Object.entries(listing.attributes)) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push('');
  lines.push('## A+ Content');
  for (const m of listing.aplusContent.modules) {
    lines.push(`### [${m.id}] ${m.headline}${m.claimBearing ? ' *(claim-bearing)*' : ''}`);
    lines.push(m.body);
    if (m.subcopy) lines.push(`_${m.subcopy}_`);
    lines.push('');
  }
  lines.push('### Comparison');
  lines.push('| | Ours | Typical |');
  lines.push('|---|---|---|');
  for (const r of listing.aplusContent.comparison.rows) {
    lines.push(`| ${r.label} | ${r.ours} | ${r.typical} |`);
  }
  lines.push('');
  lines.push('### A+ FAQ');
  for (const f of listing.aplusContent.faq) {
    lines.push(`- **Q: ${f.q}**`);
    lines.push(`  A: ${f.a}`);
  }
  lines.push('');
  lines.push('## Image / Slot Plan');
  for (const s of listing.imagePlan) {
    lines.push(`${s.slot}. **${s.purpose}** — ${s.spec} (${s.notes})`);
  }
  lines.push('');
  lines.push('## Q&A');
  for (const f of listing.qa) {
    lines.push(`- **Q: ${f.q}**`);
    lines.push(`  A: ${f.a}`);
  }
  lines.push('');
  lines.push('## Audit');
  lines.push(`Current-listing scorecard: **${audit.scorecard.total}/100**`);
  lines.push('');
  for (const p of audit.scorecard.perPrinciple) {
    lines.push(`- ${p.id}: ${p.score} — ${p.rationale}`);
  }
  lines.push('');
  lines.push('### Gaps (current → proposed)');
  lines.push('| Severity | Field | Current | Proposed | Why |');
  lines.push('|---|---|---|---|---|');
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const g of audit.gaps) {
    lines.push(`| ${g.severity} | ${g.field} | ${esc(g.current)} | ${esc(g.proposed)} | ${esc(g.why)} |`);
  }
  lines.push('');
  if (!audit.verified) {
    lines.push('### ⛔ Blocking gate failures');
    for (const f of audit.gateResult.failures) {
      lines.push(`- **[${f.checkId}] ${f.field}** — ${f.context} → ${f.fix}`);
    }
  }
  return lines.join('\n');
}
