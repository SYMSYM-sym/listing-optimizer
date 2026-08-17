import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APIError } from '@anthropic-ai/sdk';
import { GenerationFailureBanner } from '@/app/ResultsPanel';
import { buildAudit } from '@/lib/audit/buildAudit';
import {
  generationFailurePayload,
  recordedGenerationFailure,
  recordUpstreamFailures,
  withTransientRetry,
  type LlmClient,
} from '@/lib/engine/llm';
import { ALL_GROUPS, optimize } from '@/lib/engine/optimize';
import { toMarkdown } from '@/lib/export/markdown';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import {
  coerceGenerationFailure,
  generationFailureCaveat,
  generationFailureIsPartial,
  generationFailureScopeLine,
  mergeGenerationFailure,
  narrowGenerationFailure,
  GENERATION_FAILURE_CAVEAT,
} from '@/lib/shared/generationFailure';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { GenerationFailure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * V1 — THE NOTICE MUST DESCRIBE THE RUN THAT ACTUALLY HAPPENED.
 *
 * THE EXPLOIT, proven at runtime against the real composition before this fix.
 * `recordUpstreamFailures` latched the FIRST call failure of a run and never
 * let go. But `generateGroup`'s reparse retry sits ABOVE `withTransientRetry`
 * and re-attempted ANY error, so a call failure that escaped the retry wrapper
 * was followed by a SECOND call — and when that call succeeded, THE GROUP
 * SUCCEEDED. The run came back `verified: true` with zero degraded groups,
 * `firstFailure()` was still latched, `/api/optimize` attached it
 * unconditionally, and U1's banner announced that "generation never ran" and
 * that "the failures below are NOT a judgement of your listing".
 *
 * Two trigger paths were demonstrated:
 *   (1) a one-shot `LLM returned no text content` blip — classified
 *       non-transient, so `withTransientRetry` passes it straight through —
 *       recovered by the reparse call;
 *   (2) a 529 that persisted through all three wrapper attempts and then
 *       succeeded on the reparse call.
 *
 * WHY THIS IS THE DANGEROUS DIRECTION. On a run with GENUINE compliance
 * failures plus one recovered blip, the operator is told those failures are not
 * a judgement of their listing. That is the exact operator-conditioning hazard
 * U1 was built to prevent, printed in U1's own words. And one blip during a
 * regenerate branded a healthy stored run amber in History permanently, because
 * `updateRun` was set-only.
 *
 * THE RULE THIS PINS. A group raises the notice only if it BOTH failed upstream
 * without recovering AND is still degraded in the listing being returned; the
 * intersection is the notice's SCOPE; and the wording is restricted to that
 * scope, so a PARTIAL failure is still reported but cannot excuse the findings
 * on the surfaces that generated normally.
 *
 * §1 the recorder un-latches on the group's own success
 * §2 the two exploit paths, re-run: no notice, nothing persisted, verdict unmoved
 * §3 a genuinely degraded run is unchanged; a partial one is accurate
 * §4 a regeneration narrows, clears or keeps the stored notice
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };
const neverSleeps = async () => {};
const noJitter = () => 0;

const apiError = (status: number, apiType: string): APIError =>
  APIError.generate(
    status,
    { type: 'error', error: { type: apiType, message: `synthetic ${status}` } },
    undefined,
    new Headers({ 'request-id': `req_v1_${status}` }),
  );

/** Path (1): non-transient, so it reaches `generateGroup` on the first call. */
const NO_TEXT_BLIP = new Error(
  'LLM returned no text content (stop_reason=max_tokens; blocks=none)',
);
/** Path (2): transient, exhausts the wrapper's three attempts. */
const OVERLOADED_529 = apiError(529, 'overloaded_error');
/** The live outage: an exhausted credit balance. Permanent. */
const CREDIT_BALANCE_400 = apiError(400, 'invalid_request_error');

const call = (llm: LlmClient, group: string) =>
  llm({ system: 's', user: 'u', maxTokens: 10, groupName: group });

const renderBanner = (failure?: GenerationFailure | null): string =>
  renderToStaticMarkup(createElement(GenerationFailureBanner, { failure }));

// ===========================================================================
// 1 — THE RECORDER. A failure is held open only while the group is still down.
// ===========================================================================

describe('V1 §1 — recordUpstreamFailures un-latches when the same group succeeds', () => {
  it('a group that fails then succeeds leaves NO open failure', async () => {
    let first = true;
    const gen = recordUpstreamFailures(async () => {
      if (first) {
        first = false;
        throw CREDIT_BALANCE_400;
      }
      return '{"ok":true}';
    });
    await expect(call(gen.llm, 'title')).rejects.toBe(CREDIT_BALANCE_400);
    expect(gen.failedGroups()).toEqual(['title']);
    await expect(call(gen.llm, 'title')).resolves.toBe('{"ok":true}');
    expect(gen.failedGroups()).toEqual([]);
    expect(gen.firstFailure()).toBeNull();
  });

  it('a DIFFERENT group succeeding does not clear the failed one', async () => {
    const gen = recordUpstreamFailures(async (req) => {
      if (req.groupName === 'bullets') throw CREDIT_BALANCE_400;
      return '{"ok":true}';
    });
    await expect(call(gen.llm, 'bullets')).rejects.toBe(CREDIT_BALANCE_400);
    await call(gen.llm, 'title');
    expect(gen.failedGroups()).toEqual(['bullets']);
    expect(gen.firstFailure()!.status).toBe(400);
  });

  it('a group that fails, recovers, then fails AGAIN records the LATER failure', async () => {
    const seq: unknown[] = [apiError(401, 'authentication_error'), null, apiError(429, 'rate_limit_error')];
    let i = 0;
    const gen = recordUpstreamFailures(async () => {
      const step = seq[i++];
      if (step) throw step;
      return '{"ok":true}';
    });
    await call(gen.llm, 'qa').catch(() => {});
    await call(gen.llm, 'qa');
    await call(gen.llm, 'qa').catch(() => {});
    expect(gen.failedGroups()).toEqual(['qa']);
    expect(gen.firstFailure()!.status).toBe(429);
  });

  it('failures are ordered by first observation, and that is the notice identity', () => {
    const failure = recordedGenerationFailure(
      {
        openFailures: () => [
          { group: 'bullets', safe: { error: 'APIError', status: 500, issuePaths: [] } },
          { group: 'qa', safe: { error: 'APIError', status: 429, issuePaths: [] } },
        ],
      },
      ['qa', 'bullets'],
      ALL_GROUPS.length,
    );
    expect(failure!.status).toBe(500);
    expect(failure!.groups).toEqual(['bullets', 'qa']);
  });

  it('a failure whose group is NOT degraded raises nothing — the cross-check', () => {
    // Belt and braces on top of the un-latch: even if a failure were somehow
    // still held open for a group the run did not lose, it cannot caption it.
    expect(
      recordedGenerationFailure(
        { openFailures: () => [{ group: 'title', safe: { error: 'APIError', status: 400, issuePaths: [] } }] },
        [],
        ALL_GROUPS.length,
      ),
    ).toBeNull();
    expect(
      recordedGenerationFailure(
        { openFailures: () => [{ group: 'title', safe: { error: 'APIError', status: 400, issuePaths: [] } }] },
        undefined,
        ALL_GROUPS.length,
      ),
    ).toBeNull();
  });

  it('every call `generateGroup` makes names its group, so nothing lands under `unknown`', async () => {
    const seen: (string | undefined)[] = [];
    const spy: LlmClient = async (req) => {
      seen.push(req.groupName);
      return mockLlm(req);
    };
    await optimize(snapshot, pack, spy);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((g) => g === undefined || g === 'unknown')).toEqual([]);
  });
});

// ===========================================================================
// 2 — THE EXPLOIT, RE-RUN. Both proven paths, on a healthy run and on one with
//     genuine gate failures. The dangerous direction is the second.
// ===========================================================================

/** A client that throws `e` on its first `n` calls, then generates normally. */
function blipThen(e: unknown, n: number): LlmClient {
  let thrown = 0;
  return async (req) => {
    if (thrown < n) {
      thrown++;
      throw e;
    }
    return mockLlm(req);
  };
}

describe('V1 §2 — a recovered blip on an otherwise healthy run raises NO notice', () => {
  it('EXPLOIT PATH 1: a one-shot no-text-content blip recovered by the reparse call', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(blipThen(NO_TEXT_BLIP, 1), { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 1);
    // The run really did recover: this is the condition that made the old
    // behaviour a lie rather than a mere over-report.
    expect(result.audit.verified).toBe(true);
    expect('degradedGroups' in result.optimized).toBe(false);
    // The old code returned a payload here. The route attached it, the banner
    // rendered, and `saveRun` persisted it.
    expect(
      recordedGenerationFailure(gen, result.optimized.degradedGroups, ALL_GROUPS.length),
    ).toBeNull();
    expect(gen.failedGroups()).toEqual([]);
    expect(renderBanner(null)).toBe('');
  });

  it('EXPLOIT PATH 2: a 529 through all three wrapper attempts, then a reparse success', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(blipThen(OVERLOADED_529, 3), { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 1);
    expect(result.audit.verified).toBe(true);
    expect('degradedGroups' in result.optimized).toBe(false);
    expect(
      recordedGenerationFailure(gen, result.optimized.degradedGroups, ALL_GROUPS.length),
    ).toBeNull();
  });

  it('THE DANGEROUS DIRECTION: the same recovery on a run with REAL gate failures', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(blipThen(NO_TEXT_BLIP, 1), { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 1);
    // A genuine, deterministic compliance failure on copy the model really did
    // write — nothing about it is upstream.
    const optimized: OptimizedListing = {
      ...result.optimized,
      backendSearchTerms: 'ä'.repeat(200),
    };
    const audit = buildAudit(snapshot, optimized, pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.gateResult.failures.length).toBeGreaterThan(0);

    const failure = recordedGenerationFailure(
      gen,
      optimized.degradedGroups,
      ALL_GROUPS.length,
    );
    // NO banner. The operator is not told that a real compliance failure is
    // "NOT a judgement of your listing".
    expect(failure).toBeNull();
    expect(renderBanner(failure)).toBe('');
    // ...and the real failures render exactly as they always did.
    const md = toMarkdown(optimized, audit, failure);
    expect(md).toContain('NOT VERIFIED');
    expect(md).not.toContain('Generation failed upstream');
    expect(md).toBe(toMarkdown(optimized, audit));
  });

  it('nothing is persisted: the store input omits the key entirely', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(blipThen(NO_TEXT_BLIP, 1), { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 1);
    const failure = recordedGenerationFailure(
      gen,
      result.optimized.degradedGroups,
      ALL_GROUPS.length,
    );
    const saveInput = { verified: result.audit.verified, ...(failure ? { generationFailure: failure } : {}) };
    expect(saveInput).not.toHaveProperty('generationFailure');
  });

  it('`verified` is unaffected in every direction — the recorder still decides nothing', async () => {
    const withBlip = recordUpstreamFailures(
      withTransientRetry(blipThen(NO_TEXT_BLIP, 1), { random: noJitter, sleep: neverSleeps }),
    );
    const blipped = await runPipeline(snapshot, withBlip.llm, 1);
    const clean = await runPipeline(snapshot, mockLlm, 1);
    expect(blipped.audit.verified).toBe(clean.audit.verified);
    expect(blipped.audit.gateResult.failures).toEqual(clean.audit.gateResult.failures);
  });
});

// ===========================================================================
// 3 — A GENUINELY DEGRADED RUN IS UNCHANGED; A PARTIAL ONE IS ACCURATE.
// ===========================================================================

describe('V1 §3 — a genuinely degraded run gets the banner exactly as today', () => {
  it('a permanent 400 on every group: notice present, whole-run wording, unchanged', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(async () => {
        throw CREDIT_BALANCE_400;
      }, { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 0);
    expect(result.audit.verified).toBe(false);
    expect([...(result.optimized.degradedGroups ?? [])].sort()).toEqual([...ALL_GROUPS].sort());

    const failure = recordedGenerationFailure(
      gen,
      result.optimized.degradedGroups,
      ALL_GROUPS.length,
    )!;
    expect(failure.status).toBe(400);
    expect(failure.groups!.sort()).toEqual([...ALL_GROUPS].sort());
    expect(generationFailureIsPartial(failure)).toBe(false);
    // The wording an operator saw before this change, to the character.
    expect(generationFailureCaveat(failure)).toBe(GENERATION_FAILURE_CAVEAT);
    expect(generationFailureScopeLine(failure)).toBeNull();
    const html = renderBanner(failure);
    expect(html).toContain('generation-failure-banner');
    expect(html).toContain(GENERATION_FAILURE_CAVEAT);
    expect(html).toContain('The copy for this run was never written');
  });
});

describe('V1 §3b — a PARTIALLY degraded run is told the truth about scope', () => {
  /** Only `bullets` and `qa` fail, permanently. Everything else generates. */
  const twoGroupsDown: LlmClient = async (req) => {
    if (req.groupName === 'bullets' || req.groupName === 'qa') throw CREDIT_BALANCE_400;
    return mockLlm(req);
  };

  it('the notice is RAISED — silence would hide a real hole in the copy', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(twoGroupsDown, { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 0);
    expect([...(result.optimized.degradedGroups ?? [])].sort()).toEqual(['bullets', 'qa']);
    const failure = recordedGenerationFailure(
      gen,
      result.optimized.degradedGroups,
      ALL_GROUPS.length,
    )!;
    expect(failure).not.toBeNull();
    expect([...failure.groups!].sort()).toEqual(['bullets', 'qa']);
    expect(failure.groupsTotal).toBe(ALL_GROUPS.length);
    expect(generationFailureIsPartial(failure)).toBe(true);
  });

  it('the wording NAMES the groups and does NOT excuse the rest of the listing', async () => {
    const gen = recordUpstreamFailures(
      withTransientRetry(twoGroupsDown, { random: noJitter, sleep: neverSleeps }),
    );
    const result = await runPipeline(snapshot, gen.llm, 0);
    const failure = recordedGenerationFailure(
      gen,
      result.optimized.degradedGroups,
      ALL_GROUPS.length,
    )!;
    const scope = generationFailureScopeLine(failure)!;
    expect(scope).toContain(`2 of ${ALL_GROUPS.length} content groups`);
    expect(scope).toContain('bullets');
    expect(scope).toContain('qa');

    const caveat = generationFailureCaveat(failure);
    // THE ASSERTION THIS SECTION EXISTS FOR. The unqualified sentence must not
    // appear: on a partial run it would tell the operator that compliance
    // failures on copy the model really wrote are not about their listing.
    expect(caveat).not.toBe(GENERATION_FAILURE_CAVEAT);
    expect(caveat).toContain('bullets, qa');
    // W1 — the positive clause. It used to read "Every other failure below IS",
    // a universal claim over every group outside the notice's scope that a
    // schema-degraded group falsifies; it now names the three states a run can
    // actually be in. See `tests/generationFailure.caveatTruth.w1.test.ts`.
    expect(caveat).toContain('Every remaining failure IS');

    const html = renderBanner(failure);
    expect(html).toContain('generation-failure-banner');
    expect(html).toContain('Every remaining failure IS');
    expect(html).not.toContain('The copy for this run was never written');
    // The Markdown record carries the same scope, out of the same module.
    const md = toMarkdown(result.optimized, result.audit, failure);
    expect(md).toContain(`2 of ${ALL_GROUPS.length} content groups`);
    expect(md).toContain('Every remaining failure IS');
  });

  it('a legacy notice with no scope keeps the whole-run wording it always had', () => {
    const legacy = generationFailurePayload({ error: 'APIError', status: 401, issuePaths: [] })!;
    expect(legacy).not.toHaveProperty('groups');
    expect(generationFailureIsPartial(legacy)).toBe(false);
    expect(generationFailureCaveat(legacy)).toBe(GENERATION_FAILURE_CAVEAT);
    expect(renderBanner(legacy)).toContain('The copy for this run was never written');
  });

  it('a half-record — groups with no total, or a total with no groups — reads as UNKNOWN scope', () => {
    const base = { class: 'APIError', summary: 'Generation failed: x.' };
    expect(coerceGenerationFailure({ ...base, groups: ['bullets'] })).not.toHaveProperty('groups');
    expect(coerceGenerationFailure({ ...base, groupsTotal: 9 })).not.toHaveProperty('groups');
    expect(coerceGenerationFailure({ ...base, groups: 'bullets', groupsTotal: 9 })).not.toHaveProperty('groups');
    expect(coerceGenerationFailure({ ...base, groups: [], groupsTotal: 9 })).not.toHaveProperty('groups');
    expect(coerceGenerationFailure({ ...base, groups: ['bullets'], groupsTotal: 9 })).toMatchObject({
      groups: ['bullets'],
      groupsTotal: 9,
    });
  });
});

// ===========================================================================
// 4 — THE REGENERATE PATH. Narrow, clear, or keep — never announce a recovery
//     that did not happen, and never brand a recovered run forever.
// ===========================================================================

describe('V1 §4 — narrowing a stored notice by what is STILL degraded', () => {
  const notice = (groups: string[]): GenerationFailure => ({
    class: 'APIError',
    status: 400,
    summary: 'Generation failed: the upstream model API returned an error (status 400).',
    groups,
    groupsTotal: ALL_GROUPS.length,
  });

  it('a regenerate that recovers the ONLY degraded group CLEARS the stale marker', () => {
    expect(narrowGenerationFailure(notice(['bullets']), [])).toBeNull();
    expect(narrowGenerationFailure(notice(['bullets']), undefined)).toBeNull();
  });

  it('a regenerate that recovers ONE OF SEVERAL keeps the marker and narrows it', () => {
    const narrowed = narrowGenerationFailure(notice(['bullets', 'qa', 'images']), ['qa', 'images'])!;
    expect(narrowed).not.toBeNull();
    expect(narrowed.groups).toEqual(['qa', 'images']);
    // ...and the wording follows the narrowed scope, so it still cannot excuse
    // the group that just came back.
    expect(generationFailureCaveat(narrowed)).toContain('qa, images');
    expect(generationFailureCaveat(narrowed)).not.toContain('bullets');
  });

  it('a single-group regenerate CANNOT announce recovery of the other eight', () => {
    // The original reason `updateRun` was set-only, preserved as a consequence
    // of the scoped rule rather than as a separate prohibition: the eight
    // untouched groups are still in `degradedGroups`, so they hold it open.
    const stillDown = ALL_GROUPS.filter((g) => g !== 'title');
    const kept = narrowGenerationFailure(notice([...ALL_GROUPS]), stillDown)!;
    expect(kept.groups).toEqual(stillDown);
    expect(kept).not.toBeNull();
  });

  it('a legacy notice with no scope is NEVER narrowed and never cleared', () => {
    const legacy: GenerationFailure = { class: 'APIError', summary: 'Generation failed: x.' };
    expect(narrowGenerationFailure(legacy, [])).toBe(legacy);
    expect(narrowGenerationFailure(legacy, ['bullets'])).toBe(legacy);
  });

  it('a regeneration that ALSO failed upstream merges its identity and its scope', () => {
    const merged = mergeGenerationFailure(notice(['qa']), {
      class: 'APIConnectionTimeoutError',
      summary: 'Generation failed: the upstream model API could not be reached.',
      groups: ['bullets'],
      groupsTotal: ALL_GROUPS.length,
    })!;
    expect(merged.class).toBe('APIConnectionTimeoutError');
    expect([...merged.groups!].sort()).toEqual(['bullets', 'qa']);
  });

  it('merging with an unscoped side yields UNKNOWN scope rather than a made-up one', () => {
    const merged = mergeGenerationFailure(
      { class: 'APIError', summary: 'old' },
      { class: 'APIError', summary: 'new', groups: ['qa'], groupsTotal: 9 },
    )!;
    expect(merged).not.toHaveProperty('groups');
    expect(merged.summary).toBe('new');
  });

  it('nothing carried and nothing incoming is still nothing', () => {
    expect(mergeGenerationFailure(null, null)).toBeNull();
    expect(narrowGenerationFailure(null, ['bullets'])).toBeNull();
  });
});
