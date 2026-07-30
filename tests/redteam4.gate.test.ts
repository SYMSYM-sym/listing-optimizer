import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildSystemPrompt, prohibitedMarketingBlock } from '@/lib/engine/prompts';
import { FIELD_TO_GROUP, fieldToGroup } from '@/lib/engine/repair';
import {
  a2AplusBannedTerms,
  allDiseaseNouns,
  c6BannedTerms,
  c18ProhibitedContent,
  c19ProhibitedMarketing,
  requiredPackPieceIds,
  type GateContext,
} from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { INVISIBLE_CHARS, normalize, scanConcatenated, scanTerms, termRegex } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * RED TEAM ROUND 4.
 *
 * Round 3 closed the CLASSES the third auditor named; the fourth auditor
 * showed that several checks still failed OPEN when their PACK DATA was
 * emptied, that only single-letter splits were de-obfuscated, that the
 * invisible-character table was a fifth of the real one, that one trailing
 * digit disarmed every term, and that malformed structural input either passed
 * or threw.
 *
 * Every suite below is PARAMETERIZED over the whole mechanism it defends, so a
 * fix written to one literal payload cannot make them pass.
 */

const pack = loadPack('supplements');
const cp = pack.compliancePack as CompliancePack;
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const failures = (l: OptimizedListing, p: KnowledgePack = pack, c: GateContext = ctx): Failure[] =>
  runGate(l, p, c).failures;
const on = (l: OptimizedListing, checkId: string, field: string): Failure[] =>
  failures(l).filter((f) => f.checkId === checkId && f.field === field);

/**
 * Single-check helpers for the LARGE parameterized matrices.
 *
 * The matrices below run in the hundreds of cases; driving the FULL gate for
 * each one is ~10x the work for no extra signal, because the mechanism under
 * test is a single check. Every suite that asserts an END-TO-END outcome
 * (the money shots, the structural suite, the no-false-positive suite) still
 * runs the whole gate and `buildAudit`.
 */
const c6On = (l: OptimizedListing, field: string): Failure[] =>
  c6BannedTerms(l, pack).filter((f) => f.field === field);
const a2Any = (l: OptimizedListing): Failure[] => a2AplusBannedTerms(l, pack);
const c18On = (l: OptimizedListing, field: string): Failure[] =>
  c18ProhibitedContent(l, pack).filter((f) => f.field === field);
const c19On = (l: OptimizedListing, field: string): Failure[] =>
  c19ProhibitedMarketing(l, pack).filter((f) => f.field === field);

/** A deep, cache-free clone of the pack so emptying a piece cannot leak. */
const clonePack = (): KnowledgePack => JSON.parse(JSON.stringify(pack)) as KnowledgePack;

// ===========================================================================
// FIX 1 — PACK-INTEGRITY MANIFEST (pack pieces used to fail OPEN)
// ===========================================================================

/**
 * One emptier per manifest row. The suite asserts this table's key set EQUALS
 * `requiredPackPieceIds`, so a manifest row cannot be added without a test and
 * a test cannot outlive its row.
 */
const EMPTIERS: Record<string, (p: KnowledgePack) => void> = {
  'compliancePack.coreDiseaseNouns': (p) => {
    p.compliancePack!.coreDiseaseNouns = [];
  },
  'compliancePack.diseaseVerbs': (p) => {
    p.compliancePack!.diseaseVerbs = [];
  },
  'compliancePack.diseaseNounsBySubcategory': (p) => {
    p.compliancePack!.diseaseNounsBySubcategory = {};
  },
  'compliancePack.superlativeBans': (p) => {
    p.compliancePack!.superlativeBans = [];
  },
  'compliancePack.allergenRules': (p) => {
    p.compliancePack!.allergenRules = [];
  },
  'compliancePack.allergenFields': (p) => {
    p.compliancePack!.allergenFields = {
      labelList: '',
      declaration: '',
      declarationVerb: '',
      aplusModuleIdCue: '',
    };
  },
  'compliancePack.noAllergenPhrases': (p) => {
    p.compliancePack!.noAllergenPhrases = [];
  },
  'compliancePack.disclaimer': (p) => {
    p.compliancePack!.disclaimer = '';
  },
  'rules.style': (p) => {
    p.rules.style = { ...p.rules.style, bannedSymbols: [], bannedChars: [], titleTermBans: [] };
  },
  'rules.prohibitedContent.patterns': (p) => {
    p.rules.prohibitedContent!.patterns = [];
  },
  'rules.prohibitedContent.surfaces': (p) => {
    p.rules.prohibitedContent!.surfaces = [];
  },
  'rules.prohibitedMarketing.patterns': (p) => {
    p.rules.prohibitedMarketing!.patterns = [];
  },
  'rules.prohibitedMarketing.surfaces': (p) => {
    p.rules.prohibitedMarketing!.surfaces = [];
  },
  'rules.units.dimensions': (p) => {
    p.rules.units.dimensions = {};
  },
};

describe('FIX 1 — emptying ANY required pack piece is BLOCKING, never a silent pass', () => {
  it('the emptier table covers exactly the declared manifest', () => {
    expect(Object.keys(EMPTIERS).sort()).toEqual([...requiredPackPieceIds].sort());
    expect(requiredPackPieceIds.length).toBeGreaterThanOrEqual(14);
  });

  it.each(requiredPackPieceIds)('emptying %s raises a blocking PACK failure', (id) => {
    const broken = clonePack();
    EMPTIERS[id]!(broken);
    const result = runGate(clean, broken, ctx);
    const packFailures = result.failures.filter((f) => f.checkId === 'PACK');
    expect(packFailures.length).toBeGreaterThan(0);
    // the failure NAMES the missing piece
    expect(packFailures.map((f) => `${f.context} ${f.fix}`).join(' ')).toContain(id);
    expect(result.pass).toBe(false);
    expect(buildAudit(snapshot, clean, broken, ctx).verified).toBe(false);
    expect(buildAudit(snapshot, clean, broken, ctx).packIntegrity.ok).toBe(false);
  });

  /**
   * The four payloads the auditor PROVED walked through, each paired with the
   * lexicon whose emptying used to disarm its check.
   */
  const PROVEN: [string, string, (l: OptimizedListing) => void][] = [
    [
      'rules.prohibitedContent.patterns',
      'Order online for 39 dollars and 95 cents at www.brandx.com',
      (l) => {
        l.bullets[1] = 'Order online for 39 dollars and 95 cents at www.brandx.com';
      },
    ],
    [
      'rules.prohibitedMarketing.patterns',
      'Our best seller with a money back guarantee, hurry, today only',
      (l) => {
        l.bullets[1] = 'Our best seller with a money back guarantee, hurry, today only';
      },
    ],
    [
      'rules.style',
      'THIS IS SHOUTING LOUD with <b>bold</b> and an emoji',
      (l) => {
        l.bullets[1] = 'THIS IS SHOUTING LOUD with <b>bold</b> and 🎉';
      },
    ],
    [
      'compliancePack.allergenRules',
      'undeclared allergen in the label list',
      (l) => {
        l.attributes.ingredients = 'Almond extract, rice flour';
      },
    ],
  ];

  it.each(PROVEN)('emptying %s no longer launders "%s"', (id, _payload, apply) => {
    const broken = clonePack();
    EMPTIERS[id]!(broken);
    const listing = mut(apply);
    const result = runGate(listing, broken, ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'PACK')).toBe(true);
    expect(buildAudit(snapshot, listing, broken, ctx).verified).toBe(false);
  });

  it('compliancePack = null on a compliance-REQUIRING pack is blocking', () => {
    const broken = clonePack();
    broken.compliancePack = null;
    expect(broken.requiresCompliance).toBe(true);
    const listing = mut((l) => {
      l.bullets[1] = 'Cures cancer and treats diabetes fast';
    });
    const result = runGate(listing, broken, ctx);
    expect(result.pass).toBe(false);
    const packFailures = result.failures.filter((f) => f.checkId === 'PACK');
    expect(packFailures.length).toBeGreaterThan(0);
    expect(packFailures[0]!.context).toContain('compliancePack');
    expect(buildAudit(snapshot, listing, broken, ctx).verified).toBe(false);
  });

  it('the GENERIC pack (no declared requirement) still fails closed via the suspicion lexicon', () => {
    const generic = loadPack('generic');
    expect(generic.requiresCompliance).toBe(false);
    const result = runGate(clean, generic, { subcategories: [], snapshotText: snapshot.title });
    expect(result.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('an intact pack produces NO pack-integrity problem', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(audit.packIntegrity).toEqual({ ok: true, problems: [] });
    expect(audit.verified).toBe(true);
  });
});

// ===========================================================================
// FIX 2 — PARTIAL-SPLIT obfuscation (multi-letter fragments)
// ===========================================================================

const SPLIT_NOUNS = ['cancer', 'diabetes', 'arthritis', 'asthma', 'eczema', 'insomnia'];
const SPLIT_SEPARATORS = [' ', '-', '.', "'", '*', ',', '/', '  '];

/** Every split position of `word` for a separator. */
function splits(word: string, sep: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < word.length; i++) out.push(word.slice(0, i) + sep + word.slice(i));
  return out;
}

const SPLIT_CASES: [string, string, string][] = SPLIT_NOUNS.flatMap((noun) =>
  SPLIT_SEPARATORS.flatMap((sep) => splits(noun, sep).map((s) => [noun, sep, s] as [string, string, string])),
);

describe('FIX 2 — every split position x separator x noun is caught', () => {
  it('covers a large parameterized matrix (not a handful of literals)', () => {
    expect(SPLIT_CASES.length).toBeGreaterThan(250);
  });

  it.each(SPLIT_CASES)('%s split with "%s" -> "%s" fails C6 in a bullet', (_noun, _sep, payload) => {
    const l = mut((x) => {
      x.bullets[1] = `Daily support for ${payload} in adults every day`;
    });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(SPLIT_CASES.filter((_, i) => i % 7 === 0))(
    '%s split with "%s" -> "%s" also fails A2 inside A+ content',
    (_noun, _sep, payload) => {
      const l = mut((x) => {
        x.aplusContent.faq[0]!.a = `Blocks ${payload} risk for adults.`;
      });
      expect(a2Any(l).length).toBeGreaterThan(0);
    },
  );

  it('the auditor\'s exact seven payloads all fail', () => {
    for (const payload of ['c ancer', 'ca ncer', 'can cer', 'cance r', 'can-cer', 'can.cer', "can'cer"]) {
      const l = mut((x) => {
        x.bullets[1] = `Daily support for ${payload} in adults every day`;
      });
      expect(c6On(l, 'bullets[1]').length, payload).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// FIX 3 — INVISIBLE characters
// ===========================================================================

describe('FIX 3 — the whole invisible-character table is stripped before scanning', () => {
  it('covers far more than the original five codepoints', () => {
    expect(INVISIBLE_CHARS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(INVISIBLE_CHARS.map((ch) => [ch.codePointAt(0)!.toString(16), ch]))(
    'U+%s inside a banned term still fails C6',
    (_hex, ch) => {
      const l = mut((x) => {
        x.bullets[1] = `Daily support for can${ch}cer in adults every day`;
      });
      expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
    },
  );

  it.each(['‎', '‏', '؜', '᠎', '⁡', 'ㅤ', 'ᅟ', '︀'].map((c) => [c.codePointAt(0)!.toString(16), c]))(
    'the auditor\'s bypass U+%s is normalized away',
    (_hex, ch) => {
      expect(normalize(`can${ch}cer`)).toBe('cancer');
    },
  );
});

// ===========================================================================
// FIX 4 — digit-adjacent word boundary
// ===========================================================================

const DIGIT_VARIANTS: [string, (t: string) => string][] = [
  ['trailing digit', (t) => `${t}1`],
  ['trailing superscript', (t) => `${t}¹`],
  ['leading digit', (t) => `1${t}`],
  ['trailing digit 0', (t) => `${t}0`],
  ['leading digit 9', (t) => `9${t}`],
];

describe('FIX 4 — a digit no longer buys immunity', () => {
  const nouns = ['cancer', 'diabetes', 'arthritis', 'asthma'];
  const cases: [string, string][] = nouns.flatMap((n) =>
    DIGIT_VARIANTS.map(([label, f]) => [`${label}: ${f(n)}`, f(n)] as [string, string]),
  );

  it.each(cases)('%s fails C6', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = `Daily support for ${payload} in adults every day`;
    });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  /**
   * The letters-only boundary must still prevent a term matching INSIDE a
   * longer word on the primary (untouched) text. Asserted on `termRegex`
   * directly, because the separator-STRIPPED pass (FIX 2) is substring-based
   * by construction and WILL report `cancerous` — that is a deliberate
   * trade-off of concatenated matching, not a boundary regression.
   */
  it.each(['cancerous', 'oncancer', 'precancerously', 'diabetesish'])(
    '"%s" is not a word-boundary match for its embedded term',
    (word) => {
      for (const term of ['cancer', 'diabetes']) {
        const re = termRegex(term);
        re.lastIndex = 0;
        expect(re.test(word)).toBe(false);
      }
    },
  );
});

// ===========================================================================
// FIX 5 — lexicon gaps (abbreviations, colloquialisms, science, drugs)
// ===========================================================================

const NEW_TERMS = [
  't2d', 't1d', 'oa', 'ra', 'chf', 'ms', 'als', 'afib',
  'the big c', 'brain fog', 'man boobs', 'gynecomastia', 'leaky gut',
  'adrenal fatigue', 'sugar disease',
  'neoplasia', 'carcinogenesis', 'oncogenesis',
];

describe('FIX 5 — every added term is enforced', () => {
  it.each(NEW_TERMS)('"%s" is in the enforced union', (term) => {
    expect(allDiseaseNouns(cp).map((t) => t.toLowerCase())).toContain(term);
  });

  it.each(NEW_TERMS)('"%s" fails C6 in a bullet', (term) => {
    const l = mut((x) => {
      x.bullets[1] = `Daily support for ${term} in adults every day`;
    });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(cp.prescriptionDrugNames ?? [])('prescription drug "%s" fails C6 in a bullet', (drug) => {
    const l = mut((x) => {
      x.bullets[1] = `Works like a natural ${drug} replacement for adults`;
    });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(cp.prescriptionDrugNames ?? [])('prescription drug "%s" fails A2 in A+ content', (drug) => {
    const l = mut((x) => {
      x.aplusContent.faq[0]!.a = `Many customers use it instead of ${drug} every day.`;
    });
    expect(a2Any(l).length).toBeGreaterThan(0);
  });

  it('the cosmetics pack carries its own drug list', () => {
    const cosm = loadPack('cosmetics').compliancePack as CompliancePack;
    expect((cosm.prescriptionDrugNames ?? []).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FIX 6 — C18 pattern gaps
// ===========================================================================

const C18_PAYLOADS: [string, string][] = [
  ['GBP price', 'Great value at £19.95 for adults'],
  ['JPY price', 'Great value at ¥1200 for adults'],
  ['INR price', 'Great value at ₹500 for adults'],
  ['KRW price', 'Great value at ₩9000 for adults'],
  ['cent price', 'Great value at ¢99 for adults'],
  ['RUB price', 'Great value at ₽900 for adults'],
  ['UAH price', 'Great value at ₴900 for adults'],
  ['intl phone', 'Reach the team on +44 20 7946 0958 for adults'],
  ['intl phone short', 'Reach the team on +49 30 1234 5678 for adults'],
  ['obfuscated email brackets', 'Write to support [at] brandx [dot] com for adults'],
  ['obfuscated email words', 'Write to support at brandx dot com for adults'],
  ['obfuscated email parens', 'Write to support (at) brandx (dot) io for adults'],
  ['per bottle cost', 'A low per bottle cost for adults'],
  ['per-serving price', 'A low per-serving price for adults'],
  ['per month cost', 'A low per month cost for adults'],
  ['per unit price', 'A low per unit price for adults'],
];

describe('FIX 6 — C18 covers non-USD currency, international phones, obfuscated email, per-unit pricing', () => {
  it.each(C18_PAYLOADS)('%s fails C18 in a bullet', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c18On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(C18_PAYLOADS)('%s fails C18 in a Q&A answer too', (_label, payload) => {
    const l = mut((x) => {
      x.qa[0]!.a = payload;
    });
    expect(c18On(l, 'qa[0].a').length).toBeGreaterThan(0);
  });

  it.each(['£', '¥', '₹', '₩', '¢'])('the currency symbol %s is also banned by C17 on every surface', (sym) => {
    const l = mut((x) => {
      x.qa[0]!.a = `Great value at ${sym}19 for adults`;
    });
    expect(on(l, 'C17', 'qa[0].a').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FIX 7 — C19 near-synonyms + de-obfuscation for C18/C19
// ===========================================================================

const C19_PAYLOADS: [string, string][] = [
  ['top-selling', 'Our top-selling blend for adults'],
  ['top selling', 'Our top selling blend for adults'],
  ['number one rated', 'The number one rated blend for adults'],
  ['risk-free', 'A risk-free blend for adults'],
  ['risk free', 'A risk free blend for adults'],
  ['satisfaction assured', 'Satisfaction assured for adults'],
  ['satisfaction guaranteed', 'Satisfaction guaranteed for adults'],
  ['doctor recommended', 'Doctor recommended for adults'],
  ['physician recommended', 'Physician recommended for adults'],
  ['award-winning', 'An award-winning blend for adults'],
  ['award winning', 'An award winning blend for adults'],
  ['as seen on tv', 'As seen on TV, a blend for adults'],
  ['clinically studied', 'A clinically studied blend for adults'],
];

/** C18/C19 payloads written with the SAME obfuscation families the disease scan defends against. */
const OBFUSCATED_PAYLOADS: [string, string][] = [
  ['C19 separator-padded best seller', 'Our b-e-s-t s-e-l-l-e-r blend for adults'],
  ['C19 separator-padded hurry', 'Do not wait, h-u-r-r-y, stock moves for adults'],
  ['C19 leetspeak guarantee', 'A gu4rantee for every adult buyer'],
  ['C19 separator-padded money back', 'A m-o-n-e-y b-a-c-k promise for adults'],
  ['C18 separator-padded price', 'Only 39 d-o-l-l-a-r-s today for adults'],
  ['C18 leetspeak shipping offer', 'Enjoy fr33 shipping on every order for adults'],
];

describe('FIX 7 — C19 near-synonyms and shared de-obfuscation', () => {
  it.each(C19_PAYLOADS)('%s fails C19 in a bullet', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c19On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(C19_PAYLOADS)('%s fails C19 in an image-plan note too', (_label, payload) => {
    const l = mut((x) => {
      x.imagePlan[0]!.notes = payload;
    });
    expect(c19On(l, 'imagePlan[0].notes').length).toBeGreaterThan(0);
  });

  it.each(OBFUSCATED_PAYLOADS)('%s is caught through the de-obfuscated variants', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    const hits = [...c18On(l, 'bullets[1]'), ...c19On(l, 'bullets[1]')];
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// FIX 8 — structural robustness
// ===========================================================================

describe('FIX 8 — malformed structure FAILS (and never throws)', () => {
  const STRUCTURAL: [string, (l: OptimizedListing) => void, string][] = [
    ['duplicate bullet', (l) => { l.bullets[2] = l.bullets[1]!; }, 'C2'],
    ['duplicate bullet, re-cased', (l) => { l.bullets[2] = l.bullets[1]!.toUpperCase(); }, 'C2'],
    ['duplicate bullet, re-spaced', (l) => { l.bullets[2] = `  ${l.bullets[1]!}  `; }, 'C2'],
    ['marker-only bullet', (l) => { l.bullets[1] = '*'; }, 'C2'],
    ['punctuation-only bullet', (l) => { l.bullets[1] = '--- ...'; }, 'C2'],
    ['empty bullet', (l) => { l.bullets[1] = ''; }, 'C2'],
    ['whitespace-only bullet', (l) => { l.bullets[1] = '   \t  '; }, 'C2'],
    ['empty itemHighlights', (l) => { l.itemHighlights = ''; }, 'C15'],
    ['whitespace itemHighlights', (l) => { l.itemHighlights = '   '; }, 'C15'],
    ['empty backendSearchTerms', (l) => { l.backendSearchTerms = ''; }, 'C3'],
    ['whitespace backendSearchTerms', (l) => { l.backendSearchTerms = '  '; }, 'C3'],
    ['empty title', (l) => { l.title = ''; }, 'C1'],
    ['empty description', (l) => { l.description = ''; }, 'C4'],
    ['empty title75', (l) => { l.title75 = ''; }, 'C15'],
  ];

  it.each(STRUCTURAL)('%s fails %s', (_label, apply, checkId) => {
    const l = mut(apply);
    const result = runGate(l, pack, ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === checkId)).toBe(true);
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });

  const MALFORMED: [string, (l: OptimizedListing) => void][] = [
    ['null bullet', (l) => { (l.bullets as unknown[])[1] = null; }],
    ['undefined bullet', (l) => { (l.bullets as unknown[])[1] = undefined; }],
    ['numeric bullet', (l) => { (l.bullets as unknown[])[1] = 42; }],
    ['undefined qa', (l) => { (l as unknown as Record<string, unknown>).qa = undefined; }],
    ['null qa entry', (l) => { (l.qa as unknown[])[0] = null; }],
    ['undefined imagePlan', (l) => { (l as unknown as Record<string, unknown>).imagePlan = undefined; }],
    ['null imagePlan entry', (l) => { (l.imagePlan as unknown[])[0] = null; }],
    ['undefined aplusContent', (l) => { (l as unknown as Record<string, unknown>).aplusContent = undefined; }],
    ['aplusContent without comparison', (l) => { delete (l.aplusContent as unknown as Record<string, unknown>).comparison; }],
    ['aplusContent without modules', (l) => { delete (l.aplusContent as unknown as Record<string, unknown>).modules; }],
    ['undefined attributes', (l) => { (l as unknown as Record<string, unknown>).attributes = undefined; }],
    ['undefined bullets', (l) => { (l as unknown as Record<string, unknown>).bullets = undefined; }],
    ['undefined facts', (l) => { (l as unknown as Record<string, unknown>).facts = undefined; }],
    ['null title', (l) => { (l as unknown as Record<string, unknown>).title = null; }],
  ];

  it.each(MALFORMED)('%s does not throw and does not pass', (_label, apply) => {
    const l = mut(apply);
    let result: ReturnType<typeof runGate> | null = null;
    expect(() => {
      result = runGate(l, pack, ctx);
    }).not.toThrow();
    expect(result!.pass).toBe(false);
    expect(() => buildAudit(snapshot, l, pack, ctx)).not.toThrow();
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });
});

// ===========================================================================
// FIX 9 — facts surface, prompt parity, pack-integrity in the audit payload
// ===========================================================================

describe('FIX 9 — smaller closures', () => {
  it('a claim parked in facts.* is scanned (C6) and owned by the attributes group', () => {
    const l = mut((x) => {
      x.facts.potency = '50 Billion CFU that cures cancer';
    });
    const hits = failures(l).filter((f) => f.checkId === 'C6' && f.field === 'facts.potency');
    expect(hits.length).toBeGreaterThan(0);
    expect(fieldToGroup(hits[0]!)).toBe('attributes');
  });

  it.each(['potency', 'servingSize', 'weight'])('facts.%s is a scanned surface', (key) => {
    const l = mut((x) => {
      (x.facts as unknown as Record<string, string>)[key] = 'supports arthritis relief';
    });
    expect(failures(l).some((f) => f.checkId === 'C6' && f.field === `facts.${key}`)).toBe(true);
  });

  it('FIELD_TO_GROUP carries an explicit facts row', () => {
    expect(FIELD_TO_GROUP.some((r) => r.match('facts.potency', 'C6'))).toBe(true);
  });

  it('the system prompt renders EVERY prohibited-marketing label (superset of what C19 enforces)', () => {
    const prompt = buildSystemPrompt(pack, clean.facts, ['probiotic']);
    const labels = new Set((pack.rules.prohibitedMarketing?.patterns ?? []).map(([, label]) => label));
    expect(labels.size).toBeGreaterThan(5);
    for (const label of labels) expect(prompt).toContain(label);
  });

  it('prohibitedMarketingBlock is empty for a pack with no marketing patterns', () => {
    expect(prohibitedMarketingBlock(undefined)).toBe('');
    expect(prohibitedMarketingBlock({ patterns: [], surfaces: [] })).toBe('');
  });

  it('the compliance sentences come from PACK DATA, not from the engine', () => {
    const lines = cp.promptRules?.compliance ?? [];
    expect(lines.length).toBeGreaterThan(0);
    const prompt = buildSystemPrompt(pack, clean.facts, ['probiotic']);
    for (const line of lines) expect(prompt).toContain(line);

    const stripped = clonePack();
    stripped.compliancePack!.promptRules = {
      ...stripped.compliancePack!.promptRules,
      compliance: [],
    };
    const without = buildSystemPrompt(stripped, clean.facts, ['probiotic']);
    for (const line of lines) expect(without).not.toContain(line);
  });

  it('pack-integrity problems are visible in the audit payload', () => {
    const broken = clonePack();
    broken.compliancePack!.superlativeBans = [];
    const audit = buildAudit(snapshot, clean, broken, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.packIntegrity.ok).toBe(false);
    expect(audit.packIntegrity.problems.join(' ')).toContain('compliancePack.superlativeBans');
  });
});

// ===========================================================================
// THE MONEY SHOTS
// ===========================================================================

describe('MONEY SHOT — the auditor\'s full payload now FAILS with verified === false', () => {
  const build = (): OptimizedListing =>
    mut((x) => {
      x.bullets[1] =
        'Doctor recommended and award winning: our top-selling risk-free blend, only £19.95 per bottle cost';
      x.bullets[2] = 'Works like a natural Ozempic and Xanax replacement and cures brain fog, T2D and OA';
      x.qa[0]!.a =
        'Yes. Call us at +44 20 7946 0958 or email support [at] brandx dot com. Protects against the big C.';
      x.imagePlan[0]!.notes = 'Overlay text: As seen on TV, number one rated, satisfaction assured';
      x.aplusContent.faq[0]!.a =
        'Blocks carcinogenesis and reduces neoplasia risk. Fights c ancer daily.';
    });

  it('fails the gate', () => {
    expect(runGate(build(), pack, ctx).pass).toBe(false);
  });

  it('buildAudit reports verified === false', () => {
    expect(buildAudit(snapshot, build(), pack, ctx).verified).toBe(false);
  });

  const EXPECTED: [string, string][] = [
    ['bullets[1]', 'C19'],
    ['bullets[1]', 'C18'],
    ['bullets[1]', 'C17'],
    ['bullets[2]', 'C6'],
    ['qa[0].a', 'C18'],
    ['qa[0].a', 'C6'],
    ['imagePlan[0].notes', 'C19'],
    ['aplus.faq[0].a', 'A2'],
  ];

  it.each(EXPECTED)('%s is caught by %s', (field, checkId) => {
    const hits = failures(build()).filter(
      (f) => f.checkId === checkId && f.field.startsWith(field.split('.')[0]!) && f.field === field,
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  const TERMS = ['ozempic', 'xanax', 'brain fog', 't2d', 'oa', 'the big c', 'carcinogenesis', 'neoplasia', 'cancer'];
  it.each(TERMS)('the banned term "%s" is reported', (term) => {
    const reported = failures(build())
      .filter((f) => f.checkId === 'C6' || f.checkId === 'A2')
      .map((f) => f.fix.toLowerCase())
      .join(' | ');
    expect(reported).toContain(term.toLowerCase());
  });
});

describe('MONEY SHOT — the title one-liner now FAILS', () => {
  const build = (): OptimizedListing =>
    mut((x) => {
      x.title = 'BrandX Probiotic - Top-Selling Doctor Recommended Formula for T2D and OA';
      x.title75 = 'BrandX Probiotic - Top-Selling Formula for T2D';
    });

  it('fails the gate with verified === false', () => {
    const l = build();
    expect(runGate(l, pack, ctx).pass).toBe(false);
    expect(buildAudit(snapshot, l, pack, ctx).verified).toBe(false);
  });

  it.each([
    ['title', 'C19'],
    ['title', 'C6'],
    ['title75', 'C19'],
  ])('%s is caught by %s', (field, checkId) => {
    expect(failures(build()).filter((f) => f.field === field && f.checkId === checkId).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// NO FALSE POSITIVES
// ===========================================================================

const LEGIT = [
  'Gluten free and dairy free',
  '50 Billion CFU',
  '500 mg of the blend',
  '60 capsules',
  'GABA',
  '5-HTP',
  'L-theanine',
  'CoQ10',
  'B12',
  'Omega-3',
  'Non-GMO',
  'Third-party tested',
  'Made in the USA in a cGMP facility',
  'NSF certified',
  'Supports a healthy inflammatory response',
  'Contains: Tree Nuts (Almond)',
  cp.disclaimer,
  'not intended to diagnose, treat, cure, or prevent any disease',
];

/** Each surface: how to write the string in, and which failure fields belong to it. */
const NO_FP_SURFACES: [string, (l: OptimizedListing, s: string) => void, (field: string) => boolean][] = [
  [
    'bullets[1]',
    (l, s) => {
      l.bullets[1] = `Daily support: ${s} for adults every day`;
    },
    (f) => f === 'bullets[1]',
  ],
  [
    'qa[0].a',
    (l, s) => {
      l.qa[0]!.a = `Yes. ${s} as described on the label.`;
    },
    (f) => f.startsWith('qa[0]'),
  ],
  [
    'imagePlan[0].notes',
    (l, s) => {
      l.imagePlan[0]!.notes = `Overlay copy: ${s}`;
    },
    (f) => f.startsWith('imagePlan[0]'),
  ],
  [
    'aplus.faq[0]',
    (l, s) => {
      l.aplusContent.faq[0]!.a = `Yes. ${s} as described on the label.`;
    },
    (f) => f.startsWith('aplus.faq[0]'),
  ],
  [
    'attributes.material_features',
    (l, s) => {
      l.attributes.material_features = s;
    },
    (f) => f === 'attributes.material_features',
  ],
];

describe('NO FALSE POSITIVES — every legitimate string on every surface', () => {
  const cases: [string, string][] = NO_FP_SURFACES.flatMap(([name]) =>
    LEGIT.map((s) => [name, s] as [string, string]),
  );

  it('covers the whole legit x surface matrix', () => {
    expect(cases.length).toBe(LEGIT.length * NO_FP_SURFACES.length);
  });

  it.each(cases)('%s carrying "%s" produces ZERO failures on that surface', (surfaceName, legit) => {
    const row = NO_FP_SURFACES.find(([n]) => n === surfaceName)!;
    const l = mut((x) => row[1](x, legit));
    const hits = failures(l).filter((f) => row[2](f.field));
    expect(hits.map((f) => `${f.checkId} ${f.context}`)).toEqual([]);
  });

  it('the golden fixture still passes with ZERO failures', () => {
    const result = runGate(clean, pack, ctx);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(audit.verified).toBe(true);
    expect(audit.packIntegrity.ok).toBe(true);
  });
});

// ===========================================================================
// NO FALSE POSITIVES — realistic copy corpus (lexicon-level probe)
// ===========================================================================

/**
 * The short abbreviations added in FIX 5 (`t2d`, `oa`, `ra`, `chf`, `ms`,
 * `afib`) are the ones most likely to collide with ordinary words, and the
 * separator-STRIPPED pass is the one most likely to manufacture an accidental
 * substring. This probe runs BOTH matchers over realistic supplement copy,
 * including the golden fixture's own source title and bullets.
 */
const PROBE_NOUNS = allDiseaseNouns(cp);

const CORPUS = [
  'Advanced Multivitamin for Men and Women, 120 Vegan Capsules, 90 Day Supply',
  'Contains vitamins A, C, D3, E, K2, B6, B12, folate, biotin, zinc, magnesium and selenium',
  'Take 2 capsules daily with a meal. Store in a cool dry place away from direct sunlight.',
  'Our formula uses 500 mg of ashwagandha KSM-66, 200 mg L-theanine, 100 mg GABA and 50 mg 5-HTP',
  'Third-party tested for purity and potency in an NSF certified, cGMP facility in the USA',
  'Non-GMO, gluten free, dairy free, soy free, vegan and free from artificial colors',
  'Supports a healthy inflammatory response, healthy joints, and everyday mobility',
  'CoQ10 and Omega-3 for heart and cellular energy support in adults over 40',
  'Contains: Tree Nuts (Almond). Made on shared equipment. Read the full label before use.',
  'Extra strength, extra absorption, extra value for a busy modern routine',
  'Ships in a recyclable bottle with a tamper-evident seal and a child-resistant cap',
  'Each serving delivers 50 Billion CFU across 10 clinically selected strains plus prebiotic fiber',
  'Formulated by a team of nutritionists and manufactured to strict quality standards',
  'Ideal for adults seeking steady energy, restful sleep, and calm focus during the day',
  'Vitamins and minerals from whole-food sources with no fillers, binders, or artificial flavors',
  'Rated as a great option for travelers, athletes, moms, and anyone with a packed schedule',
  rainforestSample.product.title as string,
  ...(rainforestSample.product.feature_bullets as string[] ?? []),
];

describe('NO FALSE POSITIVES — realistic supplement copy corpus', () => {
  it.each(CORPUS)('no banned term matches: %s', (raw) => {
    const text = normalize(String(raw));
    const boundary = scanTerms(text, PROBE_NOUNS).map((m) => m.term);
    const concat = scanConcatenated(text, PROBE_NOUNS, 5).map((m) => m.term);
    expect({ boundary, concat }).toEqual({ boundary: [], concat: [] });
  });
});
