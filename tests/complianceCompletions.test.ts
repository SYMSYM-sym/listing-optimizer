import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { candidateTerms } from '@/lib/audit/candidateTerms';
import { buildSubstantiationRegister } from '@/lib/audit/substantiation';
import { optimize } from '@/lib/engine/optimize';
import { normalizeListingTypography, toAsciiTypography } from '@/lib/engine/typography';
import { buildShipSheet } from '@/lib/export/shipSheet';
import {
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
   * F6 — A RECORDED PARITY LIMITATION, PINNED SO IT CANNOT BE REDISCOVERED.
   *
   * The check is DIGIT-ANCHORED: its value pattern is `\d[\d,.]*` followed by
   * a hero unit, exactly as the harness kit's `checkC24` was. A hero figure
   * spelled out in words ("Fifty Billion CFU") therefore passes, and so does
   * C12, whose scan is unit-anchored on digits for the same reason.
   *
   * This is NOT fixed here, and the omission is deliberate rather than
   * overlooked: the check is a PORT, its behaviour is the kit's behaviour, and
   * widening it silently would make the app and the kit disagree about what
   * C24 means with nothing recording why. It is written down in
   * CONFORMANCE-DEVIATIONS.md (item 2) as a known limitation with the
   * conditions any future fix must meet. This test exists so the boundary is
   * asserted rather than assumed — if someone widens the pattern, this test
   * fails and they are forced to update the record in the same commit.
   */
  it('KNOWN LIMITATION (recorded): the guard is digit-anchored, so a spelled-out figure passes', () => {
    const digits = mut((x) => {
      x.attributes.maximum_dosage = '50 Billion CFU';
    });
    const words = mut((x) => {
      x.attributes.maximum_dosage = 'Fifty Billion CFU';
    });
    expect(c24DosageAttributeGuard(digits, pack)).toHaveLength(1);
    expect(c24DosageAttributeGuard(words, pack)).toEqual([]);
    // and C12 does not catch it either — same digit anchor, same reason
    expect(idsOf(words)).not.toContain('C12');
    expect(idsOf(words)).not.toContain('C24');
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
// C26 — active_ingredients ⊆ ingredients
// ===========================================================================

describe('C26 active ingredients are a subset of the full label list', () => {
  it('PASSES the compliant fixture', () => {
    expect(c26ActiveIngredientSubset(clean, pack)).toEqual([]);
    expect(idsOf(clean)).not.toContain('C26');
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
