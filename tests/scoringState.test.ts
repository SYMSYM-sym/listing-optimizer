import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { proposedAsSnapshot } from '@/lib/audit/proposedSnapshot';
import { scoreAgainstPrinciples } from '@/lib/audit/scoreAgainstPrinciples';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { toMarkdown } from '@/lib/export/markdown';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Audit, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS6 — BEFORE/AFTER SCORING, PUBLISH STATE and the P15 TIMING ADVISORY.
 *
 * Both directions throughout: the "after" number must MOVE with the proposed
 * copy (a scorecard that is really the old one wearing a new label would pass
 * a presence assertion), and a principle that is unknowable must stay unknown
 * rather than being silently scored zero.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let listing: OptimizedListing;
let audit: Audit;
beforeAll(async () => {
  listing = await optimize(snapshot, pack, mockLlm);
  audit = buildAudit(snapshot, listing, pack, ctx);
});

const clone = (l: OptimizedListing): OptimizedListing => JSON.parse(JSON.stringify(l)) as OptimizedListing;

// ===========================================================================
// 1 — BEFORE / AFTER
// ===========================================================================

describe('WS6 — the PROPOSED listing is scored by the same scorer', () => {
  it('the audit carries BOTH scorecards, over the same principle set', () => {
    expect(audit.scorecard).toBeTruthy();
    expect(audit.scorecardProposed).toBeTruthy();
    expect(audit.scorecardProposed!.perPrinciple.map((p) => p.id)).toEqual(
      audit.scorecard.perPrinciple.map((p) => p.id),
    );
  });

  it('the two totals are genuinely different computations, not the same object', () => {
    expect(audit.scorecardProposed).not.toBe(audit.scorecard);
    // The optimized listing is better copy than the scraped one; if these were
    // the same computation the test below could never fail.
    expect(audit.scorecardProposed!.total).toBeGreaterThan(audit.scorecard.total);
  });

  it('the AFTER score MOVES when the proposed copy is degraded', () => {
    const worse = clone(listing);
    worse.bullets = worse.bullets.map(() => 'x'.repeat(30));
    worse.attributes = { brand_name: 'BrandX' };
    worse.aplusContent.modules = [];
    const degraded = buildAudit(snapshot, worse, pack, ctx);
    expect(degraded.scorecardProposed!.total).toBeLessThan(audit.scorecardProposed!.total);
    // ...and the BEFORE score is untouched by a change to the proposal.
    expect(degraded.scorecard.total).toBe(audit.scorecard.total);
  });

  it('the BEFORE score moves with the CURRENT listing and not with the proposal', () => {
    const poorer = { ...snapshot, title: 'thing', bullets: [], attributes: {} };
    const a = buildAudit(poorer, listing, pack, ctx);
    expect(a.scorecard.total).toBeLessThan(audit.scorecard.total);
    expect(a.scorecardProposed!.total).toBe(audit.scorecardProposed!.total);
  });

  it('projects the PUBLISHED title (title75), not the keyword-source title', () => {
    const view = proposedAsSnapshot(snapshot, listing);
    expect(view.title).toBe(listing.title75);
    expect(view.title).not.toBe(listing.title);
    expect(view.bullets).toEqual(listing.bullets);
    expect((view.raw as { aplusText: string }).aplusText).toContain(
      listing.aplusContent.modules[0]!.headline,
    );
  });
});

describe('WS6 — a principle that cannot be known stays UNKNOWN on that side', () => {
  it('P3 (backend) is unknown for the scraped listing and SCORED for the proposal', () => {
    const before = audit.scorecard.perPrinciple.find((p) => p.id === 'P3')!;
    const after = audit.scorecardProposed!.perPrinciple.find((p) => p.id === 'P3')!;
    expect(before.score).toBe('unknown');
    expect(after.score).not.toBe('unknown');
  });

  it('P12 (Q&A) likewise', () => {
    expect(audit.scorecard.perPrinciple.find((p) => p.id === 'P12')!.score).toBe('unknown');
    expect(audit.scorecardProposed!.perPrinciple.find((p) => p.id === 'P12')!.score).not.toBe('unknown');
  });

  it('with NO inputs the scorer behaves exactly as before (P3/P12 unknown)', () => {
    const plain = scoreAgainstPrinciples(snapshot, pack);
    expect(plain.perPrinciple.find((p) => p.id === 'P3')!.score).toBe('unknown');
    expect(plain.perPrinciple.find((p) => p.id === 'P12')!.score).toBe('unknown');
    expect(plain.total).toBe(audit.scorecard.total);
  });

  it('P3 grades the field it is given, in both directions', () => {
    const empty = scoreAgainstPrinciples(snapshot, pack, { backendSearchTerms: '' });
    expect(empty.perPrinciple.find((p) => p.id === 'P3')!.score).toBe('none');
    const wasteful = scoreAgainstPrinciples(snapshot, pack, {
      backendSearchTerms: snapshot.title,
    });
    expect(wasteful.perPrinciple.find((p) => p.id === 'P3')!.score).toBe('none');
    const good = scoreAgainstPrinciples(snapshot, pack, {
      backendSearchTerms: 'probiotico culturas vivas microbiome pastillas probioticas',
    });
    expect(good.perPrinciple.find((p) => p.id === 'P3')!.score).toBe('full');
  });

  it('P12 grades the layer it is given, in both directions', () => {
    const none = scoreAgainstPrinciples(snapshot, pack, { qa: [] });
    expect(none.perPrinciple.find((p) => p.id === 'P12')!.score).toBe('none');
    const full = scoreAgainstPrinciples(snapshot, pack, {
      qa: Array.from({ length: 15 }, () => ({ q: 'What is it?', a: 'A supplement.' })),
    });
    expect(full.perPrinciple.find((p) => p.id === 'P12')!.score).toBe('full');
  });

  it('an unknown principle is excluded from the denominator, never scored zero', () => {
    // P15/P16 are process rules: unscorable on both sides, and the total is
    // still renormalized to a number the weights alone could not produce.
    for (const card of [audit.scorecard, audit.scorecardProposed!]) {
      expect(card.perPrinciple.find((p) => p.id === 'P15')!.score).toBe('unknown');
      expect(card.total).toBeGreaterThan(0);
      expect(card.total).toBeLessThanOrEqual(100);
    }
  });
});

// ===========================================================================
// 2 — THE SHEET AND THE MARKDOWN SHOW BOTH
// ===========================================================================

describe('WS6 — the operator surfaces show BEFORE → AFTER, not one number', () => {
  it('the ship sheet prints both totals and a per-principle comparison', () => {
    const html = buildShipSheet({ optimized: listing, audit, pack });
    expect(html).toContain('before &rarr; after');
    expect(html).toContain(`current <b>${audit.scorecard.total}</b>`);
    expect(html).toContain(`proposed <b>${audit.scorecardProposed!.total}</b>`);
    expect(html).toContain('<td><code>P1</code></td>');
  });

  it('the sheet numbers MOVE with the audit (they are not hard-coded)', () => {
    const worse = clone(listing);
    worse.aplusContent.modules = [];
    worse.attributes = { brand_name: 'BrandX' };
    const degraded = buildAudit(snapshot, worse, pack, ctx);
    const html = buildShipSheet({ optimized: worse, audit: degraded, pack });
    expect(html).toContain(`proposed <b>${degraded.scorecardProposed!.total}</b>`);
    expect(html).not.toContain(`proposed <b>${audit.scorecardProposed!.total}</b>`);
  });

  it('the Markdown export shows the arrow form', () => {
    const md = toMarkdown(listing, audit);
    expect(md).toContain(
      `Principle score: current **${audit.scorecard.total}/100** → proposed **${audit.scorecardProposed!.total}/100**`,
    );
  });

  it('an audit with no proposed scorecard still exports (backward compatible)', () => {
    const legacy = { ...audit, scorecardProposed: undefined } as Audit;
    const md = toMarkdown(listing, legacy);
    expect(md).toContain(`Current-listing scorecard: **${audit.scorecard.total}/100**`);
    expect(() => buildShipSheet({ optimized: listing, audit: legacy, pack })).not.toThrow();
  });
});

// ===========================================================================
// 3 — P15 TIMING ADVISORY
// ===========================================================================

describe('WS6 — P15 timing advisory in the post-publish section', () => {
  it('renders the pack advisory, headline and every note', () => {
    const html = buildShipSheet({ optimized: listing, audit, pack });
    const advisory = pack.rules.postPublish!.timingAdvisory!;
    expect(html).toContain('14 · After you publish');
    expect(html).toContain(advisory.headline.replace(/&/g, '&amp;'));
    for (const note of advisory.notes) {
      expect(html).toContain(note.slice(0, 40).replace(/&/g, '&amp;'));
    }
  });

  it('the advisory states both windows the playbook names', () => {
    const text = JSON.stringify(pack.rules.postPublish!.timingAdvisory);
    expect(text).toMatch(/2-4 weeks/);
    expect(text).toMatch(/6-8 weeks/i);
  });

  it('a pack with no post-publish data renders no such section (no procedure of its own)', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as typeof pack;
    delete bare.rules.postPublish;
    const html = buildShipSheet({ optimized: listing, audit, pack: bare });
    expect(html).not.toContain('14 · After you publish');
  });
});

// ===========================================================================
// 4 — THE PUBLISH ROUTE
// ===========================================================================

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
  requireAccess: vi.fn(() => null),
}));
vi.mock('@/lib/store/runs', () => ({
  getRun: vi.fn(),
  publishRun: vi.fn(),
}));

import { POST as PUBLISH } from '@/app/api/runs/[id]/publish/route';
import { requireAccess } from '@/lib/server/guard';
import { getRun, publishRun } from '@/lib/store/runs';
import type { RunRecord } from '@/lib/store/runs';

const runRow = (over: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: 'r1',
    created_at: '2026-07-10T12:00:00Z',
    asin: 'B0TESTASIN',
    url: 'https://www.amazon.com/dp/B0TESTASIN',
    product_name: 'BrandX Probiotic',
    pack_id: 'supplements',
    verified: true,
    score: 80,
    gaps: 0,
    failure_ids: [],
    snapshot,
    optimized: { ...listing, state: 'verified' },
    audit,
    published_at: null,
    ...over,
  }) as RunRecord;

const params = { params: Promise.resolve({ id: 'r1' }) };

describe('POST /api/runs/[id]/publish', () => {
  afterEach(() => vi.clearAllMocks());

  it('is behind the MANDATORY-token guard', async () => {
    vi.mocked(requireAccess).mockReturnValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) as never,
    );
    const res = await PUBLISH(new Request('http://x/api/runs/r1/publish', { method: 'POST' }), params);
    expect(res.status).toBe(401);
    expect(getRun).not.toHaveBeenCalled();
    expect(publishRun).not.toHaveBeenCalled();
  });

  it('404s an unknown run', async () => {
    vi.mocked(getRun).mockResolvedValue(null);
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(404);
    expect(publishRun).not.toHaveBeenCalled();
  });

  it('PUBLISHES a verified run and flips the element state', async () => {
    vi.mocked(getRun).mockResolvedValue(runRow());
    vi.mocked(publishRun).mockImplementation(async (_id, _o, at) => at);
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('published');
    expect(typeof body.publishedAt).toBe('string');
    const written = vi.mocked(publishRun).mock.calls[0]![1];
    expect(written.state).toBe('published');
  });

  /** The rule, in the direction that matters. */
  it('REFUSES an unverified run — 409, and nothing is written', async () => {
    vi.mocked(getRun).mockResolvedValue(
      runRow({
        verified: false,
        audit: {
          ...audit,
          verified: false,
          gateResult: { pass: false, failures: [{ checkId: 'C6', field: 'bullets[0]', context: 'x', fix: 'y' }] },
        },
      }),
    );
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOT_VERIFIED');
    expect(body.failureIds).toEqual(['C6']);
    expect(publishRun).not.toHaveBeenCalled();
  });

  it('trusts the STORED audit, not the run row’s convenience column', async () => {
    // `verified:true` on the row but a FAILING stored audit: the audit wins,
    // because it is the value the audit module derived by re-running the gate.
    vi.mocked(getRun).mockResolvedValue(
      runRow({ verified: true, audit: { ...audit, verified: false } }),
    );
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(409);
    expect(publishRun).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-published run keeps its original timestamp', async () => {
    vi.mocked(getRun).mockResolvedValue(runRow({ published_at: '2026-08-01T09:00:00Z' }));
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publishedAt).toBe('2026-08-01T09:00:00Z');
    expect(body.alreadyPublished).toBe(true);
    expect(publishRun).not.toHaveBeenCalled();
  });

  it('says so plainly when the store is not configured', async () => {
    vi.mocked(getRun).mockResolvedValue(runRow());
    vi.mocked(publishRun).mockResolvedValue(null);
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('STORE_DISABLED');
  });

  it('surfaces a store error as 502 rather than pretending it published', async () => {
    vi.mocked(getRun).mockResolvedValue(runRow());
    vi.mocked(publishRun).mockRejectedValue(new Error('column published_at does not exist'));
    const res = await PUBLISH(new Request('http://x', { method: 'POST' }), params);
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain('published_at');
  });
});
