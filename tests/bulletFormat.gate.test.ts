import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { c31BulletFormat, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, KnowledgePack, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS10 — C31 BULLET FORMAT (R4 + R6), the BRAND-IDENTITY marker and the two
 * rendering notes.
 *
 * C31 is the check most at risk of over-blocking, because it fails a SHAPE
 * rather than a word: everything it rejects is otherwise lawful copy. So the
 * clean direction is tested at least as hard as the failing one, and the two
 * rules the playbook leaves unenforced (Title Case per word, numbers under ten
 * written out) are asserted to STAY unenforced — a check that cannot tell a
 * registered ingredient mark from shouting must not be written.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const withBullet = (text: string): OptimizedListing => {
  const l = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  l.bullets[1] = text;
  l.bulletClaimBearing = l.bullets.map((b) => b.trimEnd().endsWith('*'));
  return l;
};
const c31 = (l: OptimizedListing): Failure[] => c31BulletFormat(l, pack);
const onBullet1 = (l: OptimizedListing): Failure[] => c31(l).filter((f) => f.field === 'bullets[1]');
const fmt = () => pack.rules.bulletFormat!;

// ===========================================================================
// 1 — R6 COLON HEADER, both directions
// ===========================================================================

describe('C31 R6 — the documented colon-header bullet shape', () => {
  it('the golden bullets already carry it, so this is not a vacuous pass', () => {
    expect(c31(clean)).toEqual([]);
    for (const b of clean.bullets) {
      expect(b.indexOf(':')).toBeGreaterThan(0);
    }
  });

  const LAWFUL: string[] = [
    'Digestive balance: a blend that supports a steady daily routine',
    'Travel ready: shelf stable, so nothing has to go in a cool bag',
    'One a day: a simple habit that fits the morning without thinking about it',
    'Q&A: everything an adult buyer asks before the first bottle',
    'Made in the USA: produced under third-party audited process controls',
  ];
  it.each(LAWFUL)('PASSES: "%s"', (text) => {
    expect(onBullet1(withBullet(text))).toEqual([]);
  });

  const UNSHAPED: string[] = [
    'Shelf stable capsules need no refrigeration so your routine keeps working',
    'A blend that supports a steady daily routine for adults who travel often',
    'Supports digestive balance',
  ];
  it.each(UNSHAPED)('FAILS: no header at all — "%s"', (text) => {
    const fs = onBullet1(withBullet(text));
    expect(fs.length).toBeGreaterThan(0);
    expect(fs[0]!.checkId).toBe('C31');
    expect(runGate(withBullet(text), pack, ctx).pass).toBe(false);
  });

  it('FAILS: a colon that arrives too late to be a header', () => {
    const late = `${'a'.repeat(fmt().headerMaxChars + 5)}: body text after a very long lead`;
    expect(onBullet1(withBullet(`A${late}`)).length).toBeGreaterThan(0);
  });

  it('PASSES at exactly the header window (the boundary is not off by one)', () => {
    const header = 'A'.repeat(fmt().headerMaxChars - 1);
    const text = `${header}: body text that follows the header fragment`;
    expect(text.indexOf(':')).toBe(fmt().headerMaxChars - 1);
    expect(onBullet1(withBullet(text))).toEqual([]);
  });

  it('FAILS: a header fragment that is not real words', () => {
    expect(onBullet1(withBullet('12: sixty capsules per bottle at one a day')).length).toBeGreaterThan(0);
    expect(onBullet1(withBullet('  : sixty capsules per bottle at one a day')).length).toBeGreaterThan(0);
  });

  it('does NOT double-report an empty bullet — that is C2 failure, not a format one', () => {
    const l = withBullet('   ');
    expect(onBullet1(l)).toEqual([]);
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C2')).toBe(true);
  });

  it('subtracts the required disclaimer before judging the shape', () => {
    const disclaimer = pack.compliancePack!.disclaimer;
    const l = withBullet(`Gut support: supports a balanced routine* ${disclaimer}`);
    expect(onBullet1(l)).toEqual([]);
  });
});

// ===========================================================================
// 2 — R4 WORD REPETITION, both directions
// ===========================================================================

describe('C31 R4 — word repetition inside one bullet', () => {
  const max = () => fmt().wordRepetitionMax;

  it('the shipped cap is the STUFFING floor, and the golden copy sits at it', () => {
    // "One capsule daily: 60 vegetable capsules ... at one capsule per day" is
    // ordinary, correct copy that uses the dosage-form noun three times. The
    // cap exists to catch the FOURTH, not to rewrite that sentence.
    expect(max()).toBe(3);
    expect(c31(clean)).toEqual([]);
  });

  it('PASSES at exactly the cap', () => {
    const text = `Routine note: capsule and capsule and capsule in a single line of copy`;
    expect(onBullet1(withBullet(text))).toEqual([]);
  });

  it('FAILS one occurrence past the cap', () => {
    const text = `Routine note: capsule and capsule and capsule and capsule in a line`;
    const fs = onBullet1(withBullet(text));
    expect(fs.length).toBeGreaterThan(0);
    expect(fs[0]!.context).toContain('capsule');
    expect(runGate(withBullet(text), pack, ctx).pass).toBe(false);
  });

  it('counts SINGULAR and PLURAL as one word, exactly as C1 does on the title', () => {
    const text = 'Routine note: capsule, capsules, capsule and capsules in one line';
    expect(onBullet1(withBullet(text)).length).toBeGreaterThan(0);
  });

  it('does not count the pack stopwords', () => {
    const stop = fmt().stopwords[0]!;
    const text = `Routine note: ${stop} steady ${stop} simple ${stop} daily ${stop} habit ${stop} routine`;
    expect(onBullet1(withBullet(text)).some((f) => f.context.includes(`'${stop}'`))).toBe(false);
  });

  it('a stuffed bullet is caught even when its header is perfect', () => {
    const text = 'Probiotic support: probiotic blend with probiotic strains and probiotic fiber';
    expect(onBullet1(withBullet(text)).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3 — WHAT C31 DELIBERATELY DOES NOT ENFORCE
// ===========================================================================

describe('C31 — the two rules the playbook leaves unenforced STAY unenforced', () => {
  it('does not require Title Case per word (a registered mark keeps its own casing)', () => {
    const text = 'Quality you can verify: third-party tested in a cGMP facility with BioPerine and L-theanine';
    expect(onBullet1(withBullet(text))).toEqual([]);
  });

  it('does not require numbers under ten to be written out (measurements stay numeric)', () => {
    const text = 'Daily routine: 1 capsule a day, 2 months per bottle, 500 mg of the blend';
    expect(onBullet1(withBullet(text))).toEqual([]);
  });

  it('emptying the pack rules disables C31 and disarms nothing else', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete bare.rules.bulletFormat;
    expect(c31BulletFormat(withBullet('no header here at all in this bullet'), bare)).toEqual([]);
    // C31 is a FORMAT rule: it is correctly NOT a REQUIRED_PACK_PIECES row,
    // because emptying it cannot let a compliance violation through.
    const l = withBullet('CURES DIABETES: this treats diabetes*');
    expect(runGate(l, bare, ctx).failures.some((f) => f.checkId === 'C6')).toBe(true);
  });
});

// ===========================================================================
// 4 — BRAND IDENTITY (item 14) and the RENDERING NOTES (item 15)
// ===========================================================================

describe('WS10 — the scraped brand identity is marked for CONFIRMATION', () => {
  const sheetWith = (scraped: Record<string, string>): string => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const snap = { ...snapshot, attributes: scraped } as ListingSnapshot;
    return buildShipSheet({ optimized: clean, audit, pack, snapshot: snap });
  };

  it('renders the scraped value beside the proposed one, with the confirm marker', () => {
    const html = sheetWith({ brand_name: 'BrandX', manufacturer: 'BrandX Labs LLC' });
    expect(html).toContain('Scraped from the live page');
    expect(html).toContain(pack.rules.copySurfaceNotes!.brandConfirm.slice(0, 40));
    expect(html).toContain('CONFIRM');
  });

  it('flags a DISAGREEMENT between the scraped and the proposed brand', () => {
    const agreeing = sheetWith({ brand_name: clean.attributes.brand_name ?? 'BrandX' });
    expect(agreeing).not.toContain('This disagrees with the proposed value');
    const disagreeing = sheetWith({ brand_name: 'A Completely Different Brand' });
    expect(disagreeing).toContain('This disagrees with the proposed value');
  });

  it('says so when the scraped page carried no brand at all', () => {
    expect(sheetWith({})).toContain('not on the scraped page');
  });

  it('still states the backend-only rule', () => {
    expect(sheetWith({ brand_name: 'BrandX' })).toContain('backend only, never in customer copy');
  });

  it('a sheet built without a snapshot renders without throwing', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(() => buildShipSheet({ optimized: clean, audit, pack })).not.toThrow();
  });
});

describe('WS10 — R11 and R12 are printed beside the field they are about', () => {
  it('the description card carries both rendering notes', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack, snapshot });
    const notes = pack.rules.copySurfaceNotes!;
    const section = html.slice(html.indexOf('<h2>3 · Description'), html.indexOf('<h2>4 ·'));
    expect(section).toContain(notes.descriptionWithAplus.slice(0, 50));
    expect(section).toContain(notes.mobileFrontLoad.slice(0, 50));
  });

  it('R12 states the indexing fact and R11 the mobile one', () => {
    const notes = pack.rules.copySurfaceNotes!;
    expect(notes.descriptionWithAplus.toLowerCase()).toContain('not indexed');
    expect(notes.mobileFrontLoad.toLowerCase()).toContain('above the bullets');
    expect(notes.mobileFrontLoad.toLowerCase()).toContain('read more');
  });

  it('a pack with no rendering notes renders none', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    delete bare.rules.copySurfaceNotes;
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack: bare, snapshot });
    expect(html).not.toContain(pack.rules.copySurfaceNotes!.mobileFrontLoad.slice(0, 50));
  });
});

// ===========================================================================
// 5 — THE GATE BOUNDARY (a throwing check is a BLOCKING failure, not a crash)
// ===========================================================================

describe('WS10 — a check that throws becomes a blocking GATE failure', () => {
  it('a junk regex in the pack does not throw — it fails closed and NAMES the check', () => {
    const broken = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    broken.rules.style.asinPattern = '([unclosed';
    let result: ReturnType<typeof runGate> | null = null;
    expect(() => { result = runGate(clean, broken, ctx); }).not.toThrow();
    expect(result!.pass).toBe(false);
    const gateErrors = result!.failures.filter((f) => f.checkId === 'GATE');
    expect(gateErrors.length).toBeGreaterThan(0);
    expect(gateErrors[0]!.field).toMatch(/^C\d+$/);
    expect(gateErrors[0]!.fix).toContain('failure is in the gate, not in the copy');
  });

  it('one broken check does not blind the other thirty', () => {
    const broken = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    broken.rules.style.asinPattern = '([unclosed';
    const l = withBullet('CURES DIABETES: this treats diabetes*');
    const result = runGate(l, broken, ctx);
    expect(result.failures.some((f) => f.checkId === 'GATE')).toBe(true);
    // ...and the compliance failure is still reported.
    expect(result.failures.some((f) => f.checkId === 'C6')).toBe(true);
  });

  it('a clean run produces NO GATE failures — the boundary is not always-on noise', () => {
    expect(runGate(clean, pack, ctx).failures.filter((f) => f.checkId === 'GATE')).toEqual([]);
  });
});
