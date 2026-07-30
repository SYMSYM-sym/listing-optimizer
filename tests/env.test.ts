import { afterEach, describe, expect, it, vi } from 'vitest';

describe('lib/env runtime validation', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('module import does not throw when keys are missing (lazy validation)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(import('@/lib/env')).resolves.toBeDefined();
  });

  it('throws at use time when ANTHROPIC_API_KEY is missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { env } = await import('@/lib/env');
    expect(() => env.anthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts valid INGEST_PROVIDER values', async () => {
    vi.stubEnv('INGEST_PROVIDER', 'paste');
    const { env } = await import('@/lib/env');
    expect(env.ingestProvider()).toBe('paste');
  });

  it('rejects invalid INGEST_PROVIDER', async () => {
    vi.stubEnv('INGEST_PROVIDER', 'scraper');
    const { env } = await import('@/lib/env');
    expect(() => env.ingestProvider()).toThrow(/rainforest\|firecrawl\|paste/);
  });

  it('MAX_REPAIR_ITERATIONS defaults to 3 and bounds 0–10', async () => {
    vi.stubEnv('MAX_REPAIR_ITERATIONS', '');
    const { env } = await import('@/lib/env');
    expect(env.maxRepairIterations()).toBe(3);
    vi.stubEnv('MAX_REPAIR_ITERATIONS', '99');
    vi.resetModules();
    const { env: env2 } = await import('@/lib/env');
    expect(() => env2.maxRepairIterations()).toThrow(/0–10/);
  });

  it('does not require provider keys when INGEST_PROVIDER=paste', async () => {
    vi.stubEnv('INGEST_PROVIDER', 'paste');
    vi.stubEnv('RAINFOREST_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    const { env } = await import('@/lib/env');
    expect(env.ingestProvider()).toBe('paste');
    expect(env.rainforestApiKey()).toBe('');
    expect(env.firecrawlApiKey()).toBe('');
  });

  it('requires RAINFOREST_API_KEY only when INGEST_PROVIDER=rainforest', async () => {
    vi.stubEnv('INGEST_PROVIDER', 'rainforest');
    vi.stubEnv('RAINFOREST_API_KEY', '');
    const { env } = await import('@/lib/env');
    expect(() => env.rainforestApiKey()).toThrow(/RAINFOREST_API_KEY/);
  });
});
