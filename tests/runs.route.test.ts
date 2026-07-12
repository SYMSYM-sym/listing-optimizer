import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_LIST } from '@/app/api/runs/route';
import { GET as GET_ONE } from '@/app/api/runs/[id]/route';
import { checkAccess } from '@/lib/server/guard';
import { getRun, listRuns } from '@/lib/store/runs';
import type { RunListItem, RunRecord } from '@/lib/store/runs';

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

vi.mock('@/lib/store/runs', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

describe('GET /api/runs', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the access guard', async () => {
    vi.mocked(checkAccess).mockReturnValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) as never,
    );
    const res = await GET_LIST(new Request('http://localhost/api/runs'));
    expect(res.status).toBe(401);
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('returns list items without jsonb payloads', async () => {
    const items: RunListItem[] = [
      {
        id: 'r1',
        created_at: '2026-07-10T12:00:00Z',
        asin: 'B00EEEITVA',
        product_name: 'Sample',
        verified: true,
        score: 88,
        gaps: 2,
        failure_ids: [],
      },
    ];
    vi.mocked(listRuns).mockResolvedValue(items);
    const res = await GET_LIST(new Request('http://localhost/api/runs?limit=10&offset=0&asin=B00'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runs).toEqual(items);
    expect(listRuns).toHaveBeenCalledWith({ limit: 10, offset: 0, asin: 'B00' });
    expect(data.runs[0].snapshot).toBeUndefined();
    expect(data.runs[0].optimized).toBeUndefined();
  });
});

describe('GET /api/runs/[id]', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the access guard', async () => {
    vi.mocked(checkAccess).mockReturnValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) as never,
    );
    const res = await GET_ONE(new Request('http://localhost/api/runs/abc'), {
      params: Promise.resolve({ id: 'abc' }),
    });
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it('returns 404 when missing', async () => {
    vi.mocked(getRun).mockResolvedValue(null);
    const res = await GET_ONE(new Request('http://localhost/api/runs/missing'), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
    const e = await res.json();
    expect(e.code).toBe('NOT_FOUND');
  });

  it('returns the full run row', async () => {
    const run = {
      id: 'r1',
      created_at: '2026-07-10T12:00:00Z',
      asin: 'B00EEEITVA',
      url: 'https://www.amazon.com/dp/B00EEEITVA',
      product_name: 'Sample',
      pack_id: 'supplements',
      verified: true,
      score: 88,
      gaps: 2,
      failure_ids: [],
      snapshot: { asin: 'B00EEEITVA', title: 'T' },
      optimized: { title: 'T', productName: 'Sample' },
      audit: { verified: true, scorecard: { total: 88 }, gaps: [], gateResult: { pass: true, failures: [] } },
    } as unknown as RunRecord;
    vi.mocked(getRun).mockResolvedValue(run);
    const res = await GET_ONE(new Request('http://localhost/api/runs/r1'), {
      params: Promise.resolve({ id: 'r1' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run.id).toBe('r1');
    expect(data.run.optimized).toBeDefined();
    expect(data.run.audit).toBeDefined();
    expect(data.run.snapshot).toBeDefined();
  });
});
