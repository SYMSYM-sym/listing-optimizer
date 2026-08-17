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
import { ALL_GROUPS } from '@/lib/engine/optimize';
import { toMarkdown } from '@/lib/export/markdown';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import {
  generationFailureCaveat,
  generationFailureContext,
  generationFailureIsPartial,
  generationFailureScopeLine,
  GENERATION_FAILURE_CAVEAT,
  GENERATION_FAILURE_CONTEXT,
} from '@/lib/shared/generationFailure';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { Audit, GenerationFailure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * W1 — THE PARTIAL CAVEAT MUST BE TRUE, NOT MERELY NARROW.
 *
 * V1 stopped the notice claiming a whole run was lost when only part of it was.
 * The sentence it left behind still made a UNIVERSAL claim in the other
 * direction:
 *
 *   "Every other failure below IS: those surfaces generated normally and the
 *    gate graded real copy."
 *
 * The notice's scope is `openFailures ∩ degradedGroups` — the groups lost to an
 * UPSTREAM failure, and deliberately ONLY those, because captioning a
 * schema-degraded group "the upstream model API could not be reached" would be
 * a false statement of cause. So a run with one transport-degraded group and
 * one SCHEMA-degraded group has a group that is (a) outside the scope and
 * (b) not generated: the gate graded an empty artifact there. The sentence said
 * that group's failures ARE a judgement of the operator's listing. They are
 * not — nobody wrote that copy.
 *
 * The direction is the safe one (over-strict; `verified` is untouched either
 * way) and that is exactly why it survived three rounds. The notice's entire
 * job is to describe the run that happened, and a sentence that is literally
 * false in a reachable case fails that job whichever way it errs.
 *
 * THE FIX PINNED HERE: the caveat names THREE states — lost upstream, reported
 * missing below, generated — and each is checkable in the failure list printed
 * directly under it. The whole-run wording is untouched, byte for byte.
 *
 * (a) transport-only partial: names the transport surfaces, positive clause true
 * (b) mixed transport + schema: no claim that the schema group generated
 * (c) whole-run: byte-identical to the wording shipped before this change
 * (d) no degrade: no notice at all
 * (e) legacy stored notice with no scope: whole-run wording, unchanged
 * (f) `verified` and every gate verdict byte-identical across all of it
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };
const neverSleeps = async () => {};
const noJitter = () => 0;

const CREDIT_BALANCE_400 = APIError.generate(
  400,
  { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic 400' } },
  undefined,
  new Headers({ 'request-id': 'req_w1_400' }),
);

/** THE WORDING AS SHIPPED, quoted rather than imported, so a constant that
 *  changes cannot quietly re-bless itself through this file. */
const WHOLE_RUN_CAVEAT = 'The failures shown below are NOT a judgement of your listing.';
const WHOLE_RUN_CONTEXT =
  'The copy for this run was never written, so the gate graded empty and partial fields. ' +
  'Nothing below is hidden or reworded: the checker output is never edited. ' +
  'Re-run once the upstream API is healthy.';

/** The clause the old sentence made unconditionally. It must never reappear. */
const OLD_UNIVERSAL_CLAUSE = 'Every other failure below IS';

/**
 * TRANSPORT degrade: the call itself never returns, on every attempt, so the
 * group is lost upstream and lands in the notice's scope.
 */
const transportDown = (groups: readonly string[]): LlmClient => async (req) => {
  if (groups.includes(req.groupName ?? '')) throw CREDIT_BALANCE_400;
  return mockLlm(req);
};

/**
 * SCHEMA degrade: the call SUCCEEDS and the model returns well-formed JSON of
 * the wrong shape, so `ZodError` → reason `'schema'` → the reparse retry runs,
 * fails the same way, and the group degrades. Nothing upstream failed, so
 * `recordUpstreamFailures` never sees it and the notice cannot cover it.
 */
const schemaBroken = (groups: readonly string[]): LlmClient => async (req) => {
  if (groups.includes(req.groupName ?? '')) return '{"not_the_schema":true}';
  return mockLlm(req);
};

const both = (transport: readonly string[], schema: readonly string[]): LlmClient => async (req) => {
  if (transport.includes(req.groupName ?? '')) throw CREDIT_BALANCE_400;
  if (schema.includes(req.groupName ?? '')) return '{"not_the_schema":true}';
  return mockLlm(req);
};

const renderBanner = (failure?: GenerationFailure | null): string =>
  renderToStaticMarkup(createElement(GenerationFailureBanner, { failure }));

/** Every verdict the gate reached, as one string. Nothing about the notice. */
const verdict = (audit: Audit): string =>
  JSON.stringify({
    verified: audit.verified,
    failures: audit.gateResult.failures
      .map((f) => `${f.checkId}|${f.field}`)
      .sort(),
  });

async function run(llm: LlmClient) {
  const gen = recordUpstreamFailures(withTransientRetry(llm, { random: noJitter, sleep: neverSleeps }));
  const result = await runPipeline(snapshot, gen.llm, 0);
  const failure = recordedGenerationFailure(
    gen,
    result.optimized.degradedGroups,
    ALL_GROUPS.length,
  );
  return { ...result, failure, gen };
}

const genFailedGroups = (audit: Audit): string[] =>
  audit.gateResult.failures
    .filter((f) => f.checkId === 'GEN')
    .map((f) => f.field.replace(/^generation\./, ''))
    .sort();

// ===========================================================================
// (a) TRANSPORT-ONLY PARTIAL — the case the old sentence was true for, kept.
// ===========================================================================

describe('W1 (a) — transport-only partial degrade: the positive clause is TRUE', () => {
  it('names the transport surfaces, and every group it does not name really generated', async () => {
    const { optimized, audit, failure } = await run(transportDown(['bullets', 'qa']));
    expect(failure).not.toBeNull();
    expect([...failure!.groups!].sort()).toEqual(['bullets', 'qa']);
    expect(generationFailureIsPartial(failure!)).toBe(true);

    // THE PREMISE OF THE POSITIVE CLAUSE, checked against the run rather than
    // assumed: the degraded set and the notice's scope are the same set, so
    // there is no third kind of group on this run at all.
    expect([...(optimized.degradedGroups ?? [])].sort()).toEqual(['bullets', 'qa']);
    expect(genFailedGroups(audit)).toEqual(['bullets', 'qa']);

    const caveat = generationFailureCaveat(failure!);
    expect(caveat).toContain('come from bullets, qa are NOT a judgement of your listing');
    expect(caveat).toContain(
      'Every remaining failure IS: that copy generated normally and the gate graded it.',
    );
    expect(caveat).not.toContain(OLD_UNIVERSAL_CLAUSE);
    // Every group NOT named by the caveat produced validated copy this run, so
    // the "remaining" clause covers only surfaces the gate really did grade.
    for (const g of ALL_GROUPS) {
      if (failure!.groups!.includes(g)) continue;
      expect(optimized.degradedGroups ?? []).not.toContain(g);
      expect(genFailedGroups(audit)).not.toContain(g);
    }
  });
});

// ===========================================================================
// (b) MIXED TRANSPORT + SCHEMA — the case that made the old sentence false.
// ===========================================================================

describe('W1 (b) — mixed transport + schema degrade: no claim the schema group generated', () => {
  it('the schema-degraded group is degraded, is OUTSIDE the notice, and is not excused as generated', async () => {
    const { optimized, audit, failure } = await run(both(['bullets'], ['images']));

    // The run really is in the mixed state: two groups down, two GEN failures,
    // one notice covering exactly one of them.
    expect([...(optimized.degradedGroups ?? [])].sort()).toEqual(['bullets', 'images']);
    expect(genFailedGroups(audit)).toEqual(['bullets', 'images']);
    expect(failure!.groups).toEqual(['bullets']);
    expect(generationFailureIsPartial(failure!)).toBe(true);

    // THE EXACT RENDERED STRING. The old wording appended
    // "Every other failure below IS: those surfaces generated normally and the
    // gate graded real copy." — which said the `images` GEN failure, and C-checks
    // on the empty image set, ARE a judgement of the operator's listing.
    expect(generationFailureCaveat(failure!)).toBe(
      'The failures shown below that come from bullets are NOT a judgement of your listing. ' +
        'Neither are failures on any other group reported missing below. ' +
        'Every remaining failure IS: that copy generated normally and the gate graded it.',
    );
    // ...and the explanation beside it no longer says "The rest of the run
    // generated normally", which was the same over-claim one sentence away.
    expect(generationFailureContext(failure!)).toBe(
      'The copy for bullets was never written, so the gate graded empty and partial fields there. ' +
        'No other group was lost to an upstream failure. ' +
        'Nothing below is hidden or reworded: the checker output is never edited. ' +
        'Re-run once the upstream API is healthy.',
    );
    // The cause is still NOT claimed for the schema group: that would be the
    // opposite lie, and `recordedGenerationFailure` is what prevents it.
    expect(generationFailureCaveat(failure!)).not.toContain('images');
    expect(generationFailureScopeLine(failure!)).toBe(
      `1 of ${ALL_GROUPS.length} content groups could not be generated: bullets.`,
    );

    // All three media print the same sentence, out of the same module.
    const html = renderBanner(failure);
    expect(html).toContain('Neither are failures on any other group reported missing below.');
    expect(html).not.toContain(OLD_UNIVERSAL_CLAUSE);
    const md = toMarkdown(optimized, audit, failure);
    expect(md).toContain('Neither are failures on any other group reported missing below.');
    expect(md).not.toContain(OLD_UNIVERSAL_CLAUSE);
    // The schema group IS still reported missing right below the notice — the
    // property the caveat's second state points at is really there to check.
    expect(md).toContain("The 'images' group returned nothing this run could validate");
  });

  it('the same shape with the roles reversed — schema first, transport second', async () => {
    const { optimized, failure } = await run(both(['qa'], ['bullets']));
    expect([...(optimized.degradedGroups ?? [])].sort()).toEqual(['bullets', 'qa']);
    expect(failure!.groups).toEqual(['qa']);
    expect(generationFailureCaveat(failure!)).toBe(
      'The failures shown below that come from qa are NOT a judgement of your listing. ' +
        'Neither are failures on any other group reported missing below. ' +
        'Every remaining failure IS: that copy generated normally and the gate graded it.',
    );
  });

  it('a purely SCHEMA-degraded run raises no notice at all — no cause to claim', async () => {
    const { optimized, audit, failure } = await run(schemaBroken(['images']));
    expect(optimized.degradedGroups).toEqual(['images']);
    expect(audit.verified).toBe(false);
    expect(failure).toBeNull();
    expect(renderBanner(failure)).toBe('');
  });
});

// ===========================================================================
// (c) WHOLE RUN — byte-identical to the wording shipped before this change.
// ===========================================================================

describe('W1 (c) — the whole-run wording is untouched, byte for byte', () => {
  it('a permanent 400 on every group renders the two constants, character for character', async () => {
    const { optimized, audit, failure } = await run(transportDown([...ALL_GROUPS]));
    expect([...(optimized.degradedGroups ?? [])].sort()).toEqual([...ALL_GROUPS].sort());
    expect(generationFailureIsPartial(failure!)).toBe(false);

    expect(generationFailureCaveat(failure!)).toBe(WHOLE_RUN_CAVEAT);
    expect(generationFailureCaveat(failure!)).toBe(GENERATION_FAILURE_CAVEAT);
    expect(generationFailureContext(failure!)).toBe(WHOLE_RUN_CONTEXT);
    expect(generationFailureContext(failure!)).toBe(GENERATION_FAILURE_CONTEXT);
    expect(generationFailureScopeLine(failure!)).toBeNull();

    const html = renderBanner(failure);
    expect(html).toContain(WHOLE_RUN_CAVEAT);
    expect(html).toContain('The copy for this run was never written');
    expect(html).not.toContain('reported missing below');
    expect(toMarkdown(optimized, audit, failure)).toContain(WHOLE_RUN_CAVEAT);
  });
});

// ===========================================================================
// (d) NO DEGRADE — the other direction: nothing to caption, nothing rendered.
// ===========================================================================

describe('W1 (d) — a healthy run shows no notice at all', () => {
  it('no failure, no banner, no line in the record', async () => {
    const { optimized, audit, failure } = await run(mockLlm);
    expect('degradedGroups' in optimized).toBe(false);
    expect(audit.verified).toBe(true);
    expect(failure).toBeNull();
    expect(renderBanner(failure)).toBe('');
    const md = toMarkdown(optimized, audit, failure);
    expect(md).not.toContain('Generation failed upstream');
    expect(md).not.toContain('reported missing below');
    expect(md).toBe(toMarkdown(optimized, audit));
  });
});

// ===========================================================================
// (e) LEGACY — a stored notice with no scope renders what it always rendered.
// ===========================================================================

describe('W1 (e) — a legacy stored notice with no scope is unchanged', () => {
  it('whole-run wording, because there is no evidence in the row to narrow it with', () => {
    const legacy = generationFailurePayload({ error: 'APIError', status: 401, issuePaths: [] })!;
    expect(legacy).not.toHaveProperty('groups');
    expect(generationFailureIsPartial(legacy)).toBe(false);
    expect(generationFailureCaveat(legacy)).toBe(WHOLE_RUN_CAVEAT);
    expect(generationFailureContext(legacy)).toBe(WHOLE_RUN_CONTEXT);
    expect(generationFailureScopeLine(legacy)).toBeNull();
    const html = renderBanner(legacy);
    expect(html).toContain(WHOLE_RUN_CAVEAT);
    expect(html).toContain('The copy for this run was never written');
    expect(html).not.toContain('reported missing below');
  });
});

// ===========================================================================
// (f) THE VERDICT IS UNMOVED. Wording is presentation; `verified` is computed
//     only in `lib/audit/buildAudit.ts`, and nothing here can reach it.
// ===========================================================================

describe('W1 (f) — `verified` and every gate verdict are byte-identical', () => {
  const cases: [string, LlmClient][] = [
    ['healthy', mockLlm],
    ['transport-only partial', transportDown(['bullets', 'qa'])],
    ['mixed transport + schema', both(['bullets'], ['images'])],
    ['schema only', schemaBroken(['images'])],
    ['whole run', transportDown([...ALL_GROUPS])],
  ];

  it.each(cases)('%s: rendering the notice moves no verdict', async (_name, llm) => {
    const { optimized, audit, failure } = await run(llm);
    const before = verdict(audit);
    // Render every surface the wording reaches.
    if (failure) {
      generationFailureCaveat(failure);
      generationFailureContext(failure);
      generationFailureScopeLine(failure);
      renderBanner(failure);
    }
    toMarkdown(optimized, audit, failure);
    // Re-grade the SAME listing from scratch: the gate cannot have seen any of
    // the above, and says exactly what it said before.
    const regraded = buildAudit(snapshot, optimized as OptimizedListing, pack, ctx);
    expect(verdict(regraded)).toBe(before);
    expect(regraded.verified).toBe(audit.verified);
  });

  it('the healthy run is still VERIFIED with zero gate failures', async () => {
    const { audit } = await run(mockLlm);
    expect(audit.verified).toBe(true);
    expect(audit.gateResult.failures).toEqual([]);
  });

  it('every degraded shape is UNVERIFIED with or without a notice attached', async () => {
    const mixed = await run(both(['bullets'], ['images']));
    const schemaOnly = await run(schemaBroken(['images']));
    expect(mixed.audit.verified).toBe(false);
    expect(schemaOnly.audit.verified).toBe(false);
    // One of these carries a notice and the other does not; the verdict is
    // reached the same way either way.
    expect(mixed.failure).not.toBeNull();
    expect(schemaOnly.failure).toBeNull();
  });
});
