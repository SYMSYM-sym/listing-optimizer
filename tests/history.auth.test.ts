import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_LIST } from '@/app/api/runs/route';
import { GET as GET_ONE } from '@/app/api/runs/[id]/route';
import { checkAccess, requireAccess } from '@/lib/server/guard';
import { getRun, listRuns } from '@/lib/store/runs';

vi.mock('@/lib/store/runs', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
}));

/**
 * FIX F — the READ-ONLY history routes serve full stored snapshots and the
 * generated copy. They must FAIL CLOSED: with no APP_ACCESS_TOKEN configured
 * the shipped guard skipped the token check entirely and published every run.
 *
 * The action routes keep their previous behaviour so local development without
 * a token still works.
 */

const TOKEN = 'test-token-value';
const original = process.env.APP_ACCESS_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  if (original === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = original;
});

const listReq = (token?: string) =>
  new Request('http://localhost/api/runs', token ? { headers: { 'x-app-token': token } } : undefined);
const oneReq = (token?: string) =>
  new Request('http://localhost/api/runs/r1', token ? { headers: { 'x-app-token': token } } : undefined);
const params = { params: Promise.resolve({ id: 'r1' }) };

describe('FIX F — history routes fail CLOSED when no token is configured', () => {
  it('GET /api/runs returns 401 and never touches the store', async () => {
    delete process.env.APP_ACCESS_TOKEN;
    const res = await GET_LIST(listReq());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
    expect(listRuns).not.toHaveBeenCalled();
  });

  it('GET /api/runs/[id] returns 401 and never touches the store', async () => {
    delete process.env.APP_ACCESS_TOKEN;
    const res = await GET_ONE(oneReq(), params);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
    expect(getRun).not.toHaveBeenCalled();
  });

  it('a wrong token is still 401 when one IS configured', async () => {
    process.env.APP_ACCESS_TOKEN = TOKEN;
    expect((await GET_LIST(listReq('nope'))).status).toBe(401);
    expect((await GET_ONE(oneReq('nope'), params)).status).toBe(401);
    expect(listRuns).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
  });

  it('the correct token is served normally', async () => {
    process.env.APP_ACCESS_TOKEN = TOKEN;
    vi.mocked(listRuns).mockResolvedValue([]);
    const res = await GET_LIST(listReq(TOKEN));
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalled();
  });
});

describe('FIX F — the action routes keep working locally without a token', () => {
  it('checkAccess passes when APP_ACCESS_TOKEN is unset', () => {
    delete process.env.APP_ACCESS_TOKEN;
    expect(checkAccess(new Request('http://localhost/api/optimize'))).toBeNull();
  });

  it('checkAccess still enforces a configured token', () => {
    process.env.APP_ACCESS_TOKEN = TOKEN;
    expect(checkAccess(new Request('http://localhost/api/optimize'))?.status).toBe(401);
    expect(
      checkAccess(new Request('http://localhost/api/optimize', { headers: { 'x-app-token': TOKEN } })),
    ).toBeNull();
  });

  it('requireAccess refuses outright when no token is configured', () => {
    delete process.env.APP_ACCESS_TOKEN;
    const denied = requireAccess(new Request('http://localhost/api/runs'));
    expect(denied?.status).toBe(401);
  });
});
