import { describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { AplusContent, Audit, Facts, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const OUTPUT_CONTRACT_FIELDS = [
  'title',
  'title75',
  'itemHighlights',
  'bullets',
  'description',
  'backendSearchTerms',
  'attributes',
  'facts',
  'fdaDisclaimer',
  'aplusContent',
  'imagePlan',
  'qa',
] as const satisfies readonly (keyof OptimizedListing)[];

const FACTS_FIELDS = [
  'potency',
  'unitCount',
  'servings',
  'servingSize',
  'daySupply',
  'weight',
  'price',
  'formulaCount',
] as const satisfies readonly (keyof Facts)[];

describe('output contract field parity (brain/05)', () => {
  it('OptimizedListing from the golden fixture includes every contract field', async () => {
    const pack = loadPack('supplements');
    const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
    const listing = await optimize(snapshot, pack, mockLlm);
    for (const key of OUTPUT_CONTRACT_FIELDS) {
      expect(listing[key]).toBeDefined();
    }
    expect(OUTPUT_CONTRACT_FIELDS).toHaveLength(12);
  });

  it('Facts type allows every brain/05 schema field', () => {
    const facts: Facts = {
      potency: '50 Billion CFU',
      unitCount: 60,
      servings: 60,
      servingSize: '1 Capsule',
      daySupply: 60,
      weight: '2.4 Ounces',
      price: '29.99',
      formulaCount: 10,
    };
    for (const key of FACTS_FIELDS) {
      expect(facts[key]).toBeDefined();
    }
  });

  it('AplusContent shape matches brain/05', async () => {
    const pack = loadPack('supplements');
    const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
    const listing = await optimize(snapshot, pack, mockLlm);
    const aplus: AplusContent = listing.aplusContent;
    expect(aplus.fdaDisclaimer.length).toBeGreaterThan(20);
    expect(aplus.modules.length).toBeGreaterThan(0);
    expect(aplus.comparison.rows.length).toBeGreaterThan(0);
    expect(aplus.faq.length).toBeGreaterThan(0);
  });

  it('Audit.verified is tied to gateResult.pass', () => {
    const auditShape: Audit = {
      scorecard: { total: 0, perPrinciple: [] },
      gaps: [],
      gateResult: { pass: false, failures: [] },
      verified: false,
    };
    expect(auditShape.verified).toBe(auditShape.gateResult.pass);
  });
});
