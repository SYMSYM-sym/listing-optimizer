import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/regenerate/route';
import { regenerateOperatorInputs, EMPTY_OPERATOR_INPUTS } from '@/app/operatorInputs';
import { optimize } from '@/lib/engine/optimize';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import type { Audit, ListingSnapshot, OptimizedListing } from '@/lib/types';

/**
 * ===========================================================================
 * N4 — REGENERATE WAS GRADED MORE WEAKLY THAN THE RUN IT REPLACES
 * ===========================================================================
 *
 * THE DECISION AND THE REASON IT CHANGED.
 *
 * `app/api/regenerate/route.ts` carried `fictionPhrases`, `panelFacts` and
 * (since G4) `reviewsText`, and deliberately did NOT carry `competitorAsins`.
 * The recorded reason — CONFORMANCE-DEVIATIONS item 9 — was:
 *
 *   "they feed the BENCHMARK, a measurement of pages a single-group
 *    regeneration does not re-ingest, and their absence changes no copy."
 *
 * That was TRUE WHEN IT WAS WRITTEN. WS9→R50 (item 7) then gave the competitor
 * set a SECOND job that has nothing to do with the benchmark: `rivalBrandNames`
 * resolves it inside `buildAudit` into the AUTOMATIC RIVAL-BRAND NEGATIVE SET
 * that C28 enforces — and C28 is a blocking check, so that set feeds `verified`.
 * Nobody re-read the comment when the second job was added.
 *
 * THE SPECIFIC SCENARIO, and §1 reproduces it end to end:
 *   1. the operator supplies competitors; the original run is graded with the
 *      rival brands ARMED;
 *   2. they regenerate one group — which is written FROM SCRATCH by the model,
 *      i.e. exactly the moment a rival brand can enter the copy;
 *   3. without the field, that regeneration is graded with the automatic set
 *      EMPTY, so a rival brand the ORIGINAL run's gate would have caught comes
 *      back `verified: true`;
 *   4. and the route PERSISTS that verdict over the stored run.
 *
 * Regeneration had silently become the weakest grader in the app. A second,
 * smaller consequence the old reasoning also missed: because the route re-runs
 * `buildAudit` and persists it, a competitor-less regeneration DELETED
 * `audit.benchmark` from the stored run.
 *
 * DECISION: THREAD IT. The route accepts `competitorAsins` and re-ingests them
 * through the same `ingestCompetitors` the optimize route uses (one
 * implementation — two would drift, and the one that drifted would be the one
 * that stopped resolving a rival brand). Nothing new is trusted: every string
 * still comes from a page the operator asked for, at run time, and
 * `rivalBrandNames` applies the same four bounds.
 *
 * COST, accepted deliberately: up to MAX_COMPETITORS provider calls, in
 * parallel, on an explicit operator action. A regeneration graded more weakly
 * than the run it replaces is worse than a regeneration that costs what the
 * original cost.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const pack = loadPack('supplements');

/**
 * The rival. TWO words, because the automatic set never admits a one-word brand
 * (item 7.4) — using a one-word rival would make this suite pass for the wrong
 * reason.
 */
const RIVAL = 'NovaPeak Labs';
const RIVAL_ASIN = 'B0RIVAL001';

vi.mock('@/lib/server/guard', () => ({ checkAccess: vi.fn(() => null) }));
vi.mock('@/lib/store/runs', () => ({ updateRun: vi.fn() }));
vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return { ...actual, anthropicClient: vi.fn() };
});
/**
 * The provider is stubbed, not the ingester: the route must run the REAL
 * `ingestCompetitors` (the cap, the ASIN filter, the never-throw behaviour) so
 * this suite exercises the code that actually ships.
 */
vi.mock('@/lib/ingest', () => ({ ingestByAsin: vi.fn() }));

import { anthropicClient } from '@/lib/engine/llm';
import { ingestByAsin } from '@/lib/ingest';
import { updateRun } from '@/lib/store/runs';

/** A competitor page whose structural brand fields carry the rival's name. */
function rivalSnapshot(): ListingSnapshot {
  return {
    ...JSON.parse(JSON.stringify(snapshot)),
    asin: RIVAL_ASIN,
    attributes: { brand_name: RIVAL, manufacturer: `${RIVAL} LLC` },
  } as ListingSnapshot;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * An LLM that regenerates the BACKEND group and slips the rival's brand into
 * it. Backend is chosen because it is a single string the model rewrites from
 * scratch — the exact "regenerated group introduces a rival brand" shape.
 */
function rivalWritingLlm(): typeof mockLlm {
  return (async (req: Parameters<typeof mockLlm>[0]) => {
    const body = await mockLlm(req);
    if (!req.user.includes('backend search terms') && !req.user.includes('backendSearchTerms')) {
      return body;
    }
    const parsed = JSON.parse(body) as { backendSearchTerms?: string };
    parsed.backendSearchTerms = `${RIVAL.toLowerCase()} probiotico acidophilus`;
    return JSON.stringify(parsed);
  }) as typeof mockLlm;
}

let base: OptimizedListing;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(anthropicClient).mockReturnValue(mockLlm as never);
  vi.mocked(ingestByAsin).mockImplementation(async (asin: string) => {
    if (asin === RIVAL_ASIN) return rivalSnapshot();
    throw new Error(`no fixture for ${asin}`);
  });
  base = await optimize(snapshot, pack, mockLlm);
});

const auditOf = async (res: Response): Promise<Audit> =>
  ((await res.json()) as { audit: Audit }).audit;

// ===========================================================================
// §1 — THE RISK, REPRODUCED, THEN CLOSED
// ===========================================================================

describe('§1 a regenerated group that introduces a rival brand', () => {
  it('WITHOUT competitors (the old behaviour) the rival brand is NOT caught', async () => {
    vi.mocked(anthropicClient).mockReturnValue(rivalWritingLlm() as never);
    const res = await post({ snapshot, listing: base, group: 'backend' });
    expect(res.status).toBe(200);
    const audit = await auditOf(res);
    // the rival really is in the shipped copy...
    expect(audit.gateResult).toBeDefined();
    const c28 = audit.gateResult.failures.filter((f) => f.checkId === 'C28');
    // ...and C28's automatic leg said nothing, because the set was empty
    expect(c28.some((f) => f.context.toLowerCase().includes('novapeak'))).toBe(false);
    // the provider was never called either — no competitors, no ingestion
    expect(ingestByAsin).not.toHaveBeenCalled();
  });

  it('WITH competitors the SAME regeneration FAILS C28 and is not verified', async () => {
    vi.mocked(anthropicClient).mockReturnValue(rivalWritingLlm() as never);
    const res = await post({
      snapshot,
      listing: base,
      group: 'backend',
      competitorAsins: [RIVAL_ASIN],
    });
    expect(res.status).toBe(200);
    const audit = await auditOf(res);
    const c28 = audit.gateResult.failures.filter((f) => f.checkId === 'C28');
    expect(
      c28.map((f) => f.context).join(' | '),
      'the automatic rival-brand set must fire on the regenerated copy',
    ).toMatch(/novapeak/i);
    expect(audit.verified).toBe(false);
  });

  it('...and the run is PERSISTED unverified, so the stored verdict is the strict one', async () => {
    vi.mocked(anthropicClient).mockReturnValue(rivalWritingLlm() as never);
    const res = await post({
      snapshot,
      listing: base,
      group: 'backend',
      runId: 'run-n4',
      competitorAsins: [RIVAL_ASIN],
    });
    expect(res.status).toBe(200);
    expect(updateRun).toHaveBeenCalledWith(
      'run-n4',
      expect.objectContaining({ verified: false }),
    );
  });

  it('the ingestion really happened, through the real shared ingester', async () => {
    await post({ snapshot, listing: base, group: 'backend', competitorAsins: [RIVAL_ASIN] });
    expect(ingestByAsin).toHaveBeenCalledWith(RIVAL_ASIN);
  });
});

// ===========================================================================
// §2 — THE OTHER DIRECTION: it must not block a clean regeneration
// ===========================================================================

describe('§2 clean copy is unaffected — this cannot become an over-blocker', () => {
  it('a clean regeneration WITH competitors is still verified', async () => {
    const res = await post({
      snapshot,
      listing: base,
      group: 'backend',
      competitorAsins: [RIVAL_ASIN],
    });
    expect(res.status).toBe(200);
    const audit = await auditOf(res);
    expect(
      audit.gateResult.failures.map((f) => `${f.checkId} ${f.field}`),
      'supplying competitors must not fail lawful copy that never mentions them',
    ).toEqual([]);
    expect(audit.verified).toBe(true);
  });

  it('the benchmark is rebuilt too — a regeneration no longer DELETES it from the stored run', async () => {
    const withCompetitors = await auditOf(
      await post({ snapshot, listing: base, group: 'backend', competitorAsins: [RIVAL_ASIN] }),
    );
    expect(withCompetitors.benchmark).toBeDefined();
    expect(withCompetitors.benchmark!.requested).toBe(1);
    expect(withCompetitors.benchmark!.ingested).toBe(1);
  });

  it('an ASIN that FAILS to ingest never loses the run — it contributes no brand', async () => {
    const res = await post({
      snapshot,
      listing: base,
      group: 'backend',
      competitorAsins: ['B0MISSING1'],
    });
    expect(res.status).toBe(200);
    const audit = await auditOf(res);
    expect(audit.verified).toBe(true);
    expect(audit.benchmark!.ingested).toBe(0);
    expect(audit.benchmark!.requested).toBe(1);
  });

  it('the OWN brand is still subtracted — an operator pasting their own ASIN cannot make the run unwinnable', async () => {
    vi.mocked(ingestByAsin).mockImplementation(async () => ({
      ...JSON.parse(JSON.stringify(snapshot)),
      asin: 'B0SELF0001',
    }) as ListingSnapshot);
    const res = await post({
      snapshot,
      listing: base,
      group: 'backend',
      competitorAsins: ['B0SELF0001'],
    });
    const audit = await auditOf(res);
    expect(audit.gateResult.failures).toEqual([]);
    expect(audit.verified).toBe(true);
  });
});

// ===========================================================================
// §3 — ABSENCE IS STILL ABSENCE
// ===========================================================================

describe('§3 an operator who supplied no competitors is unaffected', () => {
  it('no key at all: no ingestion, no benchmark, byte-identical behaviour', async () => {
    const audit = await auditOf(await post({ snapshot, listing: base, group: 'backend' }));
    expect(ingestByAsin).not.toHaveBeenCalled();
    expect('benchmark' in audit).toBe(false);
    expect(audit.verified).toBe(true);
  });

  it('an EMPTY array is the same as absence — emptiness is not a request', async () => {
    const audit = await auditOf(
      await post({ snapshot, listing: base, group: 'backend', competitorAsins: [] }),
    );
    expect(ingestByAsin).not.toHaveBeenCalled();
    expect('benchmark' in audit).toBe(false);
  });

  it('junk entries are dropped rather than ingested', async () => {
    await post({
      snapshot,
      listing: base,
      group: 'backend',
      competitorAsins: ['not-an-asin', '', '   '],
    });
    expect(ingestByAsin).not.toHaveBeenCalled();
  });

  it('the client sends NO key when the operator left the field empty', () => {
    expect(regenerateOperatorInputs(EMPTY_OPERATOR_INPUTS)).toEqual({});
    expect(
      'competitorAsins' in regenerateOperatorInputs(EMPTY_OPERATOR_INPUTS),
    ).toBe(false);
  });

  it('...and DOES send it when the operator filled it in', () => {
    const body = regenerateOperatorInputs({
      ...EMPTY_OPERATOR_INPUTS,
      competitorAsins: `${RIVAL_ASIN}\nB0RIVAL002`,
    });
    expect(body.competitorAsins).toEqual([RIVAL_ASIN, 'B0RIVAL002']);
  });
});
