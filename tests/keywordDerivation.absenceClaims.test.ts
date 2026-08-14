import { beforeAll, describe, expect, it } from 'vitest';
import {
  ABSENCE_CLAIM_STATUSES,
  deriveKeywordPlacement,
  MODEL_OWNED_STATUSES,
} from '@/lib/engine/keywordPlacement';
import { buildAudit } from '@/lib/audit/buildAudit';
import { keywordCoverage } from '@/lib/audit/keywordCoverage';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { rivalBrandNames } from '@/lib/audit/rivalBrands';
import { c28KeywordPlacement, keywordSurfaceText, type GateContext } from '@/lib/gate/checks';
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
 * E4 — `candidate` AND `not-targeted` ARE CLAIMS ABOUT THE COPY, SO CODE
 * DERIVES THEM. AND NOT ONE LEG OF C28 IS WEAKENED BY IT.
 *
 * THE LIVE DEFECT. ASIN B00IO89MYA, one run, SEVENTY-SEVEN C28 failures of a
 * single shape:
 *
 *   C28 | keywords[2] | candidate term "cat's claw" already appears on 'title'
 *   C28 | keywords[3] | candidate term 'quercetin' already appears on 'title'
 *       |             | /'bullet1'/'description'/'attributes'/'aplus'/'faq'/'qa'
 *   C28 | keywords[4] | candidate term 'vitamin c' already appears on … (x8)
 *
 * Those are the product's OWN INGREDIENTS. `candidate` means "a term NOT
 * currently in the copy, worth considering for a later cycle", and the copy was
 * full of them — the title names them because a supplement title must, the
 * attributes carry them because the template requires it, the A+ and the FAQ
 * discuss them because that is what the listing is about. C28 was RIGHT 77
 * times; the artifact was wrong 77 times; and no repair round could converge,
 * because the repair a `candidate` failure asks for is "remove the term from
 * the copy" and the term is the product.
 *
 * WHY THE PARTITION MOVED. E2 already established that a model must not be
 * asked to assert A FACT ABOUT THE COPY that code can compute exactly, and
 * moved the placement map into code — but it exempted FOUR statuses as
 * "model-owned". Re-derived from what each status actually asserts, only TWO
 * of them are:
 *
 *   negative      INTENT — "exclude this rival brand".              model-owned
 *   captured-via  INTENT + CLAIM ABOUT THE COPY — "absent, and      DERIVED
 *                 reached through `via` instead".                   (since E5)
 *   candidate     CLAIM ABOUT THE COPY — "not currently used".      DERIVED
 *   not-targeted  CLAIM ABOUT THE COPY — "not going after this".    DERIVED
 *
 * WHAT DERIVATION DOES, AND THE HALF IT REFUSES TO DO. A term the copy carries
 * becomes `placed`/`backend` with the true surfaces and the correction on
 * `note`. A term the copy carries NOWHERE keeps the model's own word for the
 * absence — because "held back for next cycle" and "deliberately left alone"
 * are two different strategy calls about an equally absent term, and no
 * substring search can tell them apart. Collapsing every absent row to
 * `candidate` would be the same error pointing the other way.
 *
 * BOTH DIRECTIONS THROUGHOUT, and the ones that matter are (d)-(g): R50 is
 * unweakened from all eight surfaces, the `captured-via` absence scan still
 * fires, the automatic competitor-derived rival set still fires, and the
 * `minNegatives` floor cannot be gamed by any of this.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, c: GateContext = ctx): Failure[] =>
  c28KeywordPlacement(l, pack, c);
const kr = () => pack.rules.keywordRules!;
const allSurfaces = (): string[] => [...kr().visibleSurfaces, ...kr().backendSurfaces];
const rowFor = (rows: KeywordTerm[], term: string): KeywordTerm =>
  rows.find((r) => r.term.toLowerCase() === term.toLowerCase())!;

/** Independent, dumb presence oracle — plain case-folded substring, no regex. */
const surfaceHas = (l: OptimizedListing, name: string, term: string): boolean =>
  (keywordSurfaceText(l, name) ?? '').toLowerCase().includes(term.toLowerCase());

const row = (term: string, status: string, extra: Partial<KeywordTerm> = {}): KeywordTerm =>
  ({ term, tier: 'strategy', status, surfaces: [], why: 'planted', ...extra }) as KeywordTerm;

/** Three GENUINE negatives — what a real reference records, and the floor. */
const NEGATIVE_FLOOR = (): KeywordTerm[] => [
  row('diabetes', 'negative', { tier: 'negative', why: 'Named condition' }),
  row('detox', 'negative', { tier: 'negative', why: 'Implied-treatment framing' }),
  row('greenluxe', 'negative', { tier: 'negative', why: 'Rival brand' }),
];

// ===========================================================================
// THE LIVE COPY SHAPE — the product's own ingredients, written where a real
// listing writes them. Nothing here is a gate workaround: it is the ordinary
// place an ingredient name lives.
// ===========================================================================

const INGREDIENTS = ["cat's claw", 'quercetin', 'vitamin c'] as const;

function withIngredientsInCopy(l: OptimizedListing): OptimizedListing {
  l.description = `${l.description}\n\nEvery serving also carries quercetin, vitamin C and cat's claw.`;
  // written INSIDE the bullet's own shape (before the claim marker) so the
  // fixture exercises C28 without tripping the bullet-format checks — the
  // point of the test is the keyword artifact, not a malformed bullet.
  l.bullets[0] = l.bullets[0]!.replace(/\*$/, 'with quercetin and vitamin C*');
  l.attributes.special_features = `${l.attributes.special_features ?? ''} quercetin, vitamin C`.trim();
  const m = l.aplusContent.modules[0]!;
  m.body = `${m.body} The blend adds quercetin and vitamin C.`;
  l.aplusContent.faq = [
    ...(l.aplusContent.faq ?? []),
    { q: 'Does it contain quercetin?', a: 'Yes, quercetin and vitamin C are both in the blend.', claimBearing: false },
  ];
  l.qa = [
    ...(l.qa ?? []),
    { q: 'Is vitamin C included?', a: 'Yes, vitamin C is part of the daily serving.', claimBearing: false },
  ];
  return l;
}

// ===========================================================================
// (a) THE LIVE SHAPE — `candidate` rows whose terms ARE in the copy
// ===========================================================================

describe('(a) the live shape: candidate rows naming the product\'s own ingredients', () => {
  const build = (): OptimizedListing => {
    const l = withIngredientsInCopy(clone());
    l.keywords = [...INGREDIENTS.map((t) => row(t, 'candidate', { tier: 'candidate' })), ...NEGATIVE_FLOOR()];
    return l;
  };

  it('the defect was REAL: underived, C28 reports every one of them', () => {
    const l = build();
    const fs = c28(l);
    for (const t of INGREDIENTS) {
      expect(
        fs.some((f) => f.context.includes('candidate term') && f.context.toLowerCase().includes(t)),
        t,
      ).toBe(true);
    }
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('derivation turns each one into `placed` with the TRUE surfaces', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    for (const t of INGREDIENTS) {
      const r = rowFor(l.keywords, t);
      expect(r.status, t).toBe('placed');
      expect(r.surfaces.length, t).toBeGreaterThan(0);
      // SOUNDNESS: every derived surface really carries the term.
      for (const name of r.surfaces) expect(surfaceHas(l, name, t), `${t} @ ${name}`).toBe(true);
      // COMPLETENESS: every surface that carries it is named.
      for (const name of allSurfaces()) {
        if (surfaceHas(l, name, t) && name !== 'bullets') {
          expect(r.surfaces, `${t} @ ${name}`).toContain(name);
        }
      }
    }
    // the live example, exactly: quercetin across the whole copy
    expect(rowFor(l.keywords, 'quercetin').surfaces).toEqual(
      expect.arrayContaining(['bullet1', 'description', 'attributes', 'aplus', 'faq']),
    );
  });

  it('the correction is RECORDED on `note` — never a silent rewrite', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    for (const t of INGREDIENTS) {
      const note = rowFor(l.keywords, t).note ?? '';
      expect(note, t).toContain('candidate');
      expect(note.toLowerCase(), t).toContain('derived');
    }
  });

  it('C28 reports NOTHING and the whole gate is green — the live failure, fixed', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (b) the same, for `not-targeted`
// ===========================================================================

describe('(b) a `not-targeted` row whose term is in the copy is derived too', () => {
  const build = (): OptimizedListing => {
    const l = withIngredientsInCopy(clone());
    l.keywords = [
      row('quercetin', 'not-targeted', { tier: 'strategy', why: 'Claimed to be left alone' }),
      ...NEGATIVE_FLOOR(),
    ];
    return l;
  };

  it('a term all over the copy IS targeted, whatever the row says', () => {
    const l = build();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const r = rowFor(l.keywords, 'quercetin');
    expect(r.status).toBe('placed');
    expect(r.surfaces.length).toBeGreaterThan(0);
    for (const name of r.surfaces) expect(surfaceHas(l, name, 'quercetin'), name).toBe(true);
    expect(r.note ?? '').toContain('not-targeted');
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('a `not-targeted` term that sits ONLY in the backend field derives to `backend`', () => {
    const l = clone();
    l.backendSearchTerms = `${l.backendSearchTerms} quercetin`;
    l.keywords = [row('quercetin', 'not-targeted', { tier: 'strategy' }), ...NEGATIVE_FLOOR()];
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack, snapshot);
    const r = rowFor(l.keywords, 'quercetin');
    expect(r.status).toBe('backend');
    expect(r.surfaces).toEqual(['backend']);
    expect(r.note ?? '').toContain('not-targeted');
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (c) THE OTHER DIRECTION — a genuinely absent row KEEPS ITS OWN LABEL
// ===========================================================================

describe('(c) a genuinely absent candidate / not-targeted keeps the model\'s label', () => {
  const ABSENT_CANDIDATE = 'organic probiotic';
  const ABSENT_NOT_TARGETED = 'weight loss';

  it('the premise: neither term is anywhere in the copy', () => {
    for (const t of [ABSENT_CANDIDATE, ABSENT_NOT_TARGETED]) {
      for (const name of allSurfaces()) expect(surfaceHas(clean, name, t), `${t} @ ${name}`).toBe(false);
    }
  });

  it('each keeps its own status, with empty surfaces and NO invented note', () => {
    const l = clone();
    const rows = [
      row(ABSENT_CANDIDATE, 'candidate', { tier: 'candidate', home: 'PPC exact' }),
      row(ABSENT_NOT_TARGETED, 'not-targeted', { tier: 'strategy' }),
    ];
    const derived = deriveKeywordPlacement(rows, l, pack, snapshot);
    expect(derived.map((r) => r.status)).toEqual(['candidate', 'not-targeted']);
    expect(derived.every((r) => r.surfaces.length === 0)).toBe(true);
    // nothing was changed, so nothing is annotated
    expect(derived.every((r) => r.note === undefined)).toBe(true);
    // `home` and every other model field survive untouched
    expect(rowFor(derived, ABSENT_CANDIDATE).home).toBe('PPC exact');
  });

  it('NOT every absent term becomes `candidate` — the strategy call is preserved', () => {
    const l = clone();
    const derived = deriveKeywordPlacement([row(ABSENT_NOT_TARGETED, 'not-targeted')], l, pack, snapshot);
    expect(rowFor(derived, ABSENT_NOT_TARGETED).status).toBe('not-targeted');
    expect(rowFor(derived, ABSENT_NOT_TARGETED).status).not.toBe('candidate');
  });

  it('the gate is green on the preserved labels', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [
        row(ABSENT_CANDIDATE, 'candidate', { tier: 'candidate', home: 'PPC exact' }),
        row(ABSENT_NOT_TARGETED, 'not-targeted', { tier: 'strategy' }),
        ...NEGATIVE_FLOOR(),
      ],
      l,
      pack,
      snapshot,
    );
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('a `placed`/`backend` row the copy carries NOWHERE is still downgraded to candidate, with a note', () => {
    const l = clone();
    const derived = deriveKeywordPlacement([row('unicorn dust', 'placed')], l, pack, snapshot);
    expect(rowFor(derived, 'unicorn dust').status).toBe('candidate');
    expect(rowFor(derived, 'unicorn dust').note ?? '').toContain('candidate');
  });
});

// ===========================================================================
// (d) R50 — UNWEAKENED. A RIVAL MARKED `negative` STILL FAILS FROM EVERY
//     SURFACE, THE INVISIBLE ONES INCLUDED.
// ===========================================================================

const RIVAL = 'GreenLuxe';

const PLANTERS: [string, (l: OptimizedListing, term: string) => void][] = [
  ['title', (l, t) => { l.title = `${l.title} ${t}`; }],
  ['bullet', (l, t) => { l.bullets[1] = `${l.bullets[1]} ${t}`; }],
  ['description', (l, t) => { l.description = `${l.description}\n${t}`; }],
  ['backend', (l, t) => { l.backendSearchTerms = `${l.backendSearchTerms} ${t}`; }],
  ['attributes', (l, t) => { l.attributes.special_features = `${l.attributes.special_features ?? ''} ${t}`; }],
  ['aplus bannerAltText', (l, t) => { l.aplusContent.modules[0]!.bannerAltText = `${l.aplusContent.modules[0]!.bannerAltText ?? ''} ${t}`; }],
  ['videoBrief', (l, t) => { l.videoBrief!.onScreenText = [...(l.videoBrief!.onScreenText ?? []), t]; }],
  ['imagePlan altText', (l, t) => { l.imagePlan[2]!.altText = `${l.imagePlan[2]!.altText} ${t}`; }],
];

describe('(d) R50 is unweakened: a rival marked negative still fails from all eight surfaces', () => {
  it.each(PLANTERS)('FAILS: the rival planted in %s', (_label, plant) => {
    const l = clone();
    plant(l, RIVAL);
    l.keywords = deriveKeywordPlacement(
      [row(RIVAL, 'negative', { tier: 'negative', why: 'Rival brand' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    // derivation left the intent alone — it did NOT launder the row into a placement
    const r = rowFor(l.keywords, RIVAL);
    expect(r.status).toBe('negative');
    expect(r.surfaces).toEqual([]);

    const fs = c28(l);
    expect(
      fs.some(
        (f) => f.context.toLowerCase().includes('negative term') && f.context.toLowerCase().includes(RIVAL.toLowerCase()),
      ),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('PASSES while the rival is genuinely absent — not a check that fails everything', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [row(RIVAL, 'negative', { tier: 'negative', why: 'Rival brand' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('a rival cannot be laundered by labelling it with an ABSENCE status either', () => {
    for (const status of ABSENCE_CLAIM_STATUSES) {
      const l = clone();
      l.aplusContent.modules[0]!.bannerAltText = `${RIVAL} banner`;
      l.keywords = deriveKeywordPlacement([row(RIVAL, status), ...NEGATIVE_FLOOR()], l, pack, snapshot);
      // derived truthfully to a PLACEMENT — the rival is now visibly in the
      // artifact's own map rather than hidden behind a status word...
      expect(rowFor(l.keywords, RIVAL).status, status).toBe('placed');
      expect(rowFor(l.keywords, RIVAL).surfaces, status).toContain('aplus');
      // ...and the automatic competitor set below still fails the run outright.
      expect(withRivals(l).length, status).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// (e) `captured-via` — the absence scan still fires, and a lawful row passes
// ===========================================================================

describe('(e) captured-via keeps BOTH legs', () => {
  const DEMAND = 'immune boost';

  it('UNDERIVED, C28 still FAILS a captured-via term sitting in the copy', () => {
    // The stored / hand-edited artifact: it never went through derivation, and
    // the everywhere-scan (item 6 of CONFORMANCE-DEVIATIONS.md) still catches
    // it. E5 changed the GENERATOR, not this leg — see the next case.
    const l = clone();
    l.description = `${l.description}\n${DEMAND} for the whole family.`;
    l.keywords = [
      row(DEMAND, 'captured-via', { tier: 'demand', via: 'the compliant daily wellness cluster' }),
      ...NEGATIVE_FLOOR(),
    ];
    expect(
      c28(l).some((f) => f.context.toLowerCase().includes('captured-via term')),
    ).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('DERIVED, the same row is corrected to its real placement instead (E5)', () => {
    const l = clone();
    l.description = `${l.description}\n${DEMAND} for the whole family.`;
    l.keywords = deriveKeywordPlacement(
      [row(DEMAND, 'captured-via', { tier: 'demand', via: 'the compliant daily wellness cluster' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    const r = rowFor(l.keywords, DEMAND);
    expect(r.status).toBe('placed');
    expect(r.surfaces).toContain('description');
    expect(r.note ?? '').toContain('captured-via');
    expect(c28(l).some((f) => f.context.toLowerCase().includes('captured-via term'))).toBe(false);
  });

  it('FAILS: a captured-via row with no route recorded', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [row(DEMAND, 'captured-via', { tier: 'demand' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(c28(l).some((f) => f.context.includes('no route recorded'))).toBe(true);
  });

  it('PASSES: absent term + documented route — K4 intact', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [row(DEMAND, 'captured-via', { tier: 'demand', via: 'the compliant daily wellness cluster' }), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(rowFor(l.keywords, DEMAND).status).toBe('captured-via');
    expect(rowFor(l.keywords, DEMAND).via).toBe('the compliant daily wellness cluster');
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });
});

// ===========================================================================
// (f) the AUTOMATIC competitor-derived rival set still fires
// ===========================================================================

const RIVAL_BRAND = 'Northwind Apothecary';
const competitor = (asin: string, attributes: Record<string, string>): CompetitorIngestion => ({
  asin,
  snapshot: { ...snapshot, asin, title: 'A rival listing title', attributes } as ListingSnapshot,
});
const RIVALS = [competitor('B0RIVAL0001', { brand_name: RIVAL_BRAND })];
const withRivals = (l: OptimizedListing): Failure[] =>
  c28KeywordPlacement(l, pack, { ...ctx, rivalBrands: rivalBrandNames(RIVALS, l, snapshot) });

describe('(f) the automatic competitor-derived rival set still fires', () => {
  it('FAILS: an ingested competitor brand in the copy, with NO negative row naming it', () => {
    const l = clone();
    l.description = `${l.description}\nBetter than ${RIVAL_BRAND}.`;
    l.keywords = deriveKeywordPlacement(NEGATIVE_FLOOR(), l, pack, snapshot);
    expect(
      withRivals(l).some((f) => f.context.includes('ingested competitor brand')),
    ).toBe(true);
  });

  it('FAILS EVEN when the row is labelled with an absence status and derived to `placed`', () => {
    for (const status of ABSENCE_CLAIM_STATUSES) {
      const l = clone();
      l.description = `${l.description}\nBetter than ${RIVAL_BRAND}.`;
      l.keywords = deriveKeywordPlacement([row(RIVAL_BRAND, status), ...NEGATIVE_FLOOR()], l, pack, snapshot);
      expect(rowFor(l.keywords, RIVAL_BRAND).status, status).toBe('placed');
      expect(
        withRivals(l).some((f) => f.context.includes('ingested competitor brand')),
        status,
      ).toBe(true);
    }
  });

  it('PASSES while the competitor brand is absent — the set is not a blanket failure', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(NEGATIVE_FLOOR(), l, pack, snapshot);
    expect(withRivals(l)).toEqual([]);
  });
});

// ===========================================================================
// (g) the `minNegatives` FLOOR cannot be gamed by the reclassification
// ===========================================================================

describe('(g) minNegatives survives derivation intact', () => {
  const min = () => kr().minNegatives ?? 0;

  it('the floor is real: one negative short still FAILS after derivation', () => {
    const l = withIngredientsInCopy(clone());
    l.keywords = deriveKeywordPlacement(
      [...INGREDIENTS.map((t) => row(t, 'candidate')), ...NEGATIVE_FLOOR().slice(0, min() - 1)],
      l,
      pack,
      snapshot,
    );
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });

  it('a row promoted OUT of an absence status never becomes a negative — the floor cannot be padded', () => {
    const l = withIngredientsInCopy(clone());
    // twenty absence rows, all of them derived to `placed`, and NO negatives
    const rows = INGREDIENTS.flatMap((t) => [row(t, 'candidate'), row(t, 'not-targeted')]);
    l.keywords = deriveKeywordPlacement(rows, l, pack, snapshot);
    expect(l.keywords.some((r) => r.status === 'negative')).toBe(false);
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });

  it('and the floor is satisfiable — the same artifact with its real negatives PASSES', () => {
    const l = withIngredientsInCopy(clone());
    l.keywords = deriveKeywordPlacement(
      [...INGREDIENTS.map((t) => row(t, 'candidate')), ...NEGATIVE_FLOOR()],
      l,
      pack,
      snapshot,
    );
    expect(l.keywords.filter((r) => r.status === 'negative')).toHaveLength(min());
    expect(c28(l)).toEqual([]);
  });
});

// ===========================================================================
// THE PARTITION HAS ONE SOURCE OF TRUTH, AND THE PROMPT IS TOLD IT
// ===========================================================================

describe('the status partition is stated once and reaches the prompt', () => {
  it('the two constants are disjoint and cover every non-placement status the pack knows', () => {
    for (const s of MODEL_OWNED_STATUSES) expect(ABSENCE_CLAIM_STATUSES).not.toContain(s);
    for (const s of [...MODEL_OWNED_STATUSES, ...ABSENCE_CLAIM_STATUSES]) {
      expect(kr().statuses).toContain(s);
    }
    // E5 moved `captured-via` across; the authoritative pin (with the reason
    // per status) lives in `tests/capturedVia.derivation.test.ts`.
    expect([...MODEL_OWNED_STATUSES].sort()).toEqual(['negative']);
    expect([...ABSENCE_CLAIM_STATUSES].sort()).toEqual([
      'candidate',
      'captured-via',
      'not-targeted',
    ]);
  });

  it('the keyword prompt tells the model the absence statuses describe ABSENT terms', () => {
    const p = buildGroupPrompts(pack).keywords(snapshot, clean);
    for (const s of ABSENCE_CLAIM_STATUSES) expect(p).toContain(s);
    expect(p).toMatch(/ABSENT FROM THE COPY ABOVE/);
    // and it still names the model-owned status as never overwritten
    expect(p).toMatch(/never overwritten/);
    for (const s of MODEL_OWNED_STATUSES) expect(p).toContain(s);
  });
});

// ===========================================================================
// THE CORRECTION REACHES THE DELIVERABLE — a rewrite the operator cannot see
// is a silent rewrite.
// ===========================================================================

describe('a derived correction is visible in the audit and the ship sheet', () => {
  const build = (): OptimizedListing => {
    const l = withIngredientsInCopy(clone());
    l.keywords = deriveKeywordPlacement(
      [
        row('quercetin', 'candidate', { tier: 'candidate' }),
        row('vitamin c', 'not-targeted', { tier: 'strategy' }),
        ...NEGATIVE_FLOOR(),
      ],
      l,
      pack,
      snapshot,
    );
    return l;
  };

  it('the coverage summary carries the note on the corrected `placed` rows', () => {
    const cov = keywordCoverage(build());
    for (const term of ['quercetin', 'vitamin c']) {
      const r = cov.placed.find((x) => x.term === term)!;
      expect(r, term).toBeTruthy();
      expect(r.note, term).toBeTruthy();
    }
    // a row nothing changed carries no note at all
    expect(cov.negatives.length).toBe(3);
  });

  it('the audit is VERIFIED and the ship sheet prints the correction', () => {
    const l = build();
    const audit = buildAudit(snapshot, l, pack, ctx);
    expect(audit.verified).toBe(true);
    const html = buildShipSheet({ optimized: l, audit, asin: 'B00IO89MYA', pack });
    expect(html).toContain('quercetin');
    expect(html).toMatch(/status and the surfaces were read off the copy/);
  });
});
