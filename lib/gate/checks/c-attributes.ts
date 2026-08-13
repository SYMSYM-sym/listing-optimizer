import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { fail } from './shared';

/**
 * C23 — ATTRIBUTE COMPLETENESS (pack-driven; the schema is
 * `pack.attributeSchema`, so this module names no field).
 *
 * WHY: a live run produced 29 of the 35 schema attributes and still came back
 * with no signal about it — a previous run had filled all 35, so the loss was
 * pure regression that nothing enforced. Attributes are the DISCOVERY surface
 * (filter facets power customer-facing filters and COSMO retrieval), so a
 * silently missing one is lost surface, not a cosmetic gap.
 *
 * THE POLICY, stated exactly (and asserted in tests):
 *  - a schema field marked `required` that is missing or blank is a FAILURE;
 *  - a FILTER-FACET field (`filterFacet: true`) that is missing or blank is a
 *    FAILURE even when the schema marks it optional — facets are the
 *    discovery surface and an empty one excludes the listing from filters;
 *  - every OTHER schema field (optional, non-facet) is NOT a gate failure when
 *    missing: it is reported as an audit GAP instead (`lib/audit/diff.ts`),
 *    because the schema itself declares it inapplicable-able. The generator is
 *    still instructed to fill every field, using the explicit none-style value
 *    the schema example shows for fields that genuinely do not apply — so a
 *    complete listing is the normal state and the gap list is the exception.
 *
 * Legitimately inapplicable fields are therefore respected: an optional
 * non-facet field never blocks, and the prompt (not this check) is what asks
 * the model to write the explicit none-style value instead of omitting it.
 *
 * A pack with an EMPTY schema has no C23 rule at all — which is why
 * `attributeSchema` is a required manifest piece on compliance-bearing packs
 * (`REQUIRED_PACK_PIECES`): emptying it would otherwise disarm this check
 * silently.
 */

const CHECK_ID = 'C23';

/** True when the produced attribute value is missing or effectively blank. */
const isBlank = (v: unknown): boolean =>
  v == null || String(v).trim() === '';

export function c23AttributeCompleteness(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const schema = pack.attributeSchema ?? [];
  if (schema.length === 0) return [];
  const attrs = l.attributes ?? {};
  const out: Failure[] = [];
  for (const field of schema) {
    const name = field?.field?.trim();
    if (!name) continue;
    if (!field.required && !field.filterFacet) continue; // optional non-facet → audit gap, not a failure
    if (!isBlank(attrs[name])) continue;
    const kind = field.required
      ? 'required by the schema'
      : 'a filter facet (customer-facing discovery surface)';
    out.push(
      fail(
        CHECK_ID,
        `attributes.${name}`,
        `'${name}' is missing or empty`,
        `Fill '${name}' — it is ${kind}. Every schema field must be produced; use the explicit none-style value the schema example shows when it does not apply.`,
      ),
    );
  }
  return out;
}
