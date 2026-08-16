import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, keywordSurfaceText, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS3 — C28, THE KEYWORD PLACEMENT CHECK.
 *
 * Every rule is asserted in BOTH DIRECTIONS, because over-blocking a truthful
 * declaration is exactly as bad as accepting a false one: a check that fails a
 * correct keyword reference would train an operator to ignore it, which is
 * indistinguishable from not having it.
 *
 * The suite drives the check against the REAL golden listing rather than a
 * hand-built stub, so a row's truth is a property of the actual emitted
 * strings — the same thing the operator is going to paste.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;

/** Replace the whole keyword artifact; everything else stays golden. */
const withKeywords = (rows: unknown[]): OptimizedListing => {
  const l = clone();
  (l as { keywords: unknown[] }).keywords = rows;
  return l;
};

const c28 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c28KeywordPlacement(l, p);
const ids = (fs: Failure[]): string[] => fs.map((f) => f.checkId);

/** The three negative rows every artifact needs to clear `minNegatives`. */
const NEGATIVE_FLOOR: KeywordTerm[] = [
  { term: 'diabetes', tier: 'negative', status: 'negative', surfaces: [], why: 'Named condition' },
  { term: 'detox', tier: 'negative', status: 'negative', surfaces: [], why: 'Implied-treatment framing' },
  { term: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
];
const withFloor = (...rows: KeywordTerm[]): OptimizedListing =>
  withKeywords([...rows, ...NEGATIVE_FLOOR]);

// ===========================================================================
// 0 — THE GOLDEN ARTIFACT IS TRUE (the "does not over-block" baseline)
// ===========================================================================

describe('C28 — the golden keyword reference passes, and it is not a vacuous pass', () => {
  it('the golden listing carries a non-trivial artifact and C28 reports nothing', () => {
    expect((clean.keywords ?? []).length).toBeGreaterThanOrEqual(8);
    expect(c28(clean)).toEqual([]);
  });

  it('the artifact really exercises every status the pack knows', () => {
    const statuses = new Set((clean.keywords ?? []).map((r) => r.status));
    for (const s of pack.rules.keywordRules!.statuses) {
      expect(statuses.has(s as KeywordTerm['status']), `status '${s}' is never exercised`).toBe(true);
    }
  });

  it('the full gate is green on the golden listing (C28 included)', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// 1 — `placed`: BOTH DIRECTIONS, per surface
// ===========================================================================

describe('C28 placed — a declaration is verified against the emitted string', () => {
  /** Surfaces the golden copy genuinely carries this term on. */
  const TRUE_PLACEMENTS: [string, string][] = [
    ['50 billion cfu', 'title'],
    ['50 billion cfu', 'title75'],
    ['50 billion cfu', 'bullet1'],
    ['50 billion cfu', 'description'],
    ['50 billion cfu', 'aplus'],
    ['50 billion cfu', 'faq'],
    ['vegan', 'itemHighlights'],
    ['vegan', 'bullet5'],
    ['vegan', 'attributes'],
    ['digestive balance', 'title'],
  ];

  it.each(TRUE_PLACEMENTS)('PASSES: "%s" declared on %s (it is really there)', (term, surface) => {
    const l = withFloor({ term, tier: 1, status: 'placed', surfaces: [surface], why: 'evidence' });
    expect(c28(l)).toEqual([]);
  });

  /** The same terms on surfaces they are NOT on. */
  const FALSE_PLACEMENTS: [string, string][] = [
    ['50 billion cfu', 'backend'],
    ['vegan', 'backend'],
    ['digestive balance', 'title75'],
    ['shelf stable', 'bullet2'], // the copy hyphenates it — a real near miss
    ['acidophilus', 'description'],
    ['organic probiotic', 'title'],
  ];

  it.each(FALSE_PLACEMENTS)('FAILS: "%s" declared on %s (it is not there)', (term, surface) => {
    const l = withFloor({ term, tier: 1, status: 'placed', surfaces: [surface], why: 'evidence' });
    const fs = c28(l);
    expect(ids(fs)).toContain('C28');
    expect(fs.some((f) => f.context.includes(term) && f.context.includes(surface))).toBe(true);
  });

  it('FAILS: a placed row that declares no surface at all', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: [], why: 'evidence' });
    expect(c28(l).some((f) => f.context.includes('declares no surface'))).toBe(true);
  });

  it('FAILS: a placed row declaring a surface outside the pack vocabulary', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: ['packaging'], why: 'evidence' });
    expect(c28(l).some((f) => f.context.includes('unknown surface'))).toBe(true);
  });

  it('FAILS when the COPY moves out from under a true declaration', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: ['itemHighlights'], why: 'evidence' });
    expect(c28(l)).toEqual([]);
    l.itemHighlights = l.itemHighlights.replace(/vegan/gi, 'plant based');
    expect(c28(l).some((f) => f.context.includes('vegan'))).toBe(true);
  });
});

// ===========================================================================
// 2 — `backend`: present in the field AND absent from every visible surface
// ===========================================================================

describe('C28 backend-only — indexed invisibly, both directions', () => {
  it('PASSES: a term that is in the backend field and nowhere visible', () => {
    const l = withFloor({ term: 'acidophilus', tier: 'backend', status: 'backend', surfaces: ['backend'], why: 'variant' });
    expect(c28(l)).toEqual([]);
  });

  it('FAILS: a backend-only term that is NOT in the backend field', () => {
    const l = withFloor({ term: 'kombucha', tier: 'backend', status: 'backend', surfaces: ['backend'], why: 'variant' });
    expect(c28(l).some((f) => f.context.includes('not in the backend field'))).toBe(true);
  });

  const VISIBLE_LEAKS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} acidophilus`; }],
    ['description', (l) => { l.description = `Acidophilus blend. ${l.description}`; }],
    ['bullet3', (l) => { l.bullets[2] = `Acidophilus routine: ${l.bullets[2]}`; }],
    ['attributes', (l) => { l.attributes.subject_keyword = 'acidophilus'; }],
    ['aplus', (l) => { l.aplusContent.modules[0]!.body = `Acidophilus. ${l.aplusContent.modules[0]!.body}`; }],
    ['qa', (l) => { l.qa[0]!.a = `Acidophilus. ${l.qa[0]!.a}`; }],
  ];

  it.each(VISIBLE_LEAKS)('FAILS: the backend-only term leaks onto %s', (_surface, leak) => {
    const l = withFloor({ term: 'acidophilus', tier: 'backend', status: 'backend', surfaces: ['backend'], why: 'variant' });
    expect(c28(l)).toEqual([]);
    leak(l);
    expect(c28(l).some((f) => f.context.includes('also appears on visible surface'))).toBe(true);
  });
});

// ===========================================================================
// 3 — `negative`: nowhere at all (R50 — this is where rival brands live)
// ===========================================================================

describe('C28 negative — verified absent everywhere, both directions', () => {
  it('PASSES: a rival brand name that appears nowhere', () => {
    const l = withKeywords([
      { term: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
      ...NEGATIVE_FLOOR,
    ]);
    expect(c28(l)).toEqual([]);
  });

  const PLANTS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} GreenLuxe`; }],
    ['title75', (l) => { l.title75 = `GreenLuxe ${l.title75}`; }],
    ['itemHighlights', (l) => { l.itemHighlights = `${l.itemHighlights}, greenluxe`; }],
    ['bullet1', (l) => { l.bullets[0] = `Better than GreenLuxe: ${l.bullets[0]}`; }],
    ['description', (l) => { l.description = `GreenLuxe alternative. ${l.description}`; }],
    ['backend', (l) => { l.backendSearchTerms = `greenluxe ${l.backendSearchTerms}`; }],
    ['attributes', (l) => { l.attributes.subject_keyword = 'greenluxe'; }],
    ['aplus', (l) => { l.aplusContent.modules[1]!.body = `Unlike GreenLuxe. ${l.aplusContent.modules[1]!.body}`; }],
    ['faq', (l) => { l.aplusContent.faq[0]!.a = `Unlike GreenLuxe. ${l.aplusContent.faq[0]!.a}`; }],
    ['qa', (l) => { l.qa[1]!.a = `Unlike GreenLuxe. ${l.qa[1]!.a}`; }],
    ['images', (l) => { l.imagePlan[1]!.notes = `Match the GreenLuxe layout`; }],
  ];

  it.each(PLANTS)('FAILS: the rival brand name planted on %s', (surface, plant) => {
    const l = withKeywords([
      { term: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
      ...NEGATIVE_FLOOR,
    ]);
    expect(c28(l)).toEqual([]);
    plant(l);
    const fs = c28(l);
    expect(fs.some((f) => f.context.includes('negative term') && f.context.includes(surface))).toBe(true);
  });

  /**
   * The disclaimer is REQUIRED legal text and names terms that are otherwise
   * negative. Reporting it would be over-blocking of the worst kind: the only
   * way to satisfy the check would be to delete a sentence the law requires.
   */
  it('PASSES: a negative term that occurs ONLY inside the verbatim disclaimer', () => {
    const disclaimerWord = 'disease';
    expect(clean.description).toContain(disclaimerWord);
    const l = withKeywords([
      { term: disclaimerWord, tier: 'negative', status: 'negative', surfaces: [], why: 'Named-condition vocabulary' },
      ...NEGATIVE_FLOOR,
    ]);
    expect(c28(l)).toEqual([]);
  });

  /**
   * S1 — THE SAME TERM OUTSIDE THE DISCLAIMER STILL FAILS THE RUN, BY THE CHECK
   * THAT OWNS IT.
   *
   * 'disease' is COMPLIANCE VOCABULARY, not a rival brand, so C28 now defers it
   * to C6 (see THE DEFERENCE in `lib/gate/checks/c-keywords.ts`) — which reads
   * the word in context, with de-obfuscation, the strict negation guard and the
   * pack's benign-context subtraction that this leg has none of. This test used
   * to assert the C28 leg fired; what it is really about is that the copy is
   * REJECTED, and it still is. The two directions are both here: the deference
   * happened, AND nothing shipped because of it.
   */
  it('DEFERRED but NOT dropped: the compliance term outside the disclaimer still fails the run', () => {
    const rows = [
      { term: 'disease', tier: 'negative', status: 'negative', surfaces: [], why: 'Named-condition vocabulary' },
      ...NEGATIVE_FLOOR,
    ];
    const l = withKeywords(rows);
    l.bullets[1] = `Everyday routine: written for disease free living`;
    // C28 is silent — the word's USAGE is not its question.
    expect(c28(l).some((f) => f.context.includes('negative term'))).toBe(false);
    // …and the run fails anyway, at the check that owns the lexicon.
    const result = runGate(l, pack, ctx);
    expect(result.pass).toBe(false);
    expect(
      result.failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]'),
      JSON.stringify(result.failures),
    ).toBe(true);
  });

  it('FAILS: fewer negative rows than the pack floor', () => {
    const l = withKeywords([
      { term: 'vegan', tier: 3, status: 'placed', surfaces: ['itemHighlights'], why: 'evidence' },
      NEGATIVE_FLOOR[0],
    ]);
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });

  it('PASSES at exactly the floor (the boundary is not off by one)', () => {
    const min = pack.rules.keywordRules!.minNegatives;
    expect(NEGATIVE_FLOOR).toHaveLength(min);
    expect(c28(withKeywords([...NEGATIVE_FLOOR]))).toEqual([]);
  });
});

// ===========================================================================
// 4 — `candidate`, `captured-via`, `not-targeted`
// ===========================================================================

describe('C28 candidate / captured-via / not-targeted', () => {
  it('PASSES: a candidate held out of the current copy', () => {
    const l = withFloor({ term: 'organic probiotic', tier: 'candidate', status: 'candidate', surfaces: [], why: 'not certified yet', home: 'PPC exact' });
    expect(c28(l)).toEqual([]);
  });

  it('FAILS: a candidate that is already in the copy (the "not yet" is a fiction)', () => {
    const l = withFloor({ term: 'shelf stable', tier: 'candidate', status: 'candidate', surfaces: [], why: 'later cycle' });
    expect(c28(l).some((f) => f.context.includes('candidate term'))).toBe(true);
  });

  it('PASSES: captured-via WITH a documented compliant route (K4)', () => {
    const l = withFloor({ term: 'immune boost', tier: 'demand', status: 'captured-via', surfaces: [], why: 'efficacy framing avoided', via: 'the compliant daily wellness cluster' });
    expect(c28(l)).toEqual([]);
  });

  it('FAILS: captured-via with NO route — an undocumented recapture is a banned term with a label', () => {
    const l = withFloor({ term: 'immune boost', tier: 'demand', status: 'captured-via', surfaces: [], why: 'efficacy framing avoided' });
    expect(c28(l).some((f) => f.context.includes('no route recorded'))).toBe(true);
  });

  it('not-targeted is deliberately NOT scanned — present or absent, it never fails', () => {
    const absent = withFloor({ term: 'weight loss', tier: 'strategy', status: 'not-targeted', surfaces: [], why: 'adjacent intent converts badly' });
    expect(c28(absent)).toEqual([]);
    const present = withFloor({ term: 'shelf stable', tier: 'strategy', status: 'not-targeted', surfaces: [], why: 'strategy call' });
    expect(c28(present)).toEqual([]);
  });
});

// ===========================================================================
// 5 — THE FOUR-TEST SCREEN (K4), reusing the gate's own lexicons
// ===========================================================================

describe('C28 four-test screen — a banned term can never be TARGETED', () => {
  const BANNED: string[] = ['diabetes', 'arthritis', 'hypertension', 'menopause', 'maximum strength', 'clinically proven'];

  it.each(BANNED)('FAILS: "%s" declared placed', (term) => {
    const l = withFloor({ term, tier: 1, status: 'placed', surfaces: ['description'], why: 'volume' });
    expect(c28(l).some((f) => f.context.includes('matches the banned lexicon'))).toBe(true);
  });

  it.each(BANNED)('FAILS: "%s" declared backend-only', (term) => {
    const l = withFloor({ term, tier: 'backend', status: 'backend', surfaces: ['backend'], why: 'volume' });
    expect(c28(l).some((f) => f.context.includes('matches the banned lexicon'))).toBe(true);
  });

  it.each(BANNED)('PASSES: "%s" recorded as negative (the lawful home for it)', (term) => {
    const l = withKeywords([
      { term, tier: 'negative', status: 'negative', surfaces: [], why: 'banned vocabulary' },
      ...NEGATIVE_FLOOR,
    ]);
    expect(c28(l)).toEqual([]);
  });

  it('PASSES: a banned term recorded as captured-via with its compliant route', () => {
    const l = withFloor({ term: 'arthritis', tier: 'demand', status: 'captured-via', surfaces: [], why: 'banned vocabulary', via: 'the joint comfort structure/function cluster' });
    expect(c28(l)).toEqual([]);
  });

  it('the screen is not a blanket ban: an ordinary term is still targetable', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: ['itemHighlights'], why: 'filter facet' });
    expect(c28(l)).toEqual([]);
  });
});

// ===========================================================================
// 6 — STRUCTURE, MALFORMED INPUT AND FAIL-CLOSED BEHAVIOUR
// ===========================================================================

describe('C28 structure — the artifact itself must be well formed', () => {
  it('FAILS: no artifact at all', () => {
    const l = clone();
    delete (l as { keywords?: unknown }).keywords;
    expect(ids(c28(l))).toContain('C28');
  });

  it('FAILS: an empty artifact', () => {
    expect(ids(c28(withKeywords([])))).toContain('C28');
  });

  it('FAILS: a row with no evidence', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: ['itemHighlights'], why: '' });
    expect(c28(l).some((f) => f.context.includes('has no evidence'))).toBe(true);
  });

  it('FAILS: a row with a status outside the pack vocabulary', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'maybe' as KeywordTerm['status'], surfaces: [], why: 'x' });
    expect(c28(l).some((f) => f.context.includes("status 'maybe'"))).toBe(true);
  });

  /**
   * CRASH IS NOT DETECTION. A malformed artifact must produce FAILURES; a
   * thrown gate is a fail-OPEN in practice, because the caller never receives
   * a `verified:false` at all.
   */
  const MALFORMED: [string, unknown[]][] = [
    ['null rows', [null, null]],
    ['non-object rows', ['vegan', 42, true]],
    ['missing term', [{ tier: 1, status: 'placed', surfaces: ['title'], why: 'x' }]],
    ['non-string term', [{ term: 12, status: 'placed', surfaces: ['title'], why: 'x' }]],
    ['surfaces not an array', [{ term: 'vegan', status: 'placed', surfaces: 'title', why: 'x' }]],
    ['surfaces holding null', [{ term: 'vegan', status: 'placed', surfaces: [null, undefined], why: 'x' }]],
    ['deeply wrong shape', [{ term: { a: 1 }, status: { b: 2 }, surfaces: [{ c: 3 }], why: [] }]],
  ];

  it.each(MALFORMED)('does not THROW on %s — it reports', (_label, rows) => {
    const l = withKeywords(rows);
    expect(() => c28(l)).not.toThrow();
    expect(() => runGate(l, pack, ctx)).not.toThrow();
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('does not throw when the LISTING is gutted under a valid artifact', () => {
    const l = withFloor({ term: 'vegan', tier: 3, status: 'placed', surfaces: ['itemHighlights', 'aplus', 'qa', 'images'], why: 'x' });
    const gutted = { ...l, aplusContent: undefined, qa: undefined, imagePlan: undefined, attributes: undefined } as unknown as OptimizedListing;
    expect(() => c28(gutted)).not.toThrow();
    expect(() => runGate(gutted, pack, ctx)).not.toThrow();
  });
});

// ===========================================================================
// 7 — CLOSED WORLD, BOTH DIRECTIONS + PACK INTEGRITY
// ===========================================================================

describe('C28 closed world', () => {
  it('every surface the pack declares resolves to text (no silently unscanned surface)', () => {
    const kr = pack.rules.keywordRules!;
    for (const name of [...kr.visibleSurfaces, ...kr.backendSurfaces]) {
      expect(keywordSurfaceText(clean, name), `surface '${name}' has no resolver`).not.toBeNull();
    }
  });

  it('FAILS when the pack declares a surface the gate cannot read', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    p.rules.keywordRules!.visibleSurfaces = [...p.rules.keywordRules!.visibleSurfaces, 'packagingInsert'];
    expect(c28(clean, p).some((f) => f.context.includes('packagingInsert'))).toBe(true);
  });

  it('emptying any keywordRules piece raises a blocking PACK failure, not a silent pass', () => {
    const PIECES = ['visibleSurfaces', 'backendSurfaces', 'statuses', 'minNegatives'] as const;
    for (const piece of PIECES) {
      const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
      if (piece === 'minNegatives') p.rules.keywordRules!.minNegatives = 0;
      else p.rules.keywordRules![piece] = [];
      const result = runGate(clean, p, ctx);
      expect(result.pass, piece).toBe(false);
      expect(
        result.failures.some((f) => f.checkId === 'PACK' && f.context.includes(`keywordRules.${piece}`)),
        piece,
      ).toBe(true);
    }
  });
});
