import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { REQUIRED_PACK_PIECES } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';

/**
 * ROUND 7 — the residuals the previous round listed as NOT fixed, each pinned
 * with the assertion that proves the mechanism rather than the symptom.
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
  return withCoherentBulletFlags(copy);
};

// ===========================================================================
// R6c — `acceptedDisclaimerVariants` (was `auditAcceptDisclaimers`)
// ===========================================================================

/**
 * The field is subtracted from GENERATED surfaces too, not only from the
 * current-listing audit path. That is safe for exactly one reason, asserted
 * here: subtracting a variant only EXEMPTS required legal text from a content
 * scan — it never satisfies the disclaimer requirement, which C5 and A1 still
 * measure against `cp.disclaimer` verbatim.
 */
describe('R6c — an accepted disclaimer VARIANT never satisfies C5/A1', () => {
  const variant = pack.compliancePack!.acceptedDisclaimerVariants[0]!;
  const canonical = pack.compliancePack!.disclaimer;

  it('the pack really does ship a variant that differs from the canonical constant', () => {
    expect(variant).toBeTruthy();
    expect(variant).not.toBe(canonical);
  });

  it('generated output carrying the variant instead of the constant hard-fails C5', () => {
    const l = mut((x) => {
      x.fdaDisclaimer = variant;
      x.description = x.description.split(canonical).join(variant);
    });
    const c5 = runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C5');
    expect(c5.map((f) => f.field).sort()).toEqual(['description', 'fdaDisclaimer']);
  });

  it('generated A+ content carrying the variant hard-fails A1', () => {
    const l = mut((x) => {
      x.aplusContent.fdaDisclaimer = variant;
      x.aplusContent.modules = x.aplusContent.modules.map((m) => ({
        ...m,
        body: m.body.split(canonical).join(variant),
      }));
      x.aplusContent.faq = x.aplusContent.faq.map((f) => ({
        ...f,
        a: f.a.split(canonical).join(variant),
      }));
    });
    const a1 = runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'A1');
    expect(a1.length).toBeGreaterThan(0);
    expect(a1.some((f) => f.field === 'aplus.fdaDisclaimer')).toBe(true);
  });

  it('the variant IS still exempt from the content scans (that is its whole job)', () => {
    // The disclaimer sentence contains 'disease' and the verbs 'diagnose,
    // treat, cure, prevent'. Planted verbatim in a bullet as the variant form,
    // it must not be reported as a claim by C6/C21.
    const l = mut((x) => { x.bullets[1] = `Good to know: ${variant}`; });
    const onBullet = runGate(l, pack, ctx).failures.filter((f) => f.field === 'bullets[1]');
    expect(onBullet.filter((f) => f.checkId === 'C6' || f.checkId === 'C21')).toEqual([]);
  });
});

// ===========================================================================
// R4 — unpunctuated certification runs
// ===========================================================================

describe('R4 — C17 all-caps runs made entirely of certification marks', () => {
  const c17On = (l: OptimizedListing, field: string): Failure[] =>
    runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C17' && f.field === field);

  it.each([
    'Certified IFOS BSCG HACCP SQF every single year',
    'IFOS BSCG HACCP SQF BRCGS IGEN NSF USP audited',
    'Audited to ISO GMP HACCP standards',
  ])('the unpunctuated certification run "%s" produces NO C17 failure', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c17On(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'NEW BIG WOW gut support',
    'BUY MORE NOW while you can',
    'THIS IS SHOUTING LOUD at the customer',
    'SAME NON USA GABA blend',
  ])('genuine shouting "%s" still FAILS C17', (copy) => {
    const l = mut((x) => { x.bullets[1] = `${copy}*`; });
    expect(c17On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the run-exempt list is a strict SUBSET of the allowlist (pack integrity)', () => {
    const allow = new Set(pack.rules.style.allCapsAllowlist);
    for (const token of pack.rules.style.allCapsRunExempt ?? []) {
      expect(allow.has(token), `${token} must also be allow-listed`).toBe(true);
    }
  });

  it('an exempt mark mixed with a non-exempt word is still measured normally', () => {
    const l = mut((x) => { x.bullets[1] = 'BUY ISO NSF NOW today*'; });
    expect(c17On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// R5 — lexicon symmetry
// ===========================================================================

describe('R5 — British/US spellings sit at the same tier', () => {
  const tiers = (packId: 'supplements' | 'cosmetics') => {
    const cp = loadPack(packId).compliancePack!;
    const core = new Set(cp.coreDiseaseNouns);
    const sub = new Set(Object.values(cp.diseaseNounsBySubcategory).flat());
    return { core, sub };
  };

  /** ae/oe -> e, and the -rrhoea/-rrhea ending. */
  const usForm = (t: string): string =>
    t.replace(/rrhoea/g, 'rrhea').replace(/ae/g, 'e').replace(/oe/g, 'e');

  it.each(['supplements', 'cosmetics'] as const)(
    '%s: no spelling pair straddles core and a subcategory list',
    (packId) => {
      const { core, sub } = tiers(packId);
      const asymmetric: string[] = [];
      for (const term of [...core, ...sub]) {
        const other = usForm(term);
        if (other === term) continue;
        const bothPresent = core.has(other) || sub.has(other);
        if (!bothPresent) continue;
        const tierOf = (t: string): string => (core.has(t) ? 'core' : 'sub');
        if (tierOf(term) !== tierOf(other)) asymmetric.push(`${term}/${other}`);
      }
      expect(asymmetric).toEqual([]);
    },
  );

  it.each(['diarrhea', 'diarrhoea', 'edema', 'oedema', 'sleep apnea', 'sleep apnoea', 'celiac disease', 'coeliac disease'])(
    'both spellings of "%s" sit in coreDiseaseNouns',
    (term) => {
      expect(pack.compliancePack!.coreDiseaseNouns).toContain(term);
    },
  );

  it.each(['sarcoma', 'mpox', 'scabies'])('the audit term "%s" is a core disease noun', (term) => {
    expect(pack.compliancePack!.coreDiseaseNouns).toContain(term);
  });

  it.each(['mounjaro', 'oxycontin', 'chemotherapy', 'radiation therapy'])(
    'the audit term "%s" is a listed prescription therapy',
    (term) => {
      expect(pack.compliancePack!.prescriptionDrugNames).toContain(term);
    },
  );

  it.each(['diarrhea', 'diarrhoea', 'sarcoma', 'mpox', 'scabies', 'mounjaro', 'oxycontin', 'chemotherapy', 'radiation therapy'])(
    '"%s" is enforced end to end by C6',
    (term) => {
      const l = mut((x) => { x.bullets[1] = `Daily support for ${term} in adults*`; });
      expect(
        runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]'),
      ).toBe(true);
    },
  );
});

// ===========================================================================
// R2 — the manifest covers the pieces added since round 6
// ===========================================================================

describe('R2 — manifest covers every newly added, DISARMABLE pack piece', () => {
  const ids = REQUIRED_PACK_PIECES.map((p) => p.id);

  it.each([
    'compliancePack.actionPairedNouns',
    'compliancePack.ingredientAttributeKeys',
    'compliancePack.semanticDrugClaims.pathologicalActionVerbs',
    'compliancePack.semanticDrugClaims.anatomicalTargets',
    'compliancePack.semanticDrugClaims.replacementCues',
    'compliancePack.semanticDrugClaims.medicalDeviceOrTherapyNouns',
    'compliancePack.semanticDrugClaims.functionRestorationVerbs',
    'compliancePack.semanticDrugClaims.lostFunctionNouns',
    'compliancePack.semanticDrugClaims.patterns',
  ])('%s is a required piece', (id) => {
    expect(ids).toContain(id);
  });

  /**
   * The other direction, which matters just as much: a FALSE-POSITIVE REDUCER
   * must NOT be required. Emptying one makes the gate stricter, so a PACK
   * failure would report a blunt pack as an unsafe one.
   */
  it.each([
    'compliancePack.allergenCompoundExclusions',
    'compliancePack.benignContextPhrases',
    'compliancePack.semanticDrugClaims.safeContextPhrases',
    'rules.style.allCapsRunExempt',
  ])('%s is deliberately NOT required', (id) => {
    expect(ids).not.toContain(id);
  });

  it('emptying allergenCompoundExclusions over-blocks rather than under-blocks', () => {
    const broken = JSON.parse(JSON.stringify(pack)) as typeof pack;
    broken.compliancePack!.allergenCompoundExclusions = [];
    const l = mut((x) => {
      x.attributes.ingredients = 'Milk Thistle Extract; Rice Flour';
      x.attributes.allergen_information = 'Free from major allergens per label';
    });
    // No PACK failure (it is not a manifest row) …
    expect(runGate(l, broken, ctx).failures.some((f) => f.checkId === 'PACK')).toBe(false);
    // … and the failure mode is a FALSE POSITIVE, not a bypass.
    expect(runGate(l, broken, ctx).failures.some((f) => f.checkId === 'C9')).toBe(true);
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C9')).toBe(false);
  });
});

// ===========================================================================
// R7 — subcategory keyword matching
// ===========================================================================

describe('R7 — subcategory keywords match on word boundaries', () => {
  const snap = (title: string, attributes: Record<string, string>): ListingSnapshot => ({
    asin: 'B0SUBCAT01',
    url: 'https://www.amazon.com/dp/B0SUBCAT01',
    title,
    bullets: [],
    description: '',
    category: 'Health & Household > Vitamins & Dietary Supplements',
    subcategory: [],
    attributes,
    images: [],
    price: '',
    raw: {},
  });

  it('"Dietary Supplement" no longer matches the subcategory keyword inside "supple-MEN-t"', () => {
    const detected = detectCategory(snap('BrandX Daily Blend', { product_type: 'Dietary Supplement' }));
    expect(detected.packId).toBe('supplements');
    expect(detected.subcategories).not.toContain('mens');
  });

  it('a real whole-word keyword still matches', () => {
    const cp = loadPack('supplements').compliancePack!;
    const term = cp.subcategoryKeywords.mens?.[0];
    expect(term).toBeTruthy();
    const detected = detectCategory(snap(`BrandX ${term} Formula`, {}));
    expect(detected.subcategories).toContain('mens');
  });

  it('cosmetics subcategory detection still returns a non-empty list', () => {
    const detected = detectCategory({
      ...snap('GlowLab Vitamin C Serum', {}),
      category: 'Beauty & Personal Care > Skin Care',
    });
    expect(detected.packId).toBe('cosmetics');
    expect(detected.subcategories.length).toBeGreaterThan(0);
    expect(
      detected.subcategories.every(
        (s) => (cosmetics.compliancePack!.diseaseNounsBySubcategory[s] ?? []).length > 0,
      ),
    ).toBe(true);
  });
});
