import { beforeAll, describe, expect, it } from 'vitest';
import { buildSubstantiationRegister } from '@/lib/audit/substantiation';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildSystemPrompt } from '@/lib/engine/prompts';
import { a8AplusProhibitedMarketing } from '@/lib/gate/checks/a-aplus';
import { c19ProhibitedMarketing } from '@/lib/gate/checks/c-prohibited';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Facts, Failure, KnowledgePack, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * M1 — `'clinically studied'` NEVER CONVERGED, AND THE THREE ANSWERS.
 *
 * Live, ASIN B00EEEITVA (a probiotic whose SOURCE listing leads on exactly that
 * framing), after the full repair budget:
 *
 *   C19 | aplus.modules[brand-story]       | 'clinically studied'
 *   C19 | aplus.modules[comparison]        | 'clinically studied'
 *   C19 | aplus.comparison[0]              | 'clinically studied'
 *   A8  | aplus.modules[brand-story].body  | 'clinically studied'
 *   A8  | aplus.modules[comparison].body   | 'clinically studied'
 *   A8  | aplus.comparison[0].ours         | 'clinically studied'
 *
 * 1. IS THE CHECK RIGHT? YES, and it is untouched in scope. The row is pack
 *    data (`knowledge/rules.json -> prohibitedMarketing.patterns`), C19 and A8
 *    read the SAME macro-expanded list through `prohibitedMarketingPatterns`,
 *    which is why one phrase produces two checks' worth of findings on the same
 *    strings. Its recorded rationale is that clinical framing is legitimate
 *    when substantiated and prohibited when it is not, and substantiation is an
 *    artifact in a filing cabinet that a scraped page cannot show. Nothing here
 *    lowers it.
 *
 * 2. WHY IT DID NOT CONVERGE — and this is NOT the C23/C28 shape. Those two
 *    were rules the generator had never been shown at all. This one WAS shown:
 *    `prohibitedMarketingBlock` renders every pattern LABEL into the system
 *    preamble, so the model was told "never include ... study-endorsement
 *    claim". What it was never given is a SUBSTITUTE. A label is a category
 *    name; the source listing's own framing is right there in the snapshot; and
 *    a brand-story module and a comparison column both demand a differentiator.
 *    Every repair round regenerated the A+ block from the same source with
 *    nothing else to reach for. C22 has both halves — the ban AND
 *    `approvedClaimTemplates`. This class had only the ban. It now has both:
 *    `compliancePack.trustFramingNote`, positive, pack data, naming no phrase
 *    any check reacts to (that constraint is `tests/promptHygiene.test.ts`,
 *    which is part of this round's verification).
 *
 * 3. THE SEPARATOR HOLE FOUND WHILE READING THE ROW. The pattern was
 *    `\bclinically\s+studied\b`, so `clinically-studied` — the same claim, one
 *    character different — matched nothing and shipped. A repair round told to
 *    remove the phrase could satisfy the gate by hyphenating it. Every other
 *    two-word row in that list already spells the separator as a class
 *    (`money[- ]back`, `award[- ]winning`, `risk[- ]free`); this one was the
 *    outlier. The SCOPE is unchanged — 'clinically tested', 'clinical study'
 *    and 'clinical research' are still not this row's business, and section (c)
 *    pins that in both directions.
 *
 * 4. THE REGISTER (section (d)). `lib/audit/substantiation.ts` offered
 *    `Clinically studied` for operator sign-off — `HELD` when the source
 *    listing already said it — about a phrase C19 will never let into copy. Two
 *    sections of one ship sheet, one string, opposite instructions. They are not
 *    both right: a substantiation row asks "can you prove this before it
 *    publishes?", and a prohibited-marketing hit cannot publish at all. The ban
 *    wins; the register no longer offers a hit whose matched span the gate bans.
 *    It is a coherence rule derived from the gate's OWN lexicon, so it covers
 *    the other two overlaps (`award-winning`, the regulatory-certification row)
 *    without naming any of them.
 */

const pack = loadPack('supplements');
const cosmetics = loadPack('cosmetics');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const baseSnapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** The live shape: a SOURCE listing that genuinely leads on the framing. */
const echoingSource: ListingSnapshot = {
  ...baseSnapshot,
  description: `${baseSnapshot.description} The strain in this formula is clinically studied.`,
};

const clonePack = (p: KnowledgePack): KnowledgePack => JSON.parse(JSON.stringify(p)) as KnowledgePack;
const withoutNote = (p: KnowledgePack): KnowledgePack => {
  const c = clonePack(p);
  delete c.compliancePack!.trustFramingNote;
  return c;
};

const NOTE = pack.compliancePack!.trustFramingNote!;

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(baseSnapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const mut = (f: (l: OptimizedListing) => void): OptimizedListing => {
  const l = clone();
  f(l);
  return l;
};

/** Every C19 + A8 finding whose context is the study-endorsement phrase. */
const studyFailures = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] =>
  [...c19ProhibitedMarketing(l, p), ...a8AplusProhibitedMarketing(l, p)].filter((f) =>
    /clinically[\s-]+studied/i.test(f.context),
  );

// ===========================================================================
// (a) THE PROMPT — the positive rule, rendered FROM PACK DATA
// ===========================================================================

describe('(a) the prompt states what verifiable trust framing IS available', () => {
  it.each(['supplements', 'cosmetics'] as const)('%s ships a non-empty trust-framing note', (id) => {
    const note = loadPack(id).compliancePack!.trustFramingNote;
    expect(typeof note).toBe('string');
    expect(note!.trim().length).toBeGreaterThan(80);
  });

  it.each([
    ['supplements', pack],
    ['cosmetics', cosmetics],
  ] as const)('%s: the assembled system prompt carries it verbatim', (_id, p) => {
    const rendered = buildSystemPrompt(p, {} as Facts, ['probiotic']);
    expect(rendered).toContain(p.compliancePack!.trustFramingNote!.trim());
  });

  it('NO note in the pack, NO line — and the rest of the prompt is byte-for-byte what it was', () => {
    const bare = withoutNote(pack);
    const withLine = buildSystemPrompt(pack, {} as Facts, ['probiotic']);
    const withoutLine = buildSystemPrompt(bare, {} as Facts, ['probiotic']);
    expect(withoutLine).not.toContain(NOTE.trim());
    expect(withLine.replace(`\n- ${NOTE.trim()}`, '')).toBe(withoutLine);
  });

  it('a blank note renders no line either (the trim is load-bearing)', () => {
    const blank = clonePack(pack);
    blank.compliancePack!.trustFramingNote = '   ';
    expect(buildSystemPrompt(blank, {} as Facts, ['probiotic'])).toBe(
      buildSystemPrompt(withoutNote(pack), {} as Facts, ['probiotic']),
    );
  });

  it.each([
    ['supplements', pack],
    ['cosmetics', cosmetics],
  ] as const)('%s: the note itself names NO phrase C19/A8 react to', (_id, p) => {
    const asCopy = { description: p.compliancePack!.trustFramingNote! } as unknown as OptimizedListing;
    expect(c19ProhibitedMarketing(asCopy, p)).toEqual([]);
  });
});

// ===========================================================================
// (b) CONVERGENCE — a model given the guidance writes A+ copy that passes
// ===========================================================================

/**
 * A generator that behaves the way the live one did: with no substitute in the
 * brief it reaches for the SOURCE listing's own framing in the brand-story body
 * and the comparison column; shown the trust-framing note, it states the
 * specification instead. Everything else it returns is `mockLlm`'s output, so
 * the two runs differ by exactly one pack key.
 */
const echoingLlm: LlmClient = async (req) => {
  const raw = await mockLlm(req);
  if (!req.user.includes('A+ content')) return raw;
  const guided = req.system.includes(NOTE.trim());
  const parsed = JSON.parse(raw) as {
    modules: { id: string; body: string }[];
    comparison: { rows: { ours: string }[] };
  };
  const trust = guided
    ? 'Every batch states its strain identity and potency on the panel.'
    : 'Every batch uses a clinically studied strain.';
  const story = parsed.modules.find((m) => m.id === 'brand-story')!;
  story.body = `${story.body} ${trust}`;
  const row = parsed.comparison.rows[0]!;
  row.ours = guided
    ? `${row.ours}, stated on the panel`
    : `${row.ours}, clinically studied`;
  return JSON.stringify(parsed);
};

describe('(b) the live shape converges once the guidance is in the brief', () => {
  it('NO guidance: the generator echoes the source and C19 + A8 both fire on the A+ surfaces', async () => {
    const bare = withoutNote(pack);
    const listing = await optimize(echoingSource, bare, echoingLlm);
    const failures = studyFailures(listing, bare);
    expect(failures.length).toBeGreaterThanOrEqual(4);
    const shapes = failures.map((f) => `${f.checkId}|${f.field}`);
    expect(shapes).toContain('C19|aplus.modules[brand-story]');
    expect(shapes).toContain('C19|aplus.comparison[0]');
    expect(shapes).toContain('A8|aplus.modules[brand-story].body');
    expect(shapes).toContain('A8|aplus.comparison[0].ours');
    expect(runGate(listing, bare, ctx).pass).toBe(false);
  });

  it('GUIDANCE SHOWN: the same generator writes specification framing and the run converges', async () => {
    const listing = await optimize(echoingSource, pack, echoingLlm);
    expect(studyFailures(listing, pack)).toEqual([]);
    const result = runGate(listing, pack, ctx);
    expect(result.failures.filter((f) => f.checkId === 'C19' || f.checkId === 'A8')).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

// ===========================================================================
// (c) THE BAN STILL FIRES — and its SCOPE is unchanged
// ===========================================================================

const FIRES: [string, string][] = [
  ['plain', 'A clinically studied strain in every capsule'],
  ['title case', 'A Clinically Studied strain in every capsule'],
  ['upper case', 'A CLINICALLY STUDIED strain in every capsule'],
  ['hyphenated', 'A clinically-studied strain in every capsule'],
  ['en dash', 'A clinically–studied strain in every capsule'],
  ['double space', 'A clinically  studied strain in every capsule'],
  ['line broken', 'A clinically\nstudied strain in every capsule'],
];

/**
 * The other direction. These are ordinary research vocabulary — several of them
 * are entries in the packs' own `naturalStateSafePhrases` — and this row is
 * deliberately not about them. Widening the verb slot would over-block lawful
 * copy, which this project treats as exactly as severe as a bypass.
 */
const DOES_NOT_FIRE: [string, string][] = [
  ['clinically tested', 'Third-party and clinically tested for purity'],
  ['clinical study', 'The strain appears in a clinical study of gut flora'],
  ['clinical research', 'Clinical research on gut flora informed the formula'],
  ['ordinary studied', 'A well studied strain of the genus in this blend'],
];

describe('(c) the study-endorsement ban fires on the claim, in every spelling', () => {
  it.each(FIRES)('%s: fails C19 in a bullet', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c19ProhibitedMarketing(l, pack).filter((f) => f.field === 'bullets[1]').length)
      .toBeGreaterThan(0);
  });

  it.each(FIRES)('%s: fails C19 AND A8 in an A+ module body', (_label, payload) => {
    const l = mut((x) => {
      x.aplusContent!.modules[2]!.body = `${x.aplusContent!.modules[2]!.body} ${payload}`;
    });
    expect(c19ProhibitedMarketing(l, pack).some((f) => f.field.startsWith('aplus.modules'))).toBe(true);
    expect(a8AplusProhibitedMarketing(l, pack).some((f) => f.field.startsWith('aplus.modules'))).toBe(true);
  });

  it.each(FIRES)('%s: fails C19 in the comparison column too', (_label, payload) => {
    const l = mut((x) => {
      x.aplusContent!.comparison!.rows[0]!.ours = payload;
    });
    expect(c19ProhibitedMarketing(l, pack).some((f) => f.field === 'aplus.comparison[0]')).toBe(true);
  });

  it.each(DOES_NOT_FIRE)('%s is NOT a study-endorsement claim (no over-block)', (_label, payload) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(studyFailures(l)).toEqual([]);
  });

  it.each(['supplements', 'cosmetics'] as const)(
    '%s: emptying the pattern list disarms the row (it is PACK DATA, not a literal)',
    (id) => {
      const bare = clonePack(loadPack(id));
      bare.rules.prohibitedMarketing = { patterns: [], surfaces: [] };
      const l = mut((x) => {
        x.bullets[1] = 'A clinically studied strain in every capsule';
      });
      expect(c19ProhibitedMarketing(l, bare).some((f) => /clinically/i.test(f.context))).toBe(false);
      // …and the manifest is what catches an emptied list.
      expect(runGate(l, bare, ctx).failures.some((f) => f.checkId === 'PACK')).toBe(true);
    },
  );
});

// ===========================================================================
// (d) THE REGISTER — it never offers a claim the gate bans
// ===========================================================================

const registerFor = (l: OptimizedListing, source: ListingSnapshot = baseSnapshot) =>
  buildSubstantiationRegister(l, source, pack);
const claimNames = (l: OptimizedListing, source?: ListingSnapshot): string[] =>
  registerFor(l, source).map((r) => r.claim);

describe('(d) the substantiation register and C19 no longer disagree', () => {
  it('a phrase the gate BANS is not offered for sign-off — even when the source listing holds it', () => {
    const l = mut((x) => {
      x.bullets[1] = 'A clinically studied strain in every capsule';
    });
    // The gate's verdict, twice over…
    expect(studyFailures(l).length).toBeGreaterThan(0);
    // …and the register stays silent rather than saying HELD about it.
    expect(claimNames(l, echoingSource)).not.toContain('Clinically studied');
  });

  it('a phrase the gate PERMITS is still a substantiation question, in both statuses', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Third-party and clinically tested for purity';
    });
    expect(studyFailures(l)).toEqual([]);
    expect(registerFor(l).find((r) => r.claim === 'Clinically studied')?.status).toBe('PENDING');
    const heldSource: ListingSnapshot = {
      ...baseSnapshot,
      description: `${baseSnapshot.description} Clinically tested for purity.`,
    };
    expect(registerFor(l, heldSource).find((r) => r.claim === 'Clinically studied')?.status).toBe('HELD');
  });

  it('the row keeps the surfaces whose hits are lawful and drops only the banned one', () => {
    const l = mut((x) => {
      x.bullets[1] = 'A clinically studied strain in every capsule';
      x.description = `${x.description} Clinically tested for purity.`;
    });
    const row = registerFor(l).find((r) => r.claim === 'Clinically studied');
    expect(row?.surface).toContain('description');
    expect(row?.surface).not.toContain('bullets[1]');
  });

  it.each([
    ['award-winning', 'An award-winning blend for adults', 'Award claim'],
    ['fda-approved', 'Made in an FDA-approved facility', 'Regulatory certification'],
  ])('the same rule covers %s — the other C19/register overlaps', (_label, payload, claim) => {
    const l = mut((x) => {
      x.bullets[1] = payload;
    });
    expect(c19ProhibitedMarketing(l, pack).filter((f) => f.field === 'bullets[1]').length)
      .toBeGreaterThan(0);
    expect(claimNames(l)).not.toContain(claim);
  });

  it('it is the GATE LEXICON that suppresses the row, not a literal in the audit', () => {
    const bare = clonePack(pack);
    bare.rules.prohibitedMarketing = { patterns: [], surfaces: [] };
    bare.compliancePack!.superlativeBans = [];
    const l = mut((x) => {
      x.bullets[1] = 'A clinically studied strain in every capsule';
    });
    // Nothing bans it any more, so the register goes back to asking about it.
    expect(
      buildSubstantiationRegister(l, baseSnapshot, bare).find((r) => r.claim === 'Clinically studied'),
    ).toBeTruthy();
  });

  it('a lawful trust claim is untouched by all of this', () => {
    expect(claimNames(clean)).toContain('Non-GMO');
    expect(registerFor(clean).find((r) => r.claim === 'Non-GMO')?.status).toBe('HELD');
  });

  it('no pack at all: the register is empty, never a throw', () => {
    expect(buildSubstantiationRegister(clean, baseSnapshot, null)).toEqual([]);
  });
});
