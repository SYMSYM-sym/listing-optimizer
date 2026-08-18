import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { c19ProhibitedMarketing } from '@/lib/gate/checks/c-prohibited';
import { a8AplusProhibitedMarketing } from '@/lib/gate/checks/a-aplus';
import { prohibitedMarketingPatterns } from '@/lib/gate/checks/shared';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';
import { withCoherentKeywords } from './fixtures/coherentKeywords';

/**
 * AC-G1 — THE THREE PROHIBITED-MARKETING CLAIMS THAT SHIPPED CLEAN.
 *
 * An independent acceptance audit ran three claims through the REAL `runGate`
 * and got ZERO failures on each:
 *
 *   1. `"Rated 4.8 stars by our customers"` — the star pattern was `star\b`,
 *      so only the SINGULAR spelling was caught.
 *   2. `"Over 4000 five star reviews across our range"` and
 *      `"Over four thousand five star reviews"` — `star reviews` is not
 *      `reviews`, and `four thousand` is not `[\d,]+`.
 *   3. `"Amazon's Choice for probiotics"` — no pattern and no superlative ban.
 *
 * All three were PACK-DATA gaps, not engine defects, and all three are closed
 * in `knowledge/rules.json → prohibitedMarketing.patterns` (which every
 * category pack shares — see the cosmetics suite below).
 *
 * BOTH DIRECTIONS ARE PINNED HERE, in one file, deliberately. `star` and
 * `review` are ordinary words in lawful supplement copy, so a widening of
 * these two patterns is exactly as likely to produce a wall as it is to close
 * a bypass, and this project treats over-blocking as the same severity as a
 * bypass. The lawful battery below is larger than the bypass battery for that
 * reason.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const cosmeticsPack = loadPack('cosmetics');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return withCoherentKeywords(withCoherentBulletFlags(copy));
};

/** A deep, cache-free clone of a pack so emptying a piece cannot leak. */
const clonePack = (p: KnowledgePack): KnowledgePack => JSON.parse(JSON.stringify(p)) as KnowledgePack;

/**
 * The planting surfaces. Each is chosen so that NO unrelated rule can fire on
 * the planted field (the Q&A answer is marked non-claim-bearing, the attribute
 * is free text, the A+ FAQ answer is non-claim-bearing), which is what lets the
 * lawful direction assert an EMPTY failure list rather than "no C19".
 */
type Surface = {
  readonly label: string;
  readonly plant: (l: OptimizedListing, s: string) => void;
  /**
   * The A+ FAQ is scanned by BOTH halves of the same lexicon and they name the
   * field differently — C19 reports `aplus.faq[0]`, A8 reports
   * `aplus.faq[0].a`. A surface therefore matches by PREFIX, or the lawful
   * direction would assert "zero failures" against only half the checks that
   * actually ran on the string.
   */
  readonly owns: (field: string) => boolean;
};

const SURFACES: Surface[] = [
  {
    label: 'qa[0].a',
    plant: (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; },
    owns: (f) => f === 'qa[0].a' || f === 'qa[0]',
  },
  {
    label: 'attributes.special_ingredients',
    plant: (l, s) => { l.attributes.special_ingredients = s; },
    owns: (f) => f === 'attributes.special_ingredients',
  },
  {
    label: 'aplus.faq[0].a',
    plant: (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: s, claimBearing: false }; },
    owns: (f) => f === 'aplus.faq[0]' || f === 'aplus.faq[0].a',
  },
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

const onSurface = (l: OptimizedListing, s: Surface): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => s.owns(f.field));

/** The two halves of the ONE prohibited-marketing lexicon. */
const MARKETING = new Set(['C19', 'A8']);

// ===========================================================================
// DIRECTION 1 — the three reported misses now FAIL through the real gate
// ===========================================================================

/** The auditor's exact strings, verbatim. */
const REPORTED_MISSES: [string, string][] = [
  ['Rated 4.8 stars by our customers', 'miss 1 — plural star rating'],
  ['Over 4000 five star reviews across our range', 'miss 2 — word-form star + digit count'],
  ['Over four thousand five star reviews', 'miss 2 — fully word-form review count'],
  ["Amazon's Choice for probiotics", 'miss 3 — marketplace badge claim'],
];

describe('AC-G1 direction 1 — the three reported misses now fail C19', () => {
  for (const [text, why] of REPORTED_MISSES) {
    for (const surface of SURFACES) {
      it(`"${text}" (${why}) fails the marketing lexicon on ${surface.label}`, () => {
        const l = mut((x) => surface.plant(x, text));
        const hits = onSurface(l, surface).filter((f) => MARKETING.has(f.checkId));
        expect(hits.length).toBeGreaterThan(0);
      });
    }
  }

  it('the singular form the auditor used as the CONTROL still fails', () => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: 'Rated 4.8 star by our customers', claimBearing: false }; });
    expect(onField(l, 'qa[0].a').some((f) => f.checkId === 'C19')).toBe(true);
  });

  it('the digit review count the auditor used as the CONTROL still fails', () => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: 'Over 4,000 reviews', claimBearing: false }; });
    expect(onField(l, 'qa[0].a').some((f) => f.checkId === 'C19')).toBe(true);
  });
});

/**
 * The FORM matrix: singular/plural, spaced/hyphenated, digit/word, and the
 * two context directions of the word-form rating ("rated <n> stars" and
 * "<n> star review").
 */
describe('AC-G1 direction 1 — every form of the same claim fails', () => {
  const FORMS = [
    'Rated 4.8 star by our customers',
    'Rated 4.8 stars by our customers',
    'Rated 4.8-star by our customers',
    'Rated 4.8-stars by our customers',
    'Rated 4.8stars by our customers',
    'A 5 star product',
    'A 5-stars product',
    'Rated five stars by our customers',
    'Rated five star by shoppers',
    'Rated five-stars by shoppers',
    'Five star reviews from our community',
    'Five star rating from our community',
    'Five-star average across the range',
    'Over 4,000 reviews',
    'Over 4000 customer reviews',
    'Over 4000 five star reviews across our range',
    'Over four thousand five star reviews',
    'Over four thousand reviews',
    'A hundred reviews and counting',
    'Twenty five reviews this month',
  ];
  it.each(FORMS)('"%s" fails C19', (text) => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: text, claimBearing: false }; });
    expect(onField(l, 'qa[0].a').some((f) => f.checkId === 'C19')).toBe(true);
  });
});

/**
 * The BADGE/RANK family. Three of these were ALREADY covered by patterns that
 * shipped — they are asserted here so a future narrowing of the star/review
 * patterns cannot quietly take them with it — and three are new.
 */
describe('AC-G1 direction 1 — the badge / rank / deal family', () => {
  const BADGES: [string, string][] = [
    ["Amazon's Choice for probiotics", 'new — marketplace badge'],
    ['Amazon Choice for probiotics', 'new — badge without the possessive'],
    ['Amazons Choice for probiotics', 'new — badge with a bare plural s'],
    ["Editor's Choice award winner", 'new — editorial award'],
    ['Editors Choice award winner', 'new — editorial award, no possessive'],
    ['Prime Day deal live now', 'new — marketplace deal event'],
    ['Lightning Deal available today', 'new — marketplace deal event'],
    ['Deal of the Day pick', 'new — marketplace deal event'],
    ['Best Seller badge winner', 'already covered by the best-seller pattern'],
    ['#1 New Release in probiotics', 'already covered by the #1 pattern'],
    ['Our top-rated formula', 'already covered by the ranking pattern'],
  ];
  it.each(BADGES)('"%s" fails C19 (%s)', (text) => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: text, claimBearing: false }; });
    expect(onField(l, 'qa[0].a').some((f) => f.checkId === 'C19')).toBe(true);
  });
});

/**
 * A8 is the A+ half of the SAME pack lexicon. It reads the pattern list through
 * the same `prohibitedMarketingPatterns` helper, so the word-form macro must be
 * expanded for it too — a helper wired into only one of the two checks would
 * leave the A+ module body open to exactly the claims C19 now catches.
 */
describe('AC-G1 direction 1 — A8 enforces the identical lexicon on A+ modules', () => {
  it.each([
    'Rated 4.8 stars by our customers',
    'Over four thousand five star reviews',
    "Amazon's Choice for probiotics",
  ])('"%s" fails A8 in an A+ module body', (text) => {
    const l = mut((x) => { x.aplusContent.modules[0]!.body = text; });
    expect(a8AplusProhibitedMarketing(l, pack).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// DIRECTION 2 — the lawful battery. Over-blocking is the real risk here.
// ===========================================================================

/**
 * Every string is ordinary, lawful supplement copy. `star` and `review` carry
 * their ordinary English senses throughout: the spice (star anise), the
 * metaphor (the star ingredient), the process noun (our review process) and the
 * scholarly participle (peer-reviewed). None of them is a rating, a count or a
 * badge, and NONE may produce a single failure on ANY surface.
 *
 * The first seven are the auditor's own list; the rest are this suite's.
 */
const LAWFUL: [string, string][] = [
  ['five star anise', 'auditor — the spice, in word form'],
  ['our review process', 'auditor — process noun'],
  ['reviewed by a nutritionist', 'auditor — participle, no count'],
  ['star ingredient', 'auditor — metaphor'],
  ['the star of the formula', 'auditor — metaphor'],
  ['peer-reviewed research', 'auditor — scholarly participle'],
  ['third-party reviewed', 'auditor — scholarly participle'],
  ['Star anise and fennel seed in a warming blend', 'the spice, sentence-initial'],
  ['Our five star anise blend is a house favourite', 'word-form number + the spice'],
  ['Two star anise pods per batch', 'word-form number + the spice, plural noun'],
  ['The star of the formula is a live culture blend', 'metaphor, full sentence'],
  ['An all star ingredient panel', 'metaphor, hyphen-free compound'],
  ['Star fruit powder and five star anise', 'two ordinary star compounds together'],
  ['Reviewed by our in-house nutritionist before release', 'participle + agent'],
  ['Peer reviewed research supports this strain', 'participle, unhyphenated'],
  ['Third party reviewed for purity and identity', 'participle, unhyphenated'],
  ['Our review process takes four weeks', 'process noun + an unrelated number word'],
  ['Read the reviews on the brand website', 'plural noun with NO count'],
  ['Customer reviews are moderated by the brand', '"customer reviews" with NO count'],
  ['One review per household', 'singular noun after a number word'],
  ['Take one capsule daily with food', 'number word, ordinary dosage prose'],
  ['A hundred percent plant based capsule shell', 'number word, ordinary label prose'],
  ['Formulated in a five step process', 'number word, ordinary process prose'],
  ['Five strains of live cultures', 'number word, ordinary panel prose'],
  ['Sixty capsules per bottle', 'number word, ordinary count prose'],
  ['Thirty day supply per bottle', 'number word, ordinary supply prose'],
  ['Prime quality botanical ingredients', '"prime" without "day"'],
  ['We deal with our growers directly', '"deal" without the badge phrase'],
  ['Amazon rainforest sourced botanicals', '"amazon" without "choice"'],
  ['The editor of our newsletter is a dietitian', '"editor" without "choice"'],
  ['Choice of two flavours', '"choice" without a badge owner'],
  ['Rated by an independent laboratory', '"rated" without a star figure'],
];

describe('AC-G1 direction 2 — lawful copy is never blocked', () => {
  for (const [text, why] of LAWFUL) {
    for (const surface of SURFACES) {
      it(`"${text}" (${why}) is clean on ${surface.label}`, () => {
        const l = mut((x) => surface.plant(x, text));
        expect(onSurface(l, surface)).toEqual([]);
      });
    }
  }

  it('the whole lawful battery in one listing still leaves the gate green', () => {
    const l = mut((x) => {
      x.qa = LAWFUL.map(([text]) => ({ q: 'What should I know?', a: text, claimBearing: false }));
      x.aplusContent.faq = LAWFUL.slice(0, 5).map(([text]) => ({
        q: 'What should I know?',
        a: text,
        claimBearing: false,
      }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('THE GOLDEN FIXTURE ITSELF is untouched — zero gate failures, nothing weakened', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

// ===========================================================================
// THE COSMETICS PACK — the same patterns, with no second edit
// ===========================================================================

/**
 * `prohibitedMarketing.patterns` lives in `knowledge/rules.json`, which EVERY
 * category pack loads; only `superlativeBans` is per-category. Putting the
 * badge and rating patterns in the shared rules file is therefore what makes
 * "does cosmetics need the same additions?" answerable with "it already has
 * them" — and this suite is the assertion, so a future move of these patterns
 * into a per-category compliance file cannot silently drop cosmetics.
 */
describe('AC-G1 — the cosmetics pack inherits the same lexicon', () => {
  it.each([
    'Rated 4.8 stars by our customers',
    'Over four thousand five star reviews',
    "Amazon's Choice for moisturisers",
    'Prime Day deal live now',
  ])('"%s" fails C19 on the cosmetics pack', (text) => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: text, claimBearing: false }; });
    expect(c19ProhibitedMarketing(l, cosmeticsPack).some((f) => f.field === 'qa[0].a')).toBe(true);
  });

  it.each(['five star anise', 'our review process', 'star ingredient', 'peer-reviewed research'])(
    '"%s" is clean on the cosmetics pack too',
    (text) => {
      const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: text, claimBearing: false }; });
      expect(c19ProhibitedMarketing(l, cosmeticsPack).filter((f) => f.field === 'qa[0].a')).toEqual([]);
    },
  );
});

// ===========================================================================
// PACK-PIECE DISARMAMENT — emptying a list disarms ONLY what it should
// ===========================================================================

/**
 * THE `REQUIRED_PACK_PIECES` DECISION.
 *
 * `rules.prohibitedMarketing.patterns` is ALREADY a manifest row, and these
 * three fixes are entries in that same list, so they need no new row: empty the
 * list and the pack-integrity check fails the pack closed exactly as it did
 * before.
 *
 * The word-form vocabulary the `{{numberWord}}` macro reads
 * (`rules.attributeGuard.spelledOutNumbers`) is deliberately NOT a manifest row
 * and is not made one here, on the reasoning that list already documents for
 * C24/C12/C10/A5: emptying it RESTORES exact digit-anchored behaviour rather
 * than disarming a check. The assertions below are that claim, tested — with
 * the vocabulary gone the three word-form patterns withdraw and every
 * digit-anchored pattern in the same list keeps working.
 */
describe('AC-G1 — emptying a pack list disarms only what it should', () => {
  const c19With = (p: KnowledgePack, text: string): Failure[] => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: text, claimBearing: false }; });
    return c19ProhibitedMarketing(l, p).filter((f) => f.field === 'qa[0].a');
  };

  it('emptying prohibitedMarketing.patterns disarms every pattern leg (and the manifest catches it)', () => {
    const p = clonePack(pack);
    p.rules.prohibitedMarketing!.patterns = [];
    for (const text of ['Rated 4.8 stars by our customers', "Amazon's Choice for probiotics", 'Over 4,000 reviews']) {
      expect(c19With(p, text)).toEqual([]);
    }
  });

  it('emptying spelledOutNumbers.cardinals withdraws ONLY the word-form leg', () => {
    const p = clonePack(pack);
    p.rules.attributeGuard!.spelledOutNumbers = { cardinals: {}, magnitudes: {} };
    // The word leg is gone...
    expect(c19With(p, 'Over four thousand reviews')).toEqual([]);
    expect(c19With(p, 'Rated five stars by our customers')).toEqual([]);
    // ...and every DIGIT-anchored pattern in the same list is untouched.
    expect(c19With(p, 'Rated 4.8 stars by our customers').length).toBeGreaterThan(0);
    expect(c19With(p, 'Over 4,000 reviews').length).toBeGreaterThan(0);
    expect(c19With(p, "Amazon's Choice for probiotics").length).toBeGreaterThan(0);
  });

  it('deleting spelledOutNumbers entirely behaves the same way (no crash, no widening)', () => {
    const p = clonePack(pack);
    delete p.rules.attributeGuard!.spelledOutNumbers;
    expect(c19With(p, 'Over four thousand reviews')).toEqual([]);
    expect(c19With(p, 'Over 4,000 reviews').length).toBeGreaterThan(0);
  });

  it('an unexpanded macro never reaches a compiled regex', () => {
    const expanded = prohibitedMarketingPatterns(pack).map(([source]) => source);
    expect(expanded.some((s) => s.includes('{{numberWord}}'))).toBe(false);
    // ...and the pack really does declare the macro, so the assertion above is
    // not vacuous.
    expect(
      (pack.rules.prohibitedMarketing?.patterns ?? []).some(([s]) => s.includes('{{numberWord}}')),
    ).toBe(true);
  });

  it('a pack with no macro at all gets its OWN array back, untouched', () => {
    const p = clonePack(pack);
    p.rules.prohibitedMarketing!.patterns = [['\\bhurry\\b', 'urgency']];
    expect(prohibitedMarketingPatterns(p)).toBe(p.rules.prohibitedMarketing!.patterns);
  });
});
