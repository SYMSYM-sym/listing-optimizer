import { beforeAll, describe, expect, it } from 'vitest';
import { keywordSurfacesOf, keywordsPrompt } from '@/lib/engine/prompts/keywords';
import type { LlmClient } from '@/lib/engine/llm';
import { deriveKeywordPlacement } from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordRules, KeywordTerm, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * J2 — `C28 | keywords | 0 negative term(s)`: THE MODEL WAS NEVER TOLD THE FLOOR
 * EXISTED, NOR WHERE THE ROWS TO MEET IT COME FROM.
 *
 * Live, ASIN B00IO89MYA, one failure and the run ended `verified:false`. The H2
 * round had already re-aimed the floor to count PROPOSALS, so this was not the
 * reclassification defect: the model simply wrote no negative rows at all.
 *
 * THE FINDING, both halves:
 *
 *  1. `rules.keywordRules.minNegatives` was pack data ONLY THE GATE READ.
 *     `maxTerms` and `whyMaxChars` were both rendered into the keyword prompt;
 *     the floor was not. The one number a keyword artifact can FAIL on was the
 *     one number its writer was never given.
 *  2. The only SOURCE the instructions led with was "every rival brand name".
 *     With no operator competitor ASINs supplied the model has no rival-brand
 *     knowledge, so that instruction asks it to invent companies — which cannot
 *     converge honestly. The source that exists on EVERY run is the vocabulary
 *     the compliance rules rule out, printed in the same prompt, which C28
 *     already credits toward the floor via the compliance deference.
 *
 * THE FLOOR IS NOT LOWERED and the anti-gaming leg is untouched: a reference
 * whose every negative names this product still fails, and a genuine rival is
 * still enforced everywhere. What changed is that the prompt states the floor
 * and its honest source before the artifact is written, and the failure message
 * names the same source at repair time.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const kr = pack.rules.keywordRules!;
const MIN = kr.minNegatives;

/**
 * Three terms the COMPLIANCE rules rule out — the source that exists on every
 * run. Each is a compliance-lexicon term, so C28 defers its enforcement to the
 * check that owns it and the row survives as `negative`.
 */
const COMPLIANCE_NEGATIVES = ['diabetes', 'arthritis', 'hypertension'];
/** A genuine rival brand — the other honest source, when the run supplies one. */
const RIVAL = 'greenluxe';

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing): Failure[] => c28KeywordPlacement(l, pack, ctx);
const floorFailures = (l: OptimizedListing): Failure[] =>
  c28(l).filter((f) => f.context.includes('negative term(s)'));
const negativeRow = (term: string, why: string): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});

// ===========================================================================
// (a) THE PROMPT — the floor and its source are now stated before the artifact
// ===========================================================================

const promptFor = (rules: KeywordRules | undefined): string =>
  keywordsPrompt(snapshot, { ...keywordSurfacesOf(clean), ...clean }, rules);

describe('(a) the keyword prompt states the floor and where the rows come from', () => {
  it('the pack carries a source note beside the floor number', () => {
    expect(MIN).toBeGreaterThan(0);
    expect(typeof kr.negativeSourceNote).toBe('string');
    expect(kr.negativeSourceNote!.trim().length).toBeGreaterThan(0);
  });

  it('the rendered prompt states the MINIMUM, not only the maximum', () => {
    const p = promptFor(kr);
    expect(p).toContain(`at least ${MIN} rows must carry the "must appear nowhere" status`);
    expect(p).toContain(`at most ${kr.maxTerms} rows in total`);
  });

  it('the rendered prompt names the always-available source and refuses invention', () => {
    const p = promptFor(kr);
    expect(p).toContain(kr.negativeSourceNote!.trim());
    expect(p).toMatch(/available on EVERY run/);
    expect(p).toMatch(/must NOT invent a company name/);
  });

  it('the floor line renders from PACK DATA — no floor in the pack, no line', () => {
    const p = promptFor({ ...kr, minNegatives: 0, negativeSourceNote: undefined });
    expect(p).not.toContain('must carry the "must appear nowhere" status');
    expect(p).not.toContain(kr.negativeSourceNote!.trim());
  });

  it('the prompt still renders when the keyword rules are absent entirely', () => {
    expect(() => promptFor(undefined)).not.toThrow();
  });
});

// ===========================================================================
// (b) CONVERGENCE — a run whose negatives are the vocabulary it avoided passes
// ===========================================================================

describe('(b) a reference whose negatives are the avoided compliance vocabulary CONVERGES', () => {
  it('three compliance-owned negatives, no rival at all, clears the floor', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      COMPLIANCE_NEGATIVES.map((t) => negativeRow(t, 'Vocabulary the compliance rules rule out')),
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(MIN);
    expect(floorFailures(l)).toEqual([]);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('END TO END: a model that records only avoided vocabulary converges', async () => {
    const sourced: LlmClient = async (req) => {
      if (req.user.includes('TASK: The keyword reference')) {
        return JSON.stringify({
          keywords: [
            ...COMPLIANCE_NEGATIVES.map((t) => ({
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
          ],
        });
      }
      return mockLlm(req);
    };
    const listing = await optimize(snapshot, pack, sourced);
    expect((listing.keywords ?? []).filter((r) => r.status === 'negative')).toHaveLength(MIN);
    expect(c28(listing)).toEqual([]);
    expect(runGate(listing, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('a genuine rival brand is unaffected — it still counts and is still enforced', () => {
    const withRival = clone();
    withRival.keywords = deriveKeywordPlacement(
      [
        negativeRow(RIVAL, 'Rival brand'),
        ...COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) =>
          negativeRow(t, 'Vocabulary the compliance rules rule out'),
        ),
      ],
      withRival,
      pack,
      snapshot,
    );
    expect(floorFailures(withRival)).toEqual([]);
    expect(runGate(withRival, pack, ctx)).toEqual({ pass: true, failures: [] });

    // …and the moment the rival's name appears in the copy, C28 still fails it.
    const leaked = clone();
    leaked.bullets[1] = `${leaked.bullets[1]} better than ${RIVAL}`;
    leaked.keywords = deriveKeywordPlacement(
      [
        negativeRow(RIVAL, 'Rival brand'),
        ...COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) =>
          negativeRow(t, 'Vocabulary the compliance rules rule out'),
        ),
      ],
      leaked,
      pack,
      snapshot,
    );
    expect(c28(leaked).some((f) => f.context.includes(`negative term '${RIVAL}'`))).toBe(true);
  });
});

// ===========================================================================
// (c) THE FLOOR IS NOT LOWERED — the failing direction, with a usable message
// ===========================================================================

describe('(c) a reference that records no exclusions still FAILS', () => {
  it('zero negative rows reproduces the live failure', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        { term: 'probiotic supplement', tier: 1, status: 'placed', surfaces: [], why: 'Head term' },
        { term: 'gut health', tier: 2, status: 'placed', surfaces: [], why: 'Secondary cluster' },
      ] as KeywordTerm[],
      l,
      pack,
      snapshot,
    );
    const fs = floorFailures(l);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.context).toBe('0 negative term(s)');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('one short of the floor still fails', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      COMPLIANCE_NEGATIVES.slice(0, MIN - 1).map((t) => negativeRow(t, 'Ruled out')),
      l,
      pack,
      snapshot,
    );
    expect(floorFailures(l)[0]!.context).toBe(`${MIN - 1} negative term(s)`);
  });

  it('the failure message names a source this run can actually draw on', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        { term: 'probiotic supplement', tier: 1, status: 'placed', surfaces: [], why: 'Head term' },
      ] as KeywordTerm[],
      l,
      pack,
      snapshot,
    );
    const fix = floorFailures(l)[0]!.fix;
    expect(fix).toContain(`at least ${MIN} negative terms`);
    // the always-available source, stated first…
    expect(fix).toMatch(/vocabulary the compliance rules rule out/i);
    expect(fix).toMatch(/counts toward this floor/i);
    // …and the refusal to fabricate the source that may not exist on this run
    expect(fix).toMatch(/never invent a competitor/i);
  });
});

// ===========================================================================
// (d) THE ANTI-GAMING PROPERTY IS PRESERVED
// ===========================================================================

describe('(d) the anti-gaming leg still holds — proposals alone do not clear it', () => {
  it('a reference whose every negative names THIS product fails, floor count or not', () => {
    const brand = snapshot.attributes.brand_name!;
    const manufacturer = snapshot.attributes.manufacturer!;
    const productName = 'BrandX Probiotic';
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        negativeRow(brand, 'Kept out of rival copy'),
        negativeRow(manufacturer, 'Kept out of rival copy'),
        negativeRow(productName, 'Kept out of rival copy'),
      ],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(0);
    const fs = c28(l);
    expect(fs.some((f) => f.context.includes('none of them an exclusion'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});
