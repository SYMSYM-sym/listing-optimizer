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

// ---------------------------------------------------------------------------
// V1 — SCOPE. The notice may only claim what the failure actually cost.
// ---------------------------------------------------------------------------

/**
 * V1 — WHY THE TWO CONSTANTS ABOVE ARE NO LONGER THE WHOLE STORY.
 *
 * They say "the copy for THIS RUN was never written" and "the failures shown
 * below are NOT a judgement of your listing", unconditionally. Those sentences
 * are true of the outage they were written for — every group failed on the same
 * 400 — and FALSE of a run where some groups degraded and others generated
 * normally. On such a run the caveat tells the operator that real compliance
 * failures on real, generated copy are not a judgement of their listing. That
 * is the operator-conditioning hazard this whole feature exists to prevent,
 * printed in the feature's own words.
 *
 * So the wording is now a FUNCTION of the failure's scope:
 *
 *   WHOLE RUN  `groups` covers every group. The constants above, unchanged, so
 *              the outage case renders byte-for-byte what it rendered before.
 *   PARTIAL    `groups` is a strict subset. The notice names the groups, and
 *              the caveat is restricted to them — everything else on the screen
 *              is left standing as the real finding it is.
 *   UNKNOWN    `groups` absent. LEGACY ROWS ONLY: written before scope existed,
 *              by code that attached the notice unconditionally. They render
 *              the whole-run wording, which is exactly what they rendered
 *              yesterday. This change stops FALSE notices being written; it
 *              does not retroactively re-caption stored ones, because there is
 *              no evidence in the row to re-caption them from.
 */
export function generationFailureIsPartial(f: GenerationFailure): boolean {
  return (
    Array.isArray(f.groups) &&
    typeof f.groupsTotal === 'number' &&
    f.groups.length > 0 &&
    f.groups.length < f.groupsTotal
  );
}

/**
 * The scope sentence, or `null` when the failure covers the whole run (or has
 * no scope at all) and there is nothing to narrow.
 */
export function generationFailureScopeLine(f: GenerationFailure): string | null {
  if (!generationFailureIsPartial(f)) return null;
  const groups = f.groups!;
  return `${groups.length} of ${f.groupsTotal} content groups could not be generated: ${groups.join(', ')}.`;
}

/**
 * The caveat, RESTRICTED to what the failure actually cost.
 *
 * This is the load-bearing sentence of the whole notice and the one a partial
 * run must not over-claim: on a partial run the failures that do NOT touch the
 * degraded groups are ordinary, honest compliance findings, and saying
 * otherwise is worse than saying nothing.
 */
export function generationFailureCaveat(f: GenerationFailure): string {
  if (!generationFailureIsPartial(f)) return GENERATION_FAILURE_CAVEAT;
  return (
    `The failures shown below that come from ${f.groups!.join(', ')} are NOT a judgement of your listing. ` +
    'Every other failure below IS: those surfaces generated normally and the gate graded real copy.'
  );
}

/** The explanation, matched to the same scope. */
export function generationFailureContext(f: GenerationFailure): string {
  if (!generationFailureIsPartial(f)) return GENERATION_FAILURE_CONTEXT;
  return (
    `The copy for ${f.groups!.join(', ')} was never written, so the gate graded empty and partial fields there. ` +
    'The rest of the run generated normally. ' +
    'Nothing below is hidden or reworded: the checker output is never edited. ' +
    'Re-run once the upstream API is healthy.'
  );
}

/**
 * V1 — NARROW a notice to the groups that are STILL degraded, or drop it.
 *
 * THE PROBLEM IT SOLVES. `updateRun` was SET-ONLY: a regeneration could add a
 * notice and could never clear one. The reason recorded for that was sound — a
 * single-group regeneration rewrites ONE group of nine and cannot honestly
 * announce that the other eight recovered — but the rule it produced was too
 * blunt in the other direction: a run whose ONLY degraded group was
 * successfully regenerated stayed amber in History forever, and after the V1
 * exploit a run that never degraded at all could be branded amber permanently
 * by one recovered blip.
 *
 * THE RULE, which is neither set-only nor clear-on-success: a notice covers a
 * SET OF GROUPS, and it survives exactly as long as any of them is still
 * degraded. Recovering one of several NARROWS it; recovering all of them drops
 * it; recovering none leaves it untouched. So the eight groups a single-group
 * regeneration did not touch keep the notice alive on their own — the original
 * reason for set-only is preserved as a CONSEQUENCE of the rule rather than as
 * a separate prohibition.
 *
 * `stillDegraded` is the regenerated listing's own `degradedGroups`, which is
 * what `GEN` and therefore `verified` are computed from. The notice can never
 * outlive, or out-claim, the record the verdict is built on.
 *
 * A notice with NO scope (legacy) is returned UNCHANGED — set-only, as before.
 * There is nothing to narrow it by, and dropping it on a guess would be
 * announcing a recovery that may not have happened.
 */
export function narrowGenerationFailure(
  stored: GenerationFailure | null | undefined,
  stillDegraded: readonly string[] | undefined,
): GenerationFailure | null {
  if (!stored) return null;
  if (!Array.isArray(stored.groups)) return stored;
  const degraded = new Set(stillDegraded ?? []);
  const groups = stored.groups.filter((g) => degraded.has(g));
  if (groups.length === 0) return null;
  if (groups.length === stored.groups.length) return stored;
  return { ...stored, groups };
}

/**
 * V1 — combine the notice a run already carried with one raised by the round
 * that just ran.
 *
 * `narrowGenerationFailure` runs FIRST (the caller does it, so the two steps
 * are separately testable); this only merges what survived with what is new.
 *
 * IDENTITY comes from the INCOMING failure when there is one — it is the thing
 * that just went wrong and the thing an operator would quote to support.
 * SCOPE is the union, so a regeneration that fails upstream does not erase the
 * groups the earlier run had already lost. If either side has no scope the
 * merged notice has none either: a union with an unknown set is unknown, and
 * claiming otherwise would be inventing a boundary.
 */
export function mergeGenerationFailure(
  carried: GenerationFailure | null | undefined,
  incoming: GenerationFailure | null | undefined,
): GenerationFailure | null {
  if (!incoming) return carried ?? null;
  if (!carried) return incoming;
  if (!Array.isArray(carried.groups) || !Array.isArray(incoming.groups)) {
    const { groups: _g, groupsTotal: _t, ...rest } = incoming;
    return rest;
  }
  const groups = [...new Set([...carried.groups, ...incoming.groups])];
  return { ...incoming, groups };
}

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
/** Bounds on the persisted SCOPE. Engine group names are short and few. */
const MAX_GROUPS = 32;
const MAX_GROUP_NAME = 64;

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
  /**
   * V1 — SCOPE, read back with the same suspicion as everything else here.
   *
   * BOTH fields or NEITHER. A `groups` list with no total cannot answer
   * "partial or whole?", and a total with no list cannot name anything, so a
   * half-record degrades to UNKNOWN scope — which renders the whole-run
   * wording, i.e. exactly what a row with no scope at all renders. Nothing new
   * is claimed from a broken record.
   */
  const groups = Array.isArray(raw.groups)
    ? raw.groups
        .map((g) => str(g, MAX_GROUP_NAME))
        .filter((g): g is string => g !== undefined)
        .slice(0, MAX_GROUPS)
    : undefined;
  const groupsTotal =
    typeof raw.groupsTotal === 'number' && Number.isFinite(raw.groupsTotal) && raw.groupsTotal > 0
      ? Math.trunc(raw.groupsTotal)
      : undefined;
  const scoped = groups !== undefined && groups.length > 0 && groupsTotal !== undefined;
  return {
    class: cls,
    ...(status !== undefined ? { status } : {}),
    ...(apiType ? { apiType } : {}),
    ...(requestId ? { requestId } : {}),
    summary,
    ...(scoped ? { groups, groupsTotal } : {}),
  };
}
