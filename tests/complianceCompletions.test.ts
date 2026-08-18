import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { candidateTerms } from '@/lib/audit/candidateTerms';
import { buildSubstantiationRegister } from '@/lib/audit/substantiation';
import { optimize } from '@/lib/engine/optimize';
import { normalizeListingTypography, toAsciiTypography } from '@/lib/engine/typography';
import { buildShipSheet } from '@/lib/export/shipSheet';
import {
  a5AplusPotencyPhrasing,
  c10PotencyPhrasing,
  c12FactConsistency,
  c17Style,
  c24DosageAttributeGuard,
  c26ActiveIngredientSubset,
  c27OutputHygiene,
  type GateContext,
} from '@/lib/gate/checks';
import {
  extractUnitNumbers,
  spelledOutFigureReader,
  type SpelledOutFigureReader,
} from '@/lib/gate/checks/shared';
import { normalize } from '@/lib/gate/util';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { withOperatorFictionPhrases } from '@/lib/knowledge/operatorInputs';
import { runPipeline } from '@/lib/pipeline/run';
import type { KnowledgePack, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS5 — COMPLIANCE COMPLETIONS, both directions for every rule.
 *
 * C24 (dosage attribute), C26 (active ⊆ full ingredients), C27 (output
 * hygiene), the substantiation register, the candidate-term proposer and the
 * per-run operator fiction phrases. Each new rule is asserted to FIRE on its
 * defect AND to stay silent on legitimate copy — a check that only ever fires
 * is over-blocking, which this project treats as exactly as severe as a bypass.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const idsOf = (l: OptimizedListing, p: KnowledgePack = pack): string[] =>
  runGate(l, p, ctx).failures.map((f) => f.checkId);
const clonePack = (): KnowledgePack => JSON.parse(JSON.stringify(pack)) as KnowledgePack;

// ===========================================================================
// C24 — dosage/strength/potency ATTRIBUTE may not assert a hero figure
// ===========================================================================

describe('C24 dosage-attribute guard (AM-1)', () => {
  it('PASSES the compliant fixture, whose dose attribute states a COUNT', () => {
    expect(clean.attributes.maximum_dosage).toBe('1 Capsule Daily');
    expect(c24DosageAttributeGuard(clean, pack)).toEqual([]);
    expect(idsOf(clean)).not.toContain('C24');
  });

  it('PASSES a legitimate serving size — the KEY does not name a dose', () => {
    const l = mut((x) => {
      x.attributes.serving_size = '2 Capsules';
    });
    expect(c24DosageAttributeGuard(l, pack)).toEqual([]);
  });

  it('PASSES a dose-KEYED attribute that asserts no hero unit', () => {
    for (const value of ['Vegetable Capsule', '2 Capsules Daily', 'Do not exceed 2 capsules']) {
      const l = mut((x) => {
        x.attributes.maximum_dosage = value;
      });
      expect(c24DosageAttributeGuard(l, pack), value).toEqual([]);
    }
  });

  it('FAILS a dosage attribute asserting a number + a hero unit', () => {
    const l = mut((x) => {
      x.attributes.maximum_dosage = '15 Billion CFU';
    });
    const failures = c24DosageAttributeGuard(l, pack);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.field).toBe('attributes.maximum_dosage');
    expect(idsOf(l)).toContain('C24');
  });

  it('FAILS even when the number is the CANONICAL one (this is the whole point)', () => {
    const l = mut((x) => {
      x.attributes.maximum_dosage = '50 Billion CFU'; // === facts.potency
    });
    expect(l.facts.potency).toBe('50 Billion CFU');
    expect(c24DosageAttributeGuard(l, pack)).toHaveLength(1);
    // C12 sees no conflict — which is exactly why C24 has to exist.
    expect(idsOf(l)).not.toContain('C12');
  });

  /**
   * ============================================================================
   * N2 — THE PARITY LIMITATION IS CLOSED, AS A FLAGGED ADDITION.
   * ============================================================================
   *
   * WHAT THIS TEST USED TO SAY. It pinned the opposite behaviour: the check was
   * DIGIT-ANCHORED, exactly as the harness kit's `checkC24` is, so
   * `maximum_dosage: "Fifty Billion CFU"` PASSED while `"50 Billion CFU"`
   * failed. C12 did not catch it either — its scan is unit-anchored on digits
   * for the same reason. The limitation was recorded in
   * CONFORMANCE-DEVIATIONS.md item 2 and pinned here so it could not be
   * rediscovered as a finding, and item 2 stated the conditions any future fix
   * would have to meet.
   *
   * WHY IT IS NOW CLOSED. Those two strings are the SAME assertion in the SAME
   * filter-fed field. C24's objection is to stating a hero figure AS A DOSE in
   * structured data, and the script the figure is written in has nothing to do
   * with that objection. Kit parity was worth keeping only for as long as the
   * divergence was undocumented; item 2 is now rewritten to record this as an
   * INTENTIONAL improvement over the kit, with the reason.
   *
   * The three conditions item 2 set are met and are asserted below:
   *   - the number vocabulary is PACK DATA (`attributeGuard.spelledOutNumbers`),
   *     never a literal in the gate — `tests/category.literals.test.ts` still
   *     passes;
   *   - both directions are tested: the spelled-out hero figure FAILS, and
   *     ordinary number-word dose language still PASSES;
   *   - the record is updated in the same commit as the code.
   */
  it('N2 (was a recorded limitation): a SPELLED-OUT hero figure now FAILS, like the digits', () => {
    const digits = mut((x) => {
      x.attributes.maximum_dosage = '50 Billion CFU';
    });
    const words = mut((x) => {
      x.attributes.maximum_dosage = 'Fifty Billion CFU';
    });
    expect(c24DosageAttributeGuard(digits, pack)).toHaveLength(1);
    const wordFailures = c24DosageAttributeGuard(words, pack);
    expect(wordFailures).toHaveLength(1);
    expect(wordFailures[0]!.field).toBe('attributes.maximum_dosage');
    expect(idsOf(words)).toContain('C24');
    // C12 reads the same vocabulary now (N3, below), and it AGREES with this
    // value: "Fifty Billion CFU" resolves to the same number as the canonical
    // "50 Billion CFU", so the fact-consistency check is silent and only C24
    // objects — which is the whole point of C24 existing separately.
    expect(clean.facts.potency).toBe('50 Billion CFU');
    expect(idsOf(words)).not.toContain('C12');
  });

  it('N2: every spelled-out shape of the hero figure fails', () => {
    for (const value of [
      'Fifty Billion CFU',
      'fifty billion cfu',
      'Fifty-Billion CFU',
      'Five Hundred mg',
      'Twenty Five mg',
      'Twenty-five mg',
      'Two Thousand IU',
      'One Billion CFU',
      'Ninety Billion',
      'Five hundred mcg per capsule',
    ]) {
      const l = mut((x) => {
        x.attributes.maximum_dosage = value;
      });
      expect(c24DosageAttributeGuard(l, pack).map((f) => f.field), value).toEqual([
        'attributes.maximum_dosage',
      ]);
    }
  });

  /**
   * THE OTHER DIRECTION, and the one that actually decides whether this change
   * was worth making. Words like "one", "two" and "thirty" are everywhere in
   * legitimate dose-form and direction language, and a widening that fails any
   * of these would be over-blocking — treated in this project as exactly as
   * severe as a bypass.
   */
  it('N2: ordinary number-word dose language still PASSES, in a dosage-KEYED attribute', () => {
    for (const value of [
      'One Capsule Daily',
      'one capsule daily',
      'Take one capsule daily with water',
      'Two Capsules',
      'two servings',
      'Two servings per day',
      'thirty day supply',
      'Thirty Day Supply',
      'Do not exceed two capsules in twenty four hours',
      'One softgel in the morning and one in the evening',
      'Two gummies daily for adults',
      'Ten gummies per pouch',
      'Vegetable Capsule',
      'One scoop',
      'Three tablets',
    ]) {
      const l = mut((x) => {
        x.attributes.maximum_dosage = value;
      });
      expect(c24DosageAttributeGuard(l, pack), value).toEqual([]);
    }
  });

  it('N2: a value that merely NAMES its unit is not read as a figure (cardinal must lead)', () => {
    for (const value of ['Billion CFU', 'Million CFU', 'mg', 'Billion', 'CFU per serving']) {
      const l = mut((x) => {
        x.attributes.maximum_dosage = value;
      });
      expect(c24DosageAttributeGuard(l, pack), value).toEqual([]);
    }
  });

  it('N2: a number word must be joined to a HERO unit — a count or day unit is not one', () => {
    // The guarded dimension is `potency`. `capsule`, `count` and `day` live in
    // other dimensions, which is what makes this widening narrow rather than a
    // general number-word scan.
    expect(pack.rules.attributeGuard!.unitDimensions).toEqual(['potency']);
    for (const value of ['Sixty Capsules', 'Thirty Days', 'Ninety Count', 'Two Tablets']) {
      const l = mut((x) => {
        x.attributes.maximum_dosage = value;
      });
      expect(c24DosageAttributeGuard(l, pack), value).toEqual([]);
    }
  });

  it('N2: the leg is scoped to dosage-KEYED attributes, exactly like the digit leg', () => {
    const l = mut((x) => {
      x.attributes.product_description_extra = 'Fifty Billion CFU blend of ten strains';
      x.attributes.serving_size = 'Two Capsules';
    });
    expect(c24DosageAttributeGuard(l, pack)).toEqual([]);
  });

  it('N2: the vocabulary is PACK DATA — removing it restores EXACT kit parity', () => {
    const kit = clonePack();
    delete kit.rules.attributeGuard!.spelledOutNumbers;
    const words = mut((x) => {
      x.attributes.maximum_dosage = 'Fifty Billion CFU';
    });
    const digits = mut((x) => {
      x.attributes.maximum_dosage = '50 Billion CFU';
    });
    // words pass (the kit's behaviour), digits still fail (the kit's behaviour)
    expect(c24DosageAttributeGuard(words, kit)).toEqual([]);
    expect(c24DosageAttributeGuard(digits, kit)).toHaveLength(1);
    // ...and because it is a WIDENER, emptying it disarms nothing, so it is
    // deliberately not a manifest piece: the pack still passes PACK.
    expect(idsOf(digits, kit)).not.toContain('PACK');
  });

  it('N2: emptying just the cardinals is the same as removing the block', () => {
    const kit = clonePack();
    kit.rules.attributeGuard!.spelledOutNumbers = { cardinals: {}, magnitudes: { billion: 1e9 } };
    const words = mut((x) => {
      x.attributes.maximum_dosage = 'Fifty Billion CFU';
    });
    expect(c24DosageAttributeGuard(words, kit)).toEqual([]);
  });

  it('N2: the golden fixture is untouched by the new leg', () => {
    expect(c24DosageAttributeGuard(clean, pack)).toEqual([]);
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
  });

  it('covers every key shape the pack pattern names', () => {
    for (const key of ['maximum_dosage', 'product_strength', 'potency_level', 'dose_per_unit']) {
      const l = mut((x) => {
        x.attributes[key] = '500 mg';
      });
      expect(c24DosageAttributeGuard(l, pack).map((f) => f.field), key).toEqual([
        `attributes.${key}`,
      ]);
    }
  });

  it('is PACK-DRIVEN: no guard data, no rule — and the manifest fails the pack closed', () => {
    const bare = clonePack();
    delete bare.rules.attributeGuard;
    const l = mut((x) => {
      x.attributes.maximum_dosage = '15 Billion CFU';
    });
    expect(c24DosageAttributeGuard(l, bare)).toEqual([]);
    expect(idsOf(l, bare)).toContain('PACK');
  });
});

// ===========================================================================
// C12 — the SPELLED-OUT hero figure (N3)
// ===========================================================================

/**
 * ============================================================================
 * N3 — C12 IS NO LONGER DIGIT-ANCHORED. This closes the limitation N2 recorded.
 * ============================================================================
 *
 * WHAT THE RECORD USED TO SAY. CONFORMANCE-DEVIATIONS.md item 2.4 closed the
 * C24 half and stated plainly that "C12 is untouched and remains
 * digit-anchored", because C12's scope is the whole listing rather than one
 * pack-matched attribute key. The consequence was concrete and worse than the
 * one N2 fixed: a bullet or description reading "Fifty Billion CFU per serving"
 * against a different canonical potency was invisible to the gate — an
 * OVERSTATED POTENCY CLAIM shipping in customer-facing copy, which is the exact
 * class C12 exists to prevent.
 *
 * WHAT CHANGED. C12 now reads the SAME pack vocabulary C24 reads
 * (`rules.attributeGuard.spelledOutNumbers`), compiled by the SAME function
 * (`spelledOutRunSource` / `spelledOutFigureReader` in `lib/gate/checks/shared.ts`).
 * One vocabulary, one compiler, two callers — there is no second copy to drift.
 *
 * THE RISK IS OVER-BLOCKING, and it is larger here than it was for C24 because
 * ordinary supplement prose is full of number words. The bounds asserted below:
 * a HERO (potency) unit is still required, so count/day/serving language can
 * never match; a cardinal must lead; the separator is required; and the VALUE
 * is composed exactly as the digit scan composes it, so TRUTHFUL word-form copy
 * passes.
 */
describe('C12 reads a SPELLED-OUT hero figure (N3)', () => {
  const wrongPotencyWords = 'Ninety Billion CFU per serving of live cultures';
  const wrongPotencyDigits = '90 Billion CFU per serving of live cultures';

  it('N3 (was a recorded limitation): an overstated potency SPELLED OUT in a bullet now FAILS', () => {
    expect(clean.facts.potency).toBe('50 Billion CFU');
    const words = mut((x) => {
      x.bullets[0] = wrongPotencyWords;
    });
    const failures = c12FactConsistency(words, pack);
    expect(failures.map((f) => f.field)).toContain('bullets[0]');
    expect(failures.some((f) => /Ninety Billion CFU/i.test(f.context))).toBe(true);
    expect(idsOf(words)).toContain('C12');
  });

  it('N3: the word form and the digit form are reported identically', () => {
    const words = mut((x) => {
      x.bullets[0] = wrongPotencyWords;
    });
    const digits = mut((x) => {
      x.bullets[0] = wrongPotencyDigits;
    });
    const w = c12FactConsistency(words, pack).filter((f) => f.field === 'bullets[0]');
    const d = c12FactConsistency(digits, pack).filter((f) => f.field === 'bullets[0]');
    expect(w).toHaveLength(1);
    expect(d).toHaveLength(1);
    expect(w[0]!.checkId).toBe(d[0]!.checkId);
    // same objection, same canonical fact cited — only the quoted figure
    // differs, because each message quotes the text it actually read.
    expect(w[0]!.fix.replace(/'Ninety Billion CFU'/i, "'90 Billion CFU'")).toBe(d[0]!.fix);
    expect(d[0]!.fix).toContain("facts.potency '50 Billion CFU'");
  });

  it('N3: every surface C12 already reads is covered — description, A+ and attributes', () => {
    const cases: [string, (l: OptimizedListing) => void][] = [
      ['description', (x) => { x.description = `<p>${wrongPotencyWords}</p>`; }],
      ['aplus.modules[hero].body', (x) => { x.aplusContent!.modules[1]!.body = wrongPotencyWords; }],
      ['attributes.product_benefit', (x) => { x.attributes.product_benefit = wrongPotencyWords; }],
      ['qa[0].a', (x) => { x.qa[0]!.a = wrongPotencyWords; }],
    ];
    for (const [field, mutate] of cases) {
      const l = mut(mutate);
      expect(c12FactConsistency(l, pack).map((f) => f.field), field).toContain(field);
    }
  });

  it('N3: the A+ "typical" column stays exempt — those figures are not ours', () => {
    const l = mut((x) => {
      x.aplusContent!.comparison!.rows[0]!.typical = wrongPotencyWords;
    });
    expect(c12FactConsistency(l, pack)).toEqual([]);
  });

  /**
   * THE VALUE MUST COMPOSE EXACTLY AS THE DIGITS DO. "Fifty Billion CFU" is
   * FIFTY of the compound unit "Billion CFU", not fifty thousand million of
   * them — the same reading the digit scan gives "50 Billion CFU". A greedy
   * word run would swallow "Billion" as a MAGNITUDE, report 50,000,000,000 and
   * fail this truthful bullet. This test is the guard on that.
   */
  it('N3: TRUTHFUL word-form copy PASSES — the compound unit is not read as a magnitude', () => {
    for (const value of [
      'Fifty Billion CFU per serving',
      'fifty billion cfu per serving',
      'Fifty-Billion CFU blend',
      'A Fifty Billion CFU blend of ten strains',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
    }
  });

  it('N3: magnitude composition matches the digit scan', () => {
    const truthful = mut((x) => {
      x.facts.potency = '500 mg';
      x.bullets[0] = 'Five Hundred mg of the botanical blend';
    });
    expect(c12FactConsistency(truthful, pack)).toEqual([]);
    const overstated = mut((x) => {
      x.facts.potency = '500 mg';
      x.bullets[0] = 'Two Thousand mg of the botanical blend';
    });
    const failures = c12FactConsistency(overstated, pack).filter((f) => f.field === 'bullets[0]');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.context).toMatch(/Two Thousand mg/i);
  });

  /**
   * THE OTHER DIRECTION, and the one that decides whether this was worth doing.
   * Over-blocking is treated in this project as exactly as severe as a bypass,
   * and C12's scope is every customer surface, so ordinary supplement prose is
   * the real risk. None of these may fail.
   */
  it('N3: ordinary supplement prose still PASSES on a customer surface', () => {
    for (const value of [
      'one capsule daily',
      'One Capsule Daily',
      'two servings',
      'Two servings per day',
      'thirty day supply',
      'Thirty Day Supply',
      'take one to two capsules',
      'Take one to two capsules with water',
      'sixty capsules, one month supply',
      'one a day',
      'One a day, every day',
      'one hundred percent plant based',
      'One Hundred Percent Plant Based',
      'ten strains',
      'Ten strains of live cultures',
      'a one-time purchase',
      'A one-time purchase, no subscription needed',
      'first-time customers',
      'For first-time customers and long-time users alike',
      'Twenty four hours of digestive comfort',
      'Do not exceed two capsules in twenty four hours',
      'One softgel in the morning and one in the evening',
      'Ten gummies per pouch',
      'Three tablets, two times a day',
      'Sixty vegetable capsules provide a two month supply',
      'Fifty percent more than the previous size',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
    }
  });

  it('N3: a cardinal must LEAD — a value that merely names its unit is not a figure', () => {
    for (const value of [
      'Billion CFU',
      'Billion CFU per serving',
      'Million CFU',
      'Measured in Billion CFU',
      'CFU per serving',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
    }
  });

  /**
   * THE BOUND THAT KEEPS IT NARROW. The word leg is restricted to the pack's
   * HERO dimension, so a count or a day figure written in words is deliberately
   * NOT read — which is exactly why "thirty day supply" and "sixty capsules"
   * above cannot fail. The digit halves of the same two sentences still fail,
   * which is what makes this a deliberate narrowing rather than an accident.
   */
  it('N3: the leg requires a HERO unit — count and day figures stay digit-only', () => {
    expect(pack.rules.attributeGuard!.unitDimensions).toEqual(['potency']);
    expect(clean.facts.unitCount).toBe(60);
    expect(clean.facts.daySupply).toBe(60);
    for (const [words, digits] of [
      ['Ninety Capsules per bottle', '90 Capsules per bottle'],
      ['A thirty day supply in every bottle', 'A 30 day supply in every bottle'],
    ]) {
      const wordListing = mut((x) => {
        x.bullets[0] = words!;
      });
      const digitListing = mut((x) => {
        x.bullets[0] = digits!;
      });
      expect(
        c12FactConsistency(wordListing, pack).filter((f) => f.field === 'bullets[0]'),
        words,
      ).toEqual([]);
      expect(
        c12FactConsistency(digitListing, pack).filter((f) => f.field === 'bullets[0]').length,
        digits,
      ).toBe(1);
    }
  });

  /**
   * The ingredient breakdown is read with the SAME reader as the copy it
   * exempts. A one-sided reader would be over-blocking: an attributed word-form
   * figure would be measured while the word-form declaration that licenses it
   * stayed invisible.
   */
  it('N3: an ATTRIBUTED word figure is exempt only when the breakdown declares it', () => {
    const undeclared = mut((x) => {
      x.bullets[0] = 'Bifidobacterium Ten Billion CFU supports regularity';
    });
    expect(
      c12FactConsistency(undeclared, pack).filter((f) => f.field === 'bullets[0]'),
    ).toHaveLength(1);
    const declaredInWords = mut((x) => {
      x.bullets[0] = 'Bifidobacterium Ten Billion CFU supports regularity';
      x.attributes.active_ingredients = `${x.attributes.active_ingredients}; Bifidobacterium Ten Billion CFU`;
    });
    expect(
      c12FactConsistency(declaredInWords, pack).filter((f) => f.field === 'bullets[0]'),
    ).toEqual([]);
  });

  /**
   * THE PACK-EMPTYING ASSERTION. The reader is a WIDENER: with no vocabulary
   * the check is byte-for-byte the digit-anchored scan it was before N3 — the
   * word form goes back to passing and every digit figure is still caught. It
   * cannot be used to DISARM C12, which is why it is deliberately not a
   * manifest piece.
   */
  it('N3: the vocabulary is PACK DATA — emptying it restores the exact prior scan, it does not disarm C12', () => {
    const words = mut((x) => {
      x.bullets[0] = wrongPotencyWords;
    });
    const digits = mut((x) => {
      x.bullets[0] = wrongPotencyDigits;
    });
    for (const kit of [
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard!.spelledOutNumbers;
        return k;
      })(),
      (() => {
        const k = clonePack();
        k.rules.attributeGuard!.spelledOutNumbers = { cardinals: {}, magnitudes: { billion: 1e9 } };
        return k;
      })(),
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard;
        return k;
      })(),
    ]) {
      // the word form passes again — the pre-N3 behaviour, exactly
      expect(c12FactConsistency(words, kit)).toEqual([]);
      // ...and the digit leg is UNTOUCHED: C12 is narrowed, never disarmed
      expect(c12FactConsistency(digits, kit)).toEqual(c12FactConsistency(digits, pack));
      expect(c12FactConsistency(digits, kit).length).toBeGreaterThan(0);
      // the golden fixture still passes C12 under the narrowed pack
      expect(c12FactConsistency(clean, kit)).toEqual([]);
    }
  });

  it('N3: ONE vocabulary — the same pack lists drive C24 and C12', () => {
    const kit = clonePack();
    delete kit.rules.attributeGuard!.spelledOutNumbers;
    const attributeValue = mut((x) => {
      x.attributes.maximum_dosage = 'Fifty Billion CFU';
    });
    const copy = mut((x) => {
      x.bullets[0] = wrongPotencyWords;
    });
    // full pack: both checks read the words
    expect(c24DosageAttributeGuard(attributeValue, pack)).toHaveLength(1);
    expect(c12FactConsistency(copy, pack).length).toBeGreaterThan(0);
    // emptied: BOTH fall back together, which is what "one source" means
    expect(c24DosageAttributeGuard(attributeValue, kit)).toEqual([]);
    expect(c12FactConsistency(copy, kit)).toEqual([]);
  });

  /**
   * A STATED, INHERITED CONDITION — not a new one. The pack lists a bare
   * magnitude token as a hero unit in its own right, so rhetorical copy that
   * borrows it ("six billion reasons") reads as a figure. That was ALREADY true
   * of the digit scan; the word leg inherits it rather than introducing it, and
   * the two are asserted to behave identically so the property stays visible.
   * CONFORMANCE-DEVIATIONS.md item 2 records it as a false-positive condition.
   */
  it('N3: a rhetorical hero-unit token behaves exactly as the digit form already did', () => {
    const words = mut((x) => {
      x.bullets[0] = 'Six billion reasons to feel good every day';
    });
    const digits = mut((x) => {
      x.bullets[0] = '6 billion reasons to feel good every day';
    });
    const w = c12FactConsistency(words, pack).filter((f) => f.field === 'bullets[0]');
    const d = c12FactConsistency(digits, pack).filter((f) => f.field === 'bullets[0]');
    expect(w).toHaveLength(1);
    expect(d).toHaveLength(1);
  });

  it('N3: the golden fixture is untouched — still ZERO gate failures', () => {
    expect(c12FactConsistency(clean, pack)).toEqual([]);
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
  });
});

// ===========================================================================
// Y1 — the INERT CONNECTOR, and the FRAGMENT the reader must never resolve
// ===========================================================================

/**
 * ============================================================================
 * Y1 — A PROVEN BYPASS OF N3, FOUND BY ADVERSARIAL REVIEW.
 * ============================================================================
 *
 * WHAT WAS BROKEN. `"Delivers One Hundred and Fifty Billion CFU per serving"`
 * against a canonical `facts.potency` of `"50 Billion CFU"` produced ZERO
 * failures from the entire gate. `and` is not in the pack vocabulary and could
 * not be: `valueMap` keeps only entries whose `value > 0`, so an inert word
 * declared as a cardinal is dropped from the value table. The run pattern
 * therefore could not cross `and`, the reader fell back to the SUB-RUN
 * `"Fifty Billion CFU"`, composed 50, and — 50 being the canonical figure —
 * concluded the copy AGREED with the facts.
 *
 * That is worse than a miss. It is a MIS-MEASUREMENT: the gate affirmatively
 * measured a threefold overstatement as truthful. `"Two Hundred and Fifty
 * Billion CFU"` read as 50 the same way, and `"A Hundred Billion CFU"` evaded
 * the pattern entirely because an article cannot lead a run.
 *
 * TWO FIXES, and the second is the one that matters:
 *
 *  1. CONNECTORS are now pack data in their own right — a list of WORDS, since
 *     being valueless is what a connector IS and no `value > 0` filter can
 *     strip a word out of a string list. `lib/gate` names none of them.
 *  2. THE READER REFUSES A FRAGMENT. A run it cannot read WHOLE yields no
 *     figure at all rather than the value of part of itself. This is the fix
 *     for the CLASS: the fallback recurs with any vocabulary a pack lacks, so
 *     the guard is deliberately vocabulary-INDEPENDENT and is asserted below
 *     with the connector list emptied.
 */
describe('Y1 — connectors, and the fragment the reader refuses (C12)', () => {
  /** The three forms the reviewer proved, with what each must resolve to. */
  const bypasses: [string, number][] = [
    ['Delivers One Hundred and Fifty Billion CFU per serving', 150],
    ['Delivers Two Hundred and Fifty Billion CFU per serving', 250],
    ['A Hundred Billion CFU per serving', 100],
  ];

  const withoutConnectors = (): KnowledgePack => {
    const k = clonePack();
    delete k.rules.attributeGuard!.spelledOutNumbers!.connectors;
    return k;
  };

  // (a) --------------------------------------------------------------------
  it('Y1 (a): all three PROVEN bypasses now FAIL C12 against a contradicting canonical figure', () => {
    expect(clean.facts.potency).toBe('50 Billion CFU');
    for (const [copy] of bypasses) {
      const l = mut((x) => {
        x.bullets[0] = copy;
      });
      const failures = c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]');
      expect(failures.length, copy).toBe(1);
      expect(failures[0]!.fix, copy).toContain("facts.potency '50 Billion CFU'");
      expect(idsOf(l), copy).toContain('C12');
    }
  });

  it('Y1 (a): the whole gate reports them — the reviewer ran runGate, so this does too', () => {
    for (const [copy] of bypasses) {
      const l = mut((x) => {
        x.bullets[0] = copy;
      });
      expect(runGate(l, pack, ctx).failures.map((f) => f.checkId), copy).toContain('C12');
    }
  });

  // (b) --------------------------------------------------------------------
  /**
   * THE OVER-BLOCK DIRECTION, and the one that matters most. The same three
   * sentences are TRUTHFUL when the canonical fact matches, and a check that
   * fails truthful copy is as bad as one that misses a lie.
   */
  it('Y1 (b): the same three forms, TRUTHFUL, still PASS', () => {
    for (const [copy, value] of bypasses) {
      const words = mut((x) => {
        x.facts.potency = `${value} Billion CFU`;
        x.bullets[0] = copy;
      });
      // the bullet itself is silent...
      expect(
        c12FactConsistency(words, pack).filter((f) => f.field === 'bullets[0]'),
        copy,
      ).toEqual([]);
      // ...and the listing as a whole behaves EXACTLY as the digit form of the
      // same truthful sentence does. (The fixture's other surfaces state the
      // old 50, so raising the canonical figure moves them together — that is
      // the control, and it is the same for both scripts.)
      const digits = mut((x) => {
        x.facts.potency = `${value} Billion CFU`;
        x.bullets[0] = `Delivers ${value} Billion CFU per serving`;
      });
      expect(c12FactConsistency(words, pack), copy).toEqual(c12FactConsistency(digits, pack));
    }
  });

  it('Y1 (b): truthful in the OTHER script too — a word-form canonical FACT matches digit copy', () => {
    for (const [words, digits] of [
      ['One Hundred and Fifty Billion CFU', 150],
      ['Two Hundred and Fifty Billion CFU', 250],
      ['A Hundred Billion CFU', 100],
    ] as [string, number][]) {
      const l = mut((x) => {
        x.facts.potency = words;
        x.bullets[0] = `Delivers ${digits} Billion CFU per serving`;
      });
      expect(
        c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]'),
        words,
      ).toEqual([]);
    }
  });

  // (c) --------------------------------------------------------------------
  /**
   * THE VALUE IS THE WHOLE POINT. Each connector form must resolve to exactly
   * what the DIGIT scan yields for the same figure — not approximately, and not
   * merely "to something different from the canonical fact".
   */
  it('Y1 (c): word form and digit form resolve to the SAME number, asserted against the digit scan', () => {
    const reader = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    for (const [words, digits] of [
      ['One Hundred and Fifty Billion CFU', '150 Billion CFU'],
      ['Two Hundred and Fifty Billion CFU', '250 Billion CFU'],
      ['A Hundred Billion CFU', '100 Billion CFU'],
      ['one hundred and fifty billion cfu', '150 billion cfu'],
      ['Two Hundred and Fifty-Billion CFU', '250 Billion CFU'],
    ] as [string, string][]) {
      const word = reader.read(words);
      const digit = extractUnitNumbers(digits, pack.rules.units);
      expect(word.length, words).toBe(1);
      expect(digit.length, digits).toBe(1);
      expect(word[0]!.value, words).toBe(digit[0]!.value);
      expect(word[0]!.unit, words).toBe(digit[0]!.unit);
      expect(word[0]!.dimension, words).toBe(digit[0]!.dimension);
    }
  });

  it('Y1 (c): the three named values are 150, 250 and 100 exactly', () => {
    const reader = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    expect(reader.read('One Hundred and Fifty Billion CFU')[0]!.value).toBe(150);
    expect(reader.read('Two Hundred and Fifty Billion CFU')[0]!.value).toBe(250);
    expect(reader.read('A Hundred Billion CFU')[0]!.value).toBe(100);
    // and the composition rule generalises rather than special-casing the three
    expect(reader.read('A Thousand mg')[0]!.value).toBe(1000);
    expect(reader.read('Two Thousand and Five Hundred mg')[0]!.value).toBe(2500);
  });

  // (d) --------------------------------------------------------------------
  /**
   * THE ROOT CAUSE, AND THE CHOSEN SAFE BEHAVIOUR.
   *
   * A run the reader cannot read WHOLE returns NO figure. Not a fragment's
   * value, and not a failure either.
   *
   * WHY REFUSE RATHER THAN FAIL CLOSED. A failure here would be an assertion
   * about a figure the reader has just said it cannot read, and the shapes that
   * reach the guard include lawful prose — `"Ten Billion CFU and Fifty Billion
   * CFU"` is a list, `"Ten Billion and Fifty Billion CFU"` is ambiguous rather
   * than untrue. Emitting a failure on those is over-blocking, which this
   * project treats as exactly as severe as a bypass. Refusing is strictly safer
   * than what it replaces: it can never affirm a false figure as truthful and
   * it can never report a true one as false. The cost is COVERAGE, it is
   * bounded, and the other legs are still armed — C24 DETECTS the same string
   * in a dosage attribute and (Y2) C10/A5 detect it on customer copy, because
   * detection needs no composed value.
   *
   * The guard is asserted with the connector list EMPTIED, because that is the
   * state every future pack with a missing word is in.
   */
  it('Y1 (d): with connectors emptied, the and-form resolves to NOTHING — never to the fragment', () => {
    const kit = withoutConnectors();
    const reader = spelledOutFigureReader(kit.rules.units, kit.rules.attributeGuard)!;
    for (const text of [
      'One Hundred and Fifty Billion CFU',
      'Two Hundred and Fifty Billion CFU',
    ]) {
      // the pre-Y1 behaviour was `[{ value: 50 }]` — the sub-run, read as the figure
      expect(reader.read(text), text).toEqual([]);
    }
    // ...and the same holds through C12: no failure, and above all no failure
    // or silent pass that treats 50 as the figure this sentence states.
    const l = mut((x) => {
      x.bullets[0] = 'Delivers One Hundred and Fifty Billion CFU per serving';
    });
    expect(c12FactConsistency(l, kit)).toEqual([]);
  });

  it('Y1 (d): the refusal is vocabulary-INDEPENDENT — an unknown joiner is refused too', () => {
    const reader = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    for (const text of [
      'One Hundred plus Fifty Billion CFU', // a joiner no pack declares
      'Hundred Fifty Billion CFU', // a magnitude cannot lead, so `Fifty` would have
      'Two Hundred or Fifty Billion CFU',
      'Fifty and Sixty mg', // a connector English does not put there
    ]) {
      expect(reader.read(text), text).toEqual([]);
    }
  });

  it('Y1 (d): refusing is NARROW — a complete figure beside another quantity is still read', () => {
    const reader = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    // "Ten" belongs to "Strains": the numeral to the left is COMPLETE, so the
    // reading is not a fragment and must not be dropped.
    expect(reader.read('Ten Strains Fifty Billion CFU').map((n) => n.value)).toEqual([50]);
    expect(reader.read('Ten Strains, Fifty Billion CFU').map((n) => n.value)).toEqual([50]);
    expect(reader.read('A Fifty Billion CFU blend of ten strains').map((n) => n.value)).toEqual([50]);
    // a LIST of two complete figures is two readings, not a refusal
    expect(
      reader.read('Ten Billion CFU and Fifty Billion CFU').map((n) => n.value),
    ).toEqual([10, 50]);
    // and the coverage that costs nothing is still there: an overstated figure
    // sitting next to a strain count is still reported
    const l = mut((x) => {
      x.bullets[0] = 'Ten Strains Ninety Billion CFU';
    });
    expect(c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]')).toHaveLength(1);
  });

  // (e) --------------------------------------------------------------------
  /**
   * THE LAWFUL-PROSE BATTERY, extended with the sentences the CONNECTORS put at
   * risk. Connectors are the commonest words in English; the bound that keeps
   * them safe is the same one as before — a HERO unit is still required, and a
   * connector may never begin or end a run.
   */
  it('Y1 (e): connector-bearing lawful prose still PASSES', () => {
    for (const value of [
      'one and a half servings',
      'One and a half servings per day',
      'a hundred percent',
      'A hundred percent plant based',
      'take one and then another',
      'Take one and then another with water',
      'two and three',
      'Two and three capsule servings',
      'a one-time purchase',
      'A one-time purchase and a one-month supply',
      'One softgel in the morning and one in the evening',
      'Ten strains and a prebiotic blend',
      'A daily capsule and a nightly one',
      'An easy routine, one capsule and done',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
      expect(c10PotencyPhrasing(l, pack), value).toEqual([]);
    }
  });

  it('Y1 (e): the whole N3 lawful-prose battery is unchanged by the connector leg', () => {
    for (const value of [
      'one capsule daily',
      'two servings',
      'Two servings per day',
      'thirty day supply',
      'take one to two capsules',
      'sixty capsules, one month supply',
      'one a day',
      'one hundred percent plant based',
      'ten strains',
      'a one-time purchase',
      'first-time customers',
      'Twenty four hours of digestive comfort',
      'Ten gummies per pouch',
      'Three tablets, two times a day',
      'Sixty vegetable capsules provide a two month supply',
      'Fifty percent more than the previous size',
      'Billion CFU',
      'Billion CFU per serving',
      'Measured in Billion CFU',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
    }
  });

  // (f) --------------------------------------------------------------------
  it('Y1 (f): emptying the pack vocabulary restores EXACT digit-only behaviour', () => {
    const digits = mut((x) => {
      x.bullets[0] = 'Delivers 150 Billion CFU per serving';
    });
    const words = mut((x) => {
      x.bullets[0] = 'Delivers One Hundred and Fifty Billion CFU per serving';
    });
    for (const kit of [
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard!.spelledOutNumbers;
        return k;
      })(),
      (() => {
        const k = clonePack();
        k.rules.attributeGuard!.spelledOutNumbers = { cardinals: {}, magnitudes: { billion: 1e9 }, connectors: ['and'] };
        return k;
      })(),
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard;
        return k;
      })(),
    ]) {
      expect(spelledOutFigureReader(kit.rules.units, kit.rules.attributeGuard)).toBeNull();
      // the word form is invisible again — the pre-N3 digit-anchored scan
      expect(c12FactConsistency(words, kit)).toEqual([]);
      expect(c10PotencyPhrasing(words, kit)).toEqual([]);
      // ...and every digit figure is caught EXACTLY as it is under the full pack
      expect(c12FactConsistency(digits, kit)).toEqual(c12FactConsistency(digits, pack));
      expect(c10PotencyPhrasing(digits, kit)).toEqual(c10PotencyPhrasing(digits, pack));
      expect(c12FactConsistency(digits, kit).length).toBeGreaterThan(0);
      expect(c10PotencyPhrasing(digits, kit).length).toBeGreaterThan(0);
      expect(c12FactConsistency(clean, kit)).toEqual([]);
      expect(c10PotencyPhrasing(clean, kit)).toEqual([]);
    }
  });

  it('Y1 (f): emptying ONLY the connectors narrows the reader — it does not reopen the fragment', () => {
    const kit = withoutConnectors();
    const digits = mut((x) => {
      x.bullets[0] = 'Delivers 150 Billion CFU per serving';
    });
    // the plain word form is untouched by the connector list
    const plain = mut((x) => {
      x.bullets[0] = 'Delivers Ninety Billion CFU per serving';
    });
    expect(c12FactConsistency(plain, kit)).toEqual(c12FactConsistency(plain, pack));
    expect(c12FactConsistency(digits, kit)).toEqual(c12FactConsistency(digits, pack));
    // the and-form is not measured at all under the narrowed pack — and, above
    // all, is not measured AS FIFTY
    const l = mut((x) => {
      x.bullets[0] = 'Delivers One Hundred and Fifty Billion CFU per serving';
    });
    expect(c12FactConsistency(l, kit)).toEqual([]);
  });

  // (g) --------------------------------------------------------------------
  it('Y1 (g): the golden fixture is untouched — still ZERO gate failures', () => {
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
    expect(c12FactConsistency(clean, pack)).toEqual([]);
    expect(c10PotencyPhrasing(clean, pack)).toEqual([]);
    expect(a5AplusPotencyPhrasing(clean, pack)).toEqual([]);
  });
});

// ===========================================================================
// Y2 — C10/A5 read the SPELLED-OUT figure too
// ===========================================================================

/**
 * ============================================================================
 * Y2 — THE C10/A5 DECLINE, RE-DECIDED.
 * ============================================================================
 *
 * CONFORMANCE-DEVIATIONS.md 2.4.6 declined extending `potencyPhrasingOver`,
 * partly on the argument that the residue was bounded *because* "an untrue
 * word-form per-serving figure is now caught by C12". Y1 proved that argument
 * false as written: `"Delivers One Hundred and Fifty Billion CFU per serving"`
 * was untrue, was not caught by C12, and was not caught by C10/A5 either — the
 * two halves failed together on exactly the sentence shape the argument named.
 *
 * RE-DECIDED: EXTEND. C10/A5 are DETECTION rules — they object to attaching the
 * headline potency to a single dose whatever the number is — so they need no
 * composed value, which makes them the right home for precisely the residue
 * C12's fragment refusal must leave behind. Same pack vocabulary, same
 * compiler, no second copy.
 */
describe('Y2 — C10/A5 potency PHRASING reads the spelled-out figure', () => {
  it('Y2: a word-form per-serving attachment now FAILS C10, exactly as the digit form does', () => {
    for (const [words, digits] of [
      ['Delivers Fifty Billion CFU per serving', 'Delivers 50 Billion CFU per serving'],
      ['Fifty Billion CFU per serving of live cultures', '50 Billion CFU per serving of live cultures'],
      ['Delivers One Hundred and Fifty Billion CFU per serving', 'Delivers 150 Billion CFU per serving'],
    ] as [string, string][]) {
      const wordListing = mut((x) => {
        x.bullets[0] = words;
      });
      const digitListing = mut((x) => {
        x.bullets[0] = digits;
      });
      const w = c10PotencyPhrasing(wordListing, pack).filter((f) => f.field === 'bullets[0]');
      const d = c10PotencyPhrasing(digitListing, pack).filter((f) => f.field === 'bullets[0]');
      expect(w.length, words).toBe(d.length);
      expect(w.length, words).toBeGreaterThan(0);
      expect(w[0]!.fix, words).toBe(d[0]!.fix);
      expect(idsOf(wordListing), words).toContain('C10');
    }
  });

  it('Y2: the TRUE word-form figure is caught too — the attachment is the objection, not the number', () => {
    // 50 IS the canonical potency, so C12 has nothing to say. C10 still does.
    const l = mut((x) => {
      x.bullets[0] = 'Delivers Fifty Billion CFU per serving';
    });
    expect(c12FactConsistency(l, pack)).toEqual([]);
    expect(c10PotencyPhrasing(l, pack).length).toBeGreaterThan(0);
  });

  it('Y2: A5 gets the same leg on A+ copy', () => {
    const l = mut((x) => {
      x.aplusContent!.modules[1]!.body = 'Delivers Fifty Billion CFU per serving';
    });
    const failures = a5AplusPotencyPhrasing(l, pack);
    expect(failures.length).toBeGreaterThan(0);
    expect(idsOf(l)).toContain('A5');
  });

  it('Y2: over-blocking — ordinary prose, and a potency NOT attached to a dose, still PASS', () => {
    for (const value of [
      'Fifty Billion CFU in every capsule of the blend',
      'A Fifty Billion CFU blend of ten strains',
      'Fifty Billion CFU per bottle',
      'one capsule daily',
      'two servings per day',
      'Ten gummies per pouch',
      'one hundred percent plant based, one capsule per day',
      'a hundred percent vegan',
      'Take one and then another with your meal',
      'No claim of Fifty Billion CFU per serving is made here',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c10PotencyPhrasing(l, pack), value).toEqual([]);
    }
  });

  it('Y2: the leg is PACK DATA — no vocabulary is the exact digit-anchored rule C10/A5 shipped with', () => {
    const kit = clonePack();
    delete kit.rules.attributeGuard!.spelledOutNumbers;
    const words = mut((x) => {
      x.bullets[0] = 'Delivers Fifty Billion CFU per serving';
    });
    const digits = mut((x) => {
      x.bullets[0] = 'Delivers 50 Billion CFU per serving';
    });
    expect(c10PotencyPhrasing(words, kit)).toEqual([]);
    expect(c10PotencyPhrasing(digits, kit)).toEqual(c10PotencyPhrasing(digits, pack));
    expect(c10PotencyPhrasing(digits, kit).length).toBeGreaterThan(0);
  });

  it('Y2: the golden fixture is untouched — still ZERO gate failures', () => {
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
  });
});


// ===========================================================================
// Z1 — the JOINER GLYPH: orthography, not vocabulary
// ===========================================================================

/**
 * ============================================================================
 * Z1 — A SECOND PROVEN BYPASS OF THE SAME GUARD, FOUND BY ADVERSARIAL REVIEW
 * AFTER Y1 SHIPPED.
 * ============================================================================
 *
 * WHAT WAS BROKEN. `"Now One Hundred & Fifty Billion CFU."` in the description,
 * against a canonical `facts.potency` of `"50 Billion CFU"`, produced ZERO gate
 * failures — and, exactly as in Y1, not by refusal: the reader composed the
 * SUB-RUN `"Fifty Billion CFU"` to 50 and affirmed a threefold overstatement as
 * agreeing with the facts. `+`, `/`, `"100 & Fifty Billion CFU"` and
 * `"One Hundred n Fifty Billion CFU"` did the same, from the description, the
 * bullets, the title and the Q&A alike.
 *
 * WHY Y1's GUARD DID NOT FIRE. Y1 made the guard vocabulary-independent but not
 * ORTHOGRAPHY-independent. `previousToken` skipped only `[\s\-]` and returned
 * `null` on any other non-word character, so `&`, `+` and `/` read as clause
 * PUNCTUATION that ends the neighbourhood, and the fragment guard concluded
 * there was nothing unread in front of `Fifty`. `&` is the commonest written
 * form of "and" in Amazon copy and `normalize` even decodes `&amp;` into it.
 * `n` slipped through a different door: a one-letter token is not a function
 * word, so the guard treated it as a CONTENT word that owns the numeral to its
 * left — while `isAttributed`, ten lines above, already refused to attribute a
 * figure to a one-letter token. The two disagreed.
 *
 * THE RULE, and the line it draws. A JOINER — a glyph or a one-letter token
 * that stands in for a joining WORD inside a phrase — is a GAP: it does not end
 * the neighbourhood, so the fragment guard sees the value word behind it and
 * the reader REFUSES. A CLAUSE BOUNDARY — `.` `,` `;` `:` `!` `?` brackets,
 * quotes, line breaks — still ends it, so ordinary copy that states two
 * complete figures in two clauses is still read.
 *
 * The cost of drawing that line wrongly is ONE-SIDED, which is why it can be
 * drawn generously: a gap only ever produces a REFUSAL, and a refusal emits no
 * failure. Calling a real boundary a joiner loses coverage; it cannot fail
 * lawful copy. Calling a joiner a boundary is this defect.
 */
describe('Z1 — joiner glyphs are a GAP inside a numeral, not a clause boundary (C12)', () => {
  /** The five forms the reviewer proved, and the value each must NEVER produce. */
  const bypasses: string[] = [
    'Now One Hundred & Fifty Billion CFU.',
    'Now One Hundred + Fifty Billion CFU.',
    'Now One Hundred / Fifty Billion CFU.',
    'Now 100 & Fifty Billion CFU.',
    'Now One Hundred n Fifty Billion CFU.',
  ];

  const reader = (): SpelledOutFigureReader =>
    spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;

  // (a) --------------------------------------------------------------------
  /**
   * WHICH OUTCOME, ASSERTED. The answer is REFUSE, not detect: the reader
   * cannot tell whether `&` means "and" (150) or a list separator (100 and 50),
   * and `/` does not mean "and" at all, so composing ANY value would be an
   * invention. What the assertion pins is the thing that actually matters —
   * none of the five composes 50, so none can be affirmed as agreeing with a
   * canonical fact that says 50.
   */
  it('Z1 (a): all five PROVEN bypasses now resolve to NOTHING — none composes 50', () => {
    const r = reader();
    for (const copy of bypasses) {
      expect(r.read(copy), copy).toEqual([]);
      expect(r.read(copy).map((n) => n.value), copy).not.toContain(50);
    }
  });

  it('Z1 (a): through the WHOLE gate, against a contradicting canonical, on every surface', () => {
    expect(clean.facts.potency).toBe('50 Billion CFU');
    const surfaces: [string, (l: OptimizedListing, copy: string) => void][] = [
      ['description', (l, copy) => { l.description = `<p>${copy}</p>`; }],
      ['bullets', (l, copy) => { l.bullets[0] = copy; }],
      ['title', (l, copy) => { l.title = copy; }],
      ['qa', (l, copy) => { l.qa[0]!.a = copy; }],
    ];
    for (const copy of bypasses) {
      for (const [name, place] of surfaces) {
        const l = mut((x) => place(x, copy));
        const potency = c12FactConsistency(l, pack).filter((f) => f.fix.includes('facts.potency'));
        // REFUSED: no potency reading at all, and above all no reading of 50
        // silently affirmed as agreeing with the canonical figure.
        expect(potency, `${name}: ${copy}`).toEqual([]);
        // and the gate never asserts the fragment as a fact either
        expect(
          runGate(l, pack, ctx).failures.some((f) => f.fix.includes("facts.potency '50 Billion CFU'")),
          `${name}: ${copy}`,
        ).toBe(false);
      }
    }
  });

  it('Z1 (a): the pre-Z1 behaviour is pinned as GONE — the fragment guard, asserted directly', () => {
    const r = reader();
    // Before Z1 each of these read `[{ value: 50 }]`. The three glyph forms and
    // the letter form are all refused for the same reason: a value word sits
    // unread in front of the run.
    for (const text of [
      'One Hundred & Fifty Billion CFU',
      'One Hundred + Fifty Billion CFU',
      'One Hundred / Fifty Billion CFU',
      '100 & Fifty Billion CFU',
      'One Hundred n Fifty Billion CFU',
      "One Hundred 'n' Fifty Billion CFU",
      'One Hundred &/ Fifty Billion CFU',
      'One Hundred ＆ Fifty Billion CFU',
    ]) {
      expect(r.read(text), text).toEqual([]);
    }
  });

  it('Z1 (a): the refusal is VOCABULARY-independent — it holds with the connector list emptied', () => {
    const kit = clonePack();
    delete kit.rules.attributeGuard!.spelledOutNumbers!.connectors;
    const r = spelledOutFigureReader(kit.rules.units, kit.rules.attributeGuard)!;
    for (const copy of bypasses) expect(r.read(copy), copy).toEqual([]);
  });

  // (b) --------------------------------------------------------------------
  /**
   * THE OVER-BLOCK DIRECTION. The same five sentences are TRUTHFUL when the
   * canonical fact is the figure they state, and a guard that fails truthful
   * copy is exactly as bad as one that misses a lie. Refusal emits no failure,
   * so what is asserted here is that nothing new fires.
   */
  it('Z1 (b): the truthful forms of the same five sentences still PASS', () => {
    for (const copy of bypasses) {
      for (const potency of ['150 Billion CFU', '100 Billion CFU', '50 Billion CFU']) {
        const l = mut((x) => {
          x.facts.potency = potency;
          x.bullets[0] = copy;
        });
        expect(
          c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]'),
          `${copy} @ ${potency}`,
        ).toEqual([]);
      }
    }
  });

  it('Z1 (b): a joiner glyph beside a COMPLETE figure is still read and still measured', () => {
    const r = reader();
    // "Strains" owns the "Ten", so the numeral to the left is complete and the
    // reading of "Fifty" is not a fragment — the glyph changes nothing.
    expect(r.read('Ten Strains & Fifty Billion CFU').map((n) => n.value)).toEqual([50]);
    expect(r.read('Ten Strains + Fifty Billion CFU').map((n) => n.value)).toEqual([50]);
    expect(r.read('Prebiotic & Fifty Billion CFU').map((n) => n.value)).toEqual([50]);
    expect(r.read('Ten Billion CFU & Fifty Billion CFU').map((n) => n.value)).toEqual([10, 50]);
    // and the coverage that costs nothing is still armed
    const l = mut((x) => {
      x.bullets[0] = 'Ten Strains & Ninety Billion CFU';
    });
    expect(c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]')).toHaveLength(1);
  });

  // (c) --------------------------------------------------------------------
  /**
   * THE LINE ITSELF. A genuine clause boundary must STILL end the
   * neighbourhood, or ordinary copy that states two complete figures starts
   * refusing legitimately-readable ones.
   */
  it('Z1 (c): genuine clause boundaries still end the neighbourhood — 50 is still read', () => {
    const r = reader();
    for (const [text, values] of [
      ['Ten Billion CFU. Fifty Billion CFU per serving', [10, 50]],
      ['Ten Billion CFU, Fifty Billion CFU', [10, 50]],
      ['Ten Strains, Fifty Billion CFU', [50]],
      ['Ten Strains; Fifty Billion CFU', [50]],
      ['Ten Strains: Fifty Billion CFU', [50]],
      ['Ten Strains! Fifty Billion CFU', [50]],
      ['Ten Strains? Fifty Billion CFU', [50]],
      ['(Fifty Billion CFU)', [50]],
      ['Ten Strains (Fifty Billion CFU)', [50]],
      ['One Hundred. Fifty Billion CFU', [50]],
      ['One Hundred, Fifty Billion CFU', [50]],
      ['"Fifty Billion CFU"', [50]],
      ['Ten Strains\nFifty Billion CFU', [50]],
      ['Ten Billion CFU.\nFifty Billion CFU', [10, 50]],
    ] as [string, number[]][]) {
      expect(r.read(text).map((n) => n.value), text).toEqual(values);
    }
  });

  /**
   * A LINE BREAK is the one item on the boundary list that is a SEPARATOR here
   * rather than a boundary, and deliberately so: `normalize` collapses every
   * whitespace run to a single space before any check reads the text, so by the
   * time this reader runs a newline IS a space. `"One Hundred\nFifty Billion
   * CFU"` therefore reads as the ONE figure it states — 150, the whole run,
   * exactly as `"One Hundred Fifty Billion CFU"` does. That is the safe
   * direction and the opposite of the Z1 defect: the figure is read WHOLE, and
   * the fragment 50 is never produced.
   */
  it('Z1 (c): a line break inside a run is a separator, and the run is read WHOLE — never as 50', () => {
    const r = reader();
    expect(r.read('One Hundred\nFifty Billion CFU').map((n) => n.value)).toEqual([150]);
    expect(r.read('One Hundred Fifty Billion CFU').map((n) => n.value)).toEqual([150]);
    expect(normalize('One Hundred\nFifty Billion CFU')).toBe('One Hundred Fifty Billion CFU');
  });

  it('Z1 (c): and those clause-boundary readings behave through C12 exactly as they did', () => {
    // A complete figure that contradicts the canonical fact is still reported —
    // the boundary cases are measured, not refused.
    for (const copy of ['Ten Strains, Ninety Billion CFU', 'Ten Strains. Ninety Billion CFU']) {
      const l = mut((x) => {
        x.bullets[0] = copy;
      });
      expect(
        c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]'),
        copy,
      ).toHaveLength(1);
    }
  });

  // (d) --------------------------------------------------------------------
  it('Z1 (d): `&amp;` behaves identically to a literal `&` once `normalize` has decoded it', () => {
    const r = reader();
    const entity = 'Now One Hundred &amp; Fifty Billion CFU.';
    const literal = 'Now One Hundred & Fifty Billion CFU.';
    expect(normalize(entity)).toBe(literal);
    expect(r.read(normalize(entity))).toEqual(r.read(literal));
    expect(r.read(normalize(entity))).toEqual([]);
    // ...and through the gate, on the surface the reviewer used
    const asEntity = mut((x) => {
      x.description = `<p>${entity}</p>`;
    });
    const asLiteral = mut((x) => {
      x.description = `<p>${literal}</p>`;
    });
    expect(c12FactConsistency(asEntity, pack)).toEqual(c12FactConsistency(asLiteral, pack));
    expect(c12FactConsistency(asEntity, pack).filter((f) => f.fix.includes('facts.potency'))).toEqual([]);
  });

  // (e) --------------------------------------------------------------------
  it('Z1 (e): the lawful-prose battery still passes on every surface', () => {
    for (const value of [
      'one and a half servings',
      'a hundred percent plant based',
      'take one and then another',
      'two and three',
      'a one-time purchase',
      'a billion tiny helpers',
      'one and done',
      'a two-month supply',
      'an all-in-one formula',
      'over a hundred five-star reviews',
      // the same battery with the joiner written as a glyph
      'a one-time purchase & a one-month supply',
      'One softgel morning & night',
      'Ten strains + a prebiotic blend',
      'Gluten free / dairy free',
      'Vitamin C & D',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
      expect(c10PotencyPhrasing(l, pack), value).toEqual([]);
      expect(a5AplusPotencyPhrasing(l, pack), value).toEqual([]);
    }
  });

  // (f) --------------------------------------------------------------------
  it('Z1 (f): the golden fixture is untouched — still ZERO gate failures', () => {
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
    expect(c12FactConsistency(clean, pack)).toEqual([]);
    expect(c10PotencyPhrasing(clean, pack)).toEqual([]);
    expect(a5AplusPotencyPhrasing(clean, pack)).toEqual([]);
  });

  it('Z1 (f): an emptied vocabulary still restores EXACT digit-only behaviour', () => {
    const digits = mut((x) => {
      x.bullets[0] = 'Delivers 150 Billion CFU per serving';
    });
    const glyph = mut((x) => {
      x.bullets[0] = 'Delivers One Hundred & Fifty Billion CFU per serving';
    });
    for (const kit of [
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard!.spelledOutNumbers;
        return k;
      })(),
      (() => {
        const k = clonePack();
        delete k.rules.attributeGuard;
        return k;
      })(),
    ]) {
      expect(spelledOutFigureReader(kit.rules.units, kit.rules.attributeGuard)).toBeNull();
      expect(c12FactConsistency(glyph, kit)).toEqual([]);
      expect(c12FactConsistency(digits, kit)).toEqual(c12FactConsistency(digits, pack));
      expect(c12FactConsistency(digits, kit).length).toBeGreaterThan(0);
      expect(c12FactConsistency(clean, kit)).toEqual([]);
    }
  });
});

// ===========================================================================
// Z3 — pack-data gaps: the `million` unit, and the lead-magnitude exclusion
// ===========================================================================

/**
 * Z3 (a) — `million cfu` was not a pack unit token, so `"200,000 Million CFU"`
 * and `"Two Hundred Thousand Million CFU"` both shipped silently. That is a
 * pack-DATA gap with digit/word parity, not an engine regression, and the worst
 * of it was not the exotic string: a canonical `facts.potency` of
 * `"500 Million CFU"` parsed to NOTHING, which switched the potency comparison
 * OFF for the whole listing — the same failure mode N3's header warns about.
 *
 * DECIDED: add the COMPOUND `million cfu`, and NOT the bare magnitude
 * `million`. The bare word is ordinary listing prose ("Two Million Happy
 * Customers"), and declaring it would read those as potency figures and fail
 * them; the compound cannot, because `million` must be followed by `cfu` to
 * match at all. Both directions are asserted below.
 */
describe('Z3 (a) — `million cfu` is a pack unit token; bare `million` deliberately is not', () => {
  it('Z3 (a): the gap is closed in BOTH scripts, and the two agree', () => {
    const r = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    const words = r.read('Two Hundred Thousand Million CFU');
    const digits = extractUnitNumbers('200,000 Million CFU', pack.rules.units);
    expect(words).toHaveLength(1);
    expect(digits).toHaveLength(1);
    expect(words[0]!.value).toBe(200000);
    expect(words[0]!.unit).toBe(digits[0]!.unit);
    expect(words[0]!.value).toBe(digits[0]!.value);
    for (const copy of ['Two Hundred Thousand Million CFU', '200,000 Million CFU', '500 Million CFU']) {
      const l = mut((x) => {
        x.bullets[0] = copy;
      });
      expect(
        c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]'),
        copy,
      ).toHaveLength(1);
    }
  });

  it('Z3 (a): a million-scale canonical FACT is now readable, so the potency leg is armed at all', () => {
    const l = mut((x) => {
      x.facts.potency = '500 Million CFU';
      x.bullets[0] = 'Delivers 500 Million CFU in every blend';
      x.description = '<p>Delivers 500 Million CFU in every blend.</p>';
    });
    // the truthful restatement in the same magnitude is silent...
    expect(c12FactConsistency(l, pack).filter((f) => f.field === 'bullets[0]')).toEqual([]);
    // ...and an overstatement against that canonical is now REPORTED, where
    // before the whole comparison was switched off by an unreadable fact.
    const lying = mut((x) => {
      x.facts.potency = '500 Million CFU';
      x.bullets[0] = 'Delivers 900 Million CFU in every blend';
    });
    expect(
      c12FactConsistency(lying, pack).filter((f) => f.field === 'bullets[0]'),
    ).toHaveLength(1);
  });

  it('Z3 (a): the OVER-BLOCK direction — ordinary `million` prose is untouched', () => {
    for (const value of [
      'Two Million Happy Customers',
      'Over One Million Servings Sold',
      'Trusted by millions',
      'a million tiny helpers',
      'One in a million formula',
      'Millions of five-star moments',
    ]) {
      const l = mut((x) => {
        x.bullets[0] = value;
        x.description = `<p>${value}</p>`;
      });
      expect(c12FactConsistency(l, pack), value).toEqual([]);
      expect(c10PotencyPhrasing(l, pack), value).toEqual([]);
    }
    // the reason it is safe, asserted directly: the bare magnitude is NOT a unit
    expect(pack.rules.units!.dimensions!.potency).toContain('million cfu');
    expect(pack.rules.units!.dimensions!.potency).not.toContain('million');
  });
});

/**
 * Z3 (b) — the lead-magnitude exclusion (`spelledOutRunSource`) used to compare
 * a magnitude word against the caller's unit tokens by EXACT match. That was
 * safe only because the shipped pack happens to declare the bare `billion`
 * alongside the compound `billion cfu`. A pack that declared only the compound
 * would have left `billion` leadable, and `"A Billion CFU"` would have composed
 * 1,000,000,000 against a digit scan that reads the same string as 1.
 *
 * Not a live defect, so the fix is the cheap one: the test is now a whole-word
 * PREFIX match, which is a pure narrowing, and this pins that the behaviour no
 * longer depends on the pack shape.
 */
describe('Z3 (b) — the lead-magnitude exclusion no longer depends on the pack shipping a bare magnitude', () => {
  const compoundOnly = (): KnowledgePack => {
    const k = clonePack();
    k.rules.units!.dimensions!.potency = ['billion cfu', 'cfu'];
    k.rules.units!.families = [['cfu', 'billion cfu']];
    return k;
  };

  it('Z3 (b): the shipped pack does ship the bare magnitude — the assumption, stated', () => {
    expect(pack.rules.units!.dimensions!.potency).toContain('billion');
    expect(pack.rules.units!.dimensions!.potency).toContain('billion cfu');
  });

  it('Z3 (b): a compound-only pack reads the same figures as the shipped one', () => {
    const shipped = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    const narrow = spelledOutFigureReader(compoundOnly().rules.units, pack.rules.attributeGuard)!;
    for (const text of [
      'A Hundred Billion CFU',
      'A Billion CFU',
      'One Billion CFU',
      'Fifty Billion CFU',
      'One Hundred and Fifty Billion CFU',
    ]) {
      expect(narrow.read(text).map((n) => [n.value, n.unit]), text).toEqual(
        shipped.read(text).map((n) => [n.value, n.unit]),
      );
    }
    // the case the conditional named, pinned to the value the digit scan gives
    expect(narrow.read('A Billion CFU')).toEqual([]);
    expect(narrow.read('A Hundred Billion CFU').map((n) => n.value)).toEqual([100]);
  });

  it('Z3 (b): an inert lead is still allowed in front of a magnitude that opens no unit token', () => {
    const r = spelledOutFigureReader(pack.rules.units, pack.rules.attributeGuard)!;
    expect(r.read('A Hundred Billion CFU').map((n) => n.value)).toEqual([100]);
    expect(r.read('A Thousand mg').map((n) => n.value)).toEqual([1000]);
    // ...and NOT in front of one that does — `million` now opens `million cfu`,
    // so "A Million CFU" is the UNIT reading the digit scan gives "1 Million CFU"
    expect(r.read('A Million CFU')).toEqual([]);
    expect(r.read('One Million CFU').map((n) => [n.value, n.unit])).toEqual(
      extractUnitNumbers('1 Million CFU', pack.rules.units).map((n) => [n.value, n.unit]),
    );
  });
});

// ===========================================================================
// C26 — active_ingredients ⊆ ingredients
// ===========================================================================

describe('C26 active ingredients are a subset of the full label list', () => {
  it('PASSES the compliant fixture', () => {
    expect(c26ActiveIngredientSubset(clean, pack)).toEqual([]);
    expect(idsOf(clean)).not.toContain('C26');
  });

  /**
   * N3 — the amount stripper reads WORDS as well as digits, through the same
   * shared vocabulary. Without this the identical label failed or passed purely
   * on which script its amount was written in, which is over-blocking: the
   * amount is a property of the panel, never part of the ingredient's NAME.
   */
  it('N3: a SPELLED-OUT amount is stripped from the name, exactly like a digit amount', () => {
    const words = mut((x) => {
      x.attributes.active_ingredients = 'Probiotic Blend Fifty Billion CFU';
      x.attributes.ingredients = 'Vegetable Cellulose Capsule; Rice Flour; Probiotic Blend';
    });
    const digits = mut((x) => {
      x.attributes.active_ingredients = 'Probiotic Blend 50 Billion CFU';
      x.attributes.ingredients = 'Vegetable Cellulose Capsule; Rice Flour; Probiotic Blend';
    });
    expect(c26ActiveIngredientSubset(digits, pack)).toEqual([]);
    expect(c26ActiveIngredientSubset(words, pack)).toEqual([]);
  });

  it('N3: stripping the amount does NOT hide a genuinely undeclared ingredient', () => {
    const l = mut((x) => {
      x.attributes.active_ingredients = 'Ashwagandha Root Five Hundred mg';
      x.attributes.ingredients = 'Vegetable Cellulose Capsule; Rice Flour; Probiotic Blend';
    });
    const failures = c26ActiveIngredientSubset(l, pack);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.context).toContain('Ashwagandha');
  });

  it('PASSES across case, punctuation, ordering and amount differences', () => {
    const l = mut((x) => {
      x.attributes.active_ingredients = 'prebiotic fiber, PROBIOTIC BLEND (10 Strains) 50 Billion CFU';
      x.attributes.ingredients =
        'Vegetable Cellulose Capsule; Rice Flour; Probiotic Blend [10 strains]; Prebiotic-Fiber';
    });
    expect(c26ActiveIngredientSubset(l, pack)).toEqual([]);
  });

  it('FAILS when an active ingredient appears nowhere in the full list', () => {
    const l = mut((x) => {
      x.attributes.active_ingredients =
        'Probiotic Blend (10 strains, 50 Billion CFU); Ashwagandha Root Extract';
    });
    const failures = c26ActiveIngredientSubset(l, pack);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.context).toContain('Ashwagandha');
    expect(idsOf(l)).toContain('C26');
  });

  it('FAILS every undeclared active, not just the first', () => {
    const l = mut((x) => {
      x.attributes.active_ingredients = 'Ashwagandha Root; Rhodiola Rosea; Prebiotic Fiber';
    });
    expect(c26ActiveIngredientSubset(l, pack)).toHaveLength(2);
  });

  it('stays silent when the actives field is empty (C23 owns a missing required field)', () => {
    const l = mut((x) => {
      x.attributes.active_ingredients = '';
    });
    expect(c26ActiveIngredientSubset(l, pack)).toEqual([]);
    expect(idsOf(l)).toContain('C23');
  });

  it('is PACK-DRIVEN: no key pair, no rule — and the manifest fails the pack closed', () => {
    const bare = clonePack();
    delete bare.compliancePack!.ingredientSubsetRule;
    const l = mut((x) => {
      x.attributes.active_ingredients = 'Ashwagandha Root Extract';
    });
    expect(c26ActiveIngredientSubset(l, bare)).toEqual([]);
    expect(idsOf(l, bare)).toContain('PACK');
  });
});

// ===========================================================================
// C27 — output hygiene (+ the engine's typographic fold)
// ===========================================================================

describe('typographic normalization at EMIT (engine, not gate)', () => {
  it('folds typographic punctuation to ASCII', () => {
    expect(toAsciiTypography('a — b ‘c’ “d”…')).toBe(
      'a - b \'c\' "d"...',
    );
    expect(toAsciiTypography('fills ≥85% ±2')).toBe('fills >=85% +/-2');
  });

  it('leaves BANNED symbols, emoji and invisible characters alone (no laundering)', () => {
    expect(toAsciiTypography('BrandX™ €9 😀 a​b')).toBe(
      'BrandX™ €9 😀 a​b',
    );
    // …and C17 still fails the symbol it did before, through the fold.
    const l = normalizeListingTypography(mut((x) => {
      x.bullets[0] = 'Quality you can verify™: third-party tested, made in a cGMP facility';
    }));
    expect(c17Style(l, pack).length).toBeGreaterThan(0);
  });

  it('every generated surface of the golden run is already ASCII', () => {
    expect(c27OutputHygiene(clean, pack)).toEqual([]);
    expect(idsOf(clean)).not.toContain('C27');
  });
});

describe('C27 output hygiene', () => {
  it('FAILS non-ASCII in customer copy (accent and zero-width alike)', () => {
    for (const bad of ['Daily balance for café lovers', 'Daily bal​ance support']) {
      const l = mut((x) => {
        x.bullets[1] = bad;
      });
      const failures = c27OutputHygiene(l, pack).filter((f) => f.field === 'bullets[1]');
      expect(failures, bad).toHaveLength(1);
      expect(failures[0]!.context).toContain('non-ASCII');
    }
  });

  it('EXEMPTS backend search terms — other-language variants are that field\'s purpose', () => {
    const l = mut((x) => {
      x.backendSearchTerms = 'probiótico digestión fördauung';
    });
    expect(c27OutputHygiene(l, pack).filter((f) => f.field === 'backendSearchTerms')).toEqual([]);
  });

  it('FAILS every AI-tell phrase the pack lists', () => {
    for (const phrase of pack.rules.outputHygiene!.aiTellPhrases) {
      const l = mut((x) => {
        x.description = `${x.description}\n\nWe ${phrase} into daily wellness routines.`;
      });
      const failures = c27OutputHygiene(l, pack).filter(
        (f) => f.field === 'description' && f.context.includes('AI-tell'),
      );
      expect(failures.length, phrase).toBeGreaterThan(0);
    }
  });

  it('FAILS every leaked instruction fragment the pack lists', () => {
    for (const fragment of pack.rules.outputHygiene!.instructionFragments) {
      const l = mut((x) => {
        x.qa[0] = { ...x.qa[0]!, a: `${fragment} the answer follows here for shoppers.` };
      });
      const failures = c27OutputHygiene(l, pack).filter(
        (f) => f.field === 'qa[0].a' && f.context.includes('leaked instruction'),
      );
      expect(failures.length, fragment).toBeGreaterThan(0);
    }
  });

  it('does NOT fire on ordinary product copy', () => {
    const legitimate = [
      'Two-month supply at one capsule daily, taken with or without food',
      'Third-party tested, Non-GMO and gluten free, made in a cGMP facility in the USA',
      'Designed for adults building a consistent daily routine at home or travelling',
      'Shelf stable with no refrigeration required, so it travels with you',
    ];
    for (const text of legitimate) {
      const l = mut((x) => {
        x.bullets[2] = text;
      });
      expect(c27OutputHygiene(l, pack).filter((f) => f.field === 'bullets[2]'), text).toEqual([]);
    }
  });

  it('is PACK-DRIVEN in all three halves — and the manifest fails each one closed', () => {
    const cases: [keyof NonNullable<typeof pack.rules.outputHygiene>, () => OptimizedListing][] = [
      ['asciiOnly', () => mut((x) => { x.bullets[1] = 'Café blend'; })],
      ['aiTellPhrases', () => mut((x) => { x.bullets[1] = 'Look no further for daily balance'; })],
      ['instructionFragments', () => mut((x) => { x.bullets[1] = 'Return JSON with the bullets'; })],
    ];
    for (const [key, make] of cases) {
      const bare = clonePack();
      if (key === 'asciiOnly') bare.rules.outputHygiene!.asciiOnly = false;
      else (bare.rules.outputHygiene as unknown as Record<string, string[]>)[key] = [];
      const l = make();
      expect(c27OutputHygiene(l, pack).length, key).toBeGreaterThan(0); // armed by default
      expect(c27OutputHygiene(l, bare).length, key).toBe(0); // disarmed by the empty list…
      expect(idsOf(l, bare), key).toContain('PACK'); // …which is itself blocking
    }
  });
});

// ===========================================================================
// R33/R38 — the substantiation register
// ===========================================================================

describe('substantiation register (R33/R38)', () => {
  it('marks a claim the SOURCE listing already made as HELD', () => {
    const register = buildSubstantiationRegister(clean, snapshot, pack.compliancePack);
    const nonGmo = register.find((r) => r.claim === 'Non-GMO');
    expect(nonGmo?.status).toBe('HELD');
    expect(nonGmo?.surface).toContain('title');
  });

  it('marks a claim only the GENERATED copy makes as PENDING — the "Made in USA" problem', () => {
    const l = mut((x) => {
      x.bullets[3] = 'Quality you can verify: certified organic and third-party tested';
    });
    const register = buildSubstantiationRegister(l, snapshot, pack.compliancePack);
    const organic = register.find((r) => r.claim === 'Organic');
    expect(organic?.status).toBe('PENDING');
    expect(organic?.note).toContain('not evidenced in source listing');
    // …and the same token IS held when the source listing carries it.
    const sourceWithOrganic: ListingSnapshot = {
      ...snapshot,
      description: `${snapshot.description} Certified organic.`,
    };
    expect(
      buildSubstantiationRegister(l, sourceWithOrganic, pack.compliancePack)!.find(
        (r) => r.claim === 'Organic',
      )?.status,
    ).toBe('HELD');
  });

  it('an UNEVIDENCED claim in a HEADER field is a P1 audit gap', () => {
    const l = mut((x) => {
      x.title75 = 'BrandX Probiotic Organic 50 Billion CFU, 10 Strains, 60 Capsules';
    });
    const audit = buildAudit(snapshot, l, pack, ctx);
    const gap = audit.gaps.find((g) => g.why.includes('Substantiation'));
    expect(gap?.severity).toBe('P1');
    expect(gap?.proposed).toContain('Organic');
  });

  it('is ADVISORY: a PENDING row never touches `verified`', () => {
    const l = mut((x) => {
      x.bullets[3] = 'Quality you can verify: certified organic and third-party tested';
    });
    const audit = buildAudit(snapshot, l, pack, ctx);
    expect(audit.substantiationRegister!.some((r) => r.status === 'PENDING')).toBe(true);
    expect(audit.verified).toBe(true);
  });

  it('renders as a ship-sheet table for operator sign-off', () => {
    const l = mut((x) => {
      x.bullets[3] = 'Quality you can verify: certified organic and third-party tested';
    });
    const audit = buildAudit(snapshot, l, pack, ctx);
    const html = buildShipSheet({ optimized: l, audit, pack });
    expect(html).toContain('10 · Substantiation register');
    expect(html).toContain('PENDING');
    expect(html).toContain('Organic');
  });

  it('is PACK-DRIVEN: no token list, no register', () => {
    const bare = clonePack();
    delete bare.compliancePack!.substantiationTokens;
    expect(buildSubstantiationRegister(clean, snapshot, bare.compliancePack)).toEqual([]);
  });
});

// ===========================================================================
// brain/02 — the candidate-noun proposer
// ===========================================================================

describe('candidate-term proposer (the dental blind-spot detector)', () => {
  const withSource = (patch: Partial<ListingSnapshot>): ListingSnapshot => ({ ...snapshot, ...patch });

  it('proposes a condition-like term the pack lexicon does NOT know', () => {
    const terms = candidateTerms(
      withSource({ description: 'Formulated to treat keratoconus in adults.' }),
      pack,
    );
    expect(terms).toContain('keratoconus');
  });

  it('proposes a term by MORPHOLOGY alone (no therapeutic verb needed)', () => {
    const terms = candidateTerms(withSource({ description: 'Some users mention pyodermatitis.' }), pack);
    expect(terms).toContain('pyodermatitis');
  });

  it('does NOT propose terms the lexicon already enforces', () => {
    const terms = candidateTerms(
      withSource({ description: 'Helps with gingivitis and treats halitosis.' }),
      pack,
    );
    expect(terms).not.toContain('gingivitis');
    expect(terms).not.toContain('halitosis');
  });

  it('does NOT propose ordinary copy words (the compliant fixture proposes nothing)', () => {
    expect(candidateTerms(snapshot, pack)).toEqual([]);
    expect(
      candidateTerms(withSource({ description: 'Supports healthy gut flora during travel.' }), pack),
    ).toEqual([]);
  });

  it('is ADVISORY: it never becomes a failure or a gap', () => {
    const audit = buildAudit(
      withSource({ description: 'Formulated to treat keratoconus in adults.' }),
      clean,
      pack,
      ctx,
    );
    expect(audit.candidateTerms).toContain('keratoconus');
    expect(audit.verified).toBe(true);
    expect(audit.gaps.some((g) => g.why.includes('keratoconus'))).toBe(false);
  });

  it('is PACK-DRIVEN: no heuristics, no proposals', () => {
    const bare = clonePack();
    delete bare.compliancePack!.candidateTermHeuristics;
    expect(
      candidateTerms(withSource({ description: 'Formulated to treat keratoconus.' }), bare),
    ).toEqual([]);
  });
});

// ===========================================================================
// R45 — per-run operator fiction phrases
// ===========================================================================

describe('R45 operator-supplied fiction phrases (per run, never persisted)', () => {
  it('MERGES over the pack list and never mutates the shipped pack', () => {
    const before = [...pack.compliancePack!.fictionPhrases];
    const merged = withOperatorFictionPhrases(pack, ['moon-harvested enzyme']);
    expect(merged.compliancePack!.fictionPhrases).toContain('moon-harvested enzyme');
    for (const phrase of before) expect(merged.compliancePack!.fictionPhrases).toContain(phrase);
    // The module-level pack (and every later run) is untouched.
    expect(pack.compliancePack!.fictionPhrases).toEqual(before);
    expect(loadPack('supplements').compliancePack!.fictionPhrases).toEqual(before);
  });

  it('ignores junk input and duplicates', () => {
    const merged = withOperatorFictionPhrases(pack, [
      '  ',
      'a',
      42 as unknown as string,
      'Moon Blend',
      'moon blend',
    ]);
    expect(merged.compliancePack!.fictionPhrases).toEqual([
      ...pack.compliancePack!.fictionPhrases,
      'Moon Blend',
    ]);
  });

  it('a supplied phrase FAILS the run through C11 (which is unchanged)', async () => {
    const withPhrase = await runPipeline(snapshot, mockLlm, 1, {
      fictionPhrases: ['two-month supply'],
    });
    expect(withPhrase.audit.verified).toBe(false);
    expect(withPhrase.audit.gateResult.failures.map((f) => f.checkId)).toContain('C11');
  });

  it('and the SAME run without the phrase is verified (the input is what changed)', async () => {
    const without = await runPipeline(snapshot, mockLlm, 1);
    expect(without.audit.verified).toBe(true);
    expect(without.audit.gateResult.failures.map((f) => f.checkId)).not.toContain('C11');
  });
});
