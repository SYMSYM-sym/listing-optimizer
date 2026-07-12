import { NextResponse } from 'next/server';
import { checkAccess } from '@/lib/server/guard';
import { listRuns } from '@/lib/store/runs';

export const maxDuration = 30;

/** GET /api/runs?limit=&offset=&asin= — list run summaries (no jsonb payloads). */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  const url = new URL(req.url);
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
  const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
  const asin = url.searchParams.get('asin') ?? undefined;
  try {
    const runs = await listRuns({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      asin,
    });
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json(
      { code: 'STORE_ERROR', message: e instanceof Error ? e.message : 'listRuns failed' },
      { status: 502 },
    );
  }
}
