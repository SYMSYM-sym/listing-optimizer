import 'server-only';

/**
 * Typed, server-only env access. Throws at USE time (runtime), never at
 * import/build time, so `next build` succeeds without secrets.
 * No key ever reaches the client bundle (import 'server-only' enforces it).
 */

export type IngestProvider = 'rainforest' | 'firecrawl' | 'paste';
export type TitlePolicy = 'dual' | 'legacy' | 'new75';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : fallback;
}

export const env = {
  anthropicApiKey: (): string => required('ANTHROPIC_API_KEY'),

  anthropicModel: (): string => optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),

  ingestProvider: (): IngestProvider => {
    const v = optional('INGEST_PROVIDER', 'rainforest');
    if (v !== 'rainforest' && v !== 'firecrawl' && v !== 'paste') {
      throw new Error(
        `INGEST_PROVIDER must be one of rainforest|firecrawl|paste, got "${v}"`,
      );
    }
    return v;
  },

  rainforestApiKey: (): string => {
    if (env.ingestProvider() !== 'rainforest') {
      return optional('RAINFOREST_API_KEY', '');
    }
    return required('RAINFOREST_API_KEY');
  },

  firecrawlApiKey: (): string => {
    if (env.ingestProvider() !== 'firecrawl') {
      return optional('FIRECRAWL_API_KEY', '');
    }
    return required('FIRECRAWL_API_KEY');
  },

  maxRepairIterations: (): number => {
    const n = Number.parseInt(optional('MAX_REPAIR_ITERATIONS', '3'), 10);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      throw new Error('MAX_REPAIR_ITERATIONS must be an integer 0–10');
    }
    return n;
  },

  /**
   * Controls UI ordering + prompt emphasis around the Jul 27 2026 title
   * policy ONLY. Both title variants are always generated and gated
   * (C1 and C15 enforced regardless of this flag).
   */
  titlePolicy: (): TitlePolicy => {
    const v = optional('TITLE_POLICY', 'dual');
    if (v !== 'dual' && v !== 'legacy' && v !== 'new75') {
      throw new Error(`TITLE_POLICY must be dual|legacy|new75, got "${v}"`);
    }
    return v;
  },

  /** Optional shared-secret gate for the public deployment (empty = open). */
  appAccessToken: (): string => optional('APP_ACCESS_TOKEN', ''),
};
