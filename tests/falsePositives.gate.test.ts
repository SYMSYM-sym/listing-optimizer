import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * FALSE-POSITIVE REGRESSION GUARD (the file round 4 was missing).
 *
 * Round 4 closed real bypasses but shipped severe OVER-BLOCKING: short
 * abbreviations collided with units/honorifics/org names/currency codes and the
 * verb "add"; the concatenated pass manufactured phantom matches
 * (`routine and` -> `routineand` -> contains `tinea`); the doubled-letter pass
 * turned the 3-letter noun `add` into the 2-letter fragment `ad`; and several
 * symptom words that DSHEA structure/function copy is built on were treated as
 * diseases.
 *
 * Over-blocking is a defect of the same severity as under-blocking — a gate
 * that cannot process ordinary supplement copy is not a gate, it is a wall.
 * Every string below is legitimate marketing/label copy and must produce ZERO
 * failures on EVERY surface it can appear on.
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

/**
 * The auditor's twenty legitimate strings, tagged with the mechanism that used
 * to flag each one. Nothing here is a claim of any kind.
 */
const LEGITIMATE: [string, string][] = [
  // (a) short abbreviations vs units / honorifics / org names / currency codes
  ['Dissolves in 500 ms', 'ms = millisecond unit'],
  ['use within 500 ms', 'ms = millisecond unit'],
  ['Ask for Ms Jones', 'Ms = honorific'],
  ['an MS in food science and an OA member', 'MS = degree, OA = org'],
  ['Vitamin A, RA levels checked', 'RA = assay abbreviation'],
  ['ISO and OA compliant', 'OA = org/standard'],
  ['A CHF payment option', 'CHF = Swiss franc'],
  ['ALS testing (Advanced Lab Services)', 'ALS = lab name'],
  ['Our mono ingredient formula', 'mono = single'],
  // (a) the verb "add" + (c) the doubled-letter pass collapsing it to "ad"
  ['Add one chew to your morning routine', 'verb add / collapsed ad'],
  ['Simply add water', 'verb add / collapsed ad'],
  ['The ADD-ON pack', 'verb add / collapsed ad'],
  // (b) concatenated-pass collisions: "routine and" -> "routineand" -> tinea
  ['Part of a healthy routine and a balanced diet', 'concat collision: tinea'],
  ['Our routine analysis', 'concat collision: tinea'],
  ['Great for your daily routine, anywhere', 'concat collision: tinea'],
  // (d) symptom words that ordinary structure/function copy is built on
  ['Great for cold and flu season travel kits', 'seasonal calendar reference'],
  ['Fatigue support blend with B12', 'symptom word, not a disease'],
  ['Supports healthy inflammation response', 'symptom word, not a disease'],
  ['Helps reduce occasional bloating, gas', 'symptom word, not a disease'],
];

/**
 * The surfaces each string is planted on.
 *
 * Every one of them is scanned by the compliance path (C6/A2), by C18/C19 and
 * by the style gate, so a false positive raised by ANY of those checks on the
 * planted field fails the test. The mutations are chosen so that no UNRELATED
 * rule can fire on the field: the bullet keeps its leading capital and ends on
 * a letter, the description keeps its product name + verbatim disclaimer, and
 * the Q&A / A+ answers are marked non-claim-bearing.
 */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['bullets[0]', (l, s) => { l.bullets[0] = `Good to know ${s}`; }],
  ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
  ['attributes.special_ingredients', (l, s) => { l.attributes.special_ingredients = s; }],
  ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

describe('FALSE POSITIVES — legitimate copy must never be blocked', () => {
  for (const [text, why] of LEGITIMATE) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" (${why}) is clean on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(onField(l, field)).toEqual([]);
      });
    }
  }

  it('all twenty strings together in one listing still leave the gate green', () => {
    const l = mut((x) => {
      x.qa = LEGITIMATE.map(([text]) => ({ q: 'What should I know?', a: text, claimBearing: false }));
      x.aplusContent.faq = LEGITIMATE.slice(0, 5).map(([text]) => ({
        q: 'What should I know?',
        a: text,
        claimBearing: false,
      }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

/**
 * The two directions of the SAME mechanism, asserted side by side so a future
 * fix cannot trade one for the other.
 */
describe('FALSE POSITIVES — the fix did not re-open the bypass it replaced', () => {
  const claims: [string, string][] = [
    ['g out', 'gout'],
    ['ib s', 'ibs'],
    ['can cer', 'cancer'],
    ['tum ors', 'tumor'],
  ];
  it.each(claims)('the split claim "%s" still FAILS C6 (term: %s)', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${payload} in adults*`; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });

  const longForms = [
    'osteoarthritis', 'rheumatoid arthritis', 'congestive heart failure',
    'multiple sclerosis', 'amyotrophic lateral sclerosis', 'adhd', 'mononucleosis',
  ];
  it.each(longForms)('the unambiguous long form "%s" still FAILS C6', (term) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${term} in adults*`; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });

  it('a benign seasonal span does NOT launder an actual prevention claim', () => {
    const l = mut((x) => { x.bullets[1] = 'Prevents colds during cold and flu season*'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });
});

// ===========================================================================
// ROUND 6 — the USABILITY half. Every case below is ordinary, lawful copy that
// the tool blocked (and, for U1, gave actively harmful advice about).
// ===========================================================================

const cosmeticsPack = loadPack('cosmetics');

/**
 * U1 — the worst of them: `presentAllergens` regex-matched allergen SOURCES
 * with no negation handling and no compound awareness, so it demanded
 * "Contains: Milk" on a milk-thistle capsule, "Contains: Wheat" on a listing
 * that says gluten free, and "Contains: Soy" on sunflower lecithin.
 */
describe('U1 — the allergen check no longer produces harmful advice', () => {
  const c9c = (l: OptimizedListing, p = pack): Failure[] =>
    runGate(l, p, ctx).failures.filter((f) => f.checkId === 'C9' || f.checkId === 'A7');

  it('"Gluten free, dairy free, soy free" in the declaration field declares NOTHING', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Rice Flour; Vegetable Cellulose';
      x.attributes.allergen_information = 'Gluten free, dairy free, soy free';
    });
    expect(c9c(l)).toEqual([]);
  });

  it.each([
    ['Milk Thistle Extract; Rice Flour', 'milk thistle is not milk'],
    ['Sunflower Lecithin (soy free); Rice Flour', 'negated inside a parenthetical'],
    ['Gluten Free Oat Fibre; Rice Flour', 'negated by a following "free"'],
    ['Wheatgrass Powder; Rice Flour', 'wheatgrass is not wheat'],
    ['Eggshell Membrane; Rice Flour', 'eggshell is not egg'],
    ['Free from milk and soy; Rice Flour', '"free from" prefix'],
    ['No added sesame; Rice Flour', '"no added" prefix'],
    ['Zero dairy; Rice Flour', '"zero" prefix'],
  ])('ingredients "%s" declare nothing (%s)', (ingredients) => {
    const l = mut((x) => {
      x.attributes.ingredients = ingredients;
      x.attributes.allergen_information = 'Free from major allergens per label';
    });
    expect(c9c(l)).toEqual([]);
  });

  it('cosmetics: "No added fragrance" declares nothing', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Aqua; Glycerin; No added fragrance';
      x.attributes.allergen_information = 'None';
    });
    expect(
      runGate(l, cosmeticsPack, { subcategories: ['skincare'] }).failures.filter(
        (f) => f.checkId === 'C9' || f.checkId === 'A7',
      ),
    ).toEqual([]);
  });

  it('TRUE POSITIVE: a real allergen source is still enforced end to end', () => {
    const undeclared = mut((x) => {
      x.attributes.ingredients = 'Whey Protein Isolate; Rice Flour';
      x.attributes.allergen_information = 'Free from major allergens per label';
    });
    const ids = runGate(undeclared, pack, ctx).failures.filter((f) => f.checkId === 'C9');
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.map((f) => f.fix).join(' ')).toContain('Contains: Milk');

    const declared = mut((x) => {
      x.attributes.ingredients = 'Whey Protein Isolate; Rice Flour';
      x.attributes.allergen_information = 'Contains: Milk';
      x.bullets[3] = 'Quality you can verify: Contains: Milk. Third-party tested and made in a cGMP facility';
      x.description = x.description.replace('Quality and safety:', 'Contains: Milk. Quality and safety:');
      const ingredients = x.aplusContent.modules.find((m) => m.id === 'ingredients')!;
      ingredients.body = `${ingredients.body} Contains: Milk.`;
    });
    expect(runGate(declared, pack, ctx).failures.filter((f) => f.checkId === 'C9' || f.checkId === 'A7')).toEqual([]);
  });

  it('TRUE POSITIVE: "no known allergens" alongside a real allergen still fails', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Whey Protein Isolate; Rice Flour';
      x.attributes.allergen_information = 'No Known Allergens';
    });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C9')).toBe(true);
  });
});

/**
 * U3 — over-generic routing markers sent a cookbook, a bag of coffee and a
 * watercolour set into a regulated pack that then demanded a compliance
 * disclaimer, and sent a vitamin C serum to supplements instead of cosmetics.
 */
describe('U3 — routing no longer hijacks ordinary products', () => {
  const snap = (title: string, category: string): ListingSnapshot => ({
    asin: 'B0ROUTE001',
    url: 'https://www.amazon.com/dp/B0ROUTE001',
    title,
    bullets: [],
    description: '',
    category,
    subcategory: [],
    attributes: {},
    images: [],
    price: '',
    raw: {},
  });

  it.each([
    ['Weeknight Blend: 100 Fast Dinner Recipes', 'Books > Cookbooks, Food & Wine'],
    ['Espresso Blend Whole Bean Coffee, Dark Roast', 'Grocery & Gourmet Food > Coffee'],
    ['Blend and Layer Watercolour Paint Set, 24 Pans', 'Arts, Crafts & Sewing > Painting'],
    ['Rise and Shine Breakfast Formula Cookbook', 'Books > Cookbooks, Food & Wine'],
    ['Cocoa Powder for Baking, Dutch Process', 'Grocery & Gourmet Food > Baking'],
  ])('"%s" routes to generic', (title, category) => {
    expect(detectCategory(snap(title, category)).packId).toBe('generic');
  });

  it.each([
    ['GlowLab Vitamin C Serum with Hyaluronic Acid', 'Beauty & Personal Care > Skin Care > Face > Serums'],
    ['GlowLab Vitamin C Serum with Hyaluronic Acid', ''],
    ['DewDrop Collagen Face Cream', 'Beauty & Personal Care > Skin Care'],
  ])('"%s" routes to cosmetics', (title, category) => {
    expect(detectCategory(snap(title, category)).packId).toBe('cosmetics');
  });

  it.each([
    ['BrandX Probiotic Supplement 50 Billion CFU, 60 Vegan Capsules', 'Health & Household > Vitamins & Dietary Supplements'],
    ['BrandX Magnesium Glycinate Capsules', ''],
    ['BrandX Vitamin C 1000 mg', ''],
  ])('"%s" still routes to supplements', (title, category) => {
    expect(detectCategory(snap(title, category)).packId).toBe('supplements');
  });
});

/**
 * U4 — a multi-ingredient formula may state more than one figure, PROVIDED the
 * ingredient breakdown actually declares those figures. Attribution alone is no
 * longer a free pass (see the attributed-but-undeclared case below).
 */
describe('U4 — C12 no longer treats every potency figure as the headline potency', () => {
  const c12On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C12' && f.field === field);

  it.each([
    'Glucosamine 1500 mg, Chondroitin 1200 mg, MSM 1000 mg and Turmeric 500 mg',
    'Melatonin 3 mg, L-Theanine 200 mg and Magnesium Glycinate 100 mg',
    'Vitamin D3 2000 IU, B12 500 mcg and Zinc 15 mg in one daily formula',
    'Folate 400 mcg with Iron 27 mg and Choline 55 mg for prenatal routines',
  ])('the attributed stack "%s" produces NO C12 failure when the ingredients declare it', (copy) => {
    const l = mut((x) => {
      x.facts.potency = '1500 mg';
      x.attributes.active_ingredients = copy;
      x.bullets[1] = `Formulated with ${copy}*`;
    });
    expect(c12On(l, 'bullets[1]')).toEqual([]);
  });

  it('an ATTRIBUTED figure that the ingredients never declare still FAILS', () => {
    const l = mut((x) => {
      x.facts.potency = '500 mg';
      x.attributes.active_ingredients = 'Turmeric 500 mg';
      x.bullets[1] = 'Maximum-strength Turmeric 2000 mg in every batch*';
    });
    expect(c12On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the SAME attributed figure passes once the ingredients declare it', () => {
    const l = mut((x) => {
      x.facts.potency = '500 mg';
      x.attributes.active_ingredients = 'Turmeric 500 mg, Black Pepper Extract 2000 mg';
      x.bullets[1] = 'Maximum-strength Black Pepper Extract 2000 mg in every batch*';
    });
    expect(c12On(l, 'bullets[1]')).toEqual([]);
  });

  it('an UNATTRIBUTED figure that contradicts facts.potency still FAILS', () => {
    const l = mut((x) => {
      x.facts.potency = '1500 mg';
      x.bullets[1] = 'Now with 900 mg in every bottle for adults*';
    });
    expect(c12On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('two UNATTRIBUTED figures in one surface are still an internal conflict', () => {
    const l = mut((x) => {
      x.facts.potency = '1500 mg';
      x.bullets[1] = 'A 1500 mg blend and also 900 mg of the same blend*';
    });
    expect(c12On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the original CFU conflict rule is untouched', () => {
    const l = mut((x) => { x.bullets[0] = 'STRONG: a 90 Billion CFU blend supports daily balance*'; });
    expect(c12On(l, 'bullets[0]').length).toBeGreaterThan(0);
  });
});

/** U5 — a day figure is only a supply statement when it says so. */
describe('U5 — C12 day figures need a supply cue', () => {
  const c12On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C12' && f.field === field);

  it.each([
    'Give it 90 days and judge for yourself',
    'Most routines settle within 30 days of consistent use',
    'Return it within 45 days if it is not for you',
  ])('"%s" produces NO C12 failure', (copy) => {
    const l = mut((x) => { x.facts.daySupply = 60; x.bullets[1] = `${copy}*`; });
    expect(c12On(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'A 90 day supply in every bottle',
    'One bottle lasts 90 days of daily use',
  ])('the supply claim "%s" still FAILS', (copy) => {
    const l = mut((x) => { x.facts.daySupply = 60; x.bullets[1] = `${copy}*`; });
    expect(c12On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });
});

/** U6 — the ALL-CAPS run rule counted digits and ignored the allowlist. */
describe('U6 — C17 ALL-CAPS rules no longer fail ordinary sentence case', () => {
  const c17On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C17' && f.field === field);

  it.each([
    'Vitamin D3 2000 IU, B12 and Zinc in one capsule',
    'D3 K2 MK7 complex for everyday routines',
    'DHA EPA ALA trio from cold pressed oil',
    'Third-party tested with L-THEANINE and 5HTP on the label',
    'Batch tested to COQ10 and KSM standards',
    'Certified by IFOS for freshness',
    'Audited to BSCG standards each year',
    'Made in a HACCP audited facility',
    'Packed in an SQF certified plant',
    'Made under a BRCGS certified programme',
    'Verified by IGEN for non-GMO status',
    'IFOS, BSCG, HACCP, SQF, BRCGS and IGEN audited every year',
    // R4 — the same list written WITHOUT commas. Every token is a
    // certification mark (`rules.style.allCapsRunExempt`), so however many of
    // them sit together it is a list, not shouting.
    'IFOS BSCG HACCP SQF audited every year',
    'Certified IFOS BSCG HACCP SQF BRCGS IGEN NSF USP GMP',
  ])('"%s" produces NO C17 failure', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c17On(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'NEW BIG WOW gut support',
    'BUY MORE NOW while you can',
    'THIS IS SHOUTING LOUD at the customer',
    'SAME NON USA GABA blend',
  ])('genuine shouting "%s" still FAILS C17', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c17On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });
});

/** U7 — `pounds` is a WEIGHT far more often than a currency. */
describe('U7 — a weight in pounds is not a price claim', () => {
  it.each([
    'A 5 Pound tub for the whole family',
    'Net weight 2 pounds of loose product',
    'Ships at 3 pounds boxed',
  ])('"%s" produces NO C18 failure', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C18' && f.field === 'bullets[1]')).toEqual([]);
  });

  it.each(['Only £19.95 today', 'Just 19 dollars and 95 cents', 'A steal at 20 euros'])(
    'the real price claim "%s" still FAILS C18',
    (copy) => {
      const l = mut((x) => { x.bullets[1] = `${copy}*`; });
      expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C18' && f.field === 'bullets[1]')).toBe(true);
    },
  );
});

/**
 * U8 — menopause/perimenopause are enumerated NATURAL STATES under
 * 21 CFR 101.93(g), and `nash` collides with a surname.
 */
describe('U8 — natural states and ambiguous names are not diseases on their own', () => {
  const c6On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C6' && f.field === field);

  it.each([
    'Formulated for women in perimenopause and menopause',
    'Made for the years around menopause',
    'Reviewed by Dr Nash in our own laboratory',
  ])('"%s" produces NO C6 failure', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c6On(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'Cures menopause in eight weeks',
    'Reverses perimenopause for good',
    'Treats nash and restores the liver',
  ])('the therapeutic-action claim "%s" still FAILS C6', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });
});

/**
 * C-1 — `styleSurfaces()` omitted `backendSearchTerms` and `facts.*`, so an
 * ASIN, an emoji or raw HTML in either one shipped as `verified`.
 */
describe('C-1 — the style gate now reads the backend field and the facts block', () => {
  const c17On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C17' && f.field === field);

  it.each([
    ['an ASIN', 'B0ABCD1234'],
    ['an emoji', '✅'],
    ['raw HTML', '<b>bold</b>'],
    ['a banned symbol', '™'],
  ])('%s in backendSearchTerms FAILS C17', (_why, payload) => {
    const l = mut((x) => { x.backendSearchTerms = `${x.backendSearchTerms} ${payload}`; });
    expect(c17On(l, 'backendSearchTerms').length).toBeGreaterThan(0);
  });

  it.each([
    ['an ASIN', 'B0ABCD1234'],
    ['an emoji', '✅'],
    ['raw HTML', '<b>bold</b>'],
    ['a banned symbol', '™'],
  ])('%s in a facts string FAILS C17', (_why, payload) => {
    const l = mut((x) => { x.facts.potency = `50 Billion CFU ${payload}`; });
    expect(c17On(l, 'facts.potency').length).toBeGreaterThan(0);
  });

  it('a legitimate "$" in facts.price is still legal (the pack scopes bannedChars)', () => {
    const l = mut((x) => { x.facts.price = '$24.99'; });
    expect(c17On(l, 'facts.price')).toEqual([]);
  });
});

/**
 * L-1 — C19's guarantee rule targets the CLAIM, not the word.
 *
 * A real production run failed `[C19] imagePlan[4].notes` with the context
 * `guarantee`: the pack pattern was `\bguarantee[ds]?\b`, which flags every
 * sense of the word — including an image brief that says the pack must carry
 * NO guarantee. The pattern set now names the claim shapes (money back /
 * satisfaction guaranteed / guaranteed results / results guaranteed / lifetime
 * guarantee) plus the first-person promise "we guarantee".
 *
 * JUDGEMENT CALL, recorded: "we guarantee freshness" FAILS. A first-person
 * promise to the buyer is a guarantee claim whatever is being promised, and the
 * substance of the promise is exactly what Amazon bans from listing copy.
 * "we cannot guarantee ..." does NOT fail: only the positive promise matches,
 * which is how the rule survives having no negation guard (C18/C19 apply none
 * by design).
 */
describe('L-1 — C19 flags guarantee CLAIMS, not every use of the word', () => {
  const c19On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C19' && f.field === field);

  const LEGITIMATE_GUARANTEE_COPY = [
    'no guarantees or claims on pack',
    'the printed panel shows no guarantee text',
    'we cannot guarantee an exact colour match in print',
  ];

  it.each(LEGITIMATE_GUARANTEE_COPY)('the image brief "%s" produces NO C19 failure', (copy) => {
    const l = mut((x) => { x.imagePlan[4]!.notes = copy; });
    expect(c19On(l, 'imagePlan[4].notes')).toEqual([]);
  });

  it.each(LEGITIMATE_GUARANTEE_COPY)('"%s" produces NO C19 failure in a bullet either', (copy) => {
    const l = mut((x) => { x.bullets[1] = `Label detail: ${copy}`; });
    expect(c19On(l, 'bullets[1]')).toEqual([]);
  });

  const GUARANTEE_CLAIMS = [
    '100% money back guarantee',
    'satisfaction guaranteed',
    'guaranteed results',
    'results guaranteed',
    'lifetime guarantee',
    // documented judgement call — a first-person promise is a claim
    'we guarantee freshness',
  ];

  it.each(GUARANTEE_CLAIMS)('the marketing guarantee "%s" still FAILS C19 in a bullet', (claim) => {
    const l = mut((x) => { x.bullets[1] = `Every bottle: ${claim}`; });
    expect(c19On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(GUARANTEE_CLAIMS)('the marketing guarantee "%s" still FAILS C19 in an image brief', (claim) => {
    const l = mut((x) => { x.imagePlan[4]!.notes = `overlay reads ${claim}`; });
    expect(c19On(l, 'imagePlan[4].notes').length).toBeGreaterThan(0);
  });
});

/**
 * L-2 — a figure cannot CONTRADICT a canonical fact that does not exist.
 *
 * A real production run failed `[C12] attributes.size_name` with
 * `Count '30 Count' matches no canonical fact (unitCount=undefined,
 * servings=undefined)`. The allowed-count set was seeded with 1-4 (a plausible
 * serving size), so it was never empty and the `size > 0` guard that was meant
 * to skip the comparison when no canonical fact exists never fired. Absence of
 * a fact was being treated as a conflict.
 *
 * The canonical comparison now runs only when a canonical count fact is
 * DEFINED; with none, the listing must still agree with ITSELF.
 */
describe('L-2 — C12 only compares a count against a canonical fact that exists', () => {
  const c12 = (l: OptimizedListing): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C12');
  const c12On = (l: OptimizedListing, field: string): Failure[] =>
    c12(l).filter((f) => f.field === field);

  /** Every count figure in the listing restated at `n`, canonical facts intact. */
  const countsAt = (l: OptimizedListing, n: number): OptimizedListing =>
    JSON.parse(
      JSON.stringify(l).replace(/\b60\b(?=[\s-]?(?:capsules?|count))/gi, String(n)),
    ) as OptimizedListing;

  /** The production shape: a self-consistent 30-count listing with no canonical count fact. */
  const noCanonicalCount = (n: number): OptimizedListing => {
    const l = countsAt(clean, n);
    delete l.facts.unitCount;
    delete l.facts.servings;
    delete l.facts.daySupply;
    delete l.facts.formulaCount;
    delete l.facts.servingSize;
    l.attributes.size_name = `${n} Count`;
    return l;
  };

  it('size_name "30 Count" with facts.unitCount undefined PASSES', () => {
    const l = noCanonicalCount(30);
    expect(l.facts.unitCount).toBeUndefined();
    expect(c12On(l, 'attributes.size_name')).toEqual([]);
    expect(c12(l)).toEqual([]);
  });

  it('the same listing with facts.unitCount = 60 still FAILS (a real contradiction)', () => {
    const l = noCanonicalCount(30);
    l.facts.unitCount = 60;
    expect(c12On(l, 'attributes.size_name').length).toBeGreaterThan(0);
  });

  it('two conflicting counts and NO canonical fact still FAIL (internal conflict)', () => {
    const l = noCanonicalCount(30);
    l.attributes.size_name = '90 Count';
    const failures = c12(l);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.map((f) => f.fix).join(' ')).toContain('internal conflict');
  });

  it('a plausible serving size next to the container count is NOT a conflict', () => {
    const l = noCanonicalCount(30);
    l.attributes.directions_for_use = 'Take 2 capsules daily with water.';
    expect(c12(l)).toEqual([]);
  });
});
