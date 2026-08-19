import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { deriveKeywordPlacement } from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { keywordSurfacesOf } from '@/lib/engine/prompts/keywords';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * K2 — C28 HAS TWO LIVE SHAPES, NOT ONE, AND J2 HAD TO COVER BOTH
 * ===========================================================================
 *
 * Live runs show the floor failing in two shapes:
 *
 *   `0 negative term(s)`   the model wrote none at all
 *   `2 negative term(s)`   the model wrote some and fell SHORT of the floor of 3
 *
 * J2 (`a3e8723`) was written against the first. The question this file answers
 * is whether it also covers the second — which needs something strictly
 * stronger than "negatives exist and here is where to get them": it needs the
 * writer to know the floor is THREE.
 *
 * THE FINDING: IT DOES, AND THE NUMBER IS STATED RATHER THAN IMPLIED. J2
 * renders `rules.keywordRules.minNegatives` into the keyword prompt verbatim
 * ("at least 3 rows must carry the ... status"), from the same pack number the
 * gate enforces, and the C28 failure text states the floor AND the count the
 * artifact actually recorded ("must record at least 3 negative terms and
 * records 2"). A model that wrote two is told the target and its own shortfall,
 * not merely reminded that the status exists.
 *
 * SO NOTHING IS FIXED HERE. What was missing was the PIN: `tests/negativeSource.j2.test.ts`
 * asserts the floor number in the prompt built by `keywordsPrompt` directly and
 * asserts `at least ${MIN} negative terms` in the fix, but nothing asserted
 *   - that the prompt the ENGINE actually assembles carries the floor (the
 *     wiring from `pack.rules.keywordRules` through `buildGroupPrompts` was
 *     untested, and a floor rendered only when a test passes the rules by hand
 *     is a floor no live run ever sees);
 *   - that the SHORTFALL message names the shortfall — the `and records N`
 *     half, which is the only part that distinguishes the two live shapes;
 *   - the end-to-end shortfall itself: a model that writes two negatives
 *     through `optimize()` fails, and the same model writing three converges.
 * Those three are pinned below, in both directions.
 *
 * THE H2 INTERACTION was checked too and is ALREADY pinned, in
 * `tests/minNegativesFloor.h2.test.ts`: "OWN BRAND: the row really is
 * reclassified, only 2 survive, and the run CONVERGES" (3 proposed, 1
 * reclassified) and "FAILS: two genuine negatives" / "FAILS: one genuine plus
 * one reclassified is still only TWO proposals" (2 proposed). Section (d) below
 * re-states that pair as the single property the two rounds have to agree on —
 * proposals are counted, and two proposals never clear a floor of three —
 * because it is the property that would break silently if either round moved.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const kr = pack.rules.keywordRules!;
const MIN = kr.minNegatives;

/** Terms the COMPLIANCE rules rule out — the source available on every run. */
const COMPLIANCE_NEGATIVES = ['diabetes', 'arthritis', 'hypertension'];
/** The subject product's OWN brand: proposed as negative, reclassified by code. */
const BRAND = snapshot.attributes.brand_name!;

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] =>
  c28KeywordPlacement(l, p, ctx);
const floorFailures = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] =>
  c28(l, p).filter((f) => f.context.includes('negative term(s)'));
const negativeRow = (term: string, why: string): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});
/** A non-negative row, so the artifact is never EMPTY (a different leg). */
const filler = (): KeywordTerm => ({
  term: 'probiotic supplement',
  tier: 1,
  status: 'placed',
  surfaces: [],
  why: 'Category head term',
});
const withNegatives = (rows: KeywordTerm[]): OptimizedListing => {
  const l = clone();
  l.keywords = deriveKeywordPlacement([...rows, filler()], l, pack, snapshot);
  return l;
};
/** The pack with the floor switched OFF — pack data, both directions. */
const noFloorPack: KnowledgePack = {
  ...pack,
  rules: { ...pack.rules, keywordRules: { ...kr, minNegatives: 0 } },
};

// ===========================================================================
// (a) THE PROMPT THE ENGINE ACTUALLY BUILDS STATES THE FLOOR AS A NUMBER
// ===========================================================================

describe('(a) the floor reaches the writer through the ENGINE, as an exact number', () => {
  const enginePrompt = (p: KnowledgePack): string =>
    buildGroupPrompts(p).keywords(snapshot, { ...keywordSurfacesOf(clean), ...clean });

  it('the floor is 3 — the number both live shapes are measured against', () => {
    expect(MIN).toBe(3);
  });

  it('the ENGINE-built prompt states the exact floor, not merely that negatives exist', () => {
    const p = enginePrompt(pack);
    expect(p).toContain(`at least ${MIN} rows must carry the "must appear nowhere" status`);
    // The DIGIT is present as a standalone number, so a model that wrote two
    // rows can tell it is one short rather than inferring a quota from prose.
    expect(p).toMatch(new RegExp(`at least ${MIN}\\b`));
    // and it is rendered from the pack number the gate enforces, not a literal.
    expect(p).toContain(String(pack.rules.keywordRules!.minNegatives));
  });

  it('the same prompt still states the honest SOURCE beside the number (J2)', () => {
    const p = enginePrompt(pack);
    expect(p).toContain(kr.negativeSourceNote!.trim());
    expect(p).toMatch(/must NOT invent a company name/);
  });

  it('BOTH DIRECTIONS: a pack with no floor renders no floor line at all', () => {
    const p = enginePrompt(noFloorPack);
    expect(p).not.toContain('must carry the "must appear nowhere" status');
  });
});

// ===========================================================================
// (b) THE SHORTFALL SHAPE — the message names the floor AND the shortfall
// ===========================================================================

describe('(b) `2 negative term(s)`: the shortfall shape, not just the empty one', () => {
  it('two of three fails, and the message states BOTH numbers', () => {
    const l = withNegatives(
      COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) =>
        negativeRow(t, 'Vocabulary the compliance rules rule out'),
      ),
    );
    const fs = floorFailures(l);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.context).toBe(`${MIN - 1} negative term(s)`);
    // THE POINT: the repair line tells a model that wrote two that the target
    // is three and that it recorded two — the distinction between the two live
    // shapes is carried in the message rather than lost in it.
    expect(fs[0]!.fix).toContain(`at least ${MIN} negative terms and records ${MIN - 1}`);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('the ZERO shape is the same message with the honest count', () => {
    const l = withNegatives([]);
    const fs = floorFailures(l);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.context).toBe('0 negative term(s)');
    expect(fs[0]!.fix).toContain(`at least ${MIN} negative terms and records 0`);
  });

  it('the shortfall fix names the source it can draw on, exactly as the empty one does', () => {
    const short = floorFailures(
      withNegatives([negativeRow(COMPLIANCE_NEGATIVES[0]!, 'Ruled out by the compliance rules')]),
    )[0]!;
    expect(short.fix).toMatch(/vocabulary the compliance rules rule out/i);
    expect(short.fix).toMatch(/never invent a competitor/i);
  });

  it('and exactly the floor CONVERGES — the boundary is where the message says', () => {
    const l = withNegatives(
      COMPLIANCE_NEGATIVES.map((t) => negativeRow(t, 'Vocabulary the compliance rules rule out')),
    );
    expect(floorFailures(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// (c) END TO END — the shortfall through optimize(), and the run that fixes it
// ===========================================================================

describe('(c) the shortfall shape end to end', () => {
  const writesNegatives = (terms: string[]): LlmClient => async (req) =>
    req.user.includes('TASK: The keyword reference')
      ? JSON.stringify({
          keywords: [
            ...terms.map((t) => ({
              t,
              tier: 'negative',
              status: 'negative',
              evidence: 'Ruled out by the compliance rules; recorded so it is never re-added',
            })),
            { t: 'probiotic supplement', tier: 1, status: 'placed', evidence: 'Category head term' },
            { t: 'digestive balance', tier: 1, status: 'placed', evidence: 'The intent cluster owned' },
            { t: 'vegan', tier: 3, status: 'placed', evidence: 'Filter facet' },
            { t: 'acidophilus', tier: 'backend', status: 'backend', evidence: 'Common-name variant' },
            { t: 'gut health', tier: 2, status: 'placed', evidence: 'Secondary cluster' },
            // Six non-negative rows in BOTH cases, so the only difference
            // between the failing run and the converging one is the number of
            // negatives — `KEYWORD_MIN_TERMS` is 8 and a short artifact would
            // otherwise degrade the group and fail on a different leg entirely.
            { t: 'probiotics', tier: 2, status: 'placed', evidence: 'Plural variant of the head term' },
          ],
        })
      : mockLlm(req);

  it('a model that writes TWO negatives fails with the shortfall message', async () => {
    const listing = await optimize(
      snapshot,
      pack,
      writesNegatives(COMPLIANCE_NEGATIVES.slice(0, MIN - 1)),
    );
    const fs = floorFailures(listing);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.context).toBe(`${MIN - 1} negative term(s)`);
    expect(runGate(listing, pack, ctx).pass).toBe(false);
  });

  it('the SAME model writing three converges — the repair the message asks for works', async () => {
    const listing = await optimize(snapshot, pack, writesNegatives(COMPLIANCE_NEGATIVES));
    expect((listing.keywords ?? []).filter((r) => r.status === 'negative')).toHaveLength(MIN);
    expect(c28(listing)).toEqual([]);
    expect(runGate(listing, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// (d) H2 x J2 — proposals are counted, and two proposals never clear three
// ===========================================================================

describe('(d) the H2 proposal count and the J2 sourcing agree', () => {
  it('THREE proposed with ONE reclassified converges — the count is of PROPOSALS', () => {
    const l = withNegatives([
      negativeRow(BRAND, 'Kept out of rival copy'),
      ...COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) =>
        negativeRow(t, 'Vocabulary the compliance rules rule out'),
      ),
    ]);
    const corrected = l.keywords!.find((r) => r.term.toLowerCase() === BRAND.toLowerCase())!;
    expect(corrected.status).not.toBe('negative');
    expect(corrected.proposedStatus).toBe('negative');
    // only two survive, and the floor is nonetheless met
    expect(l.keywords!.filter((r) => r.status === 'negative')).toHaveLength(MIN - 1);
    expect(floorFailures(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('TWO proposed still fails, reclassification or not — the floor was not lowered', () => {
    const bothWays: [string, KeywordTerm[]][] = [
      [
        'two surviving',
        COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) => negativeRow(t, 'Ruled out')),
      ],
      [
        'one surviving plus one reclassified',
        [negativeRow(BRAND, 'Kept out of rival copy'), negativeRow(COMPLIANCE_NEGATIVES[0]!, 'Ruled out')],
      ],
    ];
    for (const [label, rows] of bothWays) {
      const fs = floorFailures(withNegatives(rows));
      expect(fs, label).toHaveLength(1);
      expect(fs[0]!.context, label).toBe(`${MIN - 1} negative term(s)`);
    }
  });
});

// ===========================================================================
// (e) THE FLOOR IS PACK DATA — switch it off and the check says nothing
// ===========================================================================

describe('(e) no floor in the pack, no floor failure', () => {
  it('a reference with ZERO negatives raises no floor failure under a 0 floor', () => {
    expect(floorFailures(withNegatives([]), noFloorPack)).toEqual([]);
  });

  it('…and the SAME reference still fails under the shipped pack (non-vacuity)', () => {
    expect(floorFailures(withNegatives([])).map((f) => f.context)).toEqual(['0 negative term(s)']);
  });
});
