import { NextResponse } from 'next/server';
import { checkAccess } from '@/lib/server/guard';
import { getRun } from '@/lib/store/runs';

export const maxDuration = 30;

/** GET /api/runs/[id] — full run row including snapshot/optimized/audit. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = checkAccess(req);
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
