import type { Audit, OptimizedListing } from '@/lib/types';
import { arr } from '@/lib/gate/util';
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
    : `⛔ NOT VERIFIED — ${arr<unknown>(audit.gateResult?.failures).length} blocking gate failure(s); do not publish`;
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
  // WS10 — the RECORD must render a malformed run too: it is where the
  // failures are read from when the app is not in front of you.
  arr<string>(listing.bullets).forEach((b, i) => lines.push(`${i + 1}. ${b}`));
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
  for (const [k, v] of Object.entries(
    listing.attributes && typeof listing.attributes === 'object' ? listing.attributes : {},
  )) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push('');
  lines.push('## A+ Content');
  for (const m of arr<NonNullable<typeof listing.aplusContent>['modules'][number]>(listing.aplusContent?.modules)) {
    lines.push(`### [${m.id}] ${m.headline}${m.claimBearing ? ' *(claim-bearing)*' : ''}`);
    lines.push(m.body);
    if (m.subcopy) lines.push(`_${m.subcopy}_`);
    lines.push('');
  }
  lines.push('### Comparison');
  lines.push('| | Ours | Typical |');
  lines.push('|---|---|---|');
  for (const r of arr<{ label: string; ours: string; typical: string }>(listing.aplusContent?.comparison?.rows)) {
    lines.push(`| ${r.label} | ${r.ours} | ${r.typical} |`);
  }
  lines.push('');
  lines.push('### A+ FAQ');
  for (const f of arr<{ q: string; a: string }>(listing.aplusContent?.faq)) {
    lines.push(`- **Q: ${f.q}**`);
    lines.push(`  A: ${f.a}`);
  }
  lines.push('');
  lines.push('## Visual production pack');
  lines.push('| # | Purpose | Spec | Notes | ALT |');
  lines.push('|---|---|---|---|---|');
  const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const s of arr<NonNullable<typeof listing.imagePlan>[number]>(listing.imagePlan)) {
    lines.push(`| ${cell(s?.slot)} | ${cell(s?.purpose)} | ${cell(s?.spec)} | ${cell(s?.notes)} | ${cell(s?.altText)} |`);
  }
  lines.push('');
  // WS8 — the 9:16 brief travels with the record; its on-screen strings are
  // copy and were scanned as copy.
  const brief = listing.videoBrief;
  if (brief) {
    lines.push(`### Video brief — ${brief.aspect}, ${brief.durationSeconds}s`);
    for (const b of arr<string>(brief.shots)) lines.push(`- ${b}`);
    lines.push('');
    lines.push(`**On-screen text:** ${arr<string>(brief.onScreenText).join(' | ')}`);
    if (brief.notes) lines.push(brief.notes);
    lines.push('');
  }
  // WS3 — the keyword reference travels with the RECORD as well as the sheet:
  // whoever reads this file later needs to know what the listing deliberately
  // avoided, and how the demand behind an avoided term is still captured.
  const coverage = audit.keywordCoverage;
  if (coverage && typeof coverage === 'object' && coverage.total > 0) {
    lines.push('## Keyword reference');
    if (arr<unknown>(coverage.placed).length > 0) {
      lines.push('### Placed (verified on every surface declared)');
      lines.push('| Term | Tier | Verified on | Why |');
      lines.push('|---|---|---|---|');
      for (const r of arr<{ term: string; tier: unknown; surfaces: string[]; why: string }>(coverage.placed)) {
        lines.push(`| ${r.term} | ${String(r.tier)} | ${arr<string>(r.surfaces).join(', ')} | ${r.why} |`);
      }
      lines.push('');
    }
    if (arr<unknown>(coverage.backendOnly).length > 0) {
      lines.push(`**Backend only (verified absent from every visible surface):** ${arr<{ term: string }>(coverage.backendOnly).map((r) => r.term).join(', ')}`);
      lines.push('');
    }
    if (arr<unknown>(coverage.negatives).length > 0) {
      lines.push('### Negative list — verified to appear nowhere');
      lines.push('| Term | Why |');
      lines.push('|---|---|');
      for (const r of arr<{ term: string; why: string }>(coverage.negatives)) lines.push(`| ${r.term} | ${r.why} |`);
      lines.push('');
    }
    if (arr<unknown>(coverage.recaptured).length > 0) {
      lines.push('### Demand recapture (K4)');
      lines.push('| Demand not written | How it still reaches the listing |');
      lines.push('|---|---|');
      for (const r of arr<{ term: string; via: string }>(coverage.recaptured)) lines.push(`| ${r.term} | ${r.via} |`);
      lines.push('');
    }
    if (arr<unknown>(coverage.candidates).length > 0 || arr<unknown>(coverage.notTargeted).length > 0) {
      lines.push('### Held back / deliberately skipped');
      for (const r of arr<{ term: string; home: string; why: string }>(coverage.candidates)) lines.push(`- **${r.term}** — candidate; ${[r.home, r.why].filter(Boolean).join(' — ')}`);
      for (const r of arr<{ term: string; why: string }>(coverage.notTargeted)) lines.push(`- **${r.term}** — not targeted; ${r.why}`);
      lines.push('');
    }
  }
  lines.push('## Q&A');
  for (const f of arr<{ q: string; a: string }>(listing.qa)) {
    lines.push(`- **Q: ${f.q}**`);
    lines.push(`  A: ${f.a}`);
  }
  lines.push('');
  lines.push('## Audit');
  // WS6 — BOTH sides, scored by the same scorer. The old export printed only
  // the current listing's total, which beside a VERIFIED banner reads as a
  // grade for the new copy.
  const after = audit.scorecardProposed;
  lines.push(
    after
      ? `Principle score: current **${audit.scorecard?.total}/100** → proposed **${after.total}/100**`
      : `Current-listing scorecard: **${audit.scorecard?.total}/100**`,
  );
  lines.push('');
  lines.push(
    'Each side is renormalized over the principles that are knowable for it; an `unknown` deflates neither total. This is a content score, not the verify verdict.',
  );
  lines.push('');
  if (after) {
    lines.push('| Principle | Current | Proposed | Why (proposed) |');
    lines.push('|---|---|---|---|');
    for (const p of arr<{ id: string; score: string; rationale: string }>(audit.scorecard?.perPrinciple)) {
      const a = arr<{ id: string; score: string; rationale: string }>(after.perPrinciple).find((x) => x?.id === p?.id);
      lines.push(`| ${p.id} | ${p.score} | ${a?.score ?? '—'} | ${(a?.rationale ?? '').replace(/\|/g, '\\|')} |`);
    }
  } else {
    for (const p of arr<{ id: string; score: string; rationale: string }>(audit.scorecard?.perPrinciple)) {
      lines.push(`- ${p.id}: ${p.score} — ${p.rationale}`);
    }
  }
  lines.push('');
  lines.push('### Gaps (current → proposed)');
  lines.push('| Severity | Field | Current | Proposed | Why |');
  lines.push('|---|---|---|---|---|');
  const esc = (s: unknown): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const g of arr<NonNullable<typeof audit.gaps>[number]>(audit.gaps)) {
    lines.push(`| ${g.severity} | ${g.field} | ${esc(g.current)} | ${esc(g.proposed)} | ${esc(g.why)} |`);
  }
  lines.push('');
  // R33/R38 — the substantiation register travels with the RECORD as well as
  // the ship sheet: whoever reads this file later needs to know which trust
  // claims were signed off and which were still waiting for an artifact.
  const register = arr<NonNullable<typeof audit.substantiationRegister>[number]>(audit.substantiationRegister);
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
  const candidates = arr<string>(audit.candidateTerms);
  if (candidates.length > 0) {
    lines.push('### Candidate terms (advisory — not in the compliance lexicon)');
    lines.push(candidates.map((t) => `\`${t}\``).join(', '));
    lines.push('');
  }
  // WS9 — the benchmark travels with the record. Structural facts only.
  const bm = audit.benchmark;
  if (bm && typeof bm === 'object') {
    lines.push('### Competitor benchmark');
    lines.push(`${bm.ingested} of ${bm.requested} competitor ASIN(s) ingested. No rival copy is reproduced.`);
    lines.push('');
    lines.push('| ASIN | Title chars | Bullets | Attributes | A+ |');
    lines.push('|---|---|---|---|---|');
    const row = (label: string, r: typeof bm.subject | undefined): string =>
      !r || r.status !== 'ok'
        ? `| ${label} | — | — | — | not ingested: ${String(r?.note ?? '').replace(/\|/g, '\\|')} |`
        : `| ${label} | ${r.titleLength} | ${r.bulletCount} | ${r.attributeCount} | ${r.aplusPresent ? 'yes' : 'no'} |`;
    lines.push(row(`${bm.subject?.asin} (proposed)`, bm.subject));
    lines.push(row(`${bm.current?.asin} (current)`, bm.current));
    for (const r of arr<typeof bm.subject>(bm.rows)) lines.push(row(String(r?.asin ?? ''), r));
    lines.push('');
  }
  if (!audit.verified) {
    lines.push('### ⛔ Blocking gate failures');
    for (const f of arr<NonNullable<typeof audit.gateResult>['failures'][number]>(audit.gateResult?.failures)) {
      lines.push(`- **[${f.checkId}] ${f.field}** — ${f.context} → ${f.fix}`);
    }
  }
  return lines.join('\n');
}
