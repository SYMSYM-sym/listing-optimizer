import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { runPipeline } from '@/lib/pipeline/run';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * D5 — the RUN BUDGET.
 *
 * The function is killed at `maxDuration` (300s) and a killed function answers
 * 502, which loses the entire run: every generated surface AND every gate
 * finding. A repair round that cannot finish inside the remaining time is
 * therefore worse than no round at all, because it converts a reportable
 * `verified:false` into nothing at all.
 *
 * The loop now projects the next round from the longest one it has MEASURED
 * and stops early when it will not fit. Asserted in both directions: with no
 * deadline the loop still spends its whole iteration budget, and with a
 * deadline that cannot fit another round it stops and still returns a complete,
 * honest, unverified report.
 */
const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** Answers every group from the golden mock, with a title the gate must reject. */
const neverConverges: LlmClient = async (req) => {
  const text = await mockLlm(req);
  if (req.groupName !== 'title') return text;
  const payload = JSON.parse(text) as { title: string };
  return JSON.stringify({ ...payload, title: `${payload.title} ${'x'.repeat(pack.rules.titleMaxLegacy)}` });
};

describe('D5 — the repair loop stops before the platform kills the function', () => {
  it('with no deadline it still spends its whole iteration budget', async () => {
    const result = await runPipeline(snapshot, neverConverges, 2);
    expect(result.iterations).toBe(2);
    expect(result.audit.verified).toBe(false);
  });

  it('a deadline that cannot fit another round stops the loop and keeps the report', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = await runPipeline(snapshot, neverConverges, 2, { deadline: Date.now() });
    const lines = spy.mock.calls.map(([l]) => String(l));
    spy.mockRestore();

    expect(result.iterations).toBe(0);
    // the run still CAME BACK, with its findings — that is the whole point
    expect(result.audit.verified).toBe(false);
    expect(result.audit.gateResult.failures.length).toBeGreaterThan(0);
    expect(result.optimized.bullets).toHaveLength(5);
    expect(lines.some((l) => l.includes('repair.deadline_stop'))).toBe(true);
  });

  it('a deadline far in the future changes nothing', async () => {
    const result = await runPipeline(snapshot, neverConverges, 2, {
      deadline: Date.now() + 10 * 60 * 1000,
    });
    expect(result.iterations).toBe(2);
  });

  it('a healthy run is unaffected by the deadline it never approaches', async () => {
    const result = await runPipeline(snapshot, mockLlm, 3, { deadline: Date.now() + 10 * 60 * 1000 });
    expect(result.audit.verified).toBe(true);
    expect(result.iterations).toBe(0);
  });
});
