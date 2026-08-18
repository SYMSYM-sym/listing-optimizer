import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts, buildSystemPrompt } from '@/lib/engine/prompts';
import { sanitizeBackendSearchTerms } from '@/lib/engine/backendSanitize';
import { sanitizeBullets } from '@/lib/engine/bulletSanitize';
import {
  DESCRIPTION_MARGIN_FRACTION,
  DISCLAIMER_APPEND_SEPARATOR,
  c1TitleLength,
  c2Bullets,
  c3BackendBytes,
  c4DescriptionLength,
  c15NewTitlePolicy,
  descriptionBudget,
} from '@/lib/gate/checks/c-length';
import { utf8Bytes } from '@/lib/shared/utf8Bytes';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * C4 — THE DESCRIPTION BUDGET, AND WHY A REPAIR ROUND USED TO BE UNWINNABLE
 * ===========================================================================
 *
 * A live production run of ASIN B00EEEITVA ended `verified:false` on a SINGLE
 * C4 failure (one of six runs in the batch; the other five verified clean, and
 * the same ASIN verified on its other run). C4 routes correctly — `description`
 * has owned a row in `FIELD_TO_GROUP` since the table existed — so the loop DID
 * regenerate the right group, every round, and still did not converge.
 *
 * The cause was arithmetic, not routing. C4 measures the ASSEMBLED description,
 * which is the model's text PLUS the verbatim disclaimer `optimize()` appends
 * afterwards. Three places stated the budget and all three stated it wrong or
 * differently:
 *
 *   system prompt        "Description ≤2000 chars (leave ~250 chars headroom)"
 *   description prompt   "≤1700 chars"                (a hand-copied constant)
 *   C4's own fix line    "Shorten description to ≤2000 chars"
 *
 * The fix line is the one the repair loop feeds back verbatim
 * (`lib/engine/repair.ts` builds `[C4] description: <context> → FIX: <fix>`),
 * so it is the most specific and most recent instruction the model sees — and
 * a model that does exactly what it says writes 2000 characters, the engine
 * appends 158 more, and the next gate run reports the same failure. Obeying the
 * repair instruction REPRODUCED the defect. That is what the last three tests
 * below measure, in both directions.
 *
 * C4 IS NOT WEAKENED. Its trigger is byte-identical: empty, or assembled length
 * over `rules.descriptionMax`. Only the number it TELLS the model changed, and
 * every number now comes from one derived place (`descriptionBudget`).
 *
 * ===========================================================================
 * H1 — AND THEN THE CORRECT NUMBER WAS STILL THE WRONG THING TO SAY
 * ===========================================================================
 *
 * A later live run, ASIN B00IO89MYA:
 *
 *   C4 | description | 2019 chars (1861 written + 158 appended)
 *
 * By then every number above was right: `descriptionBudget` derived
 * max 2000 / reserve 158 / budget 1842, and the prompt AND the repair line both
 * said 1842. The model wrote 1861 — nineteen characters past a correctly-stated
 * ceiling — and the appended disclaimer carried the assembled field 19
 * characters past the hard cap. This was not an arithmetic defect; it was a
 * MARGIN defect. The number the model was told to hit was the exact number at
 * which failure begins.
 *
 * So the STATED number moved down and the CAP did not move at all:
 * `descriptionBudget` now also derives `margin` (6% of the writable budget,
 * sized against BOTH overshoots in the record — this one and the 88-character
 * one CONFORMANCE-DEVIATIONS.md §13.2 assessed as "no change") and
 * `target` (`budget - margin`), and `target` is what every prompt and every fix
 * line states. The four tests under THE MARGIN below pin the whole property in
 * both directions — writing the target passes, overshooting the target by the
 * whole margin STILL passes, and one character past the hard cap still FAILS.
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** Empty, so the prompt assertions read OUR text and never the source listing. */
const EMPTY_SNAPSHOT: ListingSnapshot = {
  asin: '', url: '', title: '', bullets: [], description: '', images: [],
  attributes: {}, category: '', subcategory: [], raw: null,
};

/**
 * `mockLlm` with the description group overridden to write EXACTLY `chars`
 * characters. Every other group is untouched, so the assembled listing is the
 * golden one with one surface resized — which is what makes the C4 result
 * attributable.
 */
const writes = (chars: number): LlmClient => (req) =>
  req.user.includes('Write the product description')
    ? Promise.resolve(JSON.stringify({ description: 'a'.repeat(chars) }))
    : mockLlm(req);

const c4Of = (l: Awaited<ReturnType<typeof optimize>>, pack: ReturnType<typeof loadPack>) =>
  c4DescriptionLength(l, pack);

describe.each(PACK_IDS)('C4 description budget — %s', (packId) => {
  const pack = loadPack(packId);
  const db = descriptionBudget(pack);
  const disclaimer = pack.compliancePack?.disclaimer ?? '';

  it('the budget is `descriptionMax` minus EXACTLY what the engine appends', () => {
    expect(db.max).toBe(pack.rules.descriptionMax);
    expect(db.reserve).toBe(DISCLAIMER_APPEND_SEPARATOR.length + disclaimer.length);
    expect(db.reserve).toBeGreaterThan(0);
    expect(db.budget + db.reserve).toBe(db.max);
  });

  it('the margin and the target are DERIVED from the budget, not carried', () => {
    expect(db.margin).toBe(Math.ceil(db.budget * DESCRIPTION_MARGIN_FRACTION));
    expect(db.target).toBe(db.budget - db.margin);
    // A margin that is not strictly positive is not a margin.
    expect(db.margin).toBeGreaterThan(0);
    // And it must not be so large the description stops being a deliverable:
    // the target keeps the great majority of the writable budget.
    expect(db.target).toBeGreaterThan(db.budget * 0.9);
    // and it is sized against the WORST overshoot in the record, not just the
    // most recent one: 88 chars on a stated 1842 (CONFORMANCE-DEVIATIONS §13.2).
    expect(db.margin).toBeGreaterThan(Math.ceil(db.budget * 0.0478));
  });

  it('a description written TO the budget survives the append and passes C4', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget));
    expect(listing.description.endsWith(disclaimer)).toBe(true);
    // The reserve is not an estimate: the assembled field lands exactly on the cap.
    expect(listing.description.length).toBe(db.max);
    expect(c4Of(listing, pack)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // THE MARGIN (H1) — the stated target sits BELOW the cliff, in both directions
  // -------------------------------------------------------------------------

  it('a model writing EXACTLY the stated target passes C4 with the disclaimer on', async () => {
    const listing = await optimize(snapshot, pack, writes(db.target));
    expect(listing.description.endsWith(disclaimer)).toBe(true);
    expect(listing.description.length).toBe(db.target + db.reserve);
    expect(listing.description.length).toBeLessThan(db.max);
    expect(c4Of(listing, pack)).toEqual([]);
  });

  it('overshooting the stated target BY THE WHOLE MARGIN still passes — the point of H1', async () => {
    // The live shape: 1861 written against a stated 1842 was a 19-char
    // overshoot. Here the model overshoots by the ENTIRE derived margin, which
    // is ~2.9x that, and the run still converges.
    const listing = await optimize(snapshot, pack, writes(db.target + db.margin));
    expect(listing.description.length).toBe(db.max);
    expect(c4Of(listing, pack)).toEqual([]);
  });

  it.each([19, 88])('the recorded overshoot of %i chars past the stated target passes now, and would NOT have before', async (LIVE_OVERSHOOT) => {
    expect(db.margin).toBeGreaterThan(LIVE_OVERSHOOT);
    const now = await optimize(snapshot, pack, writes(db.target + LIVE_OVERSHOOT));
    expect(c4Of(now, pack)).toEqual([]);
    // and the pre-H1 behaviour, reproduced from the same derived arithmetic:
    // the same overshoot against the OLD stated number (`budget`) still fails.
    const before = await optimize(snapshot, pack, writes(db.budget + LIVE_OVERSHOOT));
    expect(before.description.length).toBe(db.max + LIVE_OVERSHOOT);
    expect(c4Of(before, pack).map((f) => f.checkId)).toEqual(['C4']);
  });

  it('overshooting the HARD CAP still fails — C4 is not weakened by the margin', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget + 1));
    expect(listing.description.length).toBe(db.max + 1);
    expect(c4Of(listing, pack).map((f) => f.checkId)).toEqual(['C4']);
  });

  it('ONE character over the budget still fails C4 (the check is not weakened)', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget + 1));
    expect(listing.description.length).toBe(db.max + 1);
    const failures = c4Of(listing, pack);
    expect(failures.map((f) => f.checkId)).toEqual(['C4']);
  });

  it('the failure REPORTS both halves, so the number names text the model wrote', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget + 200));
    const failure = c4Of(listing, pack)[0]!;
    expect(failure.context).toContain(`${db.budget + 200} written`);
    expect(failure.context).toContain(`${db.reserve} appended`);
  });

  // -------------------------------------------------------------------------
  // THE CONVERGENCE PROPERTY — the point of the whole change
  // -------------------------------------------------------------------------

  it('OBEYING the C4 repair line converges in one round', async () => {
    const over = await optimize(snapshot, pack, writes(db.budget + 200));
    const failure = c4Of(over, pack)[0]!;
    // Exactly the string the repair loop pastes into the regeneration prompt.
    const repairLine = `[${failure.checkId}] ${failure.field}: ${failure.context} → FIX: ${failure.fix}`;
    const target = Number(/≤(\d+) chars/.exec(repairLine)?.[1]);
    expect(Number.isFinite(target), repairLine).toBe(true);

    const obedient = await optimize(snapshot, pack, writes(target));
    expect(c4Of(obedient, pack), `a model that writes ${target} chars must now pass`).toEqual([]);
  });

  it('the PRE-FIX repair line did NOT converge — aiming at descriptionMax still fails', async () => {
    // This is the live B00EEEITVA shape: the old fix said "Shorten description
    // to ≤2000 chars", the model complied, and C4 fired again on 2158.
    const obedientToTheOldLine = await optimize(snapshot, pack, writes(db.max));
    const failures = c4Of(obedientToTheOldLine, pack);
    expect(failures.map((f) => f.checkId)).toEqual(['C4']);
    expect(obedientToTheOldLine.description.length).toBe(db.max + db.reserve);
  });

  // -------------------------------------------------------------------------
  // THE PROMPTS AND THE GATE STATE THE SAME NUMBER
  // -------------------------------------------------------------------------

  it('every prompt that states the limit states the DERIVED target, and no stale number', () => {
    const system = buildSystemPrompt(pack, {}, []);
    const description = buildGroupPrompts(pack).description(EMPTY_SNAPSHOT);
    for (const [name, text] of [['system', system], ['description', description]] as const) {
      expect(text, `${name} must state the target the model writes to`).toContain(String(db.target));
      expect(text, `${name} must state what is appended`).toContain(String(db.reserve));
      // THE CLIFF IS NEVER STATED. `budget` is the exact count at which C4
      // begins to fail, and naming it is what B00IO89MYA obeyed.
      expect(text, `${name} must NOT state the cliff (${db.budget})`).not.toContain(String(db.budget));
    }
    // The hand-copied constants earlier rounds deleted, plus the cliff.
    for (const stale of ['1700', '~250 chars headroom']) {
      expect(`${system}\n${description}`, `stale constant '${stale}'`).not.toContain(stale);
    }
  });

  it('the C4 repair line states the DERIVED target and no stale number either', async () => {
    const over = await optimize(snapshot, pack, writes(db.budget + 200));
    const failure = c4Of(over, pack)[0]!;
    const repairLine = `[${failure.checkId}] ${failure.field}: ${failure.context} → FIX: ${failure.fix}`;
    expect(failure.fix).toContain(String(db.target));
    expect(failure.fix, 'the fix line must not name the cliff').not.toContain(String(db.budget));
    // The number a repair round actually extracts is the target.
    expect(Number(/≤(\d+) chars/.exec(repairLine)?.[1])).toBe(db.target);
  });
});

// ===========================================================================
// H1, THE OTHER HALF — DOES THE SAME LAND-ON-THE-CEILING RISK EXIST ELSEWHERE?
// ===========================================================================
//
// The margin above is a real cost (56 characters of description), so it is not
// applied to a surface that does not need it. The question was asked of every
// other capped surface and the answer is written down as EXECUTABLE evidence
// rather than as a claim, because "we checked" is not a test.
//
//   bullets (C2) and backend bytes (C3) — NO MARGIN, because code already
//   CLAMPS them. `sanitizeBullets` truncates each bullet to `bulletMax` (minus
//   one for the claim marker when the bullet carries it) and
//   `sanitizeBackendSearchTerms` truncates at a word boundary to
//   `backendMaxBytes`, both BEFORE the gate ever sees the listing. An overshoot
//   there cannot reach C2/C3 from a generated run at all, which is a stronger
//   guarantee than a margin, not a weaker one. Backend is the surface where the
//   "the model cannot count what the check counts" argument is sharpest — the
//   cap is UTF-8 BYTES and the prompt asks for other-language variants — and it
//   is precisely the one that is clamped.
//
//   title (C1), title75 and itemHighlights (C15) — NO MARGIN, deliberately, and
//   the reason is convergence rather than luck. C4 was unwinnable because the
//   quantity it measures is NOT the quantity the model wrote: the engine
//   appends the disclaimer afterwards, so a run could obey the stated number
//   exactly and still fail on a number it never wrote. On the title surfaces the
//   measured quantity IS the written string — nothing is appended to them — so
//   the failure quotes the model's own length and the fix quotes the same cap
//   the check applies, and one repair round is a straight edit. Spending title
//   characters (the scarcest keyword real estate on the page) to pre-empt a
//   failure the loop already repairs would cost ranking surface for nothing.
//   Both properties are asserted below.
//
//   PRECEDENT: this is the shape `keywordsGroupSchemaFor` already uses for the
//   keyword artifact's `why` field — the prompt states a shorter limit than the
//   schema enforces, so an ordinary overshoot never costs a round.

describe('H1 — the other capped surfaces', () => {
  const pack = loadPack('supplements');
  const r = pack.rules;
  const listing = (fields: Partial<OptimizedListing>): OptimizedListing =>
    fields as unknown as OptimizedListing;

  it('bullets: an overshoot is CLAMPED before the gate, so C2 cannot fire on it', () => {
    const over = Array.from({ length: r.bulletCount }, (_, i) => `${i} ${'b'.repeat(r.bulletMax + 200)}`);
    const clamped = sanitizeBullets(over, r.bulletMax);
    for (const b of clamped) expect(b.length).toBeLessThanOrEqual(r.bulletMax);
    expect(c2Bullets(listing({ bullets: clamped }), pack)).toEqual([]);
  });

  it('backend: a MULTI-BYTE overshoot is CLAMPED to the byte cap, so C3 cannot fire on it', () => {
    // Non-ASCII on purpose: the cap is bytes, the model counts characters, and
    // the prompt asks for other-language variants. This is the surface where
    // "the model cannot measure what the check measures" bites hardest.
    const raw = Array.from({ length: 120 }, (_, i) => `nährstoffe${i}`).join(' ');
    expect(utf8Bytes(raw)).toBeGreaterThan(r.backendMaxBytes);
    const clamped = sanitizeBackendSearchTerms(
      raw,
      { title: '', title75: '', itemHighlights: '' },
      r.backendMaxBytes,
    );
    expect(utf8Bytes(clamped)).toBeLessThanOrEqual(r.backendMaxBytes);
    expect(c3BackendBytes(listing({ backendSearchTerms: clamped }), pack)).toEqual([]);
  });

  it('title surfaces: the check measures EXACTLY the string the model wrote — nothing is appended', () => {
    const name = 'BrandX Probiotic';
    const title75 = `${name} ${'x'.repeat(r.title75Max)}`;
    const l = listing({
      title: 'a'.repeat(r.titleMaxLegacy + 7),
      title75,
      itemHighlights: 'h'.repeat(r.itemHighlightsMax + 7),
      productName: name,
    });
    const c1 = c1TitleLength(l, pack);
    const c15 = c15NewTitlePolicy(l, pack);
    // the context is the model's OWN length, and the fix names the same cap the
    // trigger uses — so obeying the fix converges, which is what C4 could not do.
    expect(c1.some((f) => f.context === `${r.titleMaxLegacy + 7} chars`)).toBe(true);
    expect(c1.some((f) => f.fix.includes(`≤${r.titleMaxLegacy} chars`))).toBe(true);
    expect(c15.some((f) => f.context === `${title75.length} chars`)).toBe(true);
    expect(c15.some((f) => f.fix.includes(`≤${r.title75Max} chars`))).toBe(true);
    expect(c15.some((f) => f.context === `${r.itemHighlightsMax + 7} chars`)).toBe(true);
  });

  it('and a title written TO its stated cap passes — the cap is the whole story there', () => {
    const name = 'BrandX Probiotic';
    const l = listing({
      title: 'a'.repeat(r.titleMaxLegacy),
      title75: `${name}${'x'.repeat(r.title75Max - name.length)}`,
      itemHighlights: 'h'.repeat(r.itemHighlightsMax),
      productName: name,
    });
    expect(c1TitleLength(l, pack)).toEqual([]);
    expect(c15NewTitlePolicy(l, pack)).toEqual([]);
  });
});
