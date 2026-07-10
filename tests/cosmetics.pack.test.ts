import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { ListingSnapshot } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';

const cosmeticsSnap: ListingSnapshot = {
  asin: 'B0COSMETIC',
  url: 'https://www.amazon.com/dp/B0COSMETIC',
  title: 'GlowLab Niacinamide Face Serum for Daily Skincare Routine',
  bullets: ['Hydrating serum', 'b', 'c', 'd', 'e'],
  description: 'A lightweight face serum for daily skincare.',
  category: 'Beauty & Personal Care > Skin Care > Face',
  subcategory: [],
  attributes: { item_form: 'Serum', brand_name: 'GlowLab' },
  images: [],
  price: '$18.00',
  raw: {},
};

describe('cosmetics KnowledgePack seam', () => {
  it('routes a cosmetics snapshot to the cosmetics pack', () => {
    const d = detectCategory(cosmeticsSnap);
    expect(d.packId).toBe('cosmetics');
    expect(d.subcategories.length).toBeGreaterThan(0);
  });

  it('loadPack(cosmetics) has its own compliance + attribute schema', () => {
    const pack = loadPack('cosmetics');
    expect(pack.compliancePack).not.toBeNull();
    expect(pack.compliancePack!.disclaimer).toContain('cosmetic');
    expect(pack.attributeSchema.some((f) => f.field === 'skin_type')).toBe(true);
    expect(Object.keys(pack.compliancePack!.diseaseNounsBySubcategory).length).toBeGreaterThan(0);
  });

  it('engine + gate run unchanged against the cosmetics pack', async () => {
    const pack = loadPack('cosmetics');
    const listing = await optimize(cosmeticsSnap, pack, mockLlm);
    const gate = runGate(listing, pack, {
      subcategories: ['skincare'],
      snapshotText: cosmeticsSnap.title,
    });
    // Mock LLM is supplement-shaped; gate may fail content checks, but must not throw
    // and PACK must not fire when subcategory nouns are populated.
    expect(gate.failures.some((f) => f.checkId === 'PACK')).toBe(false);
    expect(listing.state).toBe('draft');
  });

  it('fail-closed still holds when cosmetics subcategory nouns are emptied', async () => {
    const pack = JSON.parse(JSON.stringify(loadPack('cosmetics')));
    pack.compliancePack.diseaseNounsBySubcategory = { skincare: [] };
    const listing = await optimize(cosmeticsSnap, pack, mockLlm);
    const gate = runGate(listing, pack, { subcategories: ['skincare'] });
    expect(gate.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('lib/engine and lib/gate have zero cosmetics-specific strings', () => {
    const roots = [join(process.cwd(), 'lib/engine'), join(process.cwd(), 'lib/gate')];
    for (const root of roots) {
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, ent.name);
          if (ent.isDirectory()) out.push(...walk(p));
          else if (ent.name.endsWith('.ts')) out.push(p);
        }
        return out;
      };
      for (const f of walk(root)) {
        const src = readFileSync(f, 'utf8').toLowerCase();
        expect(src.includes('cosmetics'), f).toBe(false);
        expect(src.includes('niacinamide'), f).toBe(false);
        expect(src.includes('skincare'), f).toBe(false);
      }
    }
  });
});
