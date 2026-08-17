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

/**
 * The per-CALL timeout handed to the SDK, and therefore the longest a single
 * attempt can take before the transport gives up on it.
 *
 * V3 — it is a named export because `withTransientRetry` has to project the
 * cost of an attempt that HAS NOT HAPPENED YET, and this is the only true
 * upper bound on one. A projection built from anything smaller is a guess that
 * the deadline check then treats as a fact; see `TransientRetryOptions.
 * attemptTimeoutMs`. Two literals — one here and one in the projection — is
 * exactly how a 90s transport and a 60s reservation come to disagree.
 */
export const CLIENT_TIMEOUT_MS = 90_000;

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
      timeout: CLIENT_TIMEOUT_MS,
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
 *               A different failure mode with a different remedy.
 *
 *               CORRECTED RECORD (V2). This paragraph used to end "it is not
 *               reached from here and must not be", and that was FALSE when it
 *               was written. A call failure that escaped this wrapper — a
 *               permanent 400, or a transient one that exhausted the attempt
 *               budget — was rethrown into `generateGroup`, whose reparse
 *               retry re-attempted ANY error and therefore made a second call.
 *               It was reached from here, on every degraded group, twice per
 *               group. That is the same defect as U2's "sent EXACTLY ONCE"
 *               claim and it was the mechanism of the V1 false-notice exploit.
 *               `generateGroup` now scopes the reparse retry to the classes
 *               `classify` calls model-derived, so the sentence is true — as a
 *               property of that function, not of this comment.
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
  /**
   * V3 — the WORST CASE cost of an attempt that has not happened yet.
   * Defaults to `CLIENT_TIMEOUT_MS`, which is the only true upper bound: the
   * transport gives up at that mark and not one millisecond earlier, so a
   * retry approved on a smaller number is approved on a hope.
   *
   * Injected only so the deadline tests can state a small, exact number
   * instead of arranging a 90-second clock.
   */
  attemptTimeoutMs?: number;
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
  const attemptTimeoutMs = Math.max(0, opts.attemptTimeoutMs ?? CLIENT_TIMEOUT_MS);
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (req) => {
    const group = req.groupName ?? 'unknown';
    /**
     * The longest attempt MEASURED so far. Kept for the LOG, and as a floor
     * under the projection — not as the projection itself.
     *
     * V3 — THE DEFECT THIS REPLACES. This number alone used to decide whether
     * a retry fits. It is a measurement of attempts that ALREADY FAILED, and
     * the cheapest failure in this system is the fastest: a 529 from the edge
     * comes back in single-digit milliseconds, so after three of them
     * `longestAttemptMs` is ~5ms and the check reserved ~5ms for a call the
     * transport is willing to spend `CLIENT_TIMEOUT_MS` on. A retry approved
     * at 239.9s of a 240s mark passed that check and could then run for a
     * further 90 seconds — straight through `maxDuration`, into the platform
     * kill, into the 502 that loses every surface and every gate finding.
     * That is the exact outcome the deadline exists to prevent, approved by
     * the deadline's own check.
     *
     * So the projection is the WORST CASE for an attempt that has not
     * happened yet, and the worst case is the client timeout. A measured
     * attempt that somehow ran LONGER than the timeout (a clock jump, an
     * injected client) still wins, because it is evidence and the constant is
     * only a bound.
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
        // V3 — see `longestAttemptMs`. The projection is the client timeout,
        // raised only by a measured attempt that exceeded it.
        const projectedAttemptMs = Math.max(longestAttemptMs, attemptTimeoutMs);
        if (
          typeof opts.deadline === 'number' &&
          now() + backoff + projectedAttemptMs > opts.deadline
        ) {
          // D5 — stop rather than overrun. The group degrades, which is a
          // complete and honest `verified:false`; overrunning is a 502.
          logServer('llm.retry_deadline_stop', {
            group,
            attempt,
            backoffMs: backoff,
            projectedAttemptMs,
            measuredAttemptMs: longestAttemptMs,
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
export function generationFailurePayload(
  f: SafeErrorFields | null,
  /**
   * V1 — the groups this failure actually cost, and how many the run has.
   * OMITTED entirely when not supplied, so a caller that has no scope to give
   * produces exactly the object it produced before scope existed.
   */
  scope?: { groups: readonly string[]; total: number },
): GenerationFailure | null {
  if (!f) return null;
  return {
    class: f.error,
    ...(f.status !== undefined ? { status: f.status } : {}),
    ...(f.apiType ? { apiType: f.apiType } : {}),
    ...(f.requestId ? { requestId: f.requestId } : {}),
    summary: upstreamFailureSummary(f),
    ...(scope ? { groups: [...scope.groups], groupsTotal: scope.total } : {}),
  };
}

/** The name a call that did not declare a group is recorded under. */
export const UNNAMED_GROUP = 'unknown';

export interface UpstreamGroupFailure {
  group: string;
  safe: SafeErrorFields;
}

export interface UpstreamFailureRecorder {
  llm: LlmClient;
  /**
   * The earliest still-UNRESOLVED call failure, or null when every group that
   * failed went on to succeed.
   */
  firstFailure: () => SafeErrorFields | null;
  /** Every still-unresolved failure with the group it belongs to, in order. */
  openFailures: () => UpstreamGroupFailure[];
  /** The groups whose call failure was never followed by a success, in order. */
  failedGroups: () => string[];
}

/**
 * Wrap a client so the first UNRECOVERED transport/API failure of each GROUP is
 * available to the caller after the run finishes.
 *
 * This is how an operator staring at nine `GEN` gate failures gets told the run
 * died on a 401 instead of being left to infer it. It wraps the CLIENT, so
 * everything it sees is by construction a call failure — a parse failure never
 * reaches it, and model output never enters this path at all.
 *
 * V1 — WHY IT UN-LATCHES, AND WHAT THE OLD LATCH DID.
 *
 * It used to keep the FIRST failure of the whole run, forever, on the reasoning
 * that `withTransientRetry` sits inside it and therefore only escaped failures
 * are ever seen. That reasoning had a hole, and the hole was reachable: the
 * reparse retry in `generateGroup` sits ABOVE this wrapper, so a call failure
 * that escaped the retry wrapper was still followed by a SECOND call, and if
 * that call succeeded THE GROUP SUCCEEDED. The run then came back
 * `verified:true` with no degraded group at all — and a latched failure, which
 * the routes attached unconditionally, which rendered U1's banner, which told
 * the operator that "generation never ran" and that "the failures below are NOT
 * a judgement of your listing". On a run with genuine compliance failures that
 * is the precise operator-conditioning hazard U1 was built to prevent, wearing
 * U1's own colours. (V2 removes one of the two ways in by scoping the reparse
 * retry to schema failures; this removes the class.)
 *
 * So the record is PER GROUP and it is CLEARED when that same group later
 * returns a value. What survives is exactly "this group's copy could not be
 * fetched", which is the claim the notice makes and the claim
 * `degradedGroups` makes — the two now agree by construction rather than by
 * hope.
 *
 * A call that declares no `groupName` is recorded under `UNNAMED_GROUP`. No
 * such caller exists (`generateGroup` always names its group, asserted in
 * `tests/generationFailure.scope.v1.test.ts`); if one were added, its failure
 * could not intersect any degraded group and so would raise no notice. That is
 * the fail-closed direction: a missing notice, never a false one.
 *
 * It records and RETHROWS: the degrade behaviour downstream, and therefore
 * `verified`, is completely untouched. Removing the wrapper would change
 * nothing except how much the operator is told.
 */
export function recordUpstreamFailures(inner: LlmClient): UpstreamFailureRecorder {
  // Insertion-ordered, so "first" means first observed rather than
  // alphabetically first. A `Map` delete + re-set on a group that fails, then
  // succeeds, then fails again correctly moves it to the end: the surviving
  // failure really is the later one.
  const open = new Map<string, SafeErrorFields>();
  return {
    llm: async (req) => {
      const group = req.groupName ?? UNNAMED_GROUP;
      try {
        const text = await inner(req);
        // THE UN-LATCH. This group produced copy, so whatever went wrong on the
        // way is no longer something the operator needs to be warned about.
        open.delete(group);
        return text;
      } catch (e) {
        if (!open.has(group)) open.set(group, describeError(e));
        throw e;
      }
    },
    firstFailure: () => open.values().next().value ?? null,
    openFailures: () => [...open].map(([group, safe]) => ({ group, safe })),
    failedGroups: () => [...open.keys()],
  };
}

/**
 * V1 — THE ONE RULE that decides whether a run gets the upstream-failure
 * notice, and what the notice may claim.
 *
 * Both routes call this instead of attaching `firstFailure()` unconditionally.
 *
 * THE RULE: a group raises the notice only if it BOTH failed upstream without
 * recovering AND is still degraded in the listing being returned. The
 * intersection is the notice's SCOPE.
 *
 * WHY THE INTERSECTION RATHER THAN EITHER SIDE ALONE.
 *
 *   `degradedGroups` alone would be wrong in the other direction: a group that
 *   degraded purely on schema validation never involved an upstream failure,
 *   and captioning it "the upstream model API could not be reached" would be a
 *   second false statement of cause.
 *
 *   The recorder alone is *nearly* right after the un-latch above — but "nearly"
 *   is what the exploit was made of. `degradedGroups` is what `GEN` and
 *   therefore `verified` are computed from, so cross-checking against it makes
 *   the notice's scope a subset of the run's own record of what is missing, by
 *   construction, no matter what future composition someone builds around this.
 *
 * THE PARTIAL CASE IS THE POINT. When some groups degraded and others
 * recovered, the operator is STILL told — silence would hide a real,
 * unexplained hole in the copy — but the notice names the groups it covers and
 * the wording (`lib/shared/generationFailure.ts`) restricts the caveat to
 * them, so the failures on the surfaces that DID generate are left standing as
 * the real findings they are.
 *
 * It decides nothing: `verified` is computed only in `lib/audit/buildAudit.ts`,
 * and this reads `degradedGroups` without writing it.
 */
export function recordedGenerationFailure(
  recorder: Pick<UpstreamFailureRecorder, 'openFailures'>,
  degradedGroups: readonly string[] | undefined,
  totalGroups: number,
): GenerationFailure | null {
  const stillDegraded = new Set(degradedGroups ?? []);
  const inScope = recorder.openFailures().filter((f) => stillDegraded.has(f.group));
  if (inScope.length === 0) return null;
  // The IDENTITY is the first failure IN SCOPE, not the first failure of the
  // run: quoting the status of a group that recovered, or of a group that is
  // not degraded, would name a cause the notice does not cover.
  return generationFailurePayload(inScope[0]!.safe, {
    groups: inScope.map((f) => f.group),
    total: totalGroups,
  });
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

/**
 * V2 — is this failure one the REPARSE RETRY can do anything about?
 *
 * Expressed as a question about the EXISTING taxonomy rather than as a second
 * list of classes beside it: the reparse retry re-sends the prompt with the
 * validation error appended, which is a remedy for output the model produced
 * and nothing else. `classify` already partitions exactly that way —
 * `'schema'` (`ZodError`) and `'truncated-or-unparseable'` (`SyntaxError` from
 * `JSON.parse`, and `extractJson`'s own error) are the model's output;
 * `'transport'` is everything else. So this is a one-line consequence of
 * `classify` and cannot drift from it.
 */
function isReparseable(e: unknown): boolean {
  return classify(e) !== 'transport';
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
 *
 * V2 — THE REPARSE RETRY IS FOR SCHEMA AND JSON FAILURES, AND NOW ONLY THOSE.
 *
 * It re-attempted ANY error, and for a TRANSPORT failure that was wrong twice
 * over:
 *
 *   IT COST A SECOND CALL PER GROUP. During the credit-balance outage every
 *   group made two calls, not one — 18 per run against an account that could
 *   not pay for the first nine. U2's own commit claimed a 400 was "sent
 *   EXACTLY ONCE"; U2's own pipeline test pinned `ALL_GROUPS.length * 2` and
 *   was right. See CONFORMANCE-DEVIATIONS §15.4.
 *
 *   IT FED THE SDK'S ERROR TO THE MODEL. `detail` becomes the prompt line
 *   "your previous output was invalid: 400 {...credit balance too low...}".
 *   The model produced no previous output; there is nothing for it to correct;
 *   the sentence is incoherent, and it sends a redacted transport error back
 *   upstream to be read as a description of the model's own work.
 *
 *   AND IT WAS THE MECHANISM OF A FALSE OPERATOR NOTICE. A transport failure
 *   whose reparse call SUCCEEDED produced a healthy group off the back of a
 *   failure the run recorder had already latched — see the V1 note on
 *   `recordUpstreamFailures`.
 *
 * A transport failure now goes straight to the degrade path with reason
 * `'transport'`, which is the reason it was classified with before, so `GEN`,
 * the degrade routing and `verified` see exactly what they saw.
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
    if (!isReparseable(e)) {
      // V2 — the call did not return. There is no model output to correct, so
      // there is nothing a reparse retry can do except spend a second call and
      // hand the SDK's message to the model as if it were the model's own.
      // Degrade now, with the SAME classification and the SAME safe fields the
      // second attempt would have produced.
      throw new GroupGenerationError(
        groupName,
        classify(e),
        zodIssuePaths(e),
        `Group '${groupName}' failed upstream: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
        describeError(e),
      );
    }
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
