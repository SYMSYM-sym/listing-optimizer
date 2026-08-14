import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { deriveKeywordPlacement, ownBrandIdentity } from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * THE SUBJECT PRODUCT'S OWN BRAND IS NOT A RIVAL — AND R50 IS UNWEAKENED.
 *
 * THE LIVE DEFECT. ASIN B00IO89MYA ("Instant Immunity Support …", brand
 * "Instant Immunity"), one gate failure, and the run could not converge:
 *
 *   C28 | keywords[21] | negative term 'instant immunity' appears on
 *       |              | 'attributes'
 *
 * `negative` means "a term that must appear NOWHERE" and exists for RIVAL-brand
 * exclusion (R50). The model classified the product's OWN brand name as
 * negative; C28 then correctly found it in `brand_name`/`manufacturer`, where a
 * compliant listing MUST carry it. The check was right about its rule and the
 * model was wrong about its input, so no repair round could ever clear it.
 *
 * THE FIX IS AT THE DERIVATION BOUNDARY, IN CODE. Whether a term IS the subject
 * product's own brand identity is a fact code can compute exactly, from the
 * INGESTED SNAPSHOT (`brand_name`, `manufacturer`, the brand token at the head
 * of the scraped title) and the run's resolved canonical `productName`. A
 * `negative` row naming that identity is reclassified truthfully — its real
 * placement derived like any other term — and the correction is written onto
 * `note`, never silently dropped.
 *
 * BOTH DIRECTIONS, and the second one is the one that matters: a GENUINE rival
 * brand marked `negative` still fails from EVERY surface (title, bullets,
 * description, backend, attributes, A+ banner ALT, video brief), and a term
 * that merely SHARES A WORD with the brand is not exempted at all.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** The fixture's own identity, in its three shapes. */
const BRAND = snapshot.attributes.brand_name!;          // 'BrandX'
const MANUFACTURER = snapshot.attributes.manufacturer!; // 'BrandX Labs LLC'
const PRODUCT_NAME = 'BrandX Probiotic';                // the resolved canonical name

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing): Failure[] => c28KeywordPlacement(l, pack);
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
const NEGATIVE_FLOOR: KeywordTerm[] = [
  negativeRow('diabetes', 'Named condition'),
  negativeRow('detox', 'Implied-treatment framing'),
  negativeRow('greenluxe', 'Rival brand'),
];

// ===========================================================================
// (a) THE LIVE SHAPE — own brand marked `negative`, brand present in attributes
// ===========================================================================

describe('(a) the live shape: the product\'s OWN brand marked negative', () => {
  it('the defect was real: without the identity the row stays negative and C28 fails exactly as production did', () => {
    const l = clone();
    // Derived with NO snapshot and a term that is not the canonical product
    // name, so nothing exempts it — this is the pre-fix world, reproduced.
    l.keywords = [...deriveKeywordPlacement([negativeRow(BRAND, 'Brand term')], l, pack), ...NEGATIVE_FLOOR];
    expect(rowFor(l.keywords, BRAND).status).toBe('negative');
    const fs = c28(l);
    expect(
      fs.some(
        (f) =>
          f.context.toLowerCase().includes('negative term') &&
          f.context.toLowerCase().includes(BRAND.toLowerCase()) &&
          f.context.includes('attributes'),
      ),
      JSON.stringify(fs.map((f) => f.context)),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('the brand really IS in the brand attributes — where a compliant listing must carry it', () => {
    expect(Object.values(clean.attributes).join(' ')).toContain(BRAND);
  });

  it('with the snapshot, the row is RECLASSIFIED (not deleted) and the correction is on `note`', () => {
    const l = clone();
    const derived = deriveKeywordPlacement([negativeRow(BRAND, 'Brand term')], l, pack, snapshot);
    expect(derived).toHaveLength(1);
    const row = derived[0]!;
    expect(row.term).toBe(BRAND);
    expect(row.status).not.toBe('negative');
    expect(row.status).toBe('placed');
    expect(row.surfaces).toContain('attributes');
    expect(row.note).toBeTruthy();
    expect(row.note).toContain('OWN brand identity');
    expect(row.note).toContain("reclassified from 'negative'");
    // the model's other fields are NOT laundered
    expect(row.why).toBe('Brand term');
    expect(row.tier).toBe('negative');
  });

  it('C28 is CLEAN and the whole gate passes — the live blocker, fixed', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(BRAND, 'Brand term')], l, pack, snapshot),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('END TO END: a live-shaped model run through optimize() converges', async () => {
    const ownBrandLlm: LlmClient = async (req) => {
      if (req.user.includes('TASK: The keyword reference')) {
        return JSON.stringify({
          keywords: [
            { t: BRAND, tier: 'negative', status: 'negative', evidence: 'Brand term kept out of copy' },
            { t: 'probiotic supplement', tier: 1, status: 'placed', evidence: 'Category head term' },
            { t: 'digestive balance', tier: 1, status: 'placed', evidence: 'The intent cluster owned' },
            { t: 'vegan', tier: 3, status: 'placed', evidence: 'Filter facet' },
            { t: 'acidophilus', tier: 'backend', status: 'backend', evidence: 'Common-name variant' },
            { t: 'weight loss', tier: 'strategy', status: 'not-targeted', evidence: 'Converts badly' },
            ...NEGATIVE_FLOOR.map((r) => ({ t: r.term, tier: r.tier, status: r.status, evidence: r.why })),
          ],
        });
      }
      return mockLlm(req);
    };
    const listing = await optimize(snapshot, pack, ownBrandLlm);
    const row = rowFor(listing.keywords ?? [], BRAND);
    expect(row.status).not.toBe('negative');
    expect(row.note).toContain('OWN brand identity');
    expect(c28(listing)).toEqual([]);
    expect(runGate(listing, pack, ctx)).toEqual({ pass: true, failures: [] });
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
  ];

  it.each(PLANTS)('FAILS: the rival planted in %s', (_label, plant) => {
    const l = clone();
    plant(l);
    // Re-derived exactly as the engine does, snapshot and all: the exemption
    // must not touch a name that is not this product's own.
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const row = rowFor(l.keywords, 'greenluxe');
    expect(row.status).toBe('negative');
    expect(row.surfaces).toEqual([]);
    expect(row.note).toBeUndefined();

    const fs = c28(l);
    expect(
      fs.some(
        (f) =>
          f.context.toLowerCase().includes('negative term') &&
          f.context.toLowerCase().includes('greenluxe'),
      ),
      JSON.stringify(fs.map((f) => f.context)),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and PASSES while the rival is genuinely absent (not a check that fails everything)', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('the rival is not in the identity set, whatever the model says about it', () => {
    expect(ownBrandIdentity(clean, snapshot).has('greenluxe')).toBe(false);
  });
});

// ===========================================================================
// (c) THE EXEMPTION IS NOT A WILDCARD — sharing a word is not being the brand
// ===========================================================================

describe('(c) a term that merely SHARES A WORD with the brand is still a negative', () => {
  // The canonical product name is 'BrandX Probiotic'; 'probiotic' is one of its
  // words and is all over the copy. This is the fixture's exact analogue of the
  // live case's brand "Instant Immunity" vs the term "immunity".
  const SHARED = 'probiotic';

  it('the shared word is NOT in the resolved identity set', () => {
    const identity = ownBrandIdentity(clean, snapshot);
    expect(identity.has('brandx probiotic')).toBe(true);
    expect(identity.has(SHARED)).toBe(false);
    expect(identity.has('probiotic supplement')).toBe(false);
    expect(identity.has('brandx labs')).toBe(false);
  });

  it('marked negative and present in the copy, it STILL FAILS C28', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(SHARED, 'Planted')], l, pack, snapshot),
      ...NEGATIVE_FLOOR,
    ];
    const row = rowFor(l.keywords, SHARED);
    expect(row.status).toBe('negative');
    expect(row.note).toBeUndefined();
    expect(
      c28(l).some(
        (f) => f.context.toLowerCase().includes('negative term') && f.context.includes(SHARED),
      ),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('the live case, literally: brand "Instant Immunity" exempts itself and NOT "immunity"', () => {
    const live: ListingSnapshot = {
      ...snapshot,
      title: 'Instant Immunity Support Formula, 60 Count',
      attributes: { brand_name: 'Instant Immunity LLC' },
    };
    const identity = ownBrandIdentity({ productName: '' } as OptimizedListing, live);
    // the declared string, and the BRAND TOKEN IN THE TITLE it agrees with
    expect(identity.has('instant immunity llc')).toBe(true);
    expect(identity.has('instant immunity')).toBe(true);
    // ...and nothing that merely overlaps it
    expect(identity.has('immunity')).toBe(false);
    expect(identity.has('immunity support')).toBe(false);
    expect(identity.has('instant')).toBe(false);
    expect(identity.has('instant immunity support')).toBe(false);
  });

  it('the title token needs at least TWO agreeing words, so one generic word can never exempt itself', () => {
    const other: ListingSnapshot = {
      ...snapshot,
      title: 'Instant Relief Blend, 60 Count',
      attributes: { brand_name: 'Instant Immunity LLC' },
    };
    const identity = ownBrandIdentity({ productName: '' } as OptimizedListing, other);
    expect(identity.has('instant immunity llc')).toBe(true);
    expect(identity.has('instant')).toBe(false);
    expect(identity.size).toBe(1);
  });
});

// ===========================================================================
// (d) EVERY IDENTITY SOURCE — manufacturer-only and productName-only
// ===========================================================================

describe('(d) manufacturer-only and productName-only matches are exempted too', () => {
  it('MANUFACTURER-only: a term matching only `manufacturer` is reclassified', () => {
    expect(MANUFACTURER).not.toBe(BRAND);
    expect(MANUFACTURER).not.toBe(PRODUCT_NAME);
    const l = clone();
    const derived = deriveKeywordPlacement(
      [negativeRow(MANUFACTURER, 'Brand term')],
      l,
      pack,
      snapshot,
    );
    expect(derived[0]!.status).not.toBe('negative');
    expect(derived[0]!.surfaces).toContain('attributes');
    expect(derived[0]!.note).toContain('OWN brand identity');

    l.keywords = [...derived, ...NEGATIVE_FLOOR];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('PRODUCTNAME-only: exempted from a snapshot carrying NO brand fields and no title', () => {
    const bare: ListingSnapshot = { ...snapshot, title: '', attributes: {} };
    expect(clean.productName).toBe(PRODUCT_NAME);
    const identity = ownBrandIdentity(clean, bare);
    expect([...identity]).toEqual(['brandx probiotic']);

    const l = clone();
    const derived = deriveKeywordPlacement([negativeRow(PRODUCT_NAME, 'Brand term')], l, pack, bare);
    expect(derived[0]!.status).toBe('placed');
    expect(derived[0]!.surfaces).toContain('title');
    expect(derived[0]!.note).toContain('OWN brand identity');

    l.keywords = [...derived, ...NEGATIVE_FLOOR];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('punctuation and case are normalised the same way the rest of the keyword code does', () => {
    const l = clone();
    const derived = deriveKeywordPlacement(
      [negativeRow('  brandx labs, llc.  ', 'Brand term')],
      l,
      pack,
      snapshot,
    );
    expect(derived[0]!.status).not.toBe('negative');
    expect(derived[0]!.note).toContain('OWN brand identity');
  });

  it('an own-brand row the copy carries NOWHERE is recorded as candidate, with BOTH facts on the note', () => {
    const l = clone();
    // A brand string the finished copy does not use anywhere.
    const bare: ListingSnapshot = { ...snapshot, title: '', attributes: { brand_name: 'Northwind Apothecary' } };
    const derived = deriveKeywordPlacement(
      [negativeRow('Northwind Apothecary', 'Brand term')],
      l,
      pack,
      bare,
    );
    expect(derived[0]!.status).toBe('candidate');
    expect(derived[0]!.surfaces).toEqual([]);
    expect(derived[0]!.note).toContain('OWN brand identity');
    expect(derived[0]!.note).toContain('no surface the pack knows');
  });
});

// ===========================================================================
// (e) THE NEGATIVE FLOOR CANNOT BE SATISFIED BY RECLASSIFIED ROWS
// ===========================================================================

describe('(e) minNegatives counts only SURVIVING negatives', () => {
  const selfOnly = (): KeywordTerm[] => [
    negativeRow(BRAND, 'Brand term'),
    negativeRow(MANUFACTURER, 'Brand term'),
    negativeRow(PRODUCT_NAME, 'Brand term'),
  ];

  it('the floor is 3, and three self-references would otherwise have met it', () => {
    expect(pack.rules.keywordRules!.minNegatives).toBe(3);
    expect(selfOnly()).toHaveLength(3);
  });

  it('a run whose ONLY negatives are self-references FAILS the floor', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(selfOnly(), l, pack, snapshot);
    expect(l.keywords.every((r) => r.status !== 'negative')).toBe(true);
    expect(
      c28(l).some((f) => f.context.includes('negative term(s)')),
      JSON.stringify(c28(l).map((f) => f.context)),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and the SAME rows plus three genuine negatives clear it (the floor still works)', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement(selfOnly(), l, pack, snapshot),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// THE MODEL IS ALSO TOLD — from PACK DATA, no literal in lib/engine
// ===========================================================================

describe('the keywords prompt carries the own-brand line, from pack data', () => {
  it('renders the pack string verbatim', () => {
    const note = pack.rules.keywordRules!.ownBrandNote!;
    expect(note.length).toBeGreaterThan(40);
    const prompts = buildGroupPrompts(pack);
    const rendered = prompts.keywords(snapshot, clean);
    expect(rendered).toContain(note);
  });

  it('and renders nothing at all when the pack ships no line (pack-driven, not hard-coded)', () => {
    const p = JSON.parse(JSON.stringify(pack)) as typeof pack;
    delete p.rules.keywordRules!.ownBrandNote;
    const rendered = buildGroupPrompts(p).keywords(snapshot, clean);
    expect(rendered).not.toContain('NEVER A NEGATIVE TERM');
  });
});
