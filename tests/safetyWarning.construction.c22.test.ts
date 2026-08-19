import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c22NaturalState, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { CompliancePack, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';
import { withCoherentKeywords } from './fixtures/coherentKeywords';

/**
 * C22 — THE MANDATED SAFETY WARNING IS A CONSTRUCTION, NOT A LIST OF WORDINGS.
 *
 * `safety_warning` is a REQUIRED field of the supplements attribute template, so
 * C23 forces the listing to carry the consult-a-professional warning and C22's
 * abnormality-marker rule (R1) then failed it — an UNSATISFIABLE pair no repair
 * could clear without deleting text the template requires. It happened three
 * times, on three different wordings of the same warning:
 *
 *   1. "Women who are pregnant or nursing … managing a health concern, should
 *      talk with a physician"          (fixed by the R3 advisory escape)
 *   2. "If you are pregnant, nursing, have a KNOWN medical condition, or take
 *      medication"                     (fixed by one more `naturalStateSafePhrases` entry)
 *   3. "…if pregnant, nursing, taking medication, or MANAGING a medical
 *      condition, and keep out of reach"   (live, ASIN B00IO89MYA — this file)
 *
 * Each fix enumerated one more phrasing and each lost to the next paraphrase.
 * The fix under test is STRUCTURAL: the warning is recognised by its GRAMMATICAL
 * SHAPE — a CONDITION clause enumerating states the READER may be in
 * (`advisoryConditionCues`), governed by a RECOMMENDATION to consult a
 * professional (`advisoryCueVerbs` + `advisoryProfessionalNouns`). Every word of
 * it is pack data; the gate holds only the sentence arithmetic.
 *
 * The decisive test is `NOVEL_PARAPHRASES` below: ordinary rewordings of the
 * same warning that NO pack list contains, written for this file. If the fix
 * were enumerative they would all fail.
 */

const pack = loadPack('supplements');
const cosmetics = loadPack('cosmetics');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * The SAME pack with the condition-cue class emptied — i.e. the construction
 * rule switched off, every other list (including `naturalStateSafePhrases`)
 * untouched. Used to prove that it is the CONSTRUCTION and not the enumerated
 * safe-phrase list that clears the novel paraphrases.
 */
const stripCues = (cp: CompliancePack): CompliancePack => ({ ...cp, advisoryConditionCues: [] });
const packWithoutConstruction: KnowledgePack = {
  ...pack,
  compliancePack: pack.compliancePack ? stripCues(pack.compliancePack) : pack.compliancePack,
  crossCheckCompliancePacks: (pack.crossCheckCompliancePacks ?? []).map(stripCues),
};

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return withCoherentKeywords(withCoherentBulletFlags(copy));
};

/**
 * The surfaces the warning actually reaches on a live run. `description` is
 * where B00IO89MYA's failure was reported; `attributes.safety_warning` is the
 * required field the template forces; the Q&A answer is a third generated
 * surface C22 reads. Assertions are made against `c22NaturalState` directly so
 * that unrelated LENGTH/FORMAT checks on a long planted string cannot mask the
 * result — the whole-gate direction is asserted separately below.
 */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['description', (l, s) => { l.description = `${l.description} ${s}`; }],
  ['attributes.safety_warning', (l, s) => { l.attributes.safety_warning = s; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: s, claimBearing: false }; }],
];

const c22On = (l: OptimizedListing, field: string, p: KnowledgePack = pack) =>
  c22NaturalState(l, p).filter((f) => f.field === field);

// ===========================================================================
// DIRECTION 1 — the mandated warning, in every wording, is never flagged
// ===========================================================================

/** The exact live string from ASIN B00IO89MYA, in the sentence it was written in. */
const LIVE =
  'Consult your healthcare provider before use if pregnant, nursing, taking medication, or managing a medical condition, and keep out of reach of children.';

/** The two wordings the earlier point-fixes were written for. They must stay clean. */
const HISTORICAL = [
  'Women who are pregnant or nursing, and anyone currently taking medication or managing a health concern, should talk with a physician before adding any new daily capsule to their routine.',
  'If you are pregnant, nursing, have a known medical condition, or take medication, consult your physician before use.',
];

/**
 * ORDINARY PARAPHRASES OF THE SAME WARNING, written for this test and present in
 * NO pack list. This is the test that the fix is structural: an enumerative fix
 * cannot pass a wording nobody enumerated.
 */
const NOVEL_PARAPHRASES = [
  'Speak with your doctor before use if you are pregnant, nursing, managing a medical condition, or taking prescription medication.',
  'Anyone who is pregnant, breastfeeding, or living with a chronic medical condition should check with a healthcare professional before starting this product.',
  'If you are nursing, pregnant, or under care for a diagnosed condition, ask your physician first.',
  'Before taking this product, discuss with your pharmacist if you are pregnant, nursing, or have been diagnosed with a medical condition.',
  'If you are nursing or have a diagnosed condition, talk with your doctor.',
  'Women who are pregnant or nursing should ask a healthcare professional before use, especially if they are also managing a diagnosed medical condition.',
  'Keep out of reach of children; if you are nursing or being treated for any chronic condition, consult a physician before use.',
];

describe('C22 — the live B00IO89MYA safety warning is clean', () => {
  for (const [field, plant] of SURFACES) {
    it(`the live warning raises no C22 failure on ${field}`, () => {
      expect(c22On(mut((x) => plant(x, LIVE)), field)).toEqual([]);
    });
  }

  it('the whole gate is green with the live warning in the required safety_warning field', () => {
    const l = mut((x) => { x.attributes.safety_warning = LIVE; });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('the live warning is clean under the cosmetics pack too', () => {
    expect(c22On(mut((x) => { x.attributes.safety_warning = LIVE; }), 'attributes.safety_warning', cosmetics)).toEqual([]);
  });
});

describe('C22 — the two previously-fixed wordings stay clean', () => {
  for (const text of HISTORICAL) {
    for (const [field, plant] of SURFACES) {
      it(`"${text.slice(0, 48)}…" is clean on ${field}`, () => {
        expect(c22On(mut((x) => plant(x, text)), field)).toEqual([]);
      });
    }
  }
});

describe('C22 — ordinary paraphrases no list contains are clean (the structural test)', () => {
  for (const text of NOVEL_PARAPHRASES) {
    for (const [field, plant] of SURFACES) {
      it(`"${text.slice(0, 48)}…" is clean on ${field}`, () => {
        expect(c22On(mut((x) => plant(x, text)), field)).toEqual([]);
      });
    }
  }

  it('all seven paraphrases together in one listing leave the gate green', () => {
    const l = mut((x) => {
      x.qa = NOVEL_PARAPHRASES.map((a) => ({ q: 'What should I know?', a, claimBearing: false }));
    });
    expect(c22NaturalState(l, pack)).toEqual([]);
  });

  /**
   * THE PROOF THAT IT IS THE CONSTRUCTION DOING THE WORK. With
   * `advisoryConditionCues` emptied — and `naturalStateSafePhrases` and every
   * other list left exactly as shipped — every one of these paraphrases fails
   * again. The enumerated safe-phrase list does not cover a single one of them.
   */
  it.each(NOVEL_PARAPHRASES)(
    'without the condition-cue class, "%s" fails again — so no enumerated phrase is covering it',
    (text) => {
      const l = mut((x) => { x.attributes.safety_warning = text; });
      expect(c22On(l, 'attributes.safety_warning', packWithoutConstruction).length).toBeGreaterThan(0);
    },
  );

  it('the live warning is likewise cleared by the construction, not by a listed phrase', () => {
    const l = mut((x) => { x.attributes.safety_warning = LIVE; });
    expect(c22On(l, 'attributes.safety_warning', packWithoutConstruction).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// DIRECTION 2 — C22's real job is unweakened
// ===========================================================================

/**
 * GENUINE ABNORMALITY CLAIMS. The first group is bare copy — no advisory
 * anywhere, so the construction never applies. The second group is the
 * LAUNDERING direction: the same claim wrapped in a real safety-warning
 * sentence. A marker that MODIFIES its neighbour shares its enumeration item,
 * which is what the exemption is denied on, so every one of them still fails.
 */
const MUST_FAIL_BARE: [string, string][] = [
  ['Treats abnormal menstrual cycles', 'abnormality marker beside a natural state'],
  ['For severe menopause symptoms', 'abnormality marker beside a natural state'],
  ['Clinical menopause disorder', 'abnormality marker beside a natural state'],
  ['Formulated for women with abnormal menopause', 'abnormality marker beside a natural state'],
  ['Made for diagnosed menopause syndrome', 'abnormality marker beside a natural state'],
  ['Relieves chronic mood disorder', 'two markers name an abnormal condition'],
  ['for diagnosed medical conditions', 'two markers name an abnormal condition'],
  ['Formulated for a chronic medical condition', 'two markers name an abnormal condition'],
];

const MUST_FAIL_DRESSED: [string, string][] = [
  [
    'Consult your doctor if you want relief from severe menopause symptoms.',
    'the marker modifies the state inside its own enumeration item',
  ],
  [
    'Anyone who has chronic menopause should talk with a physician.',
    'the marker modifies the state inside its own enumeration item',
  ],
  [
    'If you are pregnant or nursing, consult your doctor before using our formula for severe menopause symptoms.',
    'the claim rides in its own item alongside a genuine warning',
  ],
  [
    'If you are nursing, consult your doctor; our blend treats abnormal menstrual cycles.',
    'the claim is a separate sentence, so the construction never covers it',
  ],
  [
    'Ask your doctor about our formula for severe menopause symptoms.',
    'no condition cue — an advisory recommendation alone is not the construction',
  ],
  [
    'Anyone can ask their doctor about our chronic disorder formula.',
    'a bare addressee is not a condition clause — the relative head is required',
  ],
  [
    'Talk with your physician: our blend targets chronic menopause disorder.',
    'no condition cue',
  ],
];

describe('C22 — genuine abnormality claims still FAIL', () => {
  for (const [text, why] of [...MUST_FAIL_BARE, ...MUST_FAIL_DRESSED]) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" (${why}) FAILS on ${field}`, () => {
        expect(c22On(mut((x) => plant(x, text)), field).length).toBeGreaterThan(0);
      });
    }
  }

  it.each([...MUST_FAIL_BARE, ...MUST_FAIL_DRESSED])(
    '"%s" makes the WHOLE gate fail from the required safety_warning field',
    (text) => {
      const l = mut((x) => { x.attributes.safety_warning = text; });
      expect(runGate(l, pack, ctx).pass).toBe(false);
    },
  );
});

/**
 * PRECEDENCE IS UNTOUCHED. The construction scopes C22's abnormality-marker
 * rules and nothing else: a named DISEASE NOUN inside a perfectly-formed safety
 * warning is still failed by C6, and R3's therapeutic-action rule still fires on
 * a verb that shares the state's clause.
 */
describe('C22 — the construction never reaches C6 or R3', () => {
  it("a named disease inside a real warning is still failed by C6", () => {
    const l = mut((x) => {
      x.attributes.safety_warning =
        "Consult your physician if you are pregnant or nursing, or if you have Alzheimer's disease.";
    });
    const failures = runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C6');
    expect(failures.length).toBeGreaterThan(0);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('R3 still denies a therapeutic verb sharing the state\'s clause', () => {
    const l = mut((x) => { x.qa[0] = { q: 'What should I know?', a: 'Reverses aging, talk to your doctor.', claimBearing: false }; });
    expect(c22On(l, 'qa[0].a').length).toBeGreaterThan(0);
  });
});
