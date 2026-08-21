import { beforeAll, describe, expect, it } from 'vitest';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import type { LlmClient } from '@/lib/engine/llm';
import {
  deriveKeywordPlacement,
  ownBrandIdentity,
  productIdentity,
  productPropertyIdentity,
} from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type {
  CompetitorIngestion,
  Failure,
  KeywordTerm,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * E6 — A PROPERTY OF THE PRODUCT BEING OPTIMIZED CANNOT BE A RIVAL-EXCLUSION
 *      TERM. AND R50 IS UNWEAKENED.
 * ===========================================================================
 *
 * THE LIVE DEFECT — three of nine production runs, two ASINs, neither able to
 * converge:
 *
 *   B00IO89MYA  C28 | keywords[24] | negative term 'elderberry' appears on
 *               |                  | 'title'
 *   B00EEEITVA  C28 | keywords[24] | negative term 'dairy free' appears on
 *               |                  | 'itemHighlights'
 *
 * `elderberry` is an ACTUAL INGREDIENT of the product being optimized and
 * `dairy free` is a LEGITIMATE DIET ATTRIBUTE of it. The copy names both because
 * a listing for that product must name them. The model had used `negative` — a
 * status whose sole meaning is RIVAL-BRAND exclusion (R50) — as a dumping ground
 * for "terms I chose not to target", which is what `not-targeted` is for.
 *
 * WHY NO REPAIR ROUND COULD CLEAR IT. `negative` is the ONE status the
 * derivation must never overwrite: for a genuine rival, presence in the copy IS
 * the violation, so deriving it away would turn the check that keeps rival
 * brands out into a relabelling exercise. C28 was right about its rule and the
 * model was wrong about its input, and the only fix the failure asks for is
 * "delete your own ingredient from your own title".
 *
 * THE FIX, AND WHERE IT READS FROM. `lib/engine/keywordPlacement.ts` resolves
 * "is this term a property of the product being optimized?" from the INGESTED
 * SNAPSHOT'S STRUCTURED ATTRIBUTES — never from the generated copy, which would
 * let the model launder a rival by writing it in, and never from the snapshot's
 * free-text bullets or description, where a competitor can be named lawfully.
 * The match is an EXACT NORMALISED EQUALITY on a whole list item, the same
 * discipline `ownBrandIdentity` established, and the row is RECLASSIFIED with
 * the correction on `note` rather than deleted.
 *
 * BOTH DIRECTIONS, and the second one is what matters:
 *   (a) the two live shapes converge;
 *   (b) R50 — a GENUINE rival marked `negative` still fails from EVERY surface,
 *       the invisible ones included;
 *   (c) the exemption is not a wildcard — a term sharing a word with an
 *       ingredient, and a term that appears only in the snapshot's PROSE, are
 *       not exempted;
 *   (d) the OPERATOR-SUPPLIED competitor set is never reclassified, even when a
 *       rival brand collides with one of our ingredient strings;
 *   (e) `minNegatives` counts only surviving negatives;
 *   (f) the golden fixture is unchanged and still gates clean.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** The live terms, verbatim. */
const INGREDIENT = 'elderberry';
const DIET_FLAG = 'dairy free';
/** Shares a word with the ingredient and is NOT the ingredient. */
const SHARED_WORD = 'berry';
/** A rival brand that COLLIDES with one of our own ingredient strings. */
const COLLIDING_RIVAL = 'Elder Berry Labs';

/**
 * The subject snapshot, with the live shapes present as STRUCTURED data: an
 * ingredient list and a diet-flag list, exactly as a marketplace page carries
 * them. `Elder Berry Labs` sits in the ingredient list on purpose — see (d).
 */
const SNAP: ListingSnapshot = {
  ...snapshot,
  attributes: {
    ...snapshot.attributes,
    ingredients: 'Elderberry, Zinc, Vitamin C, Elder Berry Labs Extract Base',
    active_ingredients: 'Elderberry',
    diet_type: 'Vegan, Gluten Free, Dairy Free',
  },
};

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, rivalBrands: string[] = []): Failure[] =>
  c28KeywordPlacement(l, pack, { ...ctx, rivalBrands });
const rowFor = (rows: KeywordTerm[], term: string): KeywordTerm =>
  rows.find((r) => r.term.toLowerCase() === term.toLowerCase())!;
const negativeRow = (term: string, why: string): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});

/** Three GENUINE negatives — what a real reference records, and the floor. */
const NEGATIVE_FLOOR = (): KeywordTerm[] => [
  negativeRow('diabetes', 'Named condition'),
  negativeRow('detox', 'Implied-treatment framing'),
  negativeRow('greenluxe', 'Rival brand'),
];

/**
 * The live copy shapes, planted where the live runs had them: the ingredient in
 * a bullet and the diet attribute in the item highlights. Both are legitimate
 * copy — that is the entire point of the defect.
 */
function plantTheLiveShapes(l: OptimizedListing): void {
  l.bullets[1] = `${l.bullets[1]} with elderberry`;
  l.itemHighlights =
    'Vegan dairy free gut health support for women and men, shelf stable prebiotic blend, two month supply';
}

// ===========================================================================
// (a) THE TWO LIVE SHAPES
// ===========================================================================

describe('(a) the live shapes: an ingredient and a diet attribute marked negative', () => {
  it('the snapshot really does declare both, as STRUCTURED attribute items', () => {
    const props = productPropertyIdentity(SNAP);
    expect(props.has(INGREDIENT)).toBe(true);
    expect(props.has(DIET_FLAG)).toBe(true);
  });

  it('the defect was real: without the snapshot the rows stay negative and C28 fails as production did', () => {
    const l = clone();
    plantTheLiveShapes(l);
    // No snapshot => nothing to resolve the identity from => nothing exempted.
    l.keywords = [
      ...deriveKeywordPlacement(
        [negativeRow(INGREDIENT, 'Not targeting it'), negativeRow(DIET_FLAG, 'Not targeting it')],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR(),
    ];
    expect(rowFor(l.keywords, INGREDIENT).status).toBe('negative');
    expect(rowFor(l.keywords, DIET_FLAG).status).toBe('negative');
    const contexts = c28(l).map((f) => f.context);
    expect(contexts.some((c) => c.includes(`negative term '${INGREDIENT}'`)), contexts.join(' | ')).toBe(true);
    expect(contexts.some((c) => c.includes(`negative term '${DIET_FLAG}'`)), contexts.join(' | ')).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('with the snapshot, BOTH rows are RECLASSIFIED (not deleted) and the correction is on `note`', () => {
    const l = clone();
    plantTheLiveShapes(l);
    const derived = deriveKeywordPlacement(
      [negativeRow(INGREDIENT, 'Not targeting it'), negativeRow(DIET_FLAG, 'Not targeting it')],
      l,
      pack,
      SNAP,
    );
    expect(derived).toHaveLength(2);

    const ingredient = derived[0]!;
    expect(ingredient.term).toBe(INGREDIENT);
    expect(ingredient.status).toBe('placed');
    expect(ingredient.surfaces).toContain('bullet2');
    expect(ingredient.note).toContain('PROPERTY OF THIS PRODUCT');
    expect(ingredient.note).toContain("reclassified from 'negative'");
    // the model's other fields are NOT laundered
    expect(ingredient.why).toBe('Not targeting it');
    expect(ingredient.tier).toBe('negative');

    const diet = derived[1]!;
    expect(diet.term).toBe(DIET_FLAG);
    expect(diet.status).toBe('placed');
    expect(diet.surfaces).toContain('itemHighlights');
    expect(diet.note).toContain('PROPERTY OF THIS PRODUCT');
  });

  it('C28 is CLEAN and the whole gate passes — the live blocker, fixed', () => {
    const l = clone();
    plantTheLiveShapes(l);
    l.keywords = [
      ...deriveKeywordPlacement(
        [negativeRow(INGREDIENT, 'Not targeting it'), negativeRow(DIET_FLAG, 'Not targeting it')],
        l,
        pack,
        SNAP,
      ),
      ...NEGATIVE_FLOOR(),
    ];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('END TO END: a live-shaped model run through optimize() converges', async () => {
    const liveShapedLlm: LlmClient = async (req) => {
      if (req.user.includes('TASK: The keyword reference')) {
        return JSON.stringify({
          keywords: [
            { t: INGREDIENT, tier: 'negative', status: 'negative', evidence: 'Not targeting it' },
            { t: DIET_FLAG, tier: 'negative', status: 'negative', evidence: 'Not targeting it' },
            { t: 'probiotic supplement', tier: 1, status: 'placed', evidence: 'Category head term' },
            { t: 'digestive balance', tier: 1, status: 'placed', evidence: 'The intent cluster owned' },
            { t: 'shelf stable', tier: 3, status: 'placed', evidence: 'Storage differentiator' },
            { t: 'acidophilus', tier: 'backend', status: 'backend', evidence: 'Common-name variant' },
            { t: 'weight loss', tier: 'strategy', status: 'not-targeted', evidence: 'Converts badly' },
            ...NEGATIVE_FLOOR().map((r) => ({
              t: r.term,
              tier: r.tier,
              status: r.status,
              evidence: r.why,
            })),
          ],
        });
      }
      return mockLlm(req);
    };
    // The generated copy carries neither live term, so the reclassified rows land
    // as `candidate` — the row is still corrected, still annotated, still not a
    // negative, and the floor is still met by the three genuine ones.
    const listing = await optimize(SNAP, pack, liveShapedLlm);
    for (const term of [INGREDIENT, DIET_FLAG]) {
      const row = rowFor(listing.keywords ?? [], term);
      expect(row.status, term).not.toBe('negative');
      expect(row.note, term).toContain('PROPERTY OF THIS PRODUCT');
    }
    expect(c28(listing)).toEqual([]);
    expect(runGate(listing, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (b) R50 IS UNWEAKENED — a GENUINE rival still fails from EVERY surface
// ===========================================================================

describe('(b) R50: a rival brand marked negative still fails from every surface', () => {
  const RIVAL = 'GreenLuxe';

  const PLANTS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} ${RIVAL}`; }],
    ['bullet1', (l) => { l.bullets[0] = `Unlike ${RIVAL}: ${l.bullets[0]}`; }],
    ['description', (l) => { l.description = `${RIVAL} alternative. ${l.description}`; }],
    ['backend', (l) => { l.backendSearchTerms = `greenluxe ${l.backendSearchTerms}`; }],
    ['attributes', (l) => { l.attributes.product_benefit = `${l.attributes.product_benefit}; ${RIVAL} comparison`; }],
    ['A+ bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = `${RIVAL} banner`; }],
    ['videoBrief', (l) => { l.videoBrief!.onScreenText[0] = `Better than ${RIVAL}`; }],
    ['imagePlan altText', (l) => { l.imagePlan[0]!.altText = `${RIVAL} bottle on white`; }],
  ];

  it.each(PLANTS)('FAILS: the rival planted in %s', (_label, plant) => {
    const l = clone();
    plant(l);
    // Re-derived exactly as the engine does, with the WIDER identity set: the
    // exemption must not touch a name that is not this product's own.
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, SNAP);
    const row = rowFor(l.keywords, 'greenluxe');
    expect(row.status).toBe('negative');
    expect(row.surfaces).toEqual([]);
    expect(row.note).toBeUndefined();

    const contexts = c28(l).map((f) => f.context);
    expect(
      contexts.some((c) => c.toLowerCase().includes("negative term 'greenluxe'")),
      contexts.join(' | '),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and PASSES while the rival is genuinely absent (not a check that fails everything)', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, SNAP);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('the rival is in NEITHER identity set, whatever the model says about it', () => {
    expect(ownBrandIdentity(clean, SNAP).has('greenluxe')).toBe(false);
    expect(productPropertyIdentity(SNAP).has('greenluxe')).toBe(false);
    expect(productIdentity(clean, SNAP).has('greenluxe')).toBe(false);
  });
});

// ===========================================================================
// (c) THE EXEMPTION IS NOT A WILDCARD
// ===========================================================================

describe('(c) sharing a word with an ingredient, and appearing only in the snapshot PROSE', () => {
  it('a term INSIDE an ingredient name is not that ingredient', () => {
    const props = productPropertyIdentity(SNAP);
    expect(props.has(INGREDIENT)).toBe(true);
    expect(props.has(SHARED_WORD)).toBe(false);
    // and the whole-item rule cuts the other way too: a term that CONTAINS an
    // item is not the item.
    expect(props.has('elderberry extract')).toBe(false);
  });

  it('marked negative and present in the copy, the shared word STILL FAILS C28', () => {
    const l = clone();
    l.bullets[1] = `${l.bullets[1]} with berry flavour notes`;
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(SHARED_WORD, 'Planted')], l, pack, SNAP),
      ...NEGATIVE_FLOOR(),
    ];
    const row = rowFor(l.keywords, SHARED_WORD);
    expect(row.status).toBe('negative');
    expect(row.note).toBeUndefined();
    const contexts = c28(l).map((f) => f.context);
    expect(
      contexts.some((c) => c.includes(`negative term '${SHARED_WORD}'`)),
      contexts.join(' | '),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('a name that appears ONLY in the snapshot\'s free-text bullets is NOT a product property', () => {
    // This is the load-bearing exclusion: a competitor can be named lawfully in
    // prose ("unlike the refrigerated brands"), and prose is exactly where a
    // rival brand would be sitting. Mining it would hand that rival an exemption.
    const prose: ListingSnapshot = {
      ...SNAP,
      bullets: [...SNAP.bullets, 'Unlike GreenLuxe, this formula is shelf stable'],
      description: `${SNAP.description} Compare with GreenLuxe.`,
      title: `${SNAP.title} vs GreenLuxe`,
    };
    expect(productPropertyIdentity(prose).has('greenluxe')).toBe(false);
    expect(productIdentity(clean, prose).has('greenluxe')).toBe(false);

    const l = clone();
    l.description = `GreenLuxe alternative. ${l.description}`;
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, prose);
    expect(rowFor(l.keywords, 'greenluxe').status).toBe('negative');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and it is not read from the GENERATED copy either — a model cannot launder a rival by writing it in', () => {
    const l = clone();
    // Every generated surface the derivation reads, saturated with the rival.
    l.title = `${l.title} GreenLuxe`;
    l.description = `GreenLuxe. ${l.description}`;
    l.attributes.product_benefit = `${l.attributes.product_benefit}; GreenLuxe`;
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, SNAP);
    expect(rowFor(l.keywords, 'greenluxe').status).toBe('negative');
    expect(rowFor(l.keywords, 'greenluxe').note).toBeUndefined();
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('WITH NO SNAPSHOT the SNAPSHOT-DERIVED sets are empty — they can only ever narrow', () => {
    expect([...productPropertyIdentity(undefined)]).toEqual([]);
    expect([...ownBrandIdentity(clean, undefined)]).toEqual([]);
    // The one entry left is the run's own canonical `productName`, held by the
    // separate `canonicalNameIdentity` rule: it is not conditioned on the
    // snapshot because it does not rest on corroborating who wrote the name — it
    // rests on C8/C15 compelling that exact string into the copy. See
    // `tests/keywordDerivation.canonicalName.test.ts`, which closes the
    // laundering path that opens, mechanism by mechanism.
    expect([...productIdentity(clean, undefined).keys()]).toEqual(['brandx probiotic']);
    expect(productIdentity(clean, undefined).get('brandx probiotic')).toBe('canonical-name');
  });
});

// ===========================================================================
// (d) THE OPERATOR-SUPPLIED COMPETITOR SET IS NEVER RECLASSIFIED
// ===========================================================================

/**
 * THE BOUND THIS PINS. `lib/audit/rivalBrands.ts` subtracts the subject's own
 * identity from the automatic rival set so an operator who pastes their own ASIN
 * into the competitor box cannot make their own brand unwritable. That
 * subtraction reads `ownBrandIdentity` — the NARROW, brand-only set — and it must
 * keep doing so. Had the wider `productIdentity` been used there, a rival brand
 * that happens to collide with one of our ingredient strings would have dropped
 * out of the operator-supplied signal by coincidence.
 */
describe('(d) a rival supplied via competitorAsins that collides with an ingredient string', () => {
  const rival: CompetitorIngestion = {
    asin: 'B0RIVAL0001',
    snapshot: {
      ...snapshot,
      asin: 'B0RIVAL0001',
      title: 'A rival listing title',
      attributes: { brand_name: COLLIDING_RIVAL, manufacturer: COLLIDING_RIVAL },
    } as ListingSnapshot,
  };

  it('the collision is real: the rival brand IS an item of our own ingredient list', () => {
    expect(productPropertyIdentity(SNAP).has('elder berry labs')).toBe(false);
    // it collides as a PREFIX of an item, which is exactly the near-miss shape
    expect(productPropertyIdentity(SNAP).has('elder berry labs extract base')).toBe(true);
  });

  it('the automatic set still carries it — the narrow subtraction was not widened', () => {
    expect(rivalBrandNames([rival], clean, SNAP)).toContain(COLLIDING_RIVAL);
  });

  it('EXACT collision: even when the rival brand IS an ingredient item verbatim, it still fails', () => {
    const exact: ListingSnapshot = {
      ...SNAP,
      attributes: { ...SNAP.attributes, ingredients: `Elderberry, ${COLLIDING_RIVAL}, Zinc` },
    };
    // The derivation WOULD exempt a model-declared negative row for it...
    expect(productPropertyIdentity(exact).has('elder berry labs')).toBe(true);
    // ...and the operator-supplied set is untouched by that, by construction.
    const names = rivalBrandNames([rival], clean, exact);
    expect(names).toContain(COLLIDING_RIVAL);

    const l = clone();
    l.description = `${l.description}\n${COLLIDING_RIVAL} comparison.`;
    l.keywords = deriveKeywordPlacement(
      [...(clean.keywords ?? []), negativeRow(COLLIDING_RIVAL, 'Rival brand')],
      l,
      pack,
      exact,
    );
    // the ROW was reclassified — that is the derivation doing exactly what it is
    // told, from the snapshot the operator's own page supplied...
    expect(rowFor(l.keywords, COLLIDING_RIVAL).status).not.toBe('negative');
    // ...and the run STILL FAILS, on the automatic leg, which reads no label.
    const contexts = c28(l, names).map((f) => f.context);
    expect(
      contexts.some((c) => c.includes(`ingested competitor brand '${COLLIDING_RIVAL}'`)),
      contexts.join(' | '),
    ).toBe(true);
    expect(runGate(l, pack, { ...ctx, rivalBrands: names }).pass).toBe(false);
  });

  it('and it fails with no keyword row at all — the automatic leg never asks the model', () => {
    const l = clone();
    l.description = `${l.description}\n${COLLIDING_RIVAL} comparison.`;
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, SNAP);
    const names = rivalBrandNames([rival], l, SNAP);
    expect(c28(l, names).length).toBeGreaterThan(0);
    expect(runGate(l, pack, { ...ctx, rivalBrands: names }).pass).toBe(false);
  });
});

// ===========================================================================
// (e) THE NEGATIVE FLOOR CANNOT BE PADDED BY RECLASSIFIED ROWS
// ===========================================================================

describe('(e) minNegatives counts only SURVIVING negatives', () => {
  const propertiesOnly = (): KeywordTerm[] => [
    negativeRow(INGREDIENT, 'Not targeting it'),
    negativeRow(DIET_FLAG, 'Not targeting it'),
    negativeRow('vegan', 'Not targeting it'),
  ];

  it('the floor is 3, and three product-property rows would otherwise have met it', () => {
    expect(pack.rules.keywordRules!.minNegatives).toBe(3);
    expect(propertiesOnly()).toHaveLength(3);
    for (const row of propertiesOnly()) {
      expect(productPropertyIdentity(SNAP).has(row.term.toLowerCase()), row.term).toBe(true);
    }
  });

  it('a run whose ONLY negatives are product properties FAILS the floor', () => {
    const l = clone();
    plantTheLiveShapes(l);
    l.keywords = deriveKeywordPlacement(propertiesOnly(), l, pack, SNAP);
    expect(l.keywords.every((r) => r.status !== 'negative')).toBe(true);
    const contexts = c28(l).map((f) => f.context);
    expect(contexts.some((c) => c.includes('negative term(s)')), contexts.join(' | ')).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and the SAME rows plus three genuine negatives clear it (the floor still works)', () => {
    const l = clone();
    plantTheLiveShapes(l);
    l.keywords = [...deriveKeywordPlacement(propertiesOnly(), l, pack, SNAP), ...NEGATIVE_FLOOR()];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (f) THE GOLDEN FIXTURE IS UNCHANGED
// ===========================================================================

describe('(f) the golden fixture', () => {
  it('re-derives to exactly what it already is', () => {
    const l = clone();
    expect(deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot)).toEqual(l.keywords);
  });

  it('keeps every one of its negatives, and still gates with ZERO failures', () => {
    const negatives = (clean.keywords ?? []).filter((r) => r.status === 'negative');
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    for (const row of negatives) expect(row.note, row.term).toBeUndefined();
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// THE MODEL IS ALSO TOLD — from PACK DATA, no literal in lib/engine
// ===========================================================================

describe('the keywords prompt states what `negative` is for, from pack data', () => {
  it('renders the pack string verbatim', () => {
    const note = pack.rules.keywordRules!.negativeScopeNote!;
    expect(note.length).toBeGreaterThan(40);
    const rendered = buildGroupPrompts(pack).keywords(snapshot, clean);
    expect(rendered).toContain(note);
  });

  it('and renders nothing at all when the pack ships no line (pack-driven, not hard-coded)', () => {
    const p = JSON.parse(JSON.stringify(pack)) as typeof pack;
    const note = p.rules.keywordRules!.negativeScopeNote!;
    delete p.rules.keywordRules!.negativeScopeNote;
    expect(buildGroupPrompts(p).keywords(snapshot, clean)).not.toContain(note);
  });
});
