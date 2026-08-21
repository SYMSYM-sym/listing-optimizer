import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import {
  KEYWORD_MIN_TERMS,
  KEYWORD_SCHEMA_TOLERANCE,
  keywordSchemaMaxTerms,
  keywordSchemaWhyMaxChars,
  keywordsGroupSchemaFor,
  keywordsMaxTokens,
} from '@/lib/engine/schemas';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { runPipeline } from '@/lib/pipeline/run';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { KeywordRules } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * D1 — the keywords group never returned valid JSON in production.
 *
 *   {"event":"llm.group","group":"keywords","ms":25901,
 *    "stopReason":"max_tokens","inputTokens":5273,"outputTokens":3000}
 *   {"event":"llm.reparse","group":"keywords","error":"SyntaxError","issuePaths":[]}
 *   {"event":"llm.group","group":"keywords","ms":25197,"stopReason":"max_tokens",...}
 *   POST /api/optimize 502
 *
 * Three separate defects, asserted separately below:
 *  (a) the budget was smaller than the artifact the schema and prompt allowed;
 *  (b) the artifact had no stated end, so a bigger budget would only move the
 *      cliff — the cap now lives in the pack, is stated in the prompt, is
 *      enforced by the schema AND derives the budget;
 *  (c) a group that still fails must DEGRADE, not 502 — and a degraded run can
 *      never be `verified`, least of all by leaving C28 nothing to check.
 *
 * The golden suite cannot reach any of this: its mock returns a hand-written,
 * already-valid payload and never truncates.
 */
const pack = loadPack('supplements');
const kr = pack.rules.keywordRules!;
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * One row at its worst permitted size, pretty-printed as a model emits it.
 *
 * `why` is filled to the length THE SCHEMA WILL ACCEPT rather than the shorter
 * length the prompt states, because that is the bound the budget must pay for:
 * anything longer is rejected on shape, and anything the parser accepts must
 * have been receivable. Derived from `keywordSchemaWhyMaxChars`, never restated.
 */
const worstRow = () => ({
  term: 'x'.repeat(30),
  tier: 'backend',
  status: 'captured-via',
  surfaces: kr.visibleSurfaces.slice(0, 6),
  why: 'w'.repeat(keywordSchemaWhyMaxChars(kr)!),
  via: 'the compliant everyday cluster the copy writes out in full',
  home: 'paid exact match plus off-site articles',
});

describe('D1a/D1b — the artifact is bounded and the budget pays for the bound', () => {
  it('the pack carries both caps', () => {
    expect(kr.maxTerms).toBeGreaterThanOrEqual(KEYWORD_MIN_TERMS);
    expect(kr.whyMaxChars).toBeGreaterThan(0);
  });

  it('the budget covers the LARGEST artifact the schema will accept', () => {
    // THE SCHEMA'S bound, not the prompt's — see the note on `worstRow`. Both
    // numbers are read off the derivation, so this cannot drift from it.
    const worst = JSON.stringify(
      { keywords: Array.from({ length: keywordSchemaMaxTerms(kr)! }, worstRow) },
      null,
      2,
    );
    // JSON of this shape tokenizes at roughly 3 characters per token.
    const needed = Math.ceil(worst.length / 3);
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(needed);
    // and it is well above what the live run was given, which truncated
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(3000);
    // the very artifact just measured is one the parser accepts, so the two
    // halves of the sentence above are about the same object
    expect(keywordsGroupSchemaFor(kr).safeParse(JSON.parse(worst)).success).toBe(true);
  });

  it('the budget is DERIVED, so raising a cap cannot leave the cliff behind', () => {
    const bigger: KeywordRules = { ...kr, maxTerms: kr.maxTerms * 2 };
    expect(keywordsMaxTokens(bigger)).toBeGreaterThan(keywordsMaxTokens(kr));
    const wordier: KeywordRules = { ...kr, whyMaxChars: kr.whyMaxChars * 2 };
    expect(keywordsMaxTokens(wordier)).toBeGreaterThan(keywordsMaxTokens(kr));
    // ...and it is derived from the SCHEMA's numbers, so widening the tolerance
    // alone — with both pack caps unmoved — moves the budget too. This is the
    // property that failed before: the budget read the prompt's numbers while
    // the schema enforced the tolerated ones.
    expect(keywordsMaxTokens(kr)).toBeGreaterThan(
      keywordsMaxTokens({ ...kr, whyMaxChars: Math.ceil(kr.whyMaxChars / KEYWORD_SCHEMA_TOLERANCE) }),
    );
  });

  it('the prompt states both caps, from the same pack numbers', () => {
    const emitted = {
      title: 'A title',
      title75: 'A short title',
      itemHighlights: 'Highlights',
      bullets: ['b1'],
      description: 'A description',
      backendSearchTerms: 'terms',
      attributes: {},
    };
    const text = buildGroupPrompts(pack).keywords(snapshot, emitted);
    expect(text).toContain(`at most ${kr.maxTerms} rows`);
    expect(text).toContain(`at most ${kr.whyMaxChars} characters`);
  });

  it('the schema enforces the cap in both directions', () => {
    const schema = keywordsGroupSchemaFor(kr);
    const rows = (n: number) => ({ keywords: Array.from({ length: n }, worstRow) });
    const schemaMax = keywordSchemaMaxTerms(kr)!;
    // THE STATED CAP IS ACCEPTED, and so is the ordinary overshoot above it —
    // the tolerance the row count gained when D1 recurred at the large-input
    // end. It is still BOUNDED: one row past the tolerated bound is refused.
    expect(schemaMax).toBeGreaterThan(kr.maxTerms);
    expect(schema.safeParse(rows(kr.maxTerms)).success).toBe(true);
    expect(schema.safeParse(rows(kr.maxTerms + 1)).success).toBe(true);
    expect(schema.safeParse(rows(schemaMax)).success).toBe(true);
    expect(schema.safeParse(rows(schemaMax + 1)).success).toBe(false);
    expect(schema.safeParse(rows(KEYWORD_MIN_TERMS - 1)).success).toBe(false);
    // a `why` far past the stated limit is refused rather than silently kept
    const wordy = rows(KEYWORD_MIN_TERMS);
    wordy.keywords[0]!.why = 'w'.repeat(kr.whyMaxChars * 4);
    expect(schema.safeParse(wordy).success).toBe(false);
  });
});

/**
 * A client that answers every group from the golden mock, except the named
 * group, whose answer is cut short exactly as a `max_tokens` stop does — the
 * JSON ends mid-row, so `JSON.parse` throws on the attempt AND on the retry.
 */
const truncating = (group: string): LlmClient => async (req) => {
  const text = await mockLlm(req);
  if (req.groupName !== group) return text;
  return text.slice(0, Math.floor(text.length * 0.6));
};

describe('D1c — a group that still fails DEGRADES; it never 502s and never verifies', () => {
  it('a truncated keywords group: the run completes, and is NOT verified', async () => {
    const result = await runPipeline(snapshot, truncating('keywords'), 1);

    // it completed at all — the live behaviour was an exception and a 502
    expect(result.optimized.title.length).toBeGreaterThan(0);
    expect(result.optimized.bullets).toHaveLength(5);

    expect(result.audit.verified).toBe(false);
    expect(result.optimized.state).toBe('draft');
    expect(result.optimized.degradedGroups).toEqual(['keywords']);

    const failures = result.audit.gateResult.failures;
    // the group is NAMED as the reason
    expect(failures.some((f) => f.checkId === 'GEN' && f.field === 'generation.keywords')).toBe(true);
    // and C28 is NOT silently disabled by the artifact being absent
    expect(failures.some((f) => f.checkId === 'C28' && f.field === 'keywords')).toBe(true);
    // no check crashed on the degraded shape
    expect(failures.filter((f) => f.checkId === 'GATE')).toEqual([]);
  });

  it('a well-formed keywords group: normal behaviour, verified, no marker at all', async () => {
    const result = await runPipeline(snapshot, mockLlm, 1);
    expect(result.audit.verified).toBe(true);
    expect(result.audit.gateResult.failures).toEqual([]);
    expect(result.optimized.state).toBe('verified');
    expect('degradedGroups' in result.optimized).toBe(false);
  });

  it.each(['title', 'bullets', 'description', 'backend', 'attributes', 'aplus', 'images', 'qa'])(
    'a truncated %s group also degrades instead of losing the run',
    async (group) => {
      const result = await runPipeline(snapshot, truncating(group), 0);
      expect(result.audit.verified).toBe(false);
      expect(result.optimized.degradedGroups).toContain(group);
      expect(
        result.audit.gateResult.failures.some(
          (f) => f.checkId === 'GEN' && f.field === `generation.${group}`,
        ),
      ).toBe(true);
      expect(result.audit.gateResult.failures.filter((f) => f.checkId === 'GATE')).toEqual([]);
    },
  );
});
