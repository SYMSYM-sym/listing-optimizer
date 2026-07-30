import { describe, expect, it } from 'vitest';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { loadPack } from '@/lib/knowledge/loadPack';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * A live run produced productName "Culturelle Health & Wellness Daily Probiotic
 * Supplement" but title75 "Culturelle Daily Probiotic Supplement, ..." — the model
 * silently abbreviated its own product name, which C8/C15 correctly rejected.
 * The prompt never stated the consistency requirement; this pins that it does.
 */
describe('title prompt states the productName consistency rule (prevention)', () => {
  for (const packId of ['supplements', 'cosmetics'] as const) {
    it(`${packId}: title prompt requires both titles to start with productName verbatim`, () => {
      const p = buildGroupPrompts(loadPack(packId)).title(snapshot).toLowerCase();
      expect(p).toContain('title75');
      expect(p).toMatch(/start with this exact string/i);
      expect(p).toMatch(/verbatim in both titles/i);
    });
  }
  it('generated fixture satisfies the rule it now states', async () => {
    const pack = loadPack('supplements');
    const l = await optimize(snapshot, pack, mockLlm);
    expect(l.title.startsWith(l.productName)).toBe(true);
    expect(l.title75.startsWith(l.productName)).toBe(true);
    const r = runGate(l, pack, { subcategories: ['probiotic','digestive'], snapshotText: snapshot.title });
    expect(r.failures.filter((f) => f.checkId === 'C15' || f.checkId === 'C8')).toEqual([]);
  });
});
