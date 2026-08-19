import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { c22NaturalState } from '@/lib/gate/checks/c-natural-state';
import { c7BrandLeakage, c8ProductNameLead } from '@/lib/gate/checks/c-compliance';
import { c15NewTitlePolicy } from '@/lib/gate/checks/c-length';
import { buildGroupPrompts, buildSystemPrompt } from '@/lib/engine/prompts';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * THE OTHER TWO LIVE FAILURES ON THE B00IO89MYA RUN — ONE DEFECT, ONE CORRECT
 * FINDING, AND THE EVIDENCE FOR EACH VERDICT.
 *
 * ============================================================================
 * C22 — A DEFECT. THE MANDATED SAFETY WARNING WAS FAILED BY ITS OWN ADJECTIVE.
 * ============================================================================
 *
 *   C22 | description | "f you are pregnant, nursing, have a known medical
 *       |             |  condition, or take medication"
 *
 * TWO separate things are wrong there and both are fixed:
 *
 *  1. THE FINDING ITSELF. That sentence IS the consult-a-professional safety
 *     warning, and `safety_warning` is a REQUIRED field of the supplements
 *     attribute template — the run was being failed for carrying text the
 *     template obliges it to carry, so no repair round could clear it without
 *     deleting a required warning. C22's safe-phrase list already blanked
 *     'have a diagnosed medical condition' and 'have a medical condition'
 *     before the scan; it did not blank 'have a KNOWN medical condition'. One
 *     adjective, and R1 paired the abnormality marker 'medical condition' with
 *     the natural state 'nursing'. The ordinary qualifiers that slot takes are
 *     now enumerated IN THE PACK (`naturalStateSafePhrases`) — enumerated, not
 *     wildcarded, so blanking stays span-local and a marketing claim written
 *     outside the phrase still fails. Both directions are asserted below.
 *
 *  2. THE REPORTED CONTEXT, which opened one character into "If". The pad
 *     around a match was a fixed character count and cut wherever it landed.
 *     A context is EVIDENCE and a fragment of a word is not a quote, so each
 *     edge is now pushed OUTWARD to a word boundary. Detection is untouched.
 *
 * ============================================================================
 * C7 — NOT A DEFECT. THE CHECK IS RIGHT AND THE REPAIR LOOP OWNS IT.
 * ============================================================================
 *
 *   C7 | description | contains backend-only 'Instant Immunity'
 *
 * At first glance this looks like the own-brand class that
 * `keywordDerivation.ownBrand.test.ts` closed. It is NOT, and the difference
 * is the one that matters: SATISFIABILITY.
 *
 *  - The C28 own-brand defect was UNSATISFIABLE. `negative` means "appears
 *    nowhere", and every compliant listing MUST carry its own brand in
 *    `brand_name`/`manufacturer`. No copy could exist that cleared it, so the
 *    loop could never converge and the incoherence had to be rejected in code.
 *  - C7 is SATISFIABLE, and it already exempts the legitimate case: the brand
 *    may appear in customer copy AS PART OF the canonical product name, and
 *    C7 skips entirely when `productName` carries the brand (which is also
 *    what C8 requires of the title). The live run's `productName` did NOT
 *    carry it and the description used the bare brand string anyway. Both
 *    exits exist, the description group OWNS the `description` field in
 *    `FIELD_TO_GROUP`, and one regeneration round reaches a clean state.
 *
 * So C7's TRIGGER, SURFACES and EXEMPTION are left exactly as they are.
 * Weakening any of them would re-open brand leakage on every surface for a
 * failure the loop is built to repair. Both directions are asserted below so the
 * verdict is a test rather than a claim.
 *
 * ---------------------------------------------------------------------------
 * WHAT DID CHANGE, AND WHY THE RUN STILL BURNED ITS ROUNDS
 * ---------------------------------------------------------------------------
 *
 * "Satisfiable" is not the same as "reachable in the rounds available", and this
 * run is the difference. The defect is C4-SHAPED — the constraint was never
 * stated where it could be acted on:
 *
 *  1. THE PROMPT INVITED THE FAILING CHOICE. `lib/engine/prompts/title.ts` said
 *     `"productName": the customer-facing product name (not the backend brand
 *     string if it differs)` — an active nudge towards a non-brand-led name —
 *     while `snapshotBlock` hands every group `Attributes: {"brand_name": …}`
 *     and the brand-led source title. Nothing anywhere said what that choice
 *     COSTS, so the model met C7 for the first time in a repair round. The rule
 *     is now stated in the title prompt AND in the system prompt's STRUCTURE
 *     section, before any copy is written.
 *  2. THE FIX LINE NAMED THE KEY, NOT THE STRING. "Remove the backend-only
 *     brand_name string from customer copy" identifies the attribute that is
 *     upset, offers no replacement, and routes to the `description` group —
 *     which cannot take the other exit at all, because `productName` is pinned
 *     by `runRepairLoop` and owned by the title group. Each message now names
 *     the exact offending string, why it is barred (the customer product name
 *     does not contain it) and the canonical product name to write instead.
 *
 * Both are asserted below (§C7 messages, §C7 prompt).
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c22 = (text: string): Failure[] =>
  c22NaturalState({ description: text } as unknown as OptimizedListing, pack);

// ===========================================================================
// C22 (1) — THE MANDATED SAFETY WARNING PASSES, IN EVERY ORDINARY PHRASING
// ===========================================================================

/** The live sentence, verbatim, plus the phrasings a generator reaches for. */
const SAFETY_WARNINGS = [
  'If you are pregnant, nursing, have a known medical condition, or take medication, consult your physician before use.',
  'If you are pregnant, nursing, have a diagnosed medical condition, or take medication, consult your physician before use.',
  'If you are pregnant, nursing, have a medical condition, or take medication, consult your physician before use.',
  'If you are pregnant, nursing, have an existing medical condition, or take medication, talk with your doctor first.',
  'If you are pregnant, nursing, have a pre-existing medical condition, or take medication, speak with your doctor first.',
];

describe('C22 — the mandated safety warning is not a disease claim', () => {
  it.each(SAFETY_WARNINGS)('PASSES: %s', (text) => {
    expect(c22(text)).toEqual([]);
  });

  it('the live sentence passes inside a real description, and the whole gate stays green', () => {
    const l = clone();
    l.description = l.description.replace(
      'If you are pregnant, nursing, or taking medication, consult your physician before use.',
      SAFETY_WARNINGS[0]!,
    );
    expect(l.description).toContain('have a known medical condition');
    expect(c22NaturalState(l, pack)).toEqual([]);
    expect(runGate(l, pack, ctx).pass).toBe(true);
  });

  it('the same warning in the REQUIRED safety_warning attribute passes too', () => {
    const l = clone();
    l.attributes.safety_warning = SAFETY_WARNINGS[0]!;
    expect(c22NaturalState(l, pack).filter((f) => f.field.includes('safety_warning'))).toEqual([]);
  });
});

// ===========================================================================
// C22 (2) — THE OTHER DIRECTION. BLANKING IS SPAN-LOCAL AND STILL STRICT.
// ===========================================================================

describe('C22 — the abnormality rules are unweakened by the wider safe list', () => {
  const STILL_FAIL: [string, string][] = [
    ['a claim written OUTSIDE the safe phrase', 'Formulated for known medical conditions during pregnancy.'],
    ['the diagnosed variant, outside the phrase', 'Made for diagnosed medical conditions in menopause.'],
    ['an abnormality marker beside a natural state', 'Relief from severe menopause symptoms every day.'],
    ['two abnormality markers together', 'Supports people with a chronic disorder.'],
    ['the marker attached to the state itself', 'For an abnormal menstrual cycle.'],
  ];

  it.each(STILL_FAIL)('FAILS: %s', (_label, text) => {
    expect(c22(text).length).toBeGreaterThan(0);
  });

  it('the safe phrase does not license the marker elsewhere in the SAME sentence', () => {
    const text =
      'If you have a known medical condition, note that this formula is for a severe menstrual cycle.';
    expect(c22(text).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// C22 (3) — THE REPORTED CONTEXT QUOTES WHOLE WORDS
// ===========================================================================

describe('C22 — the reported context never opens or closes mid-word', () => {
  const CASES = [
    'Relief from severe menopause symptoms every single day for everyone.',
    'Formulated for known medical conditions during pregnancy and beyond.',
    'Extraordinary support for an abnormal menstrual cycle, unquestionably.',
  ];

  it.each(CASES)('the context is a clean quote of: %s', (text) => {
    const fs = c22(text);
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) {
      // the quoted span really is a substring of the copy...
      expect(text).toContain(f.context);
      // ...and neither edge splits a word of it
      const at = text.indexOf(f.context);
      const before = text[at - 1];
      const after = text[at + f.context.length];
      expect(before === undefined || /[^\p{L}\p{N}]/u.test(before), `left edge of "${f.context}"`).toBe(true);
      expect(after === undefined || /[^\p{L}\p{N}]/u.test(after), `right edge of "${f.context}"`).toBe(true);
    }
  });

  it('the exact live shape no longer opens with a severed "f"', () => {
    // The pre-fix report read: "f you are pregnant, nursing, have a known ..."
    // The finding itself is gone; this asserts the FORMATTING fix independently
    // by using a sentence that still fails.
    const text = 'If it is a severe menopause case, ask us about it right away today.';
    const fs = c22(text);
    expect(fs.length).toBeGreaterThan(0);
    for (const f of fs) expect(f.context.startsWith('f ')).toBe(false);
  });
});

// ===========================================================================
// C7 — THE VERDICT, ASSERTED IN BOTH DIRECTIONS
// ===========================================================================

describe('C7 — brand leakage: the finding was correct, and the state is reachable', () => {
  const BRAND = 'Instant Immunity';

  const withBrand = (productName: string): OptimizedListing => {
    const l = clone();
    l.productName = productName;
    l.attributes.brand_name = BRAND;
    l.attributes.manufacturer = BRAND;
    l.description = `${BRAND} daily capsules. ${l.description}`;
    return l;
  };

  it('FAILS (correctly): the bare brand string in the description when productName omits it', () => {
    const fs = c7BrandLeakage(withBrand('Daily Immune Capsules'));
    expect(fs.some((f) => f.field === 'description' && f.context.includes(BRAND))).toBe(true);
  });

  it('PASSES: the SAME copy once productName carries the brand — the legitimate case is already exempt', () => {
    expect(c7BrandLeakage(withBrand(`${BRAND} Daily Immune Capsules`))).toEqual([]);
  });

  it('PASSES: the other exit — the description simply drops the bare brand string', () => {
    const l = withBrand('Daily Immune Capsules');
    l.description = l.description.replace(`${BRAND} daily capsules. `, '');
    expect(c7BrandLeakage(l)).toEqual([]);
  });

  it('so the failure is REPAIRABLE, unlike the C28 own-brand class: `description` has an owning group', async () => {
    const { fieldToGroup } = await import('@/lib/engine/repair');
    const fs = c7BrandLeakage(withBrand('Daily Immune Capsules'));
    const target = fs.find((f) => f.field === 'description')!;
    expect(fieldToGroup(target)).toBe('description');
  });

  /**
   * THE THIRD EXIT, AND THE ONE THE PROMPT NOW POINTS AT: a brand-led product
   * name clears C7, C8 and C15 SIMULTANEOUSLY. C8/C15 require the title to lead
   * with the PRODUCT NAME, never with the brand, so there is no contradiction to
   * resolve — which is why C7 is not over-broad.
   */
  it('PASSES C7 *and* C8 *and* C15 together on a brand-led product name', () => {
    const l = clone();
    l.attributes.brand_name = BRAND;
    l.attributes.manufacturer = BRAND;
    l.productName = `${BRAND} Daily Immune`;
    l.title = `${l.productName} Blend, 60 Count`;
    l.title75 = `${l.productName} Blend, 60 Count`;
    l.description = `${l.productName} blend. ${l.description}`;
    expect(c7BrandLeakage(l)).toEqual([]);
    expect(c8ProductNameLead(l)).toEqual([]);
    expect(c15NewTitlePolicy(l, pack)).toEqual([]);
  });
});

// ===========================================================================
// C7 MESSAGES — THE FIX LINE NAMES THE STRING, THE REASON AND THE REPLACEMENT
// ===========================================================================

describe('C7 — the repair instruction is actionable by the group it routes to', () => {
  const BRAND = 'Instant Immunity';
  const NAME = 'Daily Immune Capsules';

  const leaked = (): OptimizedListing => {
    const l = clone();
    l.productName = NAME;
    l.attributes.brand_name = BRAND;
    l.attributes.manufacturer = BRAND;
    l.description = `${BRAND} daily capsules. ${l.description}`;
    l.attributes.subject_keyword = `${BRAND} daily`;
    return l;
  };

  it('the customer-surface message names the exact offending string', () => {
    const f = c7BrandLeakage(leaked()).find((x) => x.field === 'description')!;
    expect(f.fix).toContain(`'${BRAND}'`);
    expect(f.fix).toContain('attributes.brand_name');
    expect(f.fix).toContain('description');
  });

  it('it says WHY the string is barred — the product name, quoted', () => {
    const f = c7BrandLeakage(leaked()).find((x) => x.field === 'description')!;
    expect(f.fix).toContain(`the customer product name is '${NAME}', which does not contain it`);
  });

  it('it names the canonical product name to write instead', () => {
    const f = c7BrandLeakage(leaked()).find((x) => x.field === 'description')!;
    expect(f.fix).toContain(`write '${NAME}'`);
  });

  it('the ATTRIBUTE message carries the same three facts', () => {
    const f = c7BrandLeakage(leaked()).find((x) => x.field === 'attributes.subject_keyword')!;
    expect(f.fix).toContain(`'${BRAND}'`);
    expect(f.fix).toContain(`the customer product name is '${NAME}'`);
    expect(f.fix).toContain(`write '${NAME}'`);
  });

  it('the PRE-FIX wording — which named the key and nothing else — is gone', () => {
    for (const f of c7BrandLeakage(leaked())) {
      expect(f.fix).not.toBe('Remove the backend-only brand_name string from customer copy');
      expect(f.fix).not.toBe('Remove the backend-only manufacturer string from customer copy');
    }
  });

  it('the CONTEXT is untouched, so the reported evidence is unchanged', () => {
    const f = c7BrandLeakage(leaked()).find((x) => x.field === 'description')!;
    expect(f.context).toBe(`contains backend-only '${BRAND}'`);
  });
});

// ===========================================================================
// C7 PROMPT — THE COST OF THE CHOICE IS STATED BEFORE ANY COPY IS WRITTEN
// ===========================================================================

describe('C7 — the prompts state the rule the gate enforces', () => {
  it('the SYSTEM prompt STRUCTURE section states it', () => {
    const prompt = buildSystemPrompt(pack, {}, []);
    expect(prompt).toContain('may enter customer copy ONLY as part of the product name');
    expect(prompt).toContain('every other attribute');
  });

  it('the TITLE prompt states the cost of a non-brand-led product name', () => {
    const prompt = buildGroupPrompts(pack).title(snapshot);
    expect(prompt).toContain('ONLY as part of this');
    expect(prompt).toContain('CONTAINS the brand string');
  });

  it('the sentence that INVITED the failing choice is gone', () => {
    const prompt = buildGroupPrompts(pack).title(snapshot);
    expect(prompt).not.toContain('not the backend brand string if it differs');
  });
});
