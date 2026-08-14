import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { buildFacts } from '@/lib/engine/facts';
import { optimize } from '@/lib/engine/optimize';
import { buildSystemPrompt } from '@/lib/engine/prompts';
import type { GateContext } from '@/lib/gate/checks';
import { c12FactConsistency } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { normalizePanelFacts, panelAttributes, withPanelFacts } from '@/lib/knowledge/panelFacts';
import { runPipeline } from '@/lib/pipeline/run';
import type { OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS5.5 / AM-5 #4 — THE OPERATOR PANEL CONFIRMATION.
 *
 * The plan's answer to "facts fragility" is not a better scraper: it is the
 * operator reading the physical label and confirming it, after which those
 * values are PRODUCT TRUTH for the run. Two properties carry the whole feature
 * and both are asserted here rather than assumed:
 *
 *  PRESENT — the confirmed value OUTRANKS the scraped one everywhere it
 *  matters: in the canonical facts block, in the system prompt, and in the
 *  fact-anchored gate check (C12) that holds every surface to it. A listing
 *  that states the SUPERSEDED figure now fails; one that states the CONFIRMED
 *  figure passes. Both directions, on the real golden listing.
 *
 *  ABSENT — byte-identical. Not "equivalent", not "close": the same strings and
 *  the same objects, because a per-run input that quietly changes the default
 *  run is a per-run input nobody can reason about.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The scraped page says 50 Billion CFU / 60 Count. The label says otherwise. */
const SUPERSEDED_PANEL = { maximum_dosage: '75 Billion CFU', unit_count: '90 Count' };
/** A panel that CONFIRMS what the page already said (the lawful direction). */
const AGREEING_PANEL = { maximum_dosage: '50 Billion CFU', unit_count: '60 Count' };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

// ===========================================================================
// 0 — ABSENT MEANS UNCHANGED (the promise everything else rests on)
// ===========================================================================

describe('WS5.5 — with no panel confirmed, behaviour is byte-identical', () => {
  it('the facts producer returns the same facts, from the same attribute object', () => {
    expect(buildFacts(snapshot, pack, undefined)).toEqual(buildFacts(snapshot, pack));
    // by REFERENCE: no defensive copy sneaks in on the default path
    expect(panelAttributes(snapshot.attributes)).toBe(snapshot.attributes);
    expect(withPanelFacts(snapshot)).toBe(snapshot);
  });

  it('the system prompt is byte-for-byte the prompt that existed before', () => {
    const facts = buildFacts(snapshot, pack);
    const before = buildSystemPrompt(pack, facts, ['probiotic']);
    expect(buildSystemPrompt(pack, facts, ['probiotic'], undefined)).toBe(before);
    expect(buildSystemPrompt(pack, facts, ['probiotic'], {})).toBe(before);
    expect(before).not.toContain(pack.rules.operatorPanel!.promptHeadline);
  });

  it('the generated listing and the audit are byte-identical', async () => {
    const withUndefined = await optimize(snapshot, pack, mockLlm, { panelFacts: undefined });
    expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(clean));
    const base = buildAudit(snapshot, clean, pack, ctx);
    expect(JSON.stringify(buildAudit(snapshot, clean, pack, ctx, {}))).toBe(JSON.stringify(base));
    expect(base.verified).toBe(true);
  });

  it('an unusable request field is treated as ABSENT, never as an empty panel', () => {
    for (const junk of [undefined, null, 'x', 42, [], {}, { '': 'v' }, { k: '' }, { k: 5 }]) {
      expect(normalizePanelFacts(junk), JSON.stringify(junk)).toBeUndefined();
    }
  });

  it('caps a runaway panel instead of accepting a corpus', () => {
    const huge = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(normalizePanelFacts(huge)!).length).toBe(40);
    expect(normalizePanelFacts({ k: 'x'.repeat(500) })).toBeUndefined();
    expect(normalizePanelFacts({ ['k'.repeat(200)]: 'v' })).toBeUndefined();
  });
});

// ===========================================================================
// 1 — PRESENT: the confirmed value becomes the canonical fact
// ===========================================================================

describe('WS5.5 — a confirmed panel is PRODUCT TRUTH for the run', () => {
  it('overlays the scraped attributes and re-derives every dependent fact', () => {
    const scraped = buildFacts(snapshot, pack);
    expect(scraped.potency).toBe('50 Billion CFU');
    expect(scraped.unitCount).toBe(60);

    const confirmed = buildFacts(snapshot, pack, SUPERSEDED_PANEL);
    expect(confirmed.potency).toBe('75 Billion CFU');
    expect(confirmed.unitCount).toBe(90);
    // derived, not merely copied: the day supply follows the confirmed count
    expect(confirmed.daySupply).toBe(90);
    // and the facts the operator did NOT confirm are untouched
    expect(confirmed.servingSize).toBe(scraped.servingSize);
    expect(confirmed.weight).toBe(scraped.weight);
  });

  it('never mutates the caller’s snapshot or the pack', () => {
    const before = JSON.stringify(snapshot);
    const packBefore = JSON.stringify(loadPack('supplements'));
    buildFacts(snapshot, pack, SUPERSEDED_PANEL);
    withPanelFacts(snapshot, SUPERSEDED_PANEL);
    expect(JSON.stringify(snapshot)).toBe(before);
    // NOT PERSISTED: the next run starts from the shipped pack again
    expect(JSON.stringify(loadPack('supplements'))).toBe(packBefore);
    expect(JSON.stringify(loadPack('supplements'))).not.toContain('75 Billion CFU');
  });

  it('is announced to the generator as authoritative, from PACK wording', () => {
    const facts = buildFacts(snapshot, pack, SUPERSEDED_PANEL);
    const prompt = buildSystemPrompt(pack, facts, ['probiotic'], SUPERSEDED_PANEL);
    expect(prompt).toContain(pack.rules.operatorPanel!.promptHeadline);
    expect(prompt).toContain('75 Billion CFU');
    expect(prompt).toContain('90 Count');
    // the facts block the model is given already carries the confirmed number
    expect(prompt).toContain('"potency": "75 Billion CFU"');
  });
});

// ===========================================================================
// 2 — C12 uses the CONFIRMED facts in preference to the scraped ones
// ===========================================================================

describe('WS5.5 — the fact-anchored check measures against the panel', () => {
  it('VIOLATION: copy stating the superseded figure now FAILS C12', () => {
    // The golden copy says 50 Billion CFU across every surface. The operator
    // has confirmed the label says 75.
    const confirmed = { ...clean, facts: buildFacts(snapshot, pack, SUPERSEDED_PANEL) };
    const failures = c12FactConsistency(confirmed, pack);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.checkId === 'C12')).toBe(true);
  });

  it('LAWFUL: the same copy PASSES when the panel confirms what it says', () => {
    const agreeing = { ...clean, facts: buildFacts(snapshot, pack, AGREEING_PANEL) };
    expect(c12FactConsistency(agreeing, pack)).toEqual([]);
  });

  it('the AUDIT re-derives facts from the panel — a client-carried facts block is not trusted', () => {
    // `clean.facts` says 50; the panel says 75. buildAudit must gate against
    // the PANEL, so `verified` drops even though the submitted listing carries
    // a facts block that agrees with its own copy.
    const audited = buildAudit(snapshot, clean, pack, ctx, { panelFacts: SUPERSEDED_PANEL });
    expect(audited.verified).toBe(false);
    expect(audited.gateResult.failures.some((f) => f.checkId === 'C12')).toBe(true);

    const agreeing = buildAudit(snapshot, clean, pack, ctx, { panelFacts: AGREEING_PANEL });
    expect(agreeing.verified).toBe(true);
    expect(agreeing.gateResult.failures).toEqual([]);
  });
});

// ===========================================================================
// 3 — END TO END through the pipeline the routes actually run
// ===========================================================================

describe('WS5.5 — end to end', () => {
  it('a run whose copy contradicts the confirmed panel is NOT verified', async () => {
    const r = await runPipeline(snapshot, mockLlm, 0, { panelFacts: SUPERSEDED_PANEL });
    expect(r.optimized.facts.potency).toBe('75 Billion CFU');
    expect(r.audit.verified).toBe(false);
    expect(r.optimized.state).toBe('draft');
    expect(r.audit.gateResult.failures.some((f) => f.checkId === 'C12')).toBe(true);
  });

  it('a run whose copy agrees with the confirmed panel IS verified', async () => {
    const r = await runPipeline(snapshot, mockLlm, 0, { panelFacts: AGREEING_PANEL });
    expect(r.audit.verified).toBe(true);
    expect(r.optimized.state).toBe('verified');
  });

  it('supplying NO panel leaves the pipeline byte-identical', async () => {
    const base = await runPipeline(snapshot, mockLlm, 0);
    const same = await runPipeline(snapshot, mockLlm, 0, { panelFacts: undefined });
    expect(JSON.stringify(same.optimized)).toBe(JSON.stringify(base.optimized));
    expect(JSON.stringify(same.audit)).toBe(JSON.stringify(base.audit));
    expect(base.audit.verified).toBe(true);
  });
});
