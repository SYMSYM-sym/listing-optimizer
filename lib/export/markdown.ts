import type { Audit, OptimizedListing } from '@/lib/types';
import { toSellerCentralDescription } from './descriptionHtml';

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
  lines.push('## Description (plain text — paste into Seller Central as-is)');
  lines.push(listing.description);
  lines.push('');
  lines.push('## Description — Seller Central `<br>` variant');
  lines.push('Amazon\'s description field accepts only the `<br>` tag; paste this variant to keep the paragraph breaks.');
  lines.push('');
  lines.push('```html');
  lines.push(toSellerCentralDescription(listing.description));
  lines.push('```');
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
  // WS3 — the keyword reference travels with the RECORD as well as the sheet:
  // whoever reads this file later needs to know what the listing deliberately
  // avoided, and how the demand behind an avoided term is still captured.
  const coverage = audit.keywordCoverage;
  if (coverage && coverage.total > 0) {
    lines.push('## Keyword reference');
    if (coverage.placed.length > 0) {
      lines.push('### Placed (verified on every surface declared)');
      lines.push('| Term | Tier | Verified on | Why |');
      lines.push('|---|---|---|---|');
      for (const r of coverage.placed) {
        lines.push(`| ${r.term} | ${String(r.tier)} | ${r.surfaces.join(', ')} | ${r.why} |`);
      }
      lines.push('');
    }
    if (coverage.backendOnly.length > 0) {
      lines.push(`**Backend only (verified absent from every visible surface):** ${coverage.backendOnly.map((r) => r.term).join(', ')}`);
      lines.push('');
    }
    if (coverage.negatives.length > 0) {
      lines.push('### Negative list — verified to appear nowhere');
      lines.push('| Term | Why |');
      lines.push('|---|---|');
      for (const r of coverage.negatives) lines.push(`| ${r.term} | ${r.why} |`);
      lines.push('');
    }
    if (coverage.recaptured.length > 0) {
      lines.push('### Demand recapture (K4)');
      lines.push('| Demand not written | How it still reaches the listing |');
      lines.push('|---|---|');
      for (const r of coverage.recaptured) lines.push(`| ${r.term} | ${r.via} |`);
      lines.push('');
    }
    if (coverage.candidates.length > 0 || coverage.notTargeted.length > 0) {
      lines.push('### Held back / deliberately skipped');
      for (const r of coverage.candidates) lines.push(`- **${r.term}** — candidate; ${[r.home, r.why].filter(Boolean).join(' — ')}`);
      for (const r of coverage.notTargeted) lines.push(`- **${r.term}** — not targeted; ${r.why}`);
      lines.push('');
    }
  }
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
  // R33/R38 — the substantiation register travels with the RECORD as well as
  // the ship sheet: whoever reads this file later needs to know which trust
  // claims were signed off and which were still waiting for an artifact.
  const register = audit.substantiationRegister ?? [];
  if (register.length > 0) {
    lines.push('### Substantiation register (operator sign-off)');
    lines.push('| Claim | Appears on | Status | Note |');
    lines.push('|---|---|---|---|');
    for (const r of register) {
      lines.push(`| ${esc(r.claim)} | ${esc(r.surface)} | ${r.status} | ${esc(r.note ?? '')} |`);
    }
    lines.push('');
  }
  // brain/02 — advisory lexicon proposals. About the CHECKER, not the copy.
  const candidates = audit.candidateTerms ?? [];
  if (candidates.length > 0) {
    lines.push('### Candidate terms (advisory — not in the compliance lexicon)');
    lines.push(candidates.map((t) => `\`${t}\``).join(', '));
    lines.push('');
  }
  if (!audit.verified) {
    lines.push('### ⛔ Blocking gate failures');
    for (const f of audit.gateResult.failures) {
      lines.push(`- **[${f.checkId}] ${f.field}** — ${f.context} → ${f.fix}`);
    }
  }
  return lines.join('\n');
}
