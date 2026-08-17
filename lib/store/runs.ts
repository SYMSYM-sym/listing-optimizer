import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';
import {
  coerceGenerationFailure,
  mergeGenerationFailure,
  narrowGenerationFailure,
} from '@/lib/shared/generationFailure';
import type { Audit, GenerationFailure, ListingSnapshot, OptimizedListing } from '@/lib/types';

export interface RunRecord {
  id: string;
  created_at: string;
  /**
   * WS6 — when the operator recorded this run as PUBLISHED. Null until then.
   *
   * REQUIRES the column: `alter table runs add column published_at timestamptz;`
   * (see README). It is nullable and unused by every other code path, so a
   * deployment that has not run the migration keeps working — only the publish
   * route fails, and it fails loudly with the store's own message rather than
   * silently pretending the run was published.
   */
  published_at?: string | null;
  /**
   * U3 — the upstream generation failure this run hit, when it hit one.
   *
   * WHY IT IS PERSISTED AT ALL. U1 put the "generation never ran" banner on the
   * live optimize screen and nothing carried the value onto the run record, so
   * re-opening the SAME degraded run from History showed eleven gate failures
   * and no cause — the exact misleading state U1 exists to prevent, one surface
   * over. This column is what closes it.
   *
   * REQUIRES the column: `alter table runs add column if not exists
   * generation_failure jsonb;` (see README, beside the `published_at` note). It
   * is nullable and no other code path depends on it, so a deployment that has
   * not run the migration keeps working: a healthy run does not send the key at
   * all (the insert is byte-identical to the one that shipped before), and the
   * LIVE response still carries `generationFailure` and still renders the
   * banner even if the save is refused — only the History replay loses it, and
   * it loses it loudly, in the `store.error` log line the route already writes.
   *
   * NEVER TRUSTED ON THE WAY OUT. Every read goes through
   * `coerceGenerationFailure`, so a legacy NULL, a partial record or outright
   * junk degrades to "no failure" instead of throwing: a History page that
   * fails to load is a worse outcome than a missing banner.
   *
   * IT DECIDES NOTHING. `verified` is computed only in
   * `lib/audit/buildAudit.ts`, from the gate.
   */
  generation_failure?: GenerationFailure | null;
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
  | 'id'
  | 'created_at'
  | 'asin'
  | 'product_name'
  | 'verified'
  | 'score'
  | 'gaps'
  | 'failure_ids'
  | 'published_at'
  // U3 — carried into the LIST, not just the detail, so a degraded run is
  // recognisable as degraded BEFORE it is opened. It is the only jsonb column
  // the list query selects, and it is ~5 short scalar fields; the three heavy
  // payloads (snapshot/optimized/audit) stay out, which is what "no jsonb
  // payloads" was ever about.
  | 'generation_failure'
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
  /**
   * U3 — present ONLY when a call to the model API actually failed. Absent on
   * every healthy run, and when absent the insert omits the column entirely.
   */
  generationFailure?: GenerationFailure | null;
}

export interface UpdateRunPatch {
  optimized: OptimizedListing;
  audit: Audit;
  verified: boolean;
  score: number;
  gaps: number;
  failureIds: string[];
  productName?: string;
  /**
   * U3/V1 — the notice raised by THIS regeneration, if it raised one.
   *
   * IT IS NO LONGER THE WHOLE STORY, AND THE COLUMN IS NO LONGER SET-ONLY.
   *
   * U3 made this write-only-upward, and the reason was right: a regeneration
   * rewrites ONE group of nine, so a notice that vanished on the first good
   * group would announce a recovery that did not happen. But the rule was
   * blunter than its reason. A run whose ONLY degraded group was then
   * successfully regenerated stayed amber in History forever, with no way back
   * — and once V1's exploit could brand a healthy run amber in the first place,
   * "can never be cleared" meant one recovered blip during a regenerate was
   * permanent.
   *
   * The rule is now SCOPED rather than one-directional, and it lives in
   * `narrowGenerationFailure`/`mergeGenerationFailure` so the live panel
   * applies the identical logic to the session it is holding: a notice covers a
   * SET OF GROUPS and survives exactly as long as any of them is still in
   * `patch.optimized.degradedGroups`. Recovering one of several narrows it;
   * recovering all of them clears it; recovering none leaves it untouched. The
   * other eight groups therefore keep the notice alive on their own — U3's
   * reason is preserved as a CONSEQUENCE of the rule instead of as a separate
   * prohibition.
   *
   * A stored notice with NO scope (written before V1) is never narrowed and
   * never cleared, exactly as under U3: there is nothing in the row to narrow
   * it by, and dropping it on a guess would be the announcement U3 forbade.
   */
  generationFailure?: GenerationFailure | null;
}

/**
 * The LIST projection. The three heavy jsonb payloads (snapshot/optimized/
 * audit) are never selected here — the list is a summary. `generation_failure`
 * is the one jsonb that is, because it is five short scalars and because a
 * degraded run has to be recognisable as degraded BEFORE it is opened.
 */
const LIST_COLUMNS =
  'id, created_at, asin, product_name, verified, score, gaps, failure_ids, published_at, generation_failure';

/** The same projection for a deployment that has not run the U3 migration. */
const LIST_COLUMNS_LEGACY =
  'id, created_at, asin, product_name, verified, score, gaps, failure_ids, published_at';

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

/**
 * Does this Postgres/PostgREST error say the `generation_failure` COLUMN is not
 * there?
 *
 * A deployment can run this code before it runs the migration — that window is
 * ordinary, not exotic, because the app auto-deploys on push and the migration
 * is applied by hand. Without this, adding the column to the list SELECT would
 * mean the whole HISTORY PAGE 502s until someone runs the SQL, which is a far
 * worse outcome than a missing banner and is precisely the trade this feature
 * is not allowed to make. So each statement that names the column is retried
 * ONCE without it, and the app behaves exactly as it did before U3.
 *
 * Deliberately NARROW: it must match the missing column and nothing else. A
 * different store failure has to keep failing loudly.
 */
function missingFailureColumn(error: { code?: string; message?: string }): boolean {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  // 42703 undefined_column (select), PGRST204 unknown column in the schema
  // cache (insert/update). Both are additionally required to NAME the column,
  // so an unrelated typo elsewhere can never be swallowed here.
  return (code === '42703' || code === 'PGRST204') && message.includes('generation_failure');
}

/**
 * U3 — the ONE gate every stored `generation_failure` passes through on the way
 * out, applied to the list rows and the detail row alike.
 *
 * A recognised failure is REBUILT field by field (so no stray persisted key —
 * `message` above all — can survive a round trip); anything else, including the
 * NULL a row written before the column existed carries, has its key DROPPED
 * entirely rather than set to `null`. Dropping keeps a legacy run's API
 * response byte-identical to the one it returned yesterday, and `'x' in row`
 * stays the exact test for "this run degraded upstream".
 */
function normalizeFailure<T extends object>(row: T): T {
  const { generation_failure: raw, ...rest } = row as T & { generation_failure?: unknown };
  const failure = coerceGenerationFailure(raw);
  return (failure ? { ...rest, generation_failure: failure } : rest) as T;
}

export async function saveRun(run: SaveRunInput): Promise<string | null> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'saveRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return null;
  }
  const storedFailure = coerceGenerationFailure(run.generationFailure);
  const insert = (withFailure: boolean) =>
    sb
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
        // Omitted, not `null`, when there was no failure: a healthy run's
        // insert is the exact statement that shipped before this column
        // existed.
        //
        // COERCED ON THE WAY IN as well as on the way out. The payload is
        // rebuilt field by field from the five-field contract, so "the stored
        // row never contains `message`" is a property of this function rather
        // than a promise about every present and future caller — and `message`
        // is the field `e885f23` deliberately kept out of anything a browser
        // can read.
        ...(withFailure && storedFailure ? { generation_failure: storedFailure } : {}),
      })
      .select('id')
      .single();
  let { data, error } = await insert(true);
  if (error && missingFailureColumn(error)) {
    // The run itself is worth more than the annotation on it. The LIVE response
    // still carries `generationFailure` and still renders the banner; only the
    // History replay loses it, and it says so here.
    logServer('store.generation_failure_column_missing', { op: 'saveRun' });
    ({ data, error } = await insert(false));
  }
  if (error) {
    throw new Error(`saveRun failed: ${error.message}`);
  }
  return (data as { id: string }).id;
}

/**
 * V1 — read the notice this run is currently carrying, so `updateRun` can
 * narrow or clear it.
 *
 * FAILS TOWARD SET-ONLY. Any error other than "the column is not there" is
 * logged and answered with `undefined`, which the caller treats as "I do not
 * know what is stored" and therefore never clears anything. Clearing an
 * operator's only statement of cause on the strength of a failed read would be
 * the worst outcome available here.
 */
async function carriedFailure(
  sb: SupabaseClient,
  id: string,
): Promise<GenerationFailure | null | undefined> {
  const { data, error } = await sb
    .from('runs')
    .select('generation_failure')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (missingFailureColumn(error)) {
      logServer('store.generation_failure_column_missing', { op: 'updateRun.read' });
      // The column does not exist, so there is nothing stored and nothing to
      // clear. That is a KNOWN empty, not an unknown — `null`, not `undefined`.
      return null;
    }
    logServer('store.error', { op: 'updateRun.read', message: String(error.message ?? '').slice(0, 200) });
    return undefined;
  }
  return coerceGenerationFailure((data as { generation_failure?: unknown } | null)?.generation_failure);
}

export async function updateRun(id: string, patch: UpdateRunPatch): Promise<void> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'updateRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }
  const incoming = coerceGenerationFailure(patch.generationFailure);
  // V1 — the two-step rule. `carried` is what the row already says; it is
  // narrowed to the groups STILL degraded in the listing being written, and the
  // notice this round raised (if any) is merged on top.
  const carried = await carriedFailure(sb, id);
  const narrowed =
    carried === undefined
      ? // Unknown: behave exactly as U3 did — set only, clear never.
        incoming
      : narrowGenerationFailure(carried, patch.optimized.degradedGroups);
  const storedFailure =
    carried === undefined ? incoming : mergeGenerationFailure(narrowed, incoming);
  /**
   * Write the column when there is something to SET or something to CLEAR, and
   * omit it otherwise — so a regeneration of a run that never had a notice
   * issues the exact statement it issued before this column existed.
   *
   * `null` is written, deliberately, when a stored notice no longer covers any
   * degraded group. That is the clear.
   */
  const touchesFailure = storedFailure !== null || (carried !== undefined && carried !== null);
  const update = (withFailure: boolean) =>
    sb
      .from('runs')
      .update({
        optimized: patch.optimized,
        audit: patch.audit,
        verified: patch.verified,
        score: patch.score,
        gaps: patch.gaps,
        failure_ids: patch.failureIds,
        ...(patch.productName !== undefined ? { product_name: patch.productName } : {}),
        // V1 — SCOPED, not set-only. See `UpdateRunPatch.generationFailure`.
        // Coerced on the way in for the same reason `saveRun` coerces, so the
        // stored row can never contain `message` or any key outside the
        // contract regardless of what a caller hands over.
        ...(withFailure && touchesFailure ? { generation_failure: storedFailure } : {}),
      })
      .eq('id', id);
  let { error } = await update(true);
  if (error && missingFailureColumn(error)) {
    logServer('store.generation_failure_column_missing', { op: 'updateRun' });
    ({ error } = await update(false));
  }
  if (error) {
    throw new Error(`updateRun failed: ${error.message}`);
  }
}

/**
 * WS6 — record a run as PUBLISHED.
 *
 * The `'published'` element state has been in the contract since the output
 * contract was written and nothing ever set it, so a run that had actually
 * gone live was indistinguishable from one sitting in a tab. This is the only
 * writer of that state.
 *
 * WHAT IT DOES NOT DO: it does not re-run the gate, and it does not decide
 * whether publishing is allowed — the ROUTE does, from the stored
 * `audit.verified` (which is itself exactly `gateResult.pass`, derived
 * server-side). Keeping the decision in the route and the write here means
 * this function can never be the thing that lets an unverified run through.
 *
 * Returns the recorded timestamp, or null when the store is not configured.
 */
export async function publishRun(
  id: string,
  optimized: OptimizedListing,
  publishedAt: string,
): Promise<string | null> {
  const sb = client();
  if (!sb) {
    logServer('store.disabled', { op: 'publishRun', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    return null;
  }
  const { error } = await sb
    .from('runs')
    .update({ optimized, published_at: publishedAt })
    .eq('id', id);
  if (error) {
    throw new Error(`publishRun failed: ${error.message}`);
  }
  return publishedAt;
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
  const query = (columns: string) => {
    let q = sb
      .from('runs')
      .select(columns)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (opts.asin?.trim()) {
      q = q.ilike('asin', opts.asin.trim());
    }
    return q;
  };
  let { data, error } = await query(LIST_COLUMNS);
  if (error && missingFailureColumn(error)) {
    logServer('store.generation_failure_column_missing', { op: 'listRuns' });
    ({ data, error } = await query(LIST_COLUMNS_LEGACY));
  }
  if (error) {
    throw new Error(`listRuns failed: ${error.message}`);
  }
  return ((data ?? []) as unknown as RunListItem[]).map(normalizeFailure);
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
  const row = (data as RunRecord | null) ?? null;
  return row ? normalizeFailure(row) : null;
}
