import { describe, expect, it } from 'vitest';
import { diff } from '@/lib/audit/diff';
import { optimize } from '@/lib/engine/optimize';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = ['probiotic', 'digestive'];

describe('diff (current vs proposed)', () => {
  it('classifies P0 for banned disease terms in the current listing', async () => {
    const dirty = {
      ...snapshot,
      bullets: ['TREATS DIABETES: helps manage diabetes symptoms fast', ...snapshot.bullets.slice(1)],
    };
    const proposed = await optimize(dirty, pack, mockLlm);
    const gaps = diff(dirty, proposed, pack, ctx);
    const p0 = gaps.filter((g) => g.severity === 'P0');
    expect(p0.length).toBeGreaterThanOrEqual(1);
    expect(p0.some((g) => g.why.toLowerCase().includes('diabetes'))).toBe(true);
    expect(p0[0]?.current).not.toBe('unknown');
    expect(p0[0]?.proposed.length).toBeGreaterThan(0);
  });

  it('marks seller-private backend as current: unknown with P1 severity', async () => {
    const proposed = await optimize(snapshot, pack, mockLlm);
    const gaps = diff(snapshot, proposed, pack, ctx);
    const backend = gaps.find((g) => g.field === 'backendSearchTerms');
    expect(backend?.current).toBe('unknown');
    expect(backend?.severity).toBe('P1');
    expect(backend?.proposed).toContain('bytes');
  });

  it('flags empty filter-facet attributes as P1', async () => {
    const sparse = {
      ...snapshot,
      attributes: { brand_name: 'BrandX' },
    };
    const proposed = await optimize(sparse, pack, mockLlm);
    const gaps = diff(sparse, proposed, pack, ctx);
    const facet = gaps.find((g) => g.field === 'attributes' && g.severity === 'P1');
    expect(facet).toBeTruthy();
    expect(facet?.current).toContain('empty filter-facet');
  });

  it('shows explicit title current-vs-proposed delta when copy changes', async () => {
    const proposed = await optimize(snapshot, pack, mockLlm);
    const gaps = diff(snapshot, proposed, pack, ctx);
    const titleGap = gaps.find(
      (g) => g.field === 'title' && g.current !== 'unknown' && g.proposed !== 'unknown',
    );
    expect(titleGap).toBeTruthy();
    expect(titleGap?.current).toContain('BrandX');
    expect(titleGap?.proposed).toContain('BrandX');
    expect(titleGap?.severity).toBe('P2');
  });

  it('returns ≥3 concrete gaps for the golden fixture', async () => {
    const proposed = await optimize(snapshot, pack, mockLlm);
    const gaps = diff(snapshot, proposed, pack, ctx);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (const g of gaps) {
      expect(['P0', 'P1', 'P2']).toContain(g.severity);
      expect(g.why.length).toBeGreaterThan(10);
    }
  });
});
