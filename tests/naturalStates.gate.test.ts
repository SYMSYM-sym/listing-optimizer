import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { buildSystemPrompt } from '@/lib/engine/prompts';
import { runGate } from '@/lib/gate/runGate';
import { c22NaturalState, type GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';
import { withCoherentKeywords } from './fixtures/coherentKeywords';

/**
 * C22 — NATURAL STATE / ABNORMALITY: the FDA structure/function DOCTRINE, in
 * both directions.
 *
 * The rule being encoded (21 CFR 101.93(f)/(g) + the Small Entity Compliance
 * Guide): ageing, the menopause, the menstrual cycle, adolescence and pregnancy
 * are NATURAL STATES, not diseases, although each can be associated with
 * abnormal conditions that are. NORMAL SYMPTOMOLOGY of a natural state is
 * permissible; the ABNORMAL condition is not. "Supports comfort during
 * menopause" is lawful; "treats menopause" is not, and neither is "clinical
 * menopause disorder".
 *
 * Both directions are asserted side by side deliberately. A gate that cannot
 * process lawful copy is not a gate, it is a wall — over-blocking here is a
 * defect of exactly the same severity as a bypass.
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
  // Keep the parallel claim-bearing flags coherent with the rewritten text.
  return withCoherentKeywords(withCoherentBulletFlags(copy));
};

/**
 * The surfaces each string is planted on. Every one is read by C6, C21 and C22,
 * and the mutations keep every UNRELATED rule satisfied (the bullet keeps its
 * leading capital and a trailing `*`, the description keeps its product name
 * and verbatim disclaimer, the Q&A answer is marked non-claim-bearing).
 */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['bullets[0]', (l, s) => { l.bullets[0] = `Good to know: ${s}*`; }],
  ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
  ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

/** Compliance-bearing failures only — the claim checks, not length/style. */
const claimFailuresOn = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter(
    (f) => f.field === field && ['C6', 'C21', 'C22', 'A2'].includes(f.checkId),
  );

// ===========================================================================
// DIRECTION 1 — LAWFUL structure/function copy must pass, everywhere
// ===========================================================================

/**
 * Every string here is lawful under the structure/function rule: a natural
 * state named without acting on it, normal symptomology qualified as the mild
 * or occasional form, or a plain structure/function statement.
 */
const MUST_PASS: string[] = [
  'Supports comfort during menopause',
  'Formulated for women in perimenopause and menopause',
  'Helps prevent mild memory loss associated with aging',
  'Helps with mild mood changes associated with the menstrual cycle',
  'Supports healthy joint function',
  'Helps maintain blood sugar already within the normal range',
  'Supports a healthy inflammatory response',
  "Supports the body's natural detoxification process",
  'Occasional sleeplessness support for adults',
  'Supports normal energy after exercise',
];

describe('C22 — lawful natural-state and structure/function copy is never blocked', () => {
  for (const text of MUST_PASS) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" is clean on ${field}`, () => {
        expect(onField(mut((x) => plant(x, text)), field)).toEqual([]);
      });
    }
  }

  it('all ten lawful strings together in one listing still leave the gate green', () => {
    const l = mut((x) => {
      x.qa = MUST_PASS.map((text) => ({ q: 'What should I know?', a: text, claimBearing: false }));
      x.aplusContent.faq = MUST_PASS.slice(0, 5).map((text) => ({
        q: 'What should I know?',
        a: text,
        claimBearing: false,
      }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  /** The same copy read through the cosmetics pack (the mirrored lists). */
  it.each(MUST_PASS)('"%s" raises no C22 failure under the cosmetics pack either', (text) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });
    expect(c22NaturalState(l, cosmetics).filter((f) => f.field === 'bullets[0]')).toEqual([]);
  });
});

// ===========================================================================
// DIRECTION 2 — the abnormal / therapeutic form must fail
// ===========================================================================

/** Each entry: the copy, and the doctrine clause it violates. */
const MUST_FAIL: [string, string][] = [
  ['Treats menopause', 'therapeutic action on a natural state'],
  ['Cures aging', 'therapeutic action on a natural state'],
  ['For severe menopause symptoms', 'abnormality marker beside a natural state'],
  ['Clinical menopause disorder', 'abnormality marker beside a natural state'],
  ['Relieves chronic mood disorder', 'two abnormality markers name an abnormal condition'],
  ["Prevents Alzheimer's disease", 'named disease noun'],
  ["mild Alzheimer's", 'named disease noun — a lawful qualifier never rescues it'],
  ['age-related macular degeneration', 'named disease noun — a lawful qualifier never rescues it'],
  ['Treats severe depression', 'named disease noun'],
  ['for diagnosed medical conditions', 'two abnormality markers name an abnormal condition'],
];

describe('C22 — the abnormal or therapeutic form of the same sentiment fails', () => {
  for (const [text, why] of MUST_FAIL) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" (${why}) FAILS on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(claimFailuresOn(l, field).length).toBeGreaterThan(0);
      });
    }
  }

  it.each(MUST_FAIL)('"%s" makes the whole gate fail', (text) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

/**
 * OBFUSCATION + the wider lawful corpus. C22 runs over the same ADDITIVE
 * de-obfuscation variant set the disease scan uses, so a leetspeak verb or a
 * letter-spaced marker is caught; and ordinary supplement copy that merely
 * MENTIONS a natural state, a research programme or a safety warning is not.
 */
describe('C22 — obfuscation is covered and ordinary copy is not touched', () => {
  const c22On = (l: OptimizedListing, field: string): Failure[] =>
    c22NaturalState(l, pack).filter((f) => f.field === field);
  const plant = (text: string): OptimizedListing =>
    mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });

  it.each([
    'Tr3ats menopause',
    's-e-v-e-r-e menopause relief',
    'Ends perimenopause for good',
    'Reverses the aging process',
    'Helps with severe pms',
    'For abnormal menstrual cycles',
    'Formulated for a chronic medical condition',
  ])('the obfuscated or restated claim "%s" still FAILS', (text) => {
    expect(c22On(plant(text), 'bullets[0]').length).toBeGreaterThan(0);
  });

  it.each([
    'If you are pregnant, nursing, or taking medication, consult your physician before use',
    'Clinically studied strains in every batch',
    'Backed by a clinical study in adults',
    'Backed by clinical research and third-party tested',
    'Our clinical strength formula for busy adults',
    'Made for women navigating perimenopause and menopause',
    'Supports healthy hormone balance during perimenopause',
    'Formulated to support normal energy levels during pregnancy',
    'Designed for teens going through puberty',
    'Not for use if you have a diagnosed medical condition without medical supervision',
    'A daily formula for adults over 50 who notice everyday forgetfulness',
    'Supports healthy aging and everyday vitality',
    'Helps ease everyday tension during the menstrual cycle',
    'A gentle blend for the years around menopause',
    'Improve your daily routine over a short period',
  ])('ordinary lawful copy "%s" raises NO C22 failure', (text) => {
    expect(c22On(plant(text), 'bullets[0]')).toEqual([]);
  });
});

// ===========================================================================
// PRECEDENCE — disease noun > abnormality marker > lawful qualifier
// ===========================================================================

describe('PRECEDENCE — disease noun > abnormality marker > lawful qualifier', () => {
  const c6On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C6' && f.field === field);
  const c22On = (l: OptimizedListing, field: string): Failure[] =>
    c22NaturalState(l, pack).filter((f) => f.field === field);

  /** TIER 1 — a listed disease noun always wins, whatever qualifies it. */
  it.each([
    "mild Alzheimer's",
    'age-related macular degeneration',
    'occasional relief from arthritis',
    'normal support for diabetes',
    'healthy help with hypertension',
    'temporary support for depression',
  ])('a lawful qualifier NEVER rescues the disease noun in "%s"', (text) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });
    expect(c6On(l, 'bullets[0]').length).toBeGreaterThan(0);
  });

  /** TIER 2 — an abnormality marker shots a natural state AND a qualifier. */
  const MARKER_PAIRS: [string, string][] = [
    ['Supports comfort during menopause', 'Supports comfort during severe menopause'],
    ['Helps prevent mild memory loss associated with aging', 'Helps prevent mild clinical memory loss associated with aging'],
    ['Helps with mild mood changes associated with the menstrual cycle', 'Helps with mild mood changes associated with a menstrual cycle disorder'],
    ['Formulated for women in perimenopause and menopause', 'Formulated for women with abnormal menopause'],
    ['Made for the years around menopause', 'Made for diagnosed menopause syndrome'],
  ];

  it.each(MARKER_PAIRS)('lawful: "%s"', (lawful) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${lawful}*`; });
    expect(c22On(l, 'bullets[0]')).toEqual([]);
  });

  it.each(MARKER_PAIRS)('…but the marked form of it FAILS: "%s" -> "%s"', (_lawful, marked) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${marked}*`; });
    expect(c22On(l, 'bullets[0]').length).toBeGreaterThan(0);
  });

  /**
   * TIER 3 — the lawful qualifier is the LAST tier: it operates only inside
   * C22's therapeutic-action rule, and only when it is adjacent to the state
   * with no action verb between the two. A sentence that opens with a
   * safe-harbour word and then acts on the state is not laundered by it.
   */
  it.each([
    ['Helps prevent mild memory loss associated with aging', true],
    ['Helps prevent memory loss', false],
    ['Supports normal comfort during menopause', true],
    ['Supports daily comfort and cures aging', false],
    ['Helps with mild mood changes associated with the menstrual cycle', true],
    ['Stops the menstrual cycle', false],
  ] as [string, boolean][])('"%s" — lawful: %s', (text, lawful) => {
    const l = mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });
    const hits = c22On(l, 'bullets[0]');
    if (lawful) expect(hits).toEqual([]);
    else expect(hits.length).toBeGreaterThan(0);
  });

  /**
   * The check is FAIL-CLOSED on its own data: with the natural-state lists
   * emptied the therapeutic-action claim is no longer reported by C22, which
   * is exactly why those lists are required manifest pieces (asserted in
   * `tests/redteam4.gate.test.ts`).
   */
  it('emptying the natural-state lists disarms C22 — hence the manifest rows', () => {
    const broken = JSON.parse(JSON.stringify(pack)) as typeof pack;
    for (const cp of [broken.compliancePack!, ...(broken.crossCheckCompliancePacks ?? [])]) {
      cp.naturalStates = [];
      cp.normalSymptomologyNouns = [];
      cp.abnormalOnlySymptomNouns = [];
      cp.abnormalityMarkers = [];
    }
    const l = mut((x) => { x.bullets[0] = 'Good to know: Cures aging*'; });
    expect(c22NaturalState(l, broken).length).toBe(0);
    // …and the gate still refuses to pass, because the manifest fails closed.
    expect(runGate(l, broken, ctx).failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });
});

/**
 * THE TWO SYMPTOM TIERS — the distinction that keeps the check from becoming a
 * wall. FDA permits a structure/function claim to address the NORMAL
 * symptomology of a natural state, so acting on an ordinary symptom is lawful;
 * only its ABNORMAL form is a disease claim. A symptom word whose UNQUALIFIED
 * form names a disease (memory loss ~ dementia) is the exception and is held to
 * the stricter rule.
 */
describe('the two symptom tiers behave differently, by design', () => {
  const c22On = (l: OptimizedListing, field: string): Failure[] =>
    c22NaturalState(l, pack).filter((f) => f.field === field);
  const plant = (text: string): OptimizedListing =>
    mut((x) => { x.bullets[0] = `Good to know: ${text}*`; });

  it.each([
    'Helps reduce hot flashes',
    'Eases night sweats through the day',
    'Helps calm mood swings',
    'Relieves menstrual cramps',
    'Reduces occasional sleeplessness',
  ])('a lawful action on ordinary normal symptomology passes: "%s"', (text) => {
    expect(c22On(plant(text), 'bullets[0]')).toEqual([]);
  });

  it.each([
    'Helps reduce severe hot flashes',
    'Eases chronic night sweats',
    'For clinical mood swings',
    'Relieves menstrual cramps caused by a diagnosed disorder',
  ])('…but the ABNORMAL form of the same symptom fails: "%s"', (text) => {
    expect(c22On(plant(text), 'bullets[0]').length).toBeGreaterThan(0);
  });

  it.each([
    'Helps prevent memory loss',
    'Reverses memory loss in adults',
  ])('a symptom whose unqualified form names a disease still fails: "%s"', (text) => {
    expect(c22On(plant(text), 'bullets[0]').length).toBeGreaterThan(0);
  });

  it.each([
    'Helps prevent mild memory loss associated with aging',
    'Supports mild memory loss associated with the natural aging process',
  ])('…and passes once it is qualified as the mild, natural form: "%s"', (text) => {
    expect(c22On(plant(text), 'bullets[0]')).toEqual([]);
  });
});

// ===========================================================================
// PREVENTION — the approved claim shapes reach the generator
// ===========================================================================

describe('the approved claim templates are injected into the system prompt', () => {
  it.each([
    ['supplements', pack],
    ['cosmetics', cosmetics],
  ] as const)('%s: every template appears verbatim in the rendered prompt', (_id, p) => {
    const templates = p.compliancePack?.approvedClaimTemplates ?? [];
    expect(templates.length).toBeGreaterThan(0);
    const prompt = buildSystemPrompt(p, clean.facts, ['probiotic']);
    const missing = templates.filter((t) => !prompt.includes(t));
    expect(missing, 'every approved claim shape must reach the generator').toEqual([]);
  });

  it.each([
    ['supplements', pack],
    ['cosmetics', cosmetics],
  ] as const)('%s: the safe-harbour qualifiers and abnormality markers are injected too', (_id, p) => {
    const prompt = buildSystemPrompt(p, clean.facts, ['probiotic']);
    for (const q of p.compliancePack?.lawfulQualifiers ?? []) expect(prompt).toContain(q);
    for (const m of p.compliancePack?.abnormalityMarkers ?? []) expect(prompt).toContain(m);
  });

  it('a pack with no approved templates renders no block (and does not crash)', () => {
    const stripped = JSON.parse(JSON.stringify(pack)) as typeof pack;
    stripped.compliancePack!.approvedClaimTemplates = [];
    expect(buildSystemPrompt(stripped, clean.facts, ['probiotic'])).not.toContain(
      'APPROVED CLAIM SHAPES',
    );
  });
});
