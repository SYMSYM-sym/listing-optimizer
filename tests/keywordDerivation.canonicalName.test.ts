import { beforeAll, describe, expect, it } from 'vitest';
import { brandParity } from '@/lib/audit/brandParity';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import type { LlmClient } from '@/lib/engine/llm';
import {
  canonicalNameIdentity,
  deriveKeywordPlacement,
  ownBrandIdentity,
  productIdentity,
  productPropertyIdentity,
} from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { c28KeywordPlacement, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type {
  CompetitorIngestion,
  Failure,
  KeywordTerm,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * THE RUN'S OWN CANONICAL PRODUCT NAME MARKED `negative` — AND THE LAUNDERING
 * PATH THAT EXEMPTION WOULD OTHERWISE OPEN, CLOSED BY NAME.
 * ===========================================================================
 *
 * THE LIVE DEFECT. ASIN B00IO89MYA, two failures, and the run could not
 * converge:
 *
 *   C28 | keywords[22] | negative term 'immunity complete' appears on 'images'
 *   C28 | keywords[22] | negative term 'immunity complete' appears on 'video'
 *
 * `Immunity Complete` is the run's OWN canonical `productName`. The snapshot's
 * brand is `Instant Immunity`, so the two disagree — which is exactly why the
 * two existing exemptions both miss it:
 *   - `ownBrandIdentity` admits a model-authored `productName` ONLY when its
 *     leading words agree with the scraped title or a declared snapshot brand
 *     (the G2 hardening). They share no leading word, so it is not admitted.
 *   - `productPropertyIdentity` reads the ingested page's structured attributes,
 *     and the name is not one of them.
 *
 * WHY THE ROW IS INCOHERENT ANYWAY — WHATEVER THE NAME'S PROVENANCE. C8 requires
 * `productName` to START the title and to APPEAR in the description; C15 requires
 * it to start `title75`. The gate FORCES that exact string into the copy, and a
 * `negative` row demands it appear nowhere. No repair round can clear an
 * unsatisfiable pair: the only move the C28 message asks for is deleting a string
 * C8/C15 fail the run for deleting. So the rule is keyed on WHAT THE GATE
 * COMPELS, not on who wrote the name.
 *
 * ===========================================================================
 * AND THE LAUNDERING PATH IS PROVED CLOSED, MECHANISM BY MECHANISM — §3
 * ===========================================================================
 * Setting `productName` to a rival's brand to buy this exemption is the attack.
 * Three independent mechanisms answer it, and this file asserts each one:
 *
 *   1. C8/C15 MAKE IT MAXIMALLY VISIBLE. The very rule the exemption rests on
 *      forces the rival's brand to be the FIRST WORDS of the title and of
 *      `title75`, and into the description. Refuse that and C8/C15 fail the run.
 *   2. THE AUTOMATIC COMPETITOR-DERIVED RIVAL SET READS NO LABEL AND NO
 *      `productName`. `rivalBrandNames` is built from the brand fields of the
 *      competitor ASINs the OPERATOR typed, and subtracts only the NARROW
 *      `ownBrandIdentity` — which is NOT widened here. The rival still fails
 *      C28's automatic leg, from the very title mechanism 1 forced it into.
 *   3. `brandParity` STILL DISAGREES WITH THE SCRAPED PAGE — a P1 gap the
 *      operator must confirm. A rename that does NOT carry into the brand
 *      attributes leaves the real brand backend-only and C7 fires instead.
 *
 * ===========================================================================
 * BOTH DIRECTIONS
 * ===========================================================================
 *   §1 the live shape converges;
 *   §2 the exemption is equality-only and never widens `ownBrandIdentity`;
 *   §3 a rival-named run still fails, via each mechanism above;
 *   §4 a GENUINE rival marked negative still fails from every surface;
 *   §5 `minNegatives` cannot be padded by the reclassified row.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/**
 * The model-authored canonical name, chosen to DISAGREE with the snapshot the
 * way the live one did (`Immunity Complete` against the brand `Instant
 * Immunity`): no leading word in common with the scraped title or brand.
 */
const RENAMED = 'Harbor Row Daily';
/** A genuine rival, and the two-word brand string an operator's ASIN carries. */
const RIVAL = 'GreenLuxe Labs';

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;

/**
 * A run that renamed itself CONSISTENTLY — every copy surface, every A+ module
 * and the brand attributes — which is what a real run does and what keeps
 * C7/C8/C15/A3/A4 satisfied. Only the SCRAPED page still disagrees, which is
 * mechanism 3's whole subject.
 */
const renamedTo = (name: string, brand = name): OptimizedListing =>
  JSON.parse(
    JSON.stringify(clean)
      .replace(/BrandX Probiotic/g, name)
      .replace(/BrandX Labs LLC/g, `${brand} Labs LLC`)
      .replace(/BrandX/g, brand),
  ) as OptimizedListing;

const c28 = (l: OptimizedListing, rivalBrands: string[] = []): Failure[] =>
  c28KeywordPlacement(l, pack, { ...ctx, rivalBrands });
const gate = (l: OptimizedListing, rivalBrands: string[] = []) =>
  runGate(l, pack, rivalBrands.length > 0 ? { ...ctx, rivalBrands } : ctx);
const rowFor = (rows: KeywordTerm[], term: string): KeywordTerm =>
  rows.find((r) => r.term.toLowerCase() === term.toLowerCase())!;
const negativeRow = (term: string, why: string): KeywordTerm => ({
  term,
  tier: 'negative',
  status: 'negative',
  surfaces: [],
  why,
});

/** Three GENUINE negatives — what a real reference records, and the floor. */
const NEGATIVE_FLOOR = (): KeywordTerm[] => [
  negativeRow('diabetes', 'Named condition'),
  negativeRow('detox', 'Implied-treatment framing'),
  negativeRow('miracle', 'Unverifiable superlative'),
];

// ===========================================================================
// §1 — THE LIVE SHAPE CONVERGES
// ===========================================================================

describe('§1 the run\'s own productName marked negative', () => {
  it('the live premise holds: the name DISAGREES with the snapshot, so neither existing exemption sees it', () => {
    const l = renamedTo(RENAMED);
    expect(l.productName).toBe(RENAMED);
    // G2: a model-authored name that agrees with nothing is not admitted.
    expect(ownBrandIdentity(l, snapshot).has('harbor row daily')).toBe(false);
    // ...and it is not a structured attribute of the ingested page either.
    expect(productPropertyIdentity(snapshot).has('harbor row daily')).toBe(false);
    // The narrower rule is what holds it, and it says so.
    expect(canonicalNameIdentity(l).has('harbor row daily')).toBe(true);
    expect(productIdentity(l, snapshot).get('harbor row daily')).toBe('canonical-name');
  });

  it('and the gate really does FORCE that string into the copy — C8 and C15, both surfaces', () => {
    const l = renamedTo(RENAMED);
    // The premise the exemption rests on, asserted rather than assumed.
    expect(l.title.startsWith(RENAMED)).toBe(true);
    expect(l.title75.startsWith(RENAMED)).toBe(true);
    expect(l.description).toContain(RENAMED);
    // Take it out and the run fails on the checks that compel it.
    const stripped = renamedTo(RENAMED);
    stripped.title = stripped.title.replace(RENAMED, 'Daily Blend');
    stripped.title75 = stripped.title75.replace(RENAMED, 'Daily Blend');
    stripped.description = stripped.description.split(RENAMED).join('Daily Blend');
    const ids = gate(stripped).failures.map((f) => `${f.checkId}|${f.field}`);
    expect(ids).toContain('C8|title');
    expect(ids).toContain('C8|description');
    expect(ids).toContain('C15|title75');
  });

  it('THE DEFECT WAS REAL: unexempted, the row stays negative and C28 fails exactly as production did', () => {
    const l = renamedTo(RENAMED);
    // The pre-fix world: the two snapshot-derived identities are the only ones,
    // and neither holds this name — so the row survives and the copy carries it.
    expect(ownBrandIdentity(l, snapshot).has('harbor row daily')).toBe(false);
    l.keywords = [{ ...negativeRow(RENAMED, 'Kept out of copy'), surfaces: [] }, ...NEGATIVE_FLOOR()];
    const contexts = c28(l).map((f) => f.context);
    expect(
      contexts.some((c) => c.toLowerCase().includes(`negative term '${RENAMED.toLowerCase()}'`)),
      contexts.join(' | '),
    ).toBe(true);
    expect(gate(l).pass).toBe(false);
  });

  it('RECLASSIFIED, not deleted, with the correction on `note`', () => {
    const l = renamedTo(RENAMED);
    const derived = deriveKeywordPlacement([negativeRow(RENAMED, 'Kept out of copy')], l, pack, snapshot);
    expect(derived).toHaveLength(1);
    const row = derived[0]!;
    expect(row.term).toBe(RENAMED);
    expect(row.status).toBe('placed');
    expect(row.surfaces).toContain('title');
    expect(row.proposedStatus).toBe('negative');
    expect(row.note).toContain('CANONICAL PRODUCT NAME');
    expect(row.note).toContain("reclassified from 'negative'");
    // the model's own fields are not laundered
    expect(row.why).toBe('Kept out of copy');
    expect(row.tier).toBe('negative');
  });

  it('C28 is CLEAN and the whole gate passes — the live blocker, fixed', () => {
    const l = renamedTo(RENAMED);
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(RENAMED, 'Kept out of copy')], l, pack, snapshot),
      ...NEGATIVE_FLOOR(),
    ];
    expect(c28(l)).toEqual([]);
    expect(gate(l)).toEqual({ pass: true, failures: [] });
  });

  it('END TO END: a live-shaped model run through optimize() converges', async () => {
    const liveShapedLlm: LlmClient = async (req) => {
      const text = await mockLlm(req);
      if (req.groupName === 'keywords') {
        return JSON.stringify({
          keywords: [
            { t: 'BrandX Probiotic', tier: 'negative', status: 'negative', evidence: 'Kept out of copy' },
            ...(JSON.parse(text) as { keywords: unknown[] }).keywords,
          ],
        });
      }
      return text;
    };
    // The golden mock resolves `productName` to 'BrandX Probiotic', so the row
    // above names the run's OWN canonical name — the live shape, one rename
    // short of it. (The `renamedTo` variants above cover the disagreeing name;
    // this covers the pipeline path end to end.)
    const listing = await optimize(snapshot, pack, liveShapedLlm);
    expect(listing.productName).toBe('BrandX Probiotic');
    const row = rowFor(listing.keywords ?? [], 'BrandX Probiotic');
    expect(row.status).not.toBe('negative');
    expect(row.note).toBeTruthy();
    expect(c28(listing)).toEqual([]);
    expect(gate(listing).pass).toBe(true);
  });
});

// ===========================================================================
// §2 — EQUALITY ONLY, AND `ownBrandIdentity` IS NOT WIDENED
// ===========================================================================

describe('§2 the exemption is narrow, and it lives outside `ownBrandIdentity`', () => {
  it('a term that merely SHARES WORDS with the canonical name is not exempted', () => {
    const l = renamedTo(RENAMED);
    const identity = productIdentity(l, snapshot);
    expect(identity.has('harbor row daily')).toBe(true);
    expect(identity.has('harbor row')).toBe(false);
    expect(identity.has('daily')).toBe(false);
    expect(identity.has('harbor row daily supplement')).toBe(false);
  });

  it('with NO canonical name there is nothing the gate compels, and nothing is exempted', () => {
    expect([...canonicalNameIdentity(undefined)]).toEqual([]);
    expect([...canonicalNameIdentity({ productName: '' } as OptimizedListing)]).toEqual([]);
  });

  it('`ownBrandIdentity` is UNCHANGED — the G2 hardening is not widened by any of this', () => {
    const l = renamedTo(RENAMED);
    // The model-authored name is still refused by the function that must refuse
    // it, because `rivalBrandNames` subtracts THAT set and only that set.
    expect(ownBrandIdentity(l, snapshot).has('harbor row daily')).toBe(false);
    expect([...ownBrandIdentity(l, snapshot)].sort()).toEqual(
      [...ownBrandIdentity({ productName: '' } as OptimizedListing, snapshot)].sort(),
    );
  });

  it('the two SNAPSHOT-derived sources still narrow to nothing without a snapshot; this one does not, deliberately', () => {
    const l = renamedTo(RENAMED);
    // No snapshot: no structured attributes to read and nothing to corroborate a
    // model-authored name against.
    expect([...ownBrandIdentity(l, undefined)]).toEqual([]);
    expect([...productPropertyIdentity(undefined)]).toEqual([]);
    // The canonical name is not conditioned on the snapshot, because it does not
    // rest on corroborating who wrote the name: C8/C15 compel that exact string
    // into the copy whatever its provenance. §3 is why that is safe.
    expect([...productIdentity(l, undefined).keys()]).toEqual(['harbor row daily']);
    expect(productIdentity(l, undefined).get('harbor row daily')).toBe('canonical-name');
  });
});

// ===========================================================================
// §3 — THE LAUNDERING PATH, MECHANISM BY MECHANISM
// ===========================================================================

/** The competitor ASIN an operator typed, carrying the rival's brand fields. */
const rivalCompetitor: CompetitorIngestion = {
  asin: 'B0RIVAL0001',
  snapshot: {
    ...snapshot,
    asin: 'B0RIVAL0001',
    title: 'A rival listing title',
    attributes: { brand_name: RIVAL, manufacturer: RIVAL },
  } as ListingSnapshot,
};

describe('§3 a run whose productName IS a rival still fails, from every mechanism', () => {
  it('THE ATTACK, STATED: naming the product after the rival DOES buy the keyword-row exemption', () => {
    // Said out loud rather than hidden: the coherence rule is keyed on what the
    // gate compels, so it fires here too. Everything below is why that is not a
    // way through.
    const l = renamedTo(RIVAL);
    expect(l.productName).toBe(RIVAL);
    const derived = deriveKeywordPlacement([negativeRow(RIVAL, 'Rival brand')], l, pack, snapshot);
    expect(derived[0]!.status).not.toBe('negative');
    expect(derived[0]!.note).toContain('CANONICAL PRODUCT NAME');
  });

  it('MECHANISM 1 — C8/C15 force the rival into the FIRST WORDS of the title, or fail the run', () => {
    const l = renamedTo(RIVAL);
    // The exemption cannot buy quiet placement: the same rule it rests on makes
    // the rival the most conspicuous string on the page.
    expect(l.title.startsWith(RIVAL)).toBe(true);
    expect(l.title75.startsWith(RIVAL)).toBe(true);
    expect(l.description).toContain(RIVAL);

    // And the alternative — keeping the rival out of the copy — is not available.
    const hidden = renamedTo(RIVAL);
    hidden.title = hidden.title.replace(RIVAL, 'Daily Blend');
    hidden.title75 = hidden.title75.replace(RIVAL, 'Daily Blend');
    hidden.description = hidden.description.split(RIVAL).join('Daily Blend');
    const ids = gate(hidden).failures.map((f) => `${f.checkId}|${f.field}`);
    expect(ids).toContain('C8|title');
    expect(ids).toContain('C8|description');
    expect(ids).toContain('C15|title75');
    expect(gate(hidden).pass).toBe(false);
  });

  it('MECHANISM 2 — the automatic rival set reads no label and no productName, so it still holds the rival', () => {
    const l = renamedTo(RIVAL);
    const names = rivalBrandNames([rivalCompetitor], l, snapshot);
    expect(names.map((n) => n.toLowerCase())).toContain(RIVAL.toLowerCase());
    // ...and naming the product after the rival did not change that set by one
    // entry: this leg never reads `productName` except through the NARROW
    // `ownBrandIdentity`, which refuses a name the snapshot does not corroborate.
    expect(names).toEqual(rivalBrandNames([rivalCompetitor], clean, snapshot));
  });

  it('MECHANISM 2, APPLIED — C28 fails on the very title mechanism 1 forced the rival into', () => {
    const l = renamedTo(RIVAL);
    // The exempted keyword row is present and clean; the automatic leg does not
    // care, because it is not a keyword row at all.
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(RIVAL, 'Rival brand')], l, pack, snapshot),
      ...NEGATIVE_FLOOR(),
    ];
    expect(rowFor(l.keywords, RIVAL).status).not.toBe('negative');

    const names = rivalBrandNames([rivalCompetitor], l, snapshot);
    const contexts = c28(l, names).map((f) => f.context);
    expect(contexts.some((c) => c.toLowerCase().includes(RIVAL.toLowerCase())), contexts.join(' | ')).toBe(true);
    expect(contexts.some((c) => c.includes('title')), contexts.join(' | ')).toBe(true);
    expect(gate(l, names).pass).toBe(false);
  });

  it('MECHANISM 3 — brandParity reports the disagreement with the scraped page', () => {
    const l = renamedTo(RIVAL);
    const advisory = brandParity(snapshot, l);
    expect(advisory).not.toBeNull();
    expect(advisory!.disagreements.map((d) => d.field)).toContain('brand_name');
    expect(advisory!.disagreements.some((d) => d.scraped === 'BrandX')).toBe(true);
    expect(advisory!.note).toContain('CONFIRM this before publishing');
  });

  it('MECHANISM 3, THE OTHER HALF — a rename that leaves the brand attributes alone makes the real brand unwritable (C7)', () => {
    // The only other way to make the rename is to leave the real brand in
    // `brand_name`/`manufacturer`. C7's exemption is keyed on `productName`
    // CONTAINING the brand — "the brand enters copy only as part of the
    // canonical product name" — so renaming the product away from its brand
    // makes that brand backend-only: an ordinary mention of it in copy, which
    // every real listing carries, now fails.
    //
    // BOTH DIRECTIONS, because the point is the exemption and not the sentence.
    const mention = (l: OptimizedListing): OptimizedListing => {
      l.description = `${l.description}\n\nMade by BrandX in a cGMP facility.`;
      return l;
    };
    const honest = mention(clone());
    expect(honest.productName).toContain('BrandX');
    expect(gate(honest).failures.filter((f) => f.checkId === 'C7')).toEqual([]);

    const renamed = mention(renamedTo(RIVAL, 'BrandX'));
    expect(renamed.attributes.brand_name).toBe('BrandX');
    expect(renamed.productName).toBe(RIVAL);
    const c7 = gate(renamed).failures.filter((f) => f.checkId === 'C7');
    expect(c7.length, JSON.stringify(gate(renamed).failures.map((f) => f.checkId))).toBeGreaterThan(0);
    expect(gate(renamed).pass).toBe(false);
  });
});

// ===========================================================================
// §4 — R50 IS UNWEAKENED: A GENUINE RIVAL STILL FAILS FROM EVERY SURFACE
// ===========================================================================

describe('§4 a rival that is NOT the canonical name still fails from every surface', () => {
  const PLANTED = 'GreenLuxe';

  const PLANTS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} ${PLANTED}`; }],
    ['bullet1', (l) => { l.bullets[0] = `Unlike ${PLANTED}: ${l.bullets[0]}`; }],
    ['description', (l) => { l.description = `${PLANTED} alternative. ${l.description}`; }],
    ['backend', (l) => { l.backendSearchTerms = `greenluxe ${l.backendSearchTerms}`; }],
    ['attributes', (l) => { l.attributes.product_benefit = `${l.attributes.product_benefit}; ${PLANTED} comparison`; }],
    ['A+ bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = `${PLANTED} banner`; }],
    ['videoBrief', (l) => { l.videoBrief!.onScreenText[0] = `Better than ${PLANTED}`; }],
    ['imagePlan altText', (l) => { l.imagePlan[0]!.altText = `${PLANTED} bottle on white`; }],
  ];

  it.each(PLANTS)('FAILS: the rival planted in %s', (_label, plant) => {
    // The run has renamed itself, so the canonical-name rule IS active — and it
    // must not reach a term that is not the canonical name.
    const l = renamedTo(RENAMED);
    plant(l);
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(PLANTED, 'Rival brand')], l, pack, snapshot),
      ...NEGATIVE_FLOOR(),
    ];
    const row = rowFor(l.keywords, PLANTED);
    expect(row.status).toBe('negative');
    expect(row.surfaces).toEqual([]);
    expect(row.note).toBeUndefined();

    const contexts = c28(l).map((f) => f.context);
    expect(
      contexts.some((c) => c.toLowerCase().includes(`negative term '${PLANTED.toLowerCase()}'`)),
      contexts.join(' | '),
    ).toBe(true);
    expect(gate(l).pass).toBe(false);
  });

  it('and PASSES while the rival is genuinely absent (not a check that fails everything)', () => {
    const l = renamedTo(RENAMED);
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(PLANTED, 'Rival brand')], l, pack, snapshot),
      ...NEGATIVE_FLOOR(),
    ];
    expect(c28(l)).toEqual([]);
    expect(gate(l).pass).toBe(true);
  });
});

// ===========================================================================
// §5 — THE FLOOR CANNOT BE PADDED BY THE RECLASSIFIED ROW
// ===========================================================================

describe('§5 minNegatives cannot be bought with the canonical name', () => {
  it('the floor is 3, and three self-references would otherwise have met it', () => {
    expect(pack.rules.keywordRules!.minNegatives).toBe(3);
  });

  it('a run whose ONLY negatives are self-references — the canonical name among them — FAILS', () => {
    const l = renamedTo(RENAMED);
    // One row per identity source: the canonical name, and the two brand fields
    // the SNAPSHOT declares (which is where `ownBrandIdentity` reads from).
    l.keywords = deriveKeywordPlacement(
      [
        negativeRow(RENAMED, 'Kept out of copy'),
        negativeRow(snapshot.attributes.brand_name!, 'Brand term'),
        negativeRow(snapshot.attributes.manufacturer!, 'Brand term'),
      ],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.every((r) => r.status !== 'negative')).toBe(true);
    const contexts = c28(l).map((f) => f.context);
    expect(contexts.length, contexts.join(' | ')).toBeGreaterThan(0);
    expect(gate(l).pass).toBe(false);
  });

  it('and the SAME rows plus three genuine negatives clear it — the floor still works', () => {
    const l = renamedTo(RENAMED);
    l.keywords = [
      ...deriveKeywordPlacement([negativeRow(RENAMED, 'Kept out of copy')], l, pack, snapshot),
      ...NEGATIVE_FLOOR(),
    ];
    expect(c28(l)).toEqual([]);
    expect(gate(l).pass).toBe(true);
  });
});
