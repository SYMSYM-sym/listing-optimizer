import { NextResponse } from 'next/server';
import { anthropicClient } from '@/lib/engine/llm';
import { runPipeline } from '@/lib/pipeline/run';
import { checkAccess } from '@/lib/server/guard';
import { env } from '@/lib/env';
import type { ListingSnapshot } from '@/lib/types';

export const maxDuration = 300;

/**
 * Full pipeline stage: snapshot -> optimize -> bounded repair loop -> audit.
 * Delegates to the ONE shared `runPipeline` (the exact code path the golden
 * E2E exercises), so the route and the deterministic test can never drift.
 * Returns { optimized, audit, detection, iterations, gateResult }.
 * `audit.verified` is derived server-side by the audit module re-running the
 * gate (worker != checker); a client-carried gate result is never trusted.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  let body: { snapshot?: ListingSnapshot };
  try {
    body = (await req.json()) as { snapshot?: ListingSnapshot };
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing snapshot.' }, { status: 400 });
  }
  try {
    const { optimized, audit, detection, iterations } = await runPipeline(
      body.snapshot,
      anthropicClient(),
      env.maxRepairIterations(),
    );
    return NextResponse.json({ optimized, audit, detection, iterations, gateResult: audit.gateResult });
  } catch (e) {
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : 'Generation failed.' },
      { status: 502 },
    );
  }
}
