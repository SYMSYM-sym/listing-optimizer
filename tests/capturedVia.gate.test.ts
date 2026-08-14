import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * G1 — `captured-via` IS SCANNED FOR ABSENCE, NOT ONLY FOR ITS ROUTE.
 *
 * THE BYPASS, REPRODUCED. C28's own docstring says `captured-via` means the
 * term is deliberately ABSENT and the demand is recaptured through a compliant
 * cluster named in `via`. The check enforced only the second half. So the
 * status was a documented way to ship a banned term:
 *
 *   the fixture's rival-brand row  'greenluxe'
 *     status: 'negative'   ->   status: 'captured-via', via: 'quality cluster'
 *   'GreenLuxe' appended to imagePlan[2].altText
 *   => runGate().pass === true, failures === []
 *
 * That is R50 (rival-brand exclusion) defeated by a STATUS WORD, on exactly the
 * invisible surface item 1 of CONFORMANCE-DEVIATIONS.md closed for a READER
 * hole. The sibling `candidate` status — which makes the same claim about the
 * copy, "this term is not in the current listing" — had the everywhere-scan the
 * whole time.
 *
 * BOTH DIRECTIONS, and the second is the point of the status. A `captured-via`
 * row whose term is GENUINELY absent must still PASS, on every surface and with
 * the recapture route present: that is K4 (demand recapture), the mechanism
 * that lets a listing reach banned demand lawfully. A fix that made
 * `captured-via` unusable would be as bad as the bypass.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing): Failure[] => c28KeywordPlacement(l, pack);
const rowFor = (l: OptimizedListing, term: string): KeywordTerm =>
  (l.keywords ?? []).find((r) => r.term.toLowerCase() === term.toLowerCase())!;

/** The rival brand the fixture's own keyword reference records as `negative`. */
const RIVAL = 'greenluxe';

/** Flip the rival row to a documented `captured-via` — the exploit's first half. */
function capturedVia(l: OptimizedListing, via = 'quality cluster'): void {
  const row = rowFor(l, RIVAL);
  row.status = 'captured-via';
  row.via = via;
  row.surfaces = [];
}

/**
 * EVERY surface a customer can read, including the two invisible ones. Each
 * entry plants the term where that surface's reader will find it.
 */
const PLANTERS: [string, (l: OptimizedListing, term: string) => void][] = [
  ['title', (l, t) => { l.title = `${l.title} ${t}`; }],
  ['title75', (l, t) => { l.title75 = `${l.title75} ${t}`; }],
  ['itemHighlights', (l, t) => { l.itemHighlights = `${l.itemHighlights} ${t}`; }],
  ['bullets', (l, t) => { l.bullets[2] = `${l.bullets[2]} ${t}`; }],
  ['description', (l, t) => { l.description = `${l.description}\n${t}`; }],
  ['backend', (l, t) => { l.backendSearchTerms = `${l.backendSearchTerms} ${t}`; }],
  ['attributes', (l, t) => { l.attributes.special_features = `${l.attributes.special_features ?? ''} ${t}`; }],
  ['aplus (module body)', (l, t) => { l.aplusContent.modules[0]!.body = `${l.aplusContent.modules[0]!.body} ${t}`; }],
  ['aplus (bannerAltText)', (l, t) => { l.aplusContent.modules[0]!.bannerAltText = `${l.aplusContent.modules[0]!.bannerAltText ?? ''} ${t}`; }],
  ['faq', (l, t) => { l.aplusContent.faq[0]!.a = `${l.aplusContent.faq[0]!.a} ${t}`; }],
  ['qa', (l, t) => { l.qa[0]!.a = `${l.qa[0]!.a} ${t}`; }],
  ['images (altText)', (l, t) => { l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} ${t}`; }],
  ['images (notes)', (l, t) => { l.imagePlan[1]!.notes = `${l.imagePlan[1]!.notes} ${t}`; }],
  ['video (onScreenText)', (l, t) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), t]; }],
  ['video (notes)', (l, t) => { l.videoBrief!.notes = `${l.videoBrief!.notes ?? ''} ${t}`; }],
];

// ===========================================================================
// (a) THE EXPLOIT, EXACTLY AS THE REVIEWER RAN IT
// ===========================================================================

describe('(a) the proven exploit', () => {
  it('the fixture records the rival brand as a NEGATIVE, and the clean run passes', () => {
    expect(rowFor(clean, RIVAL).status).toBe('negative');
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it("flipping it to captured-via + the brand in an image ALT now FAILS (it used to pass with zero failures)", () => {
    const l = clone();
    capturedVia(l);
    l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} GreenLuxe`;
    const gate = runGate(l, pack, ctx);
    expect(gate.pass).toBe(false);
    expect(
      gate.failures.some(
        (f) =>
          f.checkId === 'C28' &&
          f.context.includes('captured-via term') &&
          f.context.includes(RIVAL) &&
          f.context.includes('images'),
      ),
      JSON.stringify(gate.failures.map((f) => `${f.checkId} ${f.context}`)),
    ).toBe(true);
  });

  it('a documented `via` does not buy the term any cover — the route is not the point', () => {
    for (const via of ['quality cluster', 'the trusted-quality cluster', 'x']) {
      const l = clone();
      capturedVia(l, via);
      l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} GreenLuxe`;
      expect(runGate(l, pack, ctx).pass, via).toBe(false);
    }
  });
});

// ===========================================================================
// (b) DIRECTION ONE — present ANYWHERE fails, on every surface
// ===========================================================================

describe('(b) a captured-via term present on ANY surface fails', () => {
  it.each(PLANTERS)('fails when the term is planted in %s', (_label, plant) => {
    const l = clone();
    capturedVia(l);
    plant(l, RIVAL);
    const fs = c28(l).filter((f) => f.context.includes('captured-via term'));
    expect(fs.length, JSON.stringify(c28(l).map((f) => f.context))).toBeGreaterThan(0);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('the failure NAMES the surface and the route, so it can be acted on', () => {
    const l = clone();
    capturedVia(l, 'quality cluster');
    l.videoBrief!.notes = `${l.videoBrief!.notes ?? ''} ${RIVAL}`;
    const f = c28(l).find((x) => x.context.includes('captured-via term'))!;
    expect(f.context).toContain('video');
    expect(f.fix).toContain('quality cluster');
    expect(f.fix).toContain('deliberately ABSENT');
  });

  it('the route leg is UNTOUCHED: captured-via with no `via` still fails on its own', () => {
    const l = clone();
    const row = rowFor(l, RIVAL);
    row.status = 'captured-via';
    row.surfaces = [];
    expect(c28(l).some((f) => f.context.includes('captured-via with no route recorded'))).toBe(true);
  });

  it('BOTH legs can fail at once — a missing route AND a present term', () => {
    const l = clone();
    const row = rowFor(l, RIVAL);
    row.status = 'captured-via';
    row.surfaces = [];
    l.description = `${l.description}\n${RIVAL}`;
    const contexts = c28(l).map((f) => f.context);
    expect(contexts.some((c) => c.includes('no route recorded'))).toBe(true);
    expect(contexts.some((c) => c.includes('captured-via term'))).toBe(true);
  });
});

// ===========================================================================
// (c) DIRECTION TWO — K4 STILL WORKS. This is the whole point of the status.
// ===========================================================================

describe('(c) a LAWFUL captured-via row still passes', () => {
  /** A genuine K4 row: banned demand, absent term, compliant route recorded. */
  const lawful = (term: string): KeywordTerm => ({
    term,
    tier: 'demand',
    status: 'captured-via',
    surfaces: [],
    why: 'Real demand we may not write; reached through a compliant cluster instead',
    via: 'digestive balance cluster',
  });

  it('a captured-via term the copy carries NOWHERE raises nothing, and the gate still passes', () => {
    const l = clone();
    l.keywords = [...(l.keywords ?? []), lawful('ibs cure')];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('SEVERAL lawful recapture rows at once still raise nothing', () => {
    const l = clone();
    l.keywords = [
      ...(l.keywords ?? []),
      lawful('ibs cure'),
      lawful('acid reflux treatment'),
      lawful('cures bloating fast'),
    ];
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('the K4 status is still USABLE for the rival brand itself when the copy is clean', () => {
    // The row the exploit abused, WITHOUT the planted brand: the reference may
    // legitimately record a rival's demand as recaptured, and it passes.
    const l = clone();
    capturedVia(l);
    expect(c28(l).filter((f) => f.context.includes(RIVAL))).toEqual([]);
  });

  it('the fixture run is UNCHANGED by this leg — zero gate failures, nothing weakened', () => {
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});
