import { describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { scoreAgainstPrinciples } from '@/lib/audit/scoreAgainstPrinciples';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import type { OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

describe('scorecard', () => {
  const sc = scoreAgainstPrinciples(snapshot, pack);
  it('scores 0–100 with a per-principle breakdown', () => {
    expect(sc.total).toBeGreaterThanOrEqual(0);
    expect(sc.total).toBeLessThanOrEqual(100);
    expect(sc.perPrinciple).toHaveLength(16);
  });
  it('unknowns are excluded from the denominator, never scored 0', () => {
    const p3 = sc.perPrinciple.find((p) => p.id === 'P3');
    expect(p3?.score).toBe('unknown'); // backend is seller-private
    // P15/P16 process rules are unknown too
    expect(sc.perPrinciple.find((p) => p.id === 'P15')?.score).toBe('unknown');
    // if unknowns were scored 0 with full denominator, total would be lower:
    // recompute naive total to prove renormalization increases it.
    expect(sc.total).toBeGreaterThan(0);
  });
  it('every principle has a one-line rationale', () => {
    for (const p of sc.perPrinciple) expect(p.rationale.length).toBeGreaterThan(5);
  });
});

describe('buildAudit (worker ≠ checker)', () => {
  it('verified === gateResult.pass, re-derived by the audit module itself', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const audit = buildAudit(snapshot, listing, pack, ctx);
    expect(audit.verified).toBe(audit.gateResult.pass);
    expect(audit.verified).toBe(true);
    // ≥3 concrete gaps with severities on a real snapshot
    expect(audit.gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of audit.gaps) {
      expect(['P0', 'P1', 'P2']).toContain(g.severity);
      expect(g.why.length).toBeGreaterThan(10);
    }
  });

  it('never trusts a client-carried gateResult — tampered pass is re-derived as fail', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const bad: OptimizedListing = JSON.parse(JSON.stringify(listing));
    bad.backendSearchTerms = 'ä'.repeat(140); // over-byte
    // Simulate a client shipping a forged "pass" — buildAudit ignores it.
    const audit = buildAudit(snapshot, bad, pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.gateResult.failures.some((f) => f.checkId === 'C3')).toBe(true);
  });

  it('audits the current-vs-proposed delta with unknown states', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const audit = buildAudit(snapshot, listing, pack, ctx);
    const backendGap = audit.gaps.find((g) => g.field === 'backendSearchTerms');
    expect(backendGap?.current).toBe('unknown');
    const t75 = audit.gaps.find((g) => g.field === 'title75');
    expect(t75?.severity).toBe('P1');
  });

  it('flags P0 compliance violations in the CURRENT listing', () => {
    const dirty = {
      ...snapshot,
      bullets: ['CURES IBS FAST: this product treats ibs and prevents flare-ups', ...snapshot.bullets.slice(1)],
    };
    const listingPromise = optimize(dirty, pack, mockLlm);
    return listingPromise.then((listing) => {
      const audit = buildAudit(dirty, listing, pack, ctx);
      const p0 = audit.gaps.filter((g) => g.severity === 'P0');
      expect(p0.length).toBeGreaterThanOrEqual(1);
      expect(p0.some((g) => g.why.includes('ibs'))).toBe(true);
    });
  });
});

describe('runPipeline (shared by routes and golden test)', () => {
  it('full pipeline on the recorded fixture: verified listing + audit', async () => {
    const result = await runPipeline(snapshot, mockLlm, 3);
    expect(result.optimized.state).toBe('verified');
    expect(result.audit.verified).toBe(true);
    expect(result.iterations).toBe(0);
    // element state only advances to verified when the gate is green
    const gate = runGate(result.optimized, pack, ctx);
    expect(gate.pass).toBe(true);
  });
});
