import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/runs/[id]/ship-sheet/route';
import { getRun, type RunRecord } from '@/lib/store/runs';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import type { GateContext } from '@/lib/gate/checks';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

vi.mock('@/lib/store/runs', () => ({ getRun: vi.fn() }));

/**
 * GET /api/runs/[id]/ship-sheet.
 *
 * The sheet contains the ENTIRE generated listing, so the route rides the same
 * MANDATORY-token guard the other history routes use. The tests below use the
 * REAL guard (not a mocked one) so a regression that removes it — or that
 * swaps `requireAccess` for the optional-token `checkAccess` — is caught here
 * rather than in production.
 */

const TOKEN = 'ship-sheet-token';
const original = process.env.APP_ACCESS_TOKEN;

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

async function record(): Promise<RunRecord> {
  const optimized = await optimize(snapshot, pack, mockLlm);
  const audit = buildAudit(snapshot, optimized, pack, ctx);
  return {
    id: 'r1',
    created_at: '2026-08-14T12:00:00Z',
    asin: 'B0TESTASIN',
    url: 'https://example.test/dp/B0TESTASIN',
    product_name: optimized.productName,
    pack_id: 'supplements',
    verified: audit.verified,
    score: audit.scorecard.total,
    gaps: audit.gaps.length,
    failure_ids: [],
    snapshot,
    optimized,
    audit,
  };
}

const req = (token?: string) =>
  new Request('http://localhost/api/runs/r1/ship-sheet', {
    headers: token ? { 'x-app-token': token } : undefined,
  });
const params = { params: Promise.resolve({ id: 'r1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_ACCESS_TOKEN = TOKEN;
});
afterEach(() => {
  if (original === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = original;
});

describe('the guard is enforced', () => {
  it('401 without a token, and the store is never touched', async () => {
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
    expect(getRun).not.toHaveBeenCalled();
  });

  it('401 with the WRONG token', async () => {
    const res = await GET(req('nope'), params);
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });

  it('401 (fail CLOSED) when no token is configured at all', async () => {
    delete process.env.APP_ACCESS_TOKEN;
    const res = await GET(req(), params);
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
  });
});

describe('serving the sheet', () => {
  it('200 text/html; charset=utf-8, no-store, and a real ship sheet body', async () => {
    vi.mocked(getRun).mockResolvedValue(await record());
    const res = await GET(req(TOKEN), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('Ship Sheet');
    expect(body).toContain('8 · Verified counts');
    expect(body).toContain('B0TESTASIN');
    expect(getRun).toHaveBeenCalledWith('r1');
  });

  it('is REGENERATED from the stored run — a changed run yields a changed sheet', async () => {
    const run = await record();
    vi.mocked(getRun).mockResolvedValue(run);
    const first = await (await GET(req(TOKEN), params)).text();
    const edited: RunRecord = {
      ...run,
      optimized: { ...run.optimized, title75: 'Totally Different Published Title' },
    };
    vi.mocked(getRun).mockResolvedValue(edited);
    const second = await (await GET(req(TOKEN), params)).text();
    expect(second).toContain('Totally Different Published Title');
    expect(second).not.toBe(first);
  });
});

describe('unknown / blank ids', () => {
  it('404 with a JSON body when the run does not exist', async () => {
    vi.mocked(getRun).mockResolvedValue(null);
    const res = await GET(req(TOKEN), params);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('400 on a blank id, without calling the store', async () => {
    const res = await GET(req(TOKEN), { params: Promise.resolve({ id: '' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(getRun).not.toHaveBeenCalled();
  });

  it('502 when the store itself fails (never a silent empty sheet)', async () => {
    vi.mocked(getRun).mockRejectedValue(new Error('supabase down'));
    const res = await GET(req(TOKEN), params);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('STORE_ERROR');
  });
});
