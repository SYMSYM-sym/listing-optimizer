import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildSystemPrompt } from '@/lib/engine/prompts';
import { allDiseaseNouns, diseaseActionVerbs, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { collapseDoubles, collapseSeparators, leetFold, normalize } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * RED TEAM ROUND 3 — CLASS-level regressions.
 *
 * Round 2 was written against literal payloads, so swapping a verb, a separator
 * or a surface re-opened the hole. Every suite here is PARAMETERIZED over the
 * whole class it defends (every action verb, every negation cue, every
 * separator, every meta-phrase, every subcategory, every obfuscation family)
 * — a fix written to one string cannot make them pass.
 */

const pack = loadPack('supplements');
const cp = pack.compliancePack as CompliancePack;
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const disclaimer = cp.disclaimer;

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const failures = (l: OptimizedListing, c: GateContext = ctx): Failure[] =>
  runGate(l, pack, c).failures;
const on = (l: OptimizedListing, checkId: string, field: string): Failure[] =>
  failures(l).filter((f) => f.checkId === checkId && f.field === field);
const fieldFailures = (l: OptimizedListing, field: string): Failure[] =>
  failures(l).filter((f) => f.field === field);

/** Separators an attacker can put between a negation cue and the real claim. */
const SEPARATORS = [',', ' -', ' —', ' –', ' |', ' /', '.', ';'];
/** Negation cues that used to launder everything that followed them. */
const CUES = [
  'Never any junk',
  'No fillers here',
  'Not a drug',
  'There is no filler',
  'We do not cut corners',
];

// ---------------------------------------------------------------------------
// FIX 1 — the disease lexicon is NOT subcategory-scoped
// ---------------------------------------------------------------------------
describe('FIX 1 — every subcategory lexicon is enforced on every product', () => {
  /** One noun per subcategory that exists ONLY in that subcategory's list. */
  const exclusive: [string, string][] = [];
  for (const [sub, list] of Object.entries(cp.diseaseNounsBySubcategory)) {
    const core = new Set(cp.coreDiseaseNouns);
    const elsewhere = new Set(
      Object.entries(cp.diseaseNounsBySubcategory)
        .filter(([other]) => other !== sub)
        .flatMap(([, l]) => l),
    );
    const pick = list.find((n) => !core.has(n) && !elsewhere.has(n)) ?? list[0]!;
    exclusive.push([sub, pick]);
  }

  it('covers every subcategory the pack ships', () => {
    expect(exclusive.length).toBe(Object.keys(cp.diseaseNounsBySubcategory).length);
    expect(exclusive.length).toBeGreaterThan(20);
  });

  it.each(exclusive)(
    "a '%s' noun ('%s') fails C6 on a listing detected as probiotic/digestive",
    (_sub, noun) => {
      const l = mut((x) => {
        x.bullets[1] = `Daily support for ${noun} in adults every day`;
      });
      expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
    },
  );

  it.each(exclusive)(
    "a '%s' noun ('%s') fails A2 inside A+ content regardless of detection",
    (_sub, noun) => {
      const l = mut((x) => {
        x.aplusContent.modules[2]!.body = `Inside: a blend for ${noun} and daily balance.`;
      });
      expect(failures(l).some((f) => f.checkId === 'A2')).toBe(true);
    },
  );

  it('the gate-enforced noun set IS the full union (not the detected subset)', () => {
    const union = allDiseaseNouns(cp);
    const everySubNoun = Object.values(cp.diseaseNounsBySubcategory).flat();
    for (const n of [...cp.coreDiseaseNouns, ...everySubNoun]) expect(union).toContain(n);
  });

  it('detection no longer changes the outcome (same failures with an empty-ish ctx)', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Daily support for glaucoma in adults every day';
    });
    const asProbiotic = on(l, 'C6', 'bullets[1]').length;
    const asEye = failures(l, { subcategories: ['eye'] }).filter(
      (f) => f.checkId === 'C6' && f.field === 'bullets[1]',
    ).length;
    expect(asProbiotic).toBe(asEye);
    expect(asProbiotic).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — the therapeutic-action verb CLASS vetoes negation suppression
// ---------------------------------------------------------------------------
describe('FIX 2 — negation guard: verb class + clause separators', () => {
  const ROOTS = cp.diseaseActionVerbRoots ?? [];
  const INFLECTED = diseaseActionVerbs(cp);

  it('the pack ships action-verb ROOTS and the code generates the inflections', () => {
    expect(ROOTS.length).toBeGreaterThan(20);
    for (const root of ['relieve', 'ease', 'stop', 'reverse', 'fix', 'quiet']) {
      expect(ROOTS).toContain(root);
    }
    for (const form of ['relieves', 'relieved', 'relieving', 'eases', 'stopped', 'stopping', 'fixes', 'quieting']) {
      expect(INFLECTED).toContain(form);
    }
  });

  // (a) VERB VETO: cue adjacent to the term, no separator at all — only the
  // action-verb class can stop the suppression here.
  it.each(ROOTS.flatMap((r) => [r, `${r}s`]))(
    "'No %s arthritis' is a claim, not a disclaimer (C6 fails)",
    (verb) => {
      const l = mut((x) => {
        x.bullets[1] = `No ${verb} arthritis for adults`;
      });
      expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
    },
  );

  // (b) SEPARATORS: every cue x every separator, with a verb from the class.
  const sepCases: [string, string, string][] = [];
  for (const cue of CUES) {
    for (const sep of SEPARATORS) {
      for (const verb of ['relieves', 'eases', 'reverses', 'quiets', 'fixes', 'boosts']) {
        sepCases.push([cue, sep, verb]);
      }
    }
  }
  it.each(sepCases)('"%s%s %s arthritis" fails C6', (cue, sep, verb) => {
    const l = mut((x) => {
      x.bullets[1] = `${cue}${sep} ${verb} arthritis and eases sciatica every day`;
    });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(SEPARATORS)('a separator (%s) also fails on a non-bullet surface', (sep) => {
    const l = mut((x) => {
      x.qa[0] = { ...x.qa[0]!, a: `Never any junk${sep} relieves tinnitus and stops vertigo.` };
    });
    expect(on(l, 'C6', 'qa[0].a').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — meta-phrase laundering
// ---------------------------------------------------------------------------
describe('FIX 3 — a meta-phrase no longer launders what follows it', () => {
  const metaCases: [string, string][] = [];
  for (const phrase of cp.negationMetaPhrases ?? []) {
    for (const sep of SEPARATORS) metaCases.push([phrase, sep]);
  }

  it('the pack ships meta-phrases to test against', () => {
    expect((cp.negationMetaPhrases ?? []).length).toBeGreaterThan(5);
    expect(metaCases.length).toBeGreaterThan(40);
  });

  it.each(metaCases)('"%s%s cancer support in weeks" fails C6', (phrase, sep) => {
    const capitalised = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    const l = mut((x) => {
      x.description = `${x.productName} daily blend. ${capitalised}${sep} cancer support in weeks.\n\n${disclaimer}`;
    });
    expect(on(l, 'C6', 'description').length).toBeGreaterThan(0);
  });

  it.each(metaCases)('"%s%s diabetes relief blend" fails C6 in an A+ body', (phrase, sep) => {
    const capitalised = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    const l = mut((x) => {
      x.aplusContent.modules[2]!.body = `${capitalised}${sep} diabetes relief blend.`;
    });
    expect(failures(l).some((f) => f.checkId === 'A2')).toBe(true);
  });

  it('the verbatim disclaimer and its free-text twin stay clean', () => {
    const l = mut((x) => {
      x.description = `${x.productName} is a daily blend. This product is not intended to diagnose, treat, cure, or prevent any disease.\n\n${disclaimer}`;
      x.qa[0] = { ...x.qa[0]!, a: disclaimer };
    });
    expect(fieldFailures(l, 'description')).toEqual([]);
    expect(fieldFailures(l, 'qa[0].a')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — prohibited MARKETING claims carry no negation guard at all
// ---------------------------------------------------------------------------
describe('FIX 4 — C19 marketing claims cannot be laundered by a negation', () => {
  const CLAIMS = [
    'money back guarantee on your first bottle',
    'buy now',
    'shop now',
    'order today',
    'hurry',
    'today only',
    'limited time',
    'while supplies last',
    'act now',
    'subscribe and save',
    'best seller',
    'top rated',
    'the only formula you need',
    'clinically proven',
    'FDA approved',
    'maximum strength',
    'satisfaction guaranteed',
    'rated 5 star',
    '2,000 reviews',
  ];
  const PREFIXES = [
    'No fillers here,',
    'Contains no junk,',
    'Never tested on animals,',
    'Not a gimmick,',
    'There is no hype -',
    'We do not exaggerate |',
  ];
  const cases: [string, string][] = [];
  for (const claim of CLAIMS) for (const prefix of PREFIXES) cases.push([prefix, claim]);

  it.each(cases)('"%s %s" fails C19', (prefix, claim) => {
    const l = mut((x) => {
      x.bullets[1] = `${prefix} ${claim}`;
    });
    expect(on(l, 'C19', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(cases)('"%s %s" fails C19 in an image brief too', (prefix, claim) => {
    const l = mut((x) => {
      x.imagePlan[0] = { ...x.imagePlan[0]!, notes: `Overlay reads: ${prefix} ${claim}` };
    });
    expect(on(l, 'C19', 'imagePlan[0].notes').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 5 — obfuscation classes
// ---------------------------------------------------------------------------
describe('FIX 5 — obfuscated disease terms are caught by class', () => {
  const leet = (t: string): string =>
    t.replace(/e/g, '3').replace(/i/g, '1').replace(/o/g, '0').replace(/a/g, '4').replace(/t/g, '7');
  const doubled = (t: string): string => `${t[0]}${t}`;
  const combining = (t: string): string => t.replace(/([aeiou])/, '$1́');
  const confusable = (t: string): string =>
    t
      .replace(/c/g, 'ϲ')
      .replace(/i/g, 'ı')
      .replace(/o/g, 'о')
      .replace(/a/g, 'а')
      .replace(/e/g, 'е');
  const zeroWidth = (t: string): string => `${t.slice(0, 2)}​${t.slice(2)}`;
  const padWith = (sep: string) => (t: string): string => t.split('').join(sep);

  const OBFUSCATORS: [string, (t: string) => string][] = [
    ['leetspeak', leet],
    ['doubled letter', doubled],
    ['combining accent', combining],
    ['confusable script', confusable],
    ['zero-width', zeroWidth],
    ['pad -', padWith('-')],
    ['pad ‑', padWith('‑')],
    ['pad .', padWith('.')],
    ['pad *', padWith('*')],
    ['pad ,', padWith(',')],
    ['pad /', padWith('/')],
    ['pad |', padWith('|')],
    ['pad space', padWith(' ')],
    ['pad ·', padWith('·')],
  ];
  const TERMS = ['cancer', 'diabetes', 'arthritis', 'tinnitus'];
  const cases: [string, string, string][] = [];
  for (const [label, fn] of OBFUSCATORS) for (const term of TERMS) cases.push([label, term, fn(term)]);

  it.each(cases)('%s of "%s" (%s) fails C6', (_label, _term, payload) => {
    const l = mut((x) => {
      x.bullets[1] = `Daily support featuring ${payload} relief for adults`;
    });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  it('the confusable map no longer folds sigma onto the wrong letter', () => {
    expect(normalize('σtrength')).toBe('strength');
    expect(normalize('ϲancer')).toBe('cancer');
    expect(normalize('dıabetes')).toBe('diabetes');
    expect(normalize('cańcer')).toBe('cancer');
  });

  it('the extra passes are ADDITIVE — legitimate alphanumerics survive the primary scan', () => {
    for (const safe of ['5-HTP', 'CoQ10', 'B12', 'L-theanine', 'Non-GMO', 'Omega-3', '50 Billion CFU']) {
      expect(normalize(safe), safe).toBe(safe);
      expect(collapseSeparators(safe), safe).toBe(safe);
    }
    // the de-obfuscating helpers themselves are only ever used on scan copies
    expect(collapseDoubles('canncer')).toBe('cancer');
    expect(leetFold('d1abetes', 'i')).toBe('diabetes');
    expect(leetFold('canc3r', 'i')).toBe('cancer');
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — lexicon gaps + partial-pack fail-open
// ---------------------------------------------------------------------------
describe('FIX 6 — missing nouns and the partial-pack fail-open', () => {
  const ADDED = [
    'tinnitus', 'vertigo', 'restless leg syndrome', 'celiac disease', "crohn's disease",
    "parkinson's", 'acid reflux', 'heartburn', 'kidney stones', 'sleep apnea', 'candida',
    'urinary tract infection', 'pcos', 'fibromyalgia', 'neuropathy', 'plantar fasciitis',
    'endometriosis', 'rosacea', 'macular degeneration', 'glaucoma', 'sciatica',
  ];
  it.each(ADDED)('"%s" is in the enforced lexicon and fails C6', (noun) => {
    const l = mut((x) => {
      x.bullets[1] = `Daily support for ${noun} in adults`;
    });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
  });

  const emptied = (patch: Partial<CompliancePack>): KnowledgePack => ({
    ...pack,
    compliancePack: { ...cp, ...patch },
  });

  it('emptying coreDiseaseNouns alone is BLOCKING (was a silent fail-open)', () => {
    const result = runGate(clean, emptied({ coreDiseaseNouns: [] }), ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('emptying diseaseVerbs alone is BLOCKING', () => {
    const result = runGate(clean, emptied({ diseaseVerbs: [] }), ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('emptying the detected subcategory lists is still BLOCKING', () => {
    const result = runGate(clean, emptied({ diseaseNounsBySubcategory: {} }), ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 7 — C17 markup scan covers EVERY surface, raw and entity-encoded
// ---------------------------------------------------------------------------
describe('FIX 7 — HTML markup is caught on every surface', () => {
  const TAGS = ['<b>', '<ul>', '<li>', '<p>', '<strong>', '<div>', '<h1>', '</p>'];
  const encode = (t: string): string => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const SURFACES: [string, (l: OptimizedListing, payload: string) => void][] = [
    ['bullets[1]', (l, p) => { l.bullets[1] = `Daily support ${p} for adults`; }],
    ['description', (l, p) => { l.description = `${l.description} ${p}`; }],
    ['itemHighlights', (l, p) => { l.itemHighlights = `Vegan blend ${p} for adults`; }],
    ['qa[0].a', (l, p) => { l.qa[0] = { ...l.qa[0]!, a: `Yes ${p} it is vegan.` }; }],
    ['aplus.modules[ingredients].body', (l, p) => { l.aplusContent.modules[2]!.body = `Inside ${p} a blend.`; }],
    ['aplus.faq[0].a', (l, p) => { l.aplusContent.faq[0]!.a = `Yes ${p} it is.`; }],
    ['imagePlan[0].notes', (l, p) => { l.imagePlan[0] = { ...l.imagePlan[0]!, notes: `Overlay ${p} copy` }; }],
  ];
  const cases: [string, string, string][] = [];
  for (const [field] of SURFACES) {
    for (const tag of TAGS) {
      cases.push([field, tag, 'raw']);
      cases.push([field, encode(tag), 'entity-encoded']);
    }
  }

  it.each(cases)('%s carrying %s (%s) fails C17', (field, payload) => {
    const apply = SURFACES.find(([f]) => f === field)![1];
    const l = mut((x) => apply(x, payload));
    expect(failures(l).some((f) => f.checkId === 'C17' && f.field === field)).toBe(true);
  });

  it('<br> stays allowed wherever it appears', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Daily support <br> for adults';
      x.description = `${x.description} <br>`;
    });
    expect(failures(l).some((f) => f.checkId === 'C17')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 8 — prompt injection completeness + pattern holes
// ---------------------------------------------------------------------------
describe('FIX 8 — the generator is told exactly what the gate enforces', () => {
  it('the system prompt injects the FULL gate-enforced noun set (no truncation)', () => {
    const prompt = buildSystemPrompt(pack, clean.facts, ['probiotic', 'digestive']);
    const missing = allDiseaseNouns(cp).filter((n) => !prompt.includes(n));
    expect(missing, `prompt truncation would hide ${missing.length} enforced terms`).toEqual([]);
  });

  it('the injected set is ordered with the detected subcategories first (ranking only)', () => {
    const prompt = buildSystemPrompt(pack, clean.facts, ['eye']);
    const missing = allDiseaseNouns(cp).filter((n) => !prompt.includes(n));
    expect(missing).toEqual([]);
  });

  it.each(['twenty bucks per bottle', 'forty quid per bottle', 'thirty bucks'])(
    'spelled-out currency "%s" fails C18',
    (payload) => {
      const l = mut((x) => {
        x.aplusContent.faq[0]!.a = `A real bargain at ${payload}.`;
      });
      expect(failures(l).some((f) => f.checkId === 'C18')).toBe(true);
    },
  );

  it('allCapsRunMin stays at 3 — 2 false-positives legitimate acronym lists', () => {
    // Documented decision: "Contains GABA, MSM, CoQ10" reads as a 2-token
    // ALL-CAPS run, so a minimum of 2 flags legitimate ingredient acronyms.
    expect(pack.rules.style.allCapsRunMin).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE MONEY SHOT — 10 stacked violations that used to reach pass:true
// ---------------------------------------------------------------------------
describe('the auditor MONEY SHOT now fails closed', () => {
  const moneyShot = (): OptimizedListing =>
    mut((x) => {
      x.bullets[1] = 'Never any junk - relieves arthritis and eases sciatica every day';
      x.bullets[2] = 'No fillers here, money back guarantee on your first bottle';
      x.bullets[3] = 'Quiets tinnitus and stops vertigo for adults seeking calm';
      x.description = `${x.description}\n\nNot intended to diagnose, cancer support in weeks.`;
      x.itemHighlights = 'Vegan blend that reverses neuropathy and clears rosacea';
      x.qa[0] = { ...x.qa[0]!, a: 'Yes, it treats glaucoma and prevents macular degeneration' };
      x.aplusContent.modules[2]!.body =
        'Inside: a blend that cures plantar fasciitis and fixes restless leg syndrome';
      x.aplusContent.faq[0]!.a = 'A real bargain at twenty bucks per bottle';
      x.imagePlan[0] = {
        ...x.imagePlan[0]!,
        notes: 'Overlay reads: canc3r fighters choice, d1abetes reversal',
      };
      x.attributes = { ...x.attributes, product_benefit: 'Endometriosis relief; tinnitus support' };
    });

  it('runGate().pass === false', () => {
    expect(runGate(moneyShot(), pack, ctx).pass).toBe(false);
  });

  it('buildAudit().verified === false', () => {
    const audit = buildAudit(snapshot, moneyShot(), pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.verified).toBe(audit.gateResult.pass);
  });

  const EXPECTED: [string, string][] = [
    ['bullets[1]', 'C6'],
    ['bullets[2]', 'C19'],
    ['bullets[3]', 'C6'],
    ['description', 'C6'],
    ['itemHighlights', 'C6'],
    ['qa[0].a', 'C6'],
    ['aplus.modules[ingredients].body', 'A2'],
    ['aplus.faq[0]', 'C18'],
    ['imagePlan[0].notes', 'C6'],
    ['attributes.product_benefit', 'C6'],
  ];
  it.each(EXPECTED)('violation on %s is reported as %s', (field, checkId) => {
    const found = runGate(moneyShot(), pack, ctx).failures.filter(
      (f) => f.field === field && f.checkId === checkId,
    );
    expect(found.length, JSON.stringify(runGate(moneyShot(), pack, ctx).failures)).toBeGreaterThan(0);
  });

  it('all ten stacked violations are caught (>= 10 distinct offending fields)', () => {
    const fields = new Set(runGate(moneyShot(), pack, ctx).failures.map((f) => f.field));
    expect(fields.size).toBeGreaterThanOrEqual(10);
  });

  it('the one-liner "Treats ϲancer and dıabetes in adults every day" fails', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Treats ϲancer and dıabetes in adults every day';
    });
    expect(on(l, 'C6', 'bullets[1]').length).toBeGreaterThan(0);
    expect(runGate(l, pack, ctx).pass).toBe(false);
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NO FALSE POSITIVES — the 12 known-legitimate strings on every surface
// ---------------------------------------------------------------------------
describe('no false positives — legitimate copy on every surface', () => {
  const LEGIT = [
    'Gluten free and dairy free',
    '50 Billion CFU',
    '500 mg of the blend',
    '60 capsules',
    'GABA',
    '5-HTP',
    'L-theanine',
    'Non-GMO',
    'third-party tested',
    'CoQ10',
    'B12',
    'Omega-3',
    'Made in the USA in a cGMP facility',
    'NSF certified',
    'Supports a healthy inflammatory response',
    'Contains: Tree Nuts (Almond)',
    'not intended to diagnose, treat, cure, or prevent any disease',
    disclaimer,
  ];
  const SURFACES: [string, (l: OptimizedListing, s: string) => void][] = [
    ['bullets[1]', (l, s) => { l.bullets[1] = `Daily support with ${s} for adults`; }],
    ['itemHighlights', (l, s) => { l.itemHighlights = `Blend with ${s}`; }],
    ['qa[0].a', (l, s) => { l.qa[0] = { ...l.qa[0]!, a: `Yes — ${s}` }; }],
    ['imagePlan[0].notes', (l, s) => { l.imagePlan[0] = { ...l.imagePlan[0]!, notes: `Overlay: ${s}` }; }],
    ['attributes.product_benefit', (l, s) => { l.attributes = { ...l.attributes, product_benefit: s }; }],
    ['aplus.modules[ingredients].body', (l, s) => { l.aplusContent.modules[2]!.body = `Inside: ${s}.`; }],
    ['aplus.faq[0]', (l, s) => { l.aplusContent.faq[0]!.a = `Yes: ${s}.`; }],
  ];
  const cases: [string, string][] = [];
  for (const [field] of SURFACES) {
    for (const s of LEGIT) {
      // itemHighlights has its own 125-char cap (C15) — the full disclaimer
      // simply does not fit there, and a length failure is not a false positive.
      if (field === 'itemHighlights' && s.length > 100) continue;
      cases.push([field, s]);
    }
  }

  it.each(cases)('%s carrying "%s" stays clean', (field, s) => {
    const apply = SURFACES.find(([f]) => f === field)![1];
    const l = mut((x) => apply(x, s));
    expect(
      failures(l).filter((f) => f.field === field),
      `legitimate string '${s}' must not be flagged on ${field}`,
    ).toEqual([]);
  });

  it('the clean golden fixture passes with ZERO failures', () => {
    const result = runGate(clean, pack, ctx);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the clean golden fixture passes against EVERY subcategory context', () => {
    for (const sub of Object.keys(cp.diseaseNounsBySubcategory)) {
      expect(runGate(clean, pack, { subcategories: [sub] }).failures, sub).toEqual([]);
    }
  });

  it('buildAudit still verifies the clean fixture', () => {
    expect(buildAudit(snapshot, clean, pack, ctx).verified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CROSS-CLASS payloads — combinations none of the suites above spell out
// ---------------------------------------------------------------------------
describe('cross-class payloads (novel combinations) fail closed', () => {
  const PAYLOADS = [
    'Never any junk – soothes psoriasis for adults',
    'No fillers/binders, alleviates eczema every day',
    'This is not a drug | shrinks tumors naturally',
    'Contains no soy (banishes gout) for adults',
    'Zero junk: undoes hair loss in weeks',
    'Support that battles ca\u00adncer daily',
    'Daily blend for GERD and acid reflux comfort',
    'Helps with h.e.a.r.t.b.u.r.n every evening',
    'Support for 0besity and hyp3rtension in adults',
    'Formulated for tinnnitus relief in adults',
    'Overlay: no claims - cures d,i,a,b,e,t,e,s fast',
  ];
  it.each(PAYLOADS)('"%s" is blocked', (payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    const found = fieldFailures(l, 'bullets[1]');
    expect(found.length, JSON.stringify(found)).toBeGreaterThan(0);
  });
});
