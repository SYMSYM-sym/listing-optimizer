import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type {
  CompetitorIngestion,
  Failure,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * G1 (second observation) — A RIVAL BRAND THE MODEL LABELS `placed` MUST NOT
 * SAIL THROUGH.
 *
 * THE GAP. C28's `negative` leg is the whole of the app's R50 enforcement, and
 * every word of it is conditioned on the MODEL having written `negative` in the
 * row. The four-test screen that would otherwise catch a mislabelled row reads
 * the compliance pack's disease nouns, action-paired nouns and superlative bans
 * — and a rival BRAND NAME is in none of those lexicons, because a brand name
 * is not a lexicon item. So C28 guaranteed LABELLED-NEGATIVE absence, never
 * RIVAL absence: label the rival `placed` and the run came back verified with
 * the competitor's name in shipped copy.
 *
 * THE CODE-SIDE SIGNAL. The operator typed the competitor ASINs and WS9 already
 * INGESTS them. Their brand names are sitting in their own snapshots' brand
 * fields. `lib/audit/rivalBrands.ts` turns those into an automatic negative set
 * and the AUDIT — which owns `verified` — hands it to the gate, so no route can
 * forget it.
 *
 * BOTH DIRECTIONS, and the second half is most of this file. An automatic
 * negative that fires when it should not is exactly as severe as the bypass, so
 * every bound is asserted: no competitors => the set is empty and nothing
 * changes; the subject's OWN brand is never turned into a term it may not
 * carry; a single-word brand is never admitted; a failed ingestion contributes
 * nothing; and a word merely SHARED with a rival brand is not the brand.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;

/** A competitor as WS9 ingests it: a real snapshot with real brand fields. */
const competitor = (
  asin: string,
  attributes: Record<string, string>,
  title = 'A rival listing title',
): CompetitorIngestion => ({
  asin,
  snapshot: { ...snapshot, asin, title, attributes } as ListingSnapshot,
});

const RIVAL_BRAND = 'Northwind Apothecary';
const RIVALS = [competitor('B0RIVAL0001', { brand_name: RIVAL_BRAND })];

const withRivals = (l: OptimizedListing, competitors = RIVALS): Failure[] =>
  c28KeywordPlacement(l, pack, {
    ...ctx,
    rivalBrands: rivalBrandNames(competitors, l, snapshot),
  });

const gateWithRivals = (l: OptimizedListing, competitors = RIVALS) =>
  runGate(l, pack, { ...ctx, rivalBrands: rivalBrandNames(competitors, l, snapshot) });

/** Every customer-readable surface, including the invisible ones. */
const PLANTERS: [string, (l: OptimizedListing, term: string) => void][] = [
  ['title', (l, t) => { l.title = `${l.title} ${t}`; }],
  ['bullets', (l, t) => { l.bullets[1] = `${l.bullets[1]} ${t}`; }],
  ['description', (l, t) => { l.description = `${l.description}\n${t}`; }],
  ['backend', (l, t) => { l.backendSearchTerms = `${l.backendSearchTerms} ${t}`; }],
  ['attributes', (l, t) => { l.attributes.special_features = `${l.attributes.special_features ?? ''} ${t}`; }],
  ['aplus bannerAltText', (l, t) => { l.aplusContent.modules[0]!.bannerAltText = `${l.aplusContent.modules[0]!.bannerAltText ?? ''} ${t}`; }],
  ['images altText', (l, t) => { l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} ${t}`; }],
  ['video onScreenText', (l, t) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), t]; }],
];

// ===========================================================================
// (a) THE GAP, AND THE CLOSE
// ===========================================================================

describe('(a) a rival brand the model labelled `placed`', () => {
  /** The mislabelled row: a rival brand recorded as a term we TARGET. */
  const placedRival = (l: OptimizedListing, term = RIVAL_BRAND): void => {
    l.title = `${l.title} ${term}`;
    l.keywords = [
      ...(l.keywords ?? []),
      { term, tier: 1, status: 'placed', surfaces: ['title'], why: 'High-volume head term' },
    ];
  };

  it('THE GAP IS REAL: with NO competitors supplied, the mislabelled row still passes C28', () => {
    const l = clone();
    placedRival(l);
    // No lexicon contains a brand name, so the four-test screen cannot see it
    // and the placement leg is satisfied — the term really IS in the title.
    expect(c28KeywordPlacement(l, pack)).toEqual([]);
  });

  it('WITH the operator\'s competitors ingested, the SAME listing fails', () => {
    const l = clone();
    placedRival(l);
    const fs = withRivals(l);
    expect(
      fs.some((f) => f.context.includes('ingested competitor brand') && f.context.includes('title')),
      JSON.stringify(fs.map((f) => f.context)),
    ).toBe(true);
    expect(gateWithRivals(l).pass).toBe(false);
  });

  it.each(PLANTERS)('the rival brand fails from %s, whatever the artifact says', (_label, plant) => {
    const l = clone();
    plant(l, RIVAL_BRAND);
    expect(withRivals(l).some((f) => f.context.includes('ingested competitor brand'))).toBe(true);
    expect(gateWithRivals(l).pass).toBe(false);
  });

  it('the failure explains itself: which brand, which surface, and why it is a rival', () => {
    const l = clone();
    l.description = `${l.description}\n${RIVAL_BRAND}`;
    const f = withRivals(l).find((x) => x.context.includes('ingested competitor brand'))!;
    expect(f.checkId).toBe('C28');
    expect(f.context).toContain('description');
    expect(f.fix).toContain('competitor ASIN the operator supplied');
    expect(f.fix).toContain('trademark exposure');
  });

  it('case and spacing do not launder it — the same reader the negative leg uses', () => {
    for (const shape of ['NORTHWIND APOTHECARY', 'northwind   apothecary', 'Northwind Apothecary']) {
      const l = clone();
      l.description = `${l.description}\n${shape}`;
      expect(gateWithRivals(l).pass, shape).toBe(false);
    }
  });

  it('the AUDIT wires it: `verified` goes false with competitors supplied, and stays true without', () => {
    const l = clone();
    l.description = `${l.description}\n${RIVAL_BRAND}`;
    expect(buildAudit(snapshot, l, pack, ctx, {}).verified).toBe(true);
    expect(buildAudit(snapshot, l, pack, ctx, { competitors: RIVALS }).verified).toBe(false);
  });
});

// ===========================================================================
// (b) IT DOES NOT FIRE WHEN IT SHOULD NOT — every bound, asserted
// ===========================================================================

describe('(b) the bounds — over-blocking is as severe as a bypass', () => {
  it('NO COMPETITORS: the set is empty, and the clean fixture is untouched', () => {
    expect(rivalBrandNames(undefined, clean, snapshot)).toEqual([]);
    expect(rivalBrandNames([], clean, snapshot)).toEqual([]);
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
    expect(gateWithRivals(clone())).toEqual({ pass: true, failures: [] });
  });

  it('NO COMPETITORS: even a listing full of the rival brand raises nothing', () => {
    const l = clone();
    l.description = `${l.description}\n${RIVAL_BRAND}`;
    expect(c28KeywordPlacement(l, pack, { ...ctx, rivalBrands: [] })).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('A FAILED INGESTION contributes nothing — a page we could not read names no brand', () => {
    const failed: CompetitorIngestion[] = [{ asin: 'B0RIVAL0002', error: 'blocked' }];
    expect(rivalBrandNames(failed, clean, snapshot)).toEqual([]);
  });

  it('THE SUBJECT\'S OWN BRAND is never admitted, even if pasted into the competitor box', () => {
    // The operator pastes their OWN asin as a "competitor". A listing MUST carry
    // its own brand, so admitting it would make the run unwinnable.
    const self = [competitor('B0TESTASIN', { ...snapshot.attributes })];
    expect(rivalBrandNames(self, clean, snapshot)).toEqual([]);
    expect(gateWithRivals(clone(), self)).toEqual({ pass: true, failures: [] });
  });

  it('a rival sharing the subject\'s MANUFACTURER string is not admitted either', () => {
    const shared = [competitor('B0RIVAL0003', { brand_name: snapshot.attributes.manufacturer! })];
    expect(rivalBrandNames(shared, clean, snapshot)).toEqual([]);
  });

  it('A SINGLE-WORD BRAND is never admitted — one ordinary word would fire on ordinary prose', () => {
    const oneWord = [competitor('B0RIVAL0004', { brand_name: 'Now' })];
    expect(rivalBrandNames(oneWord, clean, snapshot)).toEqual([]);
    const l = clone();
    l.description = `${l.description}\nNow available in a travel size.`;
    expect(gateWithRivals(l, oneWord)).toEqual({ pass: true, failures: [] });
  });

  it('A SHARED WORD is not the brand — only the whole name matches', () => {
    // Each half of the rival's name, on its own, is not the rival's name. This
    // is the `ownBrandIdentity` precedent in the other direction: a term that
    // merely shares a word with a brand is not that brand.
    for (const half of ['Northwind', 'Apothecary']) {
      const c = clone();
      c.description = `${c.description}\n${half} styling notes.`;
      expect(gateWithRivals(c).pass, half).toBe(true);
    }
  });

  it('ONLY the structural brand fields are mined — a rival\'s TITLE is not guessed at', () => {
    const titleOnly = [
      competitor('B0RIVAL0005', {}, 'Northwind Apothecary Daily Probiotic 50 Billion CFU'),
    ];
    expect(rivalBrandNames(titleOnly, clean, snapshot)).toEqual([]);
  });

  it('the set DEDUPES and reads both brand fields', () => {
    const two = [
      competitor('B0RIVAL0006', { brand_name: RIVAL_BRAND, manufacturer: RIVAL_BRAND }),
      competitor('B0RIVAL0007', { manufacturer: 'Harbor Row Botanicals' }),
    ];
    const names = rivalBrandNames(two, clean, snapshot);
    expect(names).toHaveLength(2);
    expect(names.map((n) => n.toLowerCase())).toContain('northwind apothecary');
    expect(names.map((n) => n.toLowerCase())).toContain('harbor row botanicals');
  });
});

// ===========================================================================
// (c) IT CANNOT BE A SHORTCUT — the negative floor is unaffected
// ===========================================================================

describe('(c) the automatic set is not a way to satisfy anything', () => {
  it('supplying competitors does NOT count toward minNegatives', () => {
    const l = clone();
    // Strip the reference's own negatives, leaving the floor unmet.
    l.keywords = (l.keywords ?? []).filter((r) => r.status !== 'negative');
    const fs = withRivals(l);
    expect(fs.some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });

  it('a brand ALREADY recorded as a negative is reported once, by the row that owns it', () => {
    const l = clone();
    l.keywords = [
      ...(l.keywords ?? []),
      { term: RIVAL_BRAND, tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
    ];
    l.description = `${l.description}\n${RIVAL_BRAND}`;
    const fs = withRivals(l);
    expect(fs.some((f) => f.context.includes('negative term'))).toBe(true);
    expect(fs.some((f) => f.context.includes('ingested competitor brand'))).toBe(false);
  });
});
