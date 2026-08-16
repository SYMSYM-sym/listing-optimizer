import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { fieldToGroup } from '@/lib/engine/fieldRouting';
import {
  COLLECTED_SURFACE_GROUPS,
  c18ProhibitedContent,
  c19ProhibitedMarketing,
  collectSurfaces,
} from '@/lib/gate/checks/c-prohibited';
import { c17Style, styleSurfaces } from '@/lib/gate/checks/c-style';
import { c27OutputHygiene } from '@/lib/gate/checks/c-hygiene';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * N1 — THE DETECTION GAP: ALT TEXT AND THE VIDEO BRIEF WERE NOT SCANNED
 * ===========================================================================
 *
 * THE HOLE, exactly as it stood.
 *
 *   `collectSurfaces` (lib/gate/checks/c-prohibited.ts) is the ONE surface
 *   reader behind three checks — C18 prohibited detail-page content, C19
 *   prohibited marketing, C27 output hygiene. It had:
 *     - an `imagePlan` branch that read `purpose`, `spec` and `notes` and
 *       **not `altText`**;
 *     - **no `videoBrief` branch at all**.
 *
 *   `styleSurfaces` (lib/gate/checks/c-style.ts), the reader behind C17, had
 *   the same `altText` omission and the same missing video brief.
 *
 * So a price, a URL, an email address, a rank claim, a guarantee, a superlative,
 * an AI tell, a leaked instruction fragment or a non-ASCII glyph could sit in an
 * image ALT string or anywhere in the video brief and produce ZERO failures —
 * while the very same string in `imagePlan[i].notes` failed. That asymmetry is
 * the tell: these are not new surfaces. A prior fix had already added them to
 * the C6/C10/C12/C21/C22 corpus (`customerSurfaces`) and to C28's `video`
 * reader, and only these four checks were left behind.
 *
 * Both are strings that SHIP: ALT text is what a screen reader reads aloud and
 * what the marketplace indexes off an image; on-screen video text is rendered
 * into the video a customer watches. Both are also invisible to a human
 * proof-reading the listing page, which is exactly where a stale agency
 * template's leftovers survive.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS SHAPED THIS WAY
 * ---------------------------------------------------------------------------
 * §1  CLOSED WORLD, both directions — the pack's declared surface groups and
 *     the collector's branches are the same set. A group declared with no
 *     branch is silently unscanned (the hole above); a branch with no declared
 *     group is dead code that reads as coverage.
 * §2  DETECTION — for EVERY newly-scanned field × EVERY applicable check, a
 *     genuine violation planted there FAILS, and fails naming that exact field.
 * §3  THE C17 SUB-RULE PARTITION — which style rules were applied to which new
 *     surface, asserted rather than described, INCLUDING the ones deliberately
 *     excluded. An exclusion nobody tests is indistinguishable from an omission.
 * §4  THE LAWFUL-COPY REGRESSION BATTERY — ordinary ALT and overlay copy in the
 *     shapes the live-verified runs actually produce raises NOTHING, from any
 *     of the four checks. Over-blocking is treated in this project as exactly
 *     as severe as a bypass, and this change touches the two surfaces most
 *     likely to produce it.
 * §5  THE C27 ASCII CARVE-OUT DECISION — stated as a test, in both directions.
 * §6  ROUTING — every field the widened readers can now emit resolves to the
 *     generation group that can rewrite it, so a new finding is repairable
 *     rather than a round-burning dead end.
 * §7  NOT VACUOUS — the planted violations pass against the PRE-FIX readers,
 *     reconstructed here, so this suite proves it is testing the change.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

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

/** The four checks this change touches, run together. */
const fourChecks = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => [
  ...c17Style(l, p),
  ...c18ProhibitedContent(l, p),
  ...c19ProhibitedMarketing(l, p),
  ...c27OutputHygiene(l, p),
];

const onField = (fs: Failure[], field: string): Failure[] => fs.filter((f) => f.field === field);

// ===========================================================================
// §0 — THE BASELINE: the shipped fixture is clean on all four checks
// ===========================================================================

describe('§0 baseline', () => {
  it('the golden fixture raises NOTHING from the four widened checks', () => {
    expect(fourChecks(clean)).toEqual([]);
  });

  it('...and still converges to ZERO gate failures overall', () => {
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });

  it('the fixture really does carry the surfaces under test (otherwise §2 proves nothing)', () => {
    expect(clean.imagePlan.every((s) => (s.altText ?? '').trim().length > 0)).toBe(true);
    expect(clean.videoBrief!.onScreenText.length).toBeGreaterThan(0);
    expect(clean.videoBrief!.shots.length).toBeGreaterThan(0);
    expect(clean.videoBrief!.notes.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// §1 — CLOSED WORLD, BOTH DIRECTIONS
// ===========================================================================

/**
 * The three pack keys that drive `collectSurfaces`, each with the check it
 * arms. Named individually rather than folded into a union: see §1.5.
 */
const DECLARING_KEYS: [check: string, key: 'prohibitedContent' | 'prohibitedMarketing' | 'outputHygiene'][] = [
  ['C18', 'prohibitedContent'],
  ['C19', 'prohibitedMarketing'],
  ['C27', 'outputHygiene'],
];

const declaredBy = (key: (typeof DECLARING_KEYS)[number][1]): string[] =>
  (pack.rules[key]?.surfaces ?? []) as string[];

describe('§1 the surface vocabulary is closed in both directions', () => {
  /** Every group any of the three pack keys declares. */
  const declared = new Set<string>([
    ...declaredBy('prohibitedContent'),
    ...declaredBy('prohibitedMarketing'),
    ...declaredBy('outputHygiene'),
  ]);

  it('(a) DECLARED ⊆ CODED — no pack group is silently unscanned (this is the N1 bug class)', () => {
    const orphans = [...declared].filter(
      (g) => !(COLLECTED_SURFACE_GROUPS as readonly string[]).includes(g),
    );
    expect(orphans, `pack declares surface groups the collector cannot read: ${orphans.join(', ')}`).toEqual([]);
  });

  it('(b) CODED ⊆ DECLARED — no branch is dead weight that reads as coverage', () => {
    const unused = COLLECTED_SURFACE_GROUPS.filter((g) => !declared.has(g));
    expect(unused, `collector branches nothing declares: ${unused.join(', ')}`).toEqual([]);
  });

  it('(c) every coded group actually PRODUCES a field on a populated listing', () => {
    for (const group of COLLECTED_SURFACE_GROUPS) {
      const fields = collectSurfaces(clean, new Set([group]), pack.rules.factFields?.price).map(
        (s) => s.field,
      );
      expect(fields.length, `group '${group}' produced no surface`).toBeGreaterThan(0);
    }
  });

  it('(d) the video brief and every ALT string are among the fields the collector now returns', () => {
    const all = collectSurfaces(clean, declared, pack.rules.factFields?.price).map((s) => s.field);
    expect(all).toContain('imagePlan[0].altText');
    expect(all).toContain('videoBrief.aspect');
    expect(all).toContain('videoBrief.shots[0]');
    expect(all).toContain('videoBrief.onScreenText[0]');
    expect(all).toContain('videoBrief.notes');
    // ...and every ALT slot, not just the first
    for (let i = 0; i < clean.imagePlan.length; i++) {
      expect(all, `slot ${i}`).toContain(`imagePlan[${i}].altText`);
    }
  });

  it('(e) C17 reads the same set, tagged with its scoping groups', () => {
    const rows = styleSurfaces(clean);
    const byField = new Map(rows.map((r) => [r.field, r.group]));
    expect(byField.get('imagePlan[0].altText')).toBe('images');
    expect(byField.get('videoBrief.aspect')).toBe('video');
    expect(byField.get('videoBrief.shots[0]')).toBe('video');
    expect(byField.get('videoBrief.onScreenText[0]')).toBe('video');
    expect(byField.get('videoBrief.notes')).toBe('video');
  });

  it('(f) a listing with NO video brief produces no video surfaces and never throws', () => {
    const noVideo = mut((l) => { delete l.videoBrief; });
    expect(() => collectSurfaces(noVideo, new Set(['videoBrief']), undefined)).not.toThrow();
    expect(collectSurfaces(noVideo, new Set(['videoBrief']), undefined)).toEqual([]);
    expect(styleSurfaces(noVideo).some((r) => r.group === 'video')).toBe(false);
    // C29 owns "the brief is missing"; these four checks simply say nothing.
    expect(fourChecks(noVideo)).toEqual([]);
  });

  it('(g) a MALFORMED brief (nulls, wrong types) still produces failures rather than an exception', () => {
    const junk = mut((l) => {
      l.videoBrief = {
        aspect: null,
        durationSeconds: 30,
        shots: [null, 42],
        onScreenText: null,
        notes: undefined,
      } as never;
      l.imagePlan[0] = { ...l.imagePlan[0]!, altText: null } as never;
    });
    expect(() => fourChecks(junk)).not.toThrow();
    expect(() => runGate(junk, pack, ctx)).not.toThrow();
    expect(runGate(junk, pack, ctx).failures.every((f) => f.checkId !== 'GATE')).toBe(true);
  });
});

// ===========================================================================
// §1.5 — THE SAME CLOSURE, PINNED PER CHECK (M3)
// ===========================================================================

/**
 * WHY THIS SECTION EXISTS AT ALL.
 *
 * §1 pins `COLLECTED_SURFACE_GROUPS` against the **union** of the three
 * declaring keys, and a union hides a per-check omission completely. It did:
 * `facts` was declared by `prohibitedContent` and by `prohibitedMarketing` and
 * NOT by `outputHygiene`, so C18 and C19 read every fact string and **C27 never
 * read one** — while every assertion in §1 stayed green, because the union still
 * contained `facts`. That is finding M1, and §1 could not have caught it however
 * carefully it was read.
 *
 * So each check's declared set is asserted INDIVIDUALLY here. A future narrowing
 * of any ONE of the three lists is a failure in this section, rather than
 * something §2's shipped-pack cases might or might not happen to trip over.
 */

/** Groups the collector can read that a declaration list omits. */
const missingFrom = (list: readonly string[]): string[] =>
  COLLECTED_SURFACE_GROUPS.filter((g) => !list.includes(g));

/** Groups a declaration list names that the collector cannot read. */
const orphansIn = (list: readonly string[]): string[] =>
  list.filter((g) => !(COLLECTED_SURFACE_GROUPS as readonly string[]).includes(g));

describe('§1.5 each check declares the WHOLE vocabulary, asserted per check', () => {
  for (const [check, key] of DECLARING_KEYS) {
    it(`(a) ${check} — rules.${key}.surfaces declares every group the collector can read`, () => {
      const missing = missingFrom(declaredBy(key));
      expect(
        missing,
        `${check} does not scan: ${missing.join(', ')} (the collector reads them for the other checks)`,
      ).toEqual([]);
    });

    it(`(b) ${check} — rules.${key}.surfaces declares nothing the collector cannot read`, () => {
      const orphans = orphansIn(declaredBy(key));
      expect(orphans, `${check} declares unreadable groups: ${orphans.join(', ')}`).toEqual([]);
    });

    it(`(c) ${check} — no group is declared twice (a duplicate reads as breadth and adds none)`, () => {
      const list = declaredBy(key);
      expect(list.length).toBe(new Set(list).size);
    });
  }

  it('(d) the three lists are the SAME set — any divergence between them is the M1 shape', () => {
    const [first, ...rest] = DECLARING_KEYS.map(([, key]) => [...declaredBy(key)].sort());
    for (const other of rest) expect(other).toEqual(first);
  });

  it('(e) NOT VACUOUS — narrowing ONE list by one group fails HERE and is invisible to §1', () => {
    for (const [, key] of DECLARING_KEYS) {
      for (const group of COLLECTED_SURFACE_GROUPS) {
        const narrowed = declaredBy(key).filter((g) => g !== group);
        // this section catches it...
        expect(missingFrom(narrowed), `${key} minus ${group}`).toEqual([group]);
        // ...and §1's union does not, because the other two keys still name it.
        const union = new Set<string>([
          ...DECLARING_KEYS.filter(([, k]) => k !== key).flatMap(([, k]) => declaredBy(k)),
          ...narrowed,
        ]);
        expect([...union].sort(), `${key} minus ${group} is invisible to the union`).toEqual(
          [...COLLECTED_SURFACE_GROUPS].sort(),
        );
      }
    }
  });
});

// ===========================================================================
// §2 — DETECTION: each new field × each applicable check
// ===========================================================================

const putAlt = (l: OptimizedListing, text: string): void => {
  l.imagePlan[0] = { ...l.imagePlan[0]!, altText: text };
};
const putOverlay = (l: OptimizedListing, text: string): void => {
  l.videoBrief!.onScreenText[0] = text;
};
const putShot = (l: OptimizedListing, text: string): void => {
  l.videoBrief!.shots[0] = text;
};
const putNotes = (l: OptimizedListing, text: string): void => {
  l.videoBrief!.notes = text;
};
const putAspect = (l: OptimizedListing, text: string): void => {
  l.videoBrief!.aspect = text;
};

const TARGETS: { name: string; field: string; put: (l: OptimizedListing, t: string) => void }[] = [
  { name: 'image ALT text', field: 'imagePlan[0].altText', put: putAlt },
  { name: 'video on-screen text', field: 'videoBrief.onScreenText[0]', put: putOverlay },
  { name: 'video shot direction', field: 'videoBrief.shots[0]', put: putShot },
  { name: 'video notes', field: 'videoBrief.notes', put: putNotes },
  { name: 'video aspect', field: 'videoBrief.aspect', put: putAspect },
];

describe('§2 C18 — prohibited detail-page content now fails on every new surface', () => {
  // One violation per PATTERN FAMILY the pack ships, spread across the targets
  // so no single family is doing all the work.
  const CASES: [string, string][] = [
    ['a $ price figure', 'Only $19.95 while the offer runs'],
    ['a bare domain URL', 'Overlay the badge with brandsite.com in the corner'],
    ['an email address', 'End card reads contact help@example.com'],
    ['a shipping offer', 'End card reads free shipping on every order'],
    ['an availability claim', 'Card reads in stock and ready'],
  ];

  for (const target of TARGETS) {
    for (const [label, text] of CASES) {
      it(`${label} planted in the ${target.name} FAILS C18 on '${target.field}'`, () => {
        const bad = mut((l) => target.put(l, text));
        const hits = onField(c18ProhibitedContent(bad, pack), target.field);
        expect(hits.length, `no C18 finding on ${target.field}`).toBeGreaterThan(0);
        expect(hits[0]!.checkId).toBe('C18');
      });
    }
  }

  it('the SAME violation was invisible before the fix (pre-fix reader, reconstructed)', () => {
    const bad = mut((l) => putAlt(l, 'Only $19.95 while the offer runs'));
    // The pre-fix `imagePlan` branch read purpose/spec/notes only, and there was
    // no videoBrief branch at all. Reconstruct exactly that and confirm the
    // string is unreachable — so §2 is testing the change, not the pack.
    const preFix = collectSurfaces(bad, new Set(['title', 'bullets', 'description', 'qa', 'attributes', 'aplus', 'facts', 'backendSearchTerms']), pack.rules.factFields?.price);
    expect(preFix.some((s) => s.text.includes('$19.95'))).toBe(false);
  });
});

describe('§2 C19 — prohibited marketing now fails on every new surface', () => {
  const CASES: [string, string][] = [
    ['a rank/best-seller claim', 'Card reads the best seller in its category'],
    ['a guarantee', 'Card reads money back guarantee on every bottle'],
    ['an authority endorsement', 'Card reads doctor recommended for adults'],
    ['a star-rating claim', 'Card reads rated 5 star by shoppers'],
    ['a superlative from the compliance lexicon', 'Card reads clinically proven support'],
  ];

  for (const target of TARGETS) {
    for (const [label, text] of CASES) {
      it(`${label} planted in the ${target.name} FAILS C19 on '${target.field}'`, () => {
        const bad = mut((l) => target.put(l, text));
        const hits = onField(c19ProhibitedMarketing(bad, pack), target.field);
        expect(hits.length, `no C19 finding on ${target.field}`).toBeGreaterThan(0);
        expect(hits[0]!.checkId).toBe('C19');
      });
    }
  }
});

describe('§2 C27 — output hygiene now fails on every new surface', () => {
  const CASES: [string, string, string][] = [
    ['a non-ASCII glyph', 'Shot in a café with the bottle in frame', 'non-ASCII'],
    ['a smart quote the fold left alone', 'The bottle’s front label, fully legible', 'non-ASCII'],
    ['a zero-width character', 'Front label​ fully legible in frame', 'non-ASCII'],
    ['an AI-tell phrase', 'Look no further, the bottle sits in frame', 'AI-tell'],
    ['a leaked instruction fragment', 'Task: open on the bottle in a real kitchen', 'instruction fragment'],
  ];

  for (const target of TARGETS) {
    for (const [label, text, kind] of CASES) {
      it(`${label} planted in the ${target.name} FAILS C27 on '${target.field}'`, () => {
        const bad = mut((l) => target.put(l, text));
        const hits = onField(c27OutputHygiene(bad, pack), target.field);
        expect(hits.length, `no C27 finding on ${target.field}`).toBeGreaterThan(0);
        expect(hits.some((h) => h.context.includes(kind))).toBe(true);
      });
    }
  }
});

// ===========================================================================
// §3 — THE C17 SUB-RULE PARTITION, ASSERTED
// ===========================================================================

describe('§3 C17 — the sub-rules that were APPLIED to the new surfaces', () => {
  const SYMBOL = pack.rules.style.bannedSymbols[0]!;

  const APPLIED: [string, string][] = [
    ['a banned symbol', `Bottle beside one capsule ${SYMBOL} on a white background`],
    ['an emoji', 'Bottle beside one capsule \u{1F600} on a white background'],
    ['an ASIN in copy', 'Bottle beside one capsule, B0ABCDEFGH, on a white background'],
    ['raw HTML markup', 'Bottle beside <b>one capsule</b> on a white background'],
  ];

  for (const target of TARGETS) {
    for (const [label, text] of APPLIED) {
      it(`${label} in the ${target.name} FAILS C17 on '${target.field}'`, () => {
        const bad = mut((l) => target.put(l, text));
        const hits = onField(c17Style(bad, pack), target.field);
        expect(hits.length, `no C17 finding on ${target.field}`).toBeGreaterThan(0);
        expect(hits[0]!.checkId).toBe('C17');
      });
    }
  }

  it('ALL-CAPS shouting IS applied to image ALT text — it is prose a screen reader reads aloud', () => {
    const bad = mut((l) => putAlt(l, 'BUY MORE NOW bottle on a white background'));
    const hits = onField(c17Style(bad, pack), 'imagePlan[0].altText');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /sentence case/i.test(h.fix))).toBe(true);
  });

  it('...and the per-word ALL-CAPS rule too, exactly as on its purpose/spec/notes siblings', () => {
    const shout = 'SHOUTING bottle on a white background';
    const inAlt = mut((l) => putAlt(l, shout));
    const inNotes = mut((l) => { l.imagePlan[0] = { ...l.imagePlan[0]!, notes: shout }; });
    expect(onField(c17Style(inAlt, pack), 'imagePlan[0].altText').length).toBeGreaterThan(0);
    // the sibling behaves identically — that is the point of putting ALT in the
    // same group rather than inventing a special case for it
    expect(onField(c17Style(inNotes, pack), 'imagePlan[0].notes').length).toBeGreaterThan(0);
  });
});

describe('§3 C17 — the sub-rules DELIBERATELY EXCLUDED (an untested exclusion is an omission)', () => {
  it('ALL-CAPS is NOT applied to the video brief: a caps title card is typography, not shouting', () => {
    const capsOverlay = mut((l) => putOverlay(l, 'SHELF STABLE NO REFRIGERATION'));
    expect(onField(c17Style(capsOverlay, pack), 'videoBrief.onScreenText[0]')).toEqual([]);
  });

  it('...nor to a shot list, where capitalised slug lines are the conventional register', () => {
    const slug = mut((l) => putShot(l, 'CLOSE ON THE FRONT LABEL as the hand lowers'));
    expect(onField(c17Style(slug, pack), 'videoBrief.shots[0]')).toEqual([]);
  });

  it('the exemption is PACK DATA and it only SUBTRACTS — removing it makes the gate stricter', () => {
    const strict = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete strict.rules.style.allCapsExemptSurfaces;
    const capsOverlay = mut((l) => putOverlay(l, 'SHELF STABLE NO REFRIGERATION'));
    // absent list -> the ALL-CAPS rules run everywhere, the pre-existing behaviour
    expect(onField(c17Style(capsOverlay, strict), 'videoBrief.onScreenText[0]').length).toBeGreaterThan(0);
    // ...and it cannot be used to exempt anything the pack does not name
    expect(pack.rules.style.allCapsExemptSurfaces).toEqual(['video']);
  });

  it('the exemption is SCOPED: it lifts ALL-CAPS on the video brief and NOTHING else there', () => {
    const bad = mut((l) => putOverlay(l, `SHOUTING CARD ${pack.rules.style.bannedSymbols[0]} B0ABCDEFGH`));
    const hits = onField(c17Style(bad, pack), 'videoBrief.onScreenText[0]');
    // symbol + ASIN still fire; the caps do not
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => /sentence case/i.test(h.fix))).toBe(false);
    expect(hits.some((h) => /symbol/i.test(h.fix))).toBe(true);
    expect(hits.some((h) => /ASIN/i.test(h.fix))).toBe(true);
  });

  it('exempting `video` does NOT exempt `images`: ALL-CAPS still fires on ALT text', () => {
    const bad = mut((l) => putAlt(l, 'SHOUTING CARD ON A WHITE BACKGROUND'));
    expect(onField(c17Style(bad, pack), 'imagePlan[0].altText').length).toBeGreaterThan(0);
  });

  it('the BULLET-ONLY rules never reach ALT text or an overlay (they are list-rendering rules)', () => {
    // A trailing full stop and a lowercase opening both FAIL in a bullet...
    const inBullet = mut((l) => { l.bullets[0] = 'lowercase opening with a trailing period.'; });
    const bulletHits = onField(c17Style(inBullet, pack), 'bullets[0]');
    expect(bulletHits.some((h) => /start with a capital/i.test(h.fix))).toBe(true);
    expect(bulletHits.some((h) => /trailing punctuation/i.test(h.fix))).toBe(true);

    // ...and neither is a rule an ALT string or an overlay can break.
    for (const target of TARGETS) {
      const bad = mut((l) => target.put(l, 'lowercase opening with a trailing period.'));
      expect(onField(c17Style(bad, pack), target.field), target.field).toEqual([]);
    }
  });

  it('the pack-SCOPED character and title-term rules do not reach the new groups either', () => {
    // '?' and '$' are bannedChars, scoped by the pack to the title surfaces and
    // bullets. A question mark in an ALT string is ordinary English.
    for (const target of TARGETS) {
      const q = mut((l) => target.put(l, 'What is inside the bottle'));
      expect(onField(c17Style(q, pack), target.field), target.field).toEqual([]);
    }
    expect(pack.rules.style.bannedCharsSurfaces).not.toContain('images');
    expect(pack.rules.style.bannedCharsSurfaces).not.toContain('video');
    expect(pack.rules.style.titleTermBanSurfaces).not.toContain('images');
    expect(pack.rules.style.titleTermBanSurfaces).not.toContain('video');
  });
});

// ===========================================================================
// §4 — THE LAWFUL-COPY REGRESSION BATTERY
// ===========================================================================

/**
 * ORDINARY, LAWFUL COPY IN THE SHAPES THE VERIFIED RUNS ACTUALLY PRODUCE.
 *
 * These are the shapes taken from the deterministic golden fixture (which is
 * modelled on the live-verified probiotic run) plus the two other live
 * registers the repository records — the oral-care listing of B00WNDG7V8 and
 * the potency-bearing overlay of B00EEEITVA. Each one is copy that a run is
 * SUPPOSED to produce, and every one of them must raise nothing from any of the
 * four widened checks.
 *
 * This is the half of the change most likely to go wrong: a rule written for a
 * prose bullet applied to a short display string produces a wave of findings the
 * repair loop cannot clear, which is how a healthy run ends `verified:false` on
 * nothing (the exact live shape recorded as item 10 of CONFORMANCE-DEVIATIONS).
 */
const LAWFUL_ALT: string[] = [
  // --- the golden/probiotic register (all eight slots) ---
  'BrandX Probiotic bottle, 60 vegan capsules, on a plain white background',
  'Infographic: 50 Billion CFU blend of 10 strains, vegan, shelf stable',
  'One capsule beside the bottle, showing the one-a-day routine and 60 count',
  'Ten named probiotic strains with prebiotic fiber and third-party tested badge',
  'Bottle packed into a travel bag, showing the routine continuing on a trip',
  'Photograph of the printed supplement facts panel and ingredient list',
  'Comparison of this shelf stable 10-strain formula against a typical option',
  'Three step routine: one capsule daily with water, stored cool and dry',
  // --- the oral-care register (B00WNDG7V8), including the mandated notice ---
  'Front of the pack showing the mint lozenges and the count',
  'Close view of one lozenge with the ingredient list beside it',
  'Panel photograph showing the daily use direction and the storage note',
  // --- the potency-bearing overlay register (B00EEEITVA) ---
  'Infographic showing the 50 Billion CFU blend attached to the formula',
  'Label photograph with the strain names and the serving size readable',
  // --- shapes that LOOK like violations and are not ---
  'What is inside: ten strains, prebiotic fiber and nothing else',
  'Bottle beside a glass of water, third-party tested and Non-GMO',
  'Front label with CFU, IU and mg figures legible at phone size',
  'IFOS BSCG HACCP SQF certification marks shown as a row of badges',
];

const LAWFUL_OVERLAY: string[] = [
  '50 Billion CFU blend, 10 strains',
  'One capsule daily',
  'Shelf stable, no refrigeration',
  'Vegan, Non-GMO, gluten free',
  'Third-party tested',
  '60 capsules, two month supply',
  'Made in a cGMP facility in the USA',
];

const LAWFUL_SHOTS: string[] = [
  'Open on the bottle in a real kitchen, in frame within the first second',
  'Hand picks up one capsule and takes it with water, in one unbroken shot',
  'Cut to the bottle packed into a travel bag as the routine continues',
  'Close on the front label with the count and the strain number readable',
  'Hold on the printed panel so the serving size and the count are readable',
];

const LAWFUL_NOTES: string[] = [
  'Shot vertical throughout, never cropped from a wide edit. Assume it is watched muted.',
  'No rival brand named anywhere in the frame; no price, badge or call to action on screen.',
  'Keep the overlay text legible at phone size and leave the label unobstructed.',
];

describe('§4 lawful ALT and on-screen copy raises NOTHING from any of the four checks', () => {
  for (const text of LAWFUL_ALT) {
    it(`ALT: ${JSON.stringify(text.slice(0, 58))} passes`, () => {
      const l = mut((x) => {
        // every slot at once, so a rule that fires per-slot cannot hide
        x.imagePlan = x.imagePlan.map((s) => ({ ...s, altText: text }));
      });
      expect(onField(fourChecks(l), 'imagePlan[0].altText')).toEqual([]);
      expect(fourChecks(l).filter((f) => f.field.endsWith('.altText'))).toEqual([]);
    });
  }

  for (const text of LAWFUL_OVERLAY) {
    it(`OVERLAY: ${JSON.stringify(text.slice(0, 58))} passes`, () => {
      const l = mut((x) => { x.videoBrief!.onScreenText = [text, ...x.videoBrief!.onScreenText.slice(1)]; });
      expect(onField(fourChecks(l), 'videoBrief.onScreenText[0]')).toEqual([]);
    });
  }

  for (const text of LAWFUL_SHOTS) {
    it(`SHOT: ${JSON.stringify(text.slice(0, 58))} passes`, () => {
      const l = mut((x) => { x.videoBrief!.shots = [text, ...x.videoBrief!.shots.slice(1)]; });
      expect(onField(fourChecks(l), 'videoBrief.shots[0]')).toEqual([]);
    });
  }

  for (const text of LAWFUL_NOTES) {
    it(`NOTES: ${JSON.stringify(text.slice(0, 58))} passes`, () => {
      const l = mut((x) => { x.videoBrief!.notes = text; });
      expect(onField(fourChecks(l), 'videoBrief.notes')).toEqual([]);
    });
  }

  it('ALL of them at once, through the WHOLE gate, still converges to zero failures', () => {
    const l = mut((x) => {
      x.imagePlan = x.imagePlan.map((s, i) => ({ ...s, altText: LAWFUL_ALT[i % LAWFUL_ALT.length]! }));
      x.videoBrief!.onScreenText = [...LAWFUL_OVERLAY];
      x.videoBrief!.shots = [...LAWFUL_SHOTS];
      x.videoBrief!.notes = LAWFUL_NOTES[0]!;
    });
    const result = runGate(l, pack, ctx);
    expect(
      result.failures.map((f) => `${f.checkId} ${f.field}: ${f.context}`),
      'lawful ALT/overlay copy must never fail the gate',
    ).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the aspect string the brief actually ships passes', () => {
    expect(onField(fourChecks(clean), 'videoBrief.aspect')).toEqual([]);
    for (const aspect of ['9:16 vertical', '9:16', 'vertical 9x16']) {
      const l = mut((x) => { x.videoBrief!.aspect = aspect; });
      expect(onField(fourChecks(l), 'videoBrief.aspect'), aspect).toEqual([]);
    }
  });
});

// ===========================================================================
// §5 — THE C27 ASCII CARVE-OUT DECISION
// ===========================================================================

describe('§5 C27 ASCII: no carve-out for ALT or video, and the backend one is untouched', () => {
  const ACCENT = 'Shot in a café with the bottle in frame';

  it('the pack exempts EXACTLY the two groups whose exemption is argued for, and no others', () => {
    // `backendSearchTerms` — N1, argued below and in the pack comment.
    // `facts` — M1: the ASCII rule's premise (post-fold text) is false for the
    // one group the emit-time fold never touches. Both directions of that
    // decision live in `tests/m1.factsHygiene.gate.test.ts`.
    expect(pack.rules.outputHygiene!.asciiExemptSurfaces).toEqual(['backendSearchTerms', 'facts']);
  });

  it('the backend exemption still holds — a diacritic there IS the query, not a defect', () => {
    const l = mut((x) => { x.backendSearchTerms = 'probiotico acidophilus flóra'; });
    expect(onField(c27OutputHygiene(l, pack), 'backendSearchTerms')).toEqual([]);
  });

  it('...and the PHRASE scans still cover the backend field, so the carve-out is ASCII-only', () => {
    const l = mut((x) => { x.backendSearchTerms = 'probiotic delve acidophilus'; });
    expect(onField(c27OutputHygiene(l, pack), 'backendSearchTerms').length).toBeGreaterThan(0);
  });

  it('ALT text gets NO such carve-out — it is a display string, not a search-index input', () => {
    const l = mut((x) => putAlt(x, ACCENT));
    expect(onField(c27OutputHygiene(l, pack), 'imagePlan[0].altText').length).toBeGreaterThan(0);
  });

  it('nor does any video field — the on-screen string ships, and shots/notes render into it', () => {
    for (const target of TARGETS.filter((t) => t.field.startsWith('videoBrief'))) {
      const l = mut((x) => target.put(x, ACCENT));
      expect(onField(c27OutputHygiene(l, pack), target.field).length, target.field).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// §6 — ROUTING: a new finding is REPAIRABLE, not a round-burning dead end
// ===========================================================================

describe('§6 every newly-scanned field routes to the group that can rewrite it', () => {
  it('routes ALT and every video field to the images group (one call emits both)', () => {
    for (const checkId of ['C17', 'C18', 'C19', 'C27']) {
      for (const target of TARGETS) {
        expect(
          fieldToGroup({ checkId, field: target.field, context: '', fix: '' }),
          `${checkId} ${target.field}`,
        ).toBe('images');
      }
    }
  });

  it('and the fields the gate ACTUALLY emits for planted violations all resolve', () => {
    const bad = mut((l) => {
      putAlt(l, 'Only $19.95 and the best seller \u{1F600}');
      putOverlay(l, 'Look no further, money back guarantee');
      putShot(l, 'Open on brandsite.com in the corner');
      putNotes(l, 'Task: add doctor recommended to the end card');
      putAspect(l, 'Shot in a café');
    });
    const emitted = runGate(bad, pack, ctx).failures.filter(
      (f) => f.field.startsWith('imagePlan[') || f.field.startsWith('videoBrief'),
    );
    expect(emitted.length).toBeGreaterThan(8);
    for (const f of emitted) {
      expect(fieldToGroup(f), `${f.checkId} ${f.field}`).toBe('images');
    }
  });

  it('a run carrying them is NOT verified — the whole point of scanning them', () => {
    const bad = mut((l) => putAlt(l, 'Only $19.95, the best seller, money back guarantee'));
    const result = runGate(bad, pack, ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.field === 'imagePlan[0].altText')).toBe(true);
  });
});

// ===========================================================================
// §7 — NOT VACUOUS: the pre-fix readers, reconstructed
// ===========================================================================

describe('§7 the suite proves it is testing the change', () => {
  /** The `styleSurfaces` result minus everything this change added. */
  const preFixStyleFields = (l: OptimizedListing): string[] =>
    styleSurfaces(l)
      .map((r) => r.field)
      .filter((f) => f !== 'videoBrief.aspect' && f !== 'videoBrief.notes')
      .filter((f) => !f.startsWith('videoBrief.shots['))
      .filter((f) => !f.startsWith('videoBrief.onScreenText['))
      .filter((f) => !/^imagePlan\[\d+\]\.altText$/.test(f));

  it('the pre-fix C17 reader could not see a single field this suite plants into', () => {
    const fields = preFixStyleFields(clean);
    for (const target of TARGETS) {
      expect(fields, target.field).not.toContain(target.field);
    }
    // ...while the post-fix reader sees every one of them
    const now = styleSurfaces(clean).map((r) => r.field);
    for (const target of TARGETS) expect(now).toContain(target.field);
  });

  it('the change ADDED surfaces and removed none — every pre-fix field is still read', () => {
    const now = new Set(styleSurfaces(clean).map((r) => r.field));
    for (const f of preFixStyleFields(clean)) expect(now.has(f), f).toBe(true);
    const nowCollected = new Set(
      collectSurfaces(clean, new Set(COLLECTED_SURFACE_GROUPS), pack.rules.factFields?.price).map(
        (s) => s.field,
      ),
    );
    for (const f of ['title', 'description', 'backendSearchTerms', 'imagePlan[0].notes', 'qa[0].q']) {
      expect(nowCollected.has(f), f).toBe(true);
    }
  });
});
