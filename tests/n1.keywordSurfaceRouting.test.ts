import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import {
  FIELD_TO_GROUP,
  SURFACE_TO_GROUP,
  fieldToGroup,
  routeFailure,
  surfaceToGroup,
  unroutableFailures,
  type SurfaceRoutingTable,
} from '@/lib/engine/fieldRouting';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { runRepairLoop } from '@/lib/engine/repair';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type {
  CompetitorIngestion,
  Failure,
  KeywordTerm,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * N1 — A CORRECT C28 CATCH THAT COULD NEVER BE REPAIRED.
 *
 * ============================================================================
 * THE LIVE DEFECT (B00EEEITVA)
 * ============================================================================
 * One failure, every repair round spent, run ends `verified:false`:
 *
 *   C28 | keywords[6] | negative term 'dairy free' appears on 'title'
 *
 * and the artifact row behind it:
 *
 *   {"term":"dairy free","tier":3,"status":"negative","surfaces":[],
 *    "why":"Contradicts Contains: Milk allergen declaration on label"}
 *
 * THE GATE IS RIGHT. The label declares `Contains: Milk` (the strain is grown
 * on a dairy medium) and the generated title said "Dairy Free" — a false
 * allergen claim, exactly what C28's `negative` leg is for. Nothing in this
 * file relaxes it; §4 and §5 are the tests that say so.
 *
 * THE DEFECT IS THE ADDRESS ON THE ENVELOPE. C28 verifies the keyword
 * REFERENCE, so it reports on `keywords[6]`, and `lib/engine/fieldRouting.ts`
 * routes `keywords[i]` to the `keywords` group. The loop therefore regenerated
 * the reference, round after round, while the offending two words sat in the
 * TITLE — owned by a group the round never called. The failure was structurally
 * unrepairable, and the run could not converge however many rounds it was given.
 *
 * THE FIX. The failure now carries the offending SURFACE as a structured field
 * (`Failure.surface`), and the router resolves that through `SURFACE_TO_GROUP`
 * to the group that AUTHORS the surface. No prose is parsed.
 *
 * THE ASYMMETRY THIS FILE PINS (§3). Most C28 failures genuinely belong to the
 * artifact and must keep routing to `keywords`: an over-declared `placed` row,
 * a `captured-via` row with no route, a `minNegatives` shortfall — and also the
 * `candidate` / `captured-via` / backend-leak presence legs, because
 * `lib/engine/keywordPlacement.ts` re-derives every one of those statuses from
 * the finished copy on every round, so regenerating the reference CORRECTS
 * them. `negative` is the single status derivation deliberately never touches
 * (its falsification by the copy IS the R50 violation), which is why it is the
 * single leg whose only honest remedy is the copy.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The rival brand the golden keyword artifact already records as `negative`. */
const RIVAL = 'Greenluxe';

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const l = clone();
  fn(l);
  return l;
};
const negatives = (fs: Failure[]): Failure[] =>
  fs.filter((f) => f.checkId === 'C28' && f.context.startsWith('negative term'));

// ===========================================================================
// 1 — THE SURFACE TABLE IS COMPLETE, CLOSED AND NOT VACUOUS
// ===========================================================================

describe('N1 §1 — every surface the pack declares has an owning generation group', () => {
  it('the shipped keyword vocabulary maps, name for name — a surface with no row is a routing gap', () => {
    const kr = pack.rules.keywordRules!;
    const unmapped = [...kr.visibleSurfaces, ...kr.backendSurfaces].filter(
      (name) => surfaceToGroup(name) === null,
    );
    expect(unmapped, `surfaces with no owning group: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('each name resolves to the group that actually authors it', () => {
    const expected: [string, string][] = [
      ['title', 'title'],
      ['title75', 'title'],
      ['itemHighlights', 'title'],
      ['bullet1', 'bullets'],
      ['bullet5', 'bullets'],
      ['bullets', 'bullets'],
      ['description', 'description'],
      ['backend', 'backend'],
      ['attributes', 'attributes'],
      ['aplus', 'aplus'],
      ['faq', 'aplus'],
      ['qa', 'qa'],
      ['images', 'images'],
      ['video', 'images'],
    ];
    for (const [name, group] of expected) expect(surfaceToGroup(name), name).toBe(group);
  });

  it('a surface NOTHING authors is `unroutable`, never a silent fall-back to the field row', () => {
    const orphan: Failure = {
      checkId: 'C28',
      field: 'keywords[3]',
      context: "negative term 'x' appears on 'packagingInsert'",
      fix: 'y',
      surface: 'packagingInsert',
    };
    expect(surfaceToGroup('packagingInsert')).toBeNull();
    expect(routeFailure(orphan).kind).toBe('unroutable');
    // ...and specifically NOT the keyword group, which is the address that
    // could never converge.
    expect(fieldToGroup(orphan)).not.toBe('keywords');
    expect(unroutableFailures([orphan])).toEqual([{ checkId: 'C28', field: 'keywords[3]' }]);
  });

  it('nothing in the routing tables reads the failure PROSE', () => {
    // Same structured failure, message reworded beyond recognition: the route
    // must not move. A table that parsed English would.
    const a: Failure = { checkId: 'C28', field: 'keywords[6]', context: "negative term 'q' appears on 'title'", fix: '', surface: 'title' };
    const b: Failure = { ...a, context: 'completely different words here', fix: 'and here' };
    expect(fieldToGroup(a)).toBe('title');
    expect(fieldToGroup(b)).toBe('title');
  });
});

// ===========================================================================
// 2 — THE CHECK EMITS THE SURFACE, FOR EVERY SURFACE IT CAN SCAN
// ===========================================================================

/** Plant a term on ONE pack surface, and the group that must be regenerated. */
const PLANTS: [string, string, (l: OptimizedListing, t: string) => void][] = [
  ['title', 'title', (l, t) => { l.title = l.title.replace('Shelf Stable', t); }],
  ['title75', 'title', (l, t) => { l.title75 = `${l.title75.slice(0, 40)} ${t}`; }],
  ['itemHighlights', 'title', (l, t) => { l.itemHighlights = `${t} routine`; }],
  ['bullets', 'bullets', (l, t) => { l.bullets[0] = `${l.bullets[0]} ${t}`; }],
  ['description', 'description', (l, t) => { l.description = `${t}. ${l.description}`; }],
  ['attributes', 'attributes', (l, t) => { l.attributes.product_benefit = `${t} support`; }],
  ['aplus', 'aplus', (l, t) => { l.aplusContent.modules[0]!.bannerAltText = `${t} banner`; }],
  ['faq', 'aplus', (l, t) => { l.aplusContent.faq[0]!.a = `${l.aplusContent.faq[0]!.a} ${t}`; }],
  ['qa', 'qa', (l, t) => { l.qa[0]!.a = `${l.qa[0]!.a} ${t}`; }],
  ['images', 'images', (l, t) => { l.imagePlan[0]!.altText = `${t} pack shot`; }],
  ['video', 'images', (l, t) => { l.videoBrief!.notes = `${l.videoBrief!.notes} ${t}`; }],
  ['backend', 'backend', (l, t) => { l.backendSearchTerms = `${l.backendSearchTerms} ${t}`; }],
];

describe('N1 §2 — a `negative` term on ANY surface names that surface and routes to its author', () => {
  for (const [surface, group, plant] of PLANTS) {
    it(`'${surface}' -> the ${group} group`, () => {
      const l = mut((x) => plant(x, RIVAL));
      const fs = negatives(c28KeywordPlacement(l, pack));
      expect(fs.length, `no C28 negative failure for '${surface}'`).toBeGreaterThan(0);
      const hit = fs.find((f) => f.surface === surface);
      expect(hit, `no failure carrying surface '${surface}' (got: ${fs.map((f) => f.surface).join(', ')})`).toBeTruthy();
      // The prose and the structured field agree — the prose is for the human.
      expect(hit!.context).toContain(`'${surface}'`);
      // Every failure this plant produced routes to a COPY group, never to the
      // reference. (Planting in bullets[0] fires 'bullet1' and 'bullets' both.)
      for (const f of fs) {
        expect(fieldToGroup(f), `${f.surface}`).toBe(group);
        expect(fieldToGroup(f)).not.toBe('keywords');
      }
      expect(fieldToGroup(hit!)).toBe(group);
    });
  }

  it('the AUTOMATIC rival-brand leg names its surface too — it has no artifact row at all', () => {
    const competitors: CompetitorIngestion[] = [
      {
        asin: 'B0RIVAL001',
        snapshot: {
          ...snapshot,
          asin: 'B0RIVAL001',
          title: 'A rival listing title',
          attributes: { brand_name: 'Nordic Flora Labs' },
        } as ListingSnapshot,
      },
    ];
    const l = mut((x) => { x.description = `Nordic Flora Labs is a different brand. ${x.description}`; });
    const rivalBrands = rivalBrandNames(competitors, l, snapshot);
    expect(rivalBrands.length).toBeGreaterThan(0);
    const fs = c28KeywordPlacement(l, pack, { ...ctx, rivalBrands }).filter((f) =>
      f.context.startsWith('ingested competitor brand'),
    );
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) {
      expect(f.field).toBe('keywords');
      expect(f.surface).toBe('description');
      expect(fieldToGroup(f)).toBe('description');
    }
  });
});

// ===========================================================================
// 3 — THE ASYMMETRY: THE ARTIFACT-OWNED FAMILIES STILL ROUTE TO `keywords`
// ===========================================================================

const rows = (l: OptimizedListing): Partial<KeywordTerm>[] =>
  (l.keywords ?? []) as Partial<KeywordTerm>[];

describe('N1 §3 — a C28 failure the ARTIFACT owns keeps routing to the keyword group', () => {
  const artifactOwned = (l: OptimizedListing, match: (f: Failure) => boolean, label: string): void => {
    const fs = c28KeywordPlacement(l, pack).filter(match);
    expect(fs.length, `no failure for ${label}`).toBeGreaterThan(0);
    for (const f of fs) {
      expect(f.surface, `${label} must not name a surface`).toBeUndefined();
      expect(fieldToGroup(f), label).toBe('keywords');
    }
  };

  it('(a) a `placed` row that OVER-DECLARES its surfaces', () => {
    const l = mut((x) => {
      rows(x)[0] = { term: 'zzqqz', tier: 1, status: 'placed', surfaces: ['title'], why: 'declared but absent' } as KeywordTerm;
    });
    artifactOwned(l, (f) => f.context.includes('is declared placed on'), 'over-declared placed');
  });

  it('(b) a `captured-via` row with no route recorded', () => {
    const l = mut((x) => {
      rows(x)[0] = { term: 'zzqqz', tier: 1, status: 'captured-via', surfaces: [], via: '', why: 'no route' } as KeywordTerm;
    });
    artifactOwned(l, (f) => f.context.includes('captured-via with no route'), 'captured-via without via');
  });

  it('(c) a shortfall against `minNegatives`', () => {
    const l = mut((x) => {
      x.keywords = rows(x).filter((r) => r.status !== 'negative') as KeywordTerm[];
    });
    artifactOwned(l, (f) => f.context.includes('negative term(s)'), 'minNegatives shortfall');
  });

  it('(d) the DERIVED absence/placement statuses too — regenerating the reference corrects those', () => {
    // `candidate`, `captured-via` presence and the backend-only leak are all
    // re-derived from the finished copy on every round, so the keyword group
    // really can repair them. They deliberately do NOT name a surface.
    const candidate = mut((x) => {
      rows(x)[0] = { term: 'prebiotic', tier: 1, status: 'candidate', surfaces: [], why: 'held back' } as KeywordTerm;
    });
    artifactOwned(candidate, (f) => f.context.startsWith('candidate term'), 'candidate present in copy');

    const capturedVia = mut((x) => {
      rows(x)[0] = { term: 'prebiotic', tier: 1, status: 'captured-via', surfaces: [], via: 'the compliant cluster', why: 'recaptured' } as KeywordTerm;
    });
    artifactOwned(capturedVia, (f) => f.context.startsWith('captured-via term'), 'captured-via present in copy');

    const backendLeak = mut((x) => { x.description = `${x.description} acidophilus cultures.`; });
    artifactOwned(
      backendLeak,
      (f) => f.context.includes('also appears on visible surface'),
      'backend-only leak',
    );
  });
});

// ===========================================================================
// 4 — THE LIVE SHAPE, END TO END: IT CONVERGES, AND IT CONVERGES BY REWRITING
//     THE TITLE
// ===========================================================================

/**
 * The live model wrote a term its own keyword reference had marked `negative`
 * into the TITLE. This stub reproduces that, and fixes it only once the
 * regeneration prompt for the TITLE group actually carries the C28 failure —
 * which is the thing routing is responsible for.
 */
function convergingLlm(): LlmClient & { titleCalls: () => number; keywordCalls: () => number } {
  let titleCalls = 0;
  let keywordCalls = 0;
  const llm = (async (req) => {
    const body = await mockLlm(req);
    if (req.user.includes('TASK: The keyword reference')) keywordCalls++;
    if (!req.user.includes('Generate the title group')) return body;
    titleCalls++;
    const sawFailure = req.user.includes('[C28]') && req.user.includes('negative term');
    if (sawFailure) return body;
    const parsed = JSON.parse(body) as { title: string };
    parsed.title = parsed.title.replace('Shelf Stable', RIVAL);
    return JSON.stringify(parsed);
  }) as LlmClient & { titleCalls: () => number; keywordCalls: () => number };
  llm.titleCalls = () => titleCalls;
  llm.keywordCalls = () => keywordCalls;
  return llm;
}

describe('N1 §4 — the live shape converges', () => {
  it('round 1 reproduces the live finding, and it is the ONLY finding', async () => {
    const listing = await optimize(snapshot, pack, convergingLlm());
    const failures = runGate(listing, pack, ctx).failures;
    expect(failures.map((f) => `${f.checkId}:${f.field}`)).toEqual(
      failures.map((f) => `${f.checkId}:${f.field}`).filter((i) => i.startsWith('C28:keywords[')),
    );
    expect(failures.length).toBe(1);
    const f = failures[0]!;
    expect(f.checkId).toBe('C28');
    expect(f.field).toMatch(/^keywords\[\d+\]$/);
    expect(f.context).toContain("appears on 'title'");
    expect(f.surface).toBe('title');
  });

  it('THE DEFECT, NAMED: the same failure without its surface routes to the keyword group', async () => {
    const listing = await optimize(snapshot, pack, convergingLlm());
    const live = runGate(listing, pack, ctx).failures[0]!;
    // What the router did before N1 — the reference regenerated forever while
    // the words sat in the title.
    const { surface: _dropped, ...withoutSurface } = live;
    expect(fieldToGroup(withoutSurface as Failure)).toBe('keywords');
    // What it does now.
    expect(fieldToGroup(live)).toBe('title');
  });

  it('the repair loop regenerates the TITLE and reaches verified:true', async () => {
    const llm = convergingLlm();
    const outcome = await runRepairLoop(snapshot, pack, llm, ctx, 3);
    expect(outcome.iterations).toBeGreaterThan(0);
    expect(outcome.gateResult.failures).toEqual([]);
    expect(outcome.gateResult.pass).toBe(true);
    expect(outcome.unroutable).toEqual([]);
    expect(outcome.listing.title).not.toContain(RIVAL);
    // The title group really was called again — the routing is what did it.
    expect(llm.titleCalls()).toBeGreaterThan(1);
    // ...and the reference was re-derived in the SAME round (the WS3 coupling),
    // which is why routing to the copy group INSTEAD of the keyword group loses
    // nothing.
    expect(llm.keywordCalls()).toBeGreaterThan(1);
    // The audit agrees, because it re-runs the gate itself.
    const audit = buildAudit(snapshot, outcome.listing, pack, ctx);
    expect(audit.verified).toBe(true);
    expect('routingGaps' in audit).toBe(false);
  });
});

// ===========================================================================
// 5 — THE OTHER DIRECTION: C28 IS NOT WEAKENED
// ===========================================================================

describe('N1 §5 — routing makes a failure REPAIRABLE, never passing', () => {
  it('a model that keeps writing the negative term into the title still ends UNVERIFIED', async () => {
    const blind: LlmClient = async (req) => {
      const body = await mockLlm(req);
      if (!req.user.includes('Generate the title group')) return body;
      const parsed = JSON.parse(body) as { title: string };
      parsed.title = parsed.title.replace('Shelf Stable', RIVAL);
      return JSON.stringify(parsed);
    };
    const outcome = await runRepairLoop(snapshot, pack, blind, ctx, 2);
    expect(outcome.gateResult.pass).toBe(false);
    const c28 = outcome.gateResult.failures.filter((f) => f.checkId === 'C28');
    expect(c28.length).toBeGreaterThan(0);
    expect(c28.some((f) => f.context.includes("appears on 'title'"))).toBe(true);
    // A COPY failure, not a routing gap — the router owns it now.
    expect(outcome.unroutable).toEqual([]);
    const audit = buildAudit(snapshot, outcome.listing, pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.routingGaps).toBeUndefined();
  });

  it("C28's trigger is unmoved: the negative leg still fires on every surface, invisible ones included", () => {
    for (const [surface, , plant] of PLANTS) {
      const l = mut((x) => plant(x, RIVAL));
      expect(
        negatives(c28KeywordPlacement(l, pack)).some((f) => f.surface === surface),
        surface,
      ).toBe(true);
    }
  });

  it('lawful copy on the very same surfaces still PASSES — this is not an over-block', () => {
    expect(c28KeywordPlacement(clean, pack)).toEqual([]);
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// 6 — THE SURFACE TABLE IS NOT VACUOUS
// ===========================================================================

describe('N1 §6 — deleting the row that owns a surface makes the live failure unroutable', () => {
  const live: Failure = {
    checkId: 'C28',
    field: 'keywords[6]',
    context: "negative term 'q' appears on 'title'",
    fix: '',
    surface: 'title',
  };

  it('the shipped table routes it', () => {
    expect(routeFailure(live).kind).toBe('group');
    expect(fieldToGroup(live)).toBe('title');
  });

  it('deleting the title row removes exactly one row and the same call then reports the gap', () => {
    const damaged: SurfaceRoutingTable = SURFACE_TO_GROUP.filter((r) => !r.match('title'));
    expect(damaged.length).toBe(SURFACE_TO_GROUP.length - 1);
    expect(routeFailure(live, FIELD_TO_GROUP, damaged).kind).toBe('unroutable');
    expect(unroutableFailures([live], FIELD_TO_GROUP, damaged)).toEqual([
      { checkId: 'C28', field: 'keywords[6]' },
    ]);
    // ...and it is genuinely the same call that resolves on the real table.
    expect(unroutableFailures([live])).toEqual([]);
  });

  it('the proof is not title-specific — the video row behaves the same way', () => {
    const vid: Failure = { ...live, context: "negative term 'q' appears on 'video'", surface: 'video' };
    expect(fieldToGroup(vid)).toBe('images');
    const damaged: SurfaceRoutingTable = SURFACE_TO_GROUP.filter((r) => !r.match('video'));
    expect(damaged.length).toBe(SURFACE_TO_GROUP.length - 1);
    expect(routeFailure(vid, FIELD_TO_GROUP, damaged).kind).toBe('unroutable');
  });
});
