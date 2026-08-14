import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';

/**
 * RED TEAM — every bypass here was PROVEN to pass the shipped gate.
 * Each case must now FAIL with a named checkId, and the "no false positives"
 * block proves the tightened rules never fire on legitimate compliant copy.
 *
 * Nothing in this file mutates content to force a pass: it asserts the gate's
 * REPORT on adversarial fixtures.
 */

const pack = loadPack('supplements');
const cp = pack.compliancePack!;
const disclaimer = cp.disclaimer;
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  // Keep the parallel claim-bearing flags coherent with the rewritten text.
  return withCoherentBulletFlags(copy);
};
const failures = (l: OptimizedListing, c: GateContext = ctx): Failure[] =>
  runGate(l, pack, c).failures;
const idsOf = (l: OptimizedListing, c: GateContext = ctx): string[] =>
  failures(l, c).map((f) => f.checkId);
/** Failures reported against ONE field — used to prove no false positives. */
const fieldFailures = (l: OptimizedListing, field: string, c: GateContext = ctx): Failure[] =>
  failures(l, c).filter((f) => f.field === field);

// ---------------------------------------------------------------------------
// FIX 1 — negation-guard laundering ("No fillers … treats cancer")
// ---------------------------------------------------------------------------
describe('FIX 1 — a negation cue no longer launders a real drug claim', () => {
  it('bullets[0]: "No fillers or binders, this blend treats cancer and reverses diabetes fast*" fails C6', () => {
    const l = mut((x) => {
      x.bullets[0] = 'No fillers or binders, this blend treats cancer and reverses diabetes fast*';
    });
    const f = failures(l).filter((y) => y.checkId === 'C6' && y.field === 'bullets[0]');
    expect(f.length).toBeGreaterThan(0);
  });

  it('bullets[0]: "Not a drug or medicine, our daily blend is clinically shown to help with cancer recovery*" fails C6', () => {
    const l = mut((x) => {
      x.bullets[0] =
        'Not a drug or medicine, our daily blend is clinically shown to help with cancer recovery*';
    });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toBe(true);
  });

  it('description: "No soy and no gluten. It relieves arthritis pain." fails C6', () => {
    const l = mut((x) => {
      x.description = `No soy and no gluten. It relieves arthritis pain.\n\n${disclaimer}`;
    });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'description')).toBe(true);
  });

  it('qa[0].a: "We never cut corners. This supplement treats IBS and colitis." fails C6', () => {
    const l = mut((x) => {
      x.qa[0] = { ...x.qa[0]!, a: 'We never cut corners. This supplement treats IBS and colitis.' };
    });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'qa[0].a')).toBe(true);
  });

  it('itemHighlights: "Gluten free with no artificial fillers, this formula helps prevent migraines" fails C6', () => {
    const l = mut((x) => {
      x.itemHighlights = 'Gluten free with no artificial fillers, this formula helps prevent migraines';
    });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'itemHighlights')).toBe(true);
  });

  it('the same laundering fails inside A+ content too (A2)', () => {
    const l = mut((x) => {
      x.aplusContent.modules[1] = {
        ...x.aplusContent.modules[1]!,
        body: `No fillers or binders, this blend treats cancer and reverses diabetes.\n\n${disclaimer}`,
      };
    });
    expect(idsOf(l)).toContain('A2');
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — attributes + imagePlan.purpose/spec are scanned by C17/C18/C6
// ---------------------------------------------------------------------------
describe('FIX 2 — attribute values and every image-plan field are scanned', () => {
  const attrCase = (value: string): OptimizedListing =>
    mut((x) => {
      x.attributes = { ...x.attributes, special_ingredients: value };
    });

  it('attributes: a price fails C18', () => {
    const f = failures(attrCase('Best value at $19.95 each'));
    expect(f.some((y) => y.checkId === 'C18' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('attributes: a URL fails C18', () => {
    const f = failures(attrCase('See https://ourbrand.com/offers'));
    expect(f.some((y) => y.checkId === 'C18' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('attributes: a phone number fails C18', () => {
    const f = failures(attrCase('Call 555-123-4567'));
    expect(f.some((y) => y.checkId === 'C18' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('attributes: ALL-CAPS emphasis fails C17', () => {
    const f = failures(attrCase('AMAZING POWERFUL BLEND'));
    expect(f.some((y) => y.checkId === 'C17' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('attributes: a ™ symbol fails C17', () => {
    const f = failures(attrCase('GutBlend™ formula'));
    expect(f.some((y) => y.checkId === 'C17' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('attributes: an ASIN fails C17', () => {
    const f = failures(attrCase('See B0ABCDEFGH for refill'));
    expect(f.some((y) => y.checkId === 'C17' && y.field === 'attributes.special_ingredients')).toBe(true);
  });

  it('imagePlan[0].purpose: an overlay price fails C18', () => {
    const l = mut((x) => { x.imagePlan[0] = { ...x.imagePlan[0]!, purpose: 'Overlay text: $19.95 value' }; });
    expect(failures(l).some((y) => y.checkId === 'C18' && y.field === 'imagePlan[0].purpose')).toBe(true);
  });

  it('imagePlan[0].purpose: an ALL-CAPS banner fails C17', () => {
    const l = mut((x) => { x.imagePlan[0] = { ...x.imagePlan[0]!, purpose: 'BIGGEST SAVINGS OVERLAY BANNER' }; });
    expect(failures(l).some((y) => y.checkId === 'C17' && y.field === 'imagePlan[0].purpose')).toBe(true);
  });

  it('imagePlan[0].spec: a URL fails C18', () => {
    const l = mut((x) => { x.imagePlan[0] = { ...x.imagePlan[0]!, spec: 'Show https://ourbrand.com on pack' }; });
    expect(failures(l).some((y) => y.checkId === 'C18' && y.field === 'imagePlan[0].spec')).toBe(true);
  });

  it('brand_name is no longer exempt from the C6 disease scan', () => {
    const l = mut((x) => { x.attributes = { ...x.attributes, brand_name: 'CuresCancer Labs treats diabetes' }; });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'attributes.brand_name')).toBe(true);
  });

  it('manufacturer is no longer exempt from the C6 disease scan', () => {
    const l = mut((x) => { x.attributes = { ...x.attributes, manufacturer: 'Labs that cure arthritis LLC' }; });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'attributes.manufacturer')).toBe(true);
  });

  it('C7 brand-leakage logic still works independently', () => {
    const l = mut((x) => {
      x.attributes = { ...x.attributes, brand_name: 'SecretBackendBrand' };
      x.bullets[1] = 'Made by SecretBackendBrand in a cGMP facility in the USA';
    });
    expect(idsOf(l)).toContain('C7');
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — superlativeBans / prohibited marketing gated OUTSIDE A+
// ---------------------------------------------------------------------------
describe('FIX 3 — prohibited marketing is gated on every surface (C19)', () => {
  const cases: string[] = [
    '100% money back guarantee',
    '#1 best seller in gut health',
    'Buy now while supplies last',
    'Subscribe and save on every order',
    'Limited time offer today only',
    'Rated 5 star by 10,000 reviews',
    'Clinically proven maximum strength',
    'FDA approved formula',
    'Miracle breakthrough cure',
    'The only probiotic you will ever need',
  ];

  for (const phrase of cases) {
    it(`bullet: "${phrase}" fails C19`, () => {
      const l = mut((x) => { x.bullets[0] = phrase; });
      expect(failures(l).some((y) => y.checkId === 'C19' && y.field === 'bullets[0]')).toBe(true);
    });

    it(`description: "${phrase}" fails C19`, () => {
      const l = mut((x) => { x.description = `${phrase}\n\n${disclaimer}`; });
      expect(failures(l).some((y) => y.checkId === 'C19' && y.field === 'description')).toBe(true);
    });
  }

  it('a Q&A answer carrying a guarantee fails C19', () => {
    const l = mut((x) => { x.qa[0] = { ...x.qa[0]!, a: 'Yes — 100% money back guarantee on every bottle.' }; });
    expect(failures(l).some((y) => y.checkId === 'C19' && y.field === 'qa[0].a')).toBe(true);
  });

  it('an attribute value carrying a rank claim fails C19', () => {
    const l = mut((x) => { x.attributes = { ...x.attributes, product_benefit: 'Number one best seller' }; });
    expect(failures(l).some((y) => y.checkId === 'C19' && y.field === 'attributes.product_benefit')).toBe(true);
  });

  it('an image-plan purpose carrying urgency fails C19', () => {
    const l = mut((x) => { x.imagePlan[1] = { ...x.imagePlan[1]!, purpose: 'Limited time badge' }; });
    expect(failures(l).some((y) => y.checkId === 'C19' && y.field === 'imagePlan[1].purpose')).toBe(true);
  });

  it('A8 still fires on A+ content, reading the SAME pack lexicon', () => {
    const l = mut((x) => {
      x.aplusContent.modules[1] = { ...x.aplusContent.modules[1]!, headline: 'Buy now — today only' };
    });
    expect(idsOf(l)).toContain('A8');
  });

  it('the marketing lexicon is PACK DATA — emptying it disarms A8 and C19', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as typeof pack;
    bare.rules.prohibitedMarketing = { patterns: [], surfaces: [] };
    bare.compliancePack!.superlativeBans = [];
    const l = mut((x) => { x.bullets[0] = '#1 best seller, buy now, money back guarantee'; });
    const ids = runGate(l, bare, ctx).failures.map((f) => f.checkId);
    expect(ids).not.toContain('C19');
    expect(ids).not.toContain('A8');
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — disease-lexicon holes
// ---------------------------------------------------------------------------
describe('FIX 4 — previously missing condition terms are now caught', () => {
  const coreTerms = [
    'anxiety', 'high blood pressure', 'high cholesterol', 'acne', 'gout', 'osteoarthritis',
    'hypothyroidism', 'anemia', 'erectile dysfunction', 'hair loss', 'fatty liver',
    'enlarged prostate', 'prostate enlargement', 'migraine', 'migraines', 'insomnia',
    'IBS', 'colitis', 'flu',
  ];
  for (const term of coreTerms) {
    it(`"Daily support that ${term}*" fails C6`, () => {
      const l = mut((x) => { x.bullets[0] = `Daily support that ${term}*`; });
      expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toBe(true);
    });
  }

  /**
   * ROUND-6 REVISION. "menopause"/"perimenopause" are enumerated NATURAL STATES
   * under 21 CFR 101.93(g), not diseases: "for women in menopause" is a lawful
   * structure/function claim, and blocking it blocked a whole lawful segment.
   * They moved to the ACTION-PAIRED tier — they fail only when a
   * therapeutic-action verb sits in the same sentence.
   */
  it('"menopause" paired with a therapeutic-action verb is still caught', () => {
    const l = mut((x) => { x.bullets[0] = 'Daily support that cures menopause*'; });
    const womens: GateContext = { subcategories: ['womens'] };
    expect(failures(l, womens).some((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toBe(true);
  });

  it('"menopause" as a lawful natural-state reference is NOT caught', () => {
    const l = mut((x) => { x.bullets[0] = 'Formulated for women in perimenopause and menopause*'; });
    const womens: GateContext = { subcategories: ['womens'] };
    expect(failures(l, womens).filter((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toEqual([]);
  });

  /**
   * ROUND-5 REVISION. Bare "bloating" was removed from the lexicon: it is a
   * SYMPTOM word, and "helps with occasional bloating" is exactly the
   * structure/function phrasing DSHEA permits — blocking it made the tool
   * unusable on ordinary digestive copy. The DISEASE compound is what is
   * enforced.
   */
  it('"chronic bloating" is caught for a digestive product', () => {
    const l = mut((x) => { x.bullets[0] = 'Daily support that chronic bloating*'; });
    expect(failures(l).some((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toBe(true);
  });

  it('bare "occasional bloating" is NOT a violation (round-5 false-positive fix)', () => {
    const l = mut((x) => { x.bullets[0] = 'Helps reduce occasional bloating and gas*'; });
    expect(failures(l).filter((y) => y.checkId === 'C6' && y.field === 'bullets[0]')).toEqual([]);
  });

  it('every subcategory disease-noun list stays non-empty (fail-closed contract)', () => {
    for (const [sub, list] of Object.entries(cp.diseaseNounsBySubcategory)) {
      expect(list.length, `subcategory '${sub}'`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// NO FALSE POSITIVES — legitimate compliant copy must still pass
// ---------------------------------------------------------------------------
describe('no false positives — legitimate copy still passes', () => {
  it('the clean golden fixture passes with ZERO failures', () => {
    const result = runGate(clean, pack, ctx);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the clean golden fixture passes against the UNION of every subcategory list', () => {
    const all = Object.keys(cp.diseaseNounsBySubcategory);
    expect(runGate(clean, pack, { subcategories: all }).failures).toEqual([]);
  });

  it('the verbatim FDA disclaimer is clean on any surface', () => {
    const l = mut((x) => { x.qa[0] = { ...x.qa[0]!, a: disclaimer }; });
    expect(fieldFailures(l, 'qa[0].a')).toEqual([]);
  });

  it('"not intended to diagnose, treat, cure, or prevent any disease" as FREE TEXT is clean', () => {
    const l = mut((x) => {
      x.description = `${x.productName} is a daily blend. This product is not intended to diagnose, treat, cure, or prevent any disease.\n\n${disclaimer}`;
    });
    expect(fieldFailures(l, 'description')).toEqual([]);
  });

  it('"Gluten free and dairy free formula" is clean', () => {
    const l = mut((x) => { x.bullets[0] = 'Label detail: gluten free and dairy free formula'; });
    expect(fieldFailures(l, 'bullets[0]')).toEqual([]);
  });

  it('"Supports a healthy inflammatory response" is clean', () => {
    const l = mut((x) => { x.bullets[0] = 'Label detail: supports a healthy inflammatory response'; });
    expect(fieldFailures(l, 'bullets[0]')).toEqual([]);
  });

  it('"No artificial dyes or fillers*" is clean', () => {
    const l = mut((x) => { x.bullets[0] = 'Label detail: no artificial dyes or fillers*'; });
    expect(fieldFailures(l, 'bullets[0]')).toEqual([]);
  });

  it('an image brief saying "No star ratings and no unsubstantiated claims" is clean', () => {
    const l = mut((x) => {
      x.imagePlan[1] = { ...x.imagePlan[1]!, notes: 'No star ratings and no unsubstantiated claims' };
    });
    expect(fieldFailures(l, 'imagePlan[1].notes')).toEqual([]);
  });

  it('legitimate attribute values never trip the new attribute scan', () => {
    const legit = [
      '50 Billion CFU',
      '500 mg',
      '60 capsules',
      'Contains: Tree Nuts (Almond)',
      'Vegan; Non-GMO; Gluten Free',
    ];
    for (const value of legit) {
      const l = mut((x) => { x.attributes = { ...x.attributes, special_ingredients: value }; });
      expect(
        fieldFailures(l, 'attributes.special_ingredients'),
        `attribute value '${value}' must not fail`,
      ).toEqual([]);
    }
  });

  it('legitimate image-plan purposes/specs never trip the new image scan', () => {
    for (const [i, slot] of clean.imagePlan.entries()) {
      expect(fieldFailures(clean, `imagePlan[${i}].purpose`), slot.purpose).toEqual([]);
      expect(fieldFailures(clean, `imagePlan[${i}].spec`), slot.spec).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// END-TO-END — a listing stacking six violations can never be verified
// ---------------------------------------------------------------------------
describe('end-to-end: a stacked-violation listing is never verified', () => {
  it('six violations across six surfaces ⇒ pass:false and buildAudit().verified === false', () => {
    const bad = mut((x) => {
      // 1 — laundered drug claim in a bullet (C6)
      x.bullets[0] = 'No fillers or binders, this blend treats cancer and reverses diabetes fast*';
      // 2 — laundered disease claim in the description (C6)
      x.description = `No soy and no gluten. It relieves arthritis pain.\n\n${disclaimer}`;
      // 3 — prohibited marketing in Q&A (C19)
      x.qa[0] = { ...x.qa[0]!, a: 'Yes — 100% money back guarantee, the only probiotic you will ever need.' };
      // 4 — price + ALL-CAPS in an attribute (C18 + C17)
      x.attributes = { ...x.attributes, special_ingredients: 'BEST VALUE at $19.95 each' };
      // 5 — a URL in an image spec (C18)
      x.imagePlan[0] = { ...x.imagePlan[0]!, spec: 'Show https://ourbrand.com on pack' };
      // 6 — a newly-covered disease term in item highlights (C6)
      x.itemHighlights = 'Gluten free with no artificial fillers, this formula helps prevent migraines';
    });

    const gate = runGate(bad, pack, ctx);
    expect(gate.pass).toBe(false);
    const ids = new Set(gate.failures.map((f) => f.checkId));
    expect([...ids]).toEqual(expect.arrayContaining(['C6', 'C17', 'C18', 'C19']));

    const audit = buildAudit(snapshot, bad, pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.verified).toBe(audit.gateResult.pass);
  });
});
