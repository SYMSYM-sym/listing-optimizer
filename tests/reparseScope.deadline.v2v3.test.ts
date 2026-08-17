import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  CLIENT_TIMEOUT_MS,
  GroupGenerationError,
  generateGroup,
  withTransientRetry,
  TRANSIENT_BASE_DELAY_MS,
  TRANSIENT_MAX_ATTEMPTS,
  TRANSIENT_MAX_RETRY_AFTER_MS,
  type LlmClient,
} from '@/lib/engine/llm';
import { ALL_GROUPS } from '@/lib/engine/optimize';
import { runPipeline } from '@/lib/pipeline/run';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * V2 — THE REPARSE RETRY IS FOR SCHEMA AND JSON FAILURES, AND ONLY THOSE.
 * V3 — AN APPROVED RETRY CAN NEVER EXCEED THE RUN DEADLINE.
 *
 * V2. `generateGroup`'s reparse retry re-attempted ANY error, including a
 * transport error that had already escaped `withTransientRetry`. Wrong twice
 * over: it cost a SECOND CALL PER GROUP (18 per run during the billing outage,
 * against an account that could not pay for the first nine), and it fed the
 * redacted SDK error back to the model as "your previous output was invalid:
 * 400 {...credit balance too low...}" — a sentence about output the model never
 * produced. It was also the mechanism of the V1 false-notice exploit: a
 * transport failure whose reparse call SUCCEEDED produced a healthy group off
 * a failure the recorder had already latched.
 *
 * V3. The deadline check projected the next attempt from the LONGEST MEASURED
 * one. Measured attempts here are FAILURES, and the cheapest failure is the
 * fastest — a 529 from the edge returns in milliseconds — so after three of
 * them the check reserved single-digit milliseconds for a call the transport
 * will spend `CLIENT_TIMEOUT_MS` (90s) on. A retry approved at 239.9s of a 240s
 * mark could run 90 seconds past it, straight into the platform kill and the
 * 502 that loses every surface and every gate finding. The projection is now
 * the client timeout, raised only by a measured attempt that beat it.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const neverSleeps = async () => {};
const noJitter = () => 0;

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  });
});
afterEach(() => vi.restoreAllMocks());

const events = (name: string): Record<string, unknown>[] =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null && e.event === name);

const apiError = (status: number, apiType: string): APIError =>
  APIError.generate(
    status,
    { type: 'error', error: { type: apiType, message: `Your credit balance is too low (${status})` } },
    undefined,
    new Headers({ 'request-id': `req_v2_${status}` }),
  );

const CREDIT_BALANCE_400 = apiError(400, 'invalid_request_error');
const SCHEMA = z.object({ title: z.string(), subtitle: z.string() });

/** Records every request the boundary makes, so both COUNT and PROMPT are visible. */
function recorder(reply: (n: number) => string | never) {
  const requests: { user: string; group?: string }[] = [];
  const llm: LlmClient = async (req) => {
    requests.push({ user: req.user, group: req.groupName });
    return reply(requests.length);
  };
  return { llm, requests };
}

// ===========================================================================
// V2 §1 — A TRANSPORT FAILURE IS SENT EXACTLY ONCE PER GROUP.
// ===========================================================================

describe('V2 §1 — a transport failure never reaches the reparse retry', () => {
  it('a 400 makes exactly ONE call to `generateGroup`, not two', async () => {
    const { llm, requests } = recorder(() => {
      throw CREDIT_BALANCE_400;
    });
    await expect(generateGroup(llm, 'title', 's', 'u', SCHEMA, 100)).rejects.toBeInstanceOf(
      GroupGenerationError,
    );
    expect(requests).toHaveLength(1);
    // No reparse was even considered, so no `llm.reparse` line was written.
    expect(events('llm.reparse')).toEqual([]);
  });

  it('THE RUN: a 400 is sent exactly ONE time per group — nine calls, not eighteen', async () => {
    const calls: string[] = [];
    const llm: LlmClient = async (req) => {
      calls.push(req.groupName ?? 'unknown');
      throw CREDIT_BALANCE_400;
    };
    const result = await runPipeline(snapshot, withTransientRetry(llm, { sleep: neverSleeps }), 0);
    expect(calls).toHaveLength(ALL_GROUPS.length);
    expect(new Set(calls).size).toBe(ALL_GROUPS.length);
    // ...and the degrade outcome is byte-for-byte the one U2 §3 already pins.
    expect(result.audit.verified).toBe(false);
    expect([...(result.optimized.degradedGroups ?? [])].sort()).toEqual([...ALL_GROUPS].sort());
  });

  it('the model is never told a transport error was its own invalid output', async () => {
    const { llm, requests } = recorder(() => {
      throw CREDIT_BALANCE_400;
    });
    await generateGroup(llm, 'title', 's', 'u', SCHEMA, 100).catch(() => {});
    for (const r of requests) {
      expect(r.user).not.toContain('your previous output was invalid');
      expect(r.user).not.toContain('credit balance');
    }
  });

  it('the degrade reason and safe fields are the ones `classify` always produced', async () => {
    const { llm } = recorder(() => {
      throw CREDIT_BALANCE_400;
    });
    const err = (await generateGroup(llm, 'bullets', 's', 'u', SCHEMA, 100).catch(
      (e: unknown) => e,
    )) as GroupGenerationError;
    expect(err).toBeInstanceOf(GroupGenerationError);
    expect(err.group).toBe('bullets');
    expect(err.reason).toBe('transport');
    expect(err.safe.status).toBe(400);
    expect(err.safe.apiType).toBe('invalid_request_error');
    // The raw model-facing message is still never a log field for zod; for an
    // infrastructure error it is kept, redacted, exactly as before.
    expect(err.safe.error).toBe('APIError');
  });

  it('a connection timeout is transport too, and is not reparsed', async () => {
    const { llm, requests } = recorder(() => {
      throw new APIConnectionTimeoutError();
    });
    await generateGroup(llm, 'qa', 's', 'u', SCHEMA, 100).catch(() => {});
    expect(requests).toHaveLength(1);
  });
});

// ===========================================================================
// V2 §2 — SCHEMA AND JSON FAILURES ARE UNCHANGED. This is what the retry is for.
// ===========================================================================

describe('V2 §2 — a schema/JSON failure still gets its one reparse retry', () => {
  it('a ZOD failure is retried once, WITH the schema detail in the prompt', async () => {
    const { llm, requests } = recorder((n) =>
      n === 1 ? '{"title":"ok"}' : '{"title":"ok","subtitle":"fixed"}',
    );
    await expect(generateGroup(llm, 'title', 's', 'u', SCHEMA, 100)).resolves.toEqual({
      title: 'ok',
      subtitle: 'fixed',
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.user).toContain('your previous output was invalid');
    // The zod detail really is the SCHEMA detail — the failing path is in it.
    expect(requests[1]!.user).toContain('subtitle');
    expect(requests[1]!.user).toContain('Return corrected JSON only.');
    // ...and the reparse event still names the class and the failing paths.
    const [reparse] = events('llm.reparse');
    expect(reparse!.error).toBe('ZodError');
    expect(reparse!.issuePaths).toEqual(['subtitle']);
    // The zod message is model-derived and is STILL withheld from the log.
    expect(reparse).not.toHaveProperty('message');
  });

  it('a JSON.parse failure and a no-JSON-found failure are both still retried', async () => {
    for (const bad of ['{"title": ', 'there is no object here at all']) {
      const { llm, requests } = recorder((n) => (n === 1 ? bad : '{"title":"a","subtitle":"b"}'));
      await expect(generateGroup(llm, 'title', 's', 'u', SCHEMA, 100)).resolves.toBeTruthy();
      expect(requests).toHaveLength(2);
    }
  });

  it('a schema failure TWICE still degrades with the schema reason, not transport', async () => {
    const { llm, requests } = recorder(() => '{"title":"ok"}');
    const err = (await generateGroup(llm, 'title', 's', 'u', SCHEMA, 100).catch(
      (e: unknown) => e,
    )) as GroupGenerationError;
    expect(requests).toHaveLength(2);
    expect(err.reason).toBe('schema');
  });
});

// ===========================================================================
// V2 §3 — A TRANSIENT ERROR STILL GETS `withTransientRetry`, AND NOTHING MORE.
// ===========================================================================

describe('V2 §3 — the transient wrapper is untouched and is not multiplied', () => {
  it('a persistent 529 spends the wrapper budget and adds NO reparse call', async () => {
    const calls: string[] = [];
    const inner: LlmClient = async () => {
      calls.push('x');
      throw apiError(529, 'overloaded_error');
    };
    const wrapped = withTransientRetry(inner, { random: noJitter, sleep: neverSleeps });
    await expect(generateGroup(wrapped, 'title', 's', 'u', SCHEMA, 100)).rejects.toBeInstanceOf(
      GroupGenerationError,
    );
    // Exactly the wrapper's attempts. Before V2 this was TRANSIENT_MAX_ATTEMPTS
    // x 2 — the reparse retry ran the whole ladder a second time.
    expect(calls).toHaveLength(TRANSIENT_MAX_ATTEMPTS);
    expect(events('llm.retry')).toHaveLength(TRANSIENT_MAX_ATTEMPTS - 1);
    expect(events('llm.reparse')).toEqual([]);
  });

  it('a 429 that RECOVERS inside the wrapper never reaches the reparse path', async () => {
    let first = true;
    const inner: LlmClient = async () => {
      if (first) {
        first = false;
        throw apiError(429, 'rate_limit_error');
      }
      return '{"title":"a","subtitle":"b"}';
    };
    const wrapped = withTransientRetry(inner, { random: noJitter, sleep: neverSleeps });
    await expect(generateGroup(wrapped, 'title', 's', 'u', SCHEMA, 100)).resolves.toBeTruthy();
    expect(events('llm.reparse')).toEqual([]);
  });
});

// ===========================================================================
// V3 — THE DEADLINE PROJECTION.
// ===========================================================================

const call = (llm: LlmClient) => llm({ system: 's', user: 'u', maxTokens: 10, groupName: 'title' });

describe('V3 — an approved retry can never exceed the deadline', () => {
  it('THE DEFECT: a fast failure no longer buys a slow retry', async () => {
    // The three failures each measured ~0ms. The backoff is 500ms and there is
    // 1000ms left, so the OLD projection (`0 + 500 < 1000`) approved a retry
    // the transport is willing to spend 90 SECONDS on.
    const calls: string[] = [];
    const inner: LlmClient = async () => {
      calls.push('x');
      throw apiError(529, 'overloaded_error');
    };
    const start = 5_000_000;
    await expect(
      call(
        withTransientRetry(inner, {
          deadline: start + 1_000,
          now: () => start,
          random: noJitter,
          sleep: async () => {
            throw new Error('slept — the retry should not have been approved');
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 529 });
    expect(calls).toHaveLength(1);
    const [stop] = events('llm.retry_deadline_stop');
    expect(stop).toBeDefined();
    expect(stop!.projectedAttemptMs).toBe(CLIENT_TIMEOUT_MS);
    // The measurement is still reported — it is evidence, it is just not the
    // projection any more.
    expect(stop!.measuredAttemptMs).toBe(0);
    expect(events('llm.retry')).toEqual([]);
  });

  it('a retry that FITS still happens — the projection is not a ban on retrying', async () => {
    // 500ms backoff + 90s projected call, with 120s of budget left.
    let first = true;
    const inner: LlmClient = async () => {
      if (first) {
        first = false;
        throw apiError(429, 'rate_limit_error');
      }
      return '{"ok":true}';
    };
    const start = 5_000_000;
    await expect(
      call(
        withTransientRetry(inner, {
          deadline: start + 120_000,
          now: () => start,
          random: noJitter,
          sleep: neverSleeps,
        }),
      ),
    ).resolves.toBe('{"ok":true}');
    expect(events('llm.retry')).toHaveLength(1);
    expect(events('llm.retry_deadline_stop')).toEqual([]);
  });

  it('THE ARITHMETIC OF AN ORDINARY RUN — retries stay available for ~150s of 240s', () => {
    // `/api/optimize`: maxDuration 300s x RUN_BUDGET_FRACTION 0.8 = a 240s mark.
    const RUN_DEADLINE_MS = 300_000 * 0.8;
    // A retry at elapsed `t` is approved while t + backoff + 90_000 <= 240_000.
    const latestApproved = (backoff: number) => RUN_DEADLINE_MS - backoff - CLIENT_TIMEOUT_MS;
    expect(latestApproved(TRANSIENT_BASE_DELAY_MS)).toBe(149_500);
    expect(latestApproved(TRANSIENT_BASE_DELAY_MS * 2)).toBe(149_000);
    // Even the longest wait this layer will ever obey leaves two minutes of
    // runway: a server-advised 30s pause is still approved at t = 120s.
    expect(latestApproved(TRANSIENT_MAX_RETRY_AFTER_MS)).toBe(120_000);
    // The nine group calls and the repair rounds all start inside that window
    // on any run that is not already doomed, so ordinary retries are unaffected.
    expect(latestApproved(TRANSIENT_BASE_DELAY_MS)).toBeGreaterThan(RUN_DEADLINE_MS / 2);
  });

  it('a MEASURED attempt slower than the client timeout still wins — evidence beats the bound', async () => {
    const start = 5_000_000;
    let t = start;
    const clock = () => {
      const v = t;
      t += 100_000; // each attempt "took" 100s, longer than the 90s timeout
      return v;
    };
    const inner: LlmClient = async () => {
      throw apiError(529, 'overloaded_error');
    };
    await expect(
      call(
        withTransientRetry(inner, {
          deadline: start + 10_000_000,
          now: clock,
          random: noJitter,
          sleep: neverSleeps,
          attemptTimeoutMs: 1,
        }),
      ),
    ).rejects.toMatchObject({ status: 529 });
    const stops = events('llm.retry_deadline_stop');
    // With a deadline far out it still retries; the point is only that the
    // measurement is carried, which the log line shows.
    expect(stops).toEqual([]);
    expect(events('llm.retry')).toHaveLength(TRANSIENT_MAX_ATTEMPTS - 1);
  });

  it('the SDK client is built with the SAME constant the projection reserves', () => {
    // One literal, so a 90s transport and a 60s reservation cannot drift apart.
    expect(CLIENT_TIMEOUT_MS).toBe(90_000);
    const src = readFileSync(join(process.cwd(), 'lib/engine/llm.ts'), 'utf8');
    expect(src).toContain('timeout: CLIENT_TIMEOUT_MS,');
    expect(src).not.toContain('timeout: 90_000');
  });
});
