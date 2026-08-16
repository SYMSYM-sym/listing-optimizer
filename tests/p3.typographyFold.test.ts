import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { normalizeListingTypography } from '@/lib/engine/typography';
import { c17Style } from '@/lib/gate/checks/c-style';
import { c27OutputHygiene } from '@/lib/gate/checks/c-hygiene';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * P3 — THE EMIT-TIME FOLD NOW COVERS EVERY MODEL-WRITTEN SURFACE C27 SCANS
 * ===========================================================================
 *
 * THE RECORD ERROR THIS SUITE CLOSES. C27's docstring and item 1.2/M1 of
 * CONFORMANCE-DEVIATIONS.md both stated that the ASCII rule's premise — *"the
 * engine folded this text at emit, so anything non-ASCII that survives is a
 * real character"* — is **"false for this one group (`facts`) and false for no
 * other."** It was false for four: `normalizeListingTypography` also never
 * folded `imagePlan[].altText`, `aplusContent.modules[].bannerAltText`, or any
 * `videoBrief` string.
 *
 * THE DECISION, and why it went this way rather than into the carve-out list.
 * Those three are MODEL-WRITTEN copy. `facts` earns its exemption by being
 * source truth nobody wrote and no round can rewrite; none of that is true of
 * an ALT string. Leaving them unfolded was OVER-BLOCKING — a curly apostrophe
 * in `imagePlan[0].altText` was a C27 failure while the same apostrophe in
 * `imagePlan[0].notes` was folded away before the gate ever saw it, and this
 * project treats over-blocking as exactly as severe as a bypass. So the premise
 * is made true instead of the exemption widened.
 *
 * §1 THE FOLD reaches all three, every string of each.
 * §2 NOTHING IS LAUNDERED — banned symbols, emoji, invisibles and accented
 *    words survive the fold on the very same fields, and still fail.
 * §3 OPTIONALITY is preserved: a missing brief / ALT / banner ALT stays
 *    missing, so C29/C30 still report it as missing rather than as empty.
 * §4 THE PREMISE, asserted against the code rather than described: every
 *    surface group C27 scans is folded, EXCEPT the one that is exempt.
 * §5 BOTH DIRECTIONS end to end — the fold changes nothing about the golden
 *    run, and a listing that carries only typographic punctuation in the three
 *    fields passes the gate after assembly while the same listing NOT folded
 *    still fails, so the fix is doing the work and not the test.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const l = clone();
  fn(l);
  return l;
};
const onField = (fs: Failure[], field: string): Failure[] => fs.filter((f) => f.field === field);

/** One string carrying a curly quote, an en dash and an ellipsis character. */
const TYPOGRAPHIC = 'The bottle’s front label — fully legible…';
const FOLDED = "The bottle's front label - fully legible...";

// ===========================================================================
// §1 — THE FOLD REACHES ALL THREE
// ===========================================================================

describe('§1 the fold covers the three model-written surfaces it used to miss', () => {
  it('imagePlan[].altText — every slot', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.imagePlan = l.imagePlan.map((s) => ({ ...s, altText: TYPOGRAPHIC })); }),
    );
    for (const slot of folded.imagePlan) expect(slot.altText).toBe(FOLDED);
  });

  it('aplusContent.modules[].bannerAltText — every module', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.aplusContent.modules = l.aplusContent.modules.map((m) => ({ ...m, bannerAltText: TYPOGRAPHIC })); }),
    );
    for (const m of folded.aplusContent.modules) expect(m.bannerAltText).toBe(FOLDED);
  });

  it('videoBrief — aspect, every shot, every on-screen string and the notes', () => {
    const folded = normalizeListingTypography(
      mut((l) => {
        l.videoBrief!.aspect = TYPOGRAPHIC;
        l.videoBrief!.shots = l.videoBrief!.shots.map(() => TYPOGRAPHIC);
        l.videoBrief!.onScreenText = l.videoBrief!.onScreenText.map(() => TYPOGRAPHIC);
        l.videoBrief!.notes = TYPOGRAPHIC;
      }),
    );
    expect(folded.videoBrief!.aspect).toBe(FOLDED);
    expect(folded.videoBrief!.shots.every((s) => s === FOLDED)).toBe(true);
    expect(folded.videoBrief!.onScreenText.every((s) => s === FOLDED)).toBe(true);
    expect(folded.videoBrief!.notes).toBe(FOLDED);
    // …and the number rides through untouched
    expect(folded.videoBrief!.durationSeconds).toBe(clean.videoBrief!.durationSeconds);
  });

  it('NOT VACUOUS — the pre-P3 fold left all three exactly as written', () => {
    // Reconstruct the old behaviour: the fields simply were not in the mapping,
    // so they came out of the spread byte-identical to the input.
    const before = mut((l) => { l.imagePlan[0] = { ...l.imagePlan[0]!, altText: TYPOGRAPHIC }; });
    expect(before.imagePlan[0]!.altText).toBe(TYPOGRAPHIC);
    // The fold now changes it, which is what makes §1 an assertion about the fix.
    expect(normalizeListingTypography(before).imagePlan[0]!.altText).toBe(FOLDED);
  });

  it('the facts carve-out is untouched — a fact is still returned byte-identical', () => {
    const l = mut((x) => {
      x.title = 'BrandX Probiotic – 50 Billion CFU';
      (x.facts as unknown as Record<string, unknown>).servingSize = '1–2 Capsules';
    });
    const folded = normalizeListingTypography(l);
    expect(folded.title).not.toContain('–');
    expect(folded.facts.servingSize).toBe('1–2 Capsules');
  });
});

// ===========================================================================
// §2 — NOTHING IS LAUNDERED
// ===========================================================================

describe('§2 the fold cannot make a failing listing pass', () => {
  const PLANTS: [label: string, text: string][] = [
    ['a banned trademark symbol', 'Front label with the BrandX™ mark visible'],
    ['a currency sign', 'Front label beside a €9 coin for scale'],
    ['an emoji', 'Front label with the bottle in frame \u{1F600}'],
    ['a zero-width character', 'Front label​ fully legible in frame'],
    ['an accented word', 'Shot in a café with the bottle in frame'],
  ];

  const PUT: [field: string, put: (l: OptimizedListing, t: string) => void][] = [
    ['imagePlan[0].altText', (l, t) => { l.imagePlan[0] = { ...l.imagePlan[0]!, altText: t }; }],
    ['videoBrief.onScreenText[0]', (l, t) => { l.videoBrief!.onScreenText[0] = t; }],
    ['videoBrief.shots[0]', (l, t) => { l.videoBrief!.shots[0] = t; }],
    ['videoBrief.notes', (l, t) => { l.videoBrief!.notes = t; }],
    ['videoBrief.aspect', (l, t) => { l.videoBrief!.aspect = t; }],
  ];

  for (const [field, put] of PUT) {
    for (const [label, text] of PLANTS) {
      it(`${label} in ${field} survives the fold and still fails`, () => {
        const folded = normalizeListingTypography(mut((l) => put(l, text)));
        const hits = [...c17Style(folded, pack), ...c27OutputHygiene(folded, pack)];
        expect(onField(hits, field).length, `${field} / ${label}`).toBeGreaterThan(0);
      });
    }
  }

  it('the A+ banner ALT is the same story — the symbol survives and A8/C17/C27 still fire', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.aplusContent.modules[0]!.bannerAltText = 'BrandX™ banner, café shot'; }),
    );
    expect(folded.aplusContent.modules[0]!.bannerAltText).toContain('™');
    expect(folded.aplusContent.modules[0]!.bannerAltText).toContain('é');
    expect(runGate(folded, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// §3 — OPTIONALITY IS PRESERVED
// ===========================================================================

describe('§3 a MISSING field stays missing — the fold must not turn it into an empty string', () => {
  it('no videoBrief in, no videoBrief out (C29 owns "the brief is missing")', () => {
    const folded = normalizeListingTypography(mut((l) => { delete l.videoBrief; }));
    expect(folded.videoBrief).toBeUndefined();
    expect('videoBrief' in folded).toBe(false);
  });

  it('a slot with no altText keeps having no altText (C30 owns "the ALT is missing")', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.imagePlan = l.imagePlan.map((s) => { const c = { ...s }; delete c.altText; return c; }); }),
    );
    for (const slot of folded.imagePlan) expect(slot.altText).toBeUndefined();
  });

  it('a module with no bannerAltText keeps having none (a text-only module has no banner)', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.aplusContent.modules = l.aplusContent.modules.map((m) => { const c = { ...m }; delete c.bannerAltText; return c; }); }),
    );
    for (const m of folded.aplusContent.modules) expect(m.bannerAltText).toBeUndefined();
  });

  it('a module with no subcopy still keeps none — the pre-existing guard is unchanged', () => {
    const folded = normalizeListingTypography(
      mut((l) => { l.aplusContent.modules = l.aplusContent.modules.map((m) => { const c = { ...m }; delete c.subcopy; return c; }); }),
    );
    for (const m of folded.aplusContent.modules) expect(m.subcopy).toBeUndefined();
  });
});

// ===========================================================================
// §4 — THE PREMISE, ASSERTED AGAINST THE CODE
// ===========================================================================

describe('§4 the ASCII premise is now true of every scanned group except the exempt one', () => {
  /**
   * One typographic character planted into EVERY string of a surface group,
   * then folded. A group is "folded" iff nothing typographic survives.
   *
   * The list of groups is the pack's own `outputHygiene.surfaces`, so a group
   * added there with no fold coverage fails HERE rather than in a live run.
   */
  const PLANT = '’—…'; // ’ — …
  const typographic = (s: string): boolean => /[‘’“”–—…]/.test(s);

  const plantInto: Record<string, (l: OptimizedListing) => void> = {
    title: (l) => { l.title += PLANT; },
    title75: (l) => { l.title75 += PLANT; },
    itemHighlights: (l) => { l.itemHighlights += PLANT; },
    bullets: (l) => { l.bullets = l.bullets.map((b) => b + PLANT); },
    description: (l) => { l.description += PLANT; },
    backendSearchTerms: (l) => { l.backendSearchTerms += PLANT; },
    qa: (l) => { l.qa = l.qa.map((x) => ({ ...x, q: x.q + PLANT, a: x.a + PLANT })); },
    imagePlan: (l) => {
      l.imagePlan = l.imagePlan.map((s) => ({
        ...s, purpose: s.purpose + PLANT, spec: s.spec + PLANT, notes: s.notes + PLANT,
        altText: (s.altText ?? '') + PLANT,
      }));
    },
    videoBrief: (l) => {
      l.videoBrief = {
        ...l.videoBrief!,
        aspect: l.videoBrief!.aspect + PLANT,
        shots: l.videoBrief!.shots.map((s) => s + PLANT),
        onScreenText: l.videoBrief!.onScreenText.map((s) => s + PLANT),
        notes: l.videoBrief!.notes + PLANT,
      };
    },
    attributes: (l) => {
      l.attributes = Object.fromEntries(Object.entries(l.attributes).map(([k, v]) => [k, v + PLANT]));
    },
    aplus: (l) => {
      l.aplusContent.modules = l.aplusContent.modules.map((m) => ({
        ...m, headline: m.headline + PLANT, body: m.body + PLANT,
        ...(m.subcopy === undefined ? {} : { subcopy: m.subcopy + PLANT }),
        ...(m.bannerAltText === undefined ? {} : { bannerAltText: m.bannerAltText + PLANT }),
      }));
      l.aplusContent.comparison.rows = l.aplusContent.comparison.rows.map((r) => ({
        label: r.label + PLANT, ours: r.ours + PLANT, typical: r.typical + PLANT,
      }));
      l.aplusContent.faq = l.aplusContent.faq.map((f) => ({ ...f, q: f.q + PLANT, a: f.a + PLANT }));
    },
    facts: (l) => {
      l.facts = Object.fromEntries(
        Object.entries(l.facts).map(([k, v]) => [k, typeof v === 'string' ? v + PLANT : v]),
      ) as OptimizedListing['facts'];
    },
  };

  /**
   * The ONE group the fold deliberately does not reach. Note this is NOT the
   * same set as `asciiExemptSurfaces`: `backendSearchTerms` is ASCII-exempt and
   * still folded, because its exemption is about a DIACRITIC being the query,
   * not about the fold — the field is model-written like any other and its
   * smart quotes are still a defect.
   */
  const FOLD_EXEMPT = new Set(['facts']);

  it('every group C27 scans has a fold planter here (no group is silently untested)', () => {
    const missing = (pack.rules.outputHygiene!.surfaces ?? []).filter((g) => !(g in plantInto));
    expect(missing, `no fold planter for: ${missing.join(', ')}`).toEqual([]);
  });

  it('the fold-exempt set is a SUBSET of the ASCII-exempt set — an unfolded group must be carved out', () => {
    const ascii = new Set(pack.rules.outputHygiene!.asciiExemptSurfaces ?? []);
    for (const g of FOLD_EXEMPT) {
      expect(ascii, `${g} is not folded, so C27's premise is false for it and it MUST be ASCII-exempt`).toContain(g);
    }
    // …and the converse does NOT hold: backendSearchTerms is ASCII-exempt for
    // its own reason and is folded like every other model-written surface.
    expect(ascii.has('backendSearchTerms')).toBe(true);
    expect(FOLD_EXEMPT.has('backendSearchTerms')).toBe(false);
  });

  for (const group of Object.keys(plantInto)) {
    it(`${group} — ${FOLD_EXEMPT.has(group) ? 'the ONE unfolded group, which is exactly why it is ASCII-exempt' : 'is folded, so the C27 premise holds for it'}`, () => {
      const folded = normalizeListingTypography(mut(plantInto[group]!));
      if (FOLD_EXEMPT.has(group)) {
        expect(typographic(JSON.stringify(folded.facts))).toBe(true);
      } else {
        const survivors = c27OutputHygiene(folded, pack)
          .filter((f) => f.context.includes('non-ASCII'))
          .map((f) => f.field);
        expect(survivors, `${group} still carries typographic punctuation after the fold`).toEqual([]);
      }
    });
  }
});

// ===========================================================================
// §5 — END TO END, BOTH DIRECTIONS
// ===========================================================================

describe('§5 the fold changes the run only where it should', () => {
  it('the golden run is byte-identical with and without it (nothing typographic to fold)', () => {
    expect(normalizeListingTypography(clean)).toEqual(clean);
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
  });

  /**
   * The punctuation is APPENDED to the shipped strings rather than replacing
   * them: the keyword reference is DERIVED from the finished copy, so swapping
   * an overlay line out would delete a placed term and fail C28 for a reason
   * that has nothing to do with the fold.
   */
  const typographicOnly = (): OptimizedListing =>
    mut((l) => {
      l.imagePlan[0] = { ...l.imagePlan[0]!, altText: `${l.imagePlan[0]!.altText ?? ''} — it’s legible…` };
      l.aplusContent.modules[0]!.bannerAltText = `${l.aplusContent.modules[0]!.bannerAltText ?? ''} — it’s legible…`;
      l.videoBrief!.onScreenText[0] = `${l.videoBrief!.onScreenText[0]} — it’s here…`;
      l.videoBrief!.notes = `${l.videoBrief!.notes} It’s vertical — always…`;
    });

  it('a listing whose ONLY defect is typographic punctuation in the three fields now passes…', () => {
    const result = runGate(normalizeListingTypography(typographicOnly()), pack, ctx);
    expect(result.failures.map((f) => `${f.checkId} ${f.field}: ${f.context}`)).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('…and the SAME listing unfolded still fails, so the fold is doing the work', () => {
    const failures = runGate(typographicOnly(), pack, ctx).failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.checkId === 'C27')).toBe(true);
    for (const field of ['imagePlan[0].altText', 'videoBrief.onScreenText[0]', 'videoBrief.notes']) {
      expect(failures.map((f) => f.field), field).toContain(field);
    }
    // the banner ALT is reported on the module surface it is concatenated into
    expect(failures.map((f) => f.field)).toContain('aplus.modules[brand-story]');
  });
});
