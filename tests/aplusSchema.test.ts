import { describe, expect, it } from 'vitest';
import { aplusGroupSchema } from '@/lib/engine/schemas';

const baseFaq = [
  { q: 'How many CFU?', a: 'A 50 Billion CFU blend of 10 strains.', claimBearing: false },
  { q: 'Need fridge?', a: 'No, the formula is shelf stable.', claimBearing: false },
  { q: 'How long?', a: '60 capsules last about two months at one daily.', claimBearing: false },
  { q: 'Vegan?', a: 'Yes, vegetable capsules and vegan formula.', claimBearing: false },
  { q: 'Who for?', a: 'Adults seeking daily digestive balance support.', claimBearing: true },
];

const baseComparison = {
  rows: [
    { label: 'Potency', ours: '50 Billion CFU', typical: 'Lower CFU' },
    { label: 'Storage', ours: 'Shelf stable', typical: 'Refrigerated' },
    { label: 'Supply', ours: '60 count', typical: '30 count' },
  ],
};

function modulesWith(overrides: Partial<{ headline: string | undefined; title?: string }> = {}) {
  return [
    {
      id: 'brand-story',
      headline: overrides.headline === undefined && !('title' in overrides) ? 'The Brand Story' : overrides.headline,
      ...(overrides.title !== undefined ? { title: overrides.title } : {}),
      body: 'BrandX Probiotic began with a simple idea: digestive support should fit real routines every day.',
      claimBearing: false,
    },
    {
      id: 'hero',
      headline: 'BrandX Probiotic Hero',
      body: 'BrandX Probiotic delivers a 50 Billion CFU blend to support digestive balance and healthy gut flora.',
      claimBearing: true,
    },
    {
      id: 'ingredients',
      headline: 'What Is Inside',
      body: 'A 10-strain probiotic blend at 50 Billion CFU with prebiotic fiber in a vegan vegetable capsule.',
      claimBearing: false,
    },
    {
      id: 'how-to-use',
      headline: 'How To Use',
      body: 'Take one capsule daily with water, with or without food. Shelf stable, no refrigeration required.',
      claimBearing: false,
    },
    {
      id: 'who-its-for',
      headline: 'Who It Is For',
      body: 'Adults who want steady digestive comfort support during travel, busy weeks, and daily routines.',
      claimBearing: true,
    },
  ];
}

describe('aplusGroupSchema headline requirement', () => {
  it('requires a non-empty headline on module[0] (rejects missing headline)', () => {
    const raw = {
      modules: modulesWith({ headline: undefined }),
      comparison: baseComparison,
      faq: baseFaq,
    };
    // Explicitly delete headline so it is truly absent (like live LLM output)
    delete (raw.modules[0] as { headline?: string }).headline;
    const result = aplusGroupSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const path = result.error.issues[0]?.path.join('.') ?? '';
      expect(path).toMatch(/modules\.0\.headline/);
    }
  });

  it('accepts title/heading aliases as headline so first attempt validates', () => {
    const mods = modulesWith({ headline: undefined, title: 'Our Brand Story' });
    delete (mods[0] as { headline?: string }).headline;
    const result = aplusGroupSchema.safeParse({
      modules: mods,
      comparison: baseComparison,
      faq: baseFaq,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modules[0]!.headline).toBe('Our Brand Story');
    }
  });

  it('accepts the canonical shape with headline on every module', () => {
    const result = aplusGroupSchema.safeParse({
      modules: modulesWith(),
      comparison: baseComparison,
      faq: baseFaq,
    });
    expect(result.success).toBe(true);
  });
});
