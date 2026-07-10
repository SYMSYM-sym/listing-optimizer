import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/audit/route';
import { optimize } from '@/lib/engine/optimize';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const snapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);
const pack = loadPack('supplements');

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/audit', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns scorecard, gaps, and gateResult with verified === gateResult.pass', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const res = await post({ snapshot, listing });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.audit.scorecard.total).toBeGreaterThanOrEqual(0);
    expect(data.audit.scorecard.perPrinciple.length).toBeGreaterThan(0);
    expect(data.audit.gaps.length).toBeGreaterThanOrEqual(3);
    expect(data.audit.verified).toBe(data.audit.gateResult.pass);
    expect(data.detection.packId).toBe('supplements');
  });

  it('returns 400 when snapshot or listing is missing', async () => {
    const res = await post({ snapshot });
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
  });
});
