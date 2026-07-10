import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/ingest/route';
import { ProviderError } from '@/lib/ingest/providers/types';
import { PasteError } from '@/lib/ingest/paste';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { IngestError } from '@/lib/types';
import { rainforestSample } from './fixtures/rainforest.sample';

const snapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);

const ASIN = 'B01N5IB20Q';
const URL = `https://www.amazon.com/dp/${ASIN}`;

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

vi.mock('@/lib/ingest', () => ({
  ingestByAsin: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    ingestProvider: vi.fn(() => 'rainforest' as const),
  },
}));

import { ingestByAsin } from '@/lib/ingest';
import { env } from '@/lib/env';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/ingest', () => {
  beforeEach(() => {
    vi.mocked(ingestByAsin).mockResolvedValue(snapshot);
    vi.mocked(env.ingestProvider).mockReturnValue('rainforest');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a populated snapshot for a valid URL', async () => {
    const res = await post({ url: URL });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.asin).toBe('B0TESTASIN');
    expect(data.title.length).toBeGreaterThan(0);
    expect(ingestByAsin).toHaveBeenCalledWith(ASIN);
  });

  it('returns a snapshot from pasted HTML', async () => {
    const html = `<html><body><span id="productTitle">Test Product</span>${'<p>pad</p>'.repeat(20)}</body></html>`;
    const res = await post({ url: URL, pasteHtml: html });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe('Test Product');
    expect(ingestByAsin).not.toHaveBeenCalled();
  });

  it('returns a snapshot from manual fields', async () => {
    const res = await post({
      manualFields: { title: 'Manual Title', bullets: ['a'], description: 'desc' },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe('Manual Title');
    expect(ingestByAsin).not.toHaveBeenCalled();
  });

  it('returns 400 INVALID_URL for an unparseable URL', async () => {
    const res = await post({ url: 'https://www.amazon.com/' });
    expect(res.status).toBe(400);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('INVALID_URL');
    expect(e.suggestPaste).toBe(false);
  });

  it('returns 400 with suggestPaste when provider=paste and no paste payload', async () => {
    vi.mocked(env.ingestProvider).mockReturnValue('paste');
    const res = await post({ url: URL });
    expect(res.status).toBe(400);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.suggestPaste).toBe(true);
    expect(ingestByAsin).not.toHaveBeenCalled();
  });

  it('maps ProviderError ASIN_NOT_FOUND to 404', async () => {
    vi.mocked(ingestByAsin).mockRejectedValue(
      new ProviderError('ASIN_NOT_FOUND', 'Product not found'),
    );
    const res = await post({ url: URL });
    expect(res.status).toBe(404);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('ASIN_NOT_FOUND');
  });

  it('maps ProviderError RATE_LIMITED to 429', async () => {
    vi.mocked(ingestByAsin).mockRejectedValue(
      new ProviderError('RATE_LIMITED', 'Rate limit'),
    );
    const res = await post({ url: URL });
    expect(res.status).toBe(429);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('RATE_LIMITED');
  });

  it('maps ProviderError PROVIDER_BLOCKED to 502 with suggestPaste', async () => {
    vi.mocked(ingestByAsin).mockRejectedValue(
      new ProviderError('PROVIDER_BLOCKED', 'Blocked'),
    );
    const res = await post({ url: URL });
    expect(res.status).toBe(502);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('PROVIDER_BLOCKED');
    expect(e.suggestPaste).toBe(true);
  });

  it('maps PasteError to 422 with suggestPaste', async () => {
    const res = await post({ url: URL, pasteHtml: 'plain text only' });
    expect(res.status).toBe(422);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('PASTE_UNPARSEABLE');
    expect(e.suggestPaste).toBe(true);
  });

  it('never returns HTTP 500 — unexpected errors become 502', async () => {
    vi.mocked(ingestByAsin).mockRejectedValue(new Error('boom'));
    const res = await post({ url: URL });
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(500);
    const e = (await res.json()) as IngestError;
    expect(e.code).toBe('PROVIDER_ERROR');
  });
});
