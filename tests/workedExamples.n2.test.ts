import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts, buildSystemPrompt, heroSpecBlock } from '@/lib/engine/prompts';
import { a5AplusPotencyPhrasing, a8AplusProhibitedMarketing } from '@/lib/gate/checks/a-aplus';
import { c19ProhibitedMarketing } from '@/lib/gate/checks/c-prohibited';
import { c10PotencyPhrasing } from '@/lib/gate/checks/c-quality';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Facts, Failure, KnowledgePack, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * N2 — THE POSITIVE REWORDINGS REMOVED THE ECHO AND STOPPED BINDING.
 *
 * Two earlier rounds pull against each other, and both live failures below sit
 * on a build that contains both fixes.
 *
 *   ROUND L closed a prompt-echo class: an instruction that NAMES a phrase a
 *   check reacts to gets paraphrased into the copy and the listing is failed on
 *   its own brief. `tests/promptHygiene.test.ts` now derives its forbidden set
 *   from every pack lexicon any wired check matches on, so no prompt can name
 *   one. `heroSpecBlock` was reworded from "NEVER attach it to a single dose —
 *   never write it as <the phrasing>" to the purely positive "The headline
 *   potency figure describes the blend or formula AS A WHOLE."
 *
 *   ROUND M did the same for the study-endorsement class: a positive
 *   `trustFramingNote` saying what verifiable trust framing IS available,
 *   naming no banned phrase.
 *
 * Both rewordings are RIGHT and neither is enough:
 *
 *   A5 | aplus.modules[hero].body    | '15 billion CFUs of LGG probiotic per serving'
 *   A5 | aplus.modules[hero].body    | 'delivers 15 billion CFUs of LGG probiotic per serving'
 *   A5 | aplus.comparison[1].ours    | '15 billion CFUs per serving'
 *   C19 | aplus.modules[ingredients]      | 'clinically studied'
 *   A8  | aplus.modules[ingredients].body | 'clinically studied'
 *
 * The model mirrors the source listing, which says both things prominently. An
 * abstraction ("describe the whole", "let the specification carry the
 * credibility") competes with a concrete sentence sitting in the input, and
 * loses. What is missing is not a prohibition — a prohibition is what round L
 * removed, for cause — it is the COMPLIANT FORM, written out. A compliant
 * example contains no banned phrase by construction, so prompt hygiene is
 * untouched, while a concrete pattern is the one thing a mirroring generator
 * can copy.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE MEASURES, AND HOW IT AVOIDS BEING A TAUTOLOGY.
 *
 * `mirroringLlm` below only ever writes text it FOUND IN THE PROMPT IT WAS
 * GIVEN. It looks for a copyable worked shape — a quoted span carrying a
 * bracketed slot — and, finding one, fills the slots from the canonical facts
 * and writes it. Finding none, it falls back to the strongest concrete signal
 * it has: the source listing's own sentence, lifted verbatim out of the
 * `CURRENT LISTING` block of the same prompt. It never quotes a compliant
 * string of the test's own invention.
 *
 * That makes the pairing a real measurement rather than a flag:
 *  - the examples must be REACHABLE (rendered into the prompt the A+ group
 *    actually gets, and into the shared system preamble);
 *  - the examples must be COMPLIANT once their slots are filled — a shape that
 *    carried a per-dose phrasing, or the banned trust framing, would fail these
 *    tests rather than pass them;
 *  - emptying the pack key removes the shape, the model falls back to the
 *    source, and the five live failures come back on the same fields.
 *
 * WHAT IT DOES NOT MEASURE: whether a real model prefers a concrete shape to a
 * concrete source sentence. That is the hypothesis the fix rests on, and it is
 * stated here rather than pretended away. What is measured is everything the
 * repository can measure — reachability, compliance of the shape itself, the
 * both-directions behaviour of the four checks, and the byte-identity of every
 * prompt when the pack ships no examples.
 *
 * NOTHING BELOW TOUCHES A5, C10, C19 OR A8. Their triggers are correct; §(d)
 * pins them, in both directions, on several phrasings each.
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;
const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const base = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * THE SOURCE LISTING, carrying both offending phrasings prominently — the live
 * shape. The figure is the fixture's own canonical potency, so the only thing
 * wrong with the sentence is the ATTACHMENT (which is what A5/C10 object to)
 * rather than the number.
 */
const SOURCE_PER_DOSE = 'delivers 50 Billion CFU of live cultures per serving';
const SOURCE_PER_DOSE_SHORT = '50 Billion CFU per serving';
const SOURCE_TRUST = 'uses a clinically studied strain';
const source: ListingSnapshot = {
  ...base,
  description:
    `${base.description} Every batch ${SOURCE_TRUST}, and each bottle ${SOURCE_PER_DOSE}. ` +
    `The panel states ${SOURCE_PER_DOSE_SHORT}.`,
};

const clonePack = (p: KnowledgePack): KnowledgePack => JSON.parse(JSON.stringify(p)) as KnowledgePack;
const withoutHeroExamples = (p: KnowledgePack): KnowledgePack => {
  const c = clonePack(p);
  delete c.rules.units.heroSpecExamples;
  return c;
};
const withoutTrustExamples = (p: KnowledgePack): KnowledgePack => {
  const c = clonePack(p);
  delete c.compliancePack!.trustFramingExamples;
  return c;
};
const withoutBoth = (p: KnowledgePack): KnowledgePack => withoutTrustExamples(withoutHeroExamples(p));

// ---------------------------------------------------------------------------
// THE MIRRORING GENERATOR
// ---------------------------------------------------------------------------

/**
 * Every quoted span in `prompt` that carries the bracketed slot `slot`.
 *
 * Structural, so the stub needs no knowledge of the header prose that
 * introduces the shapes — only that a copyable shape is a quoted sentence with
 * a slot in it. The C22 approved-claim templates are quoted shapes too and are
 * correctly ignored: they carry different slots.
 */
function shapesWithSlot(prompt: string, slot: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/"([^"\n]{4,160})"/g)) {
    const body = m[1]!;
    if (body.includes(slot)) out.push(body);
  }
  return out;
}

/** The canonical-facts values a mirroring model would drop into the slots. */
const SLOTS: Record<string, string> = {
  '[figure]': '50 Billion CFU',
  '[potency]': '50 Billion CFU',
  '[concentration]': '50 Billion CFU',
  '[ingredient]': '10 probiotic strains',
  '[standard]': 'cGMP',
  '[origin]': 'the USA',
  '[test]': 'third-party',
  '[format]': 'vegan capsules',
  '[texture]': 'a smooth texture',
};

const fillSlots = (shape: string): string => {
  let out = shape;
  for (const [slot, value] of Object.entries(SLOTS)) out = out.split(slot).join(value);
  return out.charAt(0).toUpperCase() + out.slice(1);
};

/** The source sentence, lifted out of the prompt's own CURRENT LISTING block. */
const fromSource = (prompt: string, sentence: string): string => {
  if (!prompt.includes(sentence)) throw new Error(`source sentence absent from prompt: ${sentence}`);
  return sentence;
};

/**
 * A generator that behaves the way the live one did: it mirrors the strongest
 * concrete phrasing available to it. Given a worked shape it copies the shape;
 * given none, it copies the source listing. Everything else it returns is
 * `mockLlm`'s output, so two runs differ by exactly the pack keys under test.
 */
const mirroringLlm: LlmClient = async (req) => {
  const raw = await mockLlm(req);
  if (!req.user.includes('A+ content')) return raw;
  const parsed = JSON.parse(raw) as {
    modules: { id: string; body: string }[];
    comparison: { rows: { ours: string }[] };
  };
  // The headline potency figure — the A5 surfaces.
  const heroShapes = shapesWithSlot(req.user, '[figure]');
  const hero = parsed.modules.find((m) => m.id === 'hero')!;
  if (heroShapes.length > 0) {
    const longest = [...heroShapes].sort((a, b) => b.length - a.length)[0]!;
    const shortest = [...heroShapes].sort((a, b) => a.length - b.length)[0]!;
    hero.body = `${hero.body} ${fillSlots(longest)}.`;
    parsed.comparison.rows[0]!.ours = fillSlots(shortest);
  } else {
    hero.body = `${hero.body} Each bottle ${fromSource(req.user, SOURCE_PER_DOSE)}.`;
    parsed.comparison.rows[0]!.ours = fromSource(req.user, SOURCE_PER_DOSE_SHORT);
  }
  // The trust framing — the C19/A8 surface.
  const trustShapes = shapesWithSlot(req.system, '[standard]');
  const ingredients = parsed.modules.find((m) => m.id === 'ingredients')!;
  ingredients.body =
    trustShapes.length > 0
      ? `${ingredients.body} ${fillSlots(trustShapes[0]!)}.`
      : `${ingredients.body} Every batch ${fromSource(req.user, SOURCE_TRUST)}.`;
  return JSON.stringify(parsed);
};

const heroFailures = (l: OptimizedListing, p: KnowledgePack): Failure[] => [
  ...a5AplusPotencyPhrasing(l, p),
  ...c10PotencyPhrasing(l, p),
];
const trustFailures = (l: OptimizedListing, p: KnowledgePack): Failure[] =>
  [...c19ProhibitedMarketing(l, p), ...a8AplusProhibitedMarketing(l, p)].filter((f) =>
    /clinically[\s-]+studied/i.test(f.context),
  );
const shapeOf = (f: Failure): string => `${f.checkId}|${f.field}`;

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(base, pack, mockLlm);
});
const mut = (f: (l: OptimizedListing) => void): OptimizedListing => {
  const l = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  f(l);
  return l;
};

// ===========================================================================
// (a) THE SHAPES ARE PACK DATA, AND THEY REACH THE SURFACES THAT BREAK
// ===========================================================================

describe.each(PACK_IDS)('(a) %s — the worked shapes are rendered from pack data', (packId) => {
  const p = loadPack(packId);

  it('the pack ships both example lists, so the assertions below are about something', () => {
    expect((p.rules.units.heroSpecExamples ?? []).length).toBeGreaterThan(0);
    expect((p.compliancePack!.trustFramingExamples ?? []).length).toBeGreaterThan(0);
  });

  it('every hero shape is rendered verbatim into the A+ and images prompts', () => {
    const prompts = buildGroupPrompts(p);
    for (const shape of p.rules.units.heroSpecExamples!) {
      expect(prompts.aplus(base, 'BrandX Probiotic')).toContain(`"${shape}"`);
      expect(prompts.images(base)).toContain(`"${shape}"`);
    }
  });

  it('every trust shape is rendered verbatim into the shared system preamble', () => {
    const system = buildSystemPrompt(p, {} as Facts, ['probiotic']);
    for (const shape of p.compliancePack!.trustFramingExamples!) {
      expect(system).toContain(`"${shape}"`);
    }
  });

  it('a shape carries a bracketed slot, which is what makes it copyable', () => {
    const prompts = buildGroupPrompts(p);
    expect(shapesWithSlot(prompts.aplus(base, 'BrandX Probiotic'), '[figure]').length)
      .toBeGreaterThan(0);
    expect(shapesWithSlot(buildSystemPrompt(p, {} as Facts, ['probiotic']), '[standard]').length)
      .toBeGreaterThan(0);
  });

  it('the shapes NAME NO PER-DOSE PHRASING — the round-L constraint is untouched', () => {
    for (const shape of p.rules.units.heroSpecExamples!) {
      for (const phrase of p.rules.units.perServingPhrases) {
        expect(shape.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it('every shape is COMPLIANT once its slots are filled (this is the example, checked)', () => {
    const shapes = [
      ...p.rules.units.heroSpecExamples!,
      ...p.compliancePack!.trustFramingExamples!,
    ].map(fillSlots);
    for (const written of shapes) {
      const asCopy = {
        description: written,
        aplusContent: { modules: [{ id: 'x', headline: 'x', body: written }] },
      } as unknown as OptimizedListing;
      expect(heroFailures(asCopy, p)).toEqual([]);
      expect(c19ProhibitedMarketing(asCopy, p)).toEqual([]);
      expect(a8AplusProhibitedMarketing(asCopy, p)).toEqual([]);
    }
  });
});

// ===========================================================================
// (b) THE PAIRING — the examples are what does the work
// ===========================================================================

describe('(b) the mirroring generator, with the shapes and without them', () => {
  it('NO SHAPES: it mirrors the source and the five live failures come back', async () => {
    const bare = withoutBoth(pack);
    const listing = await optimize(source, bare, mirroringLlm);
    const shapes = [...heroFailures(listing, bare), ...trustFailures(listing, bare)].map(shapeOf);
    expect(shapes).toContain('A5|aplus.modules[hero].body');
    expect(shapes).toContain('A5|aplus.comparison[0].ours');
    expect(shapes).toContain('C19|aplus.modules[ingredients]');
    expect(shapes).toContain('A8|aplus.modules[ingredients].body');
    // The A5 hero body fires TWICE — the bare phrasing and the verb-led one —
    // exactly as the live run recorded it.
    expect(shapes.filter((s) => s === 'A5|aplus.modules[hero].body').length).toBeGreaterThanOrEqual(2);
    expect(runGate(listing, bare, ctx).pass).toBe(false);
  });

  it('SHAPES SHOWN: the same generator writes compliant copy and the run converges', async () => {
    const listing = await optimize(source, pack, mirroringLlm);
    expect(heroFailures(listing, pack)).toEqual([]);
    expect(trustFailures(listing, pack)).toEqual([]);
    const result = runGate(listing, pack, ctx);
    expect(result.failures.filter((f) => ['A5', 'C10', 'C19', 'A8'].includes(f.checkId))).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the two keys are independent: emptying ONLY the hero shapes reopens ONLY A5', async () => {
    const bare = withoutHeroExamples(pack);
    const listing = await optimize(source, bare, mirroringLlm);
    expect(heroFailures(listing, bare).map(shapeOf)).toContain('A5|aplus.modules[hero].body');
    expect(trustFailures(listing, bare)).toEqual([]);
  });

  it('the two keys are independent: emptying ONLY the trust shapes reopens ONLY C19/A8', async () => {
    const bare = withoutTrustExamples(pack);
    const listing = await optimize(source, bare, mirroringLlm);
    expect(heroFailures(listing, bare)).toEqual([]);
    expect(trustFailures(listing, bare).map(shapeOf)).toContain('A8|aplus.modules[ingredients].body');
  });

  it('the stub really is prompt-driven: it wrote the shipped shape, not a string of its own', async () => {
    const listing = await optimize(source, pack, mirroringLlm);
    const hero = listing.aplusContent!.modules.find((m) => m.id === 'hero')!;
    const written = pack.rules.units
      .heroSpecExamples!.map(fillSlots)
      .some((shape) => hero.body.includes(shape));
    expect(written).toBe(true);
  });
});

// ===========================================================================
// (c) ABSENT KEY ⇒ THE PROMPT IS BYTE-IDENTICAL TO TODAY'S
// ===========================================================================

describe.each(PACK_IDS)('(c) %s — a pack that ships no shapes renders exactly what it did', (packId) => {
  const p = loadPack(packId);

  it('heroSpecBlock loses the shapes and gains nothing else', () => {
    const bare = withoutHeroExamples(p);
    const withShapes = heroSpecBlock(p.rules.units);
    const withoutShapes = heroSpecBlock(bare.rules.units);
    expect(withoutShapes).not.toContain('WRITTEN OUT');
    const rendered = p.rules.units.heroSpecExamples!.map((e) => `\n  - "${e}"`).join('');
    expect(
      withShapes
        .replace(
          '\n- WRITTEN OUT — copy one of these shapes, filling each bracketed slot from the canonical facts above. The last one is short enough for a comparison-table cell:',
          '',
        )
        .replace(rendered, ''),
    ).toBe(withoutShapes);
  });

  it('an EMPTY list is the same as an absent one (the trim is load-bearing)', () => {
    const blank = clonePack(p);
    blank.rules.units.heroSpecExamples = ['  ', ''];
    expect(heroSpecBlock(blank.rules.units)).toBe(heroSpecBlock(withoutHeroExamples(p).rules.units));
    const blankTrust = clonePack(p);
    blankTrust.compliancePack!.trustFramingExamples = ['   '];
    expect(buildSystemPrompt(blankTrust, {} as Facts, ['probiotic'])).toBe(
      buildSystemPrompt(withoutTrustExamples(p), {} as Facts, ['probiotic']),
    );
  });

  it('the system preamble loses the trust line and is otherwise byte-for-byte what it was', () => {
    const bare = withoutTrustExamples(p);
    const withLine = buildSystemPrompt(p, {} as Facts, ['probiotic']);
    const withoutLine = buildSystemPrompt(bare, {} as Facts, ['probiotic']);
    const line = `\n- Written out — copy one of these shapes into a brand-story module or a comparison column, filling each bracketed slot from the canonical facts, the operator panel or the source listing above: ${p
      .compliancePack!.trustFramingExamples!.map((e) => `"${e}"`)
      .join(' | ')}`;
    expect(withLine.replace(line, '')).toBe(withoutLine);
  });

  it('EVERY group prompt is byte-identical when both keys are absent', () => {
    const bare = withoutBoth(p);
    const now = buildGroupPrompts(p);
    const before = buildGroupPrompts(bare);
    // Only the two prompts that render `heroSpecBlock` may differ at all …
    expect(before.title(base)).toBe(now.title(base));
    expect(before.bullets(base)).toBe(now.bullets(base));
    expect(before.description(base)).toBe(now.description(base));
    expect(before.qa(base)).toBe(now.qa(base));
    expect(before.backend(base)).toBe(now.backend(base));
    // … and those two lose only the shapes.
    for (const shape of p.rules.units.heroSpecExamples!) {
      expect(before.aplus(base, 'BrandX Probiotic')).not.toContain(shape);
      expect(before.images(base)).not.toContain(shape);
    }
  });
});

// ===========================================================================
// (d) THE FOUR CHECKS ARE UNMOVED — both directions, several phrasings each
// ===========================================================================

const A5_FIRES: [string, string][] = [
  ['bare', 'A blend at 50 Billion CFU per serving'],
  ['verb-led', 'It delivers 50 Billion CFU per serving'],
  ['interposed', '50 Billion CFU of live cultures per serving'],
  ['title case', 'A blend at 50 Billion CFU Per Serving'],
  ['upper case', 'A blend at 50 BILLION CFU PER SERVING'],
  ['double space', 'A blend at 50 Billion CFU  per serving'],
  ['spelled out', 'A blend at Fifty Billion CFU per serving'],
];

const A5_DOES_NOT_FIRE: [string, string][] = [
  ['whole-blend framing', 'A 50 Billion CFU blend of 10 probiotic strains'],
  ['the shape we ship', 'The formula is built to 50 Billion CFU of 10 probiotic strains'],
  ['no figure at all', 'One capsule is a full serving, taken per serving instructions'],
  ['figure, no attachment', 'The finished formula holds 50 Billion CFU'],
];

const C19_FIRES: [string, string][] = [
  ['plain', 'A clinically studied strain in every capsule'],
  ['title case', 'A Clinically Studied strain in every capsule'],
  ['upper case', 'A CLINICALLY STUDIED strain in every capsule'],
  ['hyphenated', 'A clinically-studied strain in every capsule'],
  ['double space', 'A clinically  studied strain in every capsule'],
];

const C19_DOES_NOT_FIRE: [string, string][] = [
  ['clinically tested', 'Third-party and clinically tested for purity'],
  ['clinical study', 'The strain appears in a clinical study of gut flora'],
  ['the shape we ship', 'Made to cGMP in the USA, with third-party testing on every lot'],
];

describe('(d) A5 / C10 still fail the attachment, in every phrasing', () => {
  /**
   * The payload leads the body, which is where a model writes a headline
   * figure. It also keeps the sentence clear of the appended disclaimer: that
   * constant carries the regulator's own negation phrase, which legitimately
   * SUPPRESSES a hit in its neighbourhood (`hasNegationContext`), and this
   * section is about the trigger rather than about the suppressor.
   */
  it.each(A5_FIRES)('%s: fails A5 in an A+ module body', (_label, payload) => {
    const l = mut((x) => {
      x.aplusContent!.modules[1]!.body = `${payload}. ${x.aplusContent!.modules[1]!.body}`;
    });
    expect(
      a5AplusPotencyPhrasing(l, pack).some((f) => f.field === 'aplus.modules[hero].body'),
    ).toBe(true);
  });

  it.each(A5_FIRES)('%s: fails A5 in a comparison column', (_label, payload) => {
    const l = mut((x) => {
      x.aplusContent!.comparison!.rows[0]!.ours = payload;
    });
    expect(a5AplusPotencyPhrasing(l, pack).some((f) => f.field === 'aplus.comparison[0].ours')).toBe(true);
  });

  it.each(A5_FIRES)('%s: fails C10 in a bullet (the customer surfaces are unmoved too)', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c10PotencyPhrasing(l, pack).some((f) => f.field === 'bullets[1]')).toBe(true);
  });

  it.each(A5_DOES_NOT_FIRE)('%s does NOT fire (no over-block)', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
      x.aplusContent!.modules[1]!.body = `${payload}. ${x.aplusContent!.modules[1]!.body}`;
      x.aplusContent!.comparison!.rows[0]!.ours = payload;
    });
    expect(heroFailures(l, pack)).toEqual([]);
  });
});

describe('(d) C19 / A8 still fail the study-endorsement claim, in every phrasing', () => {
  it.each(C19_FIRES)('%s: fails C19 AND A8 in an A+ module body', (_label, payload) => {
    const l = mut((x) => {
      x.aplusContent!.modules[2]!.body = `${x.aplusContent!.modules[2]!.body} ${payload}`;
    });
    expect(c19ProhibitedMarketing(l, pack).some((f) => f.field.startsWith('aplus.modules'))).toBe(true);
    expect(a8AplusProhibitedMarketing(l, pack).some((f) => f.field.startsWith('aplus.modules'))).toBe(true);
  });

  it.each(C19_FIRES)('%s: fails C19 in a bullet', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c19ProhibitedMarketing(l, pack).some((f) => f.field === 'bullets[1]')).toBe(true);
  });

  it.each(C19_DOES_NOT_FIRE)('%s does NOT fire (no over-block)', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(trustFailures(l, pack)).toEqual([]);
  });
});

// ===========================================================================
// (e) THE SHAPES ARE PACK DATA — emptying the pack disarms nothing in the gate
// ===========================================================================

describe('(e) the shapes are prevention only', () => {
  it('removing them changes no check: the same copy still fails the same way', () => {
    const bare = withoutBoth(pack);
    const l = mut((x) => {
      x.bullets[1] = 'A blend at 50 Billion CFU per serving';
      x.aplusContent!.modules[2]!.body = 'A clinically studied strain in every capsule';
    });
    expect(c10PotencyPhrasing(l, bare).map(shapeOf)).toEqual(c10PotencyPhrasing(l, pack).map(shapeOf));
    expect(c19ProhibitedMarketing(l, bare).map(shapeOf)).toEqual(
      c19ProhibitedMarketing(l, pack).map(shapeOf),
    );
  });

  it('the golden generation path is untouched: `mockLlm` still passes the gate', () => {
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });
});
