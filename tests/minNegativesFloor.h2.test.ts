import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { deriveKeywordPlacement } from '@/lib/engine/keywordPlacement';
import { normalizeKeywords, optimize } from '@/lib/engine/optimize';
import { keywordsGroupSchemaFor } from '@/lib/engine/schemas';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * H2 — THE `minNegatives` FLOOR MEASURED THE RESIDUE OF CODE'S OWN CORRECTIONS
 * ===========================================================================
 *
 * THE LIVE DEFECT. Production, ASIN B00IO89MYA, one failure, run unverified:
 *
 *   C28 | keywords | 2 negative term(s)
 *
 * `rules.keywordRules.minNegatives` is 3 and the model had supplied THREE
 * exclusions. The floor counted 2 because `deriveKeywordPlacement` had
 * reclassified one of them out of `negative` — correctly, and for one of the
 * reasons that boundary exists:
 *
 *   - the term was the subject product's OWN BRAND (`ownBrandIdentity`), or
 *   - a PROPERTY the ingested snapshot's structured attributes declare about it
 *     (`productPropertyIdentity`), or
 *   - a COMPLIANCE-LEXICON term deferred to the check that owns it
 *     (`complianceOwnedTerms`).
 *
 * The third of those never cost the floor anything and this file proves it
 * (section (a)): THE DEFERENCE keeps the row saying `negative` and increments
 * the count before deferring. The first two did. So the run was failed for
 * CODE'S OWN CORRECTION — a rule asserting something about the MODEL'S EFFORT
 * while measuring the artifact AFTER the engine legitimately edited it, which
 * is the same incoherence class as the own-brand and product-property defects
 * themselves. No repair round clears it honestly either: the only move the
 * message asks for is "record another negative", i.e. invent a rival to pad the
 * list.
 *
 * ===========================================================================
 * THE RULE, AND THE RECONCILIATION WITH THE ANTI-GAMING PIN
 * ===========================================================================
 *
 * These two requirements point in opposite directions and the conflict is real:
 *
 *   (1) a run must converge when the model proposed enough exclusions and code
 *       corrected one of them;
 *   (2) `tests/keywordDerivation.ownBrand.test.ts` (e) and
 *       `tests/keywordDerivation.productProperty.test.ts` (e) pin that a
 *       reference whose negatives are ALL self-references must NOT clear the
 *       floor.
 *
 * They conflict only while ONE NUMBER has to serve both. So the two jobs are
 * split, and neither test above needed a line changed:
 *
 *   THE FLOOR COUNTS PROPOSALS — surviving `negative` rows plus rows the
 *   derivation reclassified out of `negative`, which it records on
 *   `proposedStatus`. That is what the floor's own failure text has always
 *   asked for: that the REFERENCE RECORD the exclusions. A reclassified row
 *   still does — it is in the artifact, with the correction on `note`, on the
 *   ship sheet where an operator reads it.
 *
 *   THE ANTI-GAMING PROPERTY IS ITS OWN LEG — a reference that records
 *   exclusions but has NOT ONE SURVIVING `negative` row fails, whatever its row
 *   count. All-own-brand negatives therefore still fail, by name rather than by
 *   arithmetic, and the failure now says what is wrong instead of reporting a
 *   count the operator has to reverse-engineer.
 *
 * THE RESIDUE, STATED RATHER THAN HIDDEN: one genuine rival plus self-reference
 * padding can reach the count (section (e) pins that this is the ONLY residue —
 * zero genuine rivals never clears). That is the deliberate trade. The
 * alternative is failing otherwise-clean runs for a correction the model was
 * never told about, with no honest repair available; and a count of rows was
 * never proof of effort. What it can be is proof that at least one real
 * exclusion was made, and that is now enforced explicitly.
 *
 * BOTH DIRECTIONS THROUGHOUT:
 *   (a) the live shape converges — for each of the three reclassification causes;
 *   (b) below the floor still FAILS;
 *   (c) all-self-reference still FAILS, and the pinned tests stay green;
 *   (d) a genuine rival is unaffected in every direction;
 *   (e) `proposedStatus` is DERIVATION-ONLY — a model cannot write it, so it
 *       cannot mark its own rows corrected;
 *   (f) only a row PROPOSED as negative is credited;
 *   (g) the golden fixture still gates with zero failures.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** The fixture's own brand identity. */
const BRAND = snapshot.attributes.brand_name!;

/** A genuine rival brand, and a genuine banned-vocabulary exclusion. */
const RIVAL = 'greenluxe';
const BANNED = 'detox';
/** A COMPLIANCE-LEXICON term: C6 owns it, so C28 defers its failure to C6. */
const COMPLIANCE_OWNED = 'diabetes';

/** A structured-attribute property of the subject product, and where copy says it. */
const INGREDIENT = 'elderberry';
const SNAP: ListingSnapshot = {
  ...snapshot,
  attributes: {
    ...snapshot.attributes,
    ingredients: 'Elderberry, Zinc, Vitamin C',
    active_ingredients: 'Elderberry',
  },
};

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing): Failure[] => c28KeywordPlacement(l, pack, ctx);
const negativeRow = (term: string, why: string): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});
const floorFailures = (l: OptimizedListing): Failure[] =>
  c28(l).filter((f) => f.context.includes('negative term(s)'));
/** The ingredient, in the copy, legitimately — the reason the row is corrected. */
const plantIngredient = (l: OptimizedListing): OptimizedListing => {
  l.bullets[1] = `${l.bullets[1]} with elderberry`;
  return l;
};

const MIN = pack.rules.keywordRules!.minNegatives;

describe('the floor this is all about', () => {
  it('is 3, so three proposals are exactly enough and two are not', () => {
    expect(MIN).toBe(3);
  });
});

// ===========================================================================
// (a) THE LIVE SHAPE — three proposals, one reclassified, run converges
// ===========================================================================

describe('(a) the live shape: 3 proposed, 1 reclassified by code', () => {
  it('OWN BRAND: the row really is reclassified, only 2 survive, and the run CONVERGES', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [negativeRow(BRAND, 'Brand term'), negativeRow(RIVAL, 'Rival brand'), negativeRow(BANNED, 'Implied treatment')],
      l,
      pack,
      snapshot,
    );
    // the correction happened, and it is visible in the artifact
    const corrected = l.keywords.find((r) => r.term === BRAND)!;
    expect(corrected.status).not.toBe('negative');
    expect(corrected.proposedStatus).toBe('negative');
    expect(corrected.note).toContain("reclassified from 'negative'");
    // the PRE-FIX arithmetic, reproduced: only two negatives survive
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(2);
    // and the floor is nonetheless satisfied, because it counts the proposal
    expect(floorFailures(l)).toEqual([]);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('PRODUCT PROPERTY: same shape, same outcome', () => {
    const l = plantIngredient(clone());
    l.keywords = deriveKeywordPlacement(
      [negativeRow(INGREDIENT, 'Not targeting it'), negativeRow(RIVAL, 'Rival brand'), negativeRow(BANNED, 'Implied treatment')],
      l,
      pack,
      SNAP,
    );
    const corrected = l.keywords.find((r) => r.term === INGREDIENT)!;
    expect(corrected.status).not.toBe('negative');
    expect(corrected.proposedStatus).toBe('negative');
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(2);
    expect(floorFailures(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('COMPLIANCE-OWNED: this cause never cost the floor anything — the row SURVIVES as negative', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [negativeRow(COMPLIANCE_OWNED, 'Named condition'), negativeRow(RIVAL, 'Rival brand'), negativeRow(BANNED, 'Implied treatment')],
      l,
      pack,
      snapshot,
    );
    const row = l.keywords.find((r) => r.term === COMPLIANCE_OWNED)!;
    expect(row.status).toBe('negative');
    expect(row.proposedStatus).toBeUndefined();
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(3);
    expect(floorFailures(l)).toEqual([]);
  });

  it('END TO END: a live-shaped model run through optimize() converges', async () => {
    const liveShaped: LlmClient = async (req) => {
      if (req.user.includes('TASK: The keyword reference')) {
        return JSON.stringify({
          keywords: [
            { t: BRAND, tier: 'negative', status: 'negative', evidence: 'Kept out of rival copy' },
            { t: RIVAL, tier: 'negative', status: 'negative', evidence: 'Rival brand' },
            { t: BANNED, tier: 'negative', status: 'negative', evidence: 'Implied-treatment framing' },
            { t: 'probiotic supplement', tier: 1, status: 'placed', evidence: 'Category head term' },
            { t: 'digestive balance', tier: 1, status: 'placed', evidence: 'The intent cluster owned' },
            { t: 'vegan', tier: 3, status: 'placed', evidence: 'Filter facet' },
            { t: 'acidophilus', tier: 'backend', status: 'backend', evidence: 'Common-name variant' },
            { t: 'weight loss', tier: 'strategy', status: 'not-targeted', evidence: 'Converts badly' },
            { t: 'gut health', tier: 2, status: 'placed', evidence: 'Secondary cluster' },
          ],
        });
      }
      return mockLlm(req);
    };
    const listing = await optimize(snapshot, pack, liveShaped);
    const rows = listing.keywords ?? [];
    expect(rows.filter((r) => r.status === 'negative')).toHaveLength(2);
    expect(rows.find((r) => r.term === BRAND)!.proposedStatus).toBe('negative');
    expect(c28(listing)).toEqual([]);
    expect(runGate(listing, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// (b) BELOW THE FLOOR STILL FAILS — the floor was not deleted
// ===========================================================================

describe('(b) a model proposing FEWER than the floor still fails', () => {
  /** A row that is not an exclusion at all — the artifact is non-empty (an
   *  EMPTY one fails closed on its own leg, which is a different rule). */
  const nonNegative = (): KeywordTerm => ({
    term: 'unicorn dust',
    tier: 3,
    status: 'candidate',
    surfaces: [],
    why: 'Held back for a later cycle',
  });

  const cases: [string, () => KeywordTerm[]][] = [
    ['no negatives at all', () => [nonNegative()]],
    ['one genuine negative', () => [negativeRow(RIVAL, 'Rival brand')]],
    ['two genuine negatives', () => [negativeRow(RIVAL, 'Rival brand'), negativeRow(BANNED, 'Implied treatment')]],
  ];

  it.each(cases)('FAILS: %s', (_label, rows) => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(rows(), l, pack, snapshot);
    const fs = floorFailures(l);
    expect(fs.length, JSON.stringify(c28(l).map((f) => f.context))).toBeGreaterThan(0);
    expect(fs[0]!.fix).toContain(`at least ${MIN}`);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('FAILS: one genuine plus one reclassified is still only TWO proposals', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [negativeRow(BRAND, 'Brand term'), negativeRow(RIVAL, 'Rival brand')],
      l,
      pack,
      snapshot,
    );
    const fs = floorFailures(l);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.context).toBe('2 negative term(s)');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and exactly THREE proposals clear it — the boundary is where it says it is', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [negativeRow(BRAND, 'Brand term'), negativeRow(RIVAL, 'Rival'), negativeRow(BANNED, 'Implied treatment')],
      l,
      pack,
      snapshot,
    );
    expect(floorFailures(l)).toEqual([]);
  });
});

// ===========================================================================
// (c) THE ANTI-GAMING PIN — self-references never clear the floor
// ===========================================================================

describe('(c) a run whose only negatives are self-references still FAILS', () => {
  it('THREE own-brand rows: enough proposals, but not one surviving exclusion', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        negativeRow(BRAND, 'Brand term'),
        negativeRow(snapshot.attributes.manufacturer!, 'Brand term'),
        negativeRow('BrandX Probiotic', 'Brand term'),
      ],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.every((r) => r.status !== 'negative')).toBe(true);
    const fs = floorFailures(l);
    expect(fs, JSON.stringify(c28(l).map((f) => f.context))).toHaveLength(1);
    // the failure NAMES the defect rather than reporting a count to decode
    expect(fs[0]!.context).toContain('none of them an exclusion');
    expect(fs[0]!.fix).toContain('names THIS product');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('THREE product-property rows: same verdict', () => {
    const l = plantIngredient(clone());
    l.keywords = deriveKeywordPlacement(
      [
        negativeRow(INGREDIENT, 'Not targeting it'),
        negativeRow('zinc', 'Not targeting it'),
        negativeRow('vitamin c', 'Not targeting it'),
      ],
      l,
      pack,
      SNAP,
    );
    expect(l.keywords.every((r) => r.status !== 'negative')).toBe(true);
    expect(floorFailures(l).some((f) => f.context.includes('none of them an exclusion'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('own-brand AND product-property mixed, still all self-references: FAILS', () => {
    const l = plantIngredient(clone());
    l.keywords = deriveKeywordPlacement(
      [negativeRow(BRAND, 'Brand term'), negativeRow(INGREDIENT, 'Not targeting it'), negativeRow('zinc', 'Not targeting it')],
      l,
      pack,
      SNAP,
    );
    expect(floorFailures(l).some((f) => f.context.includes('none of them an exclusion'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('ONE genuine exclusion alongside them clears the leg — it is a floor, not a ban on corrections', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        negativeRow(BRAND, 'Brand term'),
        negativeRow(snapshot.attributes.manufacturer!, 'Brand term'),
        negativeRow(RIVAL, 'Rival brand'),
      ],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(1);
    expect(floorFailures(l)).toEqual([]);
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// (d) A GENUINE RIVAL IS UNAFFECTED IN EVERY DIRECTION
// ===========================================================================

describe('(d) the rival-brand exclusion R50 depends on is untouched', () => {
  const THREE = (): KeywordTerm[] => [
    negativeRow(RIVAL, 'Rival brand'),
    negativeRow(BANNED, 'Implied treatment'),
    negativeRow('purelyte', 'Rival brand'),
  ];

  it('a rival is never reclassified, so it always counts as a SURVIVOR', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(THREE(), l, pack, snapshot);
    for (const row of l.keywords) {
      expect(row.status, row.term).toBe('negative');
      expect(row.proposedStatus, row.term).toBeUndefined();
    }
    expect(floorFailures(l)).toEqual([]);
    expect(c28(l)).toEqual([]);
  });

  it('a rival PRESENT in the copy still fails, and the floor being satisfied does not silence it', () => {
    const l = clone();
    l.aplusContent.modules[0]!.bannerAltText = `${RIVAL} banner`;
    l.keywords = deriveKeywordPlacement(THREE(), l, pack, snapshot);
    const fs = c28(l);
    expect(fs.some((f) => f.context.includes(`negative term '${RIVAL}'`))).toBe(true);
    // the floor itself is content — the presence failure is a separate finding
    expect(floorFailures(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('and a rival cannot be laundered into a floor credit by being reclassified', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement([negativeRow(RIVAL, 'Rival brand')], l, pack, snapshot);
    expect(l.keywords[0]!.proposedStatus).toBeUndefined();
    expect(floorFailures(l)[0]!.context).toBe('1 negative term(s)');
  });
});

// ===========================================================================
// (e) `proposedStatus` IS DERIVATION-ONLY — the model cannot write it
// ===========================================================================

describe('(e) a run cannot mark its own rows corrected', () => {
  it('normalizeKeywords DROPS a volunteered `proposedStatus`', () => {
    const rows = normalizeKeywords([
      { term: 'gut health', tier: 1, status: 'placed', why: 'Head term', proposedStatus: 'negative' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposedStatus).toBeUndefined();
  });

  it('the LLM boundary schema does not even declare it', () => {
    const parsed = keywordsGroupSchemaFor(pack.rules.keywordRules).safeParse({
      keywords: Array.from({ length: 8 }, (_, i) => ({
        t: `term number ${i}`,
        tier: 1,
        status: 'placed',
        evidence: 'Evidence for the row',
        proposedStatus: 'negative',
      })),
    });
    expect(parsed.success).toBe(true);
    for (const row of parsed.data!.keywords) {
      expect((row as Record<string, unknown>).proposedStatus).toBeUndefined();
    }
  });

  it('END TO END: a model that volunteers the field on every row still fails the floor', async () => {
    const gamer: LlmClient = async (req) => {
      if (req.user.includes('TASK: The keyword reference')) {
        return JSON.stringify({
          keywords: Array.from({ length: 9 }, (_, i) => ({
            t: `honest term ${i}`,
            tier: 1,
            status: 'not-targeted',
            evidence: 'Deliberately left alone this cycle',
            proposedStatus: 'negative',
          })),
        });
      }
      return mockLlm(req);
    };
    const listing = await optimize(snapshot, pack, gamer);
    for (const row of listing.keywords ?? []) expect(row.proposedStatus).toBeUndefined();
    expect(floorFailures(listing)[0]!.context).toBe('0 negative term(s)');
    expect(runGate(listing, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// (f) ONLY A ROW PROPOSED AS `negative` IS CREDITED
// ===========================================================================

describe('(f) the credit is for a proposed EXCLUSION, not for any correction', () => {
  it('a corrected absence-claim row does not pad the floor', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        // an absence claim the copy falsifies: corrected to `placed`, and its
        // `proposedStatus` is `candidate` — not an exclusion, so no credit.
        { term: 'probiotic', tier: 1, status: 'candidate', surfaces: [], why: 'Held back' },
        negativeRow(RIVAL, 'Rival brand'),
        negativeRow(BANNED, 'Implied treatment'),
      ],
      l,
      pack,
      snapshot,
    );
    const corrected = l.keywords.find((r) => r.term === 'probiotic')!;
    expect(corrected.status).toBe('placed');
    expect(corrected.proposedStatus).toBe('candidate');
    expect(floorFailures(l)[0]!.context).toBe('2 negative term(s)');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// (g) THE GOLDEN FIXTURE
// ===========================================================================

describe('(g) the golden fixture', () => {
  it('carries no `proposedStatus` anywhere — nothing was corrected', () => {
    for (const row of clean.keywords ?? []) expect(row.proposedStatus, row.term).toBeUndefined();
  });

  it('still gates with ZERO failures', () => {
    expect(runGate(clone(), pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});
