import { beforeAll, describe, expect, it } from 'vitest';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import { optimize } from '@/lib/engine/optimize';
import { c6BannedTerms, c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type {
  CompetitorIngestion,
  Failure,
  KeywordTerm,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * S1 — C28's `negative` STATUS WAS DOING TWO JOBS, AND ONLY ONE OF THEM IS ITS
 * OWN.
 *
 * THE LIVE DEFECT. Production, ASIN B00WNDG7V8 (a dental probiotic). One
 * failure, and the run ended `verified:false`:
 *
 *   C28 | keywords[26] | negative term 'cavity' appears on 'attributes'
 *
 * The attribute was
 *   recommended_uses_for_product = "General wellness support for oral cavity
 *   function"
 *
 * "ORAL CAVITY" IS ANATOMY — the mouth — not dental caries. The copy is lawful,
 * and C6 (the purpose-built disease-term check, which has de-obfuscation, a
 * negation guard and pack-declared benign-context subtraction) correctly did NOT
 * fire on it: the pack lists the anatomical span as a benign-context phrase.
 * Only C28 fired, because its `negative` leg was a plain whole-term match with
 * none of that machinery. The only fix that failure ASKED for was "delete a
 * lawful anatomical phrase from your own attributes", so no repair round could
 * clear it.
 *
 * THE ROOT CAUSE, NOT THE ONE TERM. `negative` carries two jobs: RIVAL-BRAND
 * EXCLUSION (R50 — the reason C28 scans every surface, and the only enforcement
 * a rival brand has anywhere in this system, because a brand name is in no
 * lexicon) and "COMPLIANCE TERMS TO AVOID" — which C6/A2/C19 already enforce
 * properly, in context. C28 duplicating job 2 as a blunt substring match is
 * strictly less accurate than the check that owns it, and this false positive is
 * the bill for that.
 *
 * THE FIX. A model-declared `negative` row whose term IS a compliance-lexicon
 * term keeps its row (documentation, and it still steers generation), still
 * counts toward `minNegatives`, and raises no C28 failure of its own — the
 * compliance checks are the authority on whether the word's USAGE is a
 * violation. Job 1 is untouched.
 *
 * WHAT THIS FILE ASSERTS, in both directions throughout:
 *   (a) the live shape is clean, and C6 is silent too — the copy really is lawful
 *   (b) the same term used as a GENUINE CLAIM still fails, from every surface,
 *       via the check that owns it — the deference opened no hole
 *   (c) R50 is unweakened: a rival brand marked `negative` still fails from
 *       every surface, the invisible ones included
 *   (d) the AUTOMATIC competitor-derived rival set is untouched, including the
 *       two collision cases the deference could in principle have reached
 *   (e) `minNegatives` is unmoved by any of it
 *   (f) the golden fixture still gates with ZERO failures
 *   (g) the bounds: no compliance module => no deference at all
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;

const c28 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c28KeywordPlacement(l, p);

/**
 * THE LIVE TERM AND THE LIVE ATTRIBUTE.
 *
 * `cavity` is a dental disease noun in the pack's `oral` subcategory list;
 * `oral cavity` is a `benignContextPhrases` entry (anatomy). Both come off the
 * pack — nothing here re-authors a lexicon.
 */
const TERM = 'cavity';
const LAWFUL_ATTRIBUTE = 'General wellness support for oral cavity function';

/** The three negative rows an artifact needs to clear `minNegatives`. */
const NEGATIVE_FLOOR: KeywordTerm[] = [
  { term: 'diabetes', tier: 'negative', status: 'negative', surfaces: [], why: 'Named condition' },
  { term: 'detox', tier: 'negative', status: 'negative', surfaces: [], why: 'Implied-treatment framing' },
  { term: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
];

const negativeRow = (term: string, why = 'Compliance vocabulary this copy avoids'): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});

/** The golden listing with an explicit artifact — everything else stays golden. */
const withArtifact = (rows: KeywordTerm[]): OptimizedListing => {
  const l = clone();
  l.keywords = rows;
  return l;
};

/** THE LIVE SHAPE: the lawful attribute plus the `cavity` negative row. */
const liveShape = (): OptimizedListing => {
  const l = withArtifact([negativeRow(TERM), ...NEGATIVE_FLOOR]);
  l.attributes.recommended_uses_for_product = LAWFUL_ATTRIBUTE;
  return l;
};

const negativeHits = (fs: Failure[]): Failure[] =>
  fs.filter((f) => f.context.includes('negative term') && !f.context.includes('negative term(s)'));

/** Every check that OWNS compliance vocabulary — the ones the deference hands to. */
const COMPLIANCE_OWNERS = ['C6', 'A2', 'C19', 'C21', 'C22'];

// ===========================================================================
// (a) THE LIVE SHAPE — clean, and lawful for the right reason
// ===========================================================================

describe('(a) the live shape: `cavity` negative + the oral-cavity attribute', () => {
  it('the fixture really reproduces the live shape', () => {
    const l = liveShape();
    expect(l.attributes.recommended_uses_for_product).toBe(LAWFUL_ATTRIBUTE);
    expect((l.keywords ?? []).some((r) => r.term === TERM && r.status === 'negative')).toBe(true);
  });

  it('C28 is CLEAN — no `negative term` failure, and no failure at all', () => {
    expect(c28(liveShape())).toEqual([]);
  });

  it('the whole gate passes: runGate().pass === true, zero failures', () => {
    expect(runGate(liveShape(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  /**
   * The load-bearing half of (a): the copy is not merely UNREPORTED, it is
   * LAWFUL — and the check that owns the word says so independently. If C6 fired
   * here the deference would be hiding a real violation instead of removing a
   * duplicate.
   */
  it('C6 IS ALSO SILENT — the anatomical span really is lawful copy', () => {
    const l = liveShape();
    expect(c6BannedTerms(l, pack)).toEqual([]);
    expect(
      c6BannedTerms(l, pack).some((f) => f.field === 'attributes.recommended_uses_for_product'),
    ).toBe(false);
  });

  it('the un-deferred shape is what used to fail: without the row nothing changes either', () => {
    // The attribute alone was never the problem — C6 was always silent on it.
    const l = clone();
    l.attributes.recommended_uses_for_product = LAWFUL_ATTRIBUTE;
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (b) THE SAME TERM AS A GENUINE CLAIM — still fails, from every surface
// ===========================================================================

/**
 * A GENUINE therapeutic claim built on the very same word, planted surface by
 * surface. Every one of these must still fail the run — via whichever check owns
 * the lexicon, which is the whole point of the deference.
 */
const CLAIM = 'Prevents cavities and reverses tooth decay';

const CLAIM_PLANTERS: [string, (l: OptimizedListing) => void][] = [
  ['title', (l) => { l.title = `${l.title} ${CLAIM}`; }],
  ['itemHighlights', (l) => { l.itemHighlights = `${l.itemHighlights}. ${CLAIM}`; }],
  ['bullet2', (l) => { l.bullets[1] = `Dental defense: ${CLAIM}`; }],
  ['description', (l) => { l.description = `${CLAIM}. ${l.description}`; }],
  ['backend', (l) => { l.backendSearchTerms = `${l.backendSearchTerms} ${CLAIM}`; }],
  ['attributes', (l) => { l.attributes.recommended_uses_for_product = CLAIM; }],
  ['aplus body', (l) => { l.aplusContent.modules[1]!.body = `${CLAIM}. ${l.aplusContent.modules[1]!.body}`; }],
  ['aplus bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = CLAIM; }],
  ['faq', (l) => { l.aplusContent.faq[0]!.a = `${CLAIM}. ${l.aplusContent.faq[0]!.a}`; }],
  ['qa', (l) => { l.qa[0]!.a = `${CLAIM}. ${l.qa[0]!.a}`; }],
  ['images altText', (l) => { l.imagePlan[2]!.altText = CLAIM; }],
  ['video onScreenText', (l) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), CLAIM]; }],
];

describe('(b) the deference opened NO hole — a real claim on the same word still fails', () => {
  it.each(CLAIM_PLANTERS)('FAILS the run when the claim is planted on %s', (label, plant) => {
    const l = liveShape();
    plant(l);
    const result = runGate(l, pack, ctx);
    expect(result.pass, label).toBe(false);
    expect(
      result.failures.some((f) => COMPLIANCE_OWNERS.includes(f.checkId)),
      `${label}: ${JSON.stringify(result.failures.map((f) => `${f.checkId} ${f.field}`))}`,
    ).toBe(true);
  });

  it('the bare disease word outside the anatomy span is still reported by its owner', () => {
    const l = liveShape();
    l.bullets[1] = 'Cavity protection for daily use';
    const hits = c6BannedTerms(l, pack);
    expect(hits.some((f) => f.field === 'bullets[1]'), JSON.stringify(hits)).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  /**
   * EQUALITY, NEVER CONTAINMENT (bound 1). A claim PHRASE built around a lexicon
   * word is not a lexicon term, so it is not deferred at all — C28's own leg
   * still fires on it.
   */
  it('a claim PHRASE around the word is not a lexicon term, so C28 does not defer it', () => {
    const l = withArtifact([negativeRow('cavity prevention'), ...NEGATIVE_FLOOR]);
    l.attributes.recommended_uses_for_product = 'Cavity prevention for daily use';
    expect(negativeHits(c28(l)).length, JSON.stringify(c28(l))).toBeGreaterThan(0);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// (c) R50 — UNWEAKENED. A rival brand marked `negative` fails from everywhere.
// ===========================================================================

const RIVAL = 'GreenLuxe';

const RIVAL_PLANTERS: [string, (l: OptimizedListing) => void][] = [
  ['title', (l) => { l.title = `${l.title} ${RIVAL}`; }],
  ['bullet1', (l) => { l.bullets[0] = `Better than ${RIVAL}: ${l.bullets[0]}`; }],
  ['description', (l) => { l.description = `${RIVAL} alternative. ${l.description}`; }],
  ['backend', (l) => { l.backendSearchTerms = `${RIVAL} ${l.backendSearchTerms}`; }],
  ['attributes', (l) => { l.attributes.subject_keyword = RIVAL.toLowerCase(); }],
  ['aplus bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = `${RIVAL} banner`; }],
  ['videoBrief', (l) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), RIVAL]; }],
  ['imagePlan altText', (l) => { l.imagePlan[2]!.altText = `${RIVAL} layout reference`; }],
];

describe('(c) R50 is exactly as strong as it was — every surface, still failing', () => {
  it('the baseline: with the rival nowhere in the copy, C28 is clean', () => {
    expect(c28(liveShape())).toEqual([]);
  });

  it.each(RIVAL_PLANTERS)('FAILS: the rival brand negative planted in %s', (label, plant) => {
    const l = liveShape();
    plant(l);
    const fs = c28(l);
    expect(
      negativeHits(fs).some((f) => f.context.toLowerCase().includes(RIVAL.toLowerCase())),
      `${label}: ${JSON.stringify(fs.map((f) => f.context))}`,
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass, label).toBe(false);
  });

  it('a rival brand CONTAINING a lexicon word is NOT deferred — containment is not equality', () => {
    const brand = 'Cavity Guard Labs';
    const l = withArtifact([negativeRow(brand, 'Rival brand'), ...NEGATIVE_FLOOR]);
    l.description = `${l.description}\n${brand} is the alternative.`;
    expect(
      negativeHits(c28(l)).some((f) => f.context.includes(brand)),
      JSON.stringify(c28(l).map((f) => f.context)),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// (d) THE AUTOMATIC COMPETITOR-DERIVED RIVAL SET — untouched
// ===========================================================================

const competitor = (asin: string, attributes: Record<string, string>): CompetitorIngestion => ({
  asin,
  snapshot: { ...snapshot, asin, title: 'A rival listing title', attributes } as ListingSnapshot,
});

const AUTO_BRAND = 'Northwind Apothecary';
const AUTO_RIVALS = [competitor('B0RIVAL0001', { brand_name: AUTO_BRAND })];

const withAuto = (l: OptimizedListing, competitors = AUTO_RIVALS): Failure[] =>
  c28KeywordPlacement(l, pack, { ...ctx, rivalBrands: rivalBrandNames(competitors, l, snapshot) });

const gateWithAuto = (l: OptimizedListing, competitors = AUTO_RIVALS) =>
  runGate(l, pack, { ...ctx, rivalBrands: rivalBrandNames(competitors, l, snapshot) });

describe('(d) the automatic competitor-derived rival set is not reachable from here', () => {
  it('the clean live shape stays clean with competitors supplied', () => {
    expect(gateWithAuto(liveShape())).toEqual({ pass: true, failures: [] });
  });

  /** The same eight surfaces, planted with the INGESTED brand instead. */
  const AUTO_PLANTERS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} ${AUTO_BRAND}`; }],
    ['bullet1', (l) => { l.bullets[0] = `Better than ${AUTO_BRAND}: ${l.bullets[0]}`; }],
    ['description', (l) => { l.description = `${AUTO_BRAND} alternative. ${l.description}`; }],
    ['backend', (l) => { l.backendSearchTerms = `${AUTO_BRAND} ${l.backendSearchTerms}`; }],
    ['attributes', (l) => { l.attributes.subject_keyword = AUTO_BRAND.toLowerCase(); }],
    ['aplus bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = `${AUTO_BRAND} banner`; }],
    ['videoBrief', (l) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), AUTO_BRAND]; }],
    ['imagePlan altText', (l) => { l.imagePlan[2]!.altText = `${AUTO_BRAND} layout reference`; }],
  ];

  it.each(AUTO_PLANTERS)('the ingested competitor brand still fires from %s', (label, plant) => {
    const l = liveShape();
    plant(l);
    expect(
      withAuto(l).some((f) => f.context.includes('ingested competitor brand')),
      `${label}: ${JSON.stringify(withAuto(l).map((f) => f.context))}`,
    ).toBe(true);
    expect(gateWithAuto(l).pass, label).toBe(false);
  });

  /**
   * THE COLLISION CASE THE DEFERENCE COULD IN PRINCIPLE HAVE REACHED (bound 3).
   *
   * A competitor whose brand string happens to EQUAL a compliance-lexicon term
   * (here a two-word superlative ban — the automatic set never admits a
   * single-word brand) AND is also written onto the reference as a `negative`
   * row. The row is deferred, so it reports nothing; the automatic leg must
   * therefore not treat it as "already reported" — otherwise the operator's own
   * signal would be disarmed by a coincidence and nobody would report it.
   */
  it('a deferred row does NOT silence the automatic leg on a colliding brand', () => {
    const colliding = 'Maximum Strength';
    const rivals = [competitor('B0RIVAL0009', { brand_name: colliding })];
    expect(rivalBrandNames(rivals, clean, snapshot).map((n) => n.toLowerCase())).toContain(
      colliding.toLowerCase(),
    );
    const l = withArtifact([negativeRow(colliding, 'Rival brand'), ...NEGATIVE_FLOOR]);
    l.description = `${l.description}\n${colliding} is the alternative.`;
    // The declared row is deferred (it is a superlative ban)…
    expect(negativeHits(c28(l))).toEqual([]);
    // …and the automatic leg reports it anyway.
    expect(
      withAuto(l, rivals).some((f) => f.context.includes('ingested competitor brand')),
      JSON.stringify(withAuto(l, rivals).map((f) => f.context)),
    ).toBe(true);
    expect(gateWithAuto(l, rivals).pass).toBe(false);
  });

  it('the resolver itself is byte-for-byte unaffected by any of this', () => {
    expect(rivalBrandNames(undefined, clean, snapshot)).toEqual([]);
    expect(rivalBrandNames([], clean, snapshot)).toEqual([]);
    expect(rivalBrandNames(AUTO_RIVALS, clean, snapshot)).toEqual([AUTO_BRAND]);
  });
});

// ===========================================================================
// (e) minNegatives — unmoved
// ===========================================================================

describe('(e) the negative floor counts RECORDED rows, deferred or not', () => {
  const min = pack.rules.keywordRules!.minNegatives;

  it('a deferred row still counts toward the floor — the row IS on the list', () => {
    // Every one of these is compliance vocabulary, so every one is deferred.
    const allDeferred = [negativeRow('cavity'), negativeRow('diabetes'), negativeRow('miracle')];
    expect(allDeferred).toHaveLength(min);
    const l = withArtifact(allDeferred);
    l.attributes.recommended_uses_for_product = LAWFUL_ATTRIBUTE;
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(false);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('and the floor still FAILS one row short, deferred rows included', () => {
    const l = withArtifact([negativeRow('cavity'), negativeRow('diabetes')]);
    expect(
      c28(l).some((f) => f.context.includes(`${min - 1} negative term(s)`)),
      JSON.stringify(c28(l).map((f) => f.context)),
    ).toBe(true);
  });

  it('a deferred row whose term IS in the copy is still counted, not discarded', () => {
    const l = withArtifact([negativeRow('cavity'), negativeRow('diabetes'), negativeRow('miracle')]);
    l.attributes.recommended_uses_for_product = LAWFUL_ATTRIBUTE;
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(false);
  });
});

// ===========================================================================
// (f) THE GOLDEN FIXTURE — unchanged, zero failures
// ===========================================================================

describe('(f) the golden fixture is unchanged and still gates clean', () => {
  it('zero gate failures, and the negative rows are all still there', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
    const negatives = (clean.keywords ?? []).filter((r) => r.status === 'negative');
    expect(negatives.length).toBeGreaterThanOrEqual(pack.rules.keywordRules!.minNegatives);
    expect(negatives.map((r) => r.term)).toContain('greenluxe');
  });
});

// ===========================================================================
// (g) THE BOUNDS — no owning check, no deference
// ===========================================================================

describe('(g) with no compliance module NOTHING is deferred', () => {
  it('C6/A2/C19 are switched off, so C28 keeps its blunt scan', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete (p as { compliancePack?: unknown }).compliancePack;
    const l = withArtifact([negativeRow('diabetes'), ...NEGATIVE_FLOOR]);
    l.description = `${l.description}\nWritten for diabetes.`;
    expect(
      negativeHits(c28(l, p)).some((f) => f.context.includes('diabetes')),
      JSON.stringify(c28(l, p).map((f) => f.context)),
    ).toBe(true);
    // …and WITH the compliance module the very same row is deferred, because the
    // owning check is there to take it.
    expect(negativeHits(c28(l, pack))).toEqual([]);
  });
});
