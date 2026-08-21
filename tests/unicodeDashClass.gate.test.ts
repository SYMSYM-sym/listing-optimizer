import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c19ProhibitedMarketing, c27OutputHygiene, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { normalize } from '@/lib/gate/util';
import { toAsciiTypography } from '@/lib/engine/typography';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';
import { withCoherentKeywords } from './fixtures/coherentKeywords';

/**
 * ROUND R — THE HYPHEN CLASS ROUND P RELIED ON WAS SPELLED TWICE, DIFFERENTLY.
 *
 * Round P made the word JOIN of a banned phrase a class (`PHRASE_JOIN`,
 * `[\s-]+`), so `limited-time offer` fails like `limited time offer`. That leg
 * only ever sees an ASCII `-`, because every C18/C19 scan runs on `normalize()`d
 * text — so what it can actually READ as a hyphen is whatever `normalize`'s dash
 * fold happens to list.
 *
 * IT LISTED FIVE OF EIGHT. `normalize` folded U+2011/U+2013/U+2014/U+2015/U+2212
 * and NOT U+2010 HYPHEN, U+2012 FIGURE DASH or U+2043 HYPHEN BULLET, and none of
 * those three sits in any separator class either. `lib/engine/typography.ts`
 * folds SEVEN (U+2010-U+2015 and U+2212) — a different set, neither derived from
 * the other. Exactly the "class written twice" defect round P fixed one level up.
 *
 * WHAT THAT ACTUALLY COST, measured through `runGate` before the fix:
 *
 * | join                | `description`                 | `backendSearchTerms`     |
 * |---------------------|-------------------------------|--------------------------|
 * | U+2013 / U+2014 ... | C19 + C27, gate FAILS         | C19, gate FAILS          |
 * | U+2010 / U+2012     | C27 only, gate FAILS          | **gate PASSES, 0 fails** |
 * | U+2043              | C27 only, gate FAILS          | **gate PASSES, 0 fails** |
 *
 * So the reviewer's report was RIGHT about the customer-visible surfaces and one
 * surface short of the whole picture: C27's pure-ASCII rule does catch all three
 * on every visible surface, but `backendSearchTerms` and `facts` are ASCII-EXEMPT
 * (`rules.outputHygiene.asciiExemptSurfaces`) — and C18/C19 STILL DECLARE
 * `backendSearchTerms`. A prohibited marketing phrase there is a failure this
 * project has always claimed to catch, and joined by one of those three dashes it
 * shipped clean. U+2043 was live end to end: the engine's emit-time fold does not
 * touch it either, so nothing in the pipeline turned it back into a hyphen.
 *
 * THE FIX is one class in one place: `DASH_FOLD_RE` in `lib/gate/util.ts` now
 * covers every hyphen-like dash the engine folds PLUS U+2043. The CHECKER folding
 * at least as much as the WORKER is the safe direction, and it is a pure
 * narrowing — the folded form matches exactly what the plain ASCII `-` spelling
 * already matched, which §3 below asserts on the lawful battery.
 *
 * THIS FILE PINS BOTH DIRECTIONS AND THE COVERAGE STORY ITSELF, so that the
 * sentence in CONFORMANCE-DEVIATIONS.md §22.2.1 cannot drift away from the code:
 * §1 the fold class, §2 the ban direction on a visible and an exempt surface,
 * §3 the over-block direction, §4 which surfaces are ASCII-exempt and what
 * carries the load on them.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
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

const u = (ch: string): string => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The three `normalize` did NOT fold, and no separator class held either. These
 * are the round's subject.
 */
const NEWLY_FOLDED = ['‐', '‒', '⁃'];

/** The five `normalize` already folded — C19 caught these all along. */
const ALREADY_FOLDED = ['‑', '–', '—', '―', '−'];

const ALL_DASHES = [...NEWLY_FOLDED, ...ALREADY_FOLDED];

/** A row of `rules.prohibitedMarketing.patterns`, in its hyphenated spelling. */
const BAN = (join: string): string => `limited${join}time offer`;

/** Ordinary compliant copy that is hyphenated in its standard spelling. */
const LAWFUL = (join: string): string[] => [
  `sugar${join}free`,
  `third${join}party`,
  `doctor${join}formulated`,
  `time${join}release`,
];

const onField = (fs: Failure[], field: string): Failure[] => fs.filter((f) => f.field === field);

// ===========================================================================
// §1 — THE FOLD CLASS ITSELF
// ===========================================================================

describe('§1 normalize folds the whole hyphen/dash class', () => {
  for (const d of ALL_DASHES) {
    it(`${u(d)} folds to ASCII '-'`, () => {
      expect(normalize(`limited${d}time`)).toBe('limited-time');
    });
  }

  it('the gate fold is a SUPERSET of the engine fold — the checker never reads less than the worker wrote', () => {
    // Every character the engine turns into '-' at emit must also be a '-' to
    // the gate. The reverse is allowed (U+2043 is folded here and not there).
    for (let cp = 0x2000; cp <= 0x30ff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (toAsciiTypography(ch) !== '-') continue;
      expect(normalize(`a${ch}b`), `${u(ch)} folded by the engine but not by the gate`).toBe('a-b');
    }
  });

  it('U+2043 is the one the ENGINE does not fold either — it was live end to end', () => {
    expect(toAsciiTypography('a⁃b')).toBe('a⁃b');
    expect(normalize('a⁃b')).toBe('a-b');
  });

  it('a dash that is NOT an intra-word hyphen is deliberately left alone', () => {
    // U+2E3A TWO-EM DASH: not how Latin copy writes a hyphen, so it stays
    // non-ASCII and C27 reports it on every visible surface.
    expect(normalize('a⸺b')).toBe('a⸺b');
  });
});

// ===========================================================================
// §2 — THE BAN DIRECTION, on a VISIBLE surface and on the ASCII-EXEMPT one
// ===========================================================================

const inDescription = (text: string): OptimizedListing =>
  mut((l) => { l.description = `${l.description} A ${text} today.`; });

const inBackend = (text: string): OptimizedListing =>
  mut((l) => { l.backendSearchTerms = `${l.backendSearchTerms} ${text}`; });

describe('§2 a banned phrase joined by any of these dashes fails', () => {
  for (const d of ALL_DASHES) {
    it(`${u(d)} — "${BAN(d)}" fails C19 on the visible surface (description)`, () => {
      expect(onField(c19ProhibitedMarketing(inDescription(BAN(d)), pack), 'description').length)
        .toBeGreaterThan(0);
    });

    it(`${u(d)} — the visible surface ALSO fails C27's pure-ASCII rule, and the whole gate fails`, () => {
      const l = inDescription(BAN(d));
      const ascii = onField(c27OutputHygiene(l, pack), 'description')
        .filter((f) => f.context.startsWith('non-ASCII'));
      expect(ascii.length).toBe(1);
      expect(ascii[0]!.context).toContain(u(d));
      expect(runGate(l, pack, ctx).pass).toBe(false);
    });

    it(`${u(d)} — "${BAN(d)}" fails C19 on the ASCII-EXEMPT backendSearchTerms, where C27 cannot help`, () => {
      const l = inBackend(BAN(d));
      // The exemption is real: C27 raises NO non-ASCII finding here.
      expect(
        onField(c27OutputHygiene(l, pack), 'backendSearchTerms')
          .filter((f) => f.context.startsWith('non-ASCII')),
      ).toEqual([]);
      // …so C19 is the ONLY thing standing between this and the feed.
      expect(onField(c19ProhibitedMarketing(l, pack), 'backendSearchTerms').length).toBeGreaterThan(0);
      expect(runGate(l, pack, ctx).pass).toBe(false);
    });
  }

  it('the spaced and plain-ASCII spellings still fail, unchanged', () => {
    for (const join of [' ', '-']) {
      expect(onField(c19ProhibitedMarketing(inDescription(BAN(join)), pack), 'description').length)
        .toBeGreaterThan(0);
      expect(runGate(inBackend(BAN(join)), pack, ctx).pass).toBe(false);
    }
  });
});

// ===========================================================================
// §3 — THE OVER-BLOCK DIRECTION
// ===========================================================================

/**
 * A hyphen is how English WRITES a compound. Widening the fold must not reach a
 * single lawful one, in ANY of its dash spellings.
 *
 * The assertion is made on `backendSearchTerms` on purpose: it is the
 * ASCII-EXEMPT surface, so the whole gate can be required to come back GREEN
 * with a non-ASCII dash still sitting in the text. On a visible surface C27
 * would fail the raw character no matter what the fold does, which would prove
 * nothing about over-blocking.
 *
 * The plain ASCII `-` is the control: every dash spelling must land exactly
 * where it lands. The SPACE spelling is deliberately not in this list — on this
 * surface `sugar free` is two tokens and C16 fails the second one for repeating
 * a title word, which is a true finding about backend terms and has nothing to
 * do with the dash class. Its spaced/ASCII behaviour is covered on `description`
 * by `tests/separatorClass.hyphen.gate.test.ts`.
 */
describe('§3 lawful hyphenated compounds stay clean in every dash spelling', () => {
  for (const d of [...ALL_DASHES, '-']) {
    for (const text of LAWFUL(d)) {
      it(`${u(d) === 'U+002D' ? 'ASCII -' : u(d)} — "${text}" leaves the whole gate green on backendSearchTerms`, () => {
        expect(runGate(inBackend(text), pack, ctx)).toEqual({ pass: true, failures: [] });
      });
    }
  }

  it('`doctor-formulated` is one hyphen from the banned `doctor-recommended`, in every spelling', () => {
    for (const d of ALL_DASHES) {
      expect(onField(c19ProhibitedMarketing(inBackend(`doctor${d}formulated`), pack), 'backendSearchTerms'))
        .toEqual([]);
      expect(onField(c19ProhibitedMarketing(inBackend(`doctor${d}recommended`), pack), 'backendSearchTerms').length)
        .toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// §4 — WHICH SURFACES ARE ASCII-EXEMPT, AND WHAT WOULD CHANGE IF THAT WIDENED
// ===========================================================================

describe('§4 the ASCII exemption is exactly two groups, and C18/C19 carry those groups alone', () => {
  it('`asciiExemptSurfaces` is exactly backendSearchTerms and facts', () => {
    // If a group is EVER added here, C27's ASCII rule stops covering it and the
    // phrase legs (C18/C19 — and only for the groups those two declare) become
    // the sole cover, exactly as §2's backendSearchTerms case shows. That is the
    // sentence CONFORMANCE-DEVIATIONS.md §22.2.1 is tied to.
    expect([...(pack.rules.outputHygiene?.asciiExemptSurfaces ?? [])].sort())
      .toEqual(['backendSearchTerms', 'facts']);
  });

  it('C19 declares backendSearchTerms, so the phrase leg really is the cover there', () => {
    expect(pack.rules.prohibitedMarketing?.surfaces ?? []).toContain('backendSearchTerms');
  });

  it('a non-ASCII character that is NOT a banned phrase is reported on a visible surface and exempt on backendSearchTerms', () => {
    const word = 'café';
    const visible = onField(c27OutputHygiene(inDescription(word), pack), 'description')
      .filter((f) => f.context.startsWith('non-ASCII'));
    expect(visible.length).toBe(1);
    expect(onField(c27OutputHygiene(inBackend(word), pack), 'backendSearchTerms')
      .filter((f) => f.context.startsWith('non-ASCII'))).toEqual([]);
  });

  it('`facts` is exempt from the ASCII rule too — and the phrase legs still read it', () => {
    const withFact = mut((l) => { l.facts = { ...l.facts, servingSize: 'café chew' }; });
    expect(onField(c27OutputHygiene(withFact, pack), 'facts.servingSize')
      .filter((f) => f.context.startsWith('non-ASCII'))).toEqual([]);
    const bannedFact = mut((l) => { l.facts = { ...l.facts, servingSize: BAN('⁃') }; });
    expect(onField(c19ProhibitedMarketing(bannedFact, pack), 'facts.servingSize').length).toBeGreaterThan(0);
  });
});
