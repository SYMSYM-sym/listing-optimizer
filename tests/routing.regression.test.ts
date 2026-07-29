import { describe, expect, it } from 'vitest';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { c17Style } from '@/lib/gate/checks/c-style';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

/**
 * Regression: a real sleep-supplement ASIN (B00IPOTV8U) routed to the GENERIC
 * pack because its category was "Sleep & Snoring" and its title carried no
 * dosage-form word. That triggered a blocking PACK failure + repair
 * short-circuit, so nothing was ever repaired.
 */
const sleepSnapshot: ListingSnapshot = {
  asin: 'B00IPOTV8U',
  url: 'https://www.amazon.com/dp/B00IPOTV8U',
  title:
    'Sleep Complete - 6-in-1 Natural Sleep Support Formula Blend of L-Theanine, 5-HTP, Melatonin, Magnesium, Mucuna Pruriens Extract, GABA, and Phellodendron Bark (herb Powder).',
  bullets: [],
  description: '',
  images: [],
  attributes: {},
  category: 'Health & Household > Health Care > Sleep & Snoring',
  subcategory: [],
  raw: null,
};

describe('routing regression — supplement without a form word in the title', () => {
  it('routes a "Sleep & Snoring" supplement to the supplements pack, not generic', () => {
    const d = detectCategory(sleepSnapshot);
    expect(d.packId).toBe('supplements');
  });

  it('detects real subcategories (so the gate has non-empty disease nouns)', () => {
    const d = detectCategory(sleepSnapshot);
    expect(d.subcategories.length).toBeGreaterThan(0);
    expect(d.subcategories).toContain('sleep');
  });

  it('does not fail closed with a PACK failure for this product', () => {
    const d = detectCategory(sleepSnapshot);
    const pack = loadPack(d.packId);
    expect(pack.compliancePack).not.toBeNull();
  });
});

describe('C17 false-positive regression — ingredient acronyms', () => {
  const pack = loadPack('supplements');
  const base = {
    title: 'Sleep Complete Sleep Support Supplement with GABA and 5-HTP',
    title75: 'Sleep Complete Sleep Support Supplement with GABA',
    itemHighlights: 'Contains GABA, MSM, CoQ10 and NAC',
    bullets: [
      'Calm support: GABA and L-theanine support a relaxed evening routine*',
      'Restful nights: Melatonin supports healthy sleep onset*',
      'Clean formula: NMN and PQQ with no artificial dyes*',
      'Third party tested: Every batch is verified for potency*',
      'Easy to take: One serving before bed with water*',
    ],
    description: 'Sleep Complete pairs GABA with magnesium.',
  } as unknown as OptimizedListing;

  it('does not flag legitimate ingredient acronyms as ALL-CAPS violations', () => {
    const failures = c17Style(
      { ...base, aplusContent: { fdaDisclaimer: '', modules: [], comparison: { rows: [] }, faq: [] } } as OptimizedListing,
      pack,
    );
    const caps = failures.filter((f) => /caps/i.test(f.fix) || /GABA|MSM|NMN|PQQ|NAC/.test(f.context));
    expect(caps).toEqual([]);
  });
});
