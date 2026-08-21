import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c19ProhibitedMarketing, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { packPatternSource, phraseSource } from '@/lib/gate/util';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';
import { withCoherentKeywords } from './fixtures/coherentKeywords';

/**
 * THE SEPARATOR BETWEEN THE WORDS OF A PHRASE IS A CLASS, NOT A ROW-BY-ROW HABIT.
 *
 * The M1 round fixed ONE row (`clinically[\s-]+studied`) and its commit body
 * recorded that "every sibling row already spells the separator as a class".
 * THAT WAS FALSE, and adversarial review proved it end-to-end through the real
 * gate: the SPACED form failed and the HYPHENATED form produced ZERO failures
 * from the whole gate for
 *
 *     number one rated / number-one rated
 *     As Seen On TV    / As-Seen-On-TV
 *     limited time offer / limited-time offer
 *     Doctor recommended blend / Doctor-recommended blend
 *
 * `Doctor-recommended` and `limited-time` are the STANDARD spellings in real
 * Amazon listing copy, so this was live exposure rather than a curiosity.
 * `maximum-strength`, `clinically-proven` and `Today-only` were caught only
 * because they ALSO sit in `superlativeBans`, whose separator-STRIPPED variant
 * covers hyphens — an accident of which leg a phrase happened to be filed under.
 *
 * THE FIX IS THE CLASS (`util.PHRASE_JOIN`, `util.phraseSource`,
 * `util.packPatternSource`): wherever a BAN phrase becomes a regex — the
 * pack-authored pattern sources and every check's own ban-lexicon alternation —
 * its words are joined by whitespace OR a hyphen. The generic term compiler is
 * deliberately excluded, because it also answers PRESENCE questions (C28's
 * placement leg) where a wider join is more permissive, not stricter; its ban
 * side is covered by the separator-STRIPPED variant scan, which is exactly why
 * `maximum-strength` was caught all along.
 *
 * This file asserts BOTH directions: the four proven bypasses fail in both
 * spellings, a lawful hyphen battery stays clean, and the sweep test below
 * proves the class covers EVERY pack pattern row rather than the rows someone
 * remembered.
 */

const pack = loadPack('supplements');
const cosmetics = loadPack('cosmetics');
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

const plantInDescription = (text: string): OptimizedListing =>
  mut((l) => { l.description = `${l.description} ${text}.`; });

const c19On = (l: OptimizedListing, p: KnowledgePack = pack) =>
  c19ProhibitedMarketing(l, p).filter((f) => f.field === 'description');

// ===========================================================================
// DIRECTION 1 — the proven bypasses fail in BOTH spellings
// ===========================================================================

/** [spaced form, hyphenated form] — the four spellings review proved. */
const PROVEN_BYPASSES: [string, string][] = [
  ['number one rated', 'number-one rated'],
  ['As Seen On TV', 'As-Seen-On-TV'],
  ['limited time offer', 'limited-time offer'],
  ['Doctor recommended blend', 'Doctor-recommended blend'],
];

/**
 * The three phrases that WERE caught before this fix — by the term leg, not by
 * the pattern leg. They must stay caught, in both spellings.
 */
const ALREADY_CAUGHT: [string, string][] = [
  ['maximum strength', 'maximum-strength'],
  ['clinically proven', 'clinically-proven'],
  ['today only', 'Today-only'],
];

describe('C19 — a hyphen is not a disguise', () => {
  for (const [spaced, hyphenated] of [...PROVEN_BYPASSES, ...ALREADY_CAUGHT]) {
    it(`"${spaced}" fails`, () => {
      expect(c19On(plantInDescription(spaced)).length).toBeGreaterThan(0);
    });
    it(`"${hyphenated}" fails the same way`, () => {
      expect(c19On(plantInDescription(hyphenated)).length).toBeGreaterThan(0);
    });
    it(`"${hyphenated}" makes the WHOLE gate fail`, () => {
      expect(runGate(plantInDescription(hyphenated), pack, ctx).pass).toBe(false);
    });
  }

  it('the cosmetics pack reads the same class', () => {
    expect(c19On(plantInDescription('Doctor-recommended blend'), cosmetics).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// DIRECTION 2 — the OVER-BLOCK direction: a hyphen is meaningful in a compound
// ===========================================================================

/**
 * LAWFUL HYPHENATED COMPOUNDS. Every one of these is ordinary, compliant
 * supplement copy, and widening the word join must not reach a single one of
 * them. `doctor-formulated` is the sharpest of the set: it is one hyphen away
 * from `doctor-recommended`, which is banned, and it must stay clean.
 */
const LAWFUL_BATTERY = [
  'sugar-free',
  'sugar free',
  'non-GMO',
  'non GMO',
  'third-party',
  'third party',
  'time-release',
  'time release',
  'doctor formulated',
  'doctor-formulated',
  'high-potency',
  'high potency',
];

describe('C19/C18 — lawful hyphenated compounds stay clean', () => {
  for (const text of LAWFUL_BATTERY) {
    it(`"${text}" raises no marketing failure`, () => {
      expect(c19On(plantInDescription(text))).toEqual([]);
    });
    it(`"${text}" leaves the whole gate green`, () => {
      expect(runGate(plantInDescription(text), pack, ctx)).toEqual({ pass: true, failures: [] });
    });
  }
});

// ===========================================================================
// THE PACK LIST IS STILL THE LEXICON — emptying it disarms only its own leg
// ===========================================================================

const withoutMarketingPatterns: KnowledgePack = {
  ...pack,
  rules: {
    ...pack.rules,
    prohibitedMarketing: {
      surfaces: pack.rules.prohibitedMarketing?.surfaces ?? [],
      patterns: [],
    },
  },
};

describe('C19 — the pattern list is the lexicon, in both spellings', () => {
  for (const [spaced, hyphenated] of PROVEN_BYPASSES) {
    it(`emptying rules.prohibitedMarketing.patterns disarms "${hyphenated}" (and "${spaced}") — nothing else was catching them`, () => {
      expect(c19On(plantInDescription(spaced), withoutMarketingPatterns)).toEqual([]);
      expect(c19On(plantInDescription(hyphenated), withoutMarketingPatterns)).toEqual([]);
    });
  }

  it('emptying the pattern list leaves the SUPERLATIVE leg armed in both spellings', () => {
    expect(c19On(plantInDescription('maximum strength'), withoutMarketingPatterns).length).toBeGreaterThan(0);
    expect(c19On(plantInDescription('maximum-strength'), withoutMarketingPatterns).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// THE CLASS ITSELF — the rewrite, and the sweep that proves it covers the list
// ===========================================================================

describe('packPatternSource — the rewrite is structural and conservative', () => {
  it('rewrites `\\s`, `\\s+`, `\\s*` and a literal space between words', () => {
    expect(packPatternSource('\\bbuy\\s+now\\b')).toBe('\\bbuy[\\s-]+now\\b');
    expect(packPatternSource('\\$\\s*\\d')).toBe('\\$[\\s-]*\\d');
    expect(packPatternSource('\\bas seen on tv\\b')).toBe('\\bas[\\s-]seen[\\s-]on[\\s-]tv\\b');
    expect(packPatternSource('a\\sb')).toBe('a[\\s-]b');
  });

  it('leaves CHARACTER CLASSES exactly as written', () => {
    expect(packPatternSource('\\b(?:https?://|www\\.)[^\\s]+')).toBe('\\b(?:https?://|www\\.)[^\\s]+');
    expect(packPatternSource('\\(?\\d{3}\\)?[\\s.-]\\d{3}')).toBe('\\(?\\d{3}\\)?[\\s.-]\\d{3}');
    expect(packPatternSource('\\bmoney[- ]back\\b')).toBe('\\bmoney[- ]back\\b');
  });

  it('never re-reads an escaped literal as a metacharacter', () => {
    expect(packPatternSource('a\\\\sb')).toBe('a\\\\sb');
    expect(packPatternSource('\\[at\\]')).toBe('\\[at\\]');
  });

  it('phraseSource joins the words of a literal phrase with the same class', () => {
    expect(phraseSource('medical condition')).toBe('medical[\\s-]+condition');
    expect(phraseSource('cancer')).toBe('cancer');
    expect(phraseSource('5-HTP')).toBe('5-HTP');
  });
});

/**
 * THE SWEEP. Not "these four rows are fixed" — every row of every pack regex
 * list, in every shipped pack, comes out of the compiler with NO bare `\s` and
 * no literal space left outside a character class. This is the assertion the M1
 * record should have had to make before claiming the sweep was done.
 */
const packRegexLists = (p: KnowledgePack): [string, string][] => {
  const cp = p.compliancePack;
  const rows: [string, string][] = [];
  const push = (id: string, sources: unknown[]): void => {
    for (const s of sources) if (typeof s === 'string' && s.trim()) rows.push([id, s]);
  };
  push('rules.prohibitedMarketing.patterns', (p.rules?.prohibitedMarketing?.patterns ?? []).map((r) => r[0]));
  push('rules.prohibitedContent.patterns', (p.rules?.prohibitedContent?.patterns ?? []).map((r) => r[0]));
  push('compliancePack.semanticDrugClaims.patterns', (cp?.semanticDrugClaims?.patterns ?? []).map((r) => r[0]));
  push('compliancePack.substantiationTokens', (cp?.substantiationTokens ?? []).map((r) => r[0]));
  push('compliancePack.allergenRules[].source', (cp?.allergenRules ?? []).map((r) => r.source));
  return rows;
};

/** A bare `\s` or literal space OUTSIDE a character class — the bypass shape. */
function bareWordJoins(source: string): string[] {
  const found: string[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\\') {
      if (!inClass && source[i + 1] === 's') found.push(`\\s@${i}`);
      i += 1;
      continue;
    }
    if (!inClass && ch === '[') inClass = true;
    else if (inClass && ch === ']') inClass = false;
    else if (!inClass && ch === ' ') found.push(`space@${i}`);
  }
  return found;
}

describe('the sweep — every pack regex row, not the rows someone remembered', () => {
  it('the detector itself sees the bypass shape it is looking for', () => {
    expect(bareWordJoins('\\blimited\\s+time\\b')).toEqual(['\\s@9']);
    expect(bareWordJoins('\\bas seen on tv\\b')).toHaveLength(3);
    expect(bareWordJoins('\\bmoney[- ]back\\b')).toEqual([]);
  });

  for (const [packName, p] of [['supplements', pack], ['cosmetics', cosmetics]] as const) {
    for (const [listId, source] of packRegexLists(p)) {
      it(`${packName} — ${listId}: ${source.slice(0, 44)} carries no bare word join once compiled`, () => {
        expect(bareWordJoins(packPatternSource(source))).toEqual([]);
      });
    }
  }
});
