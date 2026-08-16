import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { POST } from '@/app/api/optimize/route';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { GateResult, OptimizedListing } from '@/lib/types';
import { rainforestSample } from './fixtures/rainforest.sample';

const snapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);
const pack = loadPack('supplements');

const mockListing: OptimizedListing = {
  title: snapshot.title,
  title75: 'BrandX Probiotic Supplement 50 Billion CFU',
  itemHighlights: 'vegan gluten free',
  bullets: snapshot.bullets,
  bulletAnchors: [],
  description: snapshot.description,
  backendSearchTerms: 'probiotico flora',
  attributes: {},
  facts: { potency: '50 Billion CFU' },
  fdaDisclaimer: pack.compliancePack!.disclaimer,
  aplusContent: {
    fdaDisclaimer: pack.compliancePack!.disclaimer,
    modules: [],
    comparison: { rows: [] },
    faq: [],
  },
  imagePlan: [],
  qa: [],
  primaryKeyword: 'probiotic supplement',
  productName: 'BrandX Probiotic',
  state: 'draft',
};

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

vi.mock('@/lib/engine/repair', () => ({
  runRepairLoop: vi.fn(),
}));

vi.mock('@/lib/audit/buildAudit', () => ({
  buildAudit: vi.fn(() => ({
    verified: true,
    scorecard: { total: 72, perPrinciple: [] },
    gaps: [{ field: 'backendSearchTerms', current: 'unknown', proposed: 'synonyms', why: 'test', severity: 'P1' }],
    gateResult: { pass: true, failures: [] },
  })),
}));

vi.mock('@/lib/env', () => ({
  env: {
    maxRepairIterations: vi.fn(() => 3),
    supabaseUrl: vi.fn(() => ''),
    supabaseServiceRoleKey: vi.fn(() => ''),
  },
}));

vi.mock('@/lib/store/runs', () => ({
  saveRun: vi.fn(async () => 'run-saved-id'),
}));

vi.mock('@/lib/server/log', () => ({
  logServer: vi.fn(),
}));

/**
 * Only the TRANSPORT is mocked. `recordUpstreamFailures`, `describeError` and
 * `upstreamFailureSummary` stay real, so what these tests exercise is the
 * production code path from a thrown SDK error to the response body.
 */
vi.mock('@/lib/engine/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/engine/llm')>()),
  anthropicClient: vi.fn(() => async () => '{}'),
}));

import { anthropicClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { saveRun } from '@/lib/store/runs';
import { logServer } from '@/lib/server/log';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/optimize', () => {
  beforeEach(() => {
    vi.mocked(runRepairLoop).mockResolvedValue({
      listing: mockListing,
      gateResult: { pass: true, failures: [] } as GateResult,
      iterations: 1,
      // A converged run has no routing gaps; the key is required on the
      // outcome so a caller cannot forget the loop reports them.
      unroutable: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns optimized listing, audit, detection, and runId for a valid snapshot', async () => {
    const res = await post({ snapshot });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.optimized.title).toBe(snapshot.title);
    expect(data.detection.packId).toBe('supplements');
    expect(data.audit.verified).toBe(true);
    expect(data.iterations).toBe(1);
    expect(data.runId).toBe('run-saved-id');
    expect(runRepairLoop).toHaveBeenCalledOnce();
    expect(saveRun).toHaveBeenCalledOnce();
  });

  it('still returns 200 with null runId when saveRun throws', async () => {
    vi.mocked(saveRun).mockRejectedValueOnce(new Error('db down'));
    const res = await post({ snapshot });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.optimized.title).toBe(snapshot.title);
    expect(data.runId).toBeNull();
    expect(logServer).toHaveBeenCalledWith(
      'store.error',
      expect.objectContaining({ op: 'saveRun' }),
    );
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when snapshot is missing', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toContain('Missing snapshot');
  });

  it('returns 502 when the engine throws', async () => {
    vi.mocked(runRepairLoop).mockRejectedValue(new Error('LLM down'));
    const res = await post({ snapshot });
    expect(res.status).toBe(502);
    const e = await res.json();
    expect(e.code).toBe('ENGINE_ERROR');
    expect(e.message).toContain('LLM down');
  });

  /**
   * A fully degraded run answers 200 with a `verified:false` report, so the
   * operator's only signal used to be a wall of `GEN` gate failures with no
   * statement of the cause. `generationFailure` is that statement. It is
   * OBSERVABILITY ONLY: the wrapper rethrows, so nothing about the degrade
   * path or `verified` depends on it.
   */
  describe('generationFailure — the operator is told WHY a degraded run degraded', () => {
    /**
     * The transport throws, and the loop SWALLOWS it — which is exactly what
     * `optimize()`'s `run()` does when it degrades a group. The run therefore
     * completes with a 200, which is the situation that used to leave the
     * operator with no statement of the cause.
     */
    const loopThatCalls = (toThrow: unknown) => {
      vi.mocked(anthropicClient).mockReturnValue(async () => {
        throw toThrow;
      });
      vi.mocked(runRepairLoop).mockImplementation(async (_snapshot, _pack, llm) => {
        try {
          await llm({ system: 's', user: 'u', maxTokens: 10, groupName: 'title' });
        } catch {
          // degrade, never lose the run
        }
        return {
          listing: mockListing,
          gateResult: { pass: true, failures: [] } as GateResult,
          iterations: 1,
          unroutable: [],
        };
      });
    };

    it('is ABSENT when every upstream call succeeded', async () => {
      const res = await post({ snapshot });
      const data = await res.json();
      expect('generationFailure' in data).toBe(false);
    });

    it('names the status, the API error type and the request id for a 401', async () => {
      loopThatCalls(
        APIError.generate(
          401,
          { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
          undefined,
          new Headers({ 'request-id': 'req_route_401' }),
        ),
      );
      const res = await post({ snapshot });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.generationFailure).toEqual({
        class: 'APIError',
        status: 401,
        apiType: 'authentication_error',
        requestId: 'req_route_401',
        summary:
          'Generation failed: the upstream model API rejected the request (status 401, authentication_error).',
      });
      // and the run itself is unchanged — this field decides nothing
      expect(data.audit.verified).toBe(true);
      expect(data.optimized.title).toBe(snapshot.title);
    });

    it('carries no message field, so an SDK message can never travel to a browser', async () => {
      loopThatCalls(new Error(`connect failed: sk-${'ant'}-api03-${'A'.repeat(40)}`));
      const res = await post({ snapshot });
      const data = await res.json();
      expect(JSON.stringify(data.generationFailure)).not.toContain('sk-');
      expect(data.generationFailure).not.toHaveProperty('message');
      expect(data.generationFailure.summary).toContain('could not be reached');
    });
  });
});
