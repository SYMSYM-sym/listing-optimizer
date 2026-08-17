import type { GenerationFailure } from '@/lib/types';

/**
 * U3 — THE ONE PLACE THE UPSTREAM-FAILURE NOTICE IS WORDED, AND THE ONE PLACE
 * A STORED ONE IS VALIDATED.
 *
 * U1 put a banner on the LIVE optimize screen: a run that came back degraded
 * because the model API was unpaid or unreachable is told, above everything
 * else, that generation never ran and that the gate failures below are not a
 * judgement of the listing. It closed the live surface and left one open — a
 * run REPLAYED from History carried no `generationFailure` at all, because
 * nothing persisted it, so re-opening yesterday's degraded run showed eleven
 * gate failures and no cause. Exactly the misleading state U1 was built to
 * prevent, one surface over.
 *
 * Closing it means the notice now has to appear on surfaces that are not
 * React: the Markdown export (a text record) and the Ship Sheet (an HTML
 * string). A React component cannot be shared with either, so what IS shared
 * is the WORDS — the heading, the caveat sentence, the identity line — and
 * each medium decides only how to mark them up. Two independently written
 * copies of this notice would drift exactly the way the two surface readers
 * this project already had to reconcile drifted.
 *
 * ISOMORPHIC ON PURPOSE. `lib/engine/llm.ts` owns how the payload is BUILT and
 * is `server-only`; the store, the exports and the browser all need these, so
 * they live here beside the other shared primitives.
 *
 * NOTHING HERE DECIDES ANYTHING. `verified` is computed only in
 * `lib/audit/buildAudit.ts`. Every function in this file is presentation, or
 * validation of a field that no gate check, no score and no verdict reads.
 */

/** The notice heading — identical wording on every surface. */
export const GENERATION_FAILURE_HEADING =
  'Generation failed upstream — this run is incomplete';

/**
 * The sentence the whole feature exists to say. Verbatim across the panel, the
 * Markdown record and the Ship Sheet.
 */
export const GENERATION_FAILURE_CAVEAT =
  'The failures shown below are NOT a judgement of your listing.';

/**
 * The medium-neutral explanation. The panel adds UI-specific prose after it
 * (which buttons are locked); the record and the sheet print it as-is.
 */
export const GENERATION_FAILURE_CONTEXT =
  'The copy for this run was never written, so the gate graded empty and partial fields. ' +
  'Nothing below is hidden or reworded: the checker output is never edited. ' +
  'Re-run once the upstream API is healthy.';

/**
 * The identity line — class, HTTP status, the API's own error type and the
 * request id, in that order, omitting whatever the failure did not carry.
 *
 * Built from the SAME four fields on every surface, so an operator reading the
 * Ship Sheet and an operator reading the panel quote support the same string.
 */
export function generationFailureDetail(f: GenerationFailure): string {
  return [
    `class ${f.class}`,
    f.status !== undefined ? `HTTP ${f.status}` : null,
    f.apiType ?? null,
    f.requestId ? `request ${f.requestId}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
}

// ---------------------------------------------------------------------------
// Reading one back out of storage
// ---------------------------------------------------------------------------

/** Bounds on persisted strings — a junk row can never render a wall of text. */
const MAX_SUMMARY = 400;
const MAX_FIELD = 200;

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s.slice(0, max);
};

/**
 * Validate a value read back out of `runs.generation_failure` (jsonb).
 *
 * FAIL-CLOSED TOWARD NO BANNER, and that direction is the load-bearing one.
 * The notice's value comes entirely from being TRUE: a false "the upstream API
 * failed" caption on a run whose copy really does fail compliance would teach
 * operators that gate failures are noise, and the next real one gets waved
 * through. So anything this function cannot positively recognise as a failure
 * record becomes `null`, and the run renders exactly as it does today.
 *
 * WHAT IT MUST SURVIVE, all of which reach it in practice:
 *
 *   ABSENT     a row written before the column existed. `undefined`/`null` are
 *              the ordinary case, not an error — the History page failing to
 *              load would be a far worse outcome than a missing notice.
 *   MALFORMED  a string, a number, an array, a nested object, a partial record
 *              with no `summary`, a `status` that is a string. All → `null`.
 *   REBUILT    the returned object is CONSTRUCTED FIELD BY FIELD, never spread
 *              from the input, so a key that is not in the contract cannot
 *              survive a round trip — including `message`, which `e885f23`
 *              deliberately kept out of every browser-bound body and which is
 *              stripped here even if some future writer persisted it.
 *
 * `class` and `summary` are both REQUIRED: the notice names the class and
 * quotes the summary, and half a notice is not worth showing.
 */
export function coerceGenerationFailure(value: unknown): GenerationFailure | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const cls = str(raw.class, MAX_FIELD);
  const summary = str(raw.summary, MAX_SUMMARY);
  if (!cls || !summary) return null;
  const status =
    typeof raw.status === 'number' && Number.isFinite(raw.status)
      ? Math.trunc(raw.status)
      : undefined;
  const apiType = str(raw.apiType, MAX_FIELD);
  const requestId = str(raw.requestId, MAX_FIELD);
  return {
    class: cls,
    ...(status !== undefined ? { status } : {}),
    ...(apiType ? { apiType } : {}),
    ...(requestId ? { requestId } : {}),
    summary,
  };
}
