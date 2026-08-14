import type { AttributeField, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { presentAllergens } from './c-quality';
import { fail } from './shared';

/**
 * C23 — ATTRIBUTE DISCIPLINE (pack-driven; the schema is
 * `pack.attributeSchema` and the allergen phrasing is `compliancePack`, so
 * this module names no attribute key and no allergen phrase of its own).
 *
 * WHY: a live run produced 29 of the 35 schema attributes and still came back
 * with no signal about it — a previous run had filled all 35, so the loss was
 * pure regression that nothing enforced. Attributes are the DISCOVERY surface
 * (filter facets power customer-facing filters and COSMO retrieval), so a
 * silently missing one is lost surface, not a cosmetic gap.
 *
 * FOUR RULES, all pack-driven:
 *
 *  R1 COMPLETENESS —
 *   - a schema field marked `required` that is missing or blank is a FAILURE;
 *   - a FILTER-FACET field (`filterFacet: true`) that is missing or blank is a
 *     FAILURE even when the schema marks it optional — facets are the
 *     discovery surface and an empty one excludes the listing from filters;
 *   - every OTHER schema field (optional, non-facet) is NOT a gate failure
 *     when missing: it is reported as an audit GAP instead
 *     (`lib/audit/diff.ts`), because the schema itself declares it
 *     inapplicable-able. The generator is still instructed to fill every
 *     field, using the explicit none-style value the schema example shows.
 *
 *  R2 OPERATOR EXEMPTION — a field the schema marks `source: 'operator'` is
 *   never reported missing, whatever its `required`/`filterFacet` flags say.
 *   The app CANNOT know a price, a SKU, a GTIN, a model number or an offer
 *   condition: they are seller-account facts. Demanding them would force the
 *   generator to invent one, and an invented price is a WRONG price on a live
 *   listing — a materially worse outcome than a blank the operator fills in.
 *   A field with no declared `source` reads as `generated`, the stricter side.
 *
 *  R3 ENUM VALIDATION — where the schema declares a CLOSED value set
 *   (`enum`), a produced value outside it is a FAILURE. Amazon rejects a
 *   non-enum value at feed time, so an unchecked one turns into a suppressed
 *   listing rather than a bad one. Matching is trimmed + case-insensitive
 *   (marketplace enums are not case-sensitive) but otherwise exact. Fields
 *   whose value set is open in practice deliberately carry no `enum` — see
 *   `_declinedEnums` in the schema file; an over-tight enum would block a
 *   lawful value, which is worse than not checking.
 *
 *  R4 NONE-STYLE ALLERGEN DECLARATION (AM-4a) — when the label carries NO
 *   declarable allergen, the declaration attribute must equal the pack's
 *   `noAllergenCanonical` string EXACTLY. An empty declaration field reads as
 *   "not answered" and free-text variants are unverifiable. This is the
 *   COMPLEMENT of C9, which fires only when an allergen IS present; the two
 *   never run on the same listing, and C9's ban on `noAllergenPhrases`
 *   ("No Known Allergens") is untouched and independent.
 *
 * A pack with an EMPTY schema has no R1–R3 rule at all — which is why
 * `attributeSchema` is a required manifest piece on compliance-bearing packs
 * (`REQUIRED_PACK_PIECES`): emptying it would otherwise disarm this check
 * silently. `compliancePack.noAllergenCanonical` and the schema's enum lists
 * are manifest pieces for the same reason.
 */

const CHECK_ID = 'C23';

/** True when the produced attribute value is missing or effectively blank. */
const isBlank = (v: unknown): boolean => v == null || String(v).trim() === '';

/**
 * WHO OWNS the value. A field with no declared `source` reads as `generated` —
 * deliberately the stricter reading, since that is the one the gate enforces.
 */
const isOperatorOwned = (f: AttributeField): boolean => f.source === 'operator';

const norm = (v: string): string => v.trim().toLowerCase();

export function c23AttributeCompleteness(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const schema = pack.attributeSchema ?? [];
  const attrs = l.attributes ?? {};
  const out: Failure[] = [];

  for (const field of schema) {
    const name = field?.field?.trim();
    if (!name) continue;

    // --- R3: enum validation (runs on a PRESENT value, so it is independent
    //     of the completeness rule and of the operator exemption). ---
    const allowed = (field.enum ?? []).filter((v) => String(v).trim() !== '');
    const value = attrs[name];
    if (allowed.length > 0 && !isBlank(value)) {
      if (!allowed.some((a) => norm(a) === norm(String(value)))) {
        out.push(
          fail(
            CHECK_ID,
            `attributes.${name}`,
            `'${String(value)}' is not one of the values '${name}' accepts`,
            `Set '${name}' to exactly one of: ${allowed.join(' | ')}. The marketplace rejects an out-of-set value at feed time, which suppresses the listing rather than degrading it.`,
          ),
        );
      }
    }

    // --- R2: operator-owned fields are never reported missing. ---
    if (isOperatorOwned(field)) continue;

    // --- R1: completeness. ---
    if (!field.required && !field.filterFacet) continue; // optional non-facet → audit gap, not a failure
    if (!isBlank(value)) continue;
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

  // --- R4: the none-style allergen declaration (AM-4a). ---
  out.push(...noneStyleAllergenDeclaration(l, pack));
  return out;
}

/**
 * AM-4a. Pack-driven end to end: the attribute KEY comes from
 * `compliancePack.allergenFields.declaration` and the required STRING from
 * `compliancePack.noAllergenCanonical`. This module holds neither.
 */
function noneStyleAllergenDeclaration(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const canonical = cp.noAllergenCanonical?.trim();
  const key = cp.allergenFields?.declaration?.trim();
  if (!canonical || !key) return []; // configured off → no rule (and a manifest failure elsewhere)
  // Only the NO-allergen case: when an allergen is present C9 owns the field.
  if (presentAllergens(l, cp).length > 0) return [];
  const value = (l.attributes ?? {})[key];
  if (value === canonical) return [];
  return [
    fail(
      CHECK_ID,
      `attributes.${key}`,
      isBlank(value) ? '(empty)' : String(value),
      `No declarable allergen is present, so '${key}' must equal exactly '${canonical}'. A blank reads as "not answered" and a free-text variant cannot be verified.`,
    ),
  ];
}
