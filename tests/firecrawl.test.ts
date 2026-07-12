import { afterEach, describe, expect, it, vi } from 'vitest';
import { firecrawlProvider } from '@/lib/ingest/providers/firecrawl';
import { ProviderError } from '@/lib/ingest/providers/types';

const HTML_WITH_TITLE = `<html><body>
  <span id="productTitle"> BrandX Probiotic 50 Billion CFU </span>
  <div id="feature-bullets"><ul>
    <li><span class="a-list-item">SUPPORTS DIGESTIVE BALANCE*</span></li>
  </ul></div>
  <div id="productDescription">BrandX Probiotic delivers a 50 Billion CFU blend.</div>
  ${'<p>pad</p>'.repeat(20)}
</body></html>`;

describe('firecrawl provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps successful scrape HTML through parsePdpHtml', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ success: true, data: { rawHtml: HTML_WITH_TITLE } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const raw = await firecrawlProvider.fetch('B0TESTFC01');
    expect(raw.title).toContain('BrandX Probiotic');
    expect(raw.asin).toBe('B0TESTFC01');
    expect((raw.raw as { source: string }).source).toBe('firecrawl');
  });

  it('maps 429 to RATE_LIMITED', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    await expect(firecrawlProvider.fetch('B0TESTFC02')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'RATE_LIMITED',
    } satisfies Partial<ProviderError>);
  });

  it('maps blocked / empty HTML to PROVIDER_BLOCKED', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: 'blocked' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(firecrawlProvider.fetch('B0TESTFC03')).rejects.toMatchObject({
      code: 'PROVIDER_BLOCKED',
    });
  });

  it('maps Abort/TimeoutError to PROVIDER_TIMEOUT', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      }),
    );
    await expect(firecrawlProvider.fetch('B0TESTFC04')).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
  });
});
