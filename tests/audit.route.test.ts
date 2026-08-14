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

  /**
   * WS5.5 — the route-level contract for the panel confirmation.
   *
   * `/api/audit` takes a CLIENT-SUPPLIED listing, so this is the route where
   * "the panel outranks the facts block that arrived with the request" is
   * load-bearing: worker != checker means the checker cannot take the worker's
   * word for what the product is either.
   */
  it('honours an operator-confirmed panel, and is unchanged without one', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);

    const bare = await (await post({ snapshot, listing })).json();
    expect(bare.audit.verified).toBe(true);

    // absent => byte-identical to the call that never mentioned a panel
    const empty = await (await post({ snapshot, listing, panelFacts: {} })).json();
    expect(JSON.stringify(empty.audit)).toBe(JSON.stringify(bare.audit));

    // present and CONTRADICTING the copy => blocking C12, verified false
    const superseded = await (
      await post({ snapshot, listing, panelFacts: { maximum_dosage: '75 Billion CFU' } })
    ).json();
    expect(superseded.audit.verified).toBe(false);
    expect(superseded.audit.gateResult.failures.some((f: { checkId: string }) => f.checkId === 'C12')).toBe(true);

    // present and CONFIRMING the copy => still verified
    const agreeing = await (
      await post({ snapshot, listing, panelFacts: { maximum_dosage: '50 Billion CFU' } })
    ).json();
    expect(agreeing.audit.verified).toBe(true);
  });

  it('returns 400 when snapshot or listing is missing', async () => {
    const res = await post({ snapshot });
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
  });
});
