import { describe, expect, it } from 'vitest';
import { c18ProhibitedContent } from '@/lib/gate/checks/c-prohibited';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { OptimizedListing } from '@/lib/types';

const pack = loadPack('supplements');
const disclaimer = pack.compliancePack!.disclaimer;

function listing(over: Partial<OptimizedListing>): OptimizedListing {
  return {
    title: 'Sleep Complete Sleep Support Supplement',
    title75: 'Sleep Complete Sleep Support Supplement',
    itemHighlights: 'Melatonin and magnesium blend',
    bullets: [
      'Calm support: Magnesium supports a relaxed evening routine*',
      'Restful nights: Melatonin supports healthy sleep onset*',
      'Clean formula: No artificial dyes or fillers*',
      'Third party tested: Every batch verified for potency*',
      'Easy to take: One serving before bed*',
    ],
    description: `Sleep Complete supports restful sleep.\n\n${disclaimer}`,
    backendSearchTerms: 'sleep aid nighttime rest',
    attributes: {},
    facts: {},
    fdaDisclaimer: disclaimer,
    aplusContent: { fdaDisclaimer: disclaimer, modules: [], comparison: { rows: [] }, faq: [] },
    imagePlan: [],
    qa: [],
    primaryKeyword: 'sleep supplement',
    productName: 'Sleep Complete',
    state: 'draft',
    ...over,
  } as OptimizedListing;
}

describe('C18 — Amazon prohibited detail-page content', () => {
  it('passes a clean listing', () => {
    expect(c18ProhibitedContent(listing({}), pack)).toEqual([]);
  });

  it('catches a SPELLED-OUT price in a bullet (the real reported defect)', () => {
    const bad = listing({
      bullets: [
        'Quality you can trust for nightly use: made in the USA in a GMP certified facility, Sleep Complete contains no allergens common to soy, dairy, or gluten, priced at 39 dollars and 95 cents',
        'Restful nights: Melatonin supports healthy sleep onset*',
        'Clean formula: No artificial dyes or fillers*',
        'Third party tested: Every batch verified for potency*',
        'Easy to take: One serving before bed*',
      ],
    });
    const f = c18ProhibitedContent(bad, pack);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]!.checkId).toBe('C18');
    expect(f[0]!.field).toBe('bullets[0]');
  });

  it('catches a $ price figure in the description', () => {
    const f = c18ProhibitedContent(listing({ description: `Only $19.95 today.\n\n${disclaimer}` }), pack);
    expect(f.some((x) => x.field === 'description')).toBe(true);
  });

  it('catches discount, shipping, availability and condition claims', () => {
    for (const [field, text] of [
      ['itemHighlights', 'Save 20% off today'],
      ['itemHighlights', 'Free shipping on every order'],
      ['itemHighlights', 'In stock and ships today'],
      ['itemHighlights', 'Brand new sealed bottle'],
    ] as const) {
      const f = c18ProhibitedContent(listing({ [field]: text } as Partial<OptimizedListing>), pack);
      expect(f.length, text).toBeGreaterThan(0);
    }
  });

  it('catches contact details (email, URL, phone)', () => {
    for (const text of ['Email us at help@brand.com', 'Visit www.brand.com', 'Call 555-123-4567']) {
      const f = c18ProhibitedContent(listing({ itemHighlights: text }), pack);
      expect(f.length, text).toBeGreaterThan(0);
    }
  });

  it('does NOT flag legitimate copy ("gluten free", counts, potency)', () => {
    const ok = listing({
      itemHighlights: 'Gluten free, dairy free, 60 capsules, 500 mg per serving',
      bullets: [
        'Clean label: Gluten free and dairy free with 60 capsules per bottle*',
        'Restful nights: Melatonin supports healthy sleep onset*',
        'Clean formula: No artificial dyes or fillers*',
        'Third party tested: Every batch verified for potency*',
        'Easy to take: One serving before bed*',
      ],
    });
    expect(c18ProhibitedContent(ok, pack)).toEqual([]);
  });

  it('never flags the verbatim disclaimer', () => {
    expect(c18ProhibitedContent(listing({ description: disclaimer }), pack)).toEqual([]);
  });

  it('is pack-driven — emptying the pattern list disarms the check', () => {
    const disarmed = { ...pack, rules: { ...pack.rules, prohibitedContent: { patterns: [], surfaces: [] } } };
    expect(c18ProhibitedContent(listing({ description: 'Only $19.95' }), disarmed)).toEqual([]);
  });
});

describe('C18 — full surface coverage (Q&A + image plan)', () => {
  it('catches a price hidden in a Q&A answer', () => {
    const bad = listing({
      qa: [{ q: 'How much is it?', a: 'It is priced at 39 dollars and 95 cents.', claimBearing: false }],
    });
    const f = c18ProhibitedContent(bad, pack);
    expect(f.some((x) => x.field.startsWith('qa['))).toBe(true);
  });

  it('catches a URL hidden in an image-plan note', () => {
    const bad = listing({
      imagePlan: [{ slot: 1, purpose: 'main', spec: 'white bg', notes: 'Add www.brand.com to the badge' }],
    });
    const f = c18ProhibitedContent(bad, pack);
    expect(f.some((x) => x.field.startsWith('imagePlan['))).toBe(true);
  });
});
