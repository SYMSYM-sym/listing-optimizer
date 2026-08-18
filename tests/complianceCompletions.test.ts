import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { candidateTerms } from '@/lib/audit/candidateTerms';
import { buildSubstantiationRegister } from '@/lib/audit/substantiation';
import { optimize } from '@/lib/engine/optimize';
import { normalizeListingTypography, toAsciiTypography } from '@/lib/engine/typography';
import { buildShipSheet } from '@/lib/export/shipSheet';
import {
  c12FactConsistency,
  c17Style,
  c24DosageAttributeGuard,
  c26ActiveIngredientSubset,
  c27OutputHygiene,
  type GateContext,
} from '@/lib/gate/checks';
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
