/**
 * Display-label -> underscore_case attribute mapping (brain/03 schema).
 * Rainforest/PDP attributes arrive as display labels ("Item Form"); the
 * engine, gate, and audit consume underscore_case. Unmapped labels are
 * preserved under their normalized display key prefixed with '_raw:'.
 * NOTE: this file is intentionally dependency-free and pure so the drift
 * contract test can run it against recorded fixtures.
 */

const LABEL_TO_FIELD: Record<string, string> = {
  brand: 'brand_name',
  'brand name': 'brand_name',
  manufacturer: 'manufacturer',
  'item form': 'item_form',
  form: 'item_form',
  'dosage form': 'dosage_form',
  flavor: 'flavor_name',
  flavour: 'flavor_name',
  scent: 'scent_name',
  'primary supplement type': 'primary_supplement_type',
  'supplement type': 'supplement_type',
  'unit count': 'unit_count',
  'number of items': 'number_of_items',
  'item weight': 'item_weight',
  'serving size': 'serving_size',
  'servings per container': 'servings_per_container',
  'material feature': 'material_features',
  'material features': 'material_features',
  'diet type': 'diet_type',
  'age range (description)': 'age_range_description',
  'age range description': 'age_range_description',
  'target gender': 'target_gender',
  gender: 'target_gender',
  'product benefits': 'product_benefit',
  'product benefit': 'product_benefit',
  'specific uses for product': 'specific_uses_for_product',
  'recommended uses for product': 'recommended_uses_for_product',
  'directions': 'directions_for_use',
  'directions for use': 'directions_for_use',
  ingredients: 'ingredients',
  'active ingredients': 'active_ingredients',
  'allergen information': 'allergen_information',
  'safety information': 'safety_warning',
  'safety warning': 'safety_warning',
  'legal disclaimer': 'legal_disclaimer_description',
  'country of origin': 'country_of_origin',
  'container type': 'container_type',
  size: 'size_name',
  'item package quantity': 'item_package_quantity',
  'package information': 'container_type',
  upc: 'upc',
  asin: 'asin',
  'best sellers rank': '_rank',
  'customer reviews': '_reviews',
  'date first available': '_date_first_available',
  'product dimensions': 'item_dimensions',
  'maximum strength': 'maximum_dosage',
  'dosage': 'maximum_dosage',
};

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‎‏:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Maps one display label; returns null when unknown. */
export function mapLabel(label: string): string | null {
  return LABEL_TO_FIELD[normalizeLabel(label)] ?? null;
}

/** All known display labels — used by the drift contract test. */
export function knownLabels(): string[] {
  return Object.keys(LABEL_TO_FIELD);
}

export interface MappedAttributes {
  attributes: Record<string, string>;
  unmapped: { name: string; value: string }[];
}

export function mapAttributes(
  raw: { name: string; value: string }[],
): MappedAttributes {
  const attributes: Record<string, string> = {};
  const unmapped: { name: string; value: string }[] = [];
  for (const { name, value } of raw) {
    const field = mapLabel(name);
    if (field && !field.startsWith('_')) {
      // first occurrence wins (attributes[] beats specifications[] duplicates)
      if (!(field in attributes)) attributes[field] = value;
    } else if (!field) {
      unmapped.push({ name, value });
    }
  }
  return { attributes, unmapped };
}
