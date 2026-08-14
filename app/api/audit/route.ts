import { NextResponse } from 'next/server';
import { buildAudit } from '@/lib/audit/buildAudit';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
import { normalizePanelFacts } from '@/lib/knowledge/panelFacts';
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
  let body: {
    snapshot?: ListingSnapshot;
    listing?: OptimizedListing;
    fictionPhrases?: string[];
    /** WS5.5 — operator-confirmed label values; product truth for this audit. */
    panelFacts?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title || !body.listing?.title) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing snapshot or listing.' }, { status: 400 });
  }
  const detection = detectCategory(body.snapshot);
  // R45: operator-supplied known-false descriptors apply to THIS audit only.
  const pack = withOperatorFictionPhrases(loadPack(detection.packId), body.fictionPhrases);
  const ctx = { subcategories: detection.subcategories, snapshotText: `${body.snapshot.title} ${body.snapshot.category}` };
  // WS5.5 — a confirmed panel is PRODUCT TRUTH: the audit re-derives the
  // canonical facts from it rather than trusting the facts block that arrived
  // with a client-supplied listing. Absent => identical to before.
  const panelFacts = normalizePanelFacts(body.panelFacts);
  const audit = buildAudit(body.snapshot, body.listing, pack, ctx, {
    ...(panelFacts ? { panelFacts } : {}),
  });
  return NextResponse.json({ audit, detection });
}
