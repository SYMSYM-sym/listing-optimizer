import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { c6BannedTerms, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { normalize } from '@/lib/gate/util';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * RED TEAM ROUND 5 — B1..B6.
 *
 * B1  negation cues laundered prevention claims ("Avoid diabetes" IS the claim)
 * B2  entity-encoded invisible characters (`can&#8203;cer`) beat the strip/decode
 *     ORDER inside `normalize`
 * B3  typographic LIGATURES survived the compatibility fold
 * B4  SMALL-CAPITAL letters were absent from the confusables table
 * B5  short terms (`g out`, `ib s`) were below the concatenated-pass threshold
 * B6  THE MONEY SHOT: a supplement routed to the `generic` pack disabled every
 *     compliance check, and the fail-closed backstop only ever read
 *     snapshotText + title + description
 */

const pack = loadPack('supplements');
const generic = loadPack('generic');
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
const c6On = (l: OptimizedListing, field: string): Failure[] =>
  c6BannedTerms(l, pack).filter((f) => f.field === field);

// ===========================================================================
// B1 — negation cues laundered prevention claims
// ===========================================================================

const B1_PAYLOADS = [
  'Avoid diabetes',
  'No more arthritis pain',
  'Never depression again',
  'No cancer worries',
  'Not another migraine, ever',
  'Avoid osteoporosis as you age',
  'Never asthma trouble again',
];

describe('B1 — a bare negation cue no longer launders a prevention claim', () => {
  it.each(B1_PAYLOADS)('"%s" FAILS C6 in a bullet', (payload) => {
    const l = mut((x) => { x.bullets[1] = `${payload} with our blend*`; });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(B1_PAYLOADS)('"%s" FAILS A2 in an A+ FAQ answer', (payload) => {
    const l = mut((x) => {
      x.aplusContent.faq[0] = { q: 'Why this blend?', a: `${payload} with our blend.`, claimBearing: false };
    });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'A2')).toBe(true);
  });

  /** The genuine disclaimer must STILL pass — that is the whole point of it. */
  it('the verbatim disclaimer is still clean', () => {
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  it.each([
    'not intended to diagnose, treat, cure, or prevent any disease',
    'not intended to diagnose, treat, cure or prevent any disease',
  ])('the meta-phrase "%s" is still exempt in copy', (phrase) => {
    const l = mut((x) => { x.bullets[1] = `This product is ${phrase}*`; });
    expect(c6On(l, 'bullets[1]')).toEqual([]);
  });
});

// ===========================================================================
// B2 — entity-encoded invisible characters (decode/strip ORDER)
// ===========================================================================

const ZWSP_ENTITIES = ['&#8203;', '&#x200b;', '&#65279;', '&#173;'];

describe('B2 — an entity-encoded invisible character no longer evades the scan', () => {
  it.each(ZWSP_ENTITIES)('"can%scer" FAILS C6', (entity) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for can${entity}cer in adults*`; });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  it.each(ZWSP_ENTITIES)('an entity-hidden price ("39 doll%sars") FAILS C18', (entity) => {
    const l = mut((x) => { x.bullets[1] = `Great value at 39 doll${entity}ars and 95 cents*`; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C18' && f.field === 'bullets[1]')).toBe(true);
  });

  it('normalize decodes BEFORE stripping, so the materialised character is removed', () => {
    expect(normalize('can&#8203;cer')).toBe('cancer');
    expect(normalize('39 doll&#8203;ars')).toBe('39 dollars');
  });
});

// ===========================================================================
// B3 — typographic ligatures
// ===========================================================================

const LIGATURES: [string, string][] = [
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬀ', 'ff'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬅ', 'st'],
  ['ﬆ', 'st'],
];

describe('B3 — ligatures fold to their letter pairs', () => {
  it.each(LIGATURES)('U+%s folds to "%s" in normalize', (lig, plain) => {
    expect(normalize(`x${lig}x`)).toBe(`x${plain}x`);
  });

  it.each([
    ['ﬁbromyalgia', 'fibromyalgia'],
    ['inﬂuenza', 'influenza'],
    ['ﬅroke', 'stroke'],
    ['oﬆeoporosis', 'osteoporosis'],
  ])('the ligature payload "%s" FAILS C6', (payload) => {
    const l = mut((x) => { x.bullets[1] = `Daily support for ${payload} in adults*`; });
    expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
  });

  /** The fold must NOT dissolve symbols the style gate still has to see. */
  it.each(['™', '®', '€', '£'])('the symbol U+%s survives normalize', (sym) => {
    expect(normalize(`Brand${sym} name`)).toContain(sym);
  });
});

// ===========================================================================
// B4 — small-capital letters
// ===========================================================================

/** Every small capital used to spell the payloads below, letter by letter. */
const SMALL_CAPS: [string, string][] = [
  ['ᴀ', 'a'], ['ʙ', 'b'], ['ᴄ', 'c'], ['ᴅ', 'd'], ['ᴇ', 'e'],
  ['ɢ', 'g'], ['ʜ', 'h'], ['ɪ', 'i'], ['ᴊ', 'j'], ['ᴋ', 'k'],
  ['ʟ', 'l'], ['ᴍ', 'm'], ['ɴ', 'n'], ['ᴏ', 'o'], ['ᴘ', 'p'],
  ['ʀ', 'r'], ['Ʀ', 'r'], ['ᴛ', 't'], ['ᴜ', 'u'], ['ᴠ', 'v'],
  ['ᴡ', 'w'], ['ʏ', 'y'], ['ᴢ', 'z'],
];

describe('B4 — small capitals fold to their ASCII twin', () => {
  // Case is irrelevant to every scan (they are all case-insensitive), so the
  // fold is asserted case-insensitively: some small capitals are themselves
  // UPPERCASE codepoints and fold onto the capital ASCII letter.
  it.each(SMALL_CAPS)('U+%s folds to "%s"', (smallCap, ascii) => {
    expect(normalize(`x${smallCap}x`).toLowerCase()).toBe(`x${ascii}x`);
  });

  it.each(['ᴄᴀɴᴄᴇʀ', 'ᴀᴄɴᴇ', 'ᴛᴜᴍᴏʀ', 'ɪɴꜰʟᴜᴇɴᴢᴀ'.replace('ꜰ', 'f')])(
    'the small-caps payload "%s" FAILS C6',
    (payload) => {
      const l = mut((x) => { x.bullets[1] = `Daily support for ${payload} in adults*`; });
      expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
    },
  );
});

// ===========================================================================
// B5 — short terms below the concatenated-pass threshold
// ===========================================================================

describe('B5 — short split terms are covered by the concatenated pass', () => {
  it.each(['g out', 'ib s', 'go ut', 'i bs', 'u ti', 'fl u'])(
    'the split payload "%s" FAILS C6',
    (payload) => {
      const l = mut((x) => { x.bullets[1] = `Daily support for ${payload} in adults*`; });
      expect(c6On(l, 'bullets[1]').length).toBeGreaterThan(0);
    },
  );

  /** …without re-opening the collision the same pass used to manufacture. */
  it.each([
    'Part of a healthy routine and a balanced diet',
    'Our product utility is unmatched',
    'Great for your daily routine, anywhere',
  ])('"%s" is still clean', (payload) => {
    const l = mut((x) => { x.bullets[1] = `${payload}*`; });
    expect(c6On(l, 'bullets[1]')).toEqual([]);
  });
});

// ===========================================================================
// B6 — THE MONEY SHOT
// ===========================================================================

/**
 * A dietary supplement whose CATEGORY and TITLE carry none of the routing
 * markers, so `detectCategory` sends it to the `generic` pack — which has no
 * compliance module, so C5/C6/C9/C10/C11/A1/A2 all early-return `[]`. Every
 * cure claim lives in the BULLETS, the A+ content, the Q&A and the ATTRIBUTES,
 * i.e. exactly the surfaces the old fail-closed backstop
 * (`snapshotText + title + description`) never read.
 */
const b6Snapshot: ListingSnapshot = {
  asin: 'B0GENERIC1',
  url: 'https://www.amazon.com/dp/B0GENERIC1',
  title: 'BrandZ Daily Greens Chews, 60 Count',
  bullets: ['Greens chews for grown-ups'],
  description: 'BrandZ Daily Greens Chews are a tasty way to round out your day.',
  images: [],
  attributes: { brand_name: 'BrandZ', item_form: 'Chews' },
  category: 'Health & Household',
  subcategory: [],
  raw: {},
};

const buildB6 = (): OptimizedListing =>
  mut((x) => {
    x.productName = 'BrandZ Daily Greens Chews';
    x.title = 'BrandZ Daily Greens Chews, 60 Count';
    x.title75 = 'BrandZ Daily Greens Chews, 60 Count';
    x.description =
      'BrandZ Daily Greens Chews are a tasty way to round out your day. Who it is for: grown-ups.';
    x.bullets = [
      'Cures diabetes and reverses arthritis in weeks*',
      'Clinically shown to treat high blood pressure*',
      'Greens chews for grown-ups*',
      'A tasty way to round out your day*',
      'Sixty chews per pouch*',
    ];
    x.qa = [
      { q: 'Will this help my cancer?', a: 'Yes, it shrinks tumors and cures cancer.', claimBearing: false },
    ];
    x.attributes = {
      brand_name: 'BrandZ',
      special_ingredients: 'Formulated to treat Alzheimers and prevent stroke',
    };
    x.aplusContent.faq = [
      { q: 'Does it work?', a: 'It works like a natural Ozempic and cures type 2 diabetes.', claimBearing: false },
    ];
    x.aplusContent.modules = x.aplusContent.modules.map((m) => ({
      ...m,
      body: `${m.body} Heals depression and prevents heart disease.`,
    }));
  });

describe('B6 MONEY SHOT — a supplement routed to `generic` can no longer pass', () => {
  const b6Ctx: GateContext = {
    subcategories: [],
    snapshotText: `${b6Snapshot.title} ${b6Snapshot.category}`,
  };

  it('the snapshot really does route to the generic pack (the premise holds)', () => {
    const detection = detectCategory(b6Snapshot);
    expect(detection.packId).toBe('generic');
    expect(loadPack(detection.packId).compliancePack).toBeNull();
  });

  it('the gate FAILS with a blocking PACK failure', () => {
    const result = runGate(buildB6(), generic, b6Ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.filter((f) => f.checkId === 'PACK').length).toBeGreaterThan(0);
  });

  it('the suspicion backstop reads the WHOLE listing, not just title + description', () => {
    // Nothing regulated in the snapshot text, the title or the description of
    // THIS variant — every marker sits in bullets/attributes/A+/Q&A.
    const hidden = mut((x) => {
      x.productName = 'BrandZ Chews';
      x.title = 'BrandZ Chews';
      x.title75 = 'BrandZ Chews';
      x.description = 'BrandZ Chews are a tasty pick-me-up. Who it is for: grown-ups.';
      x.attributes = { brand_name: 'BrandZ', special_ingredients: 'Two capsules per serving' };
    });
    const bare: GateContext = { subcategories: [], snapshotText: 'BrandZ Chews Household' };
    const packFailures = runGate(hidden, generic, bare).failures.filter((f) => f.checkId === 'PACK');
    expect(packFailures.length).toBeGreaterThan(0);
  });

  it('the cross-pack disease backstop fires even without any suspicion vocabulary', () => {
    const noVocab = mut((x) => {
      x.productName = 'BrandZ Bites';
      x.title = 'BrandZ Bites';
      x.title75 = 'BrandZ Bites';
      x.description = 'BrandZ Bites are a tasty pick-me-up. Who it is for: grown-ups.';
      x.bullets = ['Cures diabetes and reverses arthritis in weeks', 'b', 'c', 'd', 'e'];
      x.itemHighlights = 'A tasty pick-me-up for grown-ups everywhere today';
      x.backendSearchTerms = 'bites snack treat';
      x.facts = {};
      x.attributes = { brand_name: 'BrandZ' };
      x.qa = [{ q: 'Tasty?', a: 'Very.', claimBearing: false }];
      x.imagePlan = [{ slot: 1, purpose: 'main image', spec: 'white background', notes: 'no overlay' }];
      x.aplusContent = {
        fdaDisclaimer: '',
        modules: [{ id: 'hero', headline: 'BrandZ Bites', body: 'A tasty pick-me-up.', claimBearing: false }],
        comparison: { rows: [{ label: 'Taste', ours: 'Great', typical: 'Bland' }] },
        faq: [{ q: 'Tasty?', a: 'Very.', claimBearing: false }],
      };
    });
    const bare: GateContext = { subcategories: [], snapshotText: 'BrandZ Bites Household' };
    const hit = runGate(noVocab, generic, bare).failures.find(
      (f) => f.checkId === 'PACK' && f.context.includes('disease/drug term'),
    );
    expect(hit).toBeDefined();
  });

  it('buildAudit reports verified === false and a non-ok packIntegrity', () => {
    const audit = buildAudit(b6Snapshot, buildB6(), generic, b6Ctx);
    expect(audit.verified).toBe(false);
    expect(audit.gateResult.pass).toBe(false);
    expect(audit.packIntegrity.ok).toBe(false);
    expect(audit.packIntegrity.problems.join(' ')).toContain('no compliance module');
  });
});

// ===========================================================================
// Routing cleanliness (fix 6c) — the hard-coded literal is gone
// ===========================================================================

describe('routing is 100% pack data', () => {
  it('an attribute-only supplement signal still routes to the supplements pack', () => {
    const snap: ListingSnapshot = {
      ...b6Snapshot,
      category: 'Grocery',
      title: 'BrandZ Greens Chews',
      attributes: { product_type: 'Dietary Supplement' },
    };
    expect(detectCategory(snap).packId).toBe('supplements');
  });
});

// ===========================================================================
// FIX 6 — the smaller findings
// ===========================================================================

describe('FIX 6a — C17 subtracts the disclaimer before the bullet-only rules', () => {
  it('a bullet that carries the verbatim disclaimer no longer fails on trailing punctuation', () => {
    const l = mut((x) => {
      x.bullets[1] = `Supports a balanced gut* ${pack.compliancePack!.disclaimer}`;
    });
    expect(runGate(l, pack, ctx).failures.filter((f) => f.field === 'bullets[1]')).toEqual([]);
  });

  it('a bullet that genuinely ends in punctuation still fails C17', () => {
    const l = mut((x) => { x.bullets[1] = 'Supports a balanced gut.'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C17' && f.field === 'bullets[1]')).toBe(true);
  });

  it('a lowercase bullet still fails C17 after subtraction', () => {
    const l = mut((x) => {
      x.bullets[1] = `supports a balanced gut* ${pack.compliancePack!.disclaimer}`;
    });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C17' && f.field === 'bullets[1]')).toBe(true);
  });
});

describe('FIX 6b — facts.* are scanned by C18/C19, with facts.price exempt BY KEY', () => {
  it('a price parked in facts.potency FAILS C18', () => {
    const l = mut((x) => { x.facts.potency = 'Great value at $19.95 per bottle'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C18' && f.field === 'facts.potency')).toBe(true);
  });

  it('a marketing claim parked in facts.servingSize FAILS C19', () => {
    const l = mut((x) => { x.facts.servingSize = 'Two capsules, our best seller'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C19' && f.field === 'facts.servingSize')).toBe(true);
  });

  it('facts.price itself is exempt — it legitimately holds the standard price', () => {
    const l = mut((x) => { x.facts.price = '$29.99'; });
    expect(runGate(l, pack, ctx).failures.filter((f) => f.field === 'facts.price')).toEqual([]);
  });
});

describe('FIX 6e — the description byte cap can no longer over-block accented copy', () => {
  it('2000 characters of two-byte copy passes the byte backstop', () => {
    const style = pack.rules.style;
    expect(style.descriptionMaxBytes).toBeGreaterThanOrEqual(4 * pack.rules.descriptionMax);
  });

  it('a description at the character cap made of accented letters raises no C17 byte failure', () => {
    const l = mut((x) => {
      const head = `${x.productName}. ${pack.compliancePack!.disclaimer} `;
      x.description = head + 'é'.repeat(pack.rules.descriptionMax - head.length);
    });
    expect(l.description.length).toBe(pack.rules.descriptionMax);
    const byteFailures = runGate(l, pack, ctx).failures.filter(
      (f) => f.checkId === 'C17' && f.field === 'description' && f.context.includes('bytes'),
    );
    expect(byteFailures).toEqual([]);
  });
});
