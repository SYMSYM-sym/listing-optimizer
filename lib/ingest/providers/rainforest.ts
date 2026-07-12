import 'server-only';
import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';
import { ProviderError, type ListingProvider, type RawListing } from './types';

/**
 * Rainforest Product API adapter — a third-party scraped-data API (Traject Data),
 * NOT affiliated with or licensed by Amazon. Recommended default on reliability
 * grounds; this does not reduce ToS exposure.
 */

interface RainforestProduct {
  title?: string;
  feature_bullets?: string[];
  description?: string;
  main_image?: { link?: string };
  images?: { link?: string }[];
  attributes?: { name?: string; value?: string }[];
  specifications?: { name?: string; value?: string }[];
  categories?: { name?: string; category_id?: string }[];
  buybox_winner?: { price?: { raw?: string } };
  rating?: number;
  brand?: string;
  a_plus_content?: { body_text?: string; company_description_text?: string };
  important_information?: { sections?: { title?: string; body?: string }[] };
}

interface RainforestResponse {
  request_info?: { success?: boolean; message?: string };
  product?: RainforestProduct;
}

const TIMEOUT_MS = 30_000;

async function callOnce(asin: string): Promise<Response> {
  const params = new URLSearchParams({
    api_key: env.rainforestApiKey(),
    type: 'product',
    amazon_domain: 'amazon.com',
    asin,
    include_a_plus_body: 'true',
  });
  return fetch(`https://api.rainforestapi.com/request?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export const rainforestProvider: ListingProvider = {
  async fetch(asin: string): Promise<RawListing> {
    const started = Date.now();
    let res: Response;
    try {
      res = await callOnce(asin);
      if (res.status === 429) {
        logServer('ingest.provider', {
          provider: 'rainforest',
          asin,
          event: 'rate_limited',
          ms: Date.now() - started,
        });
        // one retry with jitter
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
        res = await callOnce(asin);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        logServer('ingest.provider', {
          provider: 'rainforest',
          asin,
          event: 'timeout',
          ms: Date.now() - started,
        });
        throw new ProviderError('PROVIDER_TIMEOUT', 'Rainforest request timed out');
      }
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'error',
        ms: Date.now() - started,
      });
      throw new ProviderError('PROVIDER_ERROR', `Rainforest request failed: ${String(e)}`);
    }
    if (res.status === 429) {
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'rate_limited_exhausted',
        ms: Date.now() - started,
      });
      throw new ProviderError('RATE_LIMITED', 'Rainforest plan rate limit reached (429)');
    }
    if (res.status === 404) {
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'not_found',
        status: 404,
        ms: Date.now() - started,
      });
      throw new ProviderError('ASIN_NOT_FOUND', `ASIN ${asin} not found`);
    }
    if (!res.ok) {
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'http_error',
        status: res.status,
        ms: Date.now() - started,
      });
      throw new ProviderError('PROVIDER_ERROR', `Rainforest HTTP ${res.status}`);
    }
    const data = (await res.json()) as RainforestResponse;
    if (data.request_info?.success === false) {
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'api_failure',
        ms: Date.now() - started,
      });
      throw new ProviderError(
        'PROVIDER_ERROR',
        `Rainforest reported failure: ${data.request_info.message ?? 'unknown'}`,
      );
    }
    const p = data.product;
    if (!p?.title) {
      logServer('ingest.provider', {
        provider: 'rainforest',
        asin,
        event: 'not_found',
        ms: Date.now() - started,
      });
      throw new ProviderError('ASIN_NOT_FOUND', `No product data returned for ${asin}`);
    }
    logServer('ingest.provider', {
      provider: 'rainforest',
      asin,
      event: 'ok',
      ms: Date.now() - started,
    });
    return mapProduct(asin, p, data);
  },
};

export function mapProduct(
  asin: string,
  p: RainforestProduct,
  raw: unknown,
): RawListing {
  const attrs = [...(p.attributes ?? []), ...(p.specifications ?? [])]
    .filter((a): a is { name: string; value: string } => Boolean(a.name && a.value))
    .map((a) => ({ name: a.name, value: a.value }));
  const images = [
    ...(p.main_image?.link ? [p.main_image.link] : []),
    ...(p.images ?? []).map((i) => i.link).filter((l): l is string => Boolean(l)),
  ];
  const aplusText = [
    p.a_plus_content?.body_text,
    p.a_plus_content?.company_description_text,
  ]
    .filter(Boolean)
    .join('\n\n');
  const importantInformation = (p.important_information?.sections ?? [])
    .map((s) => [s.title, s.body].filter(Boolean).join('\n'))
    .join('\n\n');
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: p.title ?? '',
    bullets: p.feature_bullets ?? [],
    description: p.description ?? '',
    images: [...new Set(images)],
    attributesRaw: attrs,
    price: p.buybox_winner?.price?.raw,
    rating: p.rating,
    categories: (p.categories ?? []).map((c) => c.name ?? '').filter(Boolean),
    categoryIds: (p.categories ?? [])
      .map((c) => c.category_id ?? '')
      .filter(Boolean),
    aplusText: aplusText || undefined,
    importantInformation: importantInformation || undefined,
    brand: p.brand,
    raw,
  };
}
