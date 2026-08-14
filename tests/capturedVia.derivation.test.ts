import { beforeAll, describe, expect, it } from 'vitest';
import {
  ABSENCE_CLAIM_STATUSES,
  deriveKeywordPlacement,
  MODEL_OWNED_STATUSES,
} from '@/lib/engine/keywordPlacement';
import { keywordCoverage } from '@/lib/audit/keywordCoverage';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { c28KeywordPlacement, keywordSurfaceText, type GateContext } from '@/lib/gate/checks';
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
 * E5 — `captured-via` MAKES A CLAIM ABOUT THE COPY, SO CODE DERIVES IT. AND
 * `negative` IS NOW THE ONLY MODEL-OWNED STATUS, WHICH IS THE WHOLE POINT.
 *
 * THE LIVE DEFECT. Production, ASIN B00WNDG7V8, one failure and the run ended
 * `verified: false`:
 *
 *   C28 | keywords[1] | captured-via term 'oral probiotic' appears on 'attributes'
 *
 * `oral probiotic` is an ORDINARY DESCRIPTIVE TERM for that product and the
 * copy uses it legitimately. Nothing about the listing was wrong. The model
 * labelled the row `captured-via`, G1's absence scan fired — correctly, by its
 * own rule — and a clean listing failed on a self-contradictory ROW. No repair
 * clears it either: the fix the failure asks for is "remove the term from the
 * copy", and the term is a plain description of the product.
 *
 * THE RULE, ONE STATUS FURTHER ALONG. E2 moved the placement map into code and
 * E4 moved `candidate` / `not-targeted`, both on the same principle: THE MODEL
 * MAY ASSERT AN INTENT; IT MAY NOT ASSERT A FACT ABOUT THE COPY THAT CODE CAN
 * COMPUTE. `captured-via` is a compound — an INTENT ("reach this demand through
 * the cluster named in `via`") resting on a CLAIM ABOUT THE COPY ("the term
 * itself is deliberately ABSENT"). The second half is word-for-word what
 * `candidate` asserts and is measured by word-for-word the same scan, so it is
 * derived: term in the copy => the real placement + a `note`; term absent =>
 * THE LABEL IS KEPT and K4 works exactly as before.
 *
 * WHY `negative` STAYS ALONE. A `negative` term found in the copy is not a
 * mislabelled row to correct — IT IS THE VIOLATION R50 EXISTS TO DETECT.
 * Deriving it to `placed` would turn the one check that keeps rival brands out
 * into a relabelling exercise. (d) below plants a rival on all eight surfaces
 * and shows every one still failing, and shows that no label — `captured-via`,
 * `candidate`, `not-targeted` or `placed` — launders a brand in the
 * operator-supplied competitor set.
 *
 * BOTH DIRECTIONS THROUGHOUT: (a) the corrected live shape passes, (b) a lawful
 * recapture row is PRESERVED, (c) its route leg still fails without a `via`,
 * (d) R50 is unweakened, (e) C28's absence scan still fires on an artifact
 * derivation never saw, (f) the golden fixture is unchanged at zero failures.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, c: GateContext = ctx): Failure[] => c28KeywordPlacement(l, pack, c);
const kr = () => pack.rules.keywordRules!;
const allSurfaces = (): string[] => [...kr().visibleSurfaces, ...kr().backendSurfaces];
const rowFor = (rows: KeywordTerm[], term: string): KeywordTerm =>
  rows.find((r) => r.term.toLowerCase() === term.toLowerCase())!;

/** Independent, dumb presence oracle — plain case-folded substring, no regex. */
const surfaceHas = (l: OptimizedListing, name: string, term: string): boolean =>
  (keywordSurfaceText(l, name) ?? '').toLowerCase().includes(term.toLowerCase());

const row = (term: string, status: string, extra: Partial<KeywordTerm> = {}): KeywordTerm =>
  ({ term, tier: 'demand', status, surfaces: [], why: 'planted', ...extra }) as KeywordTerm;

/** Three GENUINE negatives — what a real reference records, and the floor. */
const NEGATIVE_FLOOR = (): KeywordTerm[] => [
  row('diabetes', 'negative', { tier: 'negative', why: 'Named condition' }),
  row('detox', 'negative', { tier: 'negative', why: 'Implied-treatment framing' }),
  row('greenluxe', 'negative', { tier: 'negative', why: 'Rival brand' }),
];

const ROUTE = 'the compliant daily wellness cluster the copy writes out in full';

// ===========================================================================
// (a) THE LIVE SHAPE — a `captured-via` row whose term IS in the copy
// ===========================================================================

const DESCRIPTIVE = 'oral probiotic';

/** Where the live run had it: an ordinary attribute value, lawfully written. */
function withDescriptiveInAttributes(l: OptimizedListing): OptimizedListing {
  l.attributes.special_features = `${l.attributes.special_features ?? ''} ${DESCRIPTIVE}`.trim();
  return l;
}

describe('(a) the live shape: a captured-via row whose term IS in the copy', () => {
  const build = (): OptimizedListing => {
    const l = withDescriptiveInAttributes(clone());
    l.keywords = [row(DESCRIPTIVE, 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()];
    return l;
  };

  it('the defect was REAL: underived, C28 reports the exact live failure', () => {
    const l = build();
    const fs = c28(l);
    expect(
      fs.some(
        (f) =>
          f.context.includes('captured-via term') &&
          f.context.includes(DESCRIPTIVE) &&
          f.context.includes('attributes'),
      ),
      JSON.stringify(fs.map((f) => f.context)),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('derivation corrects it to `placed` with the TRUE surfaces', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const r = rowFor(l.keywords, DESCRIPTIVE);
    expect(r.status).toBe('placed');
    expect(r.surfaces.length).toBeGreaterThan(0);
    // every surface it now claims really does carry it, by the dumb oracle...
    for (const name of r.surfaces) expect(surfaceHas(l, name, DESCRIPTIVE), name).toBe(true);
    // ...and every surface that carries it is claimed. Nothing is hidden.
    for (const name of allSurfaces()) {
      if (surfaceHas(l, name, DESCRIPTIVE) && name !== 'bullets') {
        expect(r.surfaces, name).toContain(name);
      }
    }
    expect(r.surfaces).toContain('attributes');
  });

  it('the correction is RECORDED on `note`, never silent', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const note = rowFor(l.keywords, DESCRIPTIVE).note ?? '';
    expect(note).toContain('captured-via');
    expect(note).toContain('NOT in the copy');
  });

  it('C28 is CLEAN on the derived artifact and the whole gate PASSES', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('the corrected row leaves the RECAPTURE table — it is a placement now', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const cov = keywordCoverage(l);
    expect(cov.recaptured.some((r) => r.term.toLowerCase() === DESCRIPTIVE)).toBe(false);
    expect(cov.placed.some((r) => r.term.toLowerCase() === DESCRIPTIVE)).toBe(true);
  });

  it('DERIVATION IS NOT AN AMNESTY: a term the lexicon bans still fails once derived', () => {
    // The hostile reading of this change — "relabel a banned term captured-via,
    // write it into the copy, and derivation quietly promotes it to placed".
    // It does promote it, out loud, and the run then FAILS on the promotion.
    const l = clone();
    l.description = `${l.description}\nA daily ibs cure for the whole family.`;
    l.keywords = deriveKeywordPlacement(
      [row('ibs cure', 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(rowFor(l.keywords, 'ibs cure').status).toBe('placed');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// (b) A GENUINELY ABSENT `captured-via` — THE LABEL IS PRESERVED, K4 WORKS
// ===========================================================================

describe('(b) a genuinely absent captured-via keeps its label and its route', () => {
  const DEMAND = 'ibs cure';

  it('the premise: the term is on no surface at all', () => {
    for (const name of allSurfaces()) expect(surfaceHas(clean, name, DEMAND), name).toBe(false);
  });

  it('the status is PRESERVED, the surfaces stay empty, and nothing is annotated', () => {
    const derived = deriveKeywordPlacement([row(DEMAND, 'captured-via', { via: ROUTE })], clone(), pack, snapshot);
    const r = rowFor(derived, DEMAND);
    expect(r.status).toBe('captured-via');
    expect(r.status).not.toBe('candidate');
    expect(r.surfaces).toEqual([]);
    expect(r.note).toBeUndefined();
    // the ROUTE rides through untouched — C28's route leg still has its input
    expect(r.via).toBe(ROUTE);
  });

  it('the gate is GREEN on the preserved label — K4 still works, which is the point', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement([row(DEMAND, 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()], l, pack, snapshot);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('SEVERAL lawful recapture rows survive derivation together', () => {
    const l = clone();
    const demands = ['ibs cure', 'acid reflux treatment', 'cures bloating fast'];
    l.keywords = deriveKeywordPlacement(
      [...demands.map((t) => row(t, 'captured-via', { via: ROUTE })), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    for (const t of demands) expect(rowFor(l.keywords, t).status, t).toBe('captured-via');
    expect(keywordCoverage(l).recaptured).toHaveLength(demands.length);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (c) THE ROUTE LEG SURVIVES DERIVATION — an absent row with no `via` FAILS
// ===========================================================================

describe('(c) a preserved captured-via with an empty or missing `via` still FAILS', () => {
  const DEMAND = 'ibs cure';

  it.each([
    ['missing', {}],
    ['empty string', { via: '' }],
    ['whitespace only', { via: '   ' }],
  ])('FAILS when `via` is %s', (_label, extra) => {
    const l = clone();
    l.keywords = deriveKeywordPlacement([row(DEMAND, 'captured-via', extra), ...NEGATIVE_FLOOR()], l, pack, snapshot);
    // derivation KEPT the label (the absence claim was true), so the route leg
    // still has a row to enforce against — that leg is about the ROW's own
    // completeness, not about the copy, so no derivation could satisfy it.
    expect(rowFor(l.keywords, DEMAND).status).toBe('captured-via');
    expect(c28(l).some((f) => f.context.includes('no route recorded'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and the same row WITH a route passes — the leg is not a blanket failure', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement([row(DEMAND, 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()], l, pack, snapshot);
    expect(c28(l)).toEqual([]);
  });
});

// ===========================================================================
// (d) R50 IS UNWEAKENED — every surface, and no label launders a rival
// ===========================================================================

const RIVAL = 'GreenLuxe';

const PLANTERS: [string, (l: OptimizedListing, term: string) => void][] = [
  ['title', (l, t) => { l.title = `${l.title} ${t}`; }],
  ['bullet', (l, t) => { l.bullets[1] = `${l.bullets[1]} ${t}`; }],
  ['description', (l, t) => { l.description = `${l.description}\n${t}`; }],
  ['backend', (l, t) => { l.backendSearchTerms = `${l.backendSearchTerms} ${t}`; }],
  ['attributes', (l, t) => { l.attributes.special_features = `${l.attributes.special_features ?? ''} ${t}`; }],
  ['aplus bannerAltText', (l, t) => { l.aplusContent.modules[0]!.bannerAltText = `${l.aplusContent.modules[0]!.bannerAltText ?? ''} ${t}`; }],
  ['videoBrief', (l, t) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), t]; }],
  ['imagePlan altText', (l, t) => { l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} ${t}`; }],
];

/** The operator-supplied competitor set — a signal that reads NO status word. */
const OPERATOR_RIVAL = 'Northwind Apothecary';
const competitor = (asin: string, attributes: Record<string, string>): CompetitorIngestion => ({
  asin,
  snapshot: { ...snapshot, asin, title: 'A rival listing title', attributes } as ListingSnapshot,
});
const RIVALS = [competitor('B0RIVAL0001', { brand_name: OPERATOR_RIVAL })];
const withRivals = (l: OptimizedListing): Failure[] =>
  c28KeywordPlacement(l, pack, { ...ctx, rivalBrands: rivalBrandNames(RIVALS, l, snapshot) });

describe('(d) R50 is unweakened by moving captured-via across', () => {
  it.each(PLANTERS)('FAILS: a rival marked `negative`, planted in %s', (_label, plant) => {
    const l = clone();
    plant(l, RIVAL);
    l.keywords = deriveKeywordPlacement(
      [row(RIVAL, 'negative', { tier: 'negative', why: 'Rival brand' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    // derivation left the intent alone — `negative` is the ONE status it never
    // rewrites, precisely because this is the case that must stay loud.
    const r = rowFor(l.keywords, RIVAL);
    expect(r.status).toBe('negative');
    expect(r.surfaces).toEqual([]);
    expect(r.note).toBeUndefined();

    expect(
      c28(l).some(
        (f) =>
          f.context.toLowerCase().includes('negative term') &&
          f.context.toLowerCase().includes(RIVAL.toLowerCase()),
      ),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('PASSES while the rival is genuinely absent — not a check that fails everything', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [row(RIVAL, 'negative', { tier: 'negative', why: 'Rival brand' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it.each(['captured-via', 'candidate', 'not-targeted', 'placed'])(
    'a rival in the OPERATOR competitor set cannot be laundered by labelling it `%s`',
    (status) => {
      const l = clone();
      l.aplusContent.modules[0]!.bannerAltText = `${OPERATOR_RIVAL} banner`;
      l.keywords = deriveKeywordPlacement(
        [row(OPERATOR_RIVAL, status, { via: ROUTE }), ...NEGATIVE_FLOOR()],
        l,
        pack,
        snapshot,
      );
      // the label buys nothing: derivation reports the truth (it is placed),
      // and the automatic rival set reads no label at all.
      expect(rowFor(l.keywords, OPERATOR_RIVAL).status, status).toBe('placed');
      expect(
        withRivals(l).some((f) => f.context.includes('ingested competitor brand')),
        status,
      ).toBe(true);
    },
  );

  it('the automatic rival set stays silent while the competitor brand is absent', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(NEGATIVE_FLOOR(), l, pack, snapshot);
    expect(withRivals(l)).toEqual([]);
  });

  it('the minNegatives floor cannot be padded by a corrected captured-via row', () => {
    const l = withDescriptiveInAttributes(clone());
    l.keywords = deriveKeywordPlacement(
      [row(DESCRIPTIVE, 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR().slice(0, 1)],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(1);
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });
});

// ===========================================================================
// (e) THE C28 ABSENCE SCAN IS NOT DELETED — it still fires on an artifact
//     that never went through derivation (a stored run, a hand edit)
// ===========================================================================

describe('(e) the C28 captured-via absence scan still fires without derivation', () => {
  it.each(PLANTERS)('FAILS: an UNDERIVED captured-via row whose term sits in %s', (_label, plant) => {
    const l = clone();
    plant(l, 'unicorn dust');
    // written straight onto the artifact, exactly as a stored run or a hand
    // edit would arrive at the gate: no derivation anywhere in the path.
    l.keywords = [row('unicorn dust', 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()];
    expect(c28(l).some((f) => f.context.includes('captured-via term'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('the failure still NAMES the surface and the route, so it can be acted on', () => {
    const l = clone();
    l.videoBrief!.notes = `${l.videoBrief!.notes ?? ''} unicorn dust`;
    l.keywords = [row('unicorn dust', 'captured-via', { via: ROUTE }), ...NEGATIVE_FLOOR()];
    const f = c28(l).find((x) => x.context.includes('captured-via term'))!;
    expect(f.context).toContain('video');
    expect(f.fix).toContain(ROUTE);
    expect(f.fix).toContain('deliberately ABSENT');
  });
});

// ===========================================================================
// (f) THE GOLDEN FIXTURE IS UNCHANGED — zero gate failures, nothing weakened
// ===========================================================================

describe('(f) the golden fixture still runs clean end to end', () => {
  it('the full pipeline output passes the gate with ZERO failures', () => {
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it("the fixture's own captured-via row survived derivation with its route intact", () => {
    const recaptured = keywordCoverage(clean).recaptured;
    expect(recaptured.length).toBeGreaterThan(0);
    for (const r of recaptured) {
      expect(r.via.trim(), r.term).not.toBe('');
      // preserved, not corrected — the term really is on no surface
      for (const name of allSurfaces()) expect(surfaceHas(clean, name, r.term), `${r.term} @ ${name}`).toBe(false);
    }
  });

  it('and no keyword row carries a correction it did not earn', () => {
    for (const r of clean.keywords ?? []) {
      if (r.note !== undefined) expect(r.status, r.term).not.toBe('captured-via');
    }
  });
});

// ===========================================================================
// THE PARTITION, PINNED AGAINST THE PRINCIPLE
// ===========================================================================

describe('the partition is pinned against the principle', () => {
  /**
   * THE PRINCIPLE, IN ONE LINE: the model may assert an INTENT; it may not
   * assert a FACT ABOUT THE COPY that code can compute. Applied to every status
   * the pack defines, it leaves exactly one on the model's side:
   *
   *   negative      — MODEL-OWNED. It states an intent ("exclude this rival
   *                   brand") whose falsification by the copy is not a
   *                   mislabelled row but THE R50 VIOLATION ITSELF. Deriving it
   *                   would convert the one check that keeps rival brands out
   *                   of shipped copy into a relabelling exercise, so it is
   *                   carried to C28 exactly as written. (d) above.
   *   captured-via  — DERIVED (E5). "The term is deliberately ABSENT and the
   *                   demand is reached through `via` instead": the absence is
   *                   a fact about the copy, measured by the same scan
   *                   `candidate` gets. The `via` ROUTE is not derived — it is
   *                   about the row, not the copy — and (c) above holds it.
   *   candidate     — DERIVED (E4). "Held back for a later cycle" asserts the
   *                   term is not in the current copy. Code measures that.
   *   not-targeted  — DERIVED (E4). "We are not going after this term" is
   *                   falsified by a copy that is full of it.
   *   placed        — DERIVED (E2). The surface list is a substring search.
   *   backend       — DERIVED (E2). Same, over the invisible surface.
   *
   * If a future change wants another status on the model's side, it has to
   * argue with this list rather than edit an array.
   */
  it('MODEL_OWNED_STATUSES is exactly ["negative"]', () => {
    expect([...MODEL_OWNED_STATUSES]).toEqual(['negative']);
  });

  it('every other status the pack defines is on the derived side', () => {
    const derivedSide = kr().statuses.filter(
      (s) => !(MODEL_OWNED_STATUSES as readonly string[]).includes(s),
    );
    expect(derivedSide.sort()).toEqual(
      ['backend', 'candidate', 'captured-via', 'not-targeted', 'placed'].sort(),
    );
    for (const s of ABSENCE_CLAIM_STATUSES) expect(derivedSide).toContain(s);
  });

  it('the two constants are a PARTITION of the statuses the pack knows', () => {
    for (const s of MODEL_OWNED_STATUSES) expect(ABSENCE_CLAIM_STATUSES).not.toContain(s);
    for (const s of [...MODEL_OWNED_STATUSES, ...ABSENCE_CLAIM_STATUSES]) {
      expect(kr().statuses).toContain(s);
    }
    expect([...ABSENCE_CLAIM_STATUSES].sort()).toEqual(['candidate', 'captured-via', 'not-targeted']);
  });

  it('the PROMPT is rendered from those same constants, so it cannot drift', () => {
    const p = buildGroupPrompts(pack).keywords(snapshot, clean);
    // captured-via is now described to the model as an ABSENT-term status...
    expect(p).toMatch(/ABSENT FROM THE COPY ABOVE/);
    for (const s of ABSENCE_CLAIM_STATUSES) expect(p, s).toContain(s);
    // ...and the model-owned sentence names `negative` and nothing else.
    const owned = p.split('\n').find((line) => line.includes('These statuses are YOURS'))!;
    expect(owned).toContain('negative');
    expect(owned).not.toContain('captured-via');
    expect(owned).not.toContain('candidate');
    // the route requirement did not vanish with the move
    expect(p).toContain('via');
  });
});
