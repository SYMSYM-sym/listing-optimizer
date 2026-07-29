import { beforeAll, describe, expect, it, vi } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { generateGroup } from '@/lib/engine/llm';
import { fieldToGroup } from '@/lib/engine/repair';
import { rulesStaleness } from '@/lib/audit/staleness';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { collapseSeparators, normalize } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing, RuleSet } from '@/lib/types';
import { z } from 'zod';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * RED TEAM ROUND 2 — the defects two independent audits found after the first
 * hardening pass. Every case below PASSED the shipped gate and must now FAIL,
 * and the closing block re-proves that none of the new rules fires on
 * legitimate compliant copy or on the clean golden fixture.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const failures = (l: OptimizedListing, c: GateContext = ctx): Failure[] =>
  runGate(l, pack, c).failures;
const on = (l: OptimizedListing, checkId: string, field?: string): Failure[] =>
  failures(l).filter((f) => f.checkId === checkId && (field === undefined || f.field === field));

// ---------------------------------------------------------------------------
// FIX B — normalization bypasses (homoglyph / zero-width / separator padding)
// ---------------------------------------------------------------------------
describe('FIX B — obfuscated banned terms no longer evade the scan', () => {
  it('normalize() folds Cyrillic look-alike letters to their Latin twin', () => {
    expect(normalize('Fights cаncer every day')).toBe('Fights cancer every day');
    expect(normalize('А diabеtes claim')).toBe('A diabetes claim');
  });

  it('normalize() strips zero-width and soft-hyphen characters', () => {
    expect(normalize('dia​betes')).toBe('diabetes');
    expect(normalize('can­cer')).toBe('cancer');
    expect(normalize('tu﻿mor')).toBe('tumor');
  });

  it('normalize() folds full-width / compatibility letters', () => {
    expect(normalize('ｃancer')).toBe('cancer');
  });

  it('normalize() keeps meaningful symbols intact (the style gate still sees them)', () => {
    expect(normalize('BrandX™ blend')).toContain('™');
  });

  it('collapseSeparators() joins single-letter runs but never real hyphenated words', () => {
    expect(collapseSeparators('c-a-n-c-e-r')).toBe('cancer');
    expect(collapseSeparators('d.i.a.b.e.t.e.s')).toBe('diabetes');
    expect(collapseSeparators('c a n c e r')).toBe('cancer');
    for (const safe of ['5-HTP', 'L-theanine', 'third-party tested', 'Non-GMO', '50 Billion CFU', '10-strain blend']) {
      expect(collapseSeparators(safe), safe).toBe(safe);
    }
  });

  it('bullets[0]: Cyrillic homoglyph "cаncer" now fails C6', () => {
    const l = mut((x) => { x.bullets[0] = 'Fights cаncer every day for adults*'; });
    expect(on(l, 'C6', 'bullets[0]').length).toBeGreaterThan(0);
  });

  it('description: zero-width space inside "dia​betes" now fails C6', () => {
    const l = mut((x) => { x.description = `Helps with dia​betes for adults.\n\n${x.fdaDisclaimer}`; });
    expect(on(l, 'C6', 'description').length).toBeGreaterThan(0);
  });

  it('itemHighlights: hyphen-padded "c-a-n-c-e-r" now fails C6', () => {
    const l = mut((x) => { x.itemHighlights = 'Daily support that helps with c-a-n-c-e-r for adults'; });
    expect(on(l, 'C6', 'itemHighlights').length).toBeGreaterThan(0);
  });

  it('qa: period-padded "d.i.a.b.e.t.e.s" now fails C6', () => {
    const l = mut((x) => { x.qa[0] = { ...x.qa[0]!, a: 'It helps with d.i.a.b.e.t.e.s control.' }; });
    expect(on(l, 'C6', 'qa[0].a').length).toBeGreaterThan(0);
  });

  it('A+ content is covered by the same folding (A2)', () => {
    const l = mut((x) => { x.aplusContent.faq[0] = { ...x.aplusContent.faq[0]!, a: 'It treats cаncer.' }; });
    expect(on(l, 'A2').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FIX C — C18 pattern holes
// ---------------------------------------------------------------------------
describe('FIX C — prohibited-content patterns that used to PASS', () => {
  const c18 = (text: string): Failure[] => on(mut((x) => { x.bullets[0] = text; }), 'C18', 'bullets[0]');

  it('bare domain without scheme or www fails', () => {
    expect(c18('Visit ourbrand.com for details on the blend').length).toBeGreaterThan(0);
    expect(c18('More at brandxlabs.shop today').length).toBeGreaterThan(0);
  });

  it('10-digit phone number with no separators fails', () => {
    expect(c18('Call 5551234567 for support with your order').length).toBeGreaterThan(0);
  });

  it('spelled-out currency fails', () => {
    expect(c18('Just nineteen dollars for a two month supply').length).toBeGreaterThan(0);
    expect(c18('Only fifty cents a serving of the blend').length).toBeGreaterThan(0);
  });

  it('half price / two for one / bogo fail', () => {
    expect(c18('Grab it at half price while you can').length).toBeGreaterThan(0);
    expect(c18('This is a two for one offer for adults').length).toBeGreaterThan(0);
    expect(c18('Our bogo deal runs all month for adults').length).toBeGreaterThan(0);
  });

  it('NO false positive: "Made in the U.S." and a bare decimal do not trip the domain rule', () => {
    const domainPattern = pack.rules.prohibitedContent!.patterns.find(([, label]) =>
      label.includes('bare domain'),
    )!;
    const re = new RegExp(domainPattern[0], 'gi');
    for (const safe of ['Made in the U.S.', 'Made in the USA', '19.95', 'A 2.4 ounce bottle', 'Third-party tested. Non-GMO.']) {
      re.lastIndex = 0;
      expect(re.test(safe), safe).toBe(false);
    }
  });

  it('NO false positive: compliant quality copy stays clean on C18', () => {
    const l = mut((x) => {
      x.bullets[0] = 'Quality you can verify: Third-party tested, Non-GMO and gluten free, made in the USA in a cGMP facility';
    });
    expect(on(l, 'C18', 'bullets[0]')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX D — ALL-CAPS evasion via short words / allow-listed acronyms
// ---------------------------------------------------------------------------
describe('FIX D — shouting RUNS of ALL-CAPS words fail C17', () => {
  it('"NEW BIG WOW gut support" fails even though every word is under the length rule', () => {
    const l = mut((x) => { x.itemHighlights = 'NEW BIG WOW gut support for women and men'; });
    expect(on(l, 'C17', 'itemHighlights').length).toBeGreaterThan(0);
  });

  it('"SAME NON USA GABA blend" fails — the allowlist does not apply inside a run', () => {
    const l = mut((x) => { x.itemHighlights = 'SAME NON USA GABA blend for adults'; });
    expect(on(l, 'C17', 'itemHighlights').length).toBeGreaterThan(0);
  });

  it('a shouting run inside a bullet fails', () => {
    const l = mut((x) => { x.bullets[0] = 'BUY MORE NOW: our blend supports digestive balance for adults*'; });
    expect(on(l, 'C17', 'bullets[0]').length).toBeGreaterThan(0);
  });

  it('NO false positive: legitimate acronym usage still passes', () => {
    for (const text of [
      'Digestive balance support: a 50 Billion CFU blend of 10 strains for adults*',
      'Calm routine support: GABA and 5-HTP pair with the blend for evening use*',
      'Quality first: Made in the USA in a cGMP facility and NSF certified for adults*',
    ]) {
      const l = mut((x) => { x.bullets[0] = text; });
      expect(on(l, 'C17', 'bullets[0]'), text).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX E — title word repetition (documented in the pack, never enforced)
// ---------------------------------------------------------------------------
describe('FIX E — C1 enforces the pack title word-repetition rule', () => {
  it('a title repeating "sleep" 3x fails C1', () => {
    const l = mut((x) => {
      x.title = 'BrandX Sleep Supplement, Sleep Support Blend for Deep Sleep, 60 Vegan Capsules';
    });
    const f = on(l, 'C1', 'title');
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((y) => y.context.includes('sleep'))).toBe(true);
  });

  it('stopwords are exempt (repeating "for"/"and" is fine)', () => {
    const l = mut((x) => {
      x.title = 'BrandX Probiotic for Women and for Men and for Adults, 60 Vegan Capsules';
    });
    expect(on(l, 'C1', 'title')).toEqual([]);
  });

  it('matching is stemmed (capsule / capsules count together)', () => {
    const l = mut((x) => {
      x.title = 'BrandX Capsule Probiotic Capsules Blend, Vegan Capsule Count, 60 Units';
    });
    expect(on(l, 'C1', 'title').length).toBeGreaterThan(0);
  });

  it('the golden title passes the repetition rule', () => {
    expect(on(clean, 'C1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX G — smaller items
// ---------------------------------------------------------------------------
describe('FIX G1 — staleness takes the MIN across time-sensitive rules', () => {
  const base = pack.rules;

  it('an old time-sensitive rule makes the snapshot stale even with a fresh header', () => {
    const rules: RuleSet = {
      ...base,
      verifiedAsOf: '2026-07-29',
      staleAfterDays: 90,
      rules: [
        { id: 'fresh-non-sensitive', description: '', value: 1, timeSensitive: false },
        { id: 'title75', description: '', value: 75, timeSensitive: true, verifiedAsOf: '2026-01-01' },
      ],
    };
    const r = rulesStaleness(rules, new Date('2026-07-30T00:00:00Z'));
    expect(r.stale).toBe(true);
    expect(r.ageDays).toBeGreaterThan(90);
    expect(r.notice).toContain('title75');
    expect(r.notice).toContain('2026-01-01');
    expect(r.notice).toContain('does not affect the verify gate');
  });

  it('a NON-time-sensitive rule with an old date is ignored', () => {
    const rules: RuleSet = {
      ...base,
      verifiedAsOf: '2026-07-29',
      staleAfterDays: 90,
      rules: [{ id: 'old-static', description: '', value: 1, timeSensitive: false, verifiedAsOf: '2001-01-01' }],
    };
    expect(rulesStaleness(rules, new Date('2026-07-30T00:00:00Z')).stale).toBe(false);
  });

  it('a time-sensitive rule with no readable date fails safe (stale)', () => {
    const rules: RuleSet = {
      ...base,
      verifiedAsOf: '2026-07-29',
      rules: [{ id: 'undated', description: '', value: 1, timeSensitive: true }],
    };
    const r = rulesStaleness(rules, new Date('2026-07-30T00:00:00Z'));
    expect(r.stale).toBe(true);
    expect(r.notice).toContain('undated');
  });

  it('is never a gate failure', () => {
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });
});

describe('FIX G2 — repair ownership table', () => {
  const g = (field: string, checkId = 'C17') => fieldToGroup({ checkId, field, context: '', fix: '' });

  it('the code-inserted disclaimer field is NOT owned by the title group', () => {
    expect(g('fdaDisclaimer', 'C5')).toBeNull();
  });

  it('the unreachable PACK "compliance" matcher is gone', () => {
    expect(g('compliance', 'PACK')).toBeNull();
    expect(g('compliance', 'C5')).toBeNull();
  });

  it('every real field still maps to its owning group', () => {
    expect(g('title')).toBe('title');
    expect(g('bullets[0]')).toBe('bullets');
    expect(g('description')).toBe('description');
    expect(g('backendSearchTerms')).toBe('backend');
    expect(g('attributes.ingredients', 'C9')).toBe('attributes');
    expect(g('aplus.faq[0]', 'A2')).toBe('aplus');
    expect(g('imagePlan[0].notes', 'C6')).toBe('images');
    expect(g('qa[0].a', 'C6')).toBe('qa');
  });

  it('an unowned failure is LOGGED, never silently dropped', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { runRepairLoop } = await import('@/lib/engine/repair');
      const bad = mut((x) => { x.fdaDisclaimer = 'Wrong disclaimer text.'; });
      await runRepairLoop(snapshot, pack, mockLlm, ctx, 1, bad);
      const events = spy.mock.calls.map(([line]) => String(line));
      expect(events.some((e) => e.includes('repair.unowned_failure') && e.includes('fdaDisclaimer'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FIX G3 — the reparse log never embeds model output', () => {
  it('logs the error name + zod issue PATHS only', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const secret = 'SECRET_MODEL_TEXT_THAT_MUST_NOT_BE_LOGGED';
    const schema = z.object({ wanted: z.string() });
    try {
      await generateGroup(
        async () => JSON.stringify({ other: secret }),
        'unit-test-group',
        'system',
        'user',
        schema,
        256,
      );
    } catch {
      // expected: two failed parses
    }
    const lines = spy.mock.calls.map(([line]) => String(line));
    spy.mockRestore();
    const reparse = lines.find((l) => l.includes('llm.reparse'));
    expect(reparse).toBeTruthy();
    expect(reparse).not.toContain(secret);
    expect(reparse).not.toContain('detail');
    expect(reparse).toContain('issuePaths');
    expect(reparse).toContain('wanted');
  });
});

describe('FIX G4 — C12 also scans A+ text and attribute values', () => {
  it('a conflicting potency in an A+ FAQ answer fails C12', () => {
    const l = mut((x) => {
      x.aplusContent.faq[0] = { ...x.aplusContent.faq[0]!, a: 'Each bottle contains a 100 Billion CFU blend.' };
    });
    expect(on(l, 'C12', 'aplus.faq[0].a').length).toBeGreaterThan(0);
  });

  it('a conflicting potency in an A+ module body fails C12', () => {
    const l = mut((x) => {
      const hero = x.aplusContent.modules.find((m) => m.id === 'hero')!;
      hero.body = `${hero.body.replace('50 Billion CFU', '75 Billion CFU')}`;
    });
    expect(on(l, 'C12').some((f) => f.field.startsWith('aplus.modules'))).toBe(true);
  });

  it('a conflicting count in an attribute value fails C12', () => {
    const l = mut((x) => { x.attributes.size_name = '90 Count (Pack of 1)'; });
    expect(on(l, 'C12', 'attributes.size_name').length).toBeGreaterThan(0);
  });

  it('the comparison "typical" column is EXEMPT — it describes another product', () => {
    const l = mut((x) => {
      x.aplusContent.comparison.rows[2]!.typical = '30-count bottles, one month at 5 Billion CFU';
    });
    expect(on(l, 'C12').filter((f) => f.field.includes('typical'))).toEqual([]);
  });

  it('stays unit-anchored — a bare number in A+ or an attribute is ignored', () => {
    const l = mut((x) => {
      x.attributes.recommended_browse_nodes = '3774321';
      x.aplusContent.modules[0]!.body = `${x.aplusContent.modules[0]!.body} Founded in 1997.`;
    });
    expect(on(l, 'C12')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NO FALSE POSITIVES — compliant copy must stay green
// ---------------------------------------------------------------------------
describe('no false positives on legitimate compliant copy', () => {
  const SAFE = [
    'Gluten free and dairy free, made for sensitive routines every day',
    'A 50 Billion CFU blend of 10 strains supports healthy gut flora daily',
    'Each serving of the blend carries 500 mg of prebiotic fiber for adults',
    'Sixty vegetable capsules per bottle, one capsule daily with water',
    'Calm support: GABA pairs with the blend for an evening routine for adults',
    'Evening blend with 5-HTP and L-theanine for a steady wind-down routine',
    'Non-GMO and third-party tested for identity, potency and purity',
    'Made in the USA in a cGMP facility and NSF certified for quality',
    'Supports a healthy inflammatory response as part of a daily routine',
  ];

  for (const text of SAFE) {
    it(`bullet stays clean: "${text.slice(0, 46)}..."`, () => {
      const l = mut((x) => { x.bullets[0] = `${text}*`; });
      const f = failures(l).filter((y) => y.field === 'bullets[0]');
      expect(f, JSON.stringify(f)).toEqual([]);
    });
  }

  it('the verbatim disclaimer wording never trips the new rules', () => {
    const l = mut((x) => {
      x.description = `${x.productName} is a daily digestive support blend for adults.\n\nThese statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.`;
    });
    expect(failures(l).filter((y) => y.field === 'description')).toEqual([]);
  });

  it('THE GOLDEN FIXTURE still passes with ZERO failures', () => {
    const result = runGate(clean, pack, ctx);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the golden fixture passes against the UNION of every subcategory list', () => {
    const all = Object.keys(pack.compliancePack!.diseaseNounsBySubcategory);
    const result = runGate(clean, pack, { subcategories: all });
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Behavioural proof that the new rules are PACK-DRIVEN (no gate lexicon)
// ---------------------------------------------------------------------------
describe('the new rules are pack data, not gate literals', () => {
  const bare = (fn: (p: KnowledgePack) => void): KnowledgePack => {
    const copy = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    fn(copy);
    return copy;
  };

  it('emptying rules.units disarms C10/A5 potency phrasing and C12 entirely', () => {
    const p = bare((x) => {
      x.rules.units = { dimensions: {}, families: [], perServingPhrases: [], potencyVerbs: [], dosageForms: [] };
    });
    const l = mut((x) => {
      x.bullets[0] = 'Delivers 999 Billion CFU per serving in every capsule*';
      x.attributes.size_name = '90 Count (Pack of 1)';
    });
    const ids = runGate(l, p, ctx).failures.map((f) => f.checkId);
    expect(ids).not.toContain('C10');
    expect(ids).not.toContain('C12');
    expect(ids).not.toContain('A5');
  });

  it('emptying compliancePack.allergenFields/noAllergenPhrases disarms C9 and A7', () => {
    const p = bare((x) => {
      x.compliancePack!.allergenRules = [];
      x.compliancePack!.noAllergenPhrases = [];
    });
    const l = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin';
      x.attributes.allergen_information = 'No Known Allergens';
    });
    const ids = runGate(l, p, ctx).failures.map((f) => f.checkId);
    expect(ids).not.toContain('C9');
    expect(ids).not.toContain('A7');
    // ...and the SAME listing fails loudly against the real pack.
    expect(runGate(l, pack, ctx).failures.map((f) => f.checkId)).toContain('C9');
  });

  it('emptying rules.titleWordRepetition disarms the repetition rule', () => {
    const p = bare((x) => { x.rules.titleWordRepetition = { max: 0, stopwords: [] }; });
    const l = mut((x) => { x.title = 'BrandX Sleep Sleep Sleep Support Blend, 60 Vegan Capsules'; });
    expect(runGate(l, p, ctx).failures.filter((f) => f.checkId === 'C1')).toEqual([]);
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C1')).toBe(true);
  });
});
