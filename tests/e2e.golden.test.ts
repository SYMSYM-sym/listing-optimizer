import { describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { toMarkdown } from '@/lib/export/markdown';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { utf8Bytes } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import type { OptimizedListing } from '@/lib/types';
import rules from '@/knowledge/rules.json';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

describe('golden-ASIN E2E (recorded fixtures, deterministic)', () => {
  it('ingestion yields a populated ListingSnapshot', () => {
    expect(snapshot.asin).toBe('B0TESTASIN');
    expect(snapshot.title.length).toBeGreaterThan(10);
    expect(snapshot.bullets.length).toBeGreaterThan(0);
    expect(snapshot.category.toLowerCase()).toContain('supplement');
  });

  it('optimize → full OptimizedListing with facts + aplusContent', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.facts).toBeTruthy();
    expect(listing.aplusContent.modules.length).toBeGreaterThan(0);
    expect(listing.aplusContent.comparison.rows.length).toBeGreaterThan(0);
    expect(listing.aplusContent.faq.length).toBeGreaterThan(0);
    expect(listing.bullets).toHaveLength(5);
    expect(listing.qa.length).toBeGreaterThanOrEqual(15);
    expect(listing.imagePlan.length).toBeGreaterThanOrEqual(7);
  });

  it('every field respects its limit (bytes for backend, chars elsewhere)', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.title.length).toBeLessThanOrEqual(rules.titleMaxLegacy);
    expect(listing.title75.length).toBeLessThanOrEqual(rules.title75Max);
    expect(listing.itemHighlights.length).toBeLessThanOrEqual(rules.itemHighlightsMax);
    expect(listing.description.length).toBeLessThanOrEqual(rules.descriptionMax);
    for (const b of listing.bullets) {
      expect(b.length).toBeLessThanOrEqual(rules.bulletMax);
    }
    expect(utf8Bytes(listing.backendSearchTerms)).toBeLessThanOrEqual(rules.backendMaxBytes);
  });

  it('runGate returns pass:true on the compliant fixture', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const gate = runGate(listing, pack, ctx);
    expect(gate.pass).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('full pipeline: verified listing + audit with ≥3 gaps + gateResult', async () => {
    const result = await runPipeline(snapshot, mockLlm, 3);
    expect(result.audit.verified).toBe(true);
    expect(result.audit.verified).toBe(result.audit.gateResult.pass);
    expect(result.audit.scorecard.total).toBeGreaterThan(0);
    expect(result.audit.gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of result.audit.gaps) {
      expect(['P0', 'P1', 'P2']).toContain(g.severity);
    }
  });

  it('export produces valid JSON and Markdown', async () => {
    const result = await runPipeline(snapshot, mockLlm, 3);
    const json = JSON.stringify({ optimized: result.optimized, audit: result.audit });
    expect(() => JSON.parse(json)).not.toThrow();
    const md = toMarkdown(result.optimized, result.audit);
    expect(md).toContain('BrandX Probiotic');
    expect(md).toContain('VERIFIED');
    expect(md.length).toBeGreaterThan(500);
  });

  it('negative fixture: expected gate failures, audit.verified false, export blocked', async () => {
    const clean = await optimize(snapshot, pack, mockLlm);
    const bad: OptimizedListing = JSON.parse(JSON.stringify(clean));
    bad.bullets.push('extra sixth bullet');
    bad.bullets[0] = 'CURES DIABETES: this product treats diabetes and prevents flare-ups fast*';
    bad.description = bad.description.replace(bad.fdaDisclaimer, '');
    bad.fdaDisclaimer = 'Wrong disclaimer text.';
    bad.backendSearchTerms = 'ä'.repeat(140);
    const emptyCtx = { subcategories: [] as string[], snapshotText: snapshot.title };
    const gate = runGate(bad, pack, emptyCtx);
    expect(gate.pass).toBe(false);
    const ids = gate.failures.map((f) => f.checkId);
    expect(ids).toContain('C2');
    expect(ids).toContain('C3');
    expect(ids).toContain('C5');
    expect(ids).toContain('C6');
    expect(ids).toContain('PACK');
    const audit = buildAudit(snapshot, bad, pack, emptyCtx);
    expect(audit.verified).toBe(false);
    expect(audit.verified).toBe(audit.gateResult.pass);
    const md = toMarkdown(bad, audit);
    expect(md).toContain('NOT VERIFIED');
    expect(md).toContain('Blocking gate failures');
  });
});
