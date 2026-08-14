import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import {
  FIELD_TO_GROUP,
  NOT_REGENERABLE,
  fieldToGroup,
  routeFailure,
  unroutableFailures,
  type FieldRoutingTable,
} from '@/lib/engine/fieldRouting';
import { optimize } from '@/lib/engine/optimize';
import { runRepairLoop } from '@/lib/engine/repair';
import type { LlmClient } from '@/lib/engine/llm';
import { buildShipSheet } from '@/lib/export/shipSheet';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * THE REPAIR-ROUTING ORACLE — the crash-vs-detection idea applied to the loop
 * instead of to the gate.
 *
 * ============================================================================
 * THE LIVE DEFECT (B00EEEITVA)
 * ============================================================================
 * The run ended `verified:false` after the repair loop exhausted every round,
 * on two findings the model could trivially have fixed:
 *
 *   C10 | videoBrief.onScreenText[1]      | "15 Billion CFU per serving"
 *   A5  | aplus.modules[brand-story].body | "15 Billion CFUs per serving"
 *
 * `A5` was routed (`aplus*` → the aplus group) and would have been repaired.
 * `C10` was not: `FIELD_TO_GROUP` had rows for `imagePlan*` and `keywords*` and
 * NONE for `videoBrief*`. A failure the loop cannot attribute to a generation
 * group adds no group to the round, so the loop regenerated nothing that could
 * touch the video brief, burned its rounds, and reported a copy failure that
 * was actually a hole in a routing table.
 *
 * ============================================================================
 * WHY A TEST LIKE THIS AND NOT A LIST OF EXPECTED FIELDS
 * ============================================================================
 * A hand-written list of field names is exactly the artifact that went stale:
 * WS8/WS3/WS5/WS9 added `videoBrief`, `keywords`, `imagePlan[].altText`, A+
 * `bannerAltText` and the advisory registers, and only some of them were
 * routed. So this suite DERIVES the field set from the checks themselves: it
 * runs the FULL gate over a battery of deliberately-broken listings built to
 * fire every wired check, collects every `field` the gate actually emitted, and
 * asserts each one resolves — to an owning generation group, or to one of the
 * four DOCUMENTED non-regenerable classes in `lib/engine/fieldRouting.ts`.
 *
 * The battery's own completeness is asserted too (every id `runGate` wires must
 * appear at least once), so the oracle cannot silently stop covering a check.
 * And section 5 proves the oracle is not vacuous by deleting a routing row and
 * showing the same assertion fails, naming the field and the check.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const l = clone();
  fn(l);
  return l;
};

/** A pack that DECLARES a fiction phrase, so C11/A6 have a rule to enforce. */
const FICTION = 'legacy formulation claim';
const fictionPack = (): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
  p.compliancePack!.fictionPhrases = [FICTION];
  return p;
};

/** A pack whose style regexes cannot compile, so a check THROWS (id `GATE`). */
const brokenRegexPack = (): KnowledgePack => {
  const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
  p.rules.style.asinPattern = '([unclosed';
  p.rules.style.emojiPattern = '([unclosed';
  p.rules.style.htmlTagPattern = '([unclosed';
  return p;
};

// ===========================================================================
// 1 — THE BATTERY. One deliberately-broken listing per check family.
// ===========================================================================

interface BrokenCase {
  label: string;
  listing: () => OptimizedListing;
  pack?: () => KnowledgePack;
  ctx?: GateContext;
}

const BATTERY: BrokenCase[] = [
  // --- fail-closed pair -----------------------------------------------------
  {
    label: 'PACK: no detected subcategory, so the disease lexicon is empty',
    listing: clone,
    ctx: { subcategories: [], snapshotText: snapshot.title },
  },
  {
    label: 'GEN: a generation group degraded',
    listing: () => mut((l) => { l.degradedGroups = ['bullets', 'keywords']; }),
  },
  {
    label: 'GATE: a check throws because its pack regex will not compile',
    listing: clone,
    pack: brokenRegexPack,
  },

  // --- length / structure ---------------------------------------------------
  { label: 'C1: title far over the legacy cap', listing: () => mut((l) => { l.title = `${l.title} ${'lengthy tail '.repeat(30)}`; }) },
  { label: 'C1/C2/C4/C15: empty headline surfaces', listing: () => mut((l) => { l.title = ''; l.title75 = ''; l.itemHighlights = ''; l.description = ''; l.bullets = []; }) },
  { label: 'C2: wrong bullet count, one empty, one over-long', listing: () => mut((l) => { l.bullets = ['   ', `Header: ${'padding word '.repeat(40)}`]; l.bulletClaimBearing = [true, true]; }) },
  { label: 'C3: backend field empty', listing: () => mut((l) => { l.backendSearchTerms = ''; }) },
  { label: 'C3: backend field over the byte cap', listing: () => mut((l) => { l.backendSearchTerms = 'zzqq '.repeat(200); }) },
  { label: 'C4: description over the char cap', listing: () => mut((l) => { l.description = `${l.description} ${'more copy here '.repeat(200)}`; }) },
  { label: 'C15: title75 over cap and not led by the product name', listing: () => mut((l) => { l.title75 = `Zzz ${'tail '.repeat(30)}`; l.itemHighlights = 'x'.repeat(600); }) },
  { label: 'C16: backend repeats title words', listing: () => mut((l) => { l.backendSearchTerms = 'probiotic supplement capsules strains vegan'; }) },
  {
    label: 'C20: every required collection missing or empty',
    listing: () => mut((l) => {
      l.productName = '';
      l.primaryKeyword = '';
      l.attributes = {};
      l.qa = [];
      l.imagePlan = [];
      (l as unknown as Record<string, unknown>).facts = undefined;
    }),
  },
  { label: 'C20: one empty Q&A pair, one empty image slot, no A+ modules', listing: () => mut((l) => { l.qa[0] = { q: '', a: '', claimBearing: false }; l.imagePlan[0] = { ...l.imagePlan[0]!, purpose: '', spec: '' }; l.aplusContent.modules = []; l.aplusContent.faq = []; l.aplusContent.comparison = { rows: [] } as never; }) },

  // --- compliance -----------------------------------------------------------
  { label: 'C5: the disclaimer constant is wrong and the description drops it', listing: () => mut((l) => { l.fdaDisclaimer = 'Not evaluated by anyone.'; l.description = 'BrandX Probiotic is a shelf stable blend for adults.'; }) },
  { label: 'C6/C21/C22: banned nouns and a semantic drug claim in copy', listing: () => mut((l) => { l.bullets[0] = 'Relief support: eases diabetes and arthritis every day*'; l.description = `${l.description}\n\nStop taking your medication and switch to this routine. Relief from severe menopause symptoms every day.`; }) },
  { label: 'C7: a backend-only string leaks into customer copy and an attribute', listing: () => mut((l) => { l.backendSearchTerms = 'zorbulax probiotico acidophilus flora'; l.description = `Zorbulax daily capsules. ${l.description}`; l.attributes.subject_keyword = 'zorbulax daily'; }) },
  { label: 'C8: the product name leads nothing', listing: () => mut((l) => { l.productName = 'Unrelated Canonical Name'; }) },
  {
    label: 'C9/A7: a declarable allergen present and undeclared anywhere',
    listing: () => mut((l) => {
      l.attributes.ingredients = 'Probiotic Blend; Whey Protein Concentrate; Rice Flour';
      l.attributes.allergen_information = 'Free from major allergens per label';
    }),
  },
  {
    label: 'C10/A5: the headline potency attached to a single dose (THE LIVE SHAPE)',
    listing: () => mut((l) => {
      l.videoBrief!.onScreenText[1] = '15 Billion CFU per serving';
      l.videoBrief!.notes = 'The blend delivers 50 Billion CFU per serving on screen.';
      l.bullets[0] = 'Digestive balance: 50 Billion CFU per serving supports healthy gut flora*';
      l.qa[1] = { ...l.qa[1]!, a: 'The blend delivers 50 Billion CFU per serving.' };
      l.aplusContent.modules[0] = { ...l.aplusContent.modules[0]!, body: `${l.aplusContent.modules[0]!.body} It is 50 Billion CFU per serving.` };
      l.aplusContent.faq[0] = { ...l.aplusContent.faq[0]!, a: 'It provides 50 Billion CFU per serving.' };
      l.aplusContent.comparison.rows[0] = { ...l.aplusContent.comparison.rows[0]!, ours: '50 Billion CFU per serving' };
      l.imagePlan[1] = { ...l.imagePlan[1]!, notes: '50 Billion CFU per serving', altText: 'Infographic showing 50 Billion CFU per serving' };
    }),
  },
  {
    label: 'C11/A6: a pack-declared known-false descriptor resurfaces',
    pack: fictionPack,
    listing: () => mut((l) => {
      l.bullets[0] = `Quality first: this is a ${FICTION} you can rely on*`;
      l.description = `${l.description}\n\nA ${FICTION}.`;
      l.aplusContent.modules[1] = { ...l.aplusContent.modules[1]!, body: `A ${FICTION} in every batch. ${l.aplusContent.modules[1]!.body}` };
      l.attributes.product_benefit = `${FICTION}`;
      l.qa[0] = { ...l.qa[0]!, a: `It is a ${FICTION}.` };
    }),
  },
  {
    label: 'C12: unit figures that contradict the canonical facts',
    listing: () => mut((l) => {
      l.bullets[0] = 'Digestive balance: a 99 Billion CFU blend of 10 strains supports gut flora*';
      l.qa[1] = { ...l.qa[1]!, a: 'The blend delivers 99 Billion CFU across 10 strains.' };
      l.aplusContent.modules[1] = { ...l.aplusContent.modules[1]!, body: 'The hero blend is 99 Billion CFU with prebiotic fiber for adults every day.' };
      l.attributes.active_ingredients = 'Probiotic Blend (10 strains, 99 Billion CFU)';
      l.imagePlan[1] = { ...l.imagePlan[1]!, notes: '99 Billion CFU blend' };
      l.videoBrief!.onScreenText[0] = '99 Billion CFU blend, 10 strains';
    }),
  },
  {
    label: 'C17/C27: emoji, a symbol, raw markup, an ASIN and an AI tell',
    listing: () => mut((l) => {
      l.bullets[0] = 'Digestive balance 😀: SAVE $5 today <b>now</b> B0ABCDEFGH*';
      l.description = `${l.description}\n\nLook no further — delve into the realm of gut care — café.`;
      l.title = `${l.title} 😀`;
      l.aplusContent.modules[1] = { ...l.aplusContent.modules[1]!, headline: 'LOOK NO FURTHER 😀', body: `Elevate your routine. ${l.aplusContent.modules[1]!.body}` };
      l.qa[0] = { ...l.qa[0]!, a: 'Unlock the power of it 😀' };
      l.attributes.item_form = 'Capsule 😀';
      l.imagePlan[0] = { ...l.imagePlan[0]!, notes: 'Overlay: $5 off 😀' };
      l.backendSearchTerms = 'probiotico 😀 acidophilus';
    }),
  },
  {
    label: 'C18/C19/A8: price, contact details and superlatives everywhere',
    listing: () => mut((l) => {
      const bad = 'Only $19.95 with free shipping — the #1 best seller, doctor recommended. Email us at help@example.com.';
      l.bullets[1] = `Value first: ${bad}`;
      l.description = `${l.description}\n\n${bad}`;
      l.itemHighlights = bad;
      l.title = `${l.title} ${bad}`;
      l.title75 = `${l.title75} ${bad}`;
      l.qa[0] = { ...l.qa[0]!, q: bad, a: bad };
      l.attributes.product_benefit = bad;
      l.imagePlan[0] = { ...l.imagePlan[0]!, purpose: bad, spec: bad, notes: bad };
      l.aplusContent.modules[1] = { ...l.aplusContent.modules[1]!, headline: bad, body: `${bad} ${l.aplusContent.modules[1]!.body}` };
      l.aplusContent.faq[0] = { ...l.aplusContent.faq[0]!, q: bad, a: bad };
      l.aplusContent.comparison.rows[0] = { label: bad, ours: bad, typical: bad };
      l.backendSearchTerms = `${bad}`;
      l.facts = { ...l.facts, potency: bad } as never;
    }),
  },
  {
    label: 'C23/C24/C26: required attribute missing, a dosage attribute asserting a hero unit, active ingredients outside the label list',
    listing: () => mut((l) => {
      delete l.attributes.country_of_origin;
      l.attributes.item_form = 'Not A Listed Value';
      l.attributes.maximum_dosage = '50 Billion CFU';
      l.attributes.active_ingredients = 'Unicorn Horn Extract';
    }),
  },
  { label: 'C25/C31: a claim-bearing bullet without its marker, no colon header, a repeated word', listing: () => mut((l) => { l.bullets[0] = 'balance balance balance balance balance for balance every balance day'; l.bulletClaimBearing = [true, true, true, true, true]; }) },
  { label: 'C28: the keyword artifact is empty', listing: () => mut((l) => { l.keywords = []; }) },
  { label: 'C28: keyword rows that are wrong in every way a row can be wrong', listing: () => mut((l) => { l.keywords = [{ term: '', status: 'placed', surfaces: ['title'], why: '' }, { term: 'vegan', status: 'not-a-status', surfaces: ['nowhere'], why: '' }, { term: 'zzqqz', status: 'placed', surfaces: ['title'], why: 'declared but absent' }, { term: 'gut health', status: 'negative', surfaces: [], why: 'declared negative and present' }] as never; }) },

  // --- the visual pack ------------------------------------------------------
  {
    label: 'C29/C30: the video brief and the ALT strings are wrong (THE LIVE SURFACE)',
    listing: () => mut((l) => {
      l.videoBrief = { aspect: '16:9 landscape', durationSeconds: 240, shots: [], onScreenText: [], notes: '' };
      l.imagePlan = l.imagePlan.slice(0, 3).map((s) => ({ ...s, altText: '' }));
      l.aplusContent.modules[0] = { ...l.aplusContent.modules[0]!, bannerAltText: 'x'.repeat(400) };
    }),
  },
  { label: 'C29: the video brief is missing entirely', listing: () => mut((l) => { delete l.videoBrief; }) },

  // --- A+ -------------------------------------------------------------------
  {
    label: 'A1/A4/A9: A+ disclaimer wrong, name absent, no comparison rows, no audience cue',
    listing: () => mut((l) => {
      l.aplusContent.fdaDisclaimer = 'Not evaluated by anyone.';
      l.aplusContent.modules = l.aplusContent.modules.map((m) => ({ ...m, claimBearing: true, headline: 'A Headline Here', body: 'A body of copy that is long enough to satisfy the structural floor for a module body string.', subcopy: 'Subcopy line.' }));
      l.aplusContent.faq = l.aplusContent.faq.map((f) => ({ ...f, claimBearing: true, a: 'An answer with no disclaimer attached to it at all.' }));
      l.aplusContent.comparison = { rows: [] };
    }),
  },
  {
    label: 'A2/A3: a disease noun and a backend-only string inside A+ copy',
    listing: () => mut((l) => {
      l.backendSearchTerms = 'zorbulax probiotico acidophilus';
      l.aplusContent.modules[1] = { ...l.aplusContent.modules[1]!, body: 'Zorbulax eases diabetes and arthritis for adults every single day of the week.', subcopy: 'Zorbulax eases diabetes.' };
      l.aplusContent.faq[0] = { ...l.aplusContent.faq[0]!, a: 'Zorbulax eases arthritis.' };
      l.aplusContent.comparison.rows[0] = { label: 'Zorbulax', ours: 'eases diabetes', typical: 'eases arthritis' };
    }),
  },
];

interface Emitted {
  checkId: string;
  field: string;
  case: string;
}

const emitted: Emitted[] = [];

beforeAll(async () => {
  clean = clean ?? (await optimize(snapshot, pack, mockLlm));
  for (const c of BATTERY) {
    const failures: Failure[] = runGate(c.listing(), (c.pack ?? (() => pack))(), c.ctx ?? ctx).failures;
    for (const f of failures) emitted.push({ checkId: f.checkId, field: f.field, case: c.label });
  }
});

// ===========================================================================
// 2 — THE BATTERY IS COMPLETE: every id `runGate` wires actually fires.
// ===========================================================================

/** Every id `runGate` wires, read off the source (same derivation as census). */
const WIRED: string[] = [
  ...readFileSync(join(process.cwd(), 'lib/gate/runGate.ts'), 'utf8').matchAll(
    /guarded\(\s*'([A-Z0-9]+)'/g,
  ),
].map((m) => m[1]!);

describe('the routing oracle covers every check the gate wires', () => {
  it('the battery emits at least one failure', () => {
    expect(emitted.length).toBeGreaterThan(50);
  });

  it('every wired check id fires somewhere in the battery — plus the GATE boundary id', () => {
    const fired = new Set(emitted.map((e) => e.checkId));
    const missing = WIRED.filter((id) => !fired.has(id));
    expect(missing, `checks never exercised by the battery: ${missing.join(', ')}`).toEqual([]);
    // `GATE` is not wired — it is emitted BY the boundary. The battery reaches
    // it too, so a thrown check's field is routed like any other.
    expect(fired.has('GATE')).toBe(true);
  });

  it('the C family really is 29 checks and the A family really is 9', () => {
    expect(WIRED.filter((id) => /^C\d+$/.test(id))).toHaveLength(29);
    expect(WIRED.filter((id) => /^A\d+$/.test(id))).toHaveLength(9);
  });
});

// ===========================================================================
// 3 — THE ORACLE ITSELF: every emitted field resolves.
// ===========================================================================

/**
 * The assertion, factored out so section 5 can run the IDENTICAL logic against
 * a deliberately-damaged routing table. Returns the human-readable report of
 * every field that resolved to nothing, naming the check that emitted it.
 */
function unresolved(table: FieldRoutingTable): string[] {
  const seen = new Map<string, string>();
  for (const e of emitted) {
    if (routeFailure({ checkId: e.checkId, field: e.field, context: '', fix: '' }, table).kind !== 'unroutable') {
      continue;
    }
    seen.set(
      `${e.checkId}:${e.field}`,
      `field '${e.field}' emitted by check ${e.checkId} (case: ${e.case}) resolves to NO generation group and is not a documented non-regenerable class`,
    );
  }
  return [...seen.values()].sort();
}

describe('the routing oracle — every field the gate can emit resolves', () => {
  it('no emitted field is unroutable', () => {
    expect(unresolved(FIELD_TO_GROUP)).toEqual([]);
  });

  it('the live C10 field is among the fields the battery actually emitted', () => {
    expect(emitted.some((e) => e.checkId === 'C10' && e.field.startsWith('videoBrief.onScreenText['))).toBe(true);
  });

  it('every documented non-regenerable class is reached by the battery, so the exemptions are not dead weight', () => {
    const reached = new Set<string>();
    for (const e of emitted) {
      const r = routeFailure({ checkId: e.checkId, field: e.field, context: '', fix: '' });
      if (r.kind === 'not-regenerable') reached.add(r.id);
    }
    expect([...reached].sort()).toEqual(NOT_REGENERABLE.map((r) => r.id).sort());
  });

  it('every exemption states WHY, so an omission can never masquerade as a decision', () => {
    for (const row of NOT_REGENERABLE) expect(row.why.length).toBeGreaterThan(40);
  });
});

// ===========================================================================
// 4 — THE LIVE SHAPES, ROUTED
// ===========================================================================

describe('the B00EEEITVA fields route to the group that generates them', () => {
  const f = (checkId: string, field: string): Failure => ({ checkId, field, context: '', fix: '' });

  it('(a) C10 on videoBrief.onScreenText[i] routes to the IMAGES group — the group that emits the brief', () => {
    expect(fieldToGroup(f('C10', 'videoBrief.onScreenText[1]'))).toBe('images');
  });

  it('(a) every other videoBrief field C29 and the surface scan can emit routes there too', () => {
    for (const field of [
      'videoBrief',
      'videoBrief.aspect',
      'videoBrief.durationSeconds',
      'videoBrief.shots',
      'videoBrief.shots[0]',
      'videoBrief.onScreenText',
      'videoBrief.onScreenText[0]',
      'videoBrief.notes',
    ]) {
      expect(fieldToGroup(f('C29', field)), field).toBe('images');
    }
  });

  it('(b) A5 on aplus.modules[...].body was ALREADY routed — evidence, not assumption', () => {
    expect(fieldToGroup(f('A5', 'aplus.modules[brand-story].body'))).toBe('aplus');
    // ...and it was routed by a row that predates this change: the `aplus`
    // prefix row is in the table shipped at ac5da91.
    expect(FIELD_TO_GROUP.some((r) => r.match('aplus.modules[brand-story].body', 'A5'))).toBe(true);
  });
});

// ===========================================================================
// 5 — THE ORACLE IS NOT VACUOUS
// ===========================================================================

describe('the oracle FAILS when a routing row is deleted', () => {
  /** The shipped table minus the row that covers `videoBrief*`. */
  const withoutVideo: FieldRoutingTable = FIELD_TO_GROUP.filter(
    (r) => !r.match('videoBrief.onScreenText[0]', 'C10'),
  );

  it('deleting the videoBrief row really removes exactly one row', () => {
    expect(withoutVideo.length).toBe(FIELD_TO_GROUP.length - 1);
  });

  it('the same assertion then reports the field AND the check that emitted it', () => {
    const report = unresolved(withoutVideo);
    expect(report.length).toBeGreaterThan(0);
    expect(report.join('\n')).toContain('videoBrief.onScreenText[');
    expect(report.join('\n')).toMatch(/emitted by check C(10|29)/);
    // and it is genuinely the same assertion that passes on the real table
    expect(unresolved(FIELD_TO_GROUP)).toEqual([]);
  });

  it('deleting the imagePlan row is caught the same way, so the proof is not videoBrief-specific', () => {
    const withoutImages = FIELD_TO_GROUP.filter((r) => !r.match('imagePlan[0].notes', 'C6'));
    expect(withoutImages.length).toBe(FIELD_TO_GROUP.length - 1);
    expect(unresolved(withoutImages).join('\n')).toContain('imagePlan');
  });
});

// ===========================================================================
// 6 — (d) AN UNROUTABLE FIELD SURFACES, AND CANNOT YIELD verified:true
// ===========================================================================

describe('(d) an unroutable failure is reported, not dropped', () => {
  /** A field name nothing in the contract owns — the shape of a future WS. */
  const ORPHAN: Failure = {
    checkId: 'C99',
    field: 'someFutureArtifact.rows[0].text',
    context: 'x',
    fix: 'y',
  };

  it('the router says `unroutable`, distinctly from the documented exemptions', () => {
    expect(routeFailure(ORPHAN).kind).toBe('unroutable');
    expect(routeFailure({ checkId: 'PACK', field: 'compliance', context: '', fix: '' }).kind).toBe('not-regenerable');
    expect(routeFailure({ checkId: 'GEN', field: 'generation.bullets', context: '', fix: '' }).kind).toBe('not-regenerable');
    expect(routeFailure({ checkId: 'C5', field: 'fdaDisclaimer', context: '', fix: '' }).kind).toBe('not-regenerable');
    expect(routeFailure({ checkId: 'A1', field: 'aplus.fdaDisclaimer', context: '', fix: '' }).kind).toBe('not-regenerable');
  });

  it('`unroutableFailures` names it and deduplicates it', () => {
    expect(unroutableFailures([ORPHAN, ORPHAN, { checkId: 'C1', field: 'title', context: '', fix: '' }])).toEqual([
      { checkId: 'C99', field: 'someFutureArtifact.rows[0].text' },
    ]);
  });

  it('the AUDIT reports it as a distinct gap naming the field, and stays unverified', () => {
    // A real, failing listing: the gate produces the failures, the audit
    // derives the gaps from the SAME gate result `verified` comes from.
    const broken = mut((l) => { l.keywords = []; });
    const audit = buildAudit(snapshot, broken, pack, ctx);
    expect(audit.verified).toBe(false);
    expect(audit.verified).toBe(audit.gateResult.pass);

    // Now the orphan shape: an unroutable failure spliced into the same audit
    // payload shape the exporters read.
    const withOrphan = {
      ...audit,
      gateResult: { pass: false, failures: [...audit.gateResult.failures, ORPHAN] },
    };
    const gaps = unroutableFailures(withOrphan.gateResult.failures);
    expect(gaps).toEqual([{ checkId: 'C99', field: 'someFutureArtifact.rows[0].text' }]);

    const html = buildShipSheet({
      optimized: broken,
      audit: { ...withOrphan, routingGaps: gaps },
      pack,
      snapshot,
    });
    expect(html).toContain('Unroutable failure');
    expect(html).toContain('someFutureArtifact.rows[0].text');
    expect(html).toContain('NOT VERIFIED');
    // fail-closed: the copy buttons are still withheld
    expect(html).not.toContain('class=cp');
  });

  it('a CONVERGED run carries no routingGaps key at all, so a healthy payload is unchanged', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(audit.verified).toBe(true);
    expect('routingGaps' in audit).toBe(false);
  });
});

// ===========================================================================
// 7 — (a) THE LOOP ACTUALLY CONVERGES ON THE LIVE SHAPE
// ===========================================================================

/**
 * The live model wrote the headline potency as a per-dose claim in the video
 * brief and fixed it once the failure reached the images prompt. This stub
 * reproduces exactly that: the images group returns the bad on-screen string
 * first, and the corrected one as soon as the regeneration prompt carries the
 * C10 failure. Nothing else in the run changes.
 *
 * If `videoBrief.*` is unrouted, the images group is never regenerated, the
 * prompt never carries the failure, and this test hangs on `verified:false`
 * with the rounds exhausted — which is the live report, reproduced.
 */
const BAD_OVERLAY = '50 Billion CFU per serving';
const GOOD_OVERLAY = '50 Billion CFU blend';

function convergingLlm(): LlmClient & { imageCalls: () => number } {
  let imageCalls = 0;
  const llm = (async (req) => {
    const body = await mockLlm(req);
    if (!req.user.includes('image plan plus a')) return body;
    imageCalls++;
    // Round 1 writes the live defect. Later rounds fix it ONLY when the
    // regeneration prompt actually carried the C10 failure — which is the
    // thing routing is responsible for.
    const sawFailure = req.user.includes('[C10]') && req.user.includes('videoBrief.onScreenText');
    const overlay = sawFailure ? GOOD_OVERLAY : BAD_OVERLAY;
    const parsed = JSON.parse(body) as { videoBrief: { onScreenText: string[] } };
    parsed.videoBrief.onScreenText = [parsed.videoBrief.onScreenText[0]!, overlay, ...parsed.videoBrief.onScreenText.slice(2)];
    return JSON.stringify(parsed);
  }) as LlmClient & { imageCalls: () => number };
  llm.imageCalls = () => imageCalls;
  return llm;
}

describe('(a) the live C10 failure is repaired and the run converges', () => {
  it('round 1 reproduces the live finding: C10 on videoBrief.onScreenText[1]', async () => {
    const listing = await optimize(snapshot, pack, convergingLlm());
    expect(listing.videoBrief!.onScreenText[1]).toBe(BAD_OVERLAY);
    const ids = runGate(listing, pack, ctx).failures.map((f) => `${f.checkId}:${f.field}`);
    expect(ids).toContain('C10:videoBrief.onScreenText[1]');
  });

  it('the repair loop routes it, regenerates the images group and reaches verified:true', async () => {
    const llm = convergingLlm();
    const outcome = await runRepairLoop(snapshot, pack, llm, ctx, 3);
    expect(outcome.iterations).toBeGreaterThan(0);
    expect(outcome.gateResult.failures).toEqual([]);
    expect(outcome.gateResult.pass).toBe(true);
    expect(outcome.unroutable).toEqual([]);
    expect(outcome.listing.videoBrief!.onScreenText[1]).toBe(GOOD_OVERLAY);
    // The images group really was called again — the routing is what did it.
    expect(llm.imageCalls()).toBeGreaterThan(1);
    // ...and the audit agrees, because it re-runs the gate itself.
    const audit = buildAudit(snapshot, outcome.listing, pack, ctx);
    expect(audit.verified).toBe(true);
    expect('routingGaps' in audit).toBe(false);
  });

  it('THE OTHER DIRECTION: a model that keeps writing the per-dose phrasing still ends UNVERIFIED', async () => {
    // Routing makes a failure REPAIRABLE; it never makes one pass. This stub
    // regenerates the images group every round and writes the same defect back
    // each time, and the run still comes back `verified:false` with the C10
    // finding intact — so nothing here weakens C10.
    const blindLlm: LlmClient = async (req) => {
      const body = await mockLlm(req);
      if (!req.user.includes('image plan plus a')) return body;
      const parsed = JSON.parse(body) as { videoBrief: { onScreenText: string[] } };
      parsed.videoBrief.onScreenText = [parsed.videoBrief.onScreenText[0]!, BAD_OVERLAY, ...parsed.videoBrief.onScreenText.slice(2)];
      return JSON.stringify(parsed);
    };
    const outcome = await runRepairLoop(snapshot, pack, blindLlm, ctx, 2);
    expect(outcome.gateResult.pass).toBe(false);
    expect(outcome.gateResult.failures.map((f) => f.field)).toContain('videoBrief.onScreenText[1]');
    const audit = buildAudit(snapshot, outcome.listing, pack, ctx);
    expect(audit.verified).toBe(false);
    // The failure is a COPY failure, not a routing gap — the router owns it now.
    expect(audit.routingGaps).toBeUndefined();
    expect(outcome.unroutable).toEqual([]);
  });
});

// ===========================================================================
// 8 — (b) THE A+ HALF, AND THAT IT WAS ALREADY ROUTED
// ===========================================================================

const BAD_BODY = '50 Billion CFU per serving';
const GOOD_BODY = 'a 50 Billion CFU blend';

describe('(b) the A5 failure on aplus.modules[...].body routes and converges', () => {
  function aplusLlm(): LlmClient & { aplusCalls: () => number } {
    let aplusCalls = 0;
    const llm = (async (req) => {
      const body = await mockLlm(req);
      if (!req.user.includes('A+ content')) return body;
      aplusCalls++;
      const sawFailure = req.user.includes('[A5]') && req.user.includes('aplus.modules[');
      const parsed = JSON.parse(body) as { modules: { id: string; body: string }[] };
      parsed.modules[0]!.body = `${parsed.modules[0]!.body} It carries ${sawFailure ? GOOD_BODY : BAD_BODY}.`;
      return JSON.stringify(parsed);
    }) as LlmClient & { aplusCalls: () => number };
    llm.aplusCalls = () => aplusCalls;
    return llm;
  }

  it('round 1 reproduces the live finding on the brand-story body', async () => {
    const listing = await optimize(snapshot, pack, aplusLlm());
    const ids = runGate(listing, pack, ctx).failures.map((f) => `${f.checkId}:${f.field}`);
    expect(ids.some((i) => i.startsWith('A5:aplus.modules[') && i.endsWith('].body'))).toBe(true);
  });

  it('the loop repairs it in one round and the run verifies', async () => {
    const llm = aplusLlm();
    const outcome = await runRepairLoop(snapshot, pack, llm, ctx, 3);
    expect(outcome.gateResult.failures).toEqual([]);
    expect(outcome.gateResult.pass).toBe(true);
    expect(llm.aplusCalls()).toBeGreaterThan(1);
    expect(outcome.listing.aplusContent.modules[0]!.body).toContain(GOOD_BODY);
  });
});
