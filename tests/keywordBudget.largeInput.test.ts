import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import {
  KEYWORD_SCHEMA_TOLERANCE,
  keywordSchemaMaxTerms,
  keywordSchemaWhyMaxChars,
  keywordsGroupSchemaFor,
  keywordsMaxTokens,
} from '@/lib/engine/schemas';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import type { ListingSnapshot } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * D1 RECURRED AT THE LARGE-INPUT END — AND IT WAS THE ROW COUNT, NOT THE BUDGET.
 *
 * Live, a 24-run convergence batch. Three occurrences, ALL on one ASIN — the
 * largest of the three test listings, a twenty-ingredient formula. The other two
 * ASINs went 8/8 and 8/8 clean:
 *
 *   GEN | generation.keywords | (no valid output)
 *
 * `(no valid output)` is the degrade path, so the group had exhausted its
 * reparse retry as well: two calls, neither of which produced a payload the
 * parser would take.
 *
 * ===========================================================================
 * THE TWO CAUSES THAT HAD TO BE RULED OUT FIRST — §1 measures both
 * ===========================================================================
 *  - THE BUDGET ARITHMETIC. `keywordsMaxTokens` derives the budget from the row
 *    count times a per-row character estimate, and the question is whether the
 *    schema's `why` tolerance sits INSIDE that estimate or outside it. It sits
 *    inside: the budget's prose allowance IS `keywordSchemaWhyMaxChars`, so a
 *    model writing to the STATED `whyMaxChars` and one writing to the TOLERATED
 *    bound both fit, with room to spare. Not the defect.
 *  - THE INPUT SQUEEZING THE OUTPUT. The keywords group runs in phase 3, after
 *    all copy, so its prompt carries the finished listing and does grow with the
 *    listing — measurably, and §1 pins the growth. But `max_tokens` is an OUTPUT
 *    bound; the prompt is not spent against it, and the budget is a pure
 *    function of the pack. Not the defect either.
 *
 * ===========================================================================
 * WHAT DOES SCALE WITH THE INPUT IS THE ARTIFACT THE PROMPT ASKS FOR — §2
 * ===========================================================================
 * Tier 2 is defined in the pack vocabulary as "named entities — each component
 * by its full name", so a twenty-component formula owes twenty rows before a
 * single head term, qualifier, buyer-language phrase or `minNegatives` exclusion
 * is written. `maxTerms` is 28 and does not move with the input, so on that ASIN
 * the prompt asked for an artifact the schema would not accept — and
 * `z.array().max()` rejects the WHOLE payload for the surplus, so a reference
 * that was thirty-odd good rows was thrown away entire, the reparse re-asked the
 * identical impossible thing, and the group degraded.
 *
 * The fix is the treatment this file's own `why` bound has had since D1: the
 * SCHEMA tolerates an ordinary overshoot above the limit the PROMPT states, one
 * tolerance constant for both fields, and the budget is derived from what the
 * schema will accept. `maxTerms` is not lowered (`minNegatives` and the four
 * tiers need every row it allows) and not raised in the pack (the model would
 * write to the larger number on every listing).
 *
 * ===========================================================================
 * AND THE CLIFF ONLY MOVED — §3
 * ===========================================================================
 * An artifact past even the tolerated bound is still refused, and a response
 * that is not JSON at all is still unparseable. Both still degrade, `GEN` still
 * blocks, and the run still comes back `verified:false`. A degrade never becomes
 * a silent pass.
 */

const pack = loadPack('supplements');
const kr = pack.rules.keywordRules!;
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

// ===========================================================================
// §1 — WHAT THE INPUT DOES, AND WHAT IT DOES NOT DO
// ===========================================================================

/** The live ASIN's shape: a twenty-component formula, in the snapshot only. */
const COMPONENTS = Array.from({ length: 20 }, (_, i) => `Component ${i + 1} Standardised Extract`);

const largeSnapshot = (): ListingSnapshot => {
  const raw = JSON.parse(JSON.stringify(rainforestSample)) as typeof rainforestSample;
  const product = raw.product as Record<string, unknown>;
  product.title = `BrandX ${COMPONENTS.length}-in-1 Formula with ${COMPONENTS.slice(0, 6).join(', ')}, 120 Vegetable Capsules`;
  product.feature_bullets = Array.from(
    { length: 5 },
    (_, i) => `POINT ${i + 1}: ${COMPONENTS.join(', ')} in one daily two-capsule serving.`,
  );
  product.description = `${COMPONENTS.join(', ')}. `.repeat(12);
  product.attributes = [
    ...(raw.product.attributes as unknown[]),
    { name: 'Ingredients', value: COMPONENTS.join(', ') },
    { name: 'Active Ingredients', value: COMPONENTS.join(', ') },
  ];
  return toSnapshot(mapProduct('B0LARGEASIN', raw.product, raw));
};

/** The emitted copy the phase-3 prompt prints back, at each size. */
const emittedSmall = {
  title: 'BrandX Probiotic Supplement 50 Billion CFU, 60 Vegan Capsules',
  title75: 'BrandX Probiotic Supplement 50 Billion CFU',
  itemHighlights: 'Vegan gluten free, shelf stable, two month supply',
  bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
  description: 'A description.',
  backendSearchTerms: 'terms',
  attributes: { brand_name: 'BrandX' },
};

const emittedLarge = {
  title: `BrandX ${COMPONENTS.length}-in-1 Formula with ${COMPONENTS.join(', ')}, 120 Vegetable Capsules`,
  title75: `BrandX ${COMPONENTS.length}-in-1 Formula, 120 Capsules`,
  itemHighlights: COMPONENTS.join(', '),
  bullets: Array.from({ length: 5 }, () => `A bullet naming ${COMPONENTS.join(', ')} in one sentence.`),
  description: `${COMPONENTS.join(', ')} in one daily serving. `.repeat(20),
  backendSearchTerms: COMPONENTS.join(' ').toLowerCase(),
  attributes: {
    brand_name: 'BrandX',
    ingredients: COMPONENTS.join(', '),
    active_ingredients: COMPONENTS.join(', '),
  },
};

describe('§1 the input scales the PROMPT; it never scales the OUTPUT budget', () => {
  it('the phase-3 prompt really does grow with the finished listing', () => {
    const prompts = buildGroupPrompts(pack);
    const small = prompts.keywords(snapshot, emittedSmall);
    const large = prompts.keywords(largeSnapshot(), emittedLarge);
    // Both halves grow: the snapshot block carries the ingested page and the
    // surfaces block carries the copy this group is written against.
    expect(large.length).toBeGreaterThan(small.length * 2);
  });

  it('and the OUTPUT budget is a pure function of the pack — no prompt enters it', () => {
    // `max_tokens` bounds generation, not the request. The same budget is handed
    // to the small listing and the large one, which is why input size cannot be
    // what starved this group.
    expect(keywordsMaxTokens(kr)).toBe(keywordsMaxTokens({ ...kr }));
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(0);
  });

  it("the schema's `why` tolerance sits INSIDE the budget, not outside it", () => {
    const whyStated = kr.whyMaxChars;
    const whyTolerated = keywordSchemaWhyMaxChars(kr)!;
    expect(whyTolerated).toBe(Math.ceil(whyStated * KEYWORD_SCHEMA_TOLERANCE));

    // The largest artifact the schema accepts, priced at BOTH `why` lengths.
    // JSON of this shape tokenizes at roughly 3 characters per token.
    const priced = (why: number): number => {
      const rows = Array.from({ length: keywordSchemaMaxTerms(kr)! }, () => ({
        term: 'x'.repeat(30),
        tier: 'backend',
        status: 'captured-via',
        why: 'w'.repeat(why),
        via: 'the compliant everyday cluster the copy writes out in full',
        home: 'paid exact match plus off-site articles',
      }));
      return Math.ceil(JSON.stringify({ keywords: rows }, null, 2).length / 3);
    };
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(priced(whyStated));
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(priced(whyTolerated));
  });
});

// ===========================================================================
// §2 — THE LARGE-INPUT ARTIFACT: A REFERENCE PAST THE STATED CAP SUCCEEDS
// ===========================================================================

/**
 * A reference sized to a twenty-component formula: one tier-2 row per component
 * before anything else is written, plus the head terms, the qualifiers, the
 * buyer-language phrases and the exclusions the floor demands.
 *
 * The PIPELINE runs on the ordinary fixture snapshot and every other group is
 * answered from the golden mock. That is deliberate: the row count is the half
 * of the large-input shape that broke the group, and holding everything else to
 * the fixture leaves `GEN | generation.keywords` as the only thing that can
 * move. §1 measures the other half, prompt growth, directly.
 */
const largeReference = (rowCount: number): { keywords: unknown[] } => {
  const rows: Record<string, unknown>[] = [
    { t: 'probiotic supplement', tier: 1, status: 'placed', evidence: 'Category head term' },
    { t: 'digestive balance', tier: 1, status: 'placed', evidence: 'The intent cluster owned' },
    { t: '50 billion cfu', tier: 2, status: 'placed', evidence: 'The hero spec' },
    { t: 'prebiotic', tier: 2, status: 'placed', evidence: 'Named entity' },
    { t: 'vegan', tier: 3, status: 'placed', evidence: 'Filter facet' },
    { t: 'shelf stable', tier: 3, status: 'placed', evidence: 'Storage differentiator' },
    { t: 'acidophilus', tier: 'backend', status: 'backend', evidence: 'Common-name variant' },
    { t: 'weight loss', tier: 'strategy', status: 'not-targeted', evidence: 'Converts badly' },
    { t: 'diabetes', tier: 'negative', status: 'negative', evidence: 'Named condition' },
    { t: 'detox', tier: 'negative', status: 'negative', evidence: 'Implied-treatment framing' },
    { t: 'greenluxe', tier: 'negative', status: 'negative', evidence: 'Rival brand' },
  ];
  // One row per formula component, which is what tier 2 owes on this listing.
  for (const c of COMPONENTS) {
    if (rows.length >= rowCount) break;
    rows.push({ t: c.toLowerCase(), tier: 2, status: 'candidate', evidence: 'Named component' });
  }
  // ...and any remainder, so the count is exactly what each case asks for.
  let n = 0;
  while (rows.length < rowCount) {
    rows.push({
      t: `buyer language phrase ${++n}`,
      tier: 4,
      status: 'candidate',
      evidence: 'Conversational phrasing held for a later cycle',
    });
  }
  return { keywords: rows.slice(0, rowCount) };
};

/** Every group from the golden mock, except `keywords`, answered by `answer`. */
const withKeywords = (answer: () => string): LlmClient => async (req) =>
  req.groupName === 'keywords' ? answer() : mockLlm(req);

describe('§2 a reference sized to a twenty-component formula now succeeds', () => {
  const ROWS = 36;

  it('THE LIVE SHAPE, REPRODUCED: the reference is bigger than the cap the prompt states', () => {
    // Twenty tier-2 component rows plus the head terms, qualifiers, buyer
    // phrases and the three exclusions the floor demands do not fit in 28.
    expect(COMPONENTS).toHaveLength(20);
    expect(ROWS).toBeGreaterThan(kr.maxTerms);
    // The golden reference — a listing with a fraction of that formula — uses 19,
    // which is the size `maxTerms` was calibrated against.
    expect(kr.maxTerms).toBeGreaterThan(19);
  });

  it('THE DEFECT WAS REAL: the row bound rejects the WHOLE payload, not the surplus rows', () => {
    // Before the fix the schema's row bound WAS the prompt's `maxTerms`, with no
    // tolerance at all, and this artifact is past it.
    expect(ROWS).toBeGreaterThan(kr.maxTerms);
    // The MECHANISM, shown on a pack tightened until its tolerated bound lands
    // one row short of this artifact: `z.array().max()` fails the OBJECT, so
    // thirty-six good rows are thrown away for the surplus. That is why the
    // reparse retry could not help — it re-asked the identical impossible thing
    // — and why the group degraded rather than returning a shorter list.
    const tight = { ...kr, maxTerms: Math.floor((ROWS - 1) / KEYWORD_SCHEMA_TOLERANCE) };
    expect(keywordSchemaMaxTerms(tight)!).toBeLessThan(ROWS);
    const parsed = keywordsGroupSchemaFor(tight).safeParse(largeReference(ROWS));
    expect(parsed.success).toBe(false);
    // the failure is against the ARRAY, not against any row
    expect(parsed.error!.issues.map((i) => i.path.join('.'))).toContain('keywords');
  });

  it('and the artifact is INSIDE the bound the schema now accepts', () => {
    expect(ROWS).toBeLessThanOrEqual(keywordSchemaMaxTerms(kr)!);
    expect(keywordsGroupSchemaFor(kr).safeParse(largeReference(ROWS)).success).toBe(true);
  });

  it('END TO END: the group is NOT degraded and `GEN` does not block', async () => {
    const result = await runPipeline(
      snapshot,
      withKeywords(() => JSON.stringify(largeReference(ROWS))),
      0,
    );
    expect(result.optimized.degradedGroups ?? []).not.toContain('keywords');
    expect(
      result.audit.gateResult.failures.some(
        (f) => f.checkId === 'GEN' && f.field === 'generation.keywords',
      ),
    ).toBe(false);
    // the rows survived — the reference is the size the model wrote, not a
    // truncation of it
    expect(result.optimized.keywords).toHaveLength(ROWS);
    // and nothing crashed on the larger shape
    expect(result.audit.gateResult.failures.filter((f) => f.checkId === 'GATE')).toEqual([]);
  });
});

// ===========================================================================
// §3 — THE CLIFF MOVED; IT DID NOT DISAPPEAR
// ===========================================================================

describe('§3 a group that still cannot produce valid output still blocks', () => {
  it('an artifact past even the TOLERATED bound is refused, and the group degrades', async () => {
    const past = keywordSchemaMaxTerms(kr)! + 1;
    expect(keywordsGroupSchemaFor(kr).safeParse(largeReference(past)).success).toBe(false);

    const result = await runPipeline(
      snapshot,
      withKeywords(() => JSON.stringify(largeReference(past))),
      0,
    );
    expect(result.optimized.degradedGroups).toContain('keywords');
    expect(
      result.audit.gateResult.failures.some(
        (f) => f.checkId === 'GEN' && f.field === 'generation.keywords',
      ),
    ).toBe(true);
    expect(result.audit.verified).toBe(false);
    expect(result.optimized.state).toBe('draft');
  });

  it('a genuinely unparseable response degrades too — and C28 is not silently disabled', async () => {
    const result = await runPipeline(
      snapshot,
      withKeywords(() => JSON.stringify(largeReference(36)).slice(0, 400)),
      0,
    );
    expect(result.optimized.degradedGroups).toContain('keywords');
    const failures = result.audit.gateResult.failures;
    expect(failures.some((f) => f.checkId === 'GEN' && f.field === 'generation.keywords')).toBe(true);
    expect(failures.some((f) => f.checkId === 'C28' && f.field === 'keywords')).toBe(true);
    expect(result.audit.verified).toBe(false);
    expect(failures.filter((f) => f.checkId === 'GATE')).toEqual([]);
  });
});
