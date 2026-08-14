import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { buildBenchmark } from '@/lib/audit/benchmark';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { toMarkdown } from '@/lib/export/markdown';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mineReviewLanguage } from '@/lib/knowledge/reviewLanguage';
import { runPipeline } from '@/lib/pipeline/run';
import type { CompetitorIngestion, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS9 — OPERATOR INPUTS: pasted review text and competitor ASINs.
 *
 * The contract both features live under is "when absent, behaviour unchanged",
 * so every suite here asserts the ABSENT case as hard as the present one: an
 * unsupplied input must leave the prompts byte-identical and P11 `unknown`,
 * never quietly scored zero.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let listing: OptimizedListing;
beforeAll(async () => {
  listing = await optimize(snapshot, pack, mockLlm);
});

/** Real-shaped review text: some of it lawful to mirror, some of it not. */
const REVIEWS = [
  'I keep it in my travel bag and the routine never slips on a work trip.',
  'It cured my irritable bowel syndrome in two weeks.',
  'One capsule with breakfast and I am done for the day.',
  'This finally relieved my chronic bloating.',
  'No refrigeration needed which is the whole reason I switched.',
  'Best seller for a reason, an absolute miracle.',
  'The capsules are small and easy to swallow every single morning.',
  'It treats my severe eczema better than anything else.',
].join('\n');

// ===========================================================================
// 1 — MINING: the filter IS the gate's lexicon
// ===========================================================================

describe('WS9 — review mining keeps the compliant half and records the rest', () => {
  const mined = () => mineReviewLanguage(pack, REVIEWS);

  it('keeps the lawful, everyday phrasing', () => {
    const phrases = mined().phrases.join(' | ').toLowerCase();
    expect(phrases).toContain('travel bag');
    expect(phrases).toContain('one capsule with breakfast');
    expect(phrases).toContain('no refrigeration needed');
  });

  const BANNED_FRAGMENTS: [string, string][] = [
    ['a named condition', 'irritable bowel syndrome'],
    ['a therapeutic action verb', 'relieved'],
    ['a banned superlative', 'miracle'],
    ['an abnormality marker', 'severe'],
  ];

  it.each(BANNED_FRAGMENTS)('drops the fragment carrying %s', (_label, needle) => {
    const m = mined();
    expect(m.phrases.join(' ').toLowerCase()).not.toContain(needle.toLowerCase());
    expect(m.rejected.some((r) => r.fragment.toLowerCase().includes(needle.toLowerCase()))).toBe(true);
  });

  it('records WHY each fragment was dropped', () => {
    for (const r of mined().rejected) {
      expect(r.why.length).toBeGreaterThan(5);
      expect(r.fragment.length).toBeGreaterThan(5);
    }
    expect(mined().rejected.length).toBeGreaterThanOrEqual(4);
  });

  it('is empty for empty input, and never throws on junk', () => {
    expect(mineReviewLanguage(pack, undefined).phrases).toEqual([]);
    expect(mineReviewLanguage(pack, '').phrases).toEqual([]);
    expect(() => mineReviewLanguage(pack, 42 as unknown as string)).not.toThrow();
    expect(() => mineReviewLanguage(pack, { a: 1 } as unknown as string)).not.toThrow();
    expect(mineReviewLanguage(pack, 'x'.repeat(200_000)).phrases.length).toBeLessThanOrEqual(40);
  });

  it('a listing written FROM the mined phrases still passes the gate', () => {
    const l = JSON.parse(JSON.stringify(listing)) as OptimizedListing;
    // Every mined phrase pasted into a Q&A answer: the filter's whole claim is
    // that what it keeps is safe to mirror.
    l.qa = mined().phrases.map((p) => ({ q: 'What do buyers say about the routine?', a: p, claimBearing: false }));
    const failures = runGate(l, pack, ctx).failures.filter((f) => f.field.startsWith('qa'));
    expect(failures.filter((f) => ['C6', 'C19', 'C21', 'C22'].includes(f.checkId))).toEqual([]);
  });
});

// ===========================================================================
// 2 — PROMPTS: present vs absent
// ===========================================================================

describe('WS9 — the buyer-language block reaches the copy prompts, and only then', () => {
  it('ABSENT: the prompts are byte-identical to the no-input build', () => {
    const plain = buildGroupPrompts(pack);
    const explicitlyEmpty = buildGroupPrompts(pack, 'dual', {});
    for (const key of ['bullets', 'description', 'qa'] as const) {
      expect(explicitlyEmpty[key](snapshot)).toBe(plain[key](snapshot));
    }
  });

  it('PRESENT: every copy group is shown the mined phrasing', () => {
    const mined = mineReviewLanguage(pack, REVIEWS);
    const withReviews = buildGroupPrompts(pack, 'dual', { buyerPhrases: mined.phrases });
    for (const key of ['bullets', 'description', 'qa'] as const) {
      const prompt = withReviews[key](snapshot);
      expect(prompt).toContain('BUYER LANGUAGE');
      expect(prompt).toContain(mined.phrases[0]!);
      expect(prompt).toContain('Mirror the WORDING, never the claim');
    }
  });

  it('the block NEVER carries a rejected fragment into a prompt', () => {
    const mined = mineReviewLanguage(pack, REVIEWS);
    const prompt = buildGroupPrompts(pack, 'dual', { buyerPhrases: mined.phrases }).bullets(snapshot);
    for (const r of mined.rejected) {
      expect(prompt).not.toContain(r.fragment);
    }
  });
});

// ===========================================================================
// 3 — P11
// ===========================================================================

describe('WS9 — P11 scores when review text is supplied, and only then', () => {
  const p11 = (a: { perPrinciple: { id: string; score: string; rationale: string }[] }) =>
    a.perPrinciple.find((p) => p.id === 'P11')!;

  it('ABSENT: P11 stays unknown on BOTH sides (unchanged behaviour)', () => {
    const audit = buildAudit(snapshot, listing, pack, ctx);
    expect(p11(audit.scorecard).score).toBe('unknown');
    expect(p11(audit.scorecardProposed!).score).toBe('unknown');
    expect(audit.reviewLanguageRejected).toBeUndefined();
  });

  it('PRESENT: P11 is scored on BOTH sides, so before/after stays comparable', () => {
    const mined = mineReviewLanguage(pack, REVIEWS);
    const audit = buildAudit(snapshot, listing, pack, ctx, { reviewTokens: mined.tokens });
    expect(p11(audit.scorecard).score).not.toBe('unknown');
    expect(p11(audit.scorecardProposed!).score).not.toBe('unknown');
  });

  it('the P11 verdict MOVES with how well the copy mirrors the language', () => {
    const mined = mineReviewLanguage(pack, REVIEWS);
    const mirrored = JSON.parse(JSON.stringify(listing)) as OptimizedListing;
    mirrored.description = `${mirrored.description}\n\n${mined.phrases.join(' ')}`;
    const good = buildAudit(snapshot, mirrored, pack, ctx, { reviewTokens: mined.tokens });

    const unrelated = JSON.parse(JSON.stringify(listing)) as OptimizedListing;
    unrelated.description = 'Zephyr quartz lantern for the mantelpiece.';
    unrelated.bullets = unrelated.bullets.map(() => 'Zephyr quartz lantern for the mantelpiece*');
    const bad = buildAudit(snapshot, unrelated, pack, ctx, { reviewTokens: mined.tokens });

    const rank: Record<string, number> = { none: 0, partial: 1, full: 2, unknown: -1 };
    expect(rank[p11(good.scorecardProposed!).score]!).toBeGreaterThan(
      rank[p11(bad.scorecardProposed!).score]!,
    );
  });

  it('review text that yields NO compliant phrasing leaves P11 unassessable, not zero', () => {
    const mined = mineReviewLanguage(pack, 'It cured my diabetes. A miracle. Treats severe eczema.');
    expect(mined.phrases).toEqual([]);
    const audit = buildAudit(snapshot, listing, pack, ctx, { reviewTokens: mined.tokens });
    expect(p11(audit.scorecardProposed!).score).toBe('unknown');
  });

  it('the pipeline threads reviewsText end to end and stays verified', async () => {
    const withReviews = await runPipeline(snapshot, mockLlm, 3, { reviewsText: REVIEWS });
    expect(withReviews.audit.verified).toBe(true);
    expect(p11(withReviews.audit.scorecardProposed!).score).not.toBe('unknown');
    expect((withReviews.audit.reviewLanguageRejected ?? []).length).toBeGreaterThan(0);

    const without = await runPipeline(snapshot, mockLlm, 3);
    expect(p11(without.audit.scorecardProposed!).score).toBe('unknown');
    expect(without.audit.benchmark).toBeUndefined();
  });
});

// ===========================================================================
// 4 — COMPETITOR BENCHMARK
// ===========================================================================

const competitorSnapshot = (asin: string, over: Partial<ListingSnapshot> = {}): ListingSnapshot => ({
  ...snapshot,
  asin,
  raw: { aplusText: 'Some A+ body text from the rival page.' },
  ...over,
});

describe('WS9 — the competitor benchmark', () => {
  it('is absent when no competitor was supplied', () => {
    expect(buildBenchmark(snapshot, listing, undefined)).toBeUndefined();
    expect(buildBenchmark(snapshot, listing, [])).toBeUndefined();
  });

  it('measures every row the same way, ours included', () => {
    const competitors: CompetitorIngestion[] = [
      { asin: 'B0RIVAL001', snapshot: competitorSnapshot('B0RIVAL001') },
      { asin: 'B0RIVAL002', snapshot: competitorSnapshot('B0RIVAL002', { bullets: ['a', 'b'], attributes: {}, raw: {} }) },
    ];
    const bm = buildBenchmark(snapshot, listing, competitors)!;
    expect(bm.requested).toBe(2);
    expect(bm.ingested).toBe(2);
    expect(bm.subject.titleLength).toBe(listing.title75.length);
    expect(bm.subject.bulletCount).toBe(listing.bullets.length);
    expect(bm.subject.attributeCount).toBe(Object.keys(listing.attributes).length);
    expect(bm.subject.aplusPresent).toBe(true);
    expect(bm.current.titleLength).toBe(snapshot.title.length);
    expect(bm.rows[0]!.aplusPresent).toBe(true);
    expect(bm.rows[1]!.aplusPresent).toBe(false);
    expect(bm.rows[1]!.bulletCount).toBe(2);
  });

  it('DEGRADES GRACEFULLY: a failed ingestion is a failed ROW, never a lost run', () => {
    const competitors: CompetitorIngestion[] = [
      { asin: 'B0RIVAL001', snapshot: competitorSnapshot('B0RIVAL001') },
      { asin: 'B0BLOCKED1', error: 'PROVIDER_BLOCKED: the page could not be fetched' },
    ];
    const bm = buildBenchmark(snapshot, listing, competitors)!;
    expect(bm.requested).toBe(2);
    expect(bm.ingested).toBe(1);
    expect(bm.rows[1]!.status).toBe('failed');
    expect(bm.rows[1]!.note).toContain('PROVIDER_BLOCKED');
    // ...and the failed row carries no measurements, so nothing reads as zero.
    expect(bm.rows[1]!.bulletCount).toBeUndefined();
    expect(bm.rows[1]!.aplusPresent).toBeUndefined();
  });

  it('never affects the gate verdict', () => {
    const audit = buildAudit(snapshot, listing, pack, ctx, {
      competitors: [{ asin: 'B0BLOCKED1', error: 'blocked' }],
    });
    expect(audit.verified).toBe(true);
    expect(audit.verified).toBe(audit.gateResult.pass);
    expect(audit.benchmark!.ingested).toBe(0);
  });

  it('carries NO rival copy — only structural counts', () => {
    const rivalCopy = 'RivalBrand Ultra Cures Everything Fast';
    const bm = buildBenchmark(snapshot, listing, [
      { asin: 'B0RIVAL001', snapshot: competitorSnapshot('B0RIVAL001', { title: rivalCopy, description: rivalCopy }) },
    ])!;
    const serialized = JSON.stringify(bm);
    expect(serialized).not.toContain('RivalBrand');
    expect(serialized).not.toContain('Cures Everything');
    expect(bm.rows[0]!.titleLength).toBe(rivalCopy.length);
  });

  it('renders in the sheet and in the record, failed rows included', () => {
    const audit = buildAudit(snapshot, listing, pack, ctx, {
      competitors: [
        { asin: 'B0RIVAL001', snapshot: competitorSnapshot('B0RIVAL001') },
        { asin: 'B0BLOCKED1', error: 'PROVIDER_BLOCKED' },
      ],
      reviewTokens: mineReviewLanguage(pack, REVIEWS).tokens,
      reviewRejected: mineReviewLanguage(pack, REVIEWS).rejected,
    });
    const html = buildShipSheet({ optimized: listing, audit, pack });
    expect(html).toContain('Competitor benchmark');
    expect(html).toContain('B0RIVAL001');
    expect(html).toContain('not ingested');
    expect(html).toContain('1 of 2 competitor ASIN(s) ingested');
    // The dropped review phrasing is disclosed rather than silently swallowed.
    expect(html).toContain('Review phrasing that was not used');
    expect(html).toContain('irritable bowel syndrome');

    const md = toMarkdown(listing, audit);
    expect(md).toContain('### Competitor benchmark');
    expect(md).toContain('B0BLOCKED1');
    expect(md).toContain('not ingested');
  });

  it('a sheet for a run with no benchmark renders no benchmark section', () => {
    const audit = buildAudit(snapshot, listing, pack, ctx);
    const html = buildShipSheet({ optimized: listing, audit, pack });
    expect(html).not.toContain('Competitor benchmark');
    expect(html).not.toContain('Review phrasing that was not used');
  });
});
