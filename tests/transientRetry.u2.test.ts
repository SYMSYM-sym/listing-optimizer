import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import {
  generateGroup,
  isTransientUpstreamFailure,
  recordUpstreamFailures,
  retryAfterMs,
  transientBackoffMs,
  withTransientRetry,
  TRANSIENT_BASE_DELAY_MS,
  TRANSIENT_JITTER_FRACTION,
  TRANSIENT_MAX_ATTEMPTS,
  TRANSIENT_MAX_DELAY_MS,
  TRANSIENT_MAX_RETRY_AFTER_MS,
  type LlmClient,
} from '@/lib/engine/llm';
import { ALL_GROUPS } from '@/lib/engine/optimize';
import { runPipeline } from '@/lib/pipeline/run';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { z } from 'zod';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * U2 — A TRANSIENT UPSTREAM ERROR MUST NOT NUKE THE WHOLE GROUP.
 *
 * Before this, ANY error degraded the group after the boundary's one reparse
 * retry, and every degraded group blocks via `GEN`, so a single blip cost the
 * entire run. That is the right answer for the billing 400 that caused the
 * outage — an exhausted balance will reject the next call exactly as it
 * rejected this one — and the wrong answer for a 429, a 529, a reset connection
 * or a read timeout, each of which is a statement about this moment only.
 *
 * The four properties this suite exists to pin:
 *
 *   RECOVERS   a 429 then a success -> the group succeeds, the run verifies
 *              normally, and the retry is in the log.
 *   FAILS      a persistent 529 -> the cap is exhausted, the group degrades,
 *              `GEN` blocks, `verified:false` — EXACTLY as today.
 *   NEVER      a 400 -> ZERO retries. Asserted on the CALL COUNT, because
 *              "it degraded" is equally true of a policy that retried three
 *              times first and burned three calls against an unpayable account.
 *   BOUNDED    the deadline wins over the retry, and the backoff is exact
 *              under an injected clock and an injected random.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

// ---------------------------------------------------------------------------
// Log capture — `logServer` writes one JSON line to console.info.
// ---------------------------------------------------------------------------

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface LogLine {
  event: string;
  [k: string]: unknown;
}

const events = (name: string): LogLine[] =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l) as LogLine;
      } catch {
        return null;
      }
    })
    .filter((e): e is LogLine => e !== null && e.event === name);

// ---------------------------------------------------------------------------
// Errors built by the SDK's OWN factory, so the shape under test is production's
// ---------------------------------------------------------------------------

function apiError(status: number, apiType: string, headers?: Record<string, string>): APIError {
  return APIError.generate(
    status,
    { type: 'error', error: { type: apiType, message: `synthetic ${status}` } },
    undefined,
    new Headers({ 'request-id': `req_u2_${status}`, ...(headers ?? {}) }),
  );
}

/** The live outage: an exhausted credit balance. Retrying it is pure waste. */
const CREDIT_BALANCE_400 = apiError(400, 'invalid_request_error');

/** Deterministic injections — a backoff test that calls Math.random is flaky. */
const noJitter = () => 0;
const fullJitter = () => 1;
const neverSleeps = async () => {};

/** A clock that advances a fixed amount per read, so `now()` is reproducible. */
function fakeClock(start = 1_000_000, stepMs = 0): () => number {
  let t = start;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

/** Fails `failures` times with `e`, then answers `ok`. Counts every call. */
function flaky(e: unknown, failures: number, ok = '{"ok":true}') {
  const calls: string[] = [];
  const llm: LlmClient = async (req) => {
    calls.push(req.groupName ?? 'unknown');
    if (calls.length <= failures) throw e;
    return ok;
  };
  return { llm, calls };
}

const call = (llm: LlmClient) => llm({ system: 's', user: 'u', maxTokens: 10, groupName: 'title' });

// ===========================================================================
// 1 — CLASSIFICATION. Which failures are momentary, and which are decided.
// ===========================================================================

describe('U2 §1 — the transient classes, named rather than ranged', () => {
  it.each([429, 529, 500, 502, 503, 504, 408, 409])('status %s is transient', (status) => {
    expect(isTransientUpstreamFailure(apiError(status, 'overloaded_error'))).toBe(true);
  });

  it.each([400, 401, 403, 404])('status %s is NEVER transient', (status) => {
    expect(isTransientUpstreamFailure(apiError(status, 'invalid_request_error'))).toBe(false);
  });

  it('the connection classes are transient — neither ever got a response', () => {
    expect(isTransientUpstreamFailure(new APIConnectionError({ message: 'socket hang up' }))).toBe(true);
    expect(isTransientUpstreamFailure(new APIConnectionTimeoutError())).toBe(true);
  });

  it('an abort is a DECISION and is never retried', () => {
    expect(isTransientUpstreamFailure(new APIUserAbortError())).toBe(false);
  });

  it('anything that is not an SDK error fails closed — unknown means permanent', () => {
    expect(isTransientUpstreamFailure(new Error('LLM returned no text content'))).toBe(false);
    expect(isTransientUpstreamFailure(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isTransientUpstreamFailure('not an error')).toBe(false);
    expect(isTransientUpstreamFailure(undefined)).toBe(false);
  });

  it('the billing 400 that caused the outage is on the never list', () => {
    expect(isTransientUpstreamFailure(CREDIT_BALANCE_400)).toBe(false);
  });
});

// ===========================================================================
// 2 — RECOVERS. A 429 then a success: the group succeeds and the run verifies.
// ===========================================================================

describe('U2 §2 — a 429 then a success', () => {
  it('the call succeeds on the retry and returns the SECOND response', async () => {
    const { llm, calls } = flaky(apiError(429, 'rate_limit_error'), 1);
    const wrapped = withTransientRetry(llm, { random: noJitter, sleep: neverSleeps });
    await expect(call(wrapped)).resolves.toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
  });

  it('the retry is LOGGED, with attempt, status and the backoff it waited', async () => {
    const { llm } = flaky(apiError(429, 'rate_limit_error'), 1);
    await call(withTransientRetry(llm, { random: noJitter, sleep: neverSleeps }));
    const [retry] = events('llm.retry');
    expect(retry).toBeDefined();
    expect(retry!.group).toBe('title');
    expect(retry!.attempt).toBe(1);
    expect(retry!.nextAttempt).toBe(2);
    expect(retry!.maxAttempts).toBe(TRANSIENT_MAX_ATTEMPTS);
    expect(retry!.status).toBe(429);
    expect(retry!.apiType).toBe('rate_limit_error');
    expect(retry!.backoffMs).toBe(TRANSIENT_BASE_DELAY_MS);
  });

  it('a retried-and-recovered call reads DIFFERENTLY from a first-try success', async () => {
    const { llm } = flaky(apiError(429, 'rate_limit_error'), 1);
    await call(withTransientRetry(llm, { random: noJitter, sleep: neverSleeps }));
    expect(events('llm.retry')).toHaveLength(1);
    lines = [];
    // A first-try success writes no retry line at all — that is the difference.
    await call(withTransientRetry(flaky(null, 0).llm, { sleep: neverSleeps }));
    expect(events('llm.retry')).toEqual([]);
  });

  it('THE RUN: one 429 on the first call and the whole run still verifies', async () => {
    let thrown = false;
    const oneBlip: LlmClient = async (req) => {
      if (!thrown) {
        thrown = true;
        throw apiError(429, 'rate_limit_error');
      }
      return mockLlm(req);
    };
    const result = await runPipeline(
      snapshot,
      withTransientRetry(oneBlip, { random: noJitter, sleep: neverSleeps }),
      1,
    );
    // Byte-for-byte the healthy outcome: before U2 this run degraded a group,
    // `GEN` blocked it, and it came back unverified.
    expect(result.audit.verified).toBe(true);
    expect(result.audit.gateResult.failures).toEqual([]);
    expect('degradedGroups' in result.optimized).toBe(false);
    expect(events('llm.retry')).toHaveLength(1);
  });

  it('a transient blip that recovered leaves NO generationFailure on the response', async () => {
    // The composition the routes use: recorder OUTSIDE, retry INSIDE. Reversed,
    // the operator would get U1's "generation failed upstream" banner on a run
    // that completed perfectly.
    const { llm } = flaky(apiError(429, 'rate_limit_error'), 1);
    const gen = recordUpstreamFailures(
      withTransientRetry(llm, { random: noJitter, sleep: neverSleeps }),
    );
    await expect(call(gen.llm)).resolves.toBe('{"ok":true}');
    expect(gen.firstFailure()).toBeNull();
  });
});

// ===========================================================================
// 3 — FAILS. A persistent 529 exhausts the cap and degrades exactly as today.
// ===========================================================================

describe('U2 §3 — a persistent 529 exhausts the cap and nothing else changes', () => {
  it('makes exactly TRANSIENT_MAX_ATTEMPTS calls, then rethrows the error UNCHANGED', async () => {
    const overloaded = apiError(529, 'overloaded_error');
    const { llm, calls } = flaky(overloaded, Number.POSITIVE_INFINITY);
    const wrapped = withTransientRetry(llm, { random: noJitter, sleep: neverSleeps });
    await expect(call(wrapped)).rejects.toBe(overloaded);
    expect(calls).toHaveLength(TRANSIENT_MAX_ATTEMPTS);
    expect(events('llm.retry')).toHaveLength(TRANSIENT_MAX_ATTEMPTS - 1);
  });

  it('THE RUN: every group degrades, GEN blocks, verified:false — as before', async () => {
    const overloaded = apiError(529, 'overloaded_error');
    const always: LlmClient = async () => {
      throw overloaded;
    };
    const result = await runPipeline(
      snapshot,
      withTransientRetry(always, { random: noJitter, sleep: neverSleeps }),
      0,
    );
    expect(result.audit.verified).toBe(false);
    expect(result.optimized.state).toBe('draft');
    expect([...(result.optimized.degradedGroups ?? [])].sort()).toEqual([...ALL_GROUPS].sort());
    expect(
      result.audit.gateResult.failures
        .filter((f) => f.checkId === 'GEN')
        .map((f) => f.field)
        .sort(),
    ).toEqual(ALL_GROUPS.map((g) => `generation.${g}`).sort());
    expect(result.audit.gateResult.failures.filter((f) => f.checkId === 'GATE')).toHaveLength(0);
  });
});

// ===========================================================================
// 4 — NEVER. A 400 is not sent twice. Asserted on the CALL COUNT.
// ===========================================================================

describe('U2 §4 — a 400 is retried ZERO times', () => {
  it('exactly ONE call is made, and it is the only one', async () => {
    const { llm, calls } = flaky(CREDIT_BALANCE_400, Number.POSITIVE_INFINITY);
    const wrapped = withTransientRetry(llm, { random: noJitter, sleep: neverSleeps });
    await expect(call(wrapped)).rejects.toBe(CREDIT_BALANCE_400);
    // THE ASSERTION THIS SECTION EXISTS FOR. "It degraded" is equally true of a
    // policy that burned three calls against an account that cannot pay first.
    expect(calls).toHaveLength(1);
    expect(events('llm.retry')).toEqual([]);
  });

  it.each([401, 403, 404])('status %s is also sent exactly once', async (status) => {
    const e = apiError(status, 'authentication_error');
    const { llm, calls } = flaky(e, Number.POSITIVE_INFINITY);
    await expect(call(withTransientRetry(llm, { sleep: neverSleeps }))).rejects.toBe(e);
    expect(calls).toHaveLength(1);
  });

  it('a 400 still degrades IMMEDIATELY, with no wasted round trip', async () => {
    const { llm, calls } = flaky(CREDIT_BALANCE_400, Number.POSITIVE_INFINITY);
    const result = await runPipeline(
      snapshot,
      withTransientRetry(llm, { sleep: neverSleeps }),
      0,
    );
    expect(result.audit.verified).toBe(false);
    expect([...(result.optimized.degradedGroups ?? [])].sort()).toEqual([...ALL_GROUPS].sort());
    /**
     * UPDATED BY V2, and the old number was the honest one.
     *
     * This pinned `ALL_GROUPS.length * 2` — nine groups x TWO calls — while
     * U2's commit message claimed a 400 was "sent EXACTLY ONCE". The test was
     * right and the claim was false: the second call was the boundary's
     * reparse retry, which re-attempted ANY error including a transport one,
     * so the billing outage cost 18 calls per run against an account that
     * could not pay for the first nine.
     *
     * V2 scopes the reparse retry to the classes `classify` calls
     * model-derived, so a transport failure now goes straight to the degrade
     * path. ONE call per group. The claim is true now; see
     * CONFORMANCE-DEVIATIONS §15.4.
     */
    expect(calls).toHaveLength(ALL_GROUPS.length);
  });

  it('a schema failure still gets its own single reparse retry, and U2 does not multiply it', async () => {
    // The call SUCCEEDS and the output will not parse. That happens above this
    // wrapper and already has its own single retry with the error fed back to
    // the model — which V2 left exactly as it was; it only removed the
    // TRANSPORT classes from that retry.
    const calls: string[] = [];
    const unparseable: LlmClient = async () => {
      calls.push('x');
      return 'this is not JSON at all';
    };
    const wrapped = withTransientRetry(unparseable, { sleep: neverSleeps });
    await expect(
      generateGroup(wrapped, 'title', 's', 'u', z.object({ title: z.string() }), 100),
    ).rejects.toThrow();
    // 2 = the boundary's own attempt + its one reparse retry. Never 3, never 6.
    expect(calls).toHaveLength(2);
    expect(events('llm.retry')).toEqual([]);
  });
});

// ===========================================================================
// 5 — BOUNDED. Backoff, jitter and `retry-after`, exact under injection.
// ===========================================================================

describe('U2 §5 — the backoff is bounded and deterministic', () => {
  it('doubles per retry and is clamped at the ceiling', () => {
    expect(transientBackoffMs(1, noJitter)).toBe(TRANSIENT_BASE_DELAY_MS);
    expect(transientBackoffMs(2, noJitter)).toBe(TRANSIENT_BASE_DELAY_MS * 2);
    expect(transientBackoffMs(3, noJitter)).toBe(TRANSIENT_BASE_DELAY_MS * 4);
    expect(transientBackoffMs(20, noJitter)).toBe(TRANSIENT_MAX_DELAY_MS);
  });

  it('jitter SUBTRACTS, so a wait can never exceed the value already checked', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const ceiling = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1), TRANSIENT_MAX_DELAY_MS);
      const floor = Math.round(ceiling * (1 - TRANSIENT_JITTER_FRACTION));
      expect(transientBackoffMs(attempt, fullJitter)).toBe(floor);
      expect(transientBackoffMs(attempt, noJitter)).toBe(ceiling);
      for (const r of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
        const v = transientBackoffMs(attempt, () => r);
        expect(v).toBeGreaterThanOrEqual(floor);
        expect(v).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('the wrapper waits exactly the computed backoff, in order', async () => {
    const slept: number[] = [];
    const { llm } = flaky(apiError(529, 'overloaded_error'), Number.POSITIVE_INFINITY);
    await call(
      withTransientRetry(llm, {
        random: noJitter,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).catch(() => {});
    expect(slept).toEqual([TRANSIENT_BASE_DELAY_MS, TRANSIENT_BASE_DELAY_MS * 2]);
  });
});

describe('U2 §5b — retry-after, read from the field the installed SDK actually exposes', () => {
  it('delta-seconds on `retry-after` is honoured', () => {
    const e = apiError(429, 'rate_limit_error', { 'retry-after': '2' });
    expect(retryAfterMs(e, () => 0)).toBe(2000);
  });

  it('`retry-after-ms` wins over `retry-after`, as it does in the SDK', () => {
    const e = apiError(429, 'rate_limit_error', { 'retry-after-ms': '1500', 'retry-after': '9' });
    expect(retryAfterMs(e, () => 0)).toBe(1500);
  });

  it('an HTTP-date `retry-after` is resolved against the injected clock', () => {
    const now = Date.parse('2026-08-17T12:00:00Z');
    const e = apiError(529, 'overloaded_error', {
      'retry-after': new Date(now + 3000).toUTCString(),
    });
    expect(retryAfterMs(e, () => now)).toBe(3000);
  });

  it('an error with no headers at all asks for nothing', () => {
    expect(retryAfterMs(new APIConnectionTimeoutError(), () => 0)).toBeNull();
    expect(retryAfterMs(apiError(429, 'rate_limit_error'), () => 0)).toBeNull();
    expect(retryAfterMs(new Error('plain'), () => 0)).toBeNull();
  });

  it('the wrapper waits what the server asked for, not what it computed', async () => {
    const slept: number[] = [];
    const { llm } = flaky(apiError(429, 'rate_limit_error', { 'retry-after': '3' }), 1);
    await call(
      withTransientRetry(llm, {
        random: noJitter,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    );
    expect(slept).toEqual([3000]);
    expect(events('llm.retry')[0]!.retryAfterMs).toBe(3000);
  });

  it('a retry-after beyond the ceiling is honoured by GIVING UP, not by retrying early', async () => {
    const e = apiError(429, 'rate_limit_error', {
      'retry-after': String(TRANSIENT_MAX_RETRY_AFTER_MS / 1000 + 60),
    });
    const { llm, calls } = flaky(e, Number.POSITIVE_INFINITY);
    await expect(call(withTransientRetry(llm, { sleep: neverSleeps }))).rejects.toBe(e);
    expect(calls).toHaveLength(1);
    expect(events('llm.retry')).toEqual([]);
    expect(events('llm.retry_declined')).toHaveLength(1);
  });
});

// ===========================================================================
// 6 — THE DEADLINE WINS. A retry may never push the run past D5's mark.
// ===========================================================================

describe('U2 §6 — a retry that would overrun the run deadline is not taken', () => {
  it('stops early rather than overrunning, and says so in the log', async () => {
    // The clock does not move; the deadline is 100ms away and the backoff is
    // 500ms. Waiting it out would land past the mark.
    const { llm, calls } = flaky(apiError(529, 'overloaded_error'), Number.POSITIVE_INFINITY);
    const start = 5_000_000;
    const wrapped = withTransientRetry(llm, {
      deadline: start + 100,
      now: () => start,
      random: noJitter,
      sleep: async () => {
        throw new Error('slept past the deadline — the retry should not have been taken');
      },
    });
    await expect(call(wrapped)).rejects.toMatchObject({ status: 529 });
    expect(calls).toHaveLength(1);
    const [stop] = events('llm.retry_deadline_stop');
    expect(stop).toBeDefined();
    expect(stop!.backoffMs).toBe(TRANSIENT_BASE_DELAY_MS);
    expect(stop!.status).toBe(529);
    expect(events('llm.retry')).toEqual([]);
  });

  it('the projection covers the CALL as well as the wait, not just the wait', async () => {
    // Backoff 500ms fits in the 900ms remaining; the attempt that just failed
    // took 800ms, so the retry would land ~1300ms out. It must not be taken.
    const start = 5_000_000;
    const clock = fakeClock(start, 800);
    const { llm, calls } = flaky(apiError(529, 'overloaded_error'), Number.POSITIVE_INFINITY);
    const wrapped = withTransientRetry(llm, {
      deadline: start + 900,
      now: clock,
      random: noJitter,
      sleep: neverSleeps,
    });
    await expect(call(wrapped)).rejects.toMatchObject({ status: 529 });
    expect(calls).toHaveLength(1);
    expect(events('llm.retry_deadline_stop')).toHaveLength(1);
  });

  it('a deadline far in the future changes nothing — the retry happens as normal', async () => {
    const { llm, calls } = flaky(apiError(429, 'rate_limit_error'), 1);
    const wrapped = withTransientRetry(llm, {
      deadline: Date.now() + 10 * 60 * 1000,
      random: noJitter,
      sleep: neverSleeps,
    });
    await expect(call(wrapped)).resolves.toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
    expect(events('llm.retry')).toHaveLength(1);
  });

  it('with NO deadline the wrapper spends its whole attempt budget', async () => {
    const { llm, calls } = flaky(apiError(529, 'overloaded_error'), Number.POSITIVE_INFINITY);
    await call(withTransientRetry(llm, { random: noJitter, sleep: neverSleeps })).catch(() => {});
    expect(calls).toHaveLength(TRANSIENT_MAX_ATTEMPTS);
    expect(events('llm.retry_deadline_stop')).toEqual([]);
  });
});

// ===========================================================================
// 7 — THE WIRE. Both routes apply the policy, with the recorder OUTSIDE.
// ===========================================================================

describe('U2 §7 — both routes are wired, and the SDK is not retrying underneath', () => {
  const src = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  it.each(['app/api/optimize/route.ts', 'app/api/regenerate/route.ts'])(
    '%s wraps the client with the deadline, recorder outside',
    (file) => {
      const s = src(file);
      expect(s).toContain('recordUpstreamFailures(');
      expect(s).toContain('withTransientRetry(anthropicClient(), { deadline })');
    },
  );

  it('the SDK client is constructed with maxRetries: 0 — one retry authority', () => {
    // Leaving the SDK's default 2 on underneath would multiply to up to nine
    // calls per group, with its sleeps invisible to the run deadline.
    expect(src('lib/engine/llm.ts')).toContain('maxRetries: 0');
  });
});
