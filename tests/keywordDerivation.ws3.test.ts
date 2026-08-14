import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { deriveKeywordPlacement, MODEL_OWNED_STATUSES } from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { keywordsGroupSchemaFor } from '@/lib/engine/schemas';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { c28KeywordPlacement, keywordSurfaceText, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KeywordTerm, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS3 / E2 — THE PLACEMENT MAP IS DERIVED, AND C28 IS NOT WEAKENED BY IT.
 *
 * THE LIVE DEFECT. On all three production ASINs, every run, 21–22 C28
 * failures of one single shape:
 *
 *   keywords[2] 'digestive and immune support' declared placed on 'title' but
 *               does not appear there
 *   keywords[4] 'lgg strain'  declared placed on 'title'/'itemHighlights' ...
 *   keywords[8] 'vegetarian capsules' declared placed on 'bullet4'/'description' ...
 *
 * The model was asserting WHERE ITS OWN COPY HAD PLACED A TERM — a fact code
 * can compute exactly — and the repair loop could not converge because each
 * regeneration produced a fresh set of confident wrong claims.
 *
 * THE FIX IS ARCHITECTURAL, NOT A PROMPT TWEAK: the self-report no longer
 * exists. The model proposes terms, tiers, evidence and the four
 * intent-bearing statuses; code derives `surfaces` and resolves the placement
 * status from the finished copy through C28's own readers.
 *
 * WHAT MUST NOT CHANGE, and is asserted below in both directions: a `negative`
 * term anywhere still fails (R50 — the check's whole reason to exist), a
 * `backend` term on a visible surface still fails, a `captured-via` row with
 * no `via` still fails, an unknown surface in pack config still fails, and a
 * missing artifact still fails closed.
 */

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: 'probiotic' };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c28 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c28KeywordPlacement(l, p);
const kr = () => pack.rules.keywordRules!;
const allSurfaces = (): string[] => [...kr().visibleSurfaces, ...kr().backendSurfaces];
const rowFor = (l: OptimizedListing, term: string): KeywordTerm =>
  (l.keywords ?? []).find((r) => r.term === term)!;
/** Independent, dumb presence oracle — plain case-folded substring, no regex. */
const surfaceHas = (l: OptimizedListing, name: string, term: string): boolean =>
  (keywordSurfaceText(l, name) ?? '').toLowerCase().includes(term.toLowerCase());

/** The three negative rows any artifact needs to clear `minNegatives`. */
const NEGATIVE_FLOOR: KeywordTerm[] = [
  { term: 'diabetes', tier: 'negative', status: 'negative', surfaces: [], why: 'Named condition' },
  { term: 'detox', tier: 'negative', status: 'negative', surfaces: [], why: 'Implied-treatment framing' },
  { term: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], why: 'Rival brand' },
];

// ===========================================================================
// (a) THE LIVE FAILURE: a model that claims placements the copy does not have
// ===========================================================================

/**
 * The keywords group as production actually behaved: confident, specific and
 * wrong about where its own copy put things. The three lying terms are the
 * ones from the live log, verbatim.
 */
const LYING_TERMS = ['digestive and immune support', 'lgg strain', 'vegetarian capsules'];

const lyingKeywords = {
  keywords: [
    // ---- the live lies: claimed placed on surfaces that carry nothing of the sort
    { t: LYING_TERMS[0], tier: 1, status: 'placed', surfaces: ['title', 'attributes'], evidence: 'Head term the leaders lead with' },
    { t: LYING_TERMS[1], tier: 2, status: 'placed', surfaces: ['title', 'itemHighlights'], evidence: 'Named strain entity' },
    { t: LYING_TERMS[2], tier: 3, status: 'placed', surfaces: ['bullet4', 'description'], evidence: 'Form qualifier' },
    // ---- true terms, but declared on the WRONG surfaces
    { t: 'vegan', tier: 3, status: 'placed', surfaces: ['backend'], evidence: 'Filter facet' },
    { t: '50 billion cfu', tier: 2, status: 'placed', surfaces: ['qa'], evidence: 'Hero spec' },
    { t: 'acidophilus', tier: 'backend', status: 'placed', surfaces: ['description'], evidence: 'Common-name variant' },
    // ---- intent rows, which the model still owns
    { t: 'immune boost', tier: 'demand', status: 'captured-via', via: 'the compliant daily wellness cluster', evidence: 'Efficacy framing avoided' },
    { t: 'weight loss', tier: 'strategy', status: 'not-targeted', evidence: 'Adjacent intent converts badly' },
    { t: 'organic probiotic', tier: 'candidate', status: 'candidate', home: 'PPC exact', evidence: 'Certification not held' },
    ...NEGATIVE_FLOOR.map((r) => ({ t: r.term, tier: r.tier, status: r.status, evidence: r.why })),
  ],
};

const lyingLlm: LlmClient = async (req) => {
  if (req.user.includes('TASK: The keyword reference')) return JSON.stringify(lyingKeywords);
  return mockLlm(req);
};

describe('(a) a model that lies about placement no longer costs the run a single failure', () => {
  let lied: OptimizedListing;
  beforeAll(async () => {
    lied = await optimize(snapshot, pack, lyingLlm);
  });

  it('the lies were real lies — the copy carries those terms on NO surface', () => {
    for (const term of LYING_TERMS) {
      for (const name of allSurfaces()) {
        expect(surfaceHas(lied, name, term), `${term} @ ${name}`).toBe(false);
      }
    }
  });

  it('the emitted artifact carries the TRUE surfaces, never the claimed ones', () => {
    // claimed on 'backend', actually all over the visible copy
    const vegan = rowFor(lied, 'vegan');
    expect(vegan.status).toBe('placed');
    expect(vegan.surfaces).not.toContain('backend');
    for (const name of vegan.surfaces) expect(surfaceHas(lied, name, 'vegan'), name).toBe(true);

    // claimed 'placed' on description, actually backend-only
    const acidophilus = rowFor(lied, 'acidophilus');
    expect(acidophilus.status).toBe('backend');
    expect(acidophilus.surfaces).toEqual(['backend']);

    // claimed on 'qa', actually on the title cluster
    const hero = rowFor(lied, '50 billion cfu');
    expect(hero.status).toBe('placed');
    expect(hero.surfaces).toContain('title');
  });

  it('the three lying rows are DOWNGRADED with a note — never left claiming a placement', () => {
    for (const term of LYING_TERMS) {
      const row = rowFor(lied, term);
      expect(row.status, term).toBe('candidate');
      expect(row.surfaces, term).toEqual([]);
      expect(row.note, term).toBeTruthy();
      expect(row.note, term).toContain('candidate');
    }
  });

  it('C28 reports NOTHING and the whole gate is green — this is the live failure, fixed', () => {
    expect(c28(lied)).toEqual([]);
    expect(runGate(lied, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it('no row anywhere in the artifact declares a surface that does not carry its term', () => {
    for (const row of lied.keywords ?? []) {
      for (const name of row.surfaces) {
        expect(surfaceHas(lied, name, row.term), `${row.term} @ ${name}`).toBe(true);
      }
    }
  });
});

// ===========================================================================
// (b) R50 — A NEGATIVE TERM ANYWHERE STILL FAILS. UNWEAKENED.
// ===========================================================================

/**
 * The rival brand is the reason C28 exists (R50 / AM-9), and a recent audit
 * found a bypass in exactly this area. Derivation must never launder it: a
 * `negative` row is MODEL-OWNED, so it is carried through untouched and every
 * surface is still scanned for it — including the two invisible ones a stale
 * agency template hides in, A+ banner ALT and the video brief.
 */
describe('(b) R50 — a rival brand marked negative fails from every surface, after derivation', () => {
  const RIVAL = 'GreenLuxe';

  const PLANTS: [string, (l: OptimizedListing) => void][] = [
    ['title', (l) => { l.title = `${l.title} GreenLuxe`; }],
    ['bullet1', (l) => { l.bullets[0] = `Better than GreenLuxe: ${l.bullets[0]}`; }],
    ['description', (l) => { l.description = `GreenLuxe alternative. ${l.description}`; }],
    ['backend', (l) => { l.backendSearchTerms = `greenluxe ${l.backendSearchTerms}`; }],
    ['A+ bannerAltText', (l) => { l.aplusContent.modules[0]!.bannerAltText = `${RIVAL} banner`; }],
    ['videoBrief', (l) => { l.videoBrief!.onScreenText[0] = `Unlike ${RIVAL}`; }],
  ];

  it.each(PLANTS)('FAILS: the rival brand planted in %s', (_label, plant) => {
    const l = clone();
    plant(l);
    // Re-derive exactly as the engine does — the plant must survive derivation
    // as a negative row, not be quietly reclassified as a placement.
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack);
    const row = rowFor(l, 'greenluxe');
    expect(row.status).toBe('negative');
    expect(row.surfaces).toEqual([]);

    const fs = c28(l);
    expect(fs.some((f) => f.context.toLowerCase().includes('negative term') && f.context.toLowerCase().includes('greenluxe'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('PASSES while the rival brand is genuinely absent (not a check that fails everything)', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(l.keywords ?? [], l, pack);
    expect(c28(l)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('derivation NEVER rewrites an intent status — the four are model-owned', () => {
    const l = clone();
    const rows: KeywordTerm[] = [
      // every one of these terms IS in the copy, which is exactly when a
      // derivation bug would silently promote it to `placed`
      { term: 'vegan', tier: 'negative', status: 'negative', surfaces: [], why: 'planted' },
      { term: 'shelf stable', tier: 'candidate', status: 'candidate', surfaces: [], why: 'planted' },
      { term: 'prebiotic', tier: 'strategy', status: 'not-targeted', surfaces: [], why: 'planted' },
      { term: 'digestive balance', tier: 'demand', status: 'captured-via', surfaces: [], why: 'planted', via: 'cluster' },
    ];
    const derived = deriveKeywordPlacement(rows, l, pack);
    expect(derived.map((r) => r.status)).toEqual(['negative', 'candidate', 'not-targeted', 'captured-via']);
    expect(derived.every((r) => r.surfaces.length === 0)).toBe(true);
    for (const s of derived.map((r) => r.status)) expect(MODEL_OWNED_STATUSES).toContain(s);
  });
});

// ===========================================================================
// (c) a term the copy GENUINELY places — derived `placed`, exact surface list
// ===========================================================================

describe('(c) a genuinely placed term derives `placed` with the exact surface list', () => {
  const TERMS = ['vegan', '50 billion cfu', 'digestive balance', 'shelf stable'];

  it.each(TERMS)('"%s": every derived surface really carries it (soundness)', (term) => {
    const row = rowFor(clean, term);
    expect(row.status).toBe('placed');
    expect(row.surfaces.length).toBeGreaterThan(0);
    for (const name of row.surfaces) expect(surfaceHas(clean, name, term), name).toBe(true);
  });

  it.each(TERMS)('"%s": every surface that carries it is on the list (completeness)', (term) => {
    const row = rowFor(clean, term);
    for (const name of allSurfaces()) {
      if (!surfaceHas(clean, name, term)) continue;
      // The only permitted omission is the whole-bullets AGGREGATE when a
      // specific slot already names the same fact.
      const aggregateCoveredBySlot =
        name === 'bullets' && row.surfaces.some((s) => /^bullet\d+$/i.test(s));
      expect(row.surfaces.includes(name) || aggregateCoveredBySlot, `${term} @ ${name}`).toBe(true);
    }
  });

  it('a surface the term is NOT on is not on the list', () => {
    const row = rowFor(clean, 'vegan');
    expect(surfaceHas(clean, 'backend', 'vegan')).toBe(false);
    expect(row.surfaces).not.toContain('backend');
  });

  it('the bullets AGGREGATE is dropped when a specific slot matched (one fact, once)', () => {
    const l = clone();
    l.bullets[2] = `Vegetarian friendly: ${l.bullets[2]}`;
    const derived = deriveKeywordPlacement(
      [{ term: 'vegetarian friendly', tier: 3, status: 'placed', surfaces: [], why: 'x' }],
      l,
      pack,
    );
    expect(derived[0]!.surfaces).toContain('bullet3');
    expect(derived[0]!.surfaces).not.toContain('bullets');
  });
});

// ===========================================================================
// (d) BACKEND-ONLY: derived `backend`, and the leak rule still fails
// ===========================================================================

describe('(d) a term that lives only in the backend field', () => {
  const TERM = 'kombucha';
  const withBackendTerm = (): OptimizedListing => {
    const l = clone();
    l.backendSearchTerms = `${l.backendSearchTerms} ${TERM}`;
    return l;
  };

  it('derives `backend`, not `placed`, and names only the backend surface', () => {
    const l = withBackendTerm();
    const derived = deriveKeywordPlacement(
      [{ term: TERM, tier: 'backend', status: 'placed', surfaces: ['title'], why: 'variant' }],
      l,
      pack,
    );
    expect(derived[0]!.status).toBe('backend');
    expect(derived[0]!.surfaces).toEqual(['backend']);
  });

  it('the same term added to a VISIBLE surface still FAILS C28 (the leak rule is intact)', () => {
    const l = withBackendTerm();
    l.keywords = [
      ...deriveKeywordPlacement(
        [{ term: TERM, tier: 'backend', status: 'backend', surfaces: [], why: 'variant' }],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l)).toEqual([]);

    // now it leaks into customer copy while the row still says backend-only
    l.itemHighlights = `${l.itemHighlights}, ${TERM}`;
    expect(c28(l).some((f) => f.context.includes('also appears on visible surface'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('a backend row whose term is NOT in the backend field still FAILS', () => {
    const l = clone();
    l.keywords = [
      { term: TERM, tier: 'backend', status: 'backend', surfaces: ['backend'], why: 'variant' },
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l).some((f) => f.context.includes('not in the backend field'))).toBe(true);
  });
});

// ===========================================================================
// (e) a term the copy carries NOWHERE — downgraded, never `placed`
// ===========================================================================

describe('(e) a term that appears nowhere is downgraded, not asserted', () => {
  const GHOST = 'lgg strain';

  it('is derived as `candidate` with an explanatory note and no surfaces', () => {
    const derived = deriveKeywordPlacement(
      [{ term: GHOST, tier: 1, status: 'placed', surfaces: ['title', 'itemHighlights'], why: 'Named strain' }],
      clean,
      pack,
    );
    expect(derived[0]!.status).toBe('candidate');
    expect(derived[0]!.surfaces).toEqual([]);
    expect(derived[0]!.note).toContain("downgraded from 'placed'");
  });

  it('the downgraded row is CONSISTENT with the check that reads it', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement(
        [{ term: GHOST, tier: 1, status: 'placed', surfaces: [], why: 'Named strain' }],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l)).toEqual([]);
  });

  it('but the moment the copy DOES carry it, the stale downgrade fails (candidate must be absent)', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement(
        [{ term: GHOST, tier: 1, status: 'placed', surfaces: [], why: 'Named strain' }],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR,
    ];
    l.description = `${GHOST} included. ${l.description}`;
    expect(c28(l).some((f) => f.context.includes('candidate term'))).toBe(true);
  });
});

// ===========================================================================
// THE REST OF C28 IS UNTOUCHED — the fail-closed legs, restated here
// ===========================================================================

describe('C28 keeps every other leg', () => {
  it('captured-via with no route still FAILS', () => {
    const l = clone();
    l.keywords = [
      ...deriveKeywordPlacement(
        [{ term: 'immune boost', tier: 'demand', status: 'captured-via', surfaces: [], why: 'avoided' }],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l).some((f) => f.context.includes('no route recorded'))).toBe(true);
  });

  it('a missing artifact still FAILS CLOSED', () => {
    const l = clone();
    delete (l as { keywords?: unknown }).keywords;
    expect(c28(l).some((f) => f.checkId === 'C28')).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('an unknown surface name in PACK CONFIG still FAILS (closed world)', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    p.rules.keywordRules!.visibleSurfaces = [...p.rules.keywordRules!.visibleSurfaces, 'packagingInsert'];
    expect(c28(clean, p).some((f) => f.context.includes('packagingInsert'))).toBe(true);
    // and derivation never invents a placement on a surface it cannot read
    const derived = deriveKeywordPlacement(
      [{ term: 'vegan', tier: 3, status: 'placed', surfaces: [], why: 'x' }],
      clean,
      p,
    );
    expect(derived[0]!.surfaces).not.toContain('packagingInsert');
  });

  it('the negative FLOOR is still enforced after derivation', () => {
    const l = clone();
    l.keywords = deriveKeywordPlacement(
      [{ term: 'vegan', tier: 3, status: 'placed', surfaces: [], why: 'x' }],
      l,
      pack,
    );
    expect(c28(l).some((f) => f.context.includes('negative term(s)'))).toBe(true);
  });

  it('a term the copy places that the BANNED LEXICON forbids still FAILS the four-test screen', () => {
    const l = clone();
    l.description = `Maximum strength formula. ${l.description}`;
    l.keywords = [
      ...deriveKeywordPlacement(
        [{ term: 'maximum strength', tier: 1, status: 'placed', surfaces: [], why: 'volume' }],
        l,
        pack,
      ),
      ...NEGATIVE_FLOOR,
    ];
    expect(c28(l).some((f) => f.context.includes('matches the banned lexicon'))).toBe(true);
  });
});

// ===========================================================================
// THE CONTRACT: the model is no longer ASKED for surfaces
// ===========================================================================

describe('the surfaces field is gone from the model contract', () => {
  it('the prompt does not ask for it, and says why', () => {
    const text = buildGroupPrompts(pack).keywords(snapshot, {
      title: 't', title75: 't', itemHighlights: 'h', bullets: ['b'],
      description: 'd', backendSearchTerms: 'b', attributes: {},
    });
    expect(text).not.toContain('"surfaces": []');
    expect(text).toContain('DO NOT list surfaces');
    expect(text).toContain('computed from the copy above');
    // and the pack's own status split is rendered: the placement statuses are
    // computed, the intent statuses are the model's
    expect(text).toContain('are COMPUTED from the finished copy after you answer');
    expect(text).toContain('These statuses are YOURS and are never overwritten');
  });

  it('the schema no longer carries it, and a volunteered one is stripped rather than kept', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      term: `term number ${i}`,
      tier: 1,
      status: 'placed',
      surfaces: ['title', 'nonsenseSurface'],
      why: 'evidence for the row',
    }));
    const parsed = keywordsGroupSchemaFor(kr()).safeParse({ keywords: rows });
    expect(parsed.success).toBe(true);
    for (const row of parsed.data!.keywords) {
      expect(row as Record<string, unknown>).not.toHaveProperty('surfaces');
    }
  });

  it('the golden run still exercises every status the pack knows', () => {
    const statuses = new Set((clean.keywords ?? []).map((r) => r.status));
    for (const s of kr().statuses) expect(statuses.has(s as KeywordTerm['status']), s).toBe(true);
  });
});
