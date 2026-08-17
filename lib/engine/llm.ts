import 'server-only';
import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { ZodError, type z } from 'zod';
import { env } from '@/lib/env';
import { logServer } from '@/lib/server/log';
import { redactAndTruncate } from '@/lib/server/redact';
import type { GenerationFailure } from '@/lib/types';

/**
 * LLM boundary. The client is injectable (tests use a recorded-fixture mock).
 * The model writes copy; it NEVER decides whether a limit is met — all
 * limits/scans are deterministic code in the gate.
 */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Optional group label for structured latency logs. */
  groupName?: string;
}

export type LlmClient = (req: LlmRequest) => Promise<string>;

let _anthropic: Anthropic | null = null;

export function anthropicClient(): LlmClient {
  return async ({ system, user, maxTokens, groupName }) => {
    // U2 — `maxRetries: 0` is DELIBERATE, and it is not "no retries".
    //
    // The SDK retries twice by default (`client.js`: `this.maxRetries =
    // options.maxRetries ?? 2`), with its own exponential backoff and its own
    // `retry-after` handling. Leaving that on underneath `withTransientRetry`
    // would multiply, not add: 3 of our attempts x 3 of its own is up to NINE
    // calls for one group and up to nine groups per run, with the SDK's sleeps
    // invisible to the run deadline that the whole D5 budget is built on. A
    // deadline that the retry layer honours and the transport ignores is not a
    // deadline. So there is exactly ONE retry authority, it is the one that can
    // see the deadline, and it is the one whose retries appear in our logs.
    _anthropic ??= new Anthropic({
      apiKey: env.anthropicApiKey(),
      timeout: 90_000,
      maxRetries: 0,
    });
    const started = Date.now();
    // Claude Sonnet 5 enables adaptive thinking by default; with modest
    // max_tokens that can consume the whole budget and return zero text.
    // Structured JSON copy does not need thinking — disable it explicitly.
    const msg = await _anthropic.messages.create({
      model: env.anthropicModel(),
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: system,
          // Prompt-cache the shared rules/compliance preamble across the
          // 8 group calls and repair rounds (dominant input cost).
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: user }],
    });
    const block = msg.content.find((b) => b.type === 'text');
    const textBlocks = msg.content.filter((b) => b.type === 'text').length;
    logServer('llm.group', {
      group: groupName ?? 'unknown',
      ms: Date.now() - started,
      stopReason: msg.stop_reason,
      contentTypes: msg.content.map((b) => b.type),
      textBlocks,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
    });
    if (!block || block.type !== 'text' || !block.text.trim()) {
      throw new Error(
        `LLM returned no text content (stop_reason=${msg.stop_reason}; blocks=${msg.content.map((b) => b.type).join(',') || 'none'})`,
      );
    }
    return block.text;
  };
}

function extractJson(text: string): string {
  // Tolerate ```json fences and surrounding prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(NO_JSON_MESSAGE);
  }
  return sanitizeJsonControlChars(candidate.slice(start, end + 1));
}

/**
 * LLMs sometimes emit raw newlines/tabs inside JSON string values.
 * Escape those control characters so JSON.parse can succeed (zod still validates shape).
 */
function sanitizeJsonControlChars(json: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        // drop other control chars
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Failing schema PATHS only ("bullets.0.text") — never messages, never values.
 * Model output must never reach the log stream.
 */
function zodIssuePaths(e: unknown): string[] {
  if (!(e instanceof ZodError)) return [];
  return [...new Set(e.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 20);
}

/** The one place the "extractor found no object" text is written. */
const NO_JSON_MESSAGE = 'No JSON object found in LLM output';

// ---------------------------------------------------------------------------
// SAFE ERROR DESCRIPTION
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS.
 *
 * The privacy rule above — never log `message` — is CORRECT for a `ZodError`,
 * whose message embeds the offending model OUTPUT. It was applied to every
 * error class, and that made an entire category of outage undiagnosable: a
 * rejected key, an exhausted balance, a rate limit, a reset connection and a
 * timeout all logged as the single useless string `"Error"`, because the
 * Anthropic SDK's error classes do not override `.name` (see
 * `node_modules/@anthropic-ai/sdk/core/error.d.ts` — `APIError extends
 * AnthropicError extends Error`, and none of them assigns `this.name`). Nine
 * groups failed instantly, nine identical `{"error":"Error"}` lines were
 * written, and the only reason anyone could tell the failure was in
 * `messages.create` rather than in parsing was the ABSENCE of an `llm.group`
 * event.
 *
 * So the rule is split by PROVENANCE rather than applied uniformly:
 *
 *   MODEL-DERIVED  — `ZodError` (message embeds the rejected output),
 *                    `SyntaxError` from `JSON.parse` (V8 quotes the offending
 *                    source text in the message: `Unexpected token } in JSON
 *                    at position 812` is benign, but `Unexpected token 'x', ..."
 *                    is not JSON` is not), and our own `extractJson` error.
 *                    The MESSAGE IS WITHHELD ENTIRELY. Not truncated — a
 *                    truncated model output is still model output, and a
 *                    character budget is not a privacy boundary. The
 *                    classification and, for zod, the failing schema PATHS,
 *                    carry every bit of diagnostic value those classes have.
 *
 *   INFRASTRUCTURE — everything else, in particular the SDK's `APIError` tree.
 *                    The model never touched these messages; they are built by
 *                    the SDK from the HTTP status and the API's own error body.
 *                    They are the whole diagnosis, so they are recorded — after
 *                    `redactSecrets`, because an SDK error message can echo
 *                    request context and must never be a path on which a key
 *                    reaches stdout (`lib/server/redact.ts`).
 */
export interface SafeErrorFields {
  /** Stable class label. See `errorClass` for why this is not `e.name`. */
  error: string;
  /** HTTP status, when the failure was an API response. */
  status?: number;
  /** The API's own `error.type`, e.g. `authentication_error`. */
  apiType?: string;
  /** Anthropic's request id — opaque, non-sensitive, what support asks for. */
  requestId?: string;
  /** Redacted + truncated. ABSENT for every model-derived class. */
  message?: string;
  /** Failing schema paths; empty for anything that is not a `ZodError`. */
  issuePaths: string[];
}

/**
 * A STABLE class label.
 *
 * Neither `e.name` nor `e.constructor.name` can be trusted here. `e.name` is
 * the defect this change exists to fix — the SDK inherits `Error`'s, which is
 * the literal `"Error"`. `e.constructor.name` is no better: it survives in dev
 * and is mangled by the production minifier, so it would report correctly in
 * every test and uselessly in the outage. `instanceof` against the imported
 * classes is checked by the bundler and mapped here to a literal, so the log
 * line reads the same in production as it does in CI.
 *
 * Ordered most-derived first: `APIConnectionTimeoutError extends
 * APIConnectionError extends APIError`, and `APIUserAbortError extends
 * APIError`, so a generic-first test would swallow all four.
 *
 * The per-status subclasses (`AuthenticationError`, `RateLimitError`,
 * `InternalServerError`, …) are deliberately NOT enumerated: they all collapse
 * to `APIError` here, and `status` plus `apiType` say everything the subclass
 * name would have — `status:401, apiType:"authentication_error"` is strictly
 * more informative than `AuthenticationError`. The three that ARE named are
 * exactly the ones with NO status at all, where the class label is the only
 * diagnosis there is.
 */
function errorClass(e: unknown): string {
  if (e instanceof ZodError) return 'ZodError';
  if (e instanceof APIConnectionTimeoutError) return 'APIConnectionTimeoutError';
  if (e instanceof APIConnectionError) return 'APIConnectionError';
  if (e instanceof APIUserAbortError) return 'APIUserAbortError';
  if (e instanceof APIError) return 'APIError';
  if (e instanceof AnthropicError) return 'AnthropicError';
  if (e instanceof SyntaxError) return 'SyntaxError';
  // Our own extractor error is a plain `Error`, so it would otherwise log as
  // the same useless `"Error"` this whole change exists to end. It is named on
  // the constant it throws — the identical test `classify` makes.
  if (e instanceof Error && e.message.includes(NO_JSON_MESSAGE)) return 'NoJsonFound';
  if (e instanceof Error) return e.name || 'Error';
  return 'unknown';
}

/**
 * True when the error's `message` is, or may quote, the model's output.
 *
 * `extractJson`'s error is matched on the constant it throws rather than on
 * class, because it is a plain `Error` and therefore indistinguishable from an
 * infrastructure failure by type alone — the same test `classify` already
 * makes, against the same constant.
 */
function isModelDerived(e: unknown): boolean {
  return (
    e instanceof ZodError ||
    e instanceof SyntaxError ||
    (e instanceof Error && e.message.includes(NO_JSON_MESSAGE))
  );
}

/** Upper bound on a recorded infrastructure message. */
const MESSAGE_LOG_CHARS = 400;

/**
 * Describe any thrown value as fields that are SAFE to log verbatim.
 *
 * Every field returned here has already been through redaction where it could
 * have carried a credential. Callers pass the result straight to `logServer`;
 * they are not expected to re-check it, and they must not add `message` back in
 * from the raw error.
 */
export function describeError(e: unknown): SafeErrorFields {
  const fields: SafeErrorFields = { error: errorClass(e), issuePaths: zodIssuePaths(e) };
  if (e instanceof APIError) {
    // Verified against the installed SDK (0.110.0):
    //   `readonly status`     — HTTP status; `undefined` on the two subclasses
    //                           that never got a response (connection, abort).
    //   `readonly type`       — the API body's `error.type`, or null.
    //   `readonly requestID`  — from the `request-id` response header, or null.
    //   `readonly error`      — the raw JSON body. NOT logged: `message` is
    //                           already derived from it by `makeMessage`, and
    //                           logging the body would be a second, unbounded
    //                           copy of the same thing.
    if (typeof e.status === 'number') fields.status = e.status;
    if (e.type) fields.apiType = e.type;
    if (e.requestID) fields.requestId = e.requestID;
  }
  if (!isModelDerived(e)) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw) fields.message = redactAndTruncate(raw, MESSAGE_LOG_CHARS);
  }
  return fields;
}

/**
 * The operator-facing sentence for a run that came back fully degraded.
 *
 * Deliberately built from the STATUS and TYPE only — never from `message`. This
 * string is returned in an HTTP response body, so it is held to a stricter
 * standard than a server log line: it says what class of thing went wrong and
 * gives the operator the number to act on, and nothing that came out of either
 * the model or the upstream API's prose.
 */
export function upstreamFailureSummary(f: SafeErrorFields): string {
  const detail = [
    f.status !== undefined ? `status ${f.status}` : null,
    f.apiType ?? null,
  ].filter((s): s is string => s !== null);
  const suffix = detail.length > 0 ? ` (${detail.join(', ')})` : ` (${f.error})`;
  if (f.status === 401 || f.status === 403) {
    return `Generation failed: the upstream model API rejected the request${suffix}.`;
  }
  if (f.status === 429) {
    return `Generation failed: the upstream model API rate-limited the request${suffix}.`;
  }
  if (f.status !== undefined && f.status >= 500) {
    return `Generation failed: the upstream model API returned a server error${suffix}.`;
  }
  if (f.status !== undefined) {
    return `Generation failed: the upstream model API returned an error${suffix}.`;
  }
  return `Generation failed: the upstream model API could not be reached${suffix}.`;
}


// ---------------------------------------------------------------------------
// U2 — BOUNDED RETRY FOR TRANSIENT UPSTREAM FAILURES
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS.
 *
 * Before this, ANY error from the model API degraded the group after the
 * boundary's single reparse retry, and every degraded group blocks via `GEN`,
 * so one blip cost the whole run. That is the RIGHT answer for the outage
 * `e885f23` was written for — a 400 for an exhausted credit balance, or a 401
 * for a rejected key, will fail identically no matter how many times it is
 * sent, and retrying only burns calls against an account that already cannot
 * pay for them. It is the WRONG answer for a 429, a 529, a reset connection or
 * a read timeout, every one of which is a statement about this MOMENT.
 *
 * So the split is by CLASS, using the taxonomy above rather than a second one:
 *
 *   RETRIED     `APIConnectionError` and `APIConnectionTimeoutError` (no
 *               response at all), 408 request timeout, 409 lock timeout, 429
 *               rate limit, and every 5xx — which is where 529 `overloaded_error`
 *               lives. 408 and 409 are on this list because the SDK's own
 *               policy retried them and this layer REPLACES that policy (see
 *               `maxRetries: 0` in `anthropicClient`); dropping them would be a
 *               regression introduced by taking ownership, not a decision.
 *
 *   NEVER       400, 401, 403 and 404 — named explicitly rather than left to
 *               "4xx", so the billing 400 that caused the outage can never
 *               become retryable by someone widening a range. `APIUserAbortError`
 *               is never retried either: an abort is a DECISION, and the whole
 *               point of aborting is that the work stops.
 *
 *   NOT SEEN    the reparse path. Schema and JSON failures happen AFTER the
 *               call returned, above this wrapper, and already have their own
 *               single retry with the validation error fed back to the model.
 *               A different failure mode with a different remedy; it is not
 *               reached from here and must not be.
 *
 * Anything that is not an SDK error at all — including the boundary's own
 * "LLM returned no text content" — is NOT retried. Fails closed: an unknown
 * class is treated as permanent.
 */

/** Total attempts INCLUDING the first. 3 = one call plus two retries. */
export const TRANSIENT_MAX_ATTEMPTS = 3;
/** First backoff; doubles per retry. */
export const TRANSIENT_BASE_DELAY_MS = 500;
/** Ceiling on any single wait, computed or advised. */
export const TRANSIENT_MAX_DELAY_MS = 8_000;
/** Jitter takes up to this fraction OFF the computed delay, never adds. */
export const TRANSIENT_JITTER_FRACTION = 0.25;
/**
 * A `retry-after` longer than this is honoured by GIVING UP rather than by
 * waiting: the server has said "come back much later than any run can wait",
 * and retrying earlier than it asked would be worse than not retrying at all.
 */
export const TRANSIENT_MAX_RETRY_AFTER_MS = 30_000;

/** Statuses that are decided, not momentary. Enumerated, never a range. */
const NEVER_RETRY_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);
/** 4xx that ARE momentary — the SDK's own list, kept when we took its job. */
const TRANSIENT_4XX_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * Is this failure worth sending again?
 *
 * Ordered most-derived first for the same reason `errorClass` is:
 * `APIConnectionTimeoutError extends APIConnectionError extends APIError` and
 * `APIUserAbortError extends APIError`, so a generic-first test would swallow
 * the specific ones.
 */
export function isTransientUpstreamFailure(e: unknown): boolean {
  // An abort is a decision. Checked BEFORE the connection classes purely for
  // readability — it is their sibling, not their ancestor.
  if (e instanceof APIUserAbortError) return false;
  // Covers `APIConnectionTimeoutError`. Neither ever got a response, so there
  // is no status to consult and no body to have been rejected.
  if (e instanceof APIConnectionError) return true;
  if (e instanceof APIError) {
    const status = e.status;
    if (typeof status !== 'number') return false;
    if (NEVER_RETRY_STATUSES.has(status)) return false;
    if (TRANSIENT_4XX_STATUSES.has(status)) return true;
    return status >= 500;
  }
  return false;
}

/**
 * The wait the SERVER asked for, in ms, or `null` if it asked for none.
 *
 * VERIFIED AGAINST THE INSTALLED SDK (0.110.0) rather than assumed. There is no
 * `retryAfter` field on the error object: `APIError` carries
 * `readonly headers: Headers | undefined` (`node_modules/@anthropic-ai/sdk/
 * core/error.d.ts`), and the SDK's own `retryRequest` reads exactly two header
 * names off it, in this order — `retry-after-ms` (milliseconds, non-standard
 * but preferred when present) then `retry-after` (RFC 7231: delta-seconds OR an
 * HTTP date). Both are read here, in the same order, with the same
 * interpretations, so this layer waits what the SDK would have waited.
 *
 * `headers` is `undefined` on the connection and abort subclasses, which is
 * consistent: they never received a response to carry headers.
 */
export function retryAfterMs(e: unknown, now: () => number): number | null {
  if (!(e instanceof APIError)) return null;
  const headers: Headers | undefined = e.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  const ms = headers.get('retry-after-ms');
  if (ms !== null) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const after = headers.get('retry-after');
  if (after !== null) {
    const seconds = Number.parseFloat(after);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(0, at - now());
  }
  return null;
}

/**
 * Exponential backoff with SUBTRACTIVE jitter.
 *
 * `attempt` is 1-based over RETRIES: 1 is the first retry. The delay is
 * `base * 2^(attempt-1)`, clamped, then reduced by up to
 * `TRANSIENT_JITTER_FRACTION` of itself — so it is bounded in
 * `[0.75 * clamped, clamped]` and can never EXCEED the clamp. That matters:
 * additive jitter on the last retry could push the wait past a deadline the
 * caller had already checked.
 *
 * `random` is injected so the value is exact under test — a backoff test that
 * calls `Math.random` is a flaky test.
 */
export function transientBackoffMs(attempt: number, random: () => number): number {
  const clamped = Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1), TRANSIENT_MAX_DELAY_MS);
  return Math.round(clamped * (1 - random() * TRANSIENT_JITTER_FRACTION));
}

export interface TransientRetryOptions {
  /**
   * D5 — the SAME absolute epoch-ms mark the repair loop is already checking
   * (`/api/optimize` passes 80% of `maxDuration`). A retry that would land the
   * run past it is not taken: the platform kills the function at `maxDuration`
   * and a killed function answers 502, which loses the whole run — every
   * generated surface AND every gate finding. A degraded group is a reportable
   * `verified:false`; an overrun is nothing at all, so when the two conflict
   * the deadline wins.
   *
   * Absent => no time limit, which is what the deterministic tests use.
   */
  deadline?: number;
  /** Total attempts including the first. Defaults to `TRANSIENT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests. */
  random?: () => number;
  /** Injected for tests, so a backoff test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wrap a client so a TRANSIENT failure is sent again, a permanent one is not,
 * and neither can push the run past its deadline.
 *
 * COMPOSITION ORDER MATTERS, and the routes get it right deliberately:
 * `recordUpstreamFailures(withTransientRetry(client))`. The recorder must sit
 * OUTSIDE, so it only ever sees a failure that actually escaped. Inside-out
 * would record the 429 that was then successfully retried, and the response
 * would carry a `generationFailure` — and therefore U1's banner — for a run
 * that completed perfectly. That is precisely the false "upstream failed"
 * notice U1's absent-direction test exists to prevent.
 *
 * IT CHANGES NO VERDICT. On the exhausted path it rethrows the LAST error
 * unchanged, so `classify`, the degrade routing, `GEN` and `verified` see
 * exactly what they saw before. All it can do is turn some failures into
 * successes; it can never turn a failure into a pass.
 */
export function withTransientRetry(inner: LlmClient, opts: TransientRetryOptions = {}): LlmClient {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? TRANSIENT_MAX_ATTEMPTS);
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (req) => {
    const group = req.groupName ?? 'unknown';
    /**
     * The longest attempt MEASURED so far, used to project how long the retry
     * itself will take. The deadline has to cover the wait AND the call after
     * it — sleeping until one millisecond before the mark and then starting a
     * 60-second request is not respecting a deadline. Same projection the
     * repair loop makes from its longest measured round (`lib/engine/repair.ts`).
     */
    let longestAttemptMs = 0;
    for (let attempt = 1; ; attempt++) {
      const startedAt = now();
      try {
        return await inner(req);
      } catch (e) {
        longestAttemptMs = Math.max(longestAttemptMs, now() - startedAt);
        if (attempt >= maxAttempts) throw e;
        if (!isTransientUpstreamFailure(e)) throw e;
        const advised = retryAfterMs(e, now);
        if (advised !== null && advised > TRANSIENT_MAX_RETRY_AFTER_MS) {
          logServer('llm.retry_declined', {
            group,
            attempt,
            reason: 'retry-after beyond ceiling',
            retryAfterMs: advised,
            ...describeError(e),
          });
          throw e;
        }
        // An advised wait is obeyed as given; only a COMPUTED one is clamped,
        // because the clamp exists to bound our own guess, not the server's
        // instruction.
        const backoff = advised ?? transientBackoffMs(attempt, random);
        if (
          typeof opts.deadline === 'number' &&
          now() + backoff + longestAttemptMs > opts.deadline
        ) {
          // D5 — stop rather than overrun. The group degrades, which is a
          // complete and honest `verified:false`; overrunning is a 502.
          logServer('llm.retry_deadline_stop', {
            group,
            attempt,
            backoffMs: backoff,
            projectedAttemptMs: longestAttemptMs,
            remainingMs: opts.deadline - now(),
            ...describeError(e),
          });
          throw e;
        }
        // Distinct from `llm.error` (which fires when a call fails and is NOT
        // retried) and from `llm.group` (success). A call that was retried and
        // recovered therefore writes `llm.retry` + `llm.group`, and a first-try
        // success writes `llm.group` alone — the two are told apart in the log
        // without counting absences, which is the defect `e885f23` closed.
        logServer('llm.retry', {
          group,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          backoffMs: backoff,
          ...(advised !== null ? { retryAfterMs: advised } : {}),
          ...describeError(e),
        });
        await sleep(backoff);
      }
    }
  };
}

/**
 * The response-body payload for a run whose generation failed upstream — the
 * ONE place its shape is built.
 *
 * Both routes returned a hand-written copy of this object, and U1 added a THIRD
 * reader (the results panel, which renders it). Three independent copies of a
 * five-field contract is how a field silently stops being sent to the UI on one
 * route only, so the two producers and the renderer now agree by construction.
 *
 * Optional fields are OMITTED rather than set to `undefined`, so a healthy
 * response is byte-for-byte the object it was and `'generationFailure' in body`
 * remains the exact test for "an upstream call failed".
 */
export function generationFailurePayload(f: SafeErrorFields | null): GenerationFailure | null {
  if (!f) return null;
  return {
    class: f.error,
    ...(f.status !== undefined ? { status: f.status } : {}),
    ...(f.apiType ? { apiType: f.apiType } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
    summary: upstreamFailureSummary(f),
  };
}

/**
 * Wrap a client so the FIRST transport/API failure of a run is available to the
 * caller after the run finishes.
 *
 * This is how an operator staring at nine `GEN` gate failures gets told the run
 * died on a 401 instead of being left to infer it. It wraps the CLIENT, so
 * everything it sees is by construction a call failure — a parse failure never
 * reaches it, and model output never enters this path at all.
 *
 * It records and RETHROWS: the degrade behaviour downstream, and therefore
 * `verified`, is completely untouched. Removing the wrapper would change
 * nothing except how much the operator is told.
 */
export function recordUpstreamFailures(inner: LlmClient): {
  llm: LlmClient;
  firstFailure: () => SafeErrorFields | null;
} {
  let first: SafeErrorFields | null = null;
  return {
    llm: async (req) => {
      try {
        return await inner(req);
      } catch (e) {
        first ??= describeError(e);
        throw e;
      }
    },
    firstFailure: () => first,
  };
}

/**
 * D1 — a group that could not be produced, as a TYPED failure.
 *
 * The caller has to be able to degrade one group without losing the run, and
 * to say WHY in a log line, without ever touching the RAW `message`: a zod
 * message embeds the offending model OUTPUT (see the reparse note above). What
 * travels on this object is the classification, the failing schema PATHS, and
 * `safe` — the already-redacted description from `describeError`, which
 * withholds the message for every model-derived class and keeps it for
 * infrastructure failures. `optimize.ts` logs `safe` verbatim; it is not
 * expected to re-check it.
 */
export type GroupFailureReason = 'truncated-or-unparseable' | 'schema' | 'transport';

export class GroupGenerationError extends Error {
  constructor(
    readonly group: string,
    readonly reason: GroupFailureReason,
    readonly issuePaths: string[],
    message: string,
    /** Safe-to-log description of the underlying failure. */
    readonly safe: SafeErrorFields = { error: 'unknown', issuePaths: [] },
  ) {
    super(message);
    this.name = 'GroupGenerationError';
  }
}

function classify(e: unknown): GroupFailureReason {
  if (e instanceof ZodError) return 'schema';
  // A truncated response fails at JSON.parse (SyntaxError), and a response the
  // extractor found no object in fails with our own Error from `extractJson` —
  // both are the max_tokens signature, and both are unusable JSON.
  if (e instanceof SyntaxError) return 'truncated-or-unparseable';
  if (e instanceof Error && e.message.includes(NO_JSON_MESSAGE)) return 'truncated-or-unparseable';
  return 'transport';
}

/**
 * Generate one group: prompt → JSON → zod parse; ONE reparse retry with the
 * validation error appended (separate from the gate's repair budget).
 */
export async function generateGroup<S extends z.ZodType>(
  llm: LlmClient,
  groupName: string,
  system: string,
  user: string,
  schema: S,
  maxTokens: number,
): Promise<z.infer<S>> {
  const attempt = async (extra?: string): Promise<z.infer<S>> => {
    const startedAt = Date.now();
    let text: string;
    try {
      text = await llm({
        system,
        user: extra ? `${user}\n\nIMPORTANT — your previous output was invalid: ${extra}\nReturn corrected JSON only.` : user,
        maxTokens,
        groupName,
      });
    } catch (e) {
      // THE CALL ITSELF FAILED — a distinct fact from "the model answered and
      // the answer would not parse", and previously an unlogged one. The only
      // signal was the ABSENCE of `llm.group` (which is written on success
      // only), so telling a dead API key apart from a schema drift meant
      // reasoning about an event that was not there. Now it is there.
      //
      // Emitted per ATTEMPT, so a group that fails twice writes two lines: the
      // retry is a second real API call and an operator counting spend or
      // rate-limit pressure needs to see both.
      logServer('llm.error', {
        group: groupName,
        ms: Date.now() - startedAt,
        retry: extra !== undefined,
        ...describeError(e),
      });
      throw e;
    }
    const parsed: unknown = JSON.parse(extractJson(text));
    return schema.parse(parsed);
  };
  try {
    return await attempt();
  } catch (e) {
    // `detail` is fed back to the MODEL in the retry prompt, never to the log.
    // It is redacted anyway: for an infrastructure failure it is an SDK message
    // that can echo request context, and putting that in a prompt would send it
    // back upstream. Redaction is a no-op on everything else, so the retry the
    // model sees for a schema failure is unchanged.
    const detail = redactAndTruncate(e instanceof Error ? e.message : String(e), 600);
    // `describeError` decides what is safe: the message is WITHHELD for zod,
    // for `JSON.parse` and for the extractor's own error (all three can quote
    // model output), and KEPT — redacted — for an API/transport failure, which
    // is the whole point of this event.
    logServer('llm.reparse', { group: groupName, ...describeError(e) });
    try {
      return await attempt(detail);
    } catch (e2) {
      throw new GroupGenerationError(
        groupName,
        classify(e2),
        zodIssuePaths(e2),
        // Unchanged: this string never reaches a log or a response body. It is
        // the exception's own message, read only by a developer at a debugger.
        `Group '${groupName}' failed schema validation twice: ${e2 instanceof Error ? e2.message.slice(0, 300) : String(e2)}`,
        describeError(e2),
      );
    }
  }
}
