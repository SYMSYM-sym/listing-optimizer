import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
