import { NextResponse } from 'next/server';
import { anthropicClient } from '@/lib/engine/llm';
import { runRepairLoop } from '@/lib/engine/repair';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { checkAccess } from '@/lib/server/guard';
import { env } from '@/lib/env';
import type { ListingSnapshot } from '@/lib/types';

export const maxDuration = 300;

/**
 * Full pipeline stage: snapshot → optimize → bounded repair loop → audit.
 * Returns { optimized, audit, detection }. `audit.verified` is derived
 * server-side by the audit module re-running the gate (worker ≠ checker).
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
  const detection = detectCategory(body.snapshot);
  const pack = loadPack(detection.packId);
  const snapshot: ListingSnapshot = { ...body.snapshot, subcategory: detection.subcategories };
  const ctx = { subcategories: detection.subcategories, snapshotText: `${snapshot.title} ${snapshot.category}` };
  try {
    const { listing, gateResult, iterations } = await runRepairLoop(
      snapshot,
      pack,
      anthropicClient(),
      ctx,
      env.maxRepairIterations(),
    );
    const audit = buildAudit(snapshot, listing, pack, ctx);
    const optimized = { ...listing, state: audit.verified ? ('verified' as const) : ('draft' as const) };
    return NextResponse.json({ optimized, audit, detection, iterations, gateResult });
  } catch (e) {
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : 'Generation failed.' },
      { status: 502 },
    );
  }
}
