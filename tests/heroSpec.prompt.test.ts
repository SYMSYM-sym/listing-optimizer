import { describe, expect, it } from 'vitest';
import { buildGroupPrompts, buildSystemPrompt, heroSpecBlock } from '@/lib/engine/prompts';
import { buildFacts } from '@/lib/engine/facts';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack } from '@/lib/types';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * THE HERO-SPEC RULE REACHES THE SURFACES THAT BREAK IT.
 *
 * The live B00EEEITVA run wrote the headline potency as a per-dose claim in
 * exactly two places — `videoBrief.onScreenText[1]` and the A+ brand-story
 * body — while every bullet, the title and the description were clean. The
 * rule (C10 / A5) was stated once, in the shared SYSTEM preamble, underneath
 * the canonical facts block; the two surfaces where a headline number gets
 * written as a SLOGAN rather than as a sentence never had it stated at the
 * point of work.
 *
 * Routing the failure (see `tests/repairRouting.oracle.test.ts`) makes the
 * defect REPAIRABLE. This makes the FIRST attempt more likely to be clean,
 * which is the cheaper half.
 *
 * BOTH DIRECTIONS, because a prompt block that renders unconditionally is a
 * category literal in disguise: the block is rendered FROM PACK DATA
 * (`rules.units.perServingPhrases` / `.potencyVerbs` — the same lists gate
 * C10/A5 compile their regexes from) and a pack that ships no per-dose
 * phrasing must render NOTHING, leaving the prompts byte-for-byte what they
 * were.
 *
 * ---------------------------------------------------------------------------
 * ROUND 4 — THE BLOCK NO LONGER QUOTES THE FORBIDDEN PHRASING.
 *
 * As first shipped this block read "…NEVER attach it to a single dose — never
 * write it as \"per serving\"", i.e. it forbade a term BY NAMING IT. A live run
 * of B00EEEITVA echoed our own contrast straight back:
 *
 *   C10 | imagePlan[1].spec | "15 billion CFU as a property of the whole blend
 *                              (not per serving"
 *
 * — the third instance of the prompt-echo class in this project, and the first
 * one outside the compliance lexicon. The remedy is the same one rounds 1 and 2
 * used: state the rule as a POSITIVE constraint. The generator loses nothing it
 * can act on — C10 objects to the ATTACHMENT, and "write the figure together
 * with the whole it belongs to" is that rule, fully stated — and there is no
 * longer a forbidden surface form written anywhere the model can read it.
 *
 * The assertions below therefore run in the OPPOSITE direction on the phrasing:
 * the block must NOT contain a per-dose phrasing, and `tests/promptHygiene.test.ts`
 * §G holds the general form of that rule for every phrase list any wired check
 * reacts to. What is unchanged is everything else: the block is still rendered
 * from pack data, still reaches both surfaces, and still disappears entirely for
 * a pack that ships no rule.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

const PACK_IDS = ['supplements', 'cosmetics'] as const;

/** A pack with the per-dose phrasing removed — i.e. a category with no rule. */
const withoutRule = (id: (typeof PACK_IDS)[number]): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(loadPack(id))) as KnowledgePack;
  p.rules.units.perServingPhrases = [];
  return p;
};

describe('the hero-spec block is rendered from pack data, in both directions', () => {
  it('renders nothing when the pack declares no per-dose phrasing', () => {
    expect(heroSpecBlock(undefined)).toBe('');
    expect(heroSpecBlock({ dimensions: {}, families: [], perServingPhrases: [], potencyVerbs: [], dosageForms: [] })).toBe('');
    expect(heroSpecBlock({ dimensions: {}, families: [], perServingPhrases: ['  '], potencyVerbs: [], dosageForms: [] })).toBe('');
  });

  it('states the rule POSITIVELY and never names the per-dose phrasing (round 4)', () => {
    const block = heroSpecBlock({
      dimensions: {},
      families: [],
      perServingPhrases: ['per widget'],
      potencyVerbs: ['emits'],
      dosageForms: [],
    });
    // The rule is stated as the constraint it is …
    expect(block).toContain('HEADLINE SPEC');
    expect(block).toContain('AS A WHOLE');
    // … the potency VERBS are still quoted (C10 needs the per-dose phrasing to
    // fire at all, and the verb half is ordinary English the prompt may name —
    // see the `rules.units.potencyVerbs` exclusion row in promptHygiene §G) …
    expect(block).toContain('"emits"');
    // … and the forbidden phrasing appears nowhere, in any casing.
    expect(block.toLowerCase()).not.toContain('per widget');
    expect(block).not.toMatch(/\bper\s+\w+"/);
  });

  it('a pack with phrasings but NO verbs still renders the rule, without a verb clause', () => {
    const block = heroSpecBlock({
      dimensions: {},
      families: [],
      perServingPhrases: ['per widget'],
      potencyVerbs: [],
      dosageForms: [],
    });
    expect(block).toContain('HEADLINE SPEC');
    expect(block.toLowerCase()).not.toContain('per widget');
    expect(block).not.toContain('introduced by');
  });
});

describe.each(PACK_IDS)('%s — the hero-spec guidance reaches the surfaces that break it', (packId) => {
  const pack = loadPack(packId);
  const expected = heroSpecBlock(pack.rules.units);
  const prompts = buildGroupPrompts(pack);

  it('the pack actually declares the rule, so the assertions below are about something', () => {
    expect(expected.length).toBeGreaterThan(0);
  });

  it('the IMAGES + VIDEO prompt carries it', () => {
    expect(prompts.images(snapshot)).toContain(expected);
  });

  it('the A+ prompt carries it', () => {
    expect(prompts.aplus(snapshot, 'BrandX Probiotic')).toContain(expected);
  });

  it('the system preamble still carries the rule too — and names no phrasing', () => {
    const system = buildSystemPrompt(pack, buildFacts(snapshot, pack), ['probiotic']);
    // The rule is STATED (this block ADDS a statement at the two breaking
    // surfaces; it never removed the shared one) …
    expect(system).toContain('A potency figure describes the blend/formula as a whole');
    // … and, round 4, it is stated without quoting the phrasing it forbids.
    for (const phrase of pack.rules.units.perServingPhrases) {
      expect(system.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });
});

describe.each(PACK_IDS)('%s — a pack that ships no rule leaves the prompts unchanged', (packId) => {
  it('the images and A+ prompts lose the block entirely and gain nothing else', () => {
    const bare = withoutRule(packId);
    const barePrompts = buildGroupPrompts(bare);
    expect(heroSpecBlock(bare.rules.units)).toBe('');
    for (const phrase of loadPack(packId).rules.units.perServingPhrases) {
      expect(barePrompts.images(snapshot)).not.toContain(`"${phrase}"`);
      expect(barePrompts.aplus(snapshot, 'BrandX Probiotic')).not.toContain(`"${phrase}"`);
    }
    expect(barePrompts.images(snapshot)).not.toContain('HEADLINE SPEC');
    expect(barePrompts.aplus(snapshot, 'BrandX Probiotic')).not.toContain('HEADLINE SPEC');
  });
});
