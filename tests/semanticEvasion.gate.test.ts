import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { buildAudit } from '@/lib/audit/buildAudit';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * SEMANTIC EVASION — drug claims written with ZERO listed tokens.
 *
 * C6 scans a LEXICON. Every payload below is an unmistakable drug claim to a
 * human reader and contains no listed disease noun, no listed prescription-drug
 * name and no listed banned verb, so all ten used to come back
 * `pass:true, verified:true` on the supplements pack.
 *
 * C21 catches the claim SHAPE instead (`compliancePack.semanticDrugClaims` —
 * pack data; the gate holds no term of its own). This file asserts BOTH
 * directions in one place, because a shape heuristic that is not pinned in both
 * directions is one tuning session away from becoming a wall: over-blocking
 * lawful structure/function copy is a defect of exactly the same severity as
 * letting a drug claim through.
 */

const pack = loadPack('supplements');
const cosmeticsPack = loadPack('cosmetics');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};

/** The ten payloads the adversarial auditor proved were passing, verbatim. */
const EVASIONS: string[] = [
  'shrinks the lump in your breast',
  'clears the plaque out of your arteries',
  'replaces your daily prescription pill',
  'so you can throw away your inhaler',
  'melts the growth away in weeks',
  'kills the bad cells that spread through the body',
  'ends the need for dialysis',
  'restores sight to failing eyes',
  'your doctor will take you off your blood pressure medication',
  'brings blood sugar back to normal so you can stop medication',
];

/** The ICD-code evasion found by the same auditor. */
const ICD_PAYLOAD = 'an effective treatment for ICD-10 E11.9';

/**
 * Ordinary, lawful DSHEA structure/function copy that uses the very same verbs
 * ("dissolve", "clears", "restores", "rebuilds", "melts", "kills", "removes").
 * Every one of these must produce ZERO failures — not just zero C21 failures.
 */
const LEGITIMATE: string[] = [
  'supports healthy circulation',
  'helps maintain normal blood sugar already within the normal range',
  'supports a healthy inflammatory response',
  'helps dissolve in water quickly',
  'clears space in your routine',
  'restores your energy after a workout',
  'rebuilds after exercise',
  'melts smoothly into your smoothie',
  'kills 99.9% of odors',
  'removes the guesswork',
];

/**
 * Required SAFETY copy that names a therapy on purpose. The pack's
 * `safeContextPhrases` are what keep these clean; without them the fix would
 * have blocked the one instruction a supplement label most needs to carry.
 */
const SAFETY_COPY: string[] = [
  'Do not stop taking your medication without speaking to a professional',
  'This is not a substitute for prescription medication',
  'Consult your doctor before starting any new routine',
];

/** Surfaces a claim can hide on. Each plant leaves every OTHER rule satisfied. */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['bullets[1]', (l, s) => { l.bullets[1] = `Daily support that ${s}*`; }],
  ['description', (l, s) => { l.description = `${l.description} It ${s}.`; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: `It ${s}`, claimBearing: false }; }],
  ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: `It ${s}`, claimBearing: false }; }],
  ['attributes.special_ingredients', (l, s) => { l.attributes.special_ingredients = s; }],
  ['imagePlan[0].notes', (l, s) => { l.imagePlan[0]!.notes = `Overlay: ${s}`; }],
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

describe('R1 — semantic drug claims with zero listed tokens now FAIL (C21)', () => {
  for (const payload of [...EVASIONS, ICD_PAYLOAD]) {
    for (const [field, plant] of SURFACES) {
      it(`"${payload}" fails C21 on ${field}`, () => {
        const l = mut((x) => plant(x, payload));
        expect(onField(l, field).some((f) => f.checkId === 'C21')).toBe(true);
      });
    }
  }

  it.each(EVASIONS)('"%s" uses no term the LEXICON tier (C6) can see', (payload) => {
    // The point of the fix: C6 alone is blind to every one of these, which is
    // why the gate needed a shape tier rather than more nouns.
    const l = mut((x) => { x.bullets[1] = `Daily support that ${payload}*`; });
    const failures = onField(l, 'bullets[1]');
    expect(failures.some((f) => f.checkId === 'C21')).toBe(true);
    expect(failures.every((f) => f.checkId !== 'C6')).toBe(true);
  });

  it.each(EVASIONS)('"%s" can never come back verified', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Daily support that ${payload}*`; });
    expect(runGate(l, pack, ctx).pass).toBe(false);
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });

  it('the whole set planted at once fails, and every payload is named', () => {
    const l = mut((x) => {
      x.qa = EVASIONS.map((s, i) => ({ q: `Q${i}`, a: `It ${s}`, claimBearing: false }));
    });
    const c21 = runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C21');
    expect(new Set(c21.map((f) => f.field)).size).toBe(EVASIONS.length);
  });

  it('the cosmetics pack catches the same shapes', () => {
    const l = mut((x) => { x.bullets[1] = 'Daily support that shrinks the lump in your breast*'; });
    const failures = runGate(l, cosmeticsPack, { subcategories: ['skincare'] }).failures;
    expect(failures.some((f) => f.checkId === 'C21' && f.field === 'bullets[1]')).toBe(true);
  });
});

describe('R1 — legitimate copy using the same verbs stays clean', () => {
  for (const text of LEGITIMATE) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" is clean on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(onField(l, field)).toEqual([]);
      });
    }
  }

  it('all ten legitimate phrases together leave the gate green', () => {
    const l = mut((x) => {
      x.qa = LEGITIMATE.map((text, i) => ({ q: `Q${i}`, a: text, claimBearing: false }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it.each(SAFETY_COPY)('required safety copy "%s" is clean', (text) => {
    const l = mut((x) => { x.bullets[1] = `Good to know: ${text}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });

  it('safety copy does NOT launder a real claim in the same sentence', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Not a substitute for prescription medication, it also ends the need for dialysis*';
    });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });
});

/**
 * The heuristic's own boundaries, asserted rather than assumed: a
 * determiner-scoped target is a claim only when a determiner points at ONE
 * instance of it.
 */
describe('R1 — determiner-scoped targets', () => {
  it.each([
    'Supports healthy hair growth every day',
    'Removes the guesswork from cell growth support',
    'A blend that supports muscle mass in adults',
  ])('"%s" is clean', (text) => {
    const l = mut((x) => { x.bullets[1] = `${text}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'Melts the growth away in weeks',
    'Dissolves the stone in a fortnight',
  ])('"%s" fails C21', (text) => {
    const l = mut((x) => { x.bullets[1] = `${text}*`; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });

  /**
   * 'plaque' is the one term that could not be made safe as a PLAIN target:
   * "helps remove plaque" is ordinary lawful oral-care copy. It is
   * determiner-scoped on every pack instead, which keeps the bare form clean
   * and still fails the arterial claim. The residual is asserted, not hidden.
   */
  it.each([
    'Helps remove plaque with regular brushing',
    'Removes plaque with regular brushing',
  ])('bare-noun oral-care copy "%s" is clean', (text) => {
    const l = mut((x) => { x.bullets[1] = `${text}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });

  it('the determiner-pointed arterial form still fails', () => {
    const l = mut((x) => { x.bullets[1] = 'Clears the plaque out of your arteries*'; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });

  it('RESIDUAL, asserted so it cannot be forgotten: "removes the plaque" is reported', () => {
    const l = mut((x) => { x.bullets[1] = 'Removes the plaque from your teeth*'; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });
});
