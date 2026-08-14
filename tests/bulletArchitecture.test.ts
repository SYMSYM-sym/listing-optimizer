import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { bulletArchitectureGaps } from '@/lib/audit/bulletLints';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { buildShipSheet } from '@/lib/export/shipSheet';
import { c25BulletClaimMarker, c9Allergen, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * WS4 — BULLET ARCHITECTURE, both directions for every rule.
 *
 * Every rule added by WS4 is tested in BOTH directions, because a rule tested
 * only on its violation is indistinguishable from a rule that fires on
 * everything: the compliant fixture must stay clean, and the specific defect
 * must be reported.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

/** Deliberately does NOT reconcile the claim flags — this suite sets them itself. */
const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const idsOf = (l: OptimizedListing, p: KnowledgePack = pack): string[] =>
  runGate(l, p, ctx).failures.map((f) => f.checkId);
const clonePack = (): KnowledgePack => JSON.parse(JSON.stringify(pack)) as KnowledgePack;

// ===========================================================================
// 1 — PACK DATA + PROMPT INJECTION
// ===========================================================================

describe('WS4 pack data: the bullet architecture is DATA, not code', () => {
  it('ships five slot jobs, each with a job, guidance and cues', () => {
    const slots = pack.rules.bulletArchitecture?.slots ?? [];
    expect(slots).toHaveLength(pack.rules.bulletCount);
    for (const slot of slots) {
      expect(slot.id).toMatch(/^B[1-5]$/);
      expect(slot.job.length).toBeGreaterThan(10);
      expect(slot.guidance.length).toBeGreaterThan(20);
      expect(slot.cues.length).toBeGreaterThan(0);
    }
  });

  it('states the distinct-anchor doctrine and the AM-3 trailing rule', () => {
    const arch = pack.rules.bulletArchitecture;
    expect(arch?.anchorRule).toBeTruthy();
    expect(arch?.allergenPosition?.mustTrail).toBe(true);
    expect(arch?.allergenPosition?.leadWindow).toBeGreaterThan(0);
  });

  it('the bullets prompt renders EVERY slot job, the anchor rule and the trailing rule', () => {
    const prompt = buildGroupPrompts(pack).bullets(snapshot, 'BrandX Probiotic');
    for (const slot of pack.rules.bulletArchitecture!.slots) {
      expect(prompt, `slot ${slot.id} injected`).toContain(slot.id);
      expect(prompt).toContain(slot.job);
    }
    expect(prompt).toContain(pack.rules.bulletArchitecture!.anchorRule);
    expect(prompt).toContain(pack.rules.bulletArchitecture!.allergenPosition!.rule);
  });

  it('a pack with NO architecture renders no architecture block (data-driven, not hard-coded)', () => {
    const bare = clonePack();
    delete bare.rules.bulletArchitecture;
    const prompt = buildGroupPrompts(bare).bullets(snapshot, 'BrandX Probiotic');
    expect(prompt).not.toContain('BULLET ARCHITECTURE');
    // …and the shipped pack DOES render it, so the assertion above is not vacuous.
    expect(buildGroupPrompts(pack).bullets(snapshot, '')).toContain('BULLET ARCHITECTURE');
  });
});

describe('R48 positioning anchor', () => {
  it('is injected into the title, bullets and description prompts', () => {
    const prompts = buildGroupPrompts(pack);
    const anchor = pack.rules.positioningAnchor!;
    for (const rendered of [
      prompts.title(snapshot),
      prompts.bullets(snapshot, ''),
      prompts.description(snapshot, ''),
    ]) {
      expect(rendered).toContain(anchor.id);
      expect(rendered).toContain(anchor.headline);
      expect(rendered).toContain(anchor.guidance[0]);
    }
  });

  it('is rendered as a strategy note in the ship-sheet HEADER, above section 1', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack });
    const at = html.indexOf(pack.rules.positioningAnchor!.sheetNote);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('1 · Title'));
  });

  it('a pack with no anchor renders no note (the sheet holds no strategy of its own)', () => {
    const bare = clonePack();
    delete bare.rules.positioningAnchor;
    const audit = buildAudit(snapshot, clean, bare, ctx);
    const html = buildShipSheet({ optimized: clean, audit, pack: bare });
    expect(html).not.toContain('class=strat');
  });
});

// ===========================================================================
// 2 — C25 CLAIM-MARKER DISCIPLINE (gated, one direction only)
// ===========================================================================

describe('C25 claim-marker discipline', () => {
  const marker = pack.rules.style.claimMarker!;

  it('optimize() carries the generator\'s claim flags onto the contract', () => {
    expect(Array.isArray(clean.bulletClaimBearing)).toBe(true);
    expect(clean.bulletClaimBearing).toHaveLength(clean.bullets.length);
    // The fixture really does contain both kinds, or the tests below are vacuous.
    expect(clean.bulletClaimBearing).toContain(true);
    expect(clean.bulletClaimBearing).toContain(false);
  });

  it('PASSES: the compliant fixture (every claim-bearing bullet carries the marker)', () => {
    expect(c25BulletClaimMarker(clean, pack)).toEqual([]);
    expect(idsOf(clean)).not.toContain('C25');
  });

  it('FAILS: a claim-bearing bullet emitted without the marker', () => {
    const i = clean.bulletClaimBearing!.indexOf(true);
    const l = mut((x) => {
      x.bullets[i] = x.bullets[i]!.replace(/\*$/, '');
    });
    const failures = c25BulletClaimMarker(l, pack);
    expect(failures.map((f) => f.field)).toEqual([`bullets[${i}]`]);
    expect(idsOf(l)).toContain('C25');
  });

  it('fires per bullet: two stripped markers are two failures', () => {
    const l = mut((x) => {
      x.bullets = x.bullets.map((b) => b.replace(/\*$/, ''));
    });
    const n = clean.bulletClaimBearing!.filter(Boolean).length;
    expect(c25BulletClaimMarker(l, pack)).toHaveLength(n);
  });

  it('does NOT fire the other way: a marker on a non-claim bullet is not a failure', () => {
    const i = clean.bulletClaimBearing!.indexOf(false);
    const l = mut((x) => {
      x.bullets[i] = `${x.bullets[i]}${marker}`;
    });
    expect(c25BulletClaimMarker(l, pack)).toEqual([]);
    // …it is an ADVISORY gap instead, so the over-disclosure is still visible.
    const gaps = bulletArchitectureGaps(l, pack);
    expect(gaps.some((g) => g.field === `bullets[${i}]` && g.severity === 'P2')).toBe(true);
  });

  it('has no rule to enforce when the listing carries no flags (stateless audit path)', () => {
    const l = mut((x) => {
      delete x.bulletClaimBearing;
      x.bullets[0] = x.bullets[0]!.replace(/\*$/, '');
    });
    expect(c25BulletClaimMarker(l, pack)).toEqual([]);
  });

  it('is PACK-DRIVEN: no declared marker, no rule (and the manifest then fails the pack closed)', () => {
    const noMarker = clonePack();
    delete noMarker.rules.style.claimMarker;
    const l = mut((x) => {
      x.bullets[0] = x.bullets[0]!.replace(/\*$/, '');
    });
    expect(c25BulletClaimMarker(l, noMarker)).toEqual([]);
    expect(idsOf(l, noMarker)).toContain('PACK');
  });

  it('never throws on malformed structural input', () => {
    const l = mut((x) => {
      (x.bullets as unknown as unknown[])[0] = 42;
    });
    expect(() => c25BulletClaimMarker(l, pack)).not.toThrow();
  });
});

// ===========================================================================
// 3 — AM-3 ALLERGEN POSITION (C9 unchanged; position is an audit lint)
// ===========================================================================

/** A listing carrying a declarable allergen, declared on all three surfaces. */
const withAllergen = (declarationBullet: string): OptimizedListing =>
  mut((x) => {
    x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin; Rice Flour';
    x.attributes.active_ingredients = 'Probiotic Blend';
    x.attributes.allergen_information = 'Contains: Soy';
    x.bullets[3] = declarationBullet;
    x.description = x.description.replace('Quality and safety:', 'Contains: Soy. Quality and safety:');
  });

const TRAILING_BULLET =
  'Quality you can verify: Third-party tested, Non-GMO and gluten free, manufactured in a cGMP facility in the USA; contains: Soy';
const LEADING_BULLET =
  'Contains: Soy. Third-party tested, Non-GMO and gluten free, manufactured in a cGMP facility in the USA';

describe('AM-3 allergen POSITION (lint) — the C9 triple declaration is untouched', () => {
  it('C9 still requires all three legs by default (attribute + description + bullet)', () => {
    const undeclared = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin; Rice Flour';
      x.attributes.allergen_information = 'No Known Allergens';
    });
    const fields = c9Allergen(undeclared, pack).map((f) => f.field);
    expect(fields).toContain('attributes.allergen_information');
    expect(fields).toContain('bullets');
    expect(fields).toContain('description');
  });

  it('C9 passes when the declaration TRAILS — position is never a gate failure', () => {
    const l = withAllergen(TRAILING_BULLET);
    expect(c9Allergen(l, pack)).toEqual([]);
    expect(bulletArchitectureGaps(l, pack).filter((g) => g.severity === 'P1')).toEqual([]);
  });

  it('C9 ALSO passes when the declaration LEADS — but the audit reports a P1 gap', () => {
    const l = withAllergen(LEADING_BULLET);
    expect(c9Allergen(l, pack)).toEqual([]); // the leg is satisfied: nothing is blocked
    const p1 = bulletArchitectureGaps(l, pack).filter((g) => g.severity === 'P1');
    expect(p1).toHaveLength(1);
    expect(p1[0]!.field).toBe('bullets[3]');
    expect(p1[0]!.why).toContain('AM-3');
  });

  it('the lint is switched off by pack data (mustTrail:false), not by code', () => {
    const off = clonePack();
    off.rules.bulletArchitecture!.allergenPosition!.mustTrail = false;
    const l = withAllergen(LEADING_BULLET);
    expect(bulletArchitectureGaps(l, off).filter((g) => g.severity === 'P1')).toEqual([]);
  });

  it('the OPERATOR OVERRIDE drops the bullet leg only, and ships DEFAULT OFF', () => {
    // Shipped default: every leg on.
    expect(pack.compliancePack!.allergenDeclarationSurfaces).toEqual({
      attribute: true,
      description: true,
      bullet: true,
    });
    const override = clonePack();
    override.compliancePack!.allergenDeclarationSurfaces = {
      attribute: true,
      description: true,
      bullet: false,
    };
    const noBulletDeclaration = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin; Rice Flour';
      x.attributes.active_ingredients = 'Probiotic Blend';
      x.attributes.allergen_information = 'Contains: Soy';
      x.description = x.description.replace('Quality and safety:', 'Contains: Soy. Quality and safety:');
    });
    // Default pack: the missing bullet leg is a failure…
    expect(c9Allergen(noBulletDeclaration, pack).map((f) => f.field)).toContain('bullets');
    // …with the override it is not, and the other two legs stay enforced.
    expect(c9Allergen(noBulletDeclaration, override)).toEqual([]);
    const attributeDropped = { ...noBulletDeclaration, attributes: { ...noBulletDeclaration.attributes, allergen_information: 'None' } };
    expect(c9Allergen(attributeDropped, override).map((f) => f.field)).toContain(
      'attributes.allergen_information',
    );
  });

  it('switching off the attribute or description leg fails the PACK closed', () => {
    for (const surfaces of [
      { attribute: false, description: true, bullet: true },
      { attribute: true, description: false, bullet: true },
    ]) {
      const bad = clonePack();
      bad.compliancePack!.allergenDeclarationSurfaces = surfaces;
      expect(idsOf(clean, bad)).toContain('PACK');
    }
  });
});

// ===========================================================================
// 4 — SLOT-JOB + ANCHOR LINTS (audit only, both directions)
// ===========================================================================

describe('slot-job and anchor lints are ADVISORY (P2) and both-directional', () => {
  it('the compliant fixture raises no bullet-architecture P2 gap', () => {
    const gaps = bulletArchitectureGaps(clean, pack);
    expect(gaps).toEqual([]);
  });

  it('reports an UNFILLED slot job (no cue vocabulary for that slot)', () => {
    const l = mut((x) => {
      x.bullets[3] = 'A bullet about nothing in particular for people who like reading words';
    });
    const gaps = bulletArchitectureGaps(l, pack);
    const gap = gaps.find((g) => g.field === 'bullets[3]');
    expect(gap?.severity).toBe('P2');
    expect(gap?.proposed).toContain('B4');
  });

  it('reports a REPEATED situational anchor', () => {
    const l = mut((x) => {
      x.bulletAnchors = ['same anchor', 'same anchor', 'c', 'd', 'e'];
    });
    const gaps = bulletArchitectureGaps(l, pack);
    expect(gaps.some((g) => g.field === 'bullets' && /share a situational anchor/.test(g.why))).toBe(true);
  });

  it('reports a MISSING situational anchor', () => {
    const l = mut((x) => {
      x.bulletAnchors = ['a', '', 'c', 'd', 'e'];
    });
    expect(
      bulletArchitectureGaps(l, pack).some((g) => /no situational anchor/.test(g.why)),
    ).toBe(true);
  });

  it('NONE of these lints can ever fail the gate', () => {
    const l = mut((x) => {
      x.bullets[3] = 'A bullet about nothing in particular for people who like reading words';
      x.bulletAnchors = ['same', 'same', 'same', 'same', 'same'];
    });
    expect(idsOf(l)).not.toContain('C25');
    const audit = buildAudit(snapshot, l, pack, ctx);
    expect(audit.gaps.some((g) => g.severity === 'P2')).toBe(true);
    expect(audit.verified).toBe(runGate(l, pack, ctx).pass);
  });
});
