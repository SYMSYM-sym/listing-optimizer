import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, keywordSurfaceText, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * C28 — THE TWO SURFACES THE READER USED TO MISS (A+ banner ALT, video brief).
 *
 * THE BYPASS THIS FILE CLOSES. `keywordSurfaceText` is C28's own private
 * surface reader. Its `aplus` case read headline/body/subcopy/comparison and
 * NOT `bannerAltText`, and there was no `video` case at all — so the video
 * brief was outside the pack vocabulary entirely. Both holes had the same
 * consequence: a `negative` row (which is where rival brand names live, R50,
 * and which AM-9 exists to guarantee) was scanned against a corpus that did
 * not contain the text an operator actually ships. A rival brand planted in
 * an A+ banner ALT string, or in `videoBrief.onScreenText` / `.notes`,
 * produced ZERO gate failures and a `verified: true` run.
 *
 * BOTH DIRECTIONS, every leg: the violation must FAIL, and lawful copy written
 * into the very same field must PASS. A surface reader that fails everything
 * is not a fix, it is a different bug.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** The rival brand the golden artifact already declares `negative` (R50). */
const RIVAL = 'GreenLuxe';

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c28KeywordPlacement(l, p);
const mentions = (fs: Failure[], term: string): boolean =>
  fs.some((f) => f.checkId === 'C28' && f.context.toLowerCase().includes(term.toLowerCase()));

/** Every writable string field of the video brief, addressed by a mutator. */
const VIDEO_FIELDS: [string, (l: OptimizedListing, text: string) => void][] = [
  ['videoBrief.aspect', (l, t) => { l.videoBrief!.aspect = `9:16 vertical ${t}`; }],
  ['videoBrief.shots[0]', (l, t) => { l.videoBrief!.shots[0] = `Open on the bottle ${t}`; }],
  ['videoBrief.onScreenText[0]', (l, t) => { l.videoBrief!.onScreenText[0] = `${t}`; }],
  ['videoBrief.notes', (l, t) => { l.videoBrief!.notes = `Assume it is watched muted. ${t}`; }],
];

/** The A+ banner ALT string of the first module. */
const setBannerAlt = (l: OptimizedListing, text: string): void => {
  l.aplusContent.modules[0]!.bannerAltText = text;
};

// ===========================================================================
// 0 — the surfaces RESOLVE (a name that reads nothing vouches for everything)
// ===========================================================================

describe('C28 surface vocabulary — the pack names them and the gate can read them', () => {
  it("the pack declares 'video' and every declared surface still resolves", () => {
    const kr = pack.rules.keywordRules!;
    expect(kr.visibleSurfaces).toContain('video');
    expect(kr.visibleSurfaces).toContain('aplus');
    for (const name of [...kr.visibleSurfaces, ...kr.backendSurfaces]) {
      expect(keywordSurfaceText(clean, name), `surface '${name}' has no resolver`).not.toBeNull();
    }
  });

  it("the 'video' reader carries EVERY string field of the brief", () => {
    const l = clone();
    l.videoBrief = {
      aspect: 'ASPECTMARKER',
      durationSeconds: 30,
      shots: ['SHOTMARKER'],
      onScreenText: ['ONSCREENMARKER'],
      notes: 'NOTESMARKER',
    };
    const text = keywordSurfaceText(l, 'video') ?? '';
    for (const marker of ['ASPECTMARKER', 'SHOTMARKER', 'ONSCREENMARKER', 'NOTESMARKER']) {
      expect(text, marker).toContain(marker);
    }
  });

  it("the 'aplus' reader carries banner ALT as well as the module text", () => {
    const l = clone();
    setBannerAlt(l, 'ALTMARKER banner');
    l.aplusContent.modules[0]!.headline = 'HEADLINEMARKER';
    const text = keywordSurfaceText(l, 'aplus') ?? '';
    expect(text).toContain('ALTMARKER');
    expect(text).toContain('HEADLINEMARKER');
  });

  it('an unknown declared surface STILL fails — the world stays closed', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    p.rules.keywordRules!.visibleSurfaces = [...p.rules.keywordRules!.visibleSurfaces, 'packagingInsert'];
    expect(c28(clean, p).some((f) => f.context.includes('packagingInsert'))).toBe(true);
  });
});

// ===========================================================================
// 1 — NEGATIVE terms (R50): the proven bypass, both directions
// ===========================================================================

describe('C28 negative terms — A+ banner ALT', () => {
  it('FAILS when a negative rival brand is planted in bannerAltText', () => {
    const l = clone();
    setBannerAlt(l, `${RIVAL} probiotic banner`);
    const fs = c28(l);
    expect(mentions(fs, RIVAL)).toBe(true);
    expect(fs.some((f) => f.context.includes("'aplus'"))).toBe(true);
  });

  it('the same plant no longer produces a verified run (the bypass, end to end)', () => {
    const l = clone();
    setBannerAlt(l, `${RIVAL} probiotic banner`);
    const result = runGate(l, pack, ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'C28')).toBe(true);
  });

  it('PASSES with lawful ALT copy in the very same field', () => {
    const l = clone();
    setBannerAlt(l, 'Brand story banner: third-party tested, made in a cGMP facility in the USA');
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

describe('C28 negative terms — the video brief, field by field', () => {
  for (const [label, plant] of VIDEO_FIELDS) {
    it(`FAILS when a negative rival brand is planted in ${label}`, () => {
      const l = clone();
      plant(l, RIVAL);
      const fs = c28(l);
      expect(mentions(fs, RIVAL), label).toBe(true);
      expect(fs.some((f) => f.context.includes("'video'")), label).toBe(true);
    });
  }

  it('PASSES with lawful copy written into every one of those fields', () => {
    const l = clone();
    l.videoBrief = {
      aspect: '9:16 vertical',
      durationSeconds: 30,
      shots: ['Open on the bottle in a real kitchen', 'Hand takes one capsule with water'],
      onScreenText: ['One capsule daily', 'Shelf stable, no refrigeration'],
      notes: 'Shot vertical throughout. Assume it is watched muted.',
    };
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// 2 — the BACKEND-ONLY LEAK rule now covers both surfaces
// ===========================================================================

describe('C28 backend-only leak rule reaches ALT and video', () => {
  /** The golden artifact keeps this term backend-only and nowhere visible. */
  const BACKEND_ONLY = 'acidophilus';

  it('FAILS when a backend-only term leaks into bannerAltText', () => {
    const l = clone();
    setBannerAlt(l, `Ingredients banner with ${BACKEND_ONLY} cultures`);
    const fs = c28(l);
    expect(
      fs.some(
        (f) =>
          f.context.includes(BACKEND_ONLY) &&
          f.context.includes("visible surface 'aplus'"),
      ),
    ).toBe(true);
  });

  it('FAILS when a backend-only term leaks into the video brief', () => {
    const l = clone();
    l.videoBrief!.onScreenText[0] = `${BACKEND_ONLY} cultures`;
    const fs = c28(l);
    expect(
      fs.some(
        (f) =>
          f.context.includes(BACKEND_ONLY) &&
          f.context.includes("visible surface 'video'"),
      ),
    ).toBe(true);
  });

  it('PASSES while the backend-only term stays out of both', () => {
    expect(c28(clean)).toEqual([]);
    expect(keywordSurfaceText(clean, 'video')?.toLowerCase()).not.toContain(BACKEND_ONLY);
  });
});

// ===========================================================================
// 3 — PLACED rows may now DECLARE the new surfaces, both directions
// ===========================================================================

describe("C28 'placed' rows against the new surfaces", () => {
  const withRow = (surfaces: string[]): OptimizedListing => {
    const l = clone();
    l.keywords = [
      ...(l.keywords ?? []).filter((k) => k.status === 'negative'),
      { term: 'shelf stable', tier: 3, status: 'placed', surfaces, why: 'Storage differentiator' },
    ];
    return l;
  };

  it("FAILS a row declaring 'video' when the brief does not carry the term", () => {
    const l = withRow(['video']);
    l.videoBrief = { aspect: '9:16 vertical', durationSeconds: 30, shots: ['Open on the bottle'], onScreenText: ['One capsule daily'], notes: 'Watched muted.' };
    expect(c28(l).some((f) => f.context.includes("'video'"))).toBe(true);
  });

  it("PASSES the same row once the brief actually carries it", () => {
    const l = withRow(['video']);
    l.videoBrief!.onScreenText = ['Shelf stable, no refrigeration'];
    expect(c28(l)).toEqual([]);
  });

  it("FAILS a row declaring 'aplus' carried ONLY by a deleted ALT, and PASSES once ALT carries it", () => {
    const absent = withRow(['aplus']);
    for (const m of absent.aplusContent.modules) delete m.bannerAltText;
    absent.aplusContent.modules.forEach((m) => {
      m.headline = m.headline.replace(/shelf stable/gi, 'stable');
      m.body = m.body.replace(/shelf stable/gi, 'stable');
      if (m.subcopy) m.subcopy = m.subcopy.replace(/shelf stable/gi, 'stable');
    });
    absent.aplusContent.comparison.rows.forEach((r) => {
      r.label = r.label.replace(/shelf stable/gi, 'stable');
      r.ours = r.ours.replace(/shelf stable/gi, 'stable');
      r.typical = r.typical.replace(/shelf stable/gi, 'stable');
    });
    expect(c28(absent).some((f) => f.context.includes("'aplus'"))).toBe(true);

    const present = JSON.parse(JSON.stringify(absent)) as OptimizedListing;
    setBannerAlt(present, 'Storage banner: shelf stable, no refrigeration needed');
    expect(c28(present)).toEqual([]);
  });
});
