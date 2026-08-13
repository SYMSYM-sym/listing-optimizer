import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { buildFacts, extractUnitCount } from '@/lib/engine/facts';
import { styleRulesBlock } from '@/lib/engine/prompts';
import { runGate } from '@/lib/gate/runGate';
import { c23AttributeCompleteness, type GateContext } from '@/lib/gate/checks';
import { buildAudit } from '@/lib/audit/buildAudit';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * FORENSIC REGRESSIONS — a real production run (an oral/dental supplement,
 * ASIN B00WNDG7V8) came back `verified:false` on FIVE false positives while
 * THREE real compliance misses passed clean. Every root cause is closed here,
 * and every fix is asserted in BOTH directions: the false positive is gone AND
 * the real violation the same mechanism guards still fails. Over-blocking is a
 * defect of the same severity as a bypass.
 *
 *  FIX 1 — no oral/dental lexicon: "halitosis remedy" backend terms and a
 *          "gum and cavity defense" highlight passed clean.
 *  FIX 2 — C12 conflated the "N-in-1" marketing number (formulaCount) with the
 *          container count, and facts never read "…, 120 Capsules" from the
 *          title, so the truthful "120 Count" attribute was failed.
 *  FIX 3 — C17 flagged the registered strain trademark BLIS.
 *  FIX 4 — C22 flagged the mandated consult-a-physician safety warning.
 *  FIX 6 — 29/35 schema attributes shipped with no signal (C23 now enforces).
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

const failuresOf = (l: OptimizedListing): Failure[] => runGate(l, pack, ctx).failures;
const byCheck = (l: OptimizedListing, checkId: string): Failure[] =>
  failuresOf(l).filter((f) => f.checkId === checkId);
const onField = (l: OptimizedListing, field: string): Failure[] =>
  failuresOf(l).filter((f) => f.field === field);

// ===========================================================================
// FIX 1 — ORAL/DENTAL lexicon + subcategory
// ===========================================================================

describe('FIX 1 — the oral/dental disease lexicon exists and is enforced', () => {
  it('the exact live backend string ("… halitosis remedy …") now FAILS C6 on backendSearchTerms', () => {
    const l = mut((x) => {
      x.backendSearchTerms =
        'aliento boca fresca tonsil stones halitosis remedy natural herbal blend vitamins minerals';
    });
    const hits = byCheck(l, 'C6').filter((f) => f.field === 'backendSearchTerms');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((f) => f.fix).join(' ')).toContain('halitosis');
  });

  it('the live highlight "gum and cavity defense" now FAILS C6', () => {
    const l = mut((x) => {
      x.itemHighlights = 'gum and cavity defense';
    });
    const hits = byCheck(l, 'C6').filter((f) => f.field === 'itemHighlights');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((f) => f.fix).join(' ')).toContain('cavity');
  });

  it.each([
    'Fights gingivitis and periodontal disease',
    'Prevents cavities and tooth decay',
    'Clears oral thrush in days',
    'Helps with canker sores and mouth ulcers',
    'Support for bruxism and tmj',
  ])('the oral disease claim "%s" fails C6', (text) => {
    const l = mut((x) => {
      x.bullets[1] = text;
    });
    expect(byCheck(l, 'C6').filter((f) => f.field === 'bullets[1]').length).toBeGreaterThan(0);
  });

  /** Lawful oral structure/function copy must stay clean on every surface class. */
  const LAWFUL: string[] = [
    'Supports healthy gums',
    'Fresh breath support',
    'Supports a healthy oral microbiome',
    'Removes the plaque from your teeth',
    'Supports normal tooth surface upkeep',
    'Supports comfortable sinus cavities during seasonal changes',
    'Formulated for the oral cavity and a balanced mouth environment',
  ];
  const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
    ['bullets[0]', (l, s) => { l.bullets[0] = `Good to know: ${s}`; }],
    ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
    ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
    ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
  ];
  for (const text of LAWFUL) {
    for (const [field, plant] of SURFACES) {
      it(`lawful copy "${text}" stays clean on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(onField(l, field)).toEqual([]);
      });
    }
  }

  it('DOCUMENTED DECISION: bare "cavity" outside an anatomy span is a dental disease noun and fails', () => {
    // "sinus cavity" / "oral cavity" etc. are benignContextPhrases (anatomy
    // spans); everywhere else the bare noun is tooth decay and is enforced.
    const l = mut((x) => {
      x.bullets[1] = 'Cavity protection for daily use';
    });
    expect(byCheck(l, 'C6').filter((f) => f.field === 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('detection routes a dental supplement to the oral subcategory', () => {
    const s2 = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
    s2.title = 'BrandX Oral Complete Dental Support for Teeth and Gums, 120 Capsules';
    const d = detectCategory(s2);
    expect(d.packId).toBe('supplements');
    expect(d.subcategories).toContain('oral');
  });

  describe('FIX 1c — "remedy"/"remedies" are treatment-claim words', () => {
    it.each([
      'A natural remedy for menopause',
      'The daily menopause remedy women trust',
      'A natural remedy for gum disease',
      'Herbal remedies for halitosis',
    ])('"%s" fails the gate', (text) => {
      const l = mut((x) => {
        x.bullets[1] = text;
      });
      const hits = failuresOf(l).filter(
        (f) => f.field === 'bullets[1]' && (f.checkId === 'C6' || f.checkId === 'C22'),
      );
      expect(hits.length).toBeGreaterThan(0);
    });

    it('DOCUMENTED DECISION: bare "remedy" with no disease or condition noun stays lawful', () => {
      // "home remedy" heritage copy names nothing to treat; the word becomes a
      // violation only when paired with a disease noun (C6), a condition
      // (action-paired tier) or a natural state (C22 R3).
      const l = mut((x) => {
        x.bullets[1] = 'A traditional home remedy passed down for generations';
      });
      expect(onField(l, 'bullets[1]')).toEqual([]);
    });
  });
});

// ===========================================================================
// FIX 2 — facts extraction + formulaCount/container-count separation (C12)
// ===========================================================================

describe('FIX 2 — C12 no longer conflates formulaCount with the container count', () => {
  const countUnits: string[] = pack.rules.units.dimensions?.count ?? [];

  /** Every direct container-count figure restated at `n` (falsePositives helper). */
  const countsAt = (l: OptimizedListing, n: number): OptimizedListing =>
    JSON.parse(
      JSON.stringify(l).replace(/\b60\b(?=[\s-]?(?:capsules?|count))/gi, String(n)),
    ) as OptimizedListing;

  /** The exact live shape: facts {price, formulaCount:11}; truthful 120-count attributes. */
  const liveShape = (): OptimizedListing => {
    const l = countsAt(clean, 120);
    l.facts = { price: clean.facts.price, formulaCount: 11 };
    l.attributes.unit_count = '120';
    l.attributes.servings_per_container = '120';
    l.attributes.size_name = '120 Count';
    return l;
  };

  it('the exact live case (facts {price, formulaCount: 11}, "120 Count" attributes) → ZERO C12', () => {
    expect(byCheck(liveShape(), 'C12')).toEqual([]);
  });

  it('a genuine conflict still fails: facts.unitCount=60 vs "120 Count"', () => {
    const l = liveShape();
    l.facts.unitCount = 60;
    const hits = byCheck(l, 'C12');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((f) => f.field).join(' ')).toContain('attributes.size_name');
  });

  it('"11-in-1" with "11 formulas" copy is consistent alongside a 120 container count', () => {
    const l = liveShape();
    l.bullets[0] =
      'Complete 11-in-1 blend: 11 formulas working together in one simple daily routine*';
    expect(byCheck(l, 'C12')).toEqual([]);
  });

  it('title tail "…, 120 Capsules" now yields facts.unitCount = 120 (and formulaCount stays separate)', () => {
    const s2 = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
    delete s2.attributes.unit_count;
    s2.title = 'BrandX Oral Complete 11-in-1 Dental Support Blend, 120 Capsules';
    const facts = buildFacts(s2, pack);
    expect(facts.unitCount).toBe(120);
    expect(facts.formulaCount).toBe(11);
  });

  it.each([
    ['BrandX Dental Support, 120 Count', 120],
    ['BrandX Dental Support, 120 ct', 120],
    ['BrandX Dental Support, 120 Tablets', 120],
  ])('title "%s" yields facts.unitCount = %i', (title, expected) => {
    const s2 = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
    delete s2.attributes.unit_count;
    s2.title = title;
    expect(buildFacts(s2, pack).unitCount).toBe(expected);
  });

  it('a snapshot ATTRIBUTE carrying "120 Count" yields facts.unitCount = 120', () => {
    const s2 = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
    delete s2.attributes.unit_count;
    s2.title = 'BrandX Oral Complete Dental Support';
    s2.attributes.size_name = '120 Count (Pack of 1)';
    expect(buildFacts(s2, pack).unitCount).toBe(120);
  });

  it('servings_per_container in the snapshot still populates facts.servings', () => {
    const s2 = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
    s2.attributes.servings_per_container = '120';
    expect(buildFacts(s2, pack).servings).toBe(120);
  });

  it('serving-size phrasing can never masquerade as the container count', () => {
    expect(extractUnitCount('Take 2 Capsules Daily', countUnits)).toBeUndefined();
    expect(extractUnitCount('2 Capsules Daily Strength, 120 Capsules', countUnits)).toBe(120);
    expect(extractUnitCount('No figures here at all', countUnits)).toBeUndefined();
  });
});

// ===========================================================================
// FIX 3 — C17: registered ingredient/strain trademarks
// ===========================================================================

describe('FIX 3 — strain/ingredient trademarks are not shouting', () => {
  it('"BLIS K12" is clean in description, attributes and bullets', () => {
    const l = mut((x) => {
      x.description = `${x.description} Featuring BLIS K12, the registered Streptococcus salivarius K12 strain.`;
      x.attributes.active_ingredients = `${x.attributes.active_ingredients}; BLIS K12; BC30; LP299V; HN019; MENAQ7`;
      x.bullets[1] = 'Featuring BLIS K12: a premium strain chosen for daily fresh breath support';
    });
    expect(byCheck(l, 'C17')).toEqual([]);
  });

  it('genuine shouting still fails C17', () => {
    const l = mut((x) => {
      x.bullets[1] = 'AMAZING POWERFUL BLEND for daily support';
    });
    expect(byCheck(l, 'C17').filter((f) => f.field === 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the style block teaches the allowlist AND registered-casing preservation', () => {
    const block = styleRulesBlock(pack.rules.style);
    expect(block).toContain('BLIS');
    expect(block).toContain('registered casing');
  });
});

// ===========================================================================
// FIX 4 — C22: mandated safety warnings are never claims
// ===========================================================================

describe('FIX 4 — the consult-a-professional advisory never trips C22', () => {
  const WARNING =
    'Women who are pregnant or nursing, and anyone currently taking medication or managing a health concern, should talk with a physician before adding any new daily capsule to their routine.';
  const PARAPHRASES = [
    'Please consult your healthcare provider if you are pregnant, nursing, managing a condition, or taking medication.',
    'If you are pregnant or nursing, speak with your doctor before use.',
    'Nursing mothers, and anyone managing a health concern, should check with a doctor first.',
    'Before use, anyone managing a health concern, and women who are pregnant or nursing, should seek the advice of a pharmacist.',
  ];

  const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
    ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
    ['qa', (l, s) => { l.qa[0] = { q: 'Is it safe for everyone?', a: s, claimBearing: false }; }],
    ['aplus', (l, s) => { l.aplusContent.faq[0] = { q: 'Is it safe for everyone?', a: s, claimBearing: false }; }],
  ];

  for (const [surface, plant] of SURFACES) {
    it(`the exact live warning is clean on ${surface} (zero C22)`, () => {
      const l = mut((x) => plant(x, WARNING));
      expect(byCheck(l, 'C22')).toEqual([]);
    });
  }

  it.each(PARAPHRASES)('paraphrase "%s" is clean (zero C22)', (text) => {
    const l = mut((x) => {
      x.description = `${x.description} ${text}`;
    });
    expect(byCheck(l, 'C22')).toEqual([]);
  });

  it('DECIDED: "Manages menopause symptoms in six weeks" still fails (C6 action-paired + C22)', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Manages menopause symptoms in six weeks';
    });
    expect(byCheck(l, 'C6').length).toBeGreaterThan(0);
    expect(byCheck(l, 'C22').length).toBeGreaterThan(0);
  });

  it('DECIDED: "This formula treats nursing mothers\' fatigue" still fails C22 (therapeutic action on a natural state)', () => {
    const l = mut((x) => {
      x.description = `${x.description} This formula treats nursing mothers' fatigue.`;
    });
    expect(byCheck(l, 'C22').length).toBeGreaterThan(0);
  });

  it('the advisory cannot LAUNDER a claim: "Reverses aging, talk to your doctor today" fails C22', () => {
    const l = mut((x) => {
      x.description = `${x.description} Reverses aging, talk to your doctor today.`;
    });
    expect(byCheck(l, 'C22').length).toBeGreaterThan(0);
  });

  it('the advisory cannot launder the action-paired tier either', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Manages menopause symptoms, so talk with your physician today';
    });
    expect(byCheck(l, 'C6').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FIX 6 — C23 attribute completeness
// ===========================================================================

describe('FIX 6 — C23 enforces attribute completeness', () => {
  it('the complete golden listing passes C23 (and the whole gate)', () => {
    expect(byCheck(clean, 'C23')).toEqual([]);
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });

  it('a missing REQUIRED field fails C23 and is named', () => {
    const l = mut((x) => {
      delete x.attributes.country_of_origin;
    });
    const hits = byCheck(l, 'C23');
    expect(hits.length).toBe(1);
    expect(hits[0]!.field).toBe('attributes.country_of_origin');
    expect(hits[0]!.fix).toContain('country_of_origin');
  });

  it('a blank required value counts as missing', () => {
    const l = mut((x) => {
      x.attributes.item_form = '   ';
    });
    expect(byCheck(l, 'C23').map((f) => f.field)).toContain('attributes.item_form');
  });

  it('a missing FILTER-FACET field fails C23 even though the schema marks it optional', () => {
    const l = mut((x) => {
      delete x.attributes.fulfillment_channel; // filterFacet: true, required: false
    });
    const hits = byCheck(l, 'C23');
    expect(hits.map((f) => f.field)).toContain('attributes.fulfillment_channel');
    expect(hits[0]!.fix).toContain('filter facet');
  });

  it('a missing OPTIONAL non-facet field is an audit GAP, never a gate failure', () => {
    const l = mut((x) => {
      delete x.attributes.flavor_name; // required: false, filterFacet: false
    });
    expect(byCheck(l, 'C23')).toEqual([]);
    const audit = buildAudit(snapshot, l, pack, ctx);
    expect(audit.verified).toBe(true);
    expect(
      audit.gaps.some((g) => `${g.proposed}`.includes('flavor_name')),
    ).toBe(true);
  });

  it('the mock (and therefore the policy) fills inapplicable fields with the explicit none-style value', () => {
    expect(clean.attributes.flavor_name).toBe('Unflavored');
    expect(clean.attributes.scent_name).toBe('Unscented');
  });

  it('every one of the six fields the live run dropped is now either enforced or gap-reported', () => {
    const l = mut((x) => {
      for (const field of ['item_weight', 'flavor_name', 'scent_name', 'standard_price', 'subject_keyword', 'maximum_dosage']) {
        delete x.attributes[field];
      }
    });
    // none of the six is required/facet → no hard failure…
    expect(byCheck(l, 'C23')).toEqual([]);
    // …but the audit names every one of them.
    const audit = buildAudit(snapshot, l, pack, ctx);
    const gapText = audit.gaps.map((g) => `${g.proposed}`).join(' ');
    for (const field of ['item_weight', 'flavor_name', 'scent_name', 'standard_price', 'subject_keyword', 'maximum_dosage']) {
      expect(gapText).toContain(field);
    }
  });

  it('a pack with an EMPTY schema has no C23 rule (generic pack)', () => {
    expect(c23AttributeCompleteness(clean, loadPack('generic'))).toEqual([]);
  });
});
