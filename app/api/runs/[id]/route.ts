import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/server/guard';
import { getRun } from '@/lib/store/runs';

export const maxDuration = 30;

/**
 * GET /api/runs/[id] — full run row including snapshot/optimized/audit.
 *
 * U3 — and including `generation_failure` when the run has one, which is what
 * lets the History replay render the same "generation never ran" banner the
 * live optimize screen renders. The row comes from `getRun`, which VALIDATES
 * that column on the way out, so this route can pass the record straight
 * through: a legacy row simply has no such key and a malformed one has had it
 * dropped.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireAccess(req);
  if (denied) return denied as NextResponse;
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing run id.' }, { status: 400 });
  }
  try {
    const run = await getRun(id);
    if (!run) {
      return NextResponse.json({ code: 'NOT_FOUND', message: 'Run not found.' }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (e) {
    return NextResponse.json(
      { code: 'STORE_ERROR', message: e instanceof Error ? e.message : 'getRun failed' },
      { status: 502 },
    );
  }
}
