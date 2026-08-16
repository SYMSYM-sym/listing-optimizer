import { beforeAll, describe, expect, it } from 'vitest';
import { buildFacts } from '@/lib/engine/facts';
import { fieldToGroup } from '@/lib/engine/fieldRouting';
import { optimize } from '@/lib/engine/optimize';
import { normalizeListingTypography } from '@/lib/engine/typography';
import {
  c18ProhibitedContent,
  c19ProhibitedMarketing,
  collectSurfaces,
} from '@/lib/gate/checks/c-prohibited';
import { c27OutputHygiene } from '@/lib/gate/checks/c-hygiene';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * M1 — C27 DID NOT SCAN `facts.*`, AND THE ASCII THIRD OF IT STILL MUST NOT
 * ===========================================================================
 *
 * THE HOLE, exactly as it stood.
 *
 *   `collectSurfaces` (lib/gate/checks/c-prohibited.ts) reads exactly the
 *   surface groups the calling check's pack key declares. `prohibitedContent`
 *   (C18) and `prohibitedMarketing` (C19) each declared **twelve** groups;
 *   `outputHygiene` (C27) declared **eleven** — the missing one was `facts`.
 *
 *   So a smart quote, a zero-width character, an AI-tell phrase or a leaked
 *   instruction fragment parked in a fact string was invisible to C27, while the
 *   identical string one field over (in an attribute value, say) failed. The
 *   asymmetry is the tell, exactly as in N1: `facts` was never a new surface —
 *   C18 and C19 had been reading it all along, and only C27 was left behind.
 *
 *   `tests/n1.surfaceCoverage.gate.test.ts` §1 could not see this, because it
 *   pinned the collector's vocabulary against the **UNION** of the three keys
 *   and the union still contained `facts`. That is finding M3, closed in §1.5
 *   of that file.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, AND WHY IT IS NOT A SPLIT
 * ---------------------------------------------------------------------------
 * `facts` joins `outputHygiene.surfaces`, and it joins `asciiExemptSurfaces` in
 * the same change. That is ONE decision about ONE rule, not half of each:
 *
 *  - The two PHRASE scans belong on facts and now run there. `facts.*` is
 *    echoed **verbatim** into every repair prompt (see `collectSurfaces`), so an
 *    AI tell or an instruction fragment sitting in a fact is both a defect in
 *    the record and a prompt-injection route into the next round.
 *
 *  - The ASCII scan does not belong there, and its own docstring says why
 *    without meaning to. It reads: *the engine folds typographic punctuation to
 *    ASCII at emit, so anything non-ASCII that survives is a real character.*
 *    `lib/engine/typography.ts` **deliberately never folds `facts`** — they are
 *    deterministic source truth read off the scraped page (and, under WS5.5,
 *    off an operator's confirmed panel reading), not model-written copy. So the
 *    premise the rule rests on is false for this one group, and only for it.
 *
 *  - And a facts ASCII failure would be **structurally unrepairable**: facts are
 *    recomputed identically from the same snapshot on every round, so no
 *    regeneration can rewrite one. That is the unwinnable-run shape recorded as
 *    items 10.1 and 11.2 of CONFORMANCE-DEVIATIONS.md, and this project treats
 *    over-blocking as exactly as severe as a bypass.
 *
 * §4 asserts that premise against the code rather than restating it, so the
 * carve-out cannot outlive the reason for it: if `normalizeListingTypography`
 * ever starts folding facts, §4 fails and the exemption has to be re-argued.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The pack exactly as it shipped BEFORE M1: C27 declares everything but `facts`. */
const preM1Pack = (): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
  p.rules.outputHygiene!.surfaces = (p.rules.outputHygiene!.surfaces ?? []).filter(
    (g) => g !== 'facts',
  );
  return p;
};

/** The pack with the ASCII carve-out for `facts` removed — the STRICTER pack. */
const noFactsAsciiCarveOut = (): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
  p.rules.outputHygiene!.asciiExemptSurfaces = (
    p.rules.outputHygiene!.asciiExemptSurfaces ?? []
  ).filter((g) => g !== 'facts');
  return p;
};

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const withFact = (key: string, value: string): OptimizedListing => {
  const l = clone();
  (l.facts as unknown as Record<string, unknown>)[key] = value;
  return l;
};
const onField = (fs: Failure[], field: string): Failure[] => fs.filter((f) => f.field === field);

/** The STRING-valued fact keys the collector actually reads (`price` is exempt by key). */
const STRING_FACT_KEYS = ['potency', 'servingSize', 'weight'] as const;

const AI_TELL = 'look no further';
const FRAGMENT = 'return json';

// ===========================================================================
// §0 — THE BASELINE
// ===========================================================================

describe('§0 baseline', () => {
  it('the golden fixture carries the string facts under test (otherwise §2 proves nothing)', () => {
    for (const key of STRING_FACT_KEYS) {
      expect(typeof clean.facts[key], key).toBe('string');
      expect(String(clean.facts[key]).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('the fixture raises NOTHING from C27 and still converges to zero gate failures', () => {
    expect(c27OutputHygiene(clean, pack)).toEqual([]);
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });

  it('C27 now declares `facts`, exactly as C18 and C19 always did', () => {
    for (const key of ['prohibitedContent', 'prohibitedMarketing', 'outputHygiene'] as const) {
      expect(pack.rules[key]?.surfaces, key).toContain('facts');
    }
  });
});

// ===========================================================================
// §1 — THE OMISSION, REPRODUCED (so this suite is not vacuous)
// ===========================================================================

describe('§1 the hole, reproduced against the pre-M1 pack', () => {
  it('an AI tell in a fact was INVISIBLE to C27 before, and FAILS now', () => {
    const bad = withFact('servingSize', `1 Capsule, ${AI_TELL}`);
    expect(onField(c27OutputHygiene(bad, preM1Pack()), 'facts.servingSize')).toEqual([]);
    expect(onField(c27OutputHygiene(bad, pack), 'facts.servingSize').length).toBeGreaterThan(0);
  });

  it('a leaked instruction fragment in a fact was invisible too, and FAILS now', () => {
    const bad = withFact('weight', `2.4 Ounces ${FRAGMENT}`);
    expect(onField(c27OutputHygiene(bad, preM1Pack()), 'facts.weight')).toEqual([]);
    expect(onField(c27OutputHygiene(bad, pack), 'facts.weight').length).toBeGreaterThan(0);
  });

  it('the asymmetry that gave it away: the SAME string one field over always failed', () => {
    const bad = clone();
    bad.attributes.item_form = `Capsule, ${AI_TELL}`;
    expect(onField(c27OutputHygiene(bad, preM1Pack()), 'attributes.item_form').length).toBeGreaterThan(0);
  });

  it('C18/C19 are untouched by M1 — they declared `facts` before and after', () => {
    const bad = withFact('weight', '2.4 Ounces, only $19.95 today');
    for (const p of [preM1Pack(), pack]) {
      expect(onField(c18ProhibitedContent(bad, p), 'facts.weight').length).toBeGreaterThan(0);
    }
    const claim = withFact('weight', '2.4 Ounces, the best seller');
    for (const p of [preM1Pack(), pack]) {
      expect(onField(c19ProhibitedMarketing(claim, p), 'facts.weight').length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// §2 — THE TWO PHRASE SCANS, ON EVERY STRING FACT
// ===========================================================================

describe('§2 the phrase scans reach every fact string', () => {
  for (const key of STRING_FACT_KEYS) {
    it(`an AI-tell phrase in facts.${key} FAILS C27 naming that exact field`, () => {
      const bad = withFact(key, `${clean.facts[key]}, ${AI_TELL}`);
      const hits = onField(c27OutputHygiene(bad, pack), `facts.${key}`);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.context.includes('AI-tell'))).toBe(true);
    });

    it(`a leaked instruction fragment in facts.${key} FAILS C27 naming that exact field`, () => {
      const bad = withFact(key, `${clean.facts[key]} ${FRAGMENT}`);
      const hits = onField(c27OutputHygiene(bad, pack), `facts.${key}`);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.context.includes('instruction fragment'))).toBe(true);
    });
  }

  it('through the WHOLE gate, and the failure ROUTES to a group rather than dead-ending', () => {
    const bad = withFact('weight', `2.4 Ounces ${FRAGMENT}`);
    const result = runGate(bad, pack, ctx);
    expect(result.pass).toBe(false);
    const emitted = result.failures.filter((f) => f.checkId === 'C27' && f.field === 'facts.weight');
    expect(emitted.length).toBeGreaterThan(0);
    for (const f of emitted) expect(fieldToGroup(f)).toBe('attributes');
  });

  it('`facts.price` stays exempt BY KEY — that exemption is the collector\'s, not C27\'s', () => {
    const bad = withFact('price', `$24.99 ${AI_TELL}`);
    expect(onField(c27OutputHygiene(bad, pack), 'facts.price')).toEqual([]);
    expect(
      collectSurfaces(bad, new Set(['facts']), pack.rules.factFields?.price).map((s) => s.field),
    ).not.toContain('facts.price');
  });
});

// ===========================================================================
// §3 — THE ASCII CARVE-OUT, BOTH DIRECTIONS
// ===========================================================================

const NON_ASCII: [string, string][] = [
  ['an accented word', '1 Capsule, 2.4 Unzen mit Zusätzen'],
  ['a smart quote the fold left alone', '1 Capsule (the label’s own wording)'],
  ['an en dash', '1–2 Capsules'],
  ['a non-breaking space', '2.4 Ounces'],
  ['a micro sign', '500 µg per capsule'],
  ['a zero-width character', '1 Capsu​le'],
];

describe('§3 the ASCII third of C27 does NOT apply to facts, and applies everywhere else', () => {
  for (const [label, value] of NON_ASCII) {
    it(`${label} in a fact raises NOTHING from C27`, () => {
      for (const key of STRING_FACT_KEYS) {
        const bad = withFact(key, value);
        expect(onField(c27OutputHygiene(bad, pack), `facts.${key}`), key).toEqual([]);
      }
    });

    it(`${label} in an ATTRIBUTE value still FAILS — the carve-out is scoped to facts`, () => {
      const bad = clone();
      bad.attributes.item_form = value;
      const hits = onField(c27OutputHygiene(bad, pack), 'attributes.item_form');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.context.includes('non-ASCII'))).toBe(true);
    });
  }

  it('the carve-out is ASCII-ONLY: a non-ASCII fact carrying an AI tell still fails, for the tell', () => {
    const bad = withFact('servingSize', `1 Capsule café, ${AI_TELL}`);
    const hits = onField(c27OutputHygiene(bad, pack), 'facts.servingSize');
    expect(hits.length).toBe(1);
    expect(hits[0]!.context).toContain('AI-tell');
    expect(hits.some((h) => h.context.includes('non-ASCII'))).toBe(false);
  });

  it('the carve-out is PACK DATA and it only SUBTRACTS — removing it makes the gate stricter', () => {
    const bad = withFact('servingSize', '1–2 Capsules');
    expect(onField(c27OutputHygiene(bad, pack), 'facts.servingSize')).toEqual([]);
    expect(
      onField(c27OutputHygiene(bad, noFactsAsciiCarveOut()), 'facts.servingSize').length,
    ).toBeGreaterThan(0);
  });

  it('the backend exemption is untouched, and no OTHER group gained one', () => {
    expect(pack.rules.outputHygiene!.asciiExemptSurfaces).toEqual(['backendSearchTerms', 'facts']);
    // an exemption naming a group nothing declares would be dead weight reading
    // as a decision — both of these are declared surfaces.
    for (const g of pack.rules.outputHygiene!.asciiExemptSurfaces ?? []) {
      expect(pack.rules.outputHygiene!.surfaces, g).toContain(g);
    }
  });
});

// ===========================================================================
// §4 — THE PREMISE THE CARVE-OUT RESTS ON, ASSERTED AGAINST THE CODE
// ===========================================================================

describe('§4 why facts are different, pinned rather than asserted in prose', () => {
  it('the emit-time typographic fold covers generated copy and DELIBERATELY skips facts', () => {
    const l = clone();
    l.title = 'BrandX Probiotic – 50 Billion CFU';
    (l.facts as unknown as Record<string, unknown>).servingSize = '1–2 Capsules';
    const folded = normalizeListingTypography(l);
    // the model-written surface is folded to ASCII...
    expect(folded.title).not.toContain('–');
    expect(folded.title).toContain('-');
    // ...and the fact is returned byte-identical, en dash and all.
    expect(folded.facts.servingSize).toBe('1–2 Capsules');
  });

  it('a fact is SOURCE TRUTH: its value is the scraped attribute verbatim, not model output', () => {
    const facts = buildFacts(snapshot, pack);
    const weightKey = pack.rules.factFields.weight;
    expect(facts.weight).toBe((snapshot.attributes[weightKey] ?? '').trim());
  });

  it('...and it is DETERMINISTIC, so no repair round could ever rewrite a fact', () => {
    // The routing table sends `facts.*` to the attributes group, but the facts
    // block is rebuilt from the snapshot, not regenerated: an ASCII failure here
    // would burn every remaining round and end the run verified:false on a
    // character nobody wrote.
    expect(buildFacts(snapshot, pack)).toEqual(clean.facts);
    expect(fieldToGroup({ checkId: 'C27', field: 'facts.weight', context: '', fix: '' })).toBe(
      'attributes',
    );
  });
});

// ===========================================================================
// §5 — THE LAWFUL-VALUE BATTERY (over-blocking is as severe as a bypass)
// ===========================================================================

/**
 * The shapes real facts actually take: the golden/probiotic fixture, the
 * oral-care run of B00WNDG7V8 (whose live facts were `{price, formulaCount: 11}`
 * against truthful "120 Count" attributes) and the potency-bearing run of
 * B00EEEITVA. None of them may raise anything from C27.
 */
const LAWFUL_FACTS: Record<string, string | number>[] = [
  // the golden fixture, unchanged
  { potency: '50 Billion CFU', formulaCount: 10, unitCount: 60, servings: 60, servingSize: '1 Capsule', daySupply: 60, weight: '2.4 Ounces', price: '$24.99' },
  // B00WNDG7V8 — the live shape, price + formula count only
  { price: '$29.95', formulaCount: 11 },
  // B00WNDG7V8 with its truthful container count and scraped panel strings
  { unitCount: 120, servings: 120, servingSize: '1 Lozenge', daySupply: 120, weight: '3.5 Ounces', price: '$29.95', formulaCount: 11 },
  // B00EEEITVA — the potency-bearing register
  { potency: '50 Billion CFU', unitCount: 30, servingSize: '2 Capsules', daySupply: 15, weight: '1.6 Ounces', price: '$39.95' },
  // scraped shapes that LOOK odd and are ordinary
  { servingSize: '120 Count (Pack of 1)', weight: '1 fl oz (30 mL)', price: '$12.00' },
  { servingSize: '2 Gummies', weight: '10.6 Ounces', potency: '1000 mg' },
];

describe('§5 lawful fact values raise NOTHING from C27', () => {
  for (const facts of LAWFUL_FACTS) {
    it(`facts ${JSON.stringify(facts).slice(0, 70)} passes`, () => {
      const l = clone();
      l.facts = facts as unknown as OptimizedListing['facts'];
      expect(c27OutputHygiene(l, pack).filter((f) => f.field.startsWith('facts.'))).toEqual([]);
    });
  }

  it('every fact string the golden fixture ships is already pure ASCII, so nothing was traded away', () => {
    for (const [key, value] of Object.entries(clean.facts)) {
      if (typeof value !== 'string') continue;
      expect([...value].every((c) => c.charCodeAt(0) <= 127), `facts.${key} = ${value}`).toBe(true);
    }
    // ...which is also why the golden fixture is untouched by the carve-out:
    // the STRICTER pack produces the same zero findings on it.
    expect(c27OutputHygiene(clean, noFactsAsciiCarveOut())).toEqual([]);
  });

  it('and the whole gate still converges to zero failures on the fixture', () => {
    expect(runGate(clean, pack, ctx).failures).toEqual([]);
  });
});
