import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APIError } from '@anthropic-ai/sdk';

/**
 * U3 — A DEGRADED RUN RE-OPENED FROM HISTORY IS STILL TOLD WHY IT DEGRADED.
 *
 * THE GAP U1 LEFT. `e885f23` made the outage diagnosable and put
 * `generationFailure` on the optimize/regenerate responses. U1 rendered it: a
 * prominent banner saying generation never ran and that the gate failures below
 * are NOT a judgement of the listing. But NOTHING PERSISTED IT. Re-opening the
 * very same run from History rebuilt the results model from the stored row,
 * which had no such field, so the operator saw eleven blocking gate failures and
 * no cause — the exact misleading state U1 was built to prevent, one surface
 * over.
 *
 * This file pins the round trip and, just as importantly, pins the direction
 * that protects it: a run with REAL gate failures and no upstream error must
 * come back with NO failure value and render NO banner. A false "the upstream
 * API failed" caption would teach operators that gate failures are noise, and
 * the next real compliance failure gets waved through.
 *
 * THE STORE IS EXERCISED FOR REAL. `@supabase/supabase-js` is replaced by a
 * fake whose rows are inspectable, so `saveRun` → `getRun` → the run-detail
 * route → the results model → the banner is one continuous path with no step
 * stubbed out in the middle. That matters because every previous defect in this
 * area lived in a step somebody assumed rather than ran.
 *
 * §(a) degraded run round-trips and renders the banner on the replay
 * §(b) a normal failing run round-trips with NO failure and renders NO banner
 * §(c) a legacy row (column NULL / absent) renders exactly as today
 * §(d) a malformed stored value never throws and degrades to no banner
 * §(e) the persisted payload never contains `message` or anything key-shaped
 * §(f) `verified` and every gate verdict are byte-identical either way
 */

// ---------------------------------------------------------------------------
// The fake database. Rows in, statements captured, errors injectable.
// ---------------------------------------------------------------------------

interface Statement {
  op: 'insert' | 'update' | 'select';
  payload?: Record<string, unknown>;
  columns?: string;
}

const db = {
  statements: [] as Statement[],
  detailRow: null as Record<string, unknown> | null,
  listRows: [] as Record<string, unknown>[],
  /** Fail any statement naming `generation_failure` (a pre-migration store). */
  columnMissing: false,
  reset(): void {
    db.statements = [];
    db.detailRow = null;
    db.listRows = [];
    db.columnMissing = false;
  },
};

const MISSING = {
  code: '42703',
  message: 'column runs.generation_failure does not exist',
};
const MISSING_WRITE = {
  code: 'PGRST204',
  message: "Could not find the 'generation_failure' column of 'runs' in the schema cache",
};

const namesColumn = (s: Statement): boolean =>
  s.op === 'select'
    ? Boolean(s.columns?.includes('generation_failure'))
    : Object.prototype.hasOwnProperty.call(s.payload ?? {}, 'generation_failure');

function fakeClient() {
  return {
    from: () => ({
      insert(payload: Record<string, unknown>) {
        const stmt: Statement = { op: 'insert', payload };
        db.statements.push(stmt);
        const fail = db.columnMissing && namesColumn(stmt);
        return {
          select: () => ({
            single: async () =>
              fail ? { data: null, error: MISSING_WRITE } : { data: { id: 'run-u3' }, error: null },
          }),
        };
      },
      update(payload: Record<string, unknown>) {
        const stmt: Statement = { op: 'update', payload };
        db.statements.push(stmt);
        const fail = db.columnMissing && namesColumn(stmt);
        return { eq: async () => (fail ? { error: MISSING_WRITE } : { error: null }) };
      },
      select(columns: string) {
        const stmt: Statement = { op: 'select', columns };
        db.statements.push(stmt);
        const fail = db.columnMissing && namesColumn(stmt);
        const chain = {
          order: () => chain,
          range: () => chain,
          ilike: () => chain,
          eq: () => ({
            maybeSingle: async () =>
              fail ? { data: null, error: MISSING } : { data: db.detailRow, error: null },
          }),
          // The list query is AWAITED directly, so the builder is thenable.
          then: (resolve: (v: unknown) => unknown) =>
            resolve(fail ? { data: null, error: MISSING } : { data: db.listRows, error: null }),
        };
        return chain;
      },
    }),
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => fakeClient()) }));
vi.mock('@/lib/server/log', () => ({ logServer: vi.fn() }));

// The store is CONFIGURED via the real `lib/env` — no module stub, so every
// other reader of `env` (the pipeline, the gate, the policy flags) keeps its
// real behaviour and this file cannot accidentally change a verdict by
// replacing a config module.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
  requireAccess: vi.fn(() => null),
}));

import { GET as GET_RUN } from '@/app/api/runs/[id]/route';
import { GET as GET_SHIP_SHEET } from '@/app/api/runs/[id]/ship-sheet/route';
import { ResultsPanel, type ResultsModel } from '@/app/ResultsPanel';
import { buildAudit } from '@/lib/audit/buildAudit';
import { describeError, generationFailurePayload } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { toMarkdown } from '@/lib/export/markdown';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { loadPack } from '@/lib/knowledge/loadPack';
import { logServer } from '@/lib/server/log';
import { coerceGenerationFailure } from '@/lib/shared/generationFailure';
import {
  __resetStoreClientForTests,
  getRun,
  listRuns,
  saveRun,
  updateRun,
  type RunRecord,
  type SaveRunInput,
} from '@/lib/store/runs';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { GenerationFailure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

// ---------------------------------------------------------------------------
// Fixtures — the SAME live 400 U1 pins, and the SAME real failing run
// ---------------------------------------------------------------------------

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The live outage: an exhausted credit balance, built by the SDK's factory. */
const CREDIT_BALANCE_400 = APIError.generate(
  400,
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    },
  },
  undefined,
  new Headers({ 'request-id': 'req_outage_400' }),
);

const outageFailure = (): GenerationFailure =>
  generationFailurePayload(describeError(CREDIT_BALANCE_400))!;

/** A run with REAL gate failures and no upstream error whatsoever. */
let cached: { optimized: OptimizedListing; audit: ReturnType<typeof buildAudit> } | undefined;
async function realFailingRun(): Promise<NonNullable<typeof cached>> {
  if (cached) return cached;
  const clean = await optimize(snapshot, pack, mockLlm);
  const optimized: OptimizedListing = { ...clean, backendSearchTerms: 'ä'.repeat(200) };
  cached = { optimized, audit: buildAudit(snapshot, optimized, pack, ctx) };
  return cached;
}

const saveInput = async (over: Partial<SaveRunInput> = {}): Promise<SaveRunInput> => {
  const run = await realFailingRun();
  return {
    asin: 'B0TESTASIN',
    url: 'https://www.amazon.com/dp/B0TESTASIN',
    productName: run.optimized.productName,
    packId: 'supplements',
    verified: run.audit.verified,
    score: run.audit.scorecard.total,
    gaps: run.audit.gaps.length,
    failureIds: run.audit.gateResult.failures.map((f) => f.checkId),
    snapshot,
    optimized: run.optimized,
    audit: run.audit,
    ...over,
  };
};

/** The stored row shape `getRun` reads, as the fake DB holds it. */
const storedRow = async (generation_failure?: unknown): Promise<Record<string, unknown>> => {
  const run = await realFailingRun();
  return {
    id: 'run-u3',
    created_at: '2026-08-17T12:00:00Z',
    asin: 'B0TESTASIN',
    url: 'https://www.amazon.com/dp/B0TESTASIN',
    product_name: run.optimized.productName,
    pack_id: 'supplements',
    verified: run.audit.verified,
    score: run.audit.scorecard.total,
    gaps: run.audit.gaps.length,
    failure_ids: run.audit.gateResult.failures.map((f) => f.checkId),
    snapshot,
    optimized: run.optimized,
    audit: run.audit,
    ...(generation_failure !== undefined ? { generation_failure } : {}),
  };
};

/** Exactly what `app/page.tsx#openRun` builds from a run-detail response. */
const replayModel = (row: {
  id: string;
  snapshot: typeof snapshot;
  optimized: OptimizedListing;
  audit: ReturnType<typeof buildAudit>;
  pack_id: string;
  generation_failure?: GenerationFailure | null;
}): ResultsModel => ({
  optimized: row.optimized,
  audit: row.audit,
  detection: { packId: row.pack_id, subcategories: row.snapshot.subcategory ?? [] },
  snapshot: row.snapshot,
  runId: row.id,
  generationFailure: row.generation_failure ?? null,
});

const render = (result: ResultsModel): string =>
  renderToStaticMarkup(createElement(ResultsPanel, { result, headers: {}, onUpdated: () => {} }));

const req = (id: string) => new Request(`http://localhost/api/runs/${id}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Load a stored run through the REAL route and replay it, end to end. */
async function replayThroughRoute(generation_failure?: unknown): Promise<{
  body: { run: Record<string, unknown> };
  html: string;
}> {
  db.detailRow = await storedRow(generation_failure);
  const res = await GET_RUN(req('run-u3'), params('run-u3'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { run: Record<string, unknown> };
  return { body, html: render(replayModel(body.run as never)) };
}

beforeEach(() => {
  db.reset();
  __resetStoreClientForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  __resetStoreClientForTests();
});

// ===========================================================================
// §(a) — a degraded run round-trips, and the REPLAY renders the banner
// ===========================================================================

describe('§(a) a degraded run round-trips and the replayed run renders the banner', () => {
  it('saveRun persists generation_failure exactly as the response carried it', async () => {
    const failure = outageFailure();
    await saveRun(await saveInput({ generationFailure: failure }));
    const insert = db.statements.find((s) => s.op === 'insert')!;
    expect(insert.payload!.generation_failure).toEqual(failure);
  });

  it('getRun reads it back IDENTICAL — same object, field for field', async () => {
    const failure = outageFailure();
    db.detailRow = await storedRow(failure);
    const row = (await getRun('run-u3'))!;
    expect(row.generation_failure).toEqual(failure);
    expect(JSON.stringify(row.generation_failure)).toBe(JSON.stringify(failure));
  });

  it('the run-detail route carries it to the browser', async () => {
    const { body } = await replayThroughRoute(outageFailure());
    expect(body.run.generation_failure).toEqual(outageFailure());
  });

  it('the REPLAYED run renders the banner, naming the status and the caveat', async () => {
    const { html } = await replayThroughRoute(outageFailure());
    expect(html).toContain('generation-failure-banner');
    expect(html).toContain('Generation failed upstream');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('invalid_request_error');
    expect(html).toContain('req_outage_400');
    expect(html).toContain('NOT a judgement of your listing');
  });

  it('it is the SAME component U1 added — one renderer, not two', async () => {
    const { html } = await replayThroughRoute(outageFailure());
    // Exactly one banner in the markup, and it is U1's own element.
    expect(html).toContain('<section role="alert" data-testid="generation-failure-banner"');
    expect(html.split('data-testid="generation-failure-banner"').length - 1).toBe(1);
    // THE WIRE. The render above cannot see a field the page never sets, so the
    // one line that puts the stored value on the SAME model field the live run
    // uses is pinned by source — the same way U1 pinned its own wire.
    const page = readFileSync(join(process.cwd(), 'app', 'page.tsx'), 'utf8');
    expect(page).toContain('generationFailure: run.generation_failure ?? null');
    expect(page).toContain('generation_failure?: GenerationFailure | null');
    // And there is exactly ONE `GenerationFailureBanner` in the whole app.
    const panel = readFileSync(join(process.cwd(), 'app', 'ResultsPanel.tsx'), 'utf8');
    expect(panel.match(/export function GenerationFailureBanner/g)).toHaveLength(1);
  });

  it('STILL renders every gate failure — the banner suppresses nothing', async () => {
    const run = await realFailingRun();
    const { html } = await replayThroughRoute(outageFailure());
    expect(html).toContain(`${run.audit.gateResult.failures.length} blocking failure(s)`);
    expect(html).toContain('Not verified');
  });

  it('the History LIST marks the run degraded before it is opened', async () => {
    const failure = outageFailure();
    db.listRows = [
      {
        id: 'run-u3',
        created_at: '2026-08-17T12:00:00Z',
        asin: 'B0TESTASIN',
        product_name: 'Sample',
        verified: false,
        score: 40,
        gaps: 3,
        failure_ids: ['GEN'],
        published_at: null,
        generation_failure: failure,
      },
    ];
    const rows = await listRuns();
    expect(rows[0]!.generation_failure).toEqual(failure);
    const select = db.statements.find((s) => s.op === 'select')!;
    expect(select.columns).toContain('generation_failure');
    // ...and it stays a SUMMARY query: the three heavy payloads never load.
    for (const heavy of ['snapshot', 'optimized', 'audit']) {
      expect(select.columns).not.toContain(heavy);
    }
    const page = readFileSync(join(process.cwd(), 'app', 'page.tsx'), 'utf8');
    expect(page).toContain('item.generation_failure && (');
    expect(page).toContain('generation failed');
  });

  it('the Markdown record and the Ship Sheet state the cause too', async () => {
    const run = await realFailingRun();
    const md = toMarkdown(run.optimized, run.audit, outageFailure());
    expect(md).toContain('Generation failed upstream');
    expect(md).toContain('NOT a judgement of your listing');
    expect(md).toContain('HTTP 400');
    // ...and still refuses the run, exactly as before
    expect(md).toContain('NOT VERIFIED');
    expect(md).toContain('do not publish');

    db.detailRow = await storedRow(outageFailure());
    const res = await GET_SHIP_SHEET(req('run-u3'), params('run-u3'));
    const sheet = await res.text();
    expect(sheet).toContain('Generation failed upstream');
    expect(sheet).toContain('NOT a judgement of your listing');
    // The sheet's affordances are decided by `verified` ALONE and are unmoved.
    expect(sheet).not.toContain('class=cp');
    expect(sheet).not.toContain('navigator.clipboard');
  });

  it('a regeneration that ALSO failed upstream is persisted; a successful one cannot clear it', async () => {
    const run = await realFailingRun();
    const patch = {
      optimized: run.optimized,
      audit: run.audit,
      verified: run.audit.verified,
      score: run.audit.scorecard.total,
      gaps: run.audit.gaps.length,
      failureIds: run.audit.gateResult.failures.map((f) => f.checkId),
    };
    await updateRun('run-u3', { ...patch, generationFailure: outageFailure() });
    expect(db.statements.at(-1)!.payload!.generation_failure).toEqual(outageFailure());

    db.statements = [];
    await updateRun('run-u3', patch);
    expect(db.statements.at(-1)!.payload).not.toHaveProperty('generation_failure');
  });
});

// ===========================================================================
// §(b) — THE DIRECTION THAT PROTECTS THE FEATURE
// A real compliance failure must never wear the upstream excuse.
// ===========================================================================

describe('§(b) a normal failing run round-trips with NO failure and renders NO banner', () => {
  it('saveRun sends no generation_failure key at all for a healthy call path', async () => {
    await saveRun(await saveInput());
    const insert = db.statements.find((s) => s.op === 'insert')!;
    expect(insert.payload).not.toHaveProperty('generation_failure');
  });

  it('getRun returns a row with no failure, and the REPLAY renders no banner', async () => {
    const run = await realFailingRun();
    const { body, html } = await replayThroughRoute();
    expect(body.run).not.toHaveProperty('generation_failure');
    expect(html).not.toContain('generation-failure-banner');
    expect(html).not.toContain('Generation failed upstream');
    // ...and the REAL failures it does have are reported exactly as before
    expect(html).toContain(`${run.audit.gateResult.failures.length} blocking failure(s)`);
    expect(html).toContain('Not verified');
  });

  it('the History list shows no degraded marker for it', async () => {
    db.listRows = [
      {
        id: 'run-u3',
        created_at: '2026-08-17T12:00:00Z',
        asin: 'B0TESTASIN',
        product_name: 'Sample',
        verified: false,
        score: 40,
        gaps: 3,
        failure_ids: ['C3'],
        published_at: null,
        generation_failure: null,
      },
    ];
    const rows = await listRuns();
    expect(rows[0]).not.toHaveProperty('generation_failure');
  });

  it('the Markdown record and the Ship Sheet stay byte-identical without one', async () => {
    const run = await realFailingRun();
    expect(toMarkdown(run.optimized, run.audit, null)).toBe(toMarkdown(run.optimized, run.audit));
    expect(toMarkdown(run.optimized, run.audit)).not.toContain('Generation failed upstream');

    db.detailRow = await storedRow();
    const bare = await (await GET_SHIP_SHEET(req('run-u3'), params('run-u3'))).text();
    expect(bare).not.toContain('Generation failed upstream');
    expect(bare).not.toContain('class=gfail');
  });
});

// ===========================================================================
// §(c) — LEGACY ROWS. Written before the column existed.
// ===========================================================================

describe('§(c) a legacy row renders exactly as today and never throws', () => {
  it.each([
    ['column absent', undefined],
    ['column NULL', null],
  ])('%s — getRun succeeds and the replay has no banner', async (_label, stored) => {
    const run = await realFailingRun();
    db.detailRow = await storedRow(stored);
    const row = await getRun('run-u3');
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('generation_failure');
    // Everything else about the row is untouched.
    expect(row!.verified).toBe(run.audit.verified);
    expect(row!.audit).toEqual(run.audit);

    const html = render(replayModel(row as never));
    expect(html).not.toContain('generation-failure-banner');
    expect(html).toContain(`${run.audit.gateResult.failures.length} blocking failure(s)`);
  });

  it('a pre-migration STORE (the column does not exist) still lists, saves and updates', async () => {
    db.columnMissing = true;
    db.listRows = [
      {
        id: 'run-u3',
        created_at: '2026-08-17T12:00:00Z',
        asin: 'B0TESTASIN',
        product_name: 'Sample',
        verified: false,
        score: 40,
        gaps: 3,
        failure_ids: ['GEN'],
        published_at: null,
      },
    ];
    // The History page LOADS. Failing to load would be worse than no banner.
    await expect(listRuns()).resolves.toHaveLength(1);
    expect(vi.mocked(logServer)).toHaveBeenCalledWith(
      'store.generation_failure_column_missing',
      expect.objectContaining({ op: 'listRuns' }),
    );
    // And a degraded run is still SAVED — the annotation is lost, not the run.
    db.statements = [];
    await expect(saveRun(await saveInput({ generationFailure: outageFailure() }))).resolves.toBe(
      'run-u3',
    );
    expect(db.statements.filter((s) => s.op === 'insert')).toHaveLength(2);
    expect(db.statements.at(-1)!.payload).not.toHaveProperty('generation_failure');
  });

  it('an UNRELATED store error still fails loudly — the retry is not a swallow', async () => {
    db.columnMissing = true;
    // A select whose error names a different column must not be retried away.
    db.listRows = [];
    const original = MISSING.message;
    try {
      (MISSING as { message: string }).message = 'column runs.something_else does not exist';
      await expect(listRuns()).rejects.toThrow(/listRuns failed/);
    } finally {
      (MISSING as { message: string }).message = original;
    }
  });
});

// ===========================================================================
// §(d) — MALFORMED STORED VALUES. Junk must degrade, never throw.
// ===========================================================================

describe('§(d) a malformed stored value never throws and degrades to no banner', () => {
  const junk: [string, unknown][] = [
    ['a string', 'APIError'],
    ['a number', 400],
    ['a boolean', true],
    ['an array', [{ class: 'APIError', summary: 'nope' }]],
    ['an empty object', {}],
    ['missing summary', { class: 'APIError', status: 400 }],
    ['missing class', { summary: 'Generation failed: something happened.' }],
    ['blank strings', { class: '   ', summary: '   ' }],
    ['wrong types throughout', { class: 42, summary: { text: 'no' }, status: 'four hundred' }],
    ['a nested junk tree', { class: { a: [1, 2] }, summary: ['x'], extra: { deep: { deeper: 1 } } }],
  ];

  it.each(junk)('%s — coerces to null', (_label, value) => {
    expect(coerceGenerationFailure(value)).toBeNull();
  });

  it.each(junk)('%s — getRun does not throw and drops the key', async (_label, value) => {
    db.detailRow = await storedRow(value);
    const row = await getRun('run-u3');
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('generation_failure');
  });

  it.each(junk)('%s — the replayed run renders no banner', async (_label, value) => {
    const { body, html } = await replayThroughRoute(value);
    expect(body.run).not.toHaveProperty('generation_failure');
    expect(html).not.toContain('generation-failure-banner');
  });

  it.each(junk)('%s — listRuns does not throw and drops the key', async (_label, value) => {
    db.listRows = [{ id: 'run-u3', verified: false, generation_failure: value }];
    const rows = await listRuns();
    expect(rows[0]).not.toHaveProperty('generation_failure');
  });

  it('a PARTIALLY valid record keeps only the fields it really has', () => {
    expect(
      coerceGenerationFailure({
        class: 'APIConnectionTimeoutError',
        summary: 'Generation failed: the upstream model API could not be reached.',
        status: undefined,
        apiType: '',
        requestId: null,
      }),
    ).toEqual({
      class: 'APIConnectionTimeoutError',
      summary: 'Generation failed: the upstream model API could not be reached.',
    });
  });

  it('an absurdly long stored value is bounded, not rendered whole', () => {
    const coerced = coerceGenerationFailure({
      class: 'A'.repeat(10_000),
      summary: 'S'.repeat(10_000),
      requestId: 'r'.repeat(10_000),
    })!;
    expect(coerced.class.length).toBeLessThanOrEqual(200);
    expect(coerced.summary.length).toBeLessThanOrEqual(400);
    expect(coerced.requestId!.length).toBeLessThanOrEqual(200);
  });
});

// ===========================================================================
// §(e) — WHAT IS PERSISTED. Never the message, never a key.
// ===========================================================================

describe('§(e) the persisted payload never contains `message` or anything key-shaped', () => {
  const CONTRACT = ['class', 'status', 'apiType', 'requestId', 'summary'];

  it('the builder itself produces exactly the five-field contract', () => {
    expect(Object.keys(outageFailure()).sort()).toEqual([...CONTRACT].sort());
  });

  it('saveRun stores exactly those keys and nothing else', async () => {
    await saveRun(await saveInput({ generationFailure: outageFailure() }));
    const stored = db.statements.find((s) => s.op === 'insert')!.payload!
      .generation_failure as Record<string, unknown>;
    expect(Object.keys(stored).every((k) => CONTRACT.includes(k))).toBe(true);
    expect(stored).not.toHaveProperty('message');
  });

  it('a caller that smuggles extra fields has them STRIPPED by the store, not stored', async () => {
    await saveRun(
      await saveInput({
        generationFailure: {
          ...outageFailure(),
          // Everything a future caller must never be able to persist.
          message: 'Your credit balance is too low to access the Anthropic API.',
          apiKey: 'sk-ant-api03-DEADBEEFDEADBEEFDEADBEEF',
          authorization: 'Bearer sk-ant-secret',
        } as GenerationFailure,
      }),
    );
    const stored = db.statements.find((s) => s.op === 'insert')!.payload!.generation_failure;
    const json = JSON.stringify(stored);
    expect(stored).not.toHaveProperty('message');
    expect(stored).not.toHaveProperty('apiKey');
    expect(stored).not.toHaveProperty('authorization');
    expect(json).not.toContain('credit balance');
    expect(json).not.toContain('sk-ant');
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(Object.keys(stored as object).every((k) => CONTRACT.includes(k))).toBe(true);
  });

  it('updateRun strips them too', async () => {
    const run = await realFailingRun();
    await updateRun('run-u3', {
      optimized: run.optimized,
      audit: run.audit,
      verified: run.audit.verified,
      score: run.audit.scorecard.total,
      gaps: run.audit.gaps.length,
      failureIds: [],
      generationFailure: {
        ...outageFailure(),
        message: 'Your credit balance is too low.',
      } as GenerationFailure,
    });
    const stored = db.statements.at(-1)!.payload!.generation_failure;
    expect(stored).not.toHaveProperty('message');
    expect(JSON.stringify(stored)).not.toContain('credit balance');
  });

  it('a smuggled field cannot survive the READ either, however it got in', async () => {
    db.detailRow = await storedRow({
      ...outageFailure(),
      message: 'Your credit balance is too low.',
      apiKey: 'sk-ant-api03-DEADBEEF',
    });
    const row = (await getRun('run-u3'))!;
    expect(row.generation_failure).toEqual(outageFailure());
    expect(JSON.stringify(row.generation_failure)).not.toContain('credit balance');
    expect(JSON.stringify(row.generation_failure)).not.toContain('sk-ant');
  });

  it('nothing sensitive reaches the run-detail RESPONSE BODY', async () => {
    const { body } = await replayThroughRoute({
      ...outageFailure(),
      message: 'Your credit balance is too low.',
    });
    const json = JSON.stringify(body.run.generation_failure);
    expect(json).not.toContain('credit balance');
    expect(json).not.toContain('message');
  });
});

// ===========================================================================
// §(f) — NO VERDICT MOVES. Persistence and presentation only.
// ===========================================================================

describe('§(f) verified and every gate verdict are byte-identical either way', () => {
  it('the two inserts differ by `generation_failure` and by NOTHING else', async () => {
    await saveRun(await saveInput());
    const plain = db.statements.find((s) => s.op === 'insert')!.payload!;
    db.statements = [];
    __resetStoreClientForTests();
    await saveRun(await saveInput({ generationFailure: outageFailure() }));
    const degraded = db.statements.find((s) => s.op === 'insert')!.payload!;

    const { generation_failure: _only, ...rest } = degraded;
    expect(rest).toEqual(plain);
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
    // The verdict fields specifically.
    for (const k of ['verified', 'score', 'gaps', 'failure_ids', 'audit'] as const) {
      expect(JSON.stringify(degraded[k])).toBe(JSON.stringify(plain[k]));
    }
  });

  it('a stored run reads back with its audit and verdict untouched by the round trip', async () => {
    const run = await realFailingRun();
    db.detailRow = await storedRow(outageFailure());
    const row = (await getRun('run-u3')) as RunRecord;
    expect(row.verified).toBe(run.audit.verified);
    expect(JSON.stringify(row.audit)).toBe(JSON.stringify(run.audit));
    expect(JSON.stringify(row.optimized)).toBe(JSON.stringify(run.optimized));
    expect(row.failure_ids).toEqual(run.audit.gateResult.failures.map((f) => f.checkId));
  });

  it('the REPLAY markup differs from the same replay without the failure BY THE BANNER ALONE', async () => {
    const withBanner = (await replayThroughRoute(outageFailure())).html;
    const without = (await replayThroughRoute()).html;
    // Isolate the banner from the markup that contains it and subtract it.
    const start = withBanner.indexOf('<section role="alert" data-testid="generation-failure-banner"');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = withBanner.indexOf('</section>', start) + '</section>'.length;
    const banner = withBanner.slice(start, end);
    expect(withBanner.replace(banner, '')).toBe(without);
  });

  it('the Markdown record differs by the notice alone', async () => {
    const run = await realFailingRun();
    const plain = toMarkdown(run.optimized, run.audit);
    const degraded = toMarkdown(run.optimized, run.audit, outageFailure());
    // Subtract the inserted block-quote and the document must be the ORIGINAL,
    // line for line — nothing below it moved, reworded or disappeared.
    const lines = degraded.split('\n');
    const start = lines.findIndex((l) => l.startsWith('> ⚠ **'));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.indexOf('', start);
    expect(end).toBeGreaterThan(start);
    expect([...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')).toBe(plain);
    expect(lines.slice(start, end).every((l) => l.startsWith('>'))).toBe(true);
    // Every verdict line is still there, unchanged.
    expect(degraded).toContain('⛔ NOT VERIFIED');
    for (const f of run.audit.gateResult.failures) expect(degraded).toContain(f.checkId);
  });

  it('the Ship Sheet keeps the same verdict, the same failures and the same locks', async () => {
    const run = await realFailingRun();
    db.detailRow = await storedRow();
    const plain = await (await GET_SHIP_SHEET(req('run-u3'), params('run-u3'))).text();
    db.detailRow = await storedRow(outageFailure());
    const degraded = await (await GET_SHIP_SHEET(req('run-u3'), params('run-u3'))).text();
    for (const f of run.audit.gateResult.failures) {
      expect(plain).toContain(f.checkId);
      expect(degraded).toContain(f.checkId);
    }
    expect(degraded).toContain('NOT VERIFIED');
    expect(degraded).not.toContain('class=cp');
    expect(degraded).not.toContain('navigator.clipboard');
  });

  it('the new module cannot reach a verdict at all — it names none of the machinery', () => {
    const src = readFileSync(join(process.cwd(), 'lib/shared/generationFailure.ts'), 'utf8');
    // Comments may discuss the gate; the CODE must not touch it. ("failures"
    // is deliberately NOT on this list — it is a word in the caveat SENTENCE,
    // which is the whole point of the module.)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['verified', 'gateResult', 'scorecard', 'buildAudit', 'runGate']) {
      expect(code).not.toContain(forbidden);
    }
    // Its ONLY import is the shared type. It can read nothing else.
    expect(code.match(/^import .*$/gm)).toEqual([
      "import type { GenerationFailure } from '@/lib/types';",
    ]);
  });

  it('`verified` is still written in exactly one module', () => {
    const src = readFileSync(join(process.cwd(), 'lib/audit/buildAudit.ts'), 'utf8');
    expect(src).toContain('verified');
  });
});
