import { describe, expect, it } from 'vitest';
import { loadPack } from '@/lib/knowledge/loadPack';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { rainforestSample } from './fixtures/rainforest.sample';
import type { ListingSnapshot } from '@/lib/types';

describe('knowledge pack limits (must exactly match brain/)', () => {
  const pack = loadPack('supplements');
  it('backend cap is 249 UTF-8 bytes', () => {
    expect(pack.rules.backendMaxBytes).toBe(249);
  });
  it('title75 is 75, highlights 125, legacy 200', () => {
    expect(pack.rules.title75Max).toBe(75);
    expect(pack.rules.itemHighlightsMax).toBe(125);
    expect(pack.rules.titleMaxLegacy).toBe(200);
  });
  it('bullets 5×255, description 2000', () => {
    expect(pack.rules.bulletCount).toBe(5);
    expect(pack.rules.bulletMax).toBe(255);
    expect(pack.rules.descriptionMax).toBe(2000);
  });
  it('image and A+ caps match brain/01', () => {
    expect(pack.rules.imageGalleryMax).toBe(9);
    expect(pack.rules.aplusModuleMaxBasic).toBe(5);
    expect(pack.rules.aplusModuleMaxPremium).toBe(7);
    expect(pack.rules.imageMainMinLongSidePx).toBe(1000);
    expect(pack.rules.imageMainProductFillPct).toBe(85);
    expect(pack.rules.imageMainWhiteRgb).toEqual([255, 255, 255]);
  });
  it('timeSensitive flags on ⏳ rules', () => {
    const ids = pack.rules.rules.filter((r) => r.timeSensitive).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['title75', 'item-highlights-125', 'title-legacy-200']));
  });
});

describe('supplements pack population', () => {
  const pack = loadPack('supplements');
  it('wires all compiled JSON artifacts', () => {
    expect(pack.compliancePack).not.toBeNull();
    expect(pack.attributeSchema.length).toBe(35);
    expect(pack.principles.length).toBe(16);
  });
  it('diseaseNounsBySubcategory keys match subcategoryKeywords keys', () => {
    const cp = pack.compliancePack!;
    const nounKeys = Object.keys(cp.diseaseNounsBySubcategory).sort();
    const kwKeys = Object.keys(cp.subcategoryKeywords).sort();
    expect(nounKeys).toEqual(kwKeys);
  });
});

describe('supplements compliance pack', () => {
  const cp = loadPack('supplements').compliancePack;
  it('is populated', () => {
    expect(cp).not.toBeNull();
  });
  it('has the verbatim FDA disclaimer', () => {
    expect(cp?.disclaimer).toBe(
      'These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.',
    );
  });
  it('ships ≥20 NON-EMPTY subcategory disease-noun lists', () => {
    const map = cp?.diseaseNounsBySubcategory ?? {};
    const keys = Object.keys(map);
    expect(keys.length).toBeGreaterThanOrEqual(20);
    for (const k of keys) {
      expect(map[k]?.length, `subcategory '${k}' must be non-empty`).toBeGreaterThan(0);
    }
  });
  it('ships an always-on core disease-noun list', () => {
    expect(cp?.coreDiseaseNouns.length).toBeGreaterThanOrEqual(20);
    expect(cp?.coreDiseaseNouns).toContain('cancer');
    expect(cp?.coreDiseaseNouns).toContain('diabetes');
  });
  it('every subcategory has detection keywords', () => {
    const map = cp?.diseaseNounsBySubcategory ?? {};
    const kw = cp?.subcategoryKeywords ?? {};
    for (const k of Object.keys(map)) {
      expect(kw[k]?.length, `keywords for '${k}'`).toBeGreaterThan(0);
    }
  });
  it('fictionPhrases defaults to empty (operator-supplied)', () => {
    expect(cp?.fictionPhrases).toEqual([]);
  });
  it('scorable principle weights sum to 100; P15/P16 process-only', () => {
    const ps = loadPack('supplements').principles;
    expect(ps.filter((p) => p.scorable).reduce((a, p) => a + p.weight, 0)).toBe(100);
    expect(ps.find((p) => p.id === 'P15')?.scorable).toBe(false);
    expect(ps.find((p) => p.id === 'P16')?.scorable).toBe(false);
  });
});

describe('generic fallback pack', () => {
  const pack = loadPack('generic');
  it('has rules + principles but no compliance module', () => {
    expect(pack.compliancePack).toBeNull();
    expect(pack.rules.backendMaxBytes).toBe(249);
    expect(pack.principles.length).toBe(16);
  });
  it('ships a populated suspicion lexicon (fail-closed bypass guard)', () => {
    expect(pack.suspicionLexicon.length).toBeGreaterThan(5);
    expect(pack.suspicionLexicon).toContain('supplement facts');
  });
});

describe('detectCategory', () => {
  const supplementSnapshot = toSnapshot(
    mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
  );
  it('routes a supplement ASIN to the supplements pack with subcategories', () => {
    const d = detectCategory(supplementSnapshot);
    expect(d.packId).toBe('supplements');
    expect(d.subcategories).toContain('probiotic');
  });
  it('returns the UNION of matching subcategories for multi-benefit products', () => {
    const multi: ListingSnapshot = {
      ...supplementSnapshot,
      title: 'BrandX Sleep + Immunity Gummies with Melatonin, Elderberry and Zinc',
    };
    const d = detectCategory(multi);
    expect(d.subcategories).toEqual(expect.arrayContaining(['sleep', 'immunity']));
  });
  it('routes a non-supplement to generic with empty subcategories', () => {
    const generic: ListingSnapshot = {
      asin: 'B0GENERIC1',
      url: 'https://www.amazon.com/dp/B0GENERIC1',
      title: 'Stainless Steel Kitchen Tongs 12-Inch',
      bullets: [],
      description: 'Kitchen tongs.',
      images: [],
      attributes: {},
      category: 'Home & Kitchen > Utensils',
      subcategory: [],
      raw: {},
    };
    const d = detectCategory(generic);
    expect(d.packId).toBe('generic');
    expect(d.subcategories).toEqual([]);
  });

  it('falls back to general subcategory when supplement has no keyword hits', () => {
    const vague: ListingSnapshot = {
      asin: 'B0VAGUE01',
      url: 'https://www.amazon.com/dp/B0VAGUE01',
      title: 'Premium Daily Wellness Capsules 60 Count',
      bullets: [],
      description: 'A daily wellness formula.',
      images: [],
      attributes: {},
      category: 'Health & Household > Vitamins & Dietary Supplements',
      subcategory: [],
      raw: {},
    };
    const d = detectCategory(vague);
    expect(d.packId).toBe('supplements');
    expect(d.subcategories).toEqual(['general']);
  });
});
