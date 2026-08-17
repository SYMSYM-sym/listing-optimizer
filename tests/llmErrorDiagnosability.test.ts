import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  describeError,
  generateGroup,
  recordUpstreamFailures,
  upstreamFailureSummary,
  type LlmClient,
} from '@/lib/engine/llm';
import { redactSecrets } from '@/lib/server/redact';
import { runPipeline } from '@/lib/pipeline/run';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { ALL_GROUPS } from '@/lib/engine/optimize';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * THE DEFECT.
 *
 * Production returned fully degraded runs: nine groups failed instantly, nine
 * `optimize.group_degraded` lines fired, gate check `GEN` blocked all nine, and
 * the run correctly ended `verified:false`. The fail-closed behaviour worked
 * exactly as designed — and it was nearly impossible to tell WHY, because
 * `lib/engine/llm.ts` logged this and only this:
 *
 *   {"event":"llm.reparse","group":"title","error":"Error","issuePaths":[]}   x9
 *
 * `"Error"` because the rule "never log `message`" — CORRECT for a `ZodError`,
 * whose message embeds the model's output — was applied to EVERY error class,
 * and the Anthropic SDK's error classes do not override `.name`. A rejected
 * key, an exhausted balance, a rate limit, a reset connection and a timeout all
 * produced the same five characters. There was no `llm.group` event either
 * (that one logs on success), and its ABSENCE was the only reason anyone could
 * infer the failure was in `messages.create` rather than in parsing.
 *
 * This suite pins the fix in BOTH directions:
 *   (a) a `ZodError` still logs class + schema paths, and its message — which
 *       carries the model's output — never appears in ANY log line;
 *   (b) a `SyntaxError` from `JSON.parse` and the extractor's own no-JSON error
 *       are treated the same way, for the same reason;
 *   (c) an Anthropic `APIError` (401, 429, 529) logs status + type + message,
 *       and the run STILL ends `verified:false` with `GEN`;
 *   (d) a key-shaped string in an error message is redacted before it is
 *       logged, and before it is returned to a caller;
 *   (e) `verified`, `degradedGroups` and the `GEN` failures are identical for
 *       every failure class — this change is observability ONLY.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * A string that could only have come out of the model. If it ever turns up in
 * a log line, model output reached the log stream.
 */
const MODEL_OUTPUT = 'ZZLEAK9f3a';

/**
 * V8 quotes only a short WINDOW of the offending source in a `JSON.parse`
 * message, and the size of that window is a V8 implementation detail that has
 * changed between Node versions. Assertions about what the parser echoed are
 * therefore made against this prefix rather than the whole marker: it is enough
 * to prove the message carries model output, and it does not turn a Node
 * upgrade into a red build.
 */
const ECHOED = MODEL_OUTPUT.slice(0, 6);

/**
 * A credential-shaped string. Written by concatenation so the literal vendor
 * prefix does not appear contiguously in the repository — the same courtesy
 * `lib/server/redact.ts` extends to `npm run check:secrets`.
 */
const FAKE_KEY = `sk-${'ant'}-api03-${'A'.repeat(40)}`;

// ---------------------------------------------------------------------------
// Log capture. `logServer` writes one line of JSON to console.info, so spying
// there captures EVERY log line the code under test produces — which is what
// "the message never appears in any log line" has to be measured against.
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

/** Every captured line as one blob — for "this string appears nowhere" checks. */
const allLogText = (): string => lines.join('\n');

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
// Group-level drivers
// ---------------------------------------------------------------------------

/** A schema strict enough that an unrecognized key is itself a zod issue. */
const strictSchema = z
  .object({ bullets: z.array(z.object({ text: z.string() })) })
  .strict();

const constantLlm = (text: string): LlmClient => async () => text;
const throwingLlm = (e: unknown): LlmClient => async () => {
  throw e;
};

/** Drive one group to failure and return the thrown `GroupGenerationError`. */
async function failGroup(llm: LlmClient): Promise<unknown> {
  try {
    await generateGroup(llm, 'bullets', 'sys', 'usr', strictSchema, 100);
    throw new Error('expected generateGroup to throw');
  } catch (e) {
    return e;
  }
}

/**
 * An SDK error built by the SDK's OWN factory rather than hand-rolled, so the
 * shape under test is the shape production throws: `APIError.generate` is what
 * `@anthropic-ai/sdk` calls internally, and it is what assigns `status`,
 * `type` (from the body's `error.type`) and `requestID` (from the `request-id`
 * response header).
 */
function apiError(status: number, apiType: string, message: string): APIError {
  return APIError.generate(
    status,
    { type: 'error', error: { type: apiType, message } },
    undefined,
    new Headers({ 'request-id': `req_test_${status}` }),
  );
}

// ===========================================================================
// (a) ZodError — class + paths kept, message withheld
// ===========================================================================

describe('(a) a ZodError logs its class and schema paths, and NEVER its message', () => {
  const badJson = JSON.stringify({ bullets: [{ text: 123 }], [MODEL_OUTPUT]: 'x' });

  it('the zod message really does embed the model output (else this test proves nothing)', () => {
    const parsed = strictSchema.safeParse(JSON.parse(badJson));
    expect(parsed.success).toBe(false);
    expect(parsed.error!.message).toContain(MODEL_OUTPUT);
  });

  it('llm.reparse names the class and the failing PATHS', async () => {
    await failGroup(constantLlm(badJson));
    const [reparse] = events('llm.reparse');
    expect(reparse).toBeDefined();
    expect(reparse!.error).toBe('ZodError');
    expect(reparse!.issuePaths).toContain('bullets.0.text');
  });

  it('no log line carries the model output, and no `message` field is emitted at all', async () => {
    await failGroup(constantLlm(badJson));
    expect(allLogText()).not.toContain(MODEL_OUTPUT);
    for (const e of events('llm.reparse')) expect(e).not.toHaveProperty('message');
  });

  it('describeError withholds the message for a ZodError but keeps the paths', () => {
    const parsed = strictSchema.safeParse(JSON.parse(badJson));
    const described = describeError(parsed.error);
    expect(described.error).toBe('ZodError');
    expect(described.message).toBeUndefined();
    expect(described.issuePaths).toContain('bullets.0.text');
  });
});

// ===========================================================================
// (b) SyntaxError / no-JSON-found — same treatment, same reason
// ===========================================================================

describe('(b) a SyntaxError and the extractor error also withhold their message', () => {
  // V8 quotes the offending source in this shape of parse failure:
  //   Unexpected token 'Z', "{"a":ZZLEAK9f3a" is not valid JSON
  // so the message provably carries model output.
  const unparseable = `{"a":${MODEL_OUTPUT}}`;
  // No `{`/`}` at all, so `extractJson` throws its own Error before JSON.parse.
  const noJson = `I cannot comply. ${MODEL_OUTPUT}`;

  it('the JSON.parse message really does quote the model output', () => {
    let msg = '';
    try {
      JSON.parse(unparseable);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(ECHOED);
  });

  it('a SyntaxError logs its class and no message, and leaks nothing', async () => {
    await failGroup(constantLlm(unparseable));
    const [reparse] = events('llm.reparse');
    expect(reparse!.error).toBe('SyntaxError');
    expect(reparse).not.toHaveProperty('message');
    expect(allLogText()).not.toContain(ECHOED);
  });

  it('the no-JSON-found error is named rather than logged as a bare "Error"', async () => {
    await failGroup(constantLlm(noJson));
    const [reparse] = events('llm.reparse');
    // The old code logged `"Error"` here — indistinguishable from a 401.
    expect(reparse!.error).toBe('NoJsonFound');
    expect(reparse).not.toHaveProperty('message');
    expect(allLogText()).not.toContain(ECHOED);
  });

  it('neither class emits an llm.error event — the CALL succeeded, the parse did not', async () => {
    await failGroup(constantLlm(unparseable));
    expect(events('llm.error')).toEqual([]);
  });
});

// ===========================================================================
// (c) Anthropic APIError — status, type and message ARE logged
// ===========================================================================

describe('(c) an Anthropic APIError logs status + type + message', () => {
  const cases: [number, string, string][] = [
    [401, 'authentication_error', 'invalid x-api-key'],
    [429, 'rate_limit_error', 'Number of requests has exceeded your rate limit'],
    [529, 'overloaded_error', 'Overloaded'],
  ];

  it.each(cases)('status %s (%s) is fully described', async (status, apiType, message) => {
    const described = describeError(apiError(status, apiType, message));
    expect(described.error).toBe('APIError');
    expect(described.status).toBe(status);
    expect(described.apiType).toBe(apiType);
    expect(described.requestId).toBe(`req_test_${status}`);
    expect(described.message).toContain(message);
  });

  /**
   * UPDATED BY V2. This asserted that a transport failure "enriches
   * llm.reparse" — which it did, because the reparse retry re-sent the prompt
   * for a call that never returned. That was the defect, not the feature: it
   * cost a second call per group and fed the SDK's own error back to the model
   * as a description of the model's own output. `llm.error` is unchanged and is
   * still the event whose ABSENCE used to be the only clue; there is simply no
   * reparse to enrich any more.
   */
  it.each(cases)('status %s emits llm.error, and NO llm.reparse (V2)', async (status, apiType, message) => {
    await failGroup(throwingLlm(apiError(status, apiType, message)));

    // The event whose ABSENCE used to be the only clue.
    const errs = events('llm.error');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.group).toBe('bullets');
    expect(errs[0]!.status).toBe(status);
    expect(errs[0]!.apiType).toBe(apiType);
    expect(errs[0]!.message).toContain(message);
    expect(typeof errs[0]!.ms).toBe('number');

    // V2 — the call never returned, so there is nothing to reparse.
    expect(events('llm.reparse')).toEqual([]);
  });

  it('a transport failure is ONE attempt and ONE llm.error line (V2)', async () => {
    await failGroup(throwingLlm(apiError(429, 'rate_limit_error', 'slow down')));
    const errs = events('llm.error');
    expect(errs).toHaveLength(1);
    expect(errs.map((e) => e.retry)).toEqual([false]);
  });

  it('the PER-ATTEMPT flag still works: a reparse call that fails on transport is marked retry:true', async () => {
    // Attempt 1 returns output that will not parse (so the reparse retry is
    // legitimately taken); the reparse call then dies on the wire. Exactly one
    // `llm.error`, and it is the SECOND attempt — which is what `retry` is for.
    let n = 0;
    const llm: LlmClient = async () => {
      n += 1;
      if (n === 1) return 'not json at all';
      throw apiError(529, 'overloaded_error', 'Overloaded');
    };
    await failGroup(llm);
    const errs = events('llm.error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.retry).toBe(true);
    expect(errs[0]!.status).toBe(529);
    // ...and the reparse that WAS taken is still recorded, named by its class.
    expect(events('llm.reparse')).toHaveLength(1);
    expect(events('llm.reparse')[0]!.error).toBe('NoJsonFound');
  });

  it('an error with no status at all is named by CLASS, which is all there is', () => {
    const described = describeError(APIError.generate(undefined, undefined, 'Connection error.', undefined));
    expect(described.error).toBe('APIConnectionError');
    expect(described.status).toBeUndefined();
    expect(described.message).toContain('Connection error');
  });

  it('the operator sentence says what happened, from status and type only', () => {
    expect(upstreamFailureSummary(describeError(apiError(401, 'authentication_error', 'x')))).toBe(
      'Generation failed: the upstream model API rejected the request (status 401, authentication_error).',
    );
    expect(upstreamFailureSummary(describeError(apiError(429, 'rate_limit_error', 'x')))).toBe(
      'Generation failed: the upstream model API rate-limited the request (status 429, rate_limit_error).',
    );
    expect(upstreamFailureSummary(describeError(apiError(529, 'overloaded_error', 'x')))).toBe(
      'Generation failed: the upstream model API returned a server error (status 529, overloaded_error).',
    );
    // It is built from status/type, never from `message` — a response body is
    // held to a stricter standard than a server log.
    expect(
      upstreamFailureSummary(describeError(apiError(401, 'authentication_error', MODEL_OUTPUT))),
    ).not.toContain(MODEL_OUTPUT);
  });

  it('recordUpstreamFailures keeps the first UNRECOVERED failure and rethrows unchanged', async () => {
    const thrown = apiError(401, 'authentication_error', 'invalid x-api-key');
    const rec = recordUpstreamFailures(throwingLlm(thrown));
    await expect(rec.llm({ system: 's', user: 'u', maxTokens: 10 })).rejects.toBe(thrown);
    expect(rec.firstFailure()).toMatchObject({ error: 'APIError', status: 401 });
    // V1 — an unnamed call is recorded under `unknown`; the un-latch and the
    // scope rule are pinned in `tests/generationFailure.scope.v1.test.ts`.
    expect(rec.failedGroups()).toEqual(['unknown']);
  });
});

// ===========================================================================
// (d) redaction — a key-shaped string never survives into a log line
// ===========================================================================

describe('(d) a key-shaped string in an error message is redacted', () => {
  it('redactSecrets masks the shapes a leaked credential actually takes', () => {
    expect(redactSecrets(`x-api-key: ${FAKE_KEY}`)).not.toContain(FAKE_KEY);
    expect(redactSecrets(`Authorization: Bearer ${FAKE_KEY}`)).not.toContain(FAKE_KEY);
    expect(redactSecrets(`failed with key ${FAKE_KEY} rejected`)).not.toContain(FAKE_KEY);
    expect(redactSecrets(`{"apiKey":"${FAKE_KEY}"}`)).not.toContain(FAKE_KEY);
    expect(redactSecrets(`failed with key ${FAKE_KEY} rejected`)).toContain('[REDACTED]');
  });

  it('it is a no-op on ordinary prose, so callers can apply it unconditionally', () => {
    const prose = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('describeError redacts before it truncates, so no half-key survives', () => {
    const described = describeError(new Error(`connect failed: ${FAKE_KEY} rejected`));
    expect(described.message).toBeDefined();
    expect(described.message).not.toContain(FAKE_KEY);
    // Not even a fragment: the prefix alone is enough to identify a vendor key.
    expect(described.message).not.toContain(FAKE_KEY.slice(0, 20));
    expect(described.message).toContain('[REDACTED]');
  });

  it('no log line carries the key when the SDK error message embeds one', async () => {
    await failGroup(throwingLlm(apiError(401, 'authentication_error', `rejected key ${FAKE_KEY}`)));
    expect(events('llm.error').length).toBeGreaterThan(0);
    expect(allLogText()).not.toContain(FAKE_KEY);
    expect(allLogText()).not.toContain(FAKE_KEY.slice(0, 20));
    expect(allLogText()).toContain('[REDACTED]');
    // and the diagnosis is still there — redaction did not cost the triage
    expect(events('llm.error')[0]!.status).toBe(401);
  });
});

// ===========================================================================
// (e) OBSERVABILITY ONLY — verified / degrade / GEN are identical throughout
// ===========================================================================

describe('(e) verified, degradedGroups and GEN are byte-identical across every failure class', () => {
  /** The full-run signature an operator is judged on. Nothing else may vary. */
  const signature = (r: Awaited<ReturnType<typeof runPipeline>>) => ({
    verified: r.audit.verified,
    state: r.optimized.state,
    degraded: [...(r.optimized.degradedGroups ?? [])].sort(),
    gen: r.audit.gateResult.failures
      .filter((f) => f.checkId === 'GEN')
      .map((f) => f.field)
      .sort(),
    gateCrashes: r.audit.gateResult.failures.filter((f) => f.checkId === 'GATE').length,
  });

  const everyGroupFails = (e: unknown) => runPipeline(snapshot, throwingLlm(e), 0);

  it('a healthy run is untouched: verified, no marker, and NO new events at all', async () => {
    const result = await runPipeline(snapshot, mockLlm, 1);
    expect(result.audit.verified).toBe(true);
    expect(result.audit.gateResult.failures).toEqual([]);
    expect('degradedGroups' in result.optimized).toBe(false);
    // The new events fire on failure only — a green run's log stream is
    // exactly what it was.
    expect(events('llm.error')).toEqual([]);
    expect(events('optimize.group_degraded')).toEqual([]);
  });

  it('a 401 on every call degrades all nine groups and still fails closed', async () => {
    const result = await everyGroupFails(apiError(401, 'authentication_error', 'invalid x-api-key'));
    const sig = signature(result);
    expect(sig.verified).toBe(false);
    expect(sig.state).toBe('draft');
    expect(sig.degraded).toEqual([...ALL_GROUPS].sort());
    expect(sig.gen).toEqual(ALL_GROUPS.map((g) => `generation.${g}`).sort());
    expect(sig.gateCrashes).toBe(0);
  });

  it('the degrade log now says WHY — status and type, not a bare "transport"', async () => {
    await everyGroupFails(apiError(401, 'authentication_error', 'invalid x-api-key'));
    const degraded = events('optimize.group_degraded');
    expect(degraded).toHaveLength(ALL_GROUPS.length);
    for (const d of degraded) {
      expect(d.reason).toBe('transport');
      expect(d.error).toBe('APIError');
      expect(d.status).toBe(401);
      expect(d.apiType).toBe('authentication_error');
    }
  });

  it('the signature does NOT depend on the failure class', async () => {
    const zodish = await runPipeline(
      snapshot,
      constantLlm(JSON.stringify({ bullets: [{ text: 123 }], [MODEL_OUTPUT]: 'x' })),
      0,
    );
    const auth = await everyGroupFails(apiError(401, 'authentication_error', 'invalid x-api-key'));
    const limited = await everyGroupFails(apiError(429, 'rate_limit_error', 'slow down'));
    const overloaded = await everyGroupFails(apiError(529, 'overloaded_error', 'Overloaded'));
    const keyish = await everyGroupFails(new Error(`connect failed: ${FAKE_KEY}`));

    const base = signature(zodish);
    expect(base.verified).toBe(false);
    expect(base.gen).toEqual(ALL_GROUPS.map((g) => `generation.${g}`).sort());
    for (const other of [auth, limited, overloaded, keyish]) {
      expect(signature(other)).toEqual(base);
    }
  });

  it('across a whole degraded run, no log line carries model output or a key', async () => {
    await runPipeline(
      snapshot,
      constantLlm(JSON.stringify({ bullets: [{ text: 123 }], [MODEL_OUTPUT]: 'x' })),
      0,
    );
    expect(allLogText()).not.toContain(MODEL_OUTPUT);
    lines = [];
    await everyGroupFails(new Error(`connect failed: ${FAKE_KEY}`));
    expect(allLogText()).not.toContain(FAKE_KEY);
    expect(allLogText()).not.toContain(FAKE_KEY.slice(0, 20));
  });
});
