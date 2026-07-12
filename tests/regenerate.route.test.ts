import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/regenerate/route';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { optimize } from '@/lib/engine/optimize';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import type { OptimizedListing } from '@/lib/types';

const snapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);
const pack = loadPack('supplements');

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return {
    ...actual,
    anthropicClient: vi.fn(),
  };
});

vi.mock('@/lib/store/runs', () => ({
  updateRun: vi.fn(),
}));

// Use the real optimize with mockLlm by stubbing anthropicClient to return mockLlm
import { anthropicClient } from '@/lib/engine/llm';
import { updateRun } from '@/lib/store/runs';
import { checkAccess } from '@/lib/server/guard';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/regenerate', () => {
  let base: OptimizedListing;

  beforeEach(async () => {
    vi.mocked(anthropicClient).mockReturnValue(mockLlm as never);
    base = await optimize(snapshot, pack, mockLlm);
    // Mutate one group so we can prove regenerate only touches that group
    base = {
      ...base,
      backendSearchTerms: 'KEEP_THIS_BACKEND_MARKER_XYZ',
      title75: 'OLD_TITLE75_SHOULD_CHANGE',
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the access guard', async () => {
    vi.mocked(checkAccess).mockReturnValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) as never,
    );
    const res = await post({ snapshot, listing: base, group: 'title' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid group', async () => {
    const res = await post({ snapshot, listing: base, group: 'not-a-group' });
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
  });

  it('regenerates only the requested group over the base and re-audits', async () => {
    const res = await post({ snapshot, listing: base, group: 'title' });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Backend (other group) preserved from base
    expect(data.optimized.backendSearchTerms).toBe('KEEP_THIS_BACKEND_MARKER_XYZ');
    // Title group refreshed from mock LLM (not the OLD marker)
    expect(data.optimized.title75).not.toBe('OLD_TITLE75_SHOULD_CHANGE');
    expect(data.optimized.title75.length).toBeGreaterThan(0);
    // Audit always re-run
    expect(data.audit).toBeDefined();
    expect(typeof data.audit.verified).toBe('boolean');
    expect(data.audit.verified).toBe(data.audit.gateResult.pass);
    expect(data.group).toBe('title');
    expect(data.detection.packId).toBe('supplements');
  });

  it('persists via updateRun when runId is supplied', async () => {
    const res = await post({
      snapshot,
      listing: base,
      group: 'description',
      runId: 'run-123',
    });
    expect(res.status).toBe(200);
    expect(updateRun).toHaveBeenCalledWith(
      'run-123',
      expect.objectContaining({
        optimized: expect.any(Object),
        audit: expect.any(Object),
        verified: expect.any(Boolean),
        score: expect.any(Number),
      }),
    );
  });
});
