import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { brandParity } from '@/lib/audit/brandParity';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet } from '@/lib/export/shipSheet';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { ListingSnapshot, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * N3 — SNAPSHOT FIDELITY FOR BRAND IDENTITY (advisory, non-blocking)
 * ===========================================================================
 *
 * THE GAP. `runGate` never receives the source snapshot. Every identity check
 * it runs is internal-consistency only:
 *
 *   C7      brand leakage        backend strings vs the customer surfaces
 *   C8/C15  product-name lead    the titles vs `productName`
 *   A3/A4   A+ brand and name    the A+ copy vs `productName`
 *
 * A meta reviewer confirmed both halves of the consequence, and §1 reproduces
 * them: tamper with ONE field and those checks fire, because the listing then
 * disagrees with itself. Rename the whole listing CONSISTENTLY and every one of
 * them is silent — correctly, by their own rules — because the only thing that
 * could object is the page it was scraped from, and the gate cannot see it.
 *
 * WHY ADVISORY AND NOT A CHECK. A brand-name CORRECTION is a legitimate, common
 * use case: a stale, mis-cased or marketplace-mangled scraped value, a rebrand,
 * an acquisition, an operator running the optimizer on a listing they are about
 * to fix. No regeneration round can clear a disagreement the operator INTENDED,
 * so failing it would be an unwinnable run — the exact defect class this project
 * has been burned by. It is one P1 gap the operator must confirm, and the
 * verdict above it is untouched.
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
const snap = (fn: (s: ListingSnapshot) => void): ListingSnapshot => {
  const s = JSON.parse(JSON.stringify(snapshot)) as ListingSnapshot;
  fn(s);
  return s;
};

/** The scraped brand this fixture actually carries — asserted, not assumed. */
const SCRAPED_BRAND = snapshot.attributes.brand_name ?? '';

// ===========================================================================
// §1 — THE PREMISE, REPRODUCED: what the gate does and does not catch
// ===========================================================================

describe('§1 the premise — a CONSISTENT rename is invisible to every gate check', () => {
  it('the fixture carries a scraped brand and the proposal agrees with it', () => {
    expect(SCRAPED_BRAND.trim().length).toBeGreaterThan(0);
    expect(clean.attributes.brand_name).toBeTruthy();
    expect(brandParity(snapshot, clean)).toBeNull();
  });

  it('SINGLE-FIELD tampering IS caught — this is the half that already worked', () => {
    const oneField = mut((l) => { l.attributes.brand_name = 'GreenLuxe Naturals'; });
    const ids = runGate(oneField, pack, ctx).failures.map((f) => f.checkId);
    // it disagrees with `productName`, the titles and the A+ copy, so the
    // internal-consistency family objects
    expect(ids.length).toBeGreaterThan(0);
  });

  it('A CONSISTENT rename is NOT caught by the gate — the hole N3 fills', () => {
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    const result = runGate(renamed, pack, ctx);
    expect(
      result.failures.map((f) => `${f.checkId} ${f.field}`),
      'a consistent rename is self-consistent, so nothing in the gate objects',
    ).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('...and the ADVISORY does catch it, because it is the only thing holding the snapshot', () => {
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    const parity = brandParity(snapshot, renamed);
    expect(parity).not.toBeNull();
    expect(parity!.disagreements.map((d) => d.field)).toContain('brand_name');
  });
});

/** Rename the product everywhere a consistent tamperer would. */
function renameEverything(l: OptimizedListing, from: string, to: string): OptimizedListing {
  const sub = (v: unknown): string => String(v ?? '').split(from).join(to);
  l.productName = sub(l.productName);
  l.title = sub(l.title);
  l.title75 = sub(l.title75);
  l.itemHighlights = sub(l.itemHighlights);
  l.description = sub(l.description);
  l.bullets = l.bullets.map(sub);
  l.attributes = Object.fromEntries(
    Object.entries(l.attributes ?? {}).map(([k, v]) => [k, sub(v)]),
  );
  l.qa = (l.qa ?? []).map((q) => ({ ...q, q: sub(q.q), a: sub(q.a) }));
  l.imagePlan = (l.imagePlan ?? []).map((s) => ({
    ...s,
    purpose: sub(s.purpose),
    spec: sub(s.spec),
    notes: sub(s.notes),
    altText: sub(s.altText),
  }));
  l.aplusContent.modules = l.aplusContent.modules.map((m) => ({
    ...m,
    headline: sub(m.headline),
    body: sub(m.body),
    ...(m.subcopy ? { subcopy: sub(m.subcopy) } : {}),
    ...(m.bannerAltText ? { bannerAltText: sub(m.bannerAltText) } : {}),
  }));
  l.aplusContent.faq = l.aplusContent.faq.map((f) => ({ ...f, q: sub(f.q), a: sub(f.a) }));
  l.keywords = (l.keywords ?? []).map((k) => ({ ...k, term: sub(k.term) }));
  return l;
}

// ===========================================================================
// §2 — BOTH DIRECTIONS on the advisory itself
// ===========================================================================

describe('§2 agreement produces NO gap', () => {
  it('identical values agree', () => {
    const l = mut((x) => { x.attributes.brand_name = SCRAPED_BRAND; });
    expect(brandParity(snapshot, l)).toBeNull();
  });

  it('agreement uses the app\'s ONE definition of brand equality (identityKey)', () => {
    for (const variant of [
      SCRAPED_BRAND.toLowerCase(),
      SCRAPED_BRAND.toUpperCase(),
      `  ${SCRAPED_BRAND}  `,
      `${SCRAPED_BRAND},`,
      `${SCRAPED_BRAND}.`,
    ]) {
      const l = mut((x) => { x.attributes.brand_name = variant; });
      expect(brandParity(snapshot, l), variant).toBeNull();
    }
  });

  it('punctuation and legal-suffix formatting agree, exactly as they do for the rival set', () => {
    const s = snap((x) => { x.attributes.brand_name = 'BrandX Labs, LLC.'; });
    const l = mut((x) => { x.attributes.brand_name = 'brandx labs llc'; });
    expect(brandParity(s, l)).toBeNull();
  });

  it('the shipped fixture produces no gap and no audit key at all', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect('brandParity' in audit).toBe(false);
    expect(audit.gaps.filter((g) => /brand identity/i.test(g.why))).toEqual([]);
    expect(audit.verified).toBe(true);
  });
});

describe('§2 disagreement produces EXACTLY ONE clearly-worded gap', () => {
  it('a renamed brand_name yields one gap, at P1, naming both values', () => {
    const l = mut((x) => { x.attributes.brand_name = 'GreenLuxe Naturals'; });
    const audit = buildAudit(snapshot, l, pack, ctx);
    const hits = audit.gaps.filter((g) => /brand identity/i.test(g.why));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('P1');
    expect(hits[0]!.current).toContain(SCRAPED_BRAND);
    expect(hits[0]!.proposed).toContain('GreenLuxe Naturals');
  });

  it('the wording tells the operator what to DO and why no check can decide it', () => {
    const l = mut((x) => { x.attributes.brand_name = 'GreenLuxe Naturals'; });
    const why = buildAudit(snapshot, l, pack, ctx).gaps.find((g) => /brand identity/i.test(g.why))!.why;
    expect(why).toMatch(/CONFIRM/);
    expect(why).toMatch(/never sees the source page/i);
    expect(why).toMatch(/correcting the brand on purpose/i);
    expect(why).toMatch(/someone else's brand/i);
  });

  it('BOTH fields renamed is still exactly ONE gap — a rename is one event', () => {
    const s = snap((x) => { x.attributes.manufacturer = 'BrandX Labs'; });
    const l = mut((x) => {
      x.attributes.brand_name = 'GreenLuxe Naturals';
      x.attributes.manufacturer = 'GreenLuxe Labs';
    });
    const audit = buildAudit(s, l, pack, ctx);
    const hits = audit.gaps.filter((g) => /brand identity/i.test(g.why));
    expect(hits).toHaveLength(1);
    expect(audit.brandParity!.disagreements.map((d) => d.field)).toEqual([
      'brand_name',
      'manufacturer',
    ]);
    expect(hits[0]!.why).toContain('brand_name');
    expect(hits[0]!.why).toContain('manufacturer');
  });

  it('a `manufacturer`-only disagreement is reported on its own', () => {
    const s = snap((x) => { x.attributes.manufacturer = 'BrandX Labs'; });
    const l = mut((x) => { x.attributes.manufacturer = 'GreenLuxe Labs'; });
    const parity = brandParity(s, l);
    expect(parity!.disagreements.map((d) => d.field)).toEqual(['manufacturer']);
  });
});

// ===========================================================================
// §3 — IT IS ADVISORY. This is the half that must not regress.
// ===========================================================================

describe('§3 advisory, never blocking', () => {
  it('a disagreeing run is STILL verified — a brand correction is a real use case', () => {
    const l = mut((x) => { x.attributes.brand_name = 'GreenLuxe Naturals'; });
    const audit = buildAudit(snapshot, l, pack, ctx);
    // C7/C8/C15/A3/A4 fire here because ONE field moved; strip that noise by
    // renaming consistently, which is the case the advisory actually exists for
    const consistent = renameEverything(clone(), 'BrandX', 'NovaCo');
    const consistentAudit = buildAudit(snapshot, consistent, pack, ctx);
    expect(consistentAudit.gateResult.failures).toEqual([]);
    expect(consistentAudit.verified).toBe(true);
    expect(consistentAudit.brandParity).toBeDefined();
    // ...and `verified` is still exactly the gate verdict, unchanged by this
    expect(consistentAudit.verified).toBe(consistentAudit.gateResult.pass);
    // the single-field case is unverified for the OTHER checks' reasons, not this one
    expect(audit.gateResult.failures.every((f) => f.checkId !== 'BRAND')).toBe(true);
  });

  it('it emits no gate failure of its own, on any listing', () => {
    const consistent = renameEverything(clone(), 'BrandX', 'NovaCo');
    const ids = new Set(runGate(consistent, pack, ctx).failures.map((f) => f.checkId));
    expect(ids.size).toBe(0);
  });
});

// ===========================================================================
// §4 — THE BOUNDS: silence where silence is correct, and never a throw
// ===========================================================================

describe('§4 bounds', () => {
  it('a snapshot MISSING both brand fields produces no gap and never throws', () => {
    const bare = snap((s) => {
      delete s.attributes.brand_name;
      delete s.attributes.manufacturer;
    });
    expect(() => brandParity(bare, clean)).not.toThrow();
    expect(brandParity(bare, clean)).toBeNull();
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    expect(brandParity(bare, renamed)).toBeNull();
    const audit = buildAudit(bare, renamed, pack, ctx);
    expect('brandParity' in audit).toBe(false);
    expect(audit.gaps.filter((g) => /brand identity/i.test(g.why))).toEqual([]);
  });

  it('a snapshot with NO attributes object at all is handled', () => {
    const none = snap((s) => { (s as { attributes?: unknown }).attributes = undefined; });
    expect(() => brandParity(none, clean)).not.toThrow();
    expect(brandParity(none, clean)).toBeNull();
  });

  it('null/undefined on either side never throws', () => {
    expect(brandParity(null, null)).toBeNull();
    expect(brandParity(undefined, undefined)).toBeNull();
    expect(brandParity(snapshot, null)).toBeNull();
    expect(brandParity(null, clean)).toBeNull();
  });

  it('a BLANK proposed value is "missing", not "different" — C23 owns the blank', () => {
    for (const blank of ['', '   ']) {
      const l = mut((x) => { x.attributes.brand_name = blank; });
      expect(brandParity(snapshot, l), JSON.stringify(blank)).toBeNull();
    }
  });

  it('a BLANK scraped value is nothing to compare against', () => {
    const s = snap((x) => { x.attributes.brand_name = '   '; });
    const l = mut((x) => { x.attributes.brand_name = 'GreenLuxe Naturals'; });
    expect(brandParity(s, l)).toBeNull();
  });

  it('only the TWO structural fields are read — the title is deliberately not mined', () => {
    const s = snap((x) => { x.title = 'GreenLuxe Naturals Probiotic 50 Billion CFU'; });
    // titles disagree wildly, brand fields agree -> silence
    expect(brandParity(s, clean)).toBeNull();
  });

  it('a non-brand attribute changing is not a brand disagreement', () => {
    const l = mut((x) => { x.attributes.item_form = 'Softgel'; });
    expect(brandParity(snapshot, l)).toBeNull();
  });
});

// ===========================================================================
// §5 — THE SHIP SHEET
// ===========================================================================

describe('§5 the ship sheet surfaces it as a confirm-before-publish P1', () => {
  const sheetFor = (l: OptimizedListing, s: ListingSnapshot = snapshot): string =>
    buildShipSheet({ optimized: l, audit: buildAudit(s, l, pack, ctx), pack, snapshot: s });

  it('a disagreement is printed, naming both values and the field', () => {
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    const html = sheetFor(renamed);
    expect(html).toContain('CONFIRM THE BRAND BEFORE YOU PUBLISH');
    expect(html).toContain('brand_name');
    expect(html).toContain('NovaCo');
    expect(html).toContain(SCRAPED_BRAND);
    expect(html).toContain('P1');
  });

  it('it is printed EVEN ON A VERIFIED RUN — that is the case nobody would look for it', () => {
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    const audit = buildAudit(snapshot, renamed, pack, ctx);
    expect(audit.verified).toBe(true);
    const html = sheetFor(renamed);
    // the verdict is untouched: the sheet still says verified and still offers copy
    expect(html).toContain('Verified for publish');
    expect(html).toContain('CONFIRM THE BRAND BEFORE YOU PUBLISH');
    expect(html).toContain('does not change the verdict');
  });

  it('an AGREEING run prints nothing about it at all', () => {
    const html = sheetFor(clean);
    expect(html).not.toContain('CONFIRM THE BRAND BEFORE YOU PUBLISH');
  });

  it('a snapshot with no brand fields prints nothing and does not throw', () => {
    const bare = snap((s) => {
      delete s.attributes.brand_name;
      delete s.attributes.manufacturer;
    });
    const renamed = renameEverything(clone(), 'BrandX', 'NovaCo');
    expect(() => sheetFor(renamed, bare)).not.toThrow();
    expect(sheetFor(renamed, bare)).not.toContain('CONFIRM THE BRAND BEFORE YOU PUBLISH');
  });

  it('the values are HTML-escaped, like every other operator string on the sheet', () => {
    const s = snap((x) => { x.attributes.brand_name = 'BrandX <b>Labs</b>'; });
    const l = mut((x) => { x.attributes.brand_name = 'GreenLuxe & Co'; });
    const html = buildShipSheet({
      optimized: l,
      audit: buildAudit(s, l, pack, ctx),
      pack,
      snapshot: s,
    });
    expect(html).toContain('GreenLuxe &amp; Co');
    expect(html).not.toContain('BrandX <b>Labs</b>');
  });
});
