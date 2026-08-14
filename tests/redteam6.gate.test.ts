import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import type { GateContext } from '@/lib/gate/checks';
import { crossPackDiseaseNouns } from '@/lib/gate/checks/pack';
import { scanConcatenated } from '@/lib/gate/util';
import { buildSystemPrompt } from '@/lib/engine/prompts/system';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';

/**
 * ROUND-6 RED TEAM.
 *
 * Every payload below PASSED the gate at HEAD 7a127f4. They are grouped by the
 * MECHANISM that let them through, and each group also carries the legitimate
 * copy that mechanism must keep accepting — a fix that trades one for the other
 * fails this file.
 */

const pack = loadPack('supplements');
const cp = pack.compliancePack!;
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
const failures = (l: OptimizedListing, c: GateContext = ctx): Failure[] => runGate(l, pack, c).failures;
const on = (l: OptimizedListing, id: string, field: string): Failure[] =>
  failures(l).filter((f) => f.checkId === id && f.field === field);

// ===========================================================================
// S1 — the s/es suffix swallowed the anchor and DROPPED the match
// ===========================================================================

/**
 * `compileConcatTerms` ends every alternative on an optional `(?:e?s)?`, and
 * `scanConcatenated` anchored on the end of the WHOLE match. When the word after
 * a split term began with `s`/`es`, the optional suffix ate that letter, the
 * anchor saw a letter and the finding was discarded — silently disabling the
 * entire partial-split defence for the most natural phrasing there is
 * ("… support", "… symptoms", "… sufferers").
 */
const S1_PAYLOADS = [
  'Real relief: can cer support for adults every single morning',
  'can-cer symptoms fade',
  'arth ritis support',
  'diab etes support',
  'tum or shrinkage',
  'g out support',
  'high-blood-pressure support',
  'sleep-apnea sufferers rest',
];

describe('S1 — a following s/es word no longer erases a split-term match', () => {
  it.each(S1_PAYLOADS)('"%s" FAILS C6 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Good to know: ${payload}*`; });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(S1_PAYLOADS)('"%s" FAILS A2 in an A+ FAQ answer', (payload) => {
    const l = mut((x) => {
      x.aplusContent.faq[0] = { q: 'Why this blend?', a: `Good to know: ${payload}.`, claimBearing: false };
    });
    expect(failures(l).some((f) => f.checkId === 'A2')).toBe(true);
  });

  /**
   * MECHANISM-LEVEL, not payload-level: every core noun, in all three inflected
   * forms the compiled alternation can produce, followed by a word starting with
   * `s` or `e`. Run against the pure scanner so the whole lexicon is covered
   * without 2,000 full gate runs.
   */
  const splitOnce = (term: string): string => {
    const head = term.split(' ')[0]!;
    if (head.length < 4) return `${head[0]} ${head.slice(1)}${term.slice(head.length)}`;
    const at = Math.floor(head.length / 2);
    return `${head.slice(0, at)} ${head.slice(at)}${term.slice(head.length)}`;
  };
  const NOUNS = cp.coreDiseaseNouns.filter((n) => n.replace(/[\s'-]/g, '').length >= 4);
  const FOLLOWERS = ['support', 'symptoms', 'sufferers', 'eases', 'every day'];

  it('covers a meaningful slice of the lexicon', () => {
    expect(NOUNS.length).toBeGreaterThan(100);
  });

  it.each(['', 's', 'es'])(
    'every core noun (+"%s") split once and followed by an s/e word is still matched',
    (suffix) => {
      const missed: string[] = [];
      for (const noun of NOUNS) {
        for (const follower of FOLLOWERS) {
          const text = `Daily relief: ${splitOnce(noun)}${suffix} ${follower} for adults`;
          if (scanConcatenated(text, cp.coreDiseaseNouns, 3, { mode: 'none' }).length === 0) {
            missed.push(`${noun}+${suffix} / ${follower}`);
          }
        }
      }
      expect(missed.slice(0, 15)).toEqual([]);
    },
  );
});

// ===========================================================================
// S2 — the disease scan was scoped to the ROUTED pack's own lexicon
// ===========================================================================

const cosmeticsSnap: ListingSnapshot = {
  asin: 'B0COSMETIC',
  url: 'https://www.amazon.com/dp/B0COSMETIC',
  title: 'GlowLab Niacinamide Face Serum for Daily Skincare Routine',
  bullets: ['Hydrating serum', 'b', 'c', 'd', 'e'],
  description: 'A lightweight face serum for daily skincare.',
  category: 'Beauty & Personal Care > Skin Care > Face',
  subcategory: [],
  attributes: { item_form: 'Serum', brand_name: 'GlowLab' },
  images: [],
  price: '$18.00',
  raw: {},
};

const MONEY_SHOT_BULLET = 'Cures cancer and reverses diabetes in eight weeks of daily use*';

describe('S2 — MONEY SHOT: a drug claim is illegal whatever the product is', () => {
  it('MONEY SHOT (cosmetics pack): the claim FAILS and the audit is NOT verified', async () => {
    const cosmetics = loadPack('cosmetics');
    const base = await optimize(cosmeticsSnap, cosmetics, mockLlm);
    const bad: OptimizedListing = JSON.parse(JSON.stringify(base));
    bad.bullets[0] = MONEY_SHOT_BULLET;
    const c: GateContext = { subcategories: ['skincare'], snapshotText: cosmeticsSnap.title };
    const gate = runGate(bad, cosmetics, c);
    expect(gate.pass).toBe(false);
    const hits = gate.failures.filter((f) => f.checkId === 'C6' && f.field === 'bullets[0]');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((f) => f.fix).join(' ').toLowerCase()).toContain('cancer');
    expect(buildAudit(cosmeticsSnap, bad, cosmetics, c).verified).toBe(false);
  });

  it('MONEY SHOT (supplements pack): the same claim split apart FAILS and is NOT verified', () => {
    const bad = mut((x) => { x.bullets[0] = 'Real relief: can cer support for adults every single morning*'; });
    const gate = runGate(bad, pack, ctx);
    expect(gate.pass).toBe(false);
    expect(gate.failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[0]')).toBe(true);
    expect(buildAudit(snapshot, bad, pack, ctx).verified).toBe(false);
  });

  it.each(['cancer', 'tumor', 'diabetes', 'arthritis', 'hypertension', 'depression', 'insomnia'])(
    'the systemic condition "%s" is enforced on the cosmetics pack too',
    (noun) => {
      const cosmetics = loadPack('cosmetics');
      const l: OptimizedListing = JSON.parse(JSON.stringify(clean));
      l.bullets[1] = `Daily support for ${noun} in adults every day*`;
      const gate = runGate(l, cosmetics, { subcategories: ['skincare'] });
      expect(gate.failures.some((f) => f.checkId === 'C6' && f.field === 'bullets[1]')).toBe(true);
    },
  );

  it('and on the supplements pack (both directions of the union)', () => {
    const l = mut((x) => { x.bullets[1] = 'Daily support for melasma in adults every day*'; });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// S3 — claim-shaped "negation" cues suppressed their own claim
// ===========================================================================

const S3_PAYLOADS = [
  "Don't let osteoporosis steal your bones",
  "Don't let arthritis slow you down",
  "Don't let insomnia rob your nights",
  'Do not let diabetes win',
  'Do not suffer migraines another day',
  'You must not accept arthritis pain',
  'You cannot let hypertension continue',
];

describe('S3 — an imperative is not a negation', () => {
  it.each(S3_PAYLOADS)('"%s" FAILS C6 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `${payload} with our blend*`; });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the verbatim disclaimer still passes', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it.each([
    'not intended to diagnose, treat, cure, or prevent any disease',
    'not intended to diagnose, treat, cure or prevent any disease',
  ])('the meta-phrase "%s" is still exempt in copy', (phrase) => {
    const l = mut((x) => { x.bullets[1] = `This product is ${phrase}*`; });
    expect(on(l, 'C6', 'bullets[1]')).toEqual([]);
  });
});

// ===========================================================================
// S4 — a meta-phrase fragment plus a connector laundered the claim
// ===========================================================================

const S4_PAYLOADS = [
  'Not intended to diagnose or the tumor shrinks within two weeks',
  'This is not a drug for hypertension yet users cut their pills',
  'Not a substitute for medical advice or cancer care',
];

describe('S4 — a disclaimer fragment no longer launders the claim behind it', () => {
  it.each(S4_PAYLOADS)('"%s" FAILS C6 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `${payload}*`; });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(S4_PAYLOADS)('"%s" FAILS A2 in an A+ module body', (payload) => {
    const l = mut((x) => { x.aplusContent.modules[2]!.body = `${payload}.`; });
    expect(failures(l).some((f) => f.checkId === 'A2')).toBe(true);
  });

  it('the real disclaimer forms still pass on every surface they appear on', () => {
    const l = mut((x) => {
      x.bullets[1] = `Third-party tested. ${cp.disclaimer}`;
      x.qa[0] = { q: 'Is this a drug?', a: 'No. This product is not intended to diagnose, treat, cure, or prevent any disease.', claimBearing: false };
    });
    expect(failures(l).filter((f) => f.checkId === 'C6')).toEqual([]);
  });
});

// ===========================================================================
// S5 — fullwidth / CJK compatibility punctuation
// ===========================================================================

const S5_PAYLOADS: [string, string][] = [
  ['＄24.99', 'fullwidth dollar sign'],
  ['﹩24.99', 'small dollar sign'],
  ['50％ off', 'fullwidth percent sign'],
  ['＃1 rated', 'fullwidth number sign'],
  ['care＠brandx。com', 'fullwidth at sign + ideographic full stop'],
  ['555・123・4567', 'katakana middle dot phone'],
];

describe('S5 — compatibility punctuation no longer hides a prohibited pattern', () => {
  it.each(S5_PAYLOADS)('"%s" (%s) FAILS C17/C18/C19 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Good to know ${payload}*`; });
    const ids = failures(l).filter((f) => f.field === 'bullets[1]').map((f) => f.checkId);
    expect(ids.some((id) => id === 'C17' || id === 'C18' || id === 'C19')).toBe(true);
  });

  it('the banned-symbol rules still see the symbols NFKC would dissolve', () => {
    for (const symbol of pack.rules.style.bannedSymbols) {
      const l = mut((x) => { x.bullets[1] = `Good to know about ${symbol} marks*`; });
      expect(
        failures(l).some((f) => f.checkId === 'C17' && f.field === 'bullets[1]'),
        `banned symbol ${symbol} must still be detected`,
      ).toBe(true);
    }
  });
});

// ===========================================================================
// S6 — C19 documents "no negation guard" but its fallback had the legacy one
// ===========================================================================

const S6_PAYLOADS = [
  'No fillers used, our formula is the b est seller',
  'Never any junk here, just a mira cle blend',
  'There is no filler here, only guarant eed results',
];

describe('S6 — C19 honours its own documented contract', () => {
  it.each(S6_PAYLOADS)('"%s" FAILS C19 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `${payload}*`; });
    expect(failures(l).some((f) => f.checkId === 'C19' && f.field === 'bullets[1]')).toBe(true);
  });
});

// ===========================================================================
// C-2 — the generator was failed on a rule it was never told
// ===========================================================================

describe('C-2 — allergen rules are injected into the system prompt', () => {
  it.each([
    ['supplements', loadPack('supplements')],
    ['cosmetics', loadPack('cosmetics')],
  ] as const)('%s: the prompt is a SUPERSET of every enforced allergen string', (_id, p) => {
    const cpx = p.compliancePack!;
    const prompt = buildSystemPrompt(p, clean.facts, ['general']);
    const missing = (cpx.allergenRules ?? [])
      .map((r) => r.canonicalString)
      .filter((s) => !prompt.includes(s));
    expect(missing, 'the gate compares these character for character').toEqual([]);
    for (const rule of cpx.allergenRules ?? []) {
      expect(prompt).toContain(rule.source);
    }
    expect(prompt).toContain(cpx.allergenFields.declaration);
    expect(prompt).toContain(cpx.allergenFields.declarationVerb);
    for (const phrase of cpx.noAllergenPhrases ?? []) expect(prompt).toContain(phrase);
  });

  it('the prompt still injects the FULL cross-pack noun set the gate enforces', () => {
    const prompt = buildSystemPrompt(pack, clean.facts, ['probiotic']);
    const missing = crossPackDiseaseNouns(pack).filter((n) => !prompt.includes(n));
    expect(missing.length, `prompt would hide ${missing.length} enforced terms`).toBe(0);
  });
});

// ===========================================================================
// C-3 — lexicon gaps
// ===========================================================================

const C3_TERMS = [
  'anaemia', 'oedema', 'haemorrhoids', 'diarrhoea', 'leukaemia', 'coeliac',
  'sarcoma', 'mpox', 'scabies',
  'mounjaro', 'oxycontin', 'chemotherapy', 'radiation therapy',
];

describe('C-3 — British spellings, missing nouns and missing drug/therapy names', () => {
  it.each(C3_TERMS)('"%s" is in the enforced union', (term) => {
    expect(crossPackDiseaseNouns(pack).map((t) => t.toLowerCase())).toContain(term);
  });

  it.each(C3_TERMS)('"%s" FAILS C6 in a bullet', (term) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${term} in adults every day*`; });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(['als', 'ms'])('the deliberately-removed abbreviation "%s" is still absent', (term) => {
    expect(crossPackDiseaseNouns(pack).map((t) => t.toLowerCase())).not.toContain(term);
  });
});
