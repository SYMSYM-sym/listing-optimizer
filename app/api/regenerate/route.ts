import { NextResponse } from 'next/server';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize, type GroupName, ALL_GROUPS } from '@/lib/engine/optimize';
import { anthropicClient } from '@/lib/engine/llm';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import { checkAccess } from '@/lib/server/guard';
import { logServer } from '@/lib/server/log';
import { updateRun } from '@/lib/store/runs';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

export const maxDuration = 300;

const GROUP_SET = new Set<string>(ALL_GROUPS);

/**
 * Regenerate ONE engine group over an existing listing, re-run buildAudit
 * (worker ≠ checker), optionally persist back to a saved run.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const denied = checkAccess(req);
  if (denied) return denied as NextResponse;
  let body: {
    snapshot?: ListingSnapshot;
    listing?: OptimizedListing;
    group?: string;
    runId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body.snapshot?.title || !body.listing?.title) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', message: 'Missing snapshot or listing.' },
      { status: 400 },
    );
  }
  if (!body.group || !GROUP_SET.has(body.group)) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        message: `group must be one of: ${ALL_GROUPS.join(', ')}`,
      },
      { status: 400 },
    );
  }
  const group = body.group as GroupName;
  try {
    const detection = detectCategory(body.snapshot);
    const pack = loadPack(detection.packId);
    const enriched: ListingSnapshot = {
      ...body.snapshot,
      subcategory: detection.subcategories,
    };
    const ctx = {
      subcategories: detection.subcategories,
      snapshotText: `${body.snapshot.title} ${body.snapshot.category}`,
    };
    const merged = await optimize(enriched, pack, anthropicClient(), {
      groups: [group],
      base: body.listing,
    });
    const audit = buildAudit(enriched, merged, pack, ctx);
    const optimized: OptimizedListing = {
      ...merged,
      state: audit.verified ? 'verified' : 'draft',
    };

    if (body.runId) {
      try {
        await updateRun(body.runId, {
          optimized,
          audit,
          verified: audit.verified,
          score: audit.scorecard.total,
          gaps: audit.gaps.length,
          failureIds: audit.gateResult.failures.map((f) => f.checkId),
          productName: optimized.productName,
        });
      } catch (e) {
        logServer('store.error', {
          op: 'updateRun',
          message: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      }
    }

    return NextResponse.json({
      optimized,
      audit,
      detection,
      gateResult: audit.gateResult,
      group,
    });
  } catch (e) {
    return NextResponse.json(
      { code: 'ENGINE_ERROR', message: e instanceof Error ? e.message : 'Regenerate failed.' },
      { status: 502 },
    );
  }
}
