import { beforeAll, describe, expect, it } from 'vitest';
import { attributeSchemaStaleness } from '@/lib/audit/staleness';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { c23AttributeCompleteness, type GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { loadPack, type PackId } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import supplementsSchemaJson from '@/knowledge/attribute-schema.supplements.json';
import cosmeticsSchemaJson from '@/knowledge/attribute-schema.cosmetics.json';
import type { AttributeSchemaFile, KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import { withCoherentBulletFlags } from './fixtures/coherentBullets';

/**
 * WS2 — ATTRIBUTE DISCIPLINE.
 *
 * The point of WS2 is not "more attributes"; it is knowing WHO OWNS each one,
 * which values are closed, and when the template was last checked. Each of
 * those has a failure mode the old bare-array schema could not express:
 *
 *  - no `source` ⇒ the generator was asked for a PRICE and duly invented one;
 *  - no `enum`   ⇒ an out-of-set value passed the gate and the marketplace
 *                  rejected the feed, suppressing the listing;
 *  - no date     ⇒ nothing recorded when the template was last verified.
 */

const PACKS: PackId[] = ['supplements', 'cosmetics'];
const SCHEMA_FILES: [string, AttributeSchemaFile][] = [
  ['supplements', supplementsSchemaJson as unknown as AttributeSchemaFile],
  ['cosmetics', cosmeticsSchemaJson as unknown as AttributeSchemaFile],
];

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  // Keep the parallel claim-bearing flags coherent with the rewritten text.
  return withCoherentBulletFlags(copy);
};
const c23 = (l: OptimizedListing, p: KnowledgePack = pack) =>
  c23AttributeCompleteness(l, p);

// ---------------------------------------------------------------------------
// Shape + source
// ---------------------------------------------------------------------------

describe('schema files are DATED SNAPSHOTS, not bare lists', () => {
  it.each(SCHEMA_FILES)('%s ships { verifiedAsOf, staleAfterDays, fields[] }', (_id, file) => {
    expect(Array.isArray(file)).toBe(false);
    expect(file.verifiedAsOf).toBe('2026-08-14');
    expect(file.staleAfterDays).toBe(180);
    expect(Array.isArray(file.fields)).toBe(true);
    expect(file.fields.length).toBeGreaterThan(0);
  });

  it.each(PACKS)('%s pack exposes the fields AND the meta', (id) => {
    const p = loadPack(id);
    expect(p.attributeSchema.length).toBeGreaterThan(0);
    expect(p.attributeSchemaMeta?.verifiedAsOf).toBe('2026-08-14');
    expect(p.attributeSchemaMeta?.staleAfterDays).toBe(180);
  });
});

describe('every field declares a valid source', () => {
  it.each(PACKS)('%s: source is exactly generated | operator', (id) => {
    for (const f of loadPack(id).attributeSchema) {
      expect(['generated', 'operator'], `${f.field}`).toContain(f.source);
    }
  });

  /**
   * AC-G4(a) — `launch_date` joined this set. WS2.1 named a launch date
   * alongside price/GTIN/SKU and the schema had no field for it; it is an OFFER
   * fact the app cannot read from a detail page, so it gets the SAME treatment
   * as the other four rather than a new mechanism. The list is asserted by
   * EQUALITY so a sixth cannot be added without this line changing.
   */
  it('the operator-owned set is the six seller-account facts', () => {
    const operator = pack.attributeSchema.filter((f) => f.source === 'operator').map((f) => f.field);
    expect(operator.sort()).toEqual(
      [
        'condition_type',
        'external_product_id',
        'item_sku',
        'launch_date',
        'model_number',
        'standard_price',
      ].sort(),
    );
  });

  it('AC-G4(a): launch_date is operator-owned, exempt from C23, and never generated', () => {
    const f = pack.attributeSchema.find((x) => x.field === 'launch_date');
    expect(f, 'launch_date is missing from the schema').toBeDefined();
    expect(f!.source).toBe('operator');
    expect(f!.required).toBe(false);
    expect(f!.filterFacet).toBe(false);
    // C23 never asks for it...
    const l = mut((x) => { delete x.attributes.launch_date; });
    expect(c23(l).some((x) => x.field === 'attributes.launch_date')).toBe(false);
    // ...and the attributes prompt does not offer it to the model (built the
    // same way the R2 suite below builds it).
    const schemaFields = pack.attributeSchema
      .filter((x) => x.source !== 'operator')
      .map((x) => `${x.field} | ${x.required ? 'required' : 'optional'} | ${x.example}`)
      .join('\n');
    expect(buildGroupPrompts(pack, 'dual').attributes(snapshot, schemaFields)).not.toContain(
      'launch_date',
    );
  });

  it('every operator field is required:false and filterFacet:false', () => {
    for (const f of pack.attributeSchema.filter((x) => x.source === 'operator')) {
      expect(f.required, f.field).toBe(false);
      expect(f.filterFacet, f.field).toBe(false);
    }
  });

  it('a field with no declared source reads as generated (the stricter side)', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    const priced = p.attributeSchema.find((f) => f.field === 'standard_price')!;
    delete priced.source;
    priced.required = true;
    const l = mut((x) => {
      delete x.attributes.standard_price;
    });
    expect(c23(l, p).some((f) => f.field === 'attributes.standard_price')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R2 — operator exemption + "stop inventing price"
// ---------------------------------------------------------------------------

describe('R2 — operator fields are exempt from C23 and never generated', () => {
  it('C23 never fails for a missing operator field, even a required/facet one', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    for (const f of p.attributeSchema) {
      if (f.source === 'operator') {
        f.required = true;
        f.filterFacet = true;
      }
    }
    const l = mut((x) => {
      for (const f of p.attributeSchema) if (f.source === 'operator') delete x.attributes[f.field];
    });
    expect(c23(l, p)).toEqual([]);
  });

  it('the attributes PROMPT hides every operator field and says a class is withheld', () => {
    const prompts = buildGroupPrompts(pack, 'dual');
    const schemaFields = pack.attributeSchema
      .filter((f) => f.source !== 'operator')
      .map((f) => `${f.field} | ${f.required ? 'required' : 'optional'} | ${f.example}`)
      .join('\n');
    const text = prompts.attributes(snapshot, schemaFields);
    for (const f of pack.attributeSchema.filter((x) => x.source === 'operator')) {
      expect(text, `prompt must not list ${f.field}`).not.toContain(f.field);
    }
    for (const f of pack.attributeSchema.filter((x) => x.source !== 'operator')) {
      expect(text, `prompt must list ${f.field}`).toContain(f.field);
    }
    expect(text).toContain('DELIBERATELY INCOMPLETE');
    expect(text).toContain('owned by the seller account');
  });

  it('optimize DELETES an operator key the model volunteered anyway', () => {
    // The shipped mock volunteers standard_price; it must not survive.
    expect(clean.attributes.standard_price).toBeUndefined();
    expect(runGate(clean, pack, ctx).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3 — enums
// ---------------------------------------------------------------------------

describe('R3 — enum validation', () => {
  it('INVARIANT: valueType === enum ⟺ non-empty enum, in every pack', () => {
    for (const id of PACKS) {
      for (const f of loadPack(id).attributeSchema) {
        const hasSet = Array.isArray(f.enum) && f.enum.length > 0;
        expect(hasSet, `${id}/${f.field}: valueType=${f.valueType} enum=${JSON.stringify(f.enum)}`).toBe(
          f.valueType === 'enum',
        );
      }
    }
  });

  it('the three closed sets are exactly the ones we accepted', () => {
    const byField = Object.fromEntries(pack.attributeSchema.map((f) => [f.field, f.enum]));
    expect(byField.target_gender).toEqual(['Unisex', 'Male', 'Female']);
    expect(byField.fulfillment_channel).toEqual(['FBA', 'FBM']);
    expect(byField.condition_type).toEqual(['New', 'Used', 'Refurbished', 'Collectible']);
  });

  it('the DECLINED enums carry no value set (an over-tight enum blocks lawful values)', () => {
    for (const field of ['item_form', 'unit_count_type', 'age_range_description']) {
      const f = pack.attributeSchema.find((x) => x.field === field)!;
      expect(f.valueType, field).not.toBe('enum');
      expect(f.enum, field).toBeUndefined();
    }
    // …and the reason is written down, not folklore.
    const declined = (supplementsSchemaJson as unknown as { _declinedEnums: Record<string, string> })
      ._declinedEnums;
    for (const field of ['item_form', 'unit_count_type', 'age_range_description']) {
      expect(declined[field], `decline reason for ${field}`).toBeTruthy();
    }
  });

  it('a value outside a closed set FAILS C23', () => {
    const l = mut((x) => {
      x.attributes.target_gender = 'Everyone';
    });
    const f = c23(l).filter((x) => x.field === 'attributes.target_gender');
    expect(f.length).toBe(1);
    expect(f[0]!.checkId).toBe('C23');
    expect(f[0]!.fix).toContain('Unisex | Male | Female');
    expect(runGate(l, pack, ctx).pass).toBe(false);
  });

  it('every enum field is checked, not just the first', () => {
    const l = mut((x) => {
      x.attributes.fulfillment_channel = 'SFP';
    });
    expect(c23(l).some((f) => f.field === 'attributes.fulfillment_channel')).toBe(true);
  });

  it('an in-set value passes, case-insensitively (marketplace enums are not case-sensitive)', () => {
    const l = mut((x) => {
      x.attributes.target_gender = 'unisex';
    });
    expect(c23(l).filter((f) => f.field === 'attributes.target_gender')).toEqual([]);
  });

  it('an operator field is still enum-checked when the operator DID fill it', () => {
    const l = mut((x) => {
      x.attributes.condition_type = 'Slightly Used';
    });
    expect(c23(l).some((f) => f.field === 'attributes.condition_type')).toBe(true);
    const ok = mut((x) => {
      x.attributes.condition_type = 'New';
    });
    expect(ok.attributes.condition_type).toBe('New');
    expect(c23(ok).filter((f) => f.field === 'attributes.condition_type')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R4 — AM-4a none-style allergen declaration
// ---------------------------------------------------------------------------

describe('R4 — the none-style allergen declaration (AM-4a)', () => {
  const cp = pack.compliancePack!;
  const key = cp.allergenFields.declaration;

  it('both packs ship a canonical none-style string', () => {
    expect(cp.noAllergenCanonical).toBe('Free from major allergens per label');
    expect(loadPack('cosmetics').compliancePack!.noAllergenCanonical).toBe(
      'Free from declared allergens per label',
    );
  });

  it('DIRECTION 1: no declarable allergen + canonical value ⇒ no failure', () => {
    expect(clean.attributes[key]).toBe(cp.noAllergenCanonical);
    expect(c23(clean).filter((f) => f.field === `attributes.${key}`)).toEqual([]);
  });

  it('DIRECTION 2: no declarable allergen + a free-text variant ⇒ FAILS', () => {
    for (const variant of ['None', 'N/A', 'no allergens', 'Allergen free', '']) {
      const l = mut((x) => {
        x.attributes[key] = variant;
      });
      const f = c23(l).filter((y) => y.field === `attributes.${key}`);
      expect(f.length, `variant '${variant}'`).toBeGreaterThan(0);
      expect(f.some((y) => y.checkId === 'C23')).toBe(true);
    }
  });

  it('the rule does NOT fire when a declarable allergen IS present (C9 owns that case)', () => {
    const l = mut((x) => {
      x.attributes[cp.allergenFields.labelList] = 'Whey Protein Concentrate (Milk)';
      x.attributes[key] = 'Contains: Milk';
    });
    expect(c23(l).filter((f) => f.field === `attributes.${key}`)).toEqual([]);
  });

  it('C9 still bans "No Known Allergens" INDEPENDENTLY when an allergen is present', () => {
    const banned = cp.noAllergenPhrases[0]!;
    const l = mut((x) => {
      x.attributes[cp.allergenFields.labelList] = 'Whey Protein Concentrate (Milk)';
      x.attributes[key] = banned;
    });
    const failures = runGate(l, pack, ctx).failures;
    expect(failures.some((f) => f.checkId === 'C9' && f.context.includes(banned))).toBe(true);
  });

  it('the rule is pack-driven: emptying the canonical string disarms it AND is blocking', () => {
    const p = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    p.compliancePack!.noAllergenCanonical = '';
    const l = mut((x) => {
      x.attributes[key] = 'anything at all';
    });
    expect(c23(l, p).filter((f) => f.field === `attributes.${key}`)).toEqual([]);
    // …which is exactly why it is a manifest piece.
    expect(runGate(l, p, ctx).failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pendingTemplateConfirm + browse node + subject_keyword
// ---------------------------------------------------------------------------

describe('AM-7 / AM-4b / browse-node annotations', () => {
  const CENSUS_24 = [
    'brand_name','manufacturer','item_form','primary_supplement_type','product_benefit',
    'recommended_uses_for_product','target_gender','age_range_description','diet_type',
    'material_features','active_ingredients','ingredients','directions_for_use','unit_count',
    'unit_count_type','servings_per_container','serving_size','item_weight','flavor_name',
    'container_type','country_of_origin','safety_warning','legal_disclaimer_description',
    'standard_price',
  ];

  it('pendingTemplateConfirm marks exactly the fields outside the 24-key census', () => {
    for (const f of pack.attributeSchema) {
      expect(Boolean(f.pendingTemplateConfirm), f.field).toBe(!CENSUS_24.includes(f.field));
    }
    expect(CENSUS_24.length).toBe(24);
  });

  it('recommended_browse_nodes is suggestOnly and says so', () => {
    const f = pack.attributeSchema.find((x) => x.field === 'recommended_browse_nodes')!;
    expect(f.suggestOnly).toBe(true);
    expect(f.note).toContain('Product Classifier');
    expect(f.note).toContain('LAST');
  });

  it('subject_keyword is KEPT, with the legacy/negligible + zero-byte-cost note', () => {
    const f = pack.attributeSchema.find((x) => x.field === 'subject_keyword');
    expect(f).toBeTruthy();
    expect(f!.note).toContain('Legacy');
    expect(f!.note).toContain('negligible');
    expect(f!.note!.toLowerCase()).toContain('byte');
  });
});

// ---------------------------------------------------------------------------
// Staleness — advisory only
// ---------------------------------------------------------------------------

describe('attribute-schema staleness is computed and ADVISORY', () => {
  const meta = { verifiedAsOf: '2026-08-14', staleAfterDays: 180 };

  it('inside the horizon: not stale, age computed', () => {
    const s = attributeSchemaStaleness(meta, new Date('2026-10-01T00:00:00Z'));
    expect(s.stale).toBe(false);
    expect(s.ageDays).toBe(48);
  });

  it('past the horizon: stale, with a notice naming the date and the horizon', () => {
    const s = attributeSchemaStaleness(meta, new Date('2027-06-01T00:00:00Z'));
    expect(s.stale).toBe(true);
    expect(s.ageDays).toBeGreaterThan(180);
    expect(s.notice).toContain('2026-08-14');
    expect(s.notice).toContain('180');
    expect(s.notice).toContain('does not affect the verify gate');
  });

  it('an unreadable date is stale; no meta at all (no schema) is not', () => {
    expect(attributeSchemaStaleness({ staleAfterDays: 180 }).stale).toBe(true);
    expect(attributeSchemaStaleness(undefined).stale).toBe(false);
  });

  it('staleness NEVER affects verified', () => {
    const stalePack = JSON.parse(JSON.stringify(pack)) as KnowledgePack;
    stalePack.attributeSchemaMeta = { verifiedAsOf: '2001-01-01', staleAfterDays: 180 };
    const audit = buildAudit(snapshot, clean, stalePack, ctx);
    expect(audit.attributeSchemaStale).toBe(true);
    expect(audit.attributeSchemaStaleNotice).toBeTruthy();
    expect(audit.verified).toBe(true);
    expect(audit.gateResult.failures).toEqual([]);
  });

  it('the shipped pack is currently fresh', () => {
    expect(buildAudit(snapshot, clean, pack, ctx).attributeSchemaStale).toBe(false);
  });
});
