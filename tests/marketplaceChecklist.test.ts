import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Audit, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS7 — the MARKETPLACE / OPS CHECKLIST.
 *
 * GUIDANCE TIER, and the tests say so in both directions: every row must reach
 * the sheet, and NOTHING here may be able to change a gate verdict. A checklist
 * that could fail a run would be an app pretending to have filed a certificate
 * it cannot see.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let listing: OptimizedListing;
let audit: Audit;
let html: string;
beforeAll(async () => {
  listing = await optimize(snapshot, pack, mockLlm);
  audit = buildAudit(snapshot, listing, pack, ctx);
  html = buildShipSheet({ optimized: listing, audit, pack });
});

const checklist = () => pack.rules.postPublish!.marketplaceChecklist!;

describe('WS7 — the checklist is real pack data, not two placeholder lines', () => {
  it('the old opsPlaceholders reminders are gone', () => {
    expect(pack.rules.operatorChecklist!.opsPlaceholders).toEqual([]);
    expect(html).not.toContain('(Extended in WS7.)');
  });

  it('has a row for every topic the playbook makes an operator responsible for', () => {
    const text = JSON.stringify(checklist()).toLowerCase();
    // Same-day TIC/cGMP filing, dated, and framed as listing survival.
    expect(text).toContain('cgmp');
    expect(text).toContain('coa');
    expect(text).toContain('testing/inspection/certification');
    expect(text).toContain('january 2026');
    expect(text).toContain('survival');
    // Rating floor + rating defence.
    expect(text).toContain('4.0');
    expect(text).toContain('rating defence');
    // External traffic staging + the banned tactics.
    expect(text).toContain('week 7');
    expect(text).toContain('search-find-buy');
    expect(text).toContain('super url');
    expect(text).toContain('rebate');
    // Vine.
    expect(text).toContain('vine');
    expect(text).toContain('30 reviews');
    // Propagation.
    expect(text).toContain('48 hours');
    expect(text).toContain('re-submit');
    // Monthly re-verification of dated rules.
    expect(text).toContain('monthly');
  });

  it('every row is structurally complete (id, lane, title, detail)', () => {
    const ids = new Set<string>();
    for (const row of checklist()) {
      expect(row.id.trim()).not.toBe('');
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
      expect(row.lane.trim()).not.toBe('');
      expect(row.title.trim().length).toBeGreaterThan(20);
      expect(row.detail.trim().length).toBeGreaterThan(80);
    }
    expect(ids.size).toBeGreaterThanOrEqual(6);
  });

  it('the rows whose underlying rule MOVES are marked volatile', () => {
    const volatile = checklist().filter((r) => r.volatile);
    expect(volatile.length).toBeGreaterThanOrEqual(2);
    // The provider list and the "re-verify dated rules" row must both be marked:
    // a cached copy of either is the specific failure the playbook records.
    expect(volatile.some((r) => r.detail.toLowerCase().includes('provider'))).toBe(true);
    expect(volatile.some((r) => r.title.toLowerCase().includes('re-verify'))).toBe(true);
  });
});

describe('WS7 — the sheet renders it, and it is not a hard-coded block', () => {
  it('every row reaches the sheet, with its lane and its detail', () => {
    for (const row of checklist()) {
      expect(html).toContain(`<code>${row.id}</code>`);
      expect(html).toContain(row.title.slice(0, 40).replace(/&/g, '&amp;'));
      expect(html).toContain(row.detail.slice(0, 60).replace(/&/g, '&amp;'));
    }
  });

  it('the volatility and date markers are rendered where they exist', () => {
    const dated = checklist().find((r) => r.dated)!;
    expect(html).toContain(dated.dated!);
    expect(html).toContain('re-verify live');
  });

  it('states plainly that these are account-side and unchecked', () => {
    expect(html).toContain('This app surfaces it; it cannot do it, and nothing here was checked.');
    expect(html).toContain(pack.rules.postPublish!.marketplaceChecklistNote!.slice(0, 40));
  });

  it('a pack with no checklist renders no checklist (the sheet holds no procedure of its own)', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete bare.rules.postPublish!.marketplaceChecklist;
    delete bare.rules.postPublish!.marketplaceChecklistNote;
    const bareHtml = buildShipSheet({ optimized: listing, audit, pack: bare });
    for (const row of checklist()) {
      expect(bareHtml).not.toContain(`<code>${row.id}</code>`);
    }
    // ...and the P15 timing advisory, which shares the section, is untouched.
    expect(bareHtml).toContain('15 · After you publish');
  });

  it('the rendered rows track the PACK — edit the data, the sheet changes', () => {
    const edited = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    edited.rules.postPublish!.marketplaceChecklist = [
      { id: 'MCX', lane: 'survival', title: 'A different action entirely for this pack', detail: 'A different justification, long enough to be a real row rather than a label on a topic.' },
    ];
    const editedHtml = buildShipSheet({ optimized: listing, audit, pack: edited });
    expect(editedHtml).toContain('<code>MCX</code>');
    expect(editedHtml).not.toContain('<code>MC1</code>');
  });
});

describe('WS7 — guidance tier: the checklist can never change a verdict', () => {
  it('emptying the checklist leaves the gate green (it disarms no check)', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    bare.rules.postPublish!.marketplaceChecklist = [];
    expect(runGate(listing, bare, ctx)).toEqual({ pass: true, failures: [] });
    expect(buildAudit(snapshot, listing, bare, ctx).verified).toBe(true);
  });

  it('removing postPublish entirely leaves the gate green', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete bare.rules.postPublish;
    expect(runGate(listing, bare, ctx).pass).toBe(true);
  });

  it('an UNVERIFIED sheet still withholds every copy button, checklist or not', () => {
    const failing: Audit = {
      ...audit,
      verified: false,
      gateResult: { pass: false, failures: [{ checkId: 'C6', field: 'bullets[0]', context: 'x', fix: 'y' }] },
    };
    const blocked = buildShipSheet({ optimized: listing, audit: failing, pack });
    expect(blocked).toContain('NOT VERIFIED');
    expect(blocked).not.toContain('class=cp');
    // The checklist is still shown: it is what the operator needs whether or
    // not this particular run is pasteable.
    expect(blocked).toContain('<code>MC1</code>');
  });
});
