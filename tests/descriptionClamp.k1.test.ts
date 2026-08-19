import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { KEEP_FLOOR_FRACTION, clampDescription } from '@/lib/engine/descriptionClamp';
import { c4DescriptionLength, descriptionBudget } from '@/lib/gate/checks/c-length';
import { c5Disclaimer, c8ProductNameLead } from '@/lib/gate/checks/c-compliance';
import { a1AplusDisclaimer } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { buildAudit } from '@/lib/audit/buildAudit';
import { buildShipSheet, type ShipSheetRun } from '@/lib/export/shipSheet';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { GateContext } from '@/lib/gate/checks';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * K1 — C4 OVERSHOT A THIRD TIME, SO THE DESCRIPTION IS CLAMPED LIKE EVERY
 *      OTHER CAPPED SURFACE
 * ===========================================================================
 *
 * THE RECORD, three live observations against a canonical `descriptionMax` of
 * 2000 and a 158-character disclaimer reserve:
 *
 *   pre-margin    stated 1842 (the cliff)    model wrote 1930   +88    FAILED
 *   pre-margin    stated 1842 (the cliff)    model wrote 1861   +19    FAILED
 *   post-margin   stated 1731, margin 111    model wrote 1851   +120   FAILED
 *
 * The H1 margin was 6% of the writable budget — 111 characters, 1.26x the worst
 * overshoot then on record. The next overshoot was 120. Raising the margin
 * again would be fitting a fourth constant to three observations of a tail
 * nobody has measured, and it would be the third fix of the same defect.
 *
 * H1's own report contains the structural answer. It asked whether the other
 * capped surfaces have this problem and found that they do not, because CODE
 * CLAMPS THEM: `sanitizeBullets` truncates to `bulletMax` at a word boundary
 * and `sanitizeBackendSearchTerms` truncates to `backendMaxBytes` at a word
 * boundary, both in the deterministic assembly step, before the gate exists.
 * The description was the ONLY capped surface with no clamp and the ONLY capped
 * surface that kept failing. It is clamped now, in the same step, on the same
 * terms — see `lib/engine/descriptionClamp.ts` for the full reasoning and for
 * the explicit verdict on "never mutate content to force a gate pass".
 *
 * C4'S TRIGGER DOES NOT MOVE: empty, or assembled length over
 * `rules.descriptionMax`. The margin does not move either — the prompt still
 * states `target`, so the clamp only ever meets a description that already
 * ignored the number it was given.
 *
 * WHAT THIS FILE PINS, IN BOTH DIRECTIONS:
 *   §1  the clamp itself — boundaries, the never-mid-word rule, the floor,
 *       idempotence, and byte-identity for text already inside the budget;
 *   §2  all three recorded overshoots (+19, +88, +120) converge;
 *   §3  an in-budget description is emitted BYTE-IDENTICAL and unmarked;
 *   §4  the hard cap still fails when it genuinely should;
 *   §5  the disclaimer survives intact, exactly once, on the end;
 *   §6  a clamped description passes C5/A1/C8 and introduces NO gate failure
 *       the unclamped baseline did not already have;
 *   §7  the clamp is visible to the operator.
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const EMPTY_SNAPSHOT: ListingSnapshot = {
  asin: '', url: '', title: '', bullets: [], description: '', images: [],
  attributes: {}, category: '', subcategory: [], raw: null,
};

/** One context for every gate run here — the comparisons are like-for-like. */
const GATE_CTX: GateContext = { subcategories: [] };

/** The three overshoots in the record, measured against the STATED target. */
const RECORDED_OVERSHOOTS = [19, 88, 120] as const;

/**
 * Realistic prose of EXACTLY `chars` characters: several sentences, blank-line
 * paragraph breaks, and a final full stop. The earlier C4 tests write
 * `'a'.repeat(n)` — a single unbroken token with no sentence, paragraph or word
 * boundary anywhere — which is the right fixture for "the arithmetic is right"
 * and the wrong one for "the cut is clean". Both fixtures are used here, and
 * the boundary-less one is exactly the case in which the clamp DECLINES to act.
 */
function prose(chars: number): string {
  const parts = [
    'This daily formula is made for adults who want a simple routine they can keep.',
    'Each serving is measured so the amount you take is the amount on the label.',
    'Take it with water in the morning, or with a meal if that suits you better.',
    'The finish is smooth and the container is sized for a full month of use.',
    'Store it somewhere cool and dry, away from direct sun, with the lid closed.',
    'It is produced in a facility that follows documented quality procedures.',
  ];
  let s = 'A straightforward daily routine, written down plainly for the person buying it.';
  let i = 0;
  for (;;) {
    const next = (i % 3 === 2 ? '\n\n' : ' ') + parts[i % parts.length];
    if (s.length + next.length > chars - 3) break;
    s += next;
    i += 1;
  }
  const need = chars - s.length;
  // ' ' + one filler word + '.', sized to land on `chars` exactly and to end on
  // a sentence boundary, so the fixture's own tail is never the reason a cut
  // looks clean.
  return `${s} ${'quality'.repeat(need).slice(0, need - 2)}.`;
}

/** True unless the cut separated two word characters — the property, exactly. */
const cutIsCleanOf = (original: string, kept: string): boolean =>
  original.startsWith(kept) &&
  !(/\w/.test(kept.slice(-1)) && /\w/.test(original.charAt(kept.length)));

/** `mockLlm` with the description group overridden to write EXACTLY `text`. */
const writesText = (text: string): LlmClient => (req) =>
  req.user.includes('Write the product description')
    ? Promise.resolve(JSON.stringify({ description: text }))
    : mockLlm(req);

// ===========================================================================
// §1 — THE CLAMP ITSELF (a pure string function over a number)
// ===========================================================================

describe('K1 §1 — clampDescription', () => {
  const BUDGET = 1842; // the supplements cliff, used as a plain number here

  it('returns text already inside the budget BYTE-IDENTICALLY and unmarked', () => {
    for (const n of [0, 120, BUDGET - 1, BUDGET]) {
      const body = n === 0 ? '' : prose(n);
      const r = clampDescription(body, BUDGET);
      expect(r.text).toBe(body); // identity, not "passes"
      expect(r.clamped).toBe(false);
      expect(r.writtenChars).toBe(body.length);
      expect(r.keptChars).toBe(body.length);
    }
  });

  it('cuts an over-budget body at a SENTENCE boundary and never mid-word', () => {
    const body = prose(BUDGET + 300);
    const r = clampDescription(body, BUDGET);
    expect(r.clamped).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(BUDGET);
    expect(r.text.endsWith('.')).toBe(true);
    expect(cutIsCleanOf(body, r.text)).toBe(true);
    expect(r.writtenChars).toBe(body.length);
    expect(r.keptChars).toBe(r.text.length);
  });

  it('cuts back to a whole PARAGRAPH when that is the latest clean boundary', () => {
    // One paragraph that ends inside the budget, then an unbroken tail with no
    // sentence end at all: the paragraph break is the only structural boundary.
    const head = prose(BUDGET - 200);
    const tail = ' plus a run of trailing words carrying no terminal punctuation at all'.repeat(6);
    const r = clampDescription(`${head}\n\n${tail.trim()}`, BUDGET);
    expect(r.clamped).toBe(true);
    expect(r.text).toBe(head); // the whole paragraph, nothing of the tail
  });

  it('falls back to a WORD boundary when no sentence or paragraph end qualifies', () => {
    const body = `${'word '.repeat(500)}`.trim(); // 2499 chars, no '.' anywhere
    const r = clampDescription(body, BUDGET);
    expect(r.clamped).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(BUDGET);
    expect(r.text.endsWith('word')).toBe(true);
    expect(cutIsCleanOf(body, r.text)).toBe(true);
  });

  it('DECLINES when there is no boundary at all — it never cuts a word in half', () => {
    const body = 'a'.repeat(BUDGET + 500);
    const r = clampDescription(body, BUDGET);
    expect(r.clamped).toBe(false);
    expect(r.text).toBe(body);
  });

  it('DECLINES when the only boundary is shallower than the keep floor', () => {
    // One space at index 4, then an unbroken run: cutting there would throw the
    // description away, which is a thin-content failure wearing a fix's clothes.
    const body = `head${'z'.repeat(BUDGET + 400)}`.replace('head', 'head ');
    const r = clampDescription(body, BUDGET);
    expect(r.clamped).toBe(false);
    expect(r.text).toBe(body);
    expect(KEEP_FLOOR_FRACTION).toBeGreaterThan(0.5);
  });

  it('is IDEMPOTENT — clamping a clamped body changes nothing', () => {
    const once = clampDescription(prose(BUDGET + 400), BUDGET);
    const twice = clampDescription(once.text, BUDGET);
    expect(twice.clamped).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it('never leaves a dangling connective on the end', () => {
    // Budget 12: the window is 'alpha beta, ', the only boundary is the space
    // at 11, and the cut would otherwise end on the comma.
    const r = clampDescription('alpha beta, gamma delta', 12);
    expect(r.clamped).toBe(true);
    expect(r.text).toBe('alpha beta');
  });

  it('a non-string body and a nonsense budget are handled without throwing', () => {
    expect(clampDescription(undefined, BUDGET).text).toBe('');
    expect(clampDescription(null, BUDGET).clamped).toBe(false);
    const body = prose(BUDGET + 100);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampDescription(body, bad).text).toBe(body);
    }
  });
});

// ===========================================================================
// §2..§7 — THROUGH `optimize()`, ON EVERY SHIPPED PACK
// ===========================================================================

describe.each(PACK_IDS)('K1 — the description clamp end to end (%s)', (packId) => {
  const pack = loadPack(packId);
  const db = descriptionBudget(pack);
  const disclaimer = pack.compliancePack?.disclaimer ?? '';
  const c4 = (l: OptimizedListing): Failure[] => c4DescriptionLength(l, pack);
  const sheetFor = (l: OptimizedListing): string =>
    buildShipSheet({
      optimized: l,
      audit: buildAudit(snapshot, l, pack, GATE_CTX),
      asin: 'B0TESTASIN',
      pack,
    } satisfies ShipSheetRun);

  // -------------------------------------------------------------------------
  // §2 — ALL THREE RECORDED OVERSHOOTS CONVERGE
  // -------------------------------------------------------------------------

  it.each(RECORDED_OVERSHOOTS)(
    'the recorded overshoot of +%i past the stated target now converges',
    async (overshoot) => {
      const written = db.target + overshoot;
      const listing = await optimize(snapshot, pack, writesText(prose(written)));
      expect(c4(listing), `+${overshoot} must converge`).toEqual([]);
      expect(listing.description.length).toBeLessThanOrEqual(db.max);
      expect(listing.description.endsWith(disclaimer)).toBe(true);
      // …and the WHOLE assembled field, not just the body, is inside the cap.
      expect(
        runGate(listing, pack, GATE_CTX).failures.filter((f) => f.checkId === 'C4'),
      ).toEqual([]);
    },
  );

  it('and the +120 overshoot is the one the H1 MARGIN could not absorb', async () => {
    // The arithmetic that failed live: 1731 + 120 = 1851 written, which is past
    // the 1842 cliff, so the appended disclaimer carried the field over 2000.
    expect(db.target + 120).toBeGreaterThan(db.budget);
    expect(db.target + 120 + db.reserve).toBeGreaterThan(db.max);
    // The two SMALLER ones were already inside the cliff — the margin did its
    // job on them, and the clamp is not what saves those.
    expect(db.target + 88).toBeLessThanOrEqual(db.budget);
    expect(db.target + 19).toBeLessThanOrEqual(db.budget);

    const listing = await optimize(snapshot, pack, writesText(prose(db.target + 120)));
    expect(listing.descriptionClamped).toBeDefined();
    expect(listing.descriptionClamped!.writtenChars).toBe(db.target + 120);
    expect(listing.descriptionClamped!.keptChars).toBeLessThanOrEqual(db.budget);
  });

  it('a raised MARGIN would not have settled it — the clamp is what does', () => {
    // The margin sized against +88 and +19 was beaten by +120. This is the
    // statement of why the fix is structural rather than another constant: the
    // clamp holds for ANY overshoot, including one larger than every number in
    // the record put together.
    const absurd = clampDescription(prose(db.budget * 2), db.budget);
    expect(absurd.clamped).toBe(true);
    expect(absurd.text.length).toBeLessThanOrEqual(db.budget);
  });

  // -------------------------------------------------------------------------
  // §3 — AN IN-BUDGET DESCRIPTION IS UNTOUCHED (identity, not "passes")
  // -------------------------------------------------------------------------

  it('a description inside the budget is emitted BYTE-IDENTICALLY, with no marker', async () => {
    const body = prose(db.budget);
    const listing = await optimize(snapshot, pack, writesText(body));
    expect(listing.description).toBe(`${body}${'\n\n'}${disclaimer}`);
    expect(listing.description.length).toBe(db.max);
    expect(listing.descriptionClamped).toBeUndefined();
    expect('descriptionClamped' in listing).toBe(false);
    expect(c4(listing)).toEqual([]);
  });

  it('so is a description written to the stated TARGET, which is the normal case', async () => {
    const body = prose(db.target);
    const listing = await optimize(snapshot, pack, writesText(body));
    expect(listing.description).toBe(`${body}${'\n\n'}${disclaimer}`);
    expect(listing.descriptionClamped).toBeUndefined();
    expect(c4(listing)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // §4 — THE HARD CAP STILL FAILS WHEN IT GENUINELY SHOULD
  // -------------------------------------------------------------------------

  it('a boundary-less over-budget body is NOT clamped and C4 still fails', async () => {
    const listing = await optimize(snapshot, pack, writesText('a'.repeat(db.budget + 1)));
    expect(listing.descriptionClamped).toBeUndefined();
    expect(listing.description.length).toBe(db.max + 1);
    expect(c4(listing).map((f) => f.checkId)).toEqual(['C4']);
  });

  it("C4's EMPTY leg is untouched — the clamp adds nothing and removes nothing", () => {
    // Asserted against the check directly: `optimize()` appends the disclaimer
    // to an empty body, so the ASSEMBLED field is not empty and never was. What
    // matters is that C4's own empty trigger is exactly where it was.
    const empty = { description: '' } as OptimizedListing;
    expect(c4(empty).some((f) => f.context === '(empty)')).toBe(true);
    expect(clampDescription('', db.budget)).toEqual({
      text: '',
      clamped: false,
      writtenChars: 0,
      keptChars: 0,
    });
  });

  it('the C4 fix line is unchanged and still states the DERIVED target', async () => {
    const listing = await optimize(snapshot, pack, writesText('a'.repeat(db.budget + 200)));
    const failure = c4(listing)[0]!;
    expect(failure.fix).toContain(String(db.target));
    expect(failure.fix).not.toContain(String(db.budget));
  });

  // -------------------------------------------------------------------------
  // §5 — THE DISCLAIMER SURVIVES INTACT
  // -------------------------------------------------------------------------

  it('the disclaimer is appended to the CLAMPED body, whole and exactly once', async () => {
    const listing = await optimize(snapshot, pack, writesText(prose(db.budget + 400)));
    expect(listing.descriptionClamped).toBeDefined();
    expect(disclaimer.length).toBeGreaterThan(0);
    expect(listing.description.endsWith(disclaimer)).toBe(true);
    expect(listing.description.split(disclaimer)).toHaveLength(2);
    expect(listing.description.length).toBeLessThanOrEqual(db.max);
    // and the clamp cut the BODY, never the constant: the body is a prefix of
    // what the model wrote, and the disclaimer is not.
    const body = listing.description.slice(0, -(disclaimer.length + 2));
    expect(prose(db.budget + 400).startsWith(body)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // §6 — A CLAMPED DESCRIPTION INTRODUCES NO NEW FAILURE
  // -------------------------------------------------------------------------

  it('C5, C8 and A1 read the clamped field exactly as they read an unclamped one', async () => {
    const listing = await optimize(snapshot, pack, writesText(prose(db.budget + 400)));
    const baseline = await optimize(snapshot, pack, writesText(prose(db.budget)));
    expect(listing.descriptionClamped).toBeDefined();
    // C5 (verbatim disclaimer inside the description) and A1 (the A+ half) are
    // unaffected by the cut, in both listings, because the clamp runs BEFORE
    // the append and never touches A+ at all.
    expect(c5Disclaimer(listing, pack)).toEqual(c5Disclaimer(baseline, pack));
    expect(a1AplusDisclaimer(listing, pack)).toEqual(a1AplusDisclaimer(baseline, pack));
    // C8 asks for the product name in the description. Whatever the baseline
    // says, the clamped run says the same — the synthetic body carries no name
    // in either, so this pins the EQUIVALENCE rather than a passing verdict.
    expect(c8ProductNameLead(listing)).toEqual(c8ProductNameLead(baseline));
  });

  it('THE PROPERTY: a clamped listing has no gate failure its unclamped baseline lacks', async () => {
    // Constructed so the clamp cuts back to EXACTLY the baseline body: the tail
    // carries no sentence end, so the latest clean boundary is the baseline's
    // own closing full stop.
    const body = prose(db.budget);
    const tail = ' followed by an unpunctuated run of trailing words that pushes it over'.repeat(4);
    const baseline = await optimize(snapshot, pack, writesText(body));
    const clamped = await optimize(snapshot, pack, writesText(`${body}${tail}`));

    expect(clamped.descriptionClamped).toBeDefined();
    expect(clamped.description).toBe(baseline.description); // the cut landed on the boundary

    const before = runGate(baseline, pack, GATE_CTX);
    const after = runGate(clamped, pack, GATE_CTX);
    const key = (f: Failure): string => `${f.checkId}|${f.field}`;
    const introduced = after.failures
      .map(key)
      .filter((k) => !before.failures.map(key).includes(k));
    expect(introduced, 'the clamp introduced gate failures').toEqual([]);
    expect(after.failures.map(key)).toEqual(before.failures.map(key));
  });

  it('a clamp that cuts REAL text still introduces nothing the baseline did not have', async () => {
    const baseline = await optimize(snapshot, pack, writesText(prose(db.budget)));
    const clamped = await optimize(snapshot, pack, writesText(prose(db.budget + 350)));
    const key = (f: Failure): string => `${f.checkId}|${f.field}`;
    const before = new Set(runGate(baseline, pack, GATE_CTX).failures.map(key));
    const introduced = runGate(clamped, pack, GATE_CTX)
      .failures.map(key)
      .filter((k) => !before.has(k));
    expect(introduced).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // §7 — THE OPERATOR CAN TELL
  // -------------------------------------------------------------------------

  it('the prompt STATES the consequence, without ever naming the cliff', () => {
    const text = buildGroupPrompts(pack).description(EMPTY_SNAPSHOT);
    expect(text).toContain('cut by the system at a paragraph or sentence boundary');
    expect(text).toContain(String(db.target));
    expect(text, 'the cliff must still never be named').not.toContain(String(db.budget));
  });

  it('the Ship Sheet prints the two lengths beside the description when it was cut', async () => {
    const clamped = await optimize(snapshot, pack, writesText(prose(db.budget + 400)));
    const sheet = sheetFor(clamped);
    expect(sheet).toContain('Shortened by the system');
    expect(sheet).toContain(String(clamped.descriptionClamped!.writtenChars));
    expect(sheet).toContain(String(clamped.descriptionClamped!.keptChars));
  });

  it('and prints NOTHING of the sort on an ordinary run', async () => {
    const plain = await optimize(snapshot, pack, mockLlm);
    expect(plain.descriptionClamped).toBeUndefined();
    expect(sheetFor(plain)).not.toContain('Shortened by the system');
  });
});
