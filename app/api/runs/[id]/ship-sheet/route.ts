import { requireAccess } from '@/lib/server/guard';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { loadPack, type PackId } from '@/lib/knowledge/loadPack';
import { getRun } from '@/lib/store/runs';

export const maxDuration = 30;

const PACK_IDS: PackId[] = ['supplements', 'cosmetics', 'generic'];

const asPackId = (v: string | undefined): PackId =>
  PACK_IDS.includes(v as PackId) ? (v as PackId) : 'generic';

const json = (code: string, message: string, status: number): Response =>
  Response.json({ code, message }, { status });

/**
 * GET /api/runs/[id]/ship-sheet — the operator's paste sheet for one stored run.
 *
 * BEHIND `requireAccess` (the MANDATORY-token guard the other history routes
 * use), because the sheet contains the ENTIRE generated listing: serving it
 * from an unauthenticated URL would publish every stored run's copy.
 *
 * NEVER PERSISTED. The HTML is regenerated from the stored run on every
 * request, so it cannot go stale against the run it claims to describe — the
 * exact drift the harness kit's checked-in SHIP-SHEET.html suffered. That is
 * also why the response is `no-store`: a cached sheet is a stale sheet.
 *
 * The gate result travels with the run, so an unverified run yields the
 * blocking, copy-button-free variant of the sheet without this route needing
 * to know anything about the gate.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAccess(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!id) return json('BAD_REQUEST', 'Missing run id.', 400);
  let run;
  try {
    run = await getRun(id);
  } catch (e) {
    return json('STORE_ERROR', e instanceof Error ? e.message : 'getRun failed', 502);
  }
  if (!run) return json('NOT_FOUND', 'Run not found.', 404);
  const html = buildShipSheet({
    optimized: run.optimized,
    audit: run.audit,
    asin: run.asin,
    product_name: run.product_name,
    created_at: run.created_at,
    // WS10 — the scraped listing, so the sheet can mark the brand identity that
    // came off the live page as a value to CONFIRM rather than an answer.
    snapshot: run.snapshot,
    // U3 — a sheet PRINTED from a degraded run says why it is blocked. The
    // store validates the stored value on read, so anything malformed arrives
    // here as `undefined` and the sheet is the one that shipped before.
    ...(run.generation_failure ? { generationFailure: run.generation_failure } : {}),
    pack: loadPack(asPackId(run.pack_id)),
  });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
