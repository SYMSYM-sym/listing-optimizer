import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { toMarkdown } from '@/lib/export/markdown';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS10 — THE CRASH-VS-DETECTION ORACLE, extended to the NEW artifacts.
 *
 * Law 2 of the source project, in one sentence: a green gate proves only what
 * the oracle can DISTINGUISH, and a crash impersonates a detection. A thrown
 * `runGate` or a thrown `buildAudit` is a fail-OPEN in practice, because the
 * caller never receives `verified:false` at all — it receives a 500, and a 500
 * is not a verdict.
 *
 * This suite therefore asserts THREE things of every malformed shape, not one:
 *   1. nothing throws — not the gate, not the audit, not either exporter;
 *   2. the gate does not PASS (fails closed);
 *   3. the operator-facing surfaces still render, because a sheet that cannot
 *      be built is a sheet nobody can read the failures off.
 *
 * The shapes are the artifacts WS3/WS8/WS9 added, which the previous
 * structural suites could not have covered because they did not exist.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};

/** Anything at all can be assigned; that is the point of the suite. */
type Any = unknown;
const set = (l: OptimizedListing, key: string, value: Any): void => {
  (l as unknown as Record<string, Any>)[key] = value;
};

// ===========================================================================
// 1 — THE KEYWORD ARTIFACT (WS3)
// ===========================================================================

const KEYWORD_SHAPES: [string, (l: OptimizedListing) => void][] = [
  ['missing entirely', (l) => set(l, 'keywords', undefined)],
  ['null', (l) => set(l, 'keywords', null)],
  ['not an array', (l) => set(l, 'keywords', { term: 'vegan' })],
  ['a string', (l) => set(l, 'keywords', 'vegan')],
  ['an empty array', (l) => set(l, 'keywords', [])],
  ['rows of null', (l) => set(l, 'keywords', [null, null, null])],
  ['rows of numbers', (l) => set(l, 'keywords', [1, 2, 3])],
  ['rows with object fields', (l) => set(l, 'keywords', [{ term: {}, status: [], surfaces: {}, why: 0 }])],
  ['surfaces holding objects', (l) => set(l, 'keywords', [{ term: 'vegan', status: 'placed', surfaces: [{}, null], why: 'x' }])],
  ['a circular-ish deep nest', (l) => set(l, 'keywords', [{ term: { a: { b: { c: 1 } } }, status: 'placed', surfaces: [], why: 'x' }])],
];

// ===========================================================================
// 2 — THE VISUAL PACK (WS8)
// ===========================================================================

const IMAGE_SHAPES: [string, (l: OptimizedListing) => void][] = [
  ['imagePlan missing', (l) => set(l, 'imagePlan', undefined)],
  ['imagePlan not an array', (l) => set(l, 'imagePlan', { slot: 1 })],
  ['a null slot', (l) => { (l.imagePlan as Any[])[0] = null; }],
  ['a slot with no altText key', (l) => { delete l.imagePlan[0]!.altText; }],
  ['altText null', (l) => { (l.imagePlan[0] as Any as Record<string, Any>).altText = null; }],
  ['altText numeric', (l) => { (l.imagePlan[0] as Any as Record<string, Any>).altText = 42; }],
  ['altText an object', (l) => { (l.imagePlan[0] as Any as Record<string, Any>).altText = { a: 1 }; }],
  ['slot number a string', (l) => { (l.imagePlan[0] as Any as Record<string, Any>).slot = 'one'; }],
  ['videoBrief missing', (l) => set(l, 'videoBrief', undefined)],
  ['videoBrief null', (l) => set(l, 'videoBrief', null)],
  ['videoBrief a string', (l) => set(l, 'videoBrief', 'make a video')],
  ['videoBrief with null arrays', (l) => set(l, 'videoBrief', { aspect: null, durationSeconds: null, shots: null, onScreenText: null, notes: null })],
  ['videoBrief shots holding nulls', (l) => { (l.videoBrief as Any as Record<string, Any>).shots = [null, undefined, 7]; }],
  ['aplus banner alt an object', (l) => { (l.aplusContent.modules[0] as Any as Record<string, Any>).bannerAltText = { a: 1 }; }],
];

// ===========================================================================
// 3 — BULLET FORMAT (WS10 / C31)
// ===========================================================================

const FORMAT_SHAPES: [string, (l: OptimizedListing) => void][] = [
  ['a bullet that is an object', (l) => { (l.bullets as Any[])[0] = { text: 'x' }; }],
  ['a bullet that is an array', (l) => { (l.bullets as Any[])[0] = ['x']; }],
  ['bullets replaced by a string', (l) => set(l, 'bullets', 'one bullet')],
];

describe.each([
  ['keyword artifact', KEYWORD_SHAPES],
  ['visual pack', IMAGE_SHAPES],
  ['bullet format', FORMAT_SHAPES],
] as [string, [string, (l: OptimizedListing) => void][]][])(
  'WS10 oracle — a malformed %s FAILS CLOSED and never throws',
  (_group, shapes) => {
    it.each(shapes)('%s', (_label, apply) => {
      const l = mut(apply);

      // 1. NOTHING THROWS — a thrown gate is a fail-OPEN in practice.
      expect(() => runGate(l, pack, ctx)).not.toThrow();
      expect(() => buildAudit(snapshot, l, pack, ctx)).not.toThrow();

      // 2. FAILS CLOSED.
      const result = runGate(l, pack, ctx);
      expect(result.pass).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);

      const audit = buildAudit(snapshot, l, pack, ctx);
      expect(audit.verified).toBe(false);
      expect(audit.verified).toBe(audit.gateResult.pass);

      // 3. THE OPERATOR SURFACES STILL RENDER — a sheet that cannot be built
      //    is a sheet nobody can read the failures off.
      expect(() => buildShipSheet({ optimized: l, audit, pack, snapshot })).not.toThrow();
      expect(() => toMarkdown(l, audit)).not.toThrow();
      const html = buildShipSheet({ optimized: l, audit, pack, snapshot });
      expect(html).toContain('NOT VERIFIED');
      expect(html).not.toContain('class=cp');
    });
  },
);

// ===========================================================================
// 4 — THE BENCHMARK AND THE REVIEW ARTIFACTS (WS9), which live on the AUDIT
// ===========================================================================

describe('WS10 oracle — malformed WS9 audit artifacts never break a render', () => {
  const BAD_BENCHMARKS: [string, unknown][] = [
    ['null', null],
    ['a string', 'benchmark'],
    ['rows missing', { subject: {}, current: {}, requested: 1, ingested: 0 }],
    ['rows not an array', { subject: {}, current: {}, rows: {}, requested: 1, ingested: 0 }],
    ['rows of null', { subject: {}, current: {}, rows: [null], requested: 1, ingested: 0 }],
    ['a row with no status', { subject: {}, current: {}, rows: [{ asin: 'B0X' }], requested: 1, ingested: 0 }],
  ];

  it.each(BAD_BENCHMARKS)('benchmark %s renders without throwing', (_label, benchmark) => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const broken = { ...audit, benchmark } as typeof audit;
    expect(() => buildShipSheet({ optimized: clean, audit: broken, pack, snapshot })).not.toThrow();
    expect(() => toMarkdown(clean, broken)).not.toThrow();
  });

  const BAD_REJECTED: [string, unknown][] = [
    ['null', null],
    ['a string', 'nope'],
    ['entries of null', [null, null]],
    ['entries with object fields', [{ fragment: {}, why: [] }]],
  ];

  it.each(BAD_REJECTED)('reviewLanguageRejected %s renders without throwing', (_label, rejected) => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const broken = { ...audit, reviewLanguageRejected: rejected } as typeof audit;
    expect(() => buildShipSheet({ optimized: clean, audit: broken, pack, snapshot })).not.toThrow();
  });

  const BAD_SCORECARDS: [string, unknown][] = [
    ['null', null],
    ['no perPrinciple', { total: 50 }],
    ['perPrinciple not an array', { total: 50, perPrinciple: {} }],
    ['perPrinciple of null', { total: 50, perPrinciple: [null] }],
  ];

  it.each(BAD_SCORECARDS)('scorecardProposed %s renders without throwing', (_label, card) => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const broken = { ...audit, scorecardProposed: card } as typeof audit;
    expect(() => buildShipSheet({ optimized: clean, audit: broken, pack, snapshot })).not.toThrow();
    expect(() => toMarkdown(clean, broken)).not.toThrow();
  });

  it('a completely gutted audit still renders a blocking sheet', () => {
    const gutted = { verified: false } as unknown as ReturnType<typeof buildAudit>;
    expect(() => buildShipSheet({ optimized: clean, audit: gutted, pack, snapshot })).not.toThrow();
    const html = buildShipSheet({ optimized: clean, audit: gutted, pack, snapshot });
    expect(html).toContain('NOT VERIFIED');
    expect(html).not.toContain('class=cp');
  });
});

// ===========================================================================
// 5 — THE ORACLE IS NOT VACUOUS
// ===========================================================================

describe('WS10 oracle — the oracle can tell a PASS from a crash', () => {
  it('the unmutated listing passes, so "fails closed" is a real result', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(audit.verified).toBe(true);
    const html = buildShipSheet({ optimized: clean, audit, pack, snapshot });
    expect(html).toContain('Verified for publish');
    expect(html).toContain('class=cp');
  });

  it('a gate check that THREW would be caught here, not read as a detection', () => {
    // Proof by construction: a pack whose regex sources are junk must not make
    // the gate throw — it must still return a verdict.
    const broken = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    broken.rules.style.asinPattern = '([unclosed';
    broken.rules.style.emojiPattern = '([unclosed';
    broken.rules.style.htmlTagPattern = '([unclosed';
    expect(() => runGate(clean, broken, ctx)).not.toThrow();
  });
});
