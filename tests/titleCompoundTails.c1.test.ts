import { describe, expect, it } from 'vitest';
import { REQUIRED_PACK_PIECES } from '@/lib/gate/checks';
import {
  c1TitleLength,
  titleContentTokens,
  titleRepetitionCounts,
} from '@/lib/gate/checks/c-length';
import { buildSystemPrompt } from '@/lib/engine/prompts';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';

/**
 * C1 COMPOUND TAILS — THE B00EEEITVA OVER-BLOCK, ASSERTED IN BOTH DIRECTIONS.
 *
 * The live run failed on ONE finding and the repair loop could not converge:
 *
 *   C1 | title | 'free' x3
 *       FIX: No word may appear more than 2x in the title — replace the repeats
 *            of 'free' with distinct keywords
 *
 * The copy was lawful, and the proof is a hyphen: `titleContentTokens` keeps a
 * hyphen INSIDE a token, so the space-written diet-claim list tokenizes to
 * `gluten|free|dairy|free|soy|free` and the hyphen-written one tokenizes to
 * three distinct compounds. Identical meaning, opposite verdicts. Both spellings
 * are measured below rather than asserted from memory.
 *
 * The exemption is a WIDENER and a narrow one: the head word, a repeated
 * compound, a bare tail and a tail-after-a-tail all still count, and emptying
 * `compoundTails` restores the exact pre-fix arithmetic (§4).
 */

const pack = loadPack('supplements');
const repetition = pack.rules.titleWordRepetition;

const listing = (title: string): OptimizedListing => ({ title }) as unknown as OptimizedListing;
const c1 = (title: string, p: KnowledgePack = pack): string[] =>
  c1TitleLength(listing(title), p).map((f) => f.context);

/** The pack with the exemption emptied — i.e. exactly the pre-fix gate. */
const emptied = (): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
  p.rules.titleWordRepetition.compoundTails = [];
  return p;
};

// ===========================================================================
// 0 — THE PACK SHIPS THE TAIL, AND THE TOKENIZER STILL SPLITS THE TWO SPELLINGS
// ===========================================================================

describe('C1 tails — the measured premise', () => {
  it('the shipped pack lists the tail and keeps the cap at 2 (NOT a cap raise)', () => {
    expect(repetition.compoundTails).toContain('free');
    expect(repetition.max).toBe(2);
  });

  it('the space-written list really does tokenize to a triple tail', () => {
    expect(titleContentTokens('Gluten Free, Dairy Free, Soy Free', repetition.stopwords)).toEqual([
      'gluten', 'free', 'dairy', 'free', 'soy', 'free',
    ]);
  });

  it('the hyphen-written list really does tokenize to three distinct compounds', () => {
    expect(titleContentTokens('Gluten-Free, Dairy-Free, Soy-Free', repetition.stopwords)).toEqual([
      'gluten-free', 'dairy-free', 'soy-free',
    ]);
  });
});

// ===========================================================================
// 1 — THE LIVE SHAPE PASSES, AND SO DOES THE SPELLING THAT ALWAYS PASSED
// ===========================================================================

describe('C1 tails — the lawful shapes pass', () => {
  it('PASSES: the live shape, space-written', () => {
    expect(c1('BrandX Daily Blend, Gluten Free, Dairy Free, Soy Free, 60 Count')).toEqual([]);
  });

  it('PASSES: the same claims hyphen-written (unchanged behaviour)', () => {
    expect(c1('BrandX Daily Blend, Gluten-Free, Dairy-Free, Soy-Free, 60 Count')).toEqual([]);
  });

  it('the two spellings now agree — which is the whole point of the fix', () => {
    expect(c1('Gluten Free, Dairy Free, Soy Free')).toEqual(
      c1('Gluten-Free, Dairy-Free, Soy-Free'),
    );
  });
});

// ===========================================================================
// 2 — THE OTHER DIRECTION: EVERY CARVE-OUT STILL FAILS
// ===========================================================================

describe('C1 tails — the exemption is narrow and the stuffing shapes still FAIL', () => {
  it("FAILS on the HEAD: 'Gluten Free' three times is caught on 'gluten'", () => {
    expect(c1('Gluten Free Gluten Free Gluten Free Blend')).toContain("'gluten' x3");
  });

  it('FAILS on a REPEATED COMPOUND: the tail is counted the second time round', () => {
    // Three heads, each written twice: every head sits at the cap, so the only
    // thing that can fail is the tail — and it does, because the second
    // occurrence of each compound is a repeat rather than a new claim.
    const fs = c1('Gluten Free Dairy Free Soy Free Gluten Free Dairy Free Soy Free');
    expect(fs).toContain("'free' x3");
    expect(fs).not.toContain("'gluten' x3");
  });

  it('FAILS on a BARE tail with no head at all', () => {
    expect(c1('Free Free Free Blend')).toContain("'free' x3");
  });

  it('FAILS when the tail’s head is ITSELF a tail', () => {
    expect(c1('Gluten Free Free, Dairy Free Free, Soy Free Free')).toContain("'free' x3");
  });

  it('FAILS on an ordinary word repeated three times (the rule is untouched)', () => {
    expect(c1('Probiotic Probiotic Probiotic Blend')).toContain("'probiotic' x3");
  });

  it('FAILS on an ordinary word even while a lawful tail list sits beside it', () => {
    expect(c1('Probiotic Probiotic Probiotic, Gluten Free, Dairy Free, Soy Free')).toContain(
      "'probiotic' x3",
    );
  });
});

// ===========================================================================
// 3 — THE TAIL BUYS NOTHING FOR THE WORDS AROUND IT
// ===========================================================================

describe('C1 tails — the head is counted exactly as before', () => {
  it('counts the head on every occurrence', () => {
    const counts = titleRepetitionCounts('Gluten Free Gluten Free Dairy Free', repetition);
    expect(counts.get('gluten')).toBe(2);
    expect(counts.get('dairy')).toBe(1);
    // two distinct compounds first, then the repeat of `gluten free`
    expect(counts.get('free')).toBe(1);
  });

  it('a non-listed word is never exempt, whatever precedes it', () => {
    const counts = titleRepetitionCounts('Gluten Vegan Dairy Vegan Soy Vegan', repetition);
    expect(counts.get('vegan')).toBe(3);
  });
});

// ===========================================================================
// 4 — EMPTYING `compoundTails` RESTORES THE EXACT PRE-FIX COUNTING
// ===========================================================================

describe('C1 tails — the key is a pure WIDENER', () => {
  const CORPUS = [
    'Gluten Free, Dairy Free, Soy Free',
    'Gluten-Free, Dairy-Free, Soy-Free',
    'Gluten Free Gluten Free Gluten Free',
    'Free Free Free',
    'Gluten Free Free, Dairy Free Free, Soy Free Free',
    'Probiotic Probiotic Probiotic',
    'BrandX Daily Blend, Gluten Free, Vegan, 60 Count',
  ];

  /** The counting this module did before the exemption existed. */
  const preFixCounts = (title: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const t of titleContentTokens(title, repetition.stopwords)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  };

  it.each(CORPUS)('with the list emptied the tally is byte-for-byte the old one: %s', (title) => {
    const off = emptied().rules.titleWordRepetition;
    expect([...titleRepetitionCounts(title, off).entries()].sort()).toEqual(
      [...preFixCounts(title).entries()].sort(),
    );
  });

  it("with the list emptied the live 'free' x3 failure comes straight back", () => {
    expect(c1('BrandX Daily Blend, Gluten Free, Dairy Free, Soy Free, 60 Count', emptied()))
      .toContain("'free' x3");
  });

  it('so it can only ever WIDEN, and is deliberately not a REQUIRED_PACK_PIECES row', () => {
    expect(REQUIRED_PACK_PIECES.map((p) => p.id)).not.toContain(
      'rules.titleWordRepetition.compoundTails',
    );
  });
});

// ===========================================================================
// 5 — THE RULE STATED TO THE MODEL IS THE RULE THE GATE ENFORCES
// ===========================================================================

describe('C1 tails — the system prompt renders the exemption from pack data', () => {
  it('names the tail, the distinct-head condition and the carve-outs', () => {
    const prompt = buildSystemPrompt(pack, {}, []);
    expect(prompt).toContain(`No word more than ${repetition.max}× in the title.`);
    expect(prompt).toContain('"free"');
    expect(prompt).toContain('DIFFERENT preceding word');
    expect(prompt).toContain('still count');
  });

  it('a pack with no tails renders the line exactly as it did before the key existed', () => {
    const prompt = buildSystemPrompt(emptied(), {}, []);
    expect(prompt).toContain(
      `- No word more than ${repetition.max}× in the title. Banned title chars:`,
    );
  });
});
