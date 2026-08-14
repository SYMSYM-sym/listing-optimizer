import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKeywordPlacement } from '@/lib/engine/keywordPlacement';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { buildAudit } from '@/lib/audit/buildAudit';
import type { GateContext } from '@/lib/gate/checks';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';

/**
 * SEMANTIC EVASION — drug claims written with ZERO listed tokens.
 *
 * C6 scans a LEXICON. Every payload below is an unmistakable drug claim to a
 * human reader and contains no listed disease noun, no listed prescription-drug
 * name and no listed banned verb, so all ten used to come back
 * `pass:true, verified:true` on the supplements pack.
 *
 * C21 catches the claim SHAPE instead (`compliancePack.semanticDrugClaims` —
 * pack data; the gate holds no term of its own). This file asserts BOTH
 * directions in one place, because a shape heuristic that is not pinned in both
 * directions is one tuning session away from becoming a wall: over-blocking
 * lawful structure/function copy is a defect of exactly the same severity as
 * letting a drug claim through.
 */

const pack = loadPack('supplements');
const cosmeticsPack = loadPack('cosmetics');
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
  const coherent = withCoherentBulletFlags(copy);
  // WS3 — the keyword placement map is DERIVED from the copy, so a fixture
  // that rewrites a whole surface (this file replaces `qa` wholesale) re-derives
  // it, exactly as the engine does on every round. Nothing about C28 is
  // relaxed: `negative`/`candidate` rows are model-owned and pass through
  // untouched, which is what the R50 legs elsewhere depend on.
  return {
    ...coherent,
    keywords: deriveKeywordPlacement(coherent.keywords ?? [], coherent, pack),
  };
};

/** The ten payloads the adversarial auditor proved were passing, verbatim. */
const EVASIONS: string[] = [
  'shrinks the lump in your breast',
  'clears the plaque out of your arteries',
  'replaces your daily prescription pill',
  'so you can throw away your inhaler',
  'melts the growth away in weeks',
  'kills the bad cells that spread through the body',
  'ends the need for dialysis',
  'restores sight to failing eyes',
  'your doctor will take you off your blood pressure medication',
  'brings blood sugar back to normal so you can stop medication',
];

/** The ICD-code evasion found by the same auditor. */
const ICD_PAYLOAD = 'an effective treatment for ICD-10 E11.9';

/**
 * Ordinary, lawful DSHEA structure/function copy that uses the very same verbs
 * ("dissolve", "clears", "restores", "rebuilds", "melts", "kills", "removes").
 * Every one of these must produce ZERO failures — not just zero C21 failures.
 */
const LEGITIMATE: string[] = [
  'supports healthy circulation',
  'helps maintain normal blood sugar already within the normal range',
  'supports a healthy inflammatory response',
  'helps dissolve in water quickly',
  'clears space in your routine',
  'restores your energy after a workout',
  'rebuilds after exercise',
  'melts smoothly into your smoothie',
  'kills 99.9% of odors',
  'removes the guesswork',
];

/**
 * Required SAFETY copy that names a therapy on purpose. The pack's
 * `safeContextPhrases` are what keep these clean; without them the fix would
 * have blocked the one instruction a supplement label most needs to carry.
 */
const SAFETY_COPY: string[] = [
  'Do not stop taking your medication without speaking to a professional',
  'do not stop taking your medication without talking to a doctor',
  'This is not a substitute for prescription medication',
  'this is not a substitute for prescription medication',
  'Consult your doctor before starting any new routine',
];

/** Surfaces a claim can hide on. Each plant leaves every OTHER rule satisfied. */
const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
  ['bullets[1]', (l, s) => { l.bullets[1] = `Daily support: that ${s}*`; }],
  ['description', (l, s) => { l.description = `${l.description} It ${s}.`; }],
  ['qa[0].a', (l, s) => { l.qa[0] = { q: 'What should I know?', a: `It ${s}`, claimBearing: false }; }],
  ['aplus.faq[0].a', (l, s) => { l.aplusContent.faq[0] = { q: 'What should I know?', a: `It ${s}`, claimBearing: false }; }],
  ['attributes.special_ingredients', (l, s) => { l.attributes.special_ingredients = s; }],
  ['imagePlan[0].notes', (l, s) => { l.imagePlan[0]!.notes = `Overlay: ${s}`; }],
];

const onField = (l: OptimizedListing, field: string): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.field === field);

describe('R1 — semantic drug claims with zero listed tokens now FAIL (C21)', () => {
  for (const payload of [...EVASIONS, ICD_PAYLOAD]) {
    for (const [field, plant] of SURFACES) {
      it(`"${payload}" fails C21 on ${field}`, () => {
        const l = mut((x) => plant(x, payload));
        expect(onField(l, field).some((f) => f.checkId === 'C21')).toBe(true);
      });
    }
  }

  it.each(EVASIONS)('"%s" uses no term the LEXICON tier (C6) can see', (payload) => {
    // The point of the fix: C6 alone is blind to every one of these, which is
    // why the gate needed a shape tier rather than more nouns.
    const l = mut((x) => { x.bullets[1] = `Daily support: that ${payload}*`; });
    const failures = onField(l, 'bullets[1]');
    expect(failures.some((f) => f.checkId === 'C21')).toBe(true);
    expect(failures.every((f) => f.checkId !== 'C6')).toBe(true);
  });

  it.each(EVASIONS)('"%s" can never come back verified', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Daily support: that ${payload}*`; });
    expect(runGate(l, pack, ctx).pass).toBe(false);
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });

  it('the whole set planted at once fails, and every payload is named', () => {
    const l = mut((x) => {
      x.qa = EVASIONS.map((s, i) => ({ q: `Q${i}`, a: `It ${s}`, claimBearing: false }));
    });
    const c21 = runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C21');
    expect(new Set(c21.map((f) => f.field)).size).toBe(EVASIONS.length);
  });

  it('the cosmetics pack catches the same shapes', () => {
    const l = mut((x) => { x.bullets[1] = 'Daily support: that shrinks the lump in your breast*'; });
    const failures = runGate(l, cosmeticsPack, { subcategories: ['skincare'] }).failures;
    expect(failures.some((f) => f.checkId === 'C21' && f.field === 'bullets[1]')).toBe(true);
  });
});

describe('R1 — legitimate copy using the same verbs stays clean', () => {
  for (const text of LEGITIMATE) {
    for (const [field, plant] of SURFACES) {
      it(`"${text}" is clean on ${field}`, () => {
        const l = mut((x) => plant(x, text));
        expect(onField(l, field)).toEqual([]);
      });
    }
  }

  it('all ten legitimate phrases together leave the gate green', () => {
    const l = mut((x) => {
      x.qa = LEGITIMATE.map((text, i) => ({ q: `Q${i}`, a: text, claimBearing: false }));
    });
    expect(runGate(l, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it.each(SAFETY_COPY)('required safety copy "%s" is clean', (text) => {
    const l = mut((x) => { x.bullets[1] = `Good to know: ${text}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });

  it('safety copy does NOT launder a real claim in the same sentence', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Not a substitute for prescription medication, it also ends the need for dialysis*';
    });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });
});

/**
 * The heuristic's own boundaries, asserted rather than assumed: a
 * determiner-scoped target is a claim only when a determiner points at ONE
 * instance of it.
 */
describe('R1 — determiner-scoped targets', () => {
  it.each([
    'Supports healthy hair growth every day',
    'Removes the guesswork from cell growth support',
    'A blend that supports muscle mass in adults',
  ])('"%s" is clean', (text) => {
    const l = mut((x) => { x.bullets[1] = `Label detail: ${text}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });

  it.each([
    'Melts the growth away in weeks',
    'Dissolves the stone in a fortnight',
  ])('"%s" fails C21', (text) => {
    const l = mut((x) => { x.bullets[1] = `Label detail: ${text}*`; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });
});

/**
 * CONTEXT-QUALIFIED TARGETS — the fix for the plaque over-block.
 *
 * Some target nouns head a drug claim in one domain and ordinary lawful copy in
 * another. `plaque` was the worst case: it was determiner-scoped, which kept the
 * bare noun clean but still reported "removes the plaque from your teeth" — a
 * lawful oral-care sentence. It is now a PLAIN target carrying a
 * `requiresContext` list in pack data, so it counts only when an anatomical /
 * systemic context word sits inside the proximity window. That closes the
 * over-block AND closes a hole the determiner scoping left open ("removes
 * plaque from your arteries" has no determiner and used to pass).
 *
 * Both directions are asserted for every qualified target, because a shape
 * heuristic pinned in one direction only is one tuning session away from
 * becoming a wall: over-blocking lawful copy is a defect of exactly the same
 * severity as letting a drug claim through.
 */
const QUALIFIED_CLEAN: [string, string][] = [
  // 'plaque' — lawful oral care. The over-block this round removed.
  ['plaque', 'Removes the plaque from your teeth'],
  ['plaque', 'Helps reduce plaque and supports healthy gums'],
  ['plaque', 'Fights plaque between brushings'],
  ['plaque', 'Helps remove plaque with regular brushing'],
  ['plaque', 'Removes plaque with regular brushing'],
  ['plaque', 'Dissolves plaque on tooth enamel'],
  // 'stone' — the fruit, not the kidney.
  ['stone', 'Removes the stone from each cherry'],
  ['stone', 'Dissolves the stone fruit blend into your smoothie'],
  // 'growth' — hair and nails, not a tumour.
  ['growth', 'Restores the growth of your hair'],
  ['growth', 'Rebuilds the growth of healthy nails'],
  ['growth', 'Restores the natural growth cycle of your lashes'],
  // 'mass' — lean body mass, not a lesion.
  ['mass', 'Restores the muscle mass you lost'],
  ['mass', 'Rebuilds your muscle mass after training'],
];

const QUALIFIED_BLOCKED: [string, string][] = [
  ['plaque', 'Clears the plaque out of your arteries'],
  ['plaque', 'Dissolves arterial plaque in weeks'],
  ['plaque', 'Melts the plaque from your blood vessels'],
  ['plaque', 'Removes plaque from your arteries'],
  ['stone', 'Dissolves the stone in a fortnight'],
  ['stone', 'Breaks up the stone in your kidney'],
  ['growth', 'Melts the growth away in weeks'],
  ['growth', 'Shrinks the growth in your breast'],
  ['growth', 'Clears the growth from your skin'],
  ['mass', 'Rebuilds the mass in your legs'],
];

describe('R2 — context-qualified targets, both directions', () => {
  it.each(QUALIFIED_CLEAN)('[%s] lawful copy "%s" is clean on every surface', (_term, text) => {
    for (const [field, plant] of SURFACES) {
      const l = mut((x) => plant(x, text));
      expect(onField(l, field), field).toEqual([]);
    }
  });

  it.each(QUALIFIED_BLOCKED)('[%s] the drug-claim form "%s" fails C21', (_term, text) => {
    const l = mut((x) => { x.bullets[1] = `Label detail: ${text}*`; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });

  it('every qualified target is pinned in BOTH directions', () => {
    const clean = new Set(QUALIFIED_CLEAN.map(([t]) => t));
    const blocked = new Set(QUALIFIED_BLOCKED.map(([t]) => t));
    expect([...clean].sort()).toEqual([...blocked].sort());
  });

  /**
   * The targets that were CHECKED and deliberately left unqualified: they have
   * no lawful non-pathological sense in listing copy, so adding a context list
   * would only create a bypass.
   */
  it.each([
    'Removes the clot from your leg',
    'Clears the cyst away',
    'Removes the lesion in days',
  ])('unconditional target: "%s" fails C21 with no context word present', (text) => {
    const l = mut((x) => { x.bullets[1] = `Label detail: ${text}*`; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });
});

/**
 * R3 — OBFUSCATION. C21 used to scan the normalized surface text only, so every
 * de-obfuscation pass C6 has run for rounds walked straight past it: `shr1nks
 * the lump`, `sh rinks the lump`, `cl3ars the plaque out of your arteries` and
 * `ᴋɪʟʟꜱ the bad cells` evaded BOTH checks. C21 now runs over the same ADDITIVE
 * variant set (`util.obfuscationVariants` + the doubled-letter pass).
 *
 * The obfuscators below are written the way an evader would use them — a
 * mechanical transform of the payload — not tuned to the folds.
 */
const LEET_MAP: Record<string, string> = { e: '3', o: '0', a: '4', s: '5', t: '7' };
const HOMOGLYPH_MAP: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', s: 'ѕ',
  y: 'у', x: 'х', i: 'і',
};
const SMALL_CAP_MAP: Record<string, string> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ',
  g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ',
  m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ꞯ', r: 'ʀ',
  s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', y: 'ʏ',
  z: 'ᴢ',
};

const mapChars = (text: string, table: Record<string, string>): string =>
  [...text].map((ch) => table[ch.toLowerCase()] ?? ch).join('');

const OBFUSCATIONS: [string, (s: string) => string][] = [
  ['leetspeak', (s) => s.replace(/[eoast]/g, (ch) => LEET_MAP[ch]!)],
  ['doubled letters', (s) => s.replace(/\b([A-Za-z])/g, '$1$1')],
  // Splits the first token long enough to survive the split — the exact shape
  // of the `sh rinks the lump` evasion.
  ['separator split', (s) => s.replace(/\b([A-Za-z]{2})([A-Za-z]{3,})/, '$1 $2')],
  ['homoglyph', (s) => mapChars(s, HOMOGLYPH_MAP)],
  ['small caps', (s) => mapChars(s, SMALL_CAP_MAP)],
];

const OBFUSCATION_CASES: [string, string, string][] = OBFUSCATIONS.flatMap(
  ([name, fn]) =>
    [...EVASIONS, ICD_PAYLOAD].map(
      (payload) => [name, payload, fn(payload)] as [string, string, string],
    ),
);

describe('R3 — every payload still fails C21 under every obfuscation', () => {
  it.each(OBFUSCATION_CASES)('%s: "%s" -> "%s" fails C21', (_name, _payload, obfuscated) => {
    const l = mut((x) => { x.bullets[1] = `Daily support that ${obfuscated}*`; });
    expect(onField(l, 'bullets[1]').some((f) => f.checkId === 'C21')).toBe(true);
  });

  it('covers all eleven payloads times every obfuscation class', () => {
    expect(OBFUSCATION_CASES).toHaveLength(11 * OBFUSCATIONS.length);
  });

  it('an obfuscated payload can never come back verified', () => {
    for (const [, , obfuscated] of OBFUSCATION_CASES) {
      const l = mut((x) => { x.bullets[1] = `Daily support that ${obfuscated}*`; });
      expect(runGate(l, pack, ctx).pass, obfuscated).toBe(false);
    }
  });
});

/**
 * The other half of R3, and the one that decides whether the fix is an
 * improvement or a wall: the de-obfuscation passes must not manufacture a
 * finding on lawful copy. Every phrase below is scanned through the SAME
 * variant set and must stay completely clean.
 */
describe('R3 — the variant passes introduce no false positives', () => {
  it.each([
    ...LEGITIMATE,
    ...QUALIFIED_CLEAN.map(([, text]) => text),
    'do not stop taking your medication without talking to a doctor',
    'this is not a substitute for prescription medication',
  ])('"%s" is clean with every variant class armed', (text) => {
    // Sentence-cased so C17's bullet-capitalisation rule cannot mask the
    // point, and carried in the documented colon-header bullet shape so C31's
    // FORMAT rule cannot mask it either — the subject of this suite is the
    // phrase, not the wrapper.
    const bullet = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    const l = mut((x) => { x.bullets[1] = `Label detail: ${bullet}*`; });
    expect(onField(l, 'bullets[1]')).toEqual([]);
  });
});
