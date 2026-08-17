import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { APIError } from '@anthropic-ai/sdk';
import { GenerationFailureBanner, ResultsPanel, type ResultsModel } from '@/app/ResultsPanel';
import { buildAudit } from '@/lib/audit/buildAudit';
import { describeError, generationFailurePayload } from '@/lib/engine/llm';
import { toMarkdown } from '@/lib/export/markdown';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { optimize } from '@/lib/engine/optimize';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { GenerationFailure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * U1 — THE OPERATOR IS TOLD, IN THE UI, THAT GENERATION NEVER RAN.
 *
 * THE OUTAGE. The Anthropic credit balance hit zero. Every generation group
 * failed with a 400 `invalid_request_error` ("Your credit balance is too low"),
 * every group degraded, and the gate — doing exactly its job on the empty
 * surfaces that resulted — reported eleven blocking failures: A4, A9, C1, C2,
 * C3, C15, C20, C23, C28, C29 and GEN. `e885f23` had already made that
 * diagnosable in the LOG and had already put `generationFailure` on the
 * RESPONSE. Nothing rendered it. The operator's screen showed eleven compliance
 * failures and no cause, and the only conclusions reachable from it were "the
 * tool is broken" and "my listing is catastrophic".
 *
 * The two directions that matter, and why BOTH are load-bearing:
 *
 *  PRESENT — a run carrying `generationFailure` renders the banner, naming the
 *  status and the caveat, AND still renders every gate failure. Suppressing
 *  them would be mutating what the checker reported.
 *
 *  ABSENT — a run with REAL gate failures and no upstream error renders NO
 *  banner. This is the direction that protects the feature's value: a false
 *  "the upstream API failed" notice would teach operators that gate failures
 *  are noise, and the next real compliance failure would be waved through.
 *
 * The strongest form of "nothing is suppressed" is available here and is used:
 * the two panels are rendered from the SAME audit, and the markup is asserted
 * to differ by the banner and by NOTHING ELSE.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The live 400: an exhausted credit balance, built by the SDK's own factory. */
const CREDIT_BALANCE_400 = APIError.generate(
  400,
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    },
  },
  undefined,
  new Headers({ 'request-id': 'req_outage_400' }),
);

const outageFailure = (): GenerationFailure =>
  generationFailurePayload(describeError(CREDIT_BALANCE_400))!;

/**
 * A run with REAL gate failures and no upstream error — the listing the golden
 * mock produces, with an over-length backend field. Nothing about it is
 * upstream: the model answered, and the copy fails a deterministic check.
 */
let failingRun: { optimized: OptimizedListing; audit: ReturnType<typeof buildAudit> };

async function realFailingRun(): Promise<typeof failingRun> {
  if (failingRun) return failingRun;
  const clean = await optimize(snapshot, pack, mockLlm);
  const optimized: OptimizedListing = { ...clean, backendSearchTerms: 'ä'.repeat(200) };
  failingRun = { optimized, audit: buildAudit(snapshot, optimized, pack, ctx) };
  return failingRun;
}

const model = (over: Partial<ResultsModel>, base: typeof failingRun): ResultsModel => ({
  optimized: base.optimized,
  audit: base.audit,
  detection: { packId: 'supplements', subcategories: ctx.subcategories },
  runId: 'run-u1-test',
  ...over,
});

const render = (result: ResultsModel): string =>
  renderToStaticMarkup(
    createElement(ResultsPanel, { result, headers: {}, onUpdated: () => {} }),
  );

const renderBanner = (failure?: GenerationFailure | null): string =>
  renderToStaticMarkup(createElement(GenerationFailureBanner, { failure }));

// ===========================================================================
// 0 — the fixture really is a failing run (else everything below proves nothing)
// ===========================================================================

describe('U1 fixture', () => {
  it('the failing run has real, blocking gate failures and is unverified', async () => {
    const run = await realFailingRun();
    expect(run.audit.verified).toBe(false);
    expect(run.audit.gateResult.failures.length).toBeGreaterThan(0);
  });

  it('the outage payload is exactly what the route would send for the live 400', () => {
    expect(outageFailure()).toEqual({
      class: 'APIError',
      status: 400,
      apiType: 'invalid_request_error',
      requestId: 'req_outage_400',
      summary:
        'Generation failed: the upstream model API returned an error (status 400, invalid_request_error).',
    });
    // The API's own prose never travels to a browser — only status and type.
    expect(JSON.stringify(outageFailure())).not.toContain('credit balance');
  });
});

// ===========================================================================
// 1 — PRESENT: the banner is rendered, and it names the cause
// ===========================================================================

describe('U1 present — a run carrying generationFailure renders the banner', () => {
  it('renders the banner with the summary, the status and the API error type', async () => {
    const html = render(model({ generationFailure: outageFailure() }, await realFailingRun()));
    expect(html).toContain('generation-failure-banner');
    expect(html).toContain('Generation failed upstream');
    expect(html).toContain('the upstream model API returned an error (status 400');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('invalid_request_error');
    expect(html).toContain('req_outage_400');
  });

  it('states the caveat: the gate output below is NOT a judgement of the listing', async () => {
    const html = render(model({ generationFailure: outageFailure() }, await realFailingRun()));
    expect(html).toContain('NOT a judgement of your listing');
  });

  it('the banner comes BEFORE the verdict and before the tabs', async () => {
    const html = render(model({ generationFailure: outageFailure() }, await realFailingRun()));
    const banner = html.indexOf('generation-failure-banner');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(html.indexOf('Not verified'));
    expect(banner).toBeLessThan(html.indexOf('Audit ('));
  });

  it('STILL renders the gate failures — nothing is suppressed or filtered', async () => {
    const run = await realFailingRun();
    const html = render(model({ generationFailure: outageFailure() }, run));
    expect(html).toContain(`${run.audit.gateResult.failures.length} blocking failure(s)`);
    expect(html).toContain('Not verified');
    // and the fields the gate flagged are still marked as flagged
    expect(html).toContain('see the Audit tab');
  });

  /**
   * The decisive assertion. Same audit, same listing, banner the only input
   * that differs: if the panel suppressed, filtered, collapsed or reworded ONE
   * gate failure in the presence of an upstream error, the remainders would not
   * be equal.
   */
  it('the ONLY difference from the same run without the banner is the banner', async () => {
    const run = await realFailingRun();
    const withBanner = render(model({ generationFailure: outageFailure() }, run));
    const without = render(model({ generationFailure: null }, run));
    const bannerHtml = renderBanner(outageFailure());
    expect(withBanner).toContain(bannerHtml);
    expect(withBanner.replace(bannerHtml, '')).toBe(without);
  });
});

// ===========================================================================
// 2 — ABSENT: a real compliance failure must never wear the upstream excuse
// ===========================================================================

describe('U1 absent — a normal failing run renders NO banner', () => {
  it('a run with real gate failures and no upstream error shows no banner at all', async () => {
    const run = await realFailingRun();
    for (const value of [undefined, null] as const) {
      const html = render(model({ generationFailure: value }, run));
      expect(html).not.toContain('generation-failure-banner');
      expect(html).not.toContain('Generation failed upstream');
      // ...and the failures it DOES have are reported exactly as before
      expect(html).toContain(`${run.audit.gateResult.failures.length} blocking failure(s)`);
    }
  });

  it('a VERIFIED run renders no banner either', async () => {
    const clean = await optimize(snapshot, pack, mockLlm);
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(audit.verified).toBe(true);
    const html = render({
      optimized: clean,
      audit,
      detection: { packId: 'supplements', subcategories: ctx.subcategories },
    });
    expect(html).not.toContain('generation-failure-banner');
  });

  it('the banner component itself renders nothing for a missing failure', () => {
    expect(renderBanner(undefined)).toBe('');
    expect(renderBanner(null)).toBe('');
    expect(renderBanner(outageFailure())).not.toBe('');
  });
});

// ===========================================================================
// 3 — the deliverables: a degraded run can never LOOK shippable
// ===========================================================================

describe('U1 — the export paths already refuse a degraded run (confirmed, not assumed)', () => {
  it('export-final is disabled and the Ship Sheet buttons carry the reason', async () => {
    const html = render(model({ generationFailure: outageFailure() }, await realFailingRun()));
    // `export final` is rendered `disabled` — React emits the bare attribute
    expect(html).toContain('Blocked: the verify gate is failing');
    expect(html).toMatch(/disabled=""[^>]*>⬇ export final|⬇ export final/);
  });

  it('the Markdown export leads with NOT VERIFIED / do not publish', async () => {
    const run = await realFailingRun();
    const md = toMarkdown(run.optimized, run.audit);
    expect(md).toContain('NOT VERIFIED');
    expect(md).toContain('do not publish');
  });

  it('the Ship Sheet omits every copy button and the clipboard script when unverified', async () => {
    const run = await realFailingRun();
    const sheet = buildShipSheet({
      optimized: run.optimized,
      audit: run.audit,
      asin: 'B0TESTASIN',
      pack,
    });
    expect(sheet).not.toContain('class=cp');
    expect(sheet).not.toContain('<script>');
    expect(sheet).not.toContain('navigator.clipboard');
  });
});

// ===========================================================================
// 4 — THE WIRE. The render tests above cannot see a field the page never sets.
// ===========================================================================

describe('U1 — every place a run is rendered carries the failure into the model', () => {
  const src = (file: string): string => readFileSync(join(process.cwd(), 'app', file), 'utf8');

  it('the optimize page reads generationFailure off the response and puts it on the model', () => {
    const page = src('page.tsx');
    expect(page).toContain('generationFailure?: ResultsModel[\'generationFailure\']');
    expect(page).toContain('generationFailure: r.generationFailure ?? null');
  });

  /**
   * UPDATED BY V1. This used to pin the literal
   * `body.generationFailure ?? result.generationFailure ?? null`, i.e. the
   * set-only rule. That rule kept a stale notice on screen after the ONLY
   * degraded group had been successfully regenerated. The property it was
   * really defending — a single-group regeneration cannot announce the
   * recovery of the other eight — is now a consequence of the SCOPED rule, and
   * that is what is pinned instead. The behaviour itself is asserted, not just
   * grepped, in `tests/generationFailure.scope.v1.test.ts` §4.
   */
  it('a regeneration narrows the carried notice by what is STILL degraded, and merges a new one', () => {
    const panel = src('ResultsPanel.tsx');
    expect(panel).toContain('mergeGenerationFailure(');
    expect(panel).toContain(
      'narrowGenerationFailure(result.generationFailure, body.optimized.degradedGroups)',
    );
  });

  it('both routes build the payload with the ONE shared builder, cross-checked against degradedGroups', () => {
    const routes = ['api/optimize/route.ts', 'api/regenerate/route.ts'].map(src);
    for (const r of routes) expect(r).toContain('recordedGenerationFailure(');
    // V1 — the cross-check is the fix. `firstFailure()` alone latched a failure
    // the group had RECOVERED from, so a healthy run could carry the notice.
    expect(src('api/optimize/route.ts')).toContain('optimized.degradedGroups');
    expect(src('api/regenerate/route.ts')).toContain('merged.degradedGroups');
    for (const r of routes) expect(r).not.toContain('generationFailurePayload(generation.firstFailure())');
  });
});
