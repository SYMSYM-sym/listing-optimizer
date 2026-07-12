import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    supabaseUrl: vi.fn(() => ''),
    supabaseServiceRoleKey: vi.fn(() => ''),
  },
}));

vi.mock('@/lib/server/log', () => ({
  logServer: vi.fn(),
}));

import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';
import {
  __resetStoreClientForTests,
  getRun,
  listRuns,
  saveRun,
  updateRun,
  type SaveRunInput,
} from '@/lib/store/runs';
import type { Audit, ListingSnapshot, OptimizedListing } from '@/lib/types';

const snapshot = {
  asin: 'B0TEST',
  url: 'https://www.amazon.com/dp/B0TEST',
  title: 'Test Product',
} as ListingSnapshot;

const optimized = {
  title: 'Test Product',
  productName: 'Test Product',
} as OptimizedListing;

const audit = {
  verified: true,
  scorecard: { total: 80, perPrinciple: [] },
  gaps: [],
  gateResult: { pass: true, failures: [] },
} as Audit;

function sampleInput(): SaveRunInput {
  return {
    asin: 'B0TEST',
    url: 'https://www.amazon.com/dp/B0TEST',
    productName: 'Test Product',
    packId: 'generic',
    verified: true,
    score: 80,
    gaps: 0,
    failureIds: [],
    snapshot,
    optimized,
    audit,
  };
}

describe('lib/store/runs (unconfigured)', () => {
  beforeEach(() => {
    __resetStoreClientForTests();
    vi.mocked(env.supabaseUrl).mockReturnValue('');
    vi.mocked(env.supabaseServiceRoleKey).mockReturnValue('');
  });

  afterEach(() => {
    vi.clearAllMocks();
    __resetStoreClientForTests();
  });

  it('saveRun is a no-op that logs store.disabled and returns null', async () => {
    const id = await saveRun(sampleInput());
    expect(id).toBeNull();
    expect(logServer).toHaveBeenCalledWith(
      'store.disabled',
      expect.objectContaining({ op: 'saveRun' }),
    );
  });

  it('updateRun is a no-op that logs store.disabled', async () => {
    await updateRun('fake-id', {
      optimized,
      audit,
      verified: true,
      score: 80,
      gaps: 0,
      failureIds: [],
    });
    expect(logServer).toHaveBeenCalledWith(
      'store.disabled',
      expect.objectContaining({ op: 'updateRun' }),
    );
  });

  it('listRuns returns [] and logs store.disabled', async () => {
    const rows = await listRuns();
    expect(rows).toEqual([]);
    expect(logServer).toHaveBeenCalledWith(
      'store.disabled',
      expect.objectContaining({ op: 'listRuns' }),
    );
  });

  it('getRun returns null and logs store.disabled', async () => {
    const row = await getRun('fake-id');
    expect(row).toBeNull();
    expect(logServer).toHaveBeenCalledWith(
      'store.disabled',
      expect.objectContaining({ op: 'getRun' }),
    );
  });
});
