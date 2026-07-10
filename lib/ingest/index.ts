import 'server-only';
import { env } from '@/lib/env';
import type { ListingSnapshot } from '@/lib/types';
import { firecrawlProvider } from './providers/firecrawl';
import { rainforestProvider } from './providers/rainforest';
import type { ListingProvider } from './providers/types';
import { toSnapshot } from './toSnapshot';

/** ASIN-keyed in-memory cache (per serverless instance) with short TTL. */
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { at: number; snapshot: ListingSnapshot }>();

export function selectProvider(): ListingProvider {
  const p = env.ingestProvider();
  if (p === 'rainforest') return rainforestProvider;
  if (p === 'firecrawl') return firecrawlProvider;
  throw new Error(
    'INGEST_PROVIDER=paste — use the paste endpoint, not automated ingestion.',
  );
}

export async function ingestByAsin(asin: string): Promise<ListingSnapshot> {
  const hit = cache.get(asin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.snapshot;
  const provider = selectProvider();
  const rawListing = await provider.fetch(asin);
  const snapshot = toSnapshot(rawListing);
  cache.set(asin, { at: Date.now(), snapshot });
  return snapshot;
}
