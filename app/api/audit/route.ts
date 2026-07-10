import { NextResponse } from 'next/server';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { checkAccess } from '@/lib/server/guard';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

export const maxDuration = 300;

/**
 * Stateless audit stage. SECURITY: `verified` and the gate evidence are
 * re-computed HERE, server-side, on the submitted listing — a client-carried
 * gateResult is never trusted. Idempotent: same input → same output.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  let body: { snapshot?: ListingSnapshot; listing?: OptimizedListing };
  try {
    body = (await req.json()) as { snapshot?: ListingSnapshot; listing?: OptimizedListing };
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title || !body.listing?.title) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing snapshot or listing.' }, { status: 400 });
  }
  const detection = detectCategory(body.snapshot);
  const pack = loadPack(detection.packId);
  const ctx = { subcategories: detection.subcategories, snapshotText: `${body.snapshot.title} ${body.snapshot.category}` };
  const audit = buildAudit(body.snapshot, body.listing, pack, ctx);
  return NextResponse.json({ audit, detection });
}
