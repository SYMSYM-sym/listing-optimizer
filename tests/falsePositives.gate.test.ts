import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * FALSE-POSITIVE REGRESSION GUARD (the file round 4 was missing).
 *
 * Round 4 closed real bypasses but shipped severe OVER-BLOCKING: short
 * abbreviations collided with units/honorifics/org names/currency codes and the
 * verb "add"; the concatenated pass manufactured phantom matches
 * (`routine and` -> `routineand` -> contains `tinea`); the doubled-letter pass
 * turned the 3-letter noun `add` into the 2-letter fragment `ad`; and several
 * symptom words that DSHEA structure/function copy is built on were treated as
 * diseases.
 *
 * Over-blocking is a defect of the same severity as under-blocking — a gate
 * that cannot process ordinary supplement copy is not a gate, it is a wall.
 * Every string below is legitimate marketing/label copy and must produce ZERO
 * failures on EVERY surface it can appear on.
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
  return copy;
};

/**
 * The auditor's twenty legitimate strings, tagged with the mechanism that used
 * to flag each one. Nothing here is a claim of any kind.
 */
const LEGITIMATE: [string, string][] = [
  // (a) short abbreviations vs units / honorifics / org names / currency codes
  ['Dissolves in 500 ms', 'ms = millisecond unit'],
  ['use within 500 ms', 'ms = millisecond unit'],
  ['Ask for Ms Jones', 'Ms = honorific'],
  ['an MS in food science and an OA member', 'MS = degree, OA = org'],
  ['Vitamin A, RA levels checked', 'RA = assay abbreviation'],
  ['ISO and OA compliant', 'OA = org/standard'],
  ['A CHF payment option', 'CHF = Swiss franc'],
  ['ALS testing (Advanced Lab Services)', 'ALS = lab name'],
  ['Our mono ingredient formula', 'mono = single'],
  // (a) the verb "add" + (c) the doubled-letter pass collapsing it to "ad"
  ['Add one chew to your morning routine', 'verb add / collapsed ad'],
  ['Simply add water', 'verb add / collapsed ad'],
  ['The ADD-ON pack', 'verb add / collapsed ad'],
  // (b) concatenated-pass collisions: "routine and" -> "routineand" -> tinea
  ['Part of a healthy routine and a balanced diet', 'concat collision: tinea'],
  ['Our routine analysis', 'concat collision: tinea'],
  ['Great for your daily routine, anywhere', 'concat collision: tinea'],
  // (d) symptom words that ordinary structure/function copy is built on
  ['Great for cold and flu season travel kits', 'seasonal calendar reference'],
  ['Fatigue support blend with B12', 'symptom word, not a disease'],
  ['Supports healthy inflammation response', 'symptom word, not a disease'],
  ['Helps reduce occasional bloating, gas', 'symptom word, not a disease'],
];

/**
 * The surfaces each string is planted on.
 *
 * Every one of them is scanned by the compliance path (C6/A2), by C18/C19 and
 * by the style gate, so a false positive raised by ANY of those checks on the
 * planted field fails the test. The mutations are chosen so that no UNRELATED
 * rule can fire on the field: the bullet keeps its leading capital and ends on
 * a letter, the description keeps its product name + verbatim disclaimer, and
 * the Q&A / A+ answers are marked non-claim-bearing.
 */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['bullets[0]', (l, s) => { l.bullets[0] = `Good to know ${s}`; }],
  ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
  ['attributes.special_ingredients', (l, s) => { l.attributes.special_ingredients = s; }],
  ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

describe('FALSE POSITIVES — legitimate copy must never be blocked', () => {
  for (const [text, why] of LEGITIMATE) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" (${why}) is clean on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(onField(l, field)).toEqual([]);
      });
    }
  }

  it('all twenty strings together in one listing still leave the gate green', () => {
    const l = mut((x) => {
      x.qa = LEGITIMATE.map(([text]) => ({ q: 'What should I know?', a: text, claimBearing: false }));
      x.aplusContent.faq = LEGITIMATE.slice(0, 5).map(([text]) => ({
        q: 'What should I know?',
        a: text,
        claimBearing: false,
      }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});

/**
 * The two directions of the SAME mechanism, asserted side by side so a future
 * fix cannot trade one for the other.
 */
describe('FALSE POSITIVES — the fix did not re-open the bypass it replaced', () => {
  const claims: [string, string][] = [
    ['g out', 'gout'],
    ['ib s', 'ibs'],
    ['can cer', 'cancer'],
    ['tum ors', 'tumor'],
  ];
  it.each(claims)('the split claim "%s" still FAILS C6 (term: %s)', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${payload} in adults*`; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });

  const longForms = [
    'osteoarthritis', 'rheumatoid arthritis', 'congestive heart failure',
    'multiple sclerosis', 'amyotrophic lateral sclerosis', 'adhd', 'mononucleosis',
  ];
  it.each(longForms)('the unambiguous long form "%s" still FAILS C6', (term) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${term} in adults*`; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });

  it('a benign seasonal span does NOT launder an actual prevention claim', () => {
    const l = mut((x) => { x.bullets[1] = 'Prevents colds during cold and flu season*'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
  });
});
