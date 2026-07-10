import 'server-only';
import { env } from '@/lib/env';
import { parsePdpHtml } from '../parsePdpHtml';
import { ProviderError, type ListingProvider, type RawListing } from './types';

/**
 * Firecrawl adapter — raw HTML format ONLY (no LLM JSON-extraction in the
 * ingestion path), fed through the same deterministic parser as paste mode.
 * ToS note: pointing a scraping vendor at Amazon PDPs carries the same ToS /
 * rate-limit exposure as scraping. Non-default; best-effort.
 */

const TIMEOUT_MS = 60_000;

export const firecrawlProvider: ListingProvider = {
  async fetch(asin: string): Promise<RawListing> {
    const url = `https://www.amazon.com/dp/${asin}`;
    let res: Response;
    try {
      res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.firecrawlApiKey()}`,
        },
        body: JSON.stringify({ url, formats: ['rawHtml'] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new ProviderError('PROVIDER_TIMEOUT', 'Firecrawl request timed out');
      }
      throw new ProviderError('PROVIDER_ERROR', `Firecrawl request failed: ${String(e)}`);
    }
    if (res.status === 429) {
      throw new ProviderError('RATE_LIMITED', 'Firecrawl rate limit (429)');
    }
    if (!res.ok) {
      throw new ProviderError('PROVIDER_ERROR', `Firecrawl HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      success?: boolean;
      data?: { rawHtml?: string; html?: string };
      error?: string;
    };
    const html = data.data?.rawHtml ?? data.data?.html;
    if (!data.success || !html) {
      throw new ProviderError(
        'PROVIDER_BLOCKED',
        `Firecrawl could not retrieve the page (likely blocked): ${data.error ?? 'no HTML returned'}`,
      );
    }
    const listing = parsePdpHtml(html, asin, url);
    if (!listing.title) {
      throw new ProviderError(
        'PROVIDER_BLOCKED',
        'Retrieved page has no product title — likely a bot-check page. Use paste mode.',
      );
    }
    return { ...listing, raw: { source: 'firecrawl' } };
  },
};
