import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { toMarkdown } from '@/lib/export/markdown';
import { aspectMatches, c29ImagePlanContent, c30ImageAltText, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS8 — the VISUAL PRODUCTION PACK: 8 slots + a video brief, ALT text, and the
 * two CONTENT checks (C29/C30).
 *
 * The point of C29 is that structural checks cannot see an empty brief. So the
 * suite is written the other way round from a normal "does it fail" suite: it
 * proves the golden briefs SATISFY each requirement, then removes each
 * requirement's wording one at a time and proves the check notices — and then
 * proves a brief that satisfies the requirement in a DIFFERENT accepted
 * spelling still passes, so the check is not a string-match on our fixture.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const clone = (): OptimizedListing => JSON.parse(JSON.stringify(clean)) as OptimizedListing;
const c29 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c29ImagePlanContent(l, p);
const c30 = (l: OptimizedListing, p: KnowledgePack = pack): Failure[] => c30ImageAltText(l, p);
const arch = () => pack.rules.imageArchitecture!;
const slotOf = (l: OptimizedListing, n: number) => l.imagePlan.find((s) => s.slot === n)!;

// ===========================================================================
// 1 — THE PLAN ITSELF
// ===========================================================================

describe('WS8 — 8 slots and a video brief', () => {
  it('the pack specifies 8 slots and the generator produces all 8', () => {
    expect(arch().slots).toHaveLength(8);
    expect(clean.imagePlan).toHaveLength(8);
    expect(clean.imagePlan.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('the video brief is produced, in the pack frame and inside the pack window', () => {
    const b = clean.videoBrief!;
    expect(b.aspect.toLowerCase()).toContain(arch().video.aspect.toLowerCase());
    expect(b.durationSeconds).toBeGreaterThanOrEqual(arch().video.minSeconds);
    expect(b.durationSeconds).toBeLessThanOrEqual(arch().video.maxSeconds);
    expect(b.shots.length).toBeGreaterThanOrEqual(3);
    expect(b.onScreenText.length).toBeGreaterThanOrEqual(2);
  });

  it('the golden plan passes both content checks and the whole gate', () => {
    expect(c29(clean)).toEqual([]);
    expect(c30(clean)).toEqual([]);
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });

  const MISSING: [string, (l: OptimizedListing) => void, string][] = [
    ['a dropped slot', (l) => { l.imagePlan = l.imagePlan.filter((s) => s.slot !== 6); }, 'imagePlan'],
    ['the whole video brief', (l) => { delete l.videoBrief; }, 'videoBrief'],
    ['a wide-frame brief', (l) => { l.videoBrief!.aspect = '16:9 landscape'; }, 'videoBrief.aspect'],
    ['an over-long brief', (l) => { l.videoBrief!.durationSeconds = 240; }, 'videoBrief.durationSeconds'],
    ['a too-short brief', (l) => { l.videoBrief!.durationSeconds = 3; }, 'videoBrief.durationSeconds'],
    ['an empty shot list', (l) => { l.videoBrief!.shots = []; }, 'videoBrief.shots'],
    ['no on-screen text', (l) => { l.videoBrief!.onScreenText = []; }, 'videoBrief.onScreenText'],
  ];

  it.each(MISSING)('FAILS: %s', (_label, apply, field) => {
    const l = clone();
    apply(l);
    const fs = c29(l);
    expect(fs.some((f) => f.field.startsWith(field))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });
});

// ===========================================================================
// 2 — C29 CONTENT: every required token group, both directions
// ===========================================================================

describe('C29 — each slot requirement is verified in the emitted brief', () => {
  const specced = () => arch().slots.filter((s) => (s.requiredTokens ?? []).length > 0);

  it('the pack specs the two slots that may never be AI-generated', () => {
    const slots = specced().map((s) => s.slot);
    expect(slots).toContain(1); // the main bottle photograph
    expect(slots).toContain(6); // the printed facts panel
  });

  /**
   * Removing ONE requirement's wording from a brief must be reported. The
   * removal is done by blanking the accepted spellings out of the brief, so
   * the test cannot pass by accident on a fixture that never said it.
   */
  it.each(
    arch()
      .slots.flatMap((s) => (s.requiredTokens ?? []).map((g) => [s.slot, g.label, g.anyOf] as [number, string, string[]])),
  )('FAILS: slot %s brief that never states "%s"', (slotNo, label, anyOf) => {
    const l = clone();
    const slot = slotOf(l, slotNo);
    for (const token of anyOf) {
      const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      slot.spec = slot.spec.replace(re, '');
      slot.notes = slot.notes.replace(re, '');
      slot.purpose = slot.purpose.replace(re, '');
    }
    const fs = c29(l);
    expect(fs.some((f) => f.context.includes(label))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  /** The other direction: a DIFFERENT accepted spelling still passes. */
  it.each(
    arch()
      .slots.flatMap((s) => (s.requiredTokens ?? []).map((g) => [s.slot, g.label, g.anyOf] as [number, string, string[]])),
  )('PASSES: slot %s stating "%s" in any accepted wording', (slotNo, label, anyOf) => {
    for (const spelling of anyOf) {
      const l = clone();
      const slot = slotOf(l, slotNo);
      // Wipe the brief and rebuild it from ONE spelling of each requirement.
      const groups = arch().slots.find((s) => s.slot === slotNo)!.requiredTokens!;
      slot.purpose = `slot ${slotNo}`;
      slot.notes = '';
      slot.spec = groups
        .map((g) => (g.label === label ? spelling : g.anyOf[0]!))
        .join('; ');
      expect(c29(l).some((f) => f.context.includes(label))).toBe(false);
    }
  });

  it('says WHICH requirement is missing and WHICH wordings satisfy it', () => {
    const l = clone();
    const slot = slotOf(l, 1);
    slot.spec = 'nice product shot, good lighting';
    slot.notes = '';
    const fs = c29(l);
    expect(fs.length).toBeGreaterThanOrEqual(3);
    for (const f of fs) {
      expect(f.checkId).toBe('C29');
      expect(f.fix).toContain('accepted wordings');
    }
  });

  it('a slot the pack gives NO tokens for is not content-checked (a floor, not a straitjacket)', () => {
    const unspecced = arch().slots.find((s) => (s.requiredTokens ?? []).length === 0)!;
    const l = clone();
    const slot = slotOf(l, unspecced.slot);
    slot.spec = 'anything at all, written however the brief writer likes';
    slot.notes = '';
    expect(c29(l).some((f) => f.field.includes(`slot ${unspecced.slot}`))).toBe(false);
  });

  it('reads the WHOLE card, not one field (the operator reads the card)', () => {
    const l = clone();
    const slot = slotOf(l, 1);
    const spec = slot.spec;
    slot.spec = '';
    slot.notes = spec;
    expect(c29(l).some((f) => f.field.includes('slot 1'))).toBe(false);
  });
});

// ===========================================================================
// 3 — C30 ALT TEXT
// ===========================================================================

describe('C30 — ALT text is written and within the cap', () => {
  it('every generated slot has ALT within the pack cap', () => {
    for (const slot of clean.imagePlan) {
      expect(slot.altText).toBeTruthy();
      expect(slot.altText!.length).toBeLessThanOrEqual(arch().altMax);
    }
    expect(c30(clean)).toEqual([]);
  });

  it.each([0, 3, 7])('FAILS: slot index %s with an over-long ALT', (i) => {
    const l = clone();
    l.imagePlan[i]!.altText = 'x'.repeat(arch().altMax + 1);
    const fs = c30(l);
    expect(fs.some((f) => f.field === `imagePlan[${i}].altText` && f.context.includes('chars'))).toBe(true);
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('PASSES at exactly the cap (the boundary is not off by one)', () => {
    const l = clone();
    l.imagePlan[0]!.altText = 'x'.repeat(arch().altMax);
    expect(c30(l).some((f) => f.field === 'imagePlan[0].altText')).toBe(false);
  });

  it.each(['', '   ', undefined])('FAILS: an unwritten ALT (%s)', (value) => {
    const l = clone();
    l.imagePlan[2]!.altText = value as string | undefined;
    expect(c30(l).some((f) => f.field === 'imagePlan[2].altText' && f.context === '(empty)')).toBe(true);
  });

  it('A+ banner ALT rides the same cap, and is OPTIONAL', () => {
    const l = clone();
    expect(l.aplusContent.modules.some((m) => m.bannerAltText)).toBe(true);
    expect(c30(l)).toEqual([]);
    // Optional: a module with no banner is not a failure.
    for (const m of l.aplusContent.modules) delete m.bannerAltText;
    expect(c30(l)).toEqual([]);
    // Present but over-length: failure.
    l.aplusContent.modules[0]!.bannerAltText = 'y'.repeat(arch().altMax + 1);
    expect(c30(l).some((f) => f.field === 'aplus.modules[0].bannerAltText')).toBe(true);
  });

  it('ALT text is a SCANNED customer surface, not just a measured one', () => {
    const l = clone();
    l.imagePlan[1]!.altText = 'Better than GreenLuxe, cures diabetes fast';
    const failures = runGate(l, pack, ctx).failures;
    expect(failures.some((f) => f.checkId === 'C6' && f.field.includes('altText'))).toBe(true);
  });

  it('the video brief on-screen text is scanned too', () => {
    const l = clone();
    l.videoBrief!.onScreenText = [...l.videoBrief!.onScreenText, 'Cures diabetes in eight weeks'];
    const failures = runGate(l, pack, ctx).failures;
    expect(failures.some((f) => f.checkId === 'C6' && f.field.includes('videoBrief'))).toBe(true);
  });
});

// ===========================================================================
// 4 — PACK INTEGRITY (emptying a piece must be BLOCKING, not a silent pass)
// ===========================================================================

describe('WS8 — pack integrity', () => {
  const PIECES: [string, (p: KnowledgePack) => void][] = [
    ['rules.imageArchitecture.slots', (p) => { p.rules.imageArchitecture!.slots = []; }],
    ['rules.imageArchitecture.slotTokens', (p) => { for (const s of p.rules.imageArchitecture!.slots) delete s.requiredTokens; }],
    ['rules.imageArchitecture.altMax', (p) => { p.rules.imageArchitecture!.altMax = 0; }],
    ['rules.imageArchitecture.video', (p) => { p.rules.imageArchitecture!.video = { aspect: '', minSeconds: 0, maxSeconds: 0, guidance: [] }; }],
  ];

  it.each(PIECES)('emptying %s raises a blocking PACK failure', (id, empty) => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    empty(p);
    const result = runGate(clean, p, ctx);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.checkId === 'PACK' && f.context.includes(id))).toBe(true);
  });
});

// ===========================================================================
// 5 — THE SHEET AND THE RECORD
// ===========================================================================

describe('WS8 — the sheet renders the visual pack and the A+ disclosures', () => {
  it('renders every slot with its ALT and a live character count', async () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack });
    expect(html).toContain('Visual production pack');
    for (const slot of clean.imagePlan) {
      expect(html).toContain(slot.purpose);
      expect(html).toContain(slot.altText!);
      expect(html).toContain(`${slot.altText!.length}/${arch().altMax}`);
    }
    expect(html).toContain('Video brief');
    expect(html).toContain(clean.videoBrief!.shots[0]!);
  });

  it('marks an over-long ALT in the sheet rather than printing it as fine', () => {
    const l = clone();
    l.imagePlan[0]!.altText = 'z'.repeat(arch().altMax + 5);
    const audit = buildAudit(snapshot, l, pack, ctx);
    const html = buildShipSheet({ optimized: l, audit, pack });
    expect(html).toContain(`${arch().altMax + 5}/${arch().altMax}`);
    expect(html).toContain('class="bad"');
  });

  it('renders all four A+ disclosures from pack data', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack });
    const notes = arch().aplusNotes!;
    for (const note of [notes.brandStoryCard, notes.bannerAlt, notes.carouselTrim, notes.premiumScope]) {
      expect(html).toContain(note.slice(0, 50).replace(/&/g, '&amp;'));
    }
    // The carousel-trim disclosure and the Premium scope statement, by topic.
    expect(notes.carouselTrim.toLowerCase()).toContain('trimmed');
    expect(notes.premiumScope.toLowerCase()).toContain('out of scope');
  });

  it('a pack with no A+ notes renders none (the sheet holds no doctrine of its own)', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete bare.rules.imageArchitecture!.aplusNotes;
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack: bare });
    expect(html).not.toContain(arch().aplusNotes!.carouselTrim.slice(0, 50));
  });

  it('the Markdown record carries the slots, the ALT and the brief', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const md = toMarkdown(clean, audit);
    expect(md).toContain('## Visual production pack');
    expect(md).toContain(clean.imagePlan[5]!.altText!);
    expect(md).toContain(`Video brief — ${clean.videoBrief!.aspect}`);
    expect(md).toContain('On-screen text');
  });
});

// ===========================================================================
// 7 — E1: THE C29 ASPECT FALSE POSITIVE (live, all three ASINs, every run)
// ===========================================================================

/**
 * THE LIVE FAILURE, verbatim:
 *
 *   C29 | videoBrief.aspect | context: "9:16"
 *        | fix: "The brief must be for a 9:16 vertical frame — a wide edit
 *                cropped down is a different shot"
 *
 * The emitted value IS the pack's frame. The check compared the whole pack
 * string ("9:16 vertical") as a SUBSTRING of a field whose entire content is
 * the ratio, so it demanded a prose word the field never carries and reported
 * a correct brief as the wrong shot on every run. Over-blocking a truthful
 * value is exactly as bad as accepting a false one: it trains the operator to
 * ignore C29, which is indistinguishable from not having it.
 *
 * Both directions, with the exact live value as the passing case.
 */
describe('C29 videoBrief.aspect — the ratio is the fact, the prose word is not', () => {
  const packAspect = () => arch().video.aspect;
  const aspectFailures = (value: unknown): Failure[] => {
    const l = clone();
    (l.videoBrief as { aspect: unknown }).aspect = value;
    return c29(l).filter((f) => f.field === 'videoBrief.aspect');
  };

  it('the pack states the frame as a ratio PLUS a prose word (this is the mismatch)', () => {
    expect(packAspect()).toContain('9:16');
    expect(packAspect()).not.toBe('9:16');
  });

  /** Every one of these states the pack's frame. */
  const ACCEPTED = [
    '9:16', // <- the exact live value that was being rejected
    '9:16 vertical',
    'vertical 9:16',
    '9:16 portrait, full-bleed',
    '9 : 16',
    '9:16 (1080x1920)',
  ];

  it.each(ACCEPTED)('PASSES: %s', (value) => {
    expect(aspectFailures(value)).toEqual([]);
  });

  /** And a genuinely wrong frame still fails — the check is not disarmed. */
  const REJECTED: [string, unknown][] = [
    ['a wide edit', '16:9'],
    ['a wide edit with prose', '16:9 landscape'],
    ['a square', '1:1'],
    ['a 4:5 feed crop', '4:5'],
    ['a wide edit cropped down', '16:9 cropped to 9:16'],
    ['the prose word alone, no ratio', 'vertical'],
    ['empty', ''],
    ['whitespace', '   '],
    ['null', null],
    ['a number', 916],
    ['the ratio inverted inside prose', 'shoot 16:9 and crop'],
  ];

  it.each(REJECTED)('FAILS: %s', (_label, value) => {
    expect(aspectFailures(value).length).toBeGreaterThan(0);
  });

  it('FAILS: the whole brief missing (the aspect leg is not the only one)', () => {
    const l = clone();
    delete l.videoBrief;
    expect(c29(l).some((f) => f.field === 'videoBrief')).toBe(true);
  });

  it('the pure predicate, both directions, against the pack value', () => {
    expect(aspectMatches('9:16', packAspect())).toBe(true);
    expect(aspectMatches(packAspect(), packAspect())).toBe(true);
    expect(aspectMatches('16:9', packAspect())).toBe(false);
    expect(aspectMatches('', packAspect())).toBe(false);
  });

  /**
   * A pack that spells its frame with NO ratio at all keeps the old
   * containment rule, so widening the check never silently unchecks a pack.
   */
  it('a ratio-free pack aspect still enforces containment, both directions', () => {
    expect(aspectMatches('shot in portrait throughout', 'portrait')).toBe(true);
    expect(aspectMatches('shot wide', 'portrait')).toBe(false);
  });

  it('the golden brief and the whole gate stay green', () => {
    expect(c29(clean)).toEqual([]);
    expect(runGate(clean, pack, ctx)).toEqual({ pass: true, failures: [] });
  });
});
