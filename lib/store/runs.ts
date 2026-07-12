import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';
import type { Audit, ListingSnapshot, OptimizedListing } from '@/lib/types';

export interface RunRecord {
  id: string;
  created_at: string;
  asin: string;
  url: string;
  product_name: string;
  pack_id: string;
  verified: boolean;
  score: number;
  gaps: number;
  failure_ids: string[];
  snapshot: ListingSnapshot;
  optimized: OptimizedListing;
  audit: Audit;
}

export type RunListItem = Pick<
  RunRecord,
  'id' | 'created_at' | 'asin' | 'product_name' | 'verified' | 'score' | 'gaps' | 'failure_ids'
>;

export interface SaveRunInput {
  asin: string;
  url: string;
  productName: string;
  packId: string;
  verified: boolean;
  score: number;
  gaps: number;
  failureIds: string[];
  snapshot: ListingSnapshot;
  optimized: OptimizedListing;
  audit: Audit;
}

export interface UpdateRunPatch {
  optimized: OptimizedListing;
  audit: Audit;
  verified: boolean;
  score: number;
  gaps: number;
  failureIds: string[];
  productName?: string;
}

let _client: SupabaseClient | null | undefined;

function configured(): boolean {
  return Boolean(env.supabaseUrl() && env.supabaseServiceRoleKey());
}

function client(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  if (!configured()) {
    _client = null;
    return null;
  }
  _client = createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** Reset cached client (tests). */
export function __resetStoreClientForTests(): void {
  _client = undefined;
}

export async function saveRun(run: SaveRunInput): Promise<string | null> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'saveRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return null;
  }
  const { data, error } = await sb
    .from('runs')
    .insert({
      asin: run.asin,
      url: run.url,
      product_name: run.productName,
      pack_id: run.packId,
      verified: run.verified,
      score: run.score,
      gaps: run.gaps,
      failure_ids: run.failureIds,
      snapshot: run.snapshot,
      optimized: run.optimized,
      audit: run.audit,
    })
    .select('id')
    .single();
  if (error) {
    throw new Error(`saveRun failed: ${error.message}`);
  }
  return (data as { id: string }).id;
}

export async function updateRun(id: string, patch: UpdateRunPatch): Promise<void> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'updateRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }
  const { error } = await sb
    .from('runs')
    .update({
      optimized: patch.optimized,
      audit: patch.audit,
      verified: patch.verified,
      score: patch.score,
      gaps: patch.gaps,
      failure_ids: patch.failureIds,
      ...(patch.productName !== undefined ? { product_name: patch.productName } : {}),
    })
    .eq('id', id);
  if (error) {
    throw new Error(`updateRun failed: ${error.message}`);
  }
}

export async function listRuns(opts: {
  limit?: number;
  offset?: number;
  asin?: string;
} = {}): Promise<RunListItem[]> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'listRuns', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return [];
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = sb
    .from('runs')
    .select('id, created_at, asin, product_name, verified, score, gaps, failure_ids')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.asin?.trim()) {
    q = q.ilike('asin', opts.asin.trim());
  }
  const { data, error } = await q;
  if (error) {
    throw new Error(`listRuns failed: ${error.message}`);
  }
  return (data ?? []) as RunListItem[];
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'getRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return null;
  }
  const { data, error } = await sb.from('runs').select('*').eq('id', id).maybeSingle();
  if (error) {
    throw new Error(`getRun failed: ${error.message}`);
  }
  return (data as RunRecord | null) ?? null;
}
