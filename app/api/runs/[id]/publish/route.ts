import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/server/guard';
import { logServer } from '@/lib/server/log';
import { getRun, publishRun } from '@/lib/store/runs';

export const maxDuration = 30;

/**
 * POST /api/runs/[id]/publish — record a stored run as PUBLISHED (WS6).
 *
 * WHY THIS ROUTE EXISTS. `ElementState` has carried a `'published'` member
 * since the output contract was written and nothing ever set it: a run that
 * had genuinely gone live on Amazon looked exactly like one still sitting in a
 * browser tab, which is precisely the "partially-entered states are invisible"
 * problem the element registry exists to prevent.
 *
 * THE GUARD, and where it lives. Publishing is allowed ONLY when the STORED
 * `audit.verified` is true. That flag is not client-carried and not
 * re-asserted here from anything the caller sent: it was written by the audit
 * module re-running the gate server-side (`verified === gateResult.pass`), so
 * the decision this route makes is a read of a server-derived fact. A run that
 * failed the gate cannot be marked published by anyone holding the token.
 *
 * IDEMPOTENT: publishing an already-published run returns the ORIGINAL
 * timestamp and writes nothing. A second click must never move the date of an
 * event that already happened.
 *
 * Behind `requireAccess` — the MANDATORY-token guard, like every other history
 * route: this mutates stored state.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireAccess(req);
  if (denied) return denied as NextResponse;
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ code: 'BAD_REQUEST', message: 'Missing run id.' }, { status: 400 });
  }

  let run;
  try {
    run = await getRun(id);
  } catch (e) {
    return NextResponse.json(
      { code: 'STORE_ERROR', message: e instanceof Error ? e.message : 'getRun failed' },
      { status: 502 },
    );
  }
  if (!run) {
    return NextResponse.json({ code: 'NOT_FOUND', message: 'Run not found.' }, { status: 404 });
  }

  if (run.published_at) {
    return NextResponse.json({
      runId: id,
      publishedAt: run.published_at,
      state: 'published',
      alreadyPublished: true,
    });
  }

  // THE ONE RULE. `audit.verified` is server-derived (=== gateResult.pass);
  // nothing the caller sent is consulted.
  if (run.audit?.verified !== true) {
    const failures = run.audit?.gateResult?.failures ?? [];
    return NextResponse.json(
      {
        code: 'NOT_VERIFIED',
        message:
          'This run did not pass the gate, so it cannot be recorded as published. Fix the blocking failures and re-run.',
        failureIds: [...new Set(failures.map((f) => f.checkId))],
      },
      { status: 409 },
    );
  }

  const publishedAt = new Date().toISOString();
  const optimized = { ...run.optimized, state: 'published' as const };
  try {
    const recorded = await publishRun(id, optimized, publishedAt);
    if (recorded === null) {
      return NextResponse.json(
        {
          code: 'STORE_DISABLED',
          message: 'The run store is not configured on this server, so publish state cannot be recorded.',
        },
        { status: 503 },
      );
    }
    logServer('run.published', { runId: id, publishedAt: recorded });
    return NextResponse.json({ runId: id, publishedAt: recorded, state: 'published' });
  } catch (e) {
    return NextResponse.json(
      { code: 'STORE_ERROR', message: e instanceof Error ? e.message : 'publishRun failed' },
      { status: 502 },
    );
  }
}
