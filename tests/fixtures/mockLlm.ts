import type { LlmClient } from '@/lib/engine/llm';

/**
 * Deterministic mock LLM returning a COMPLIANT optimization for the
 * rainforest sample fixture — the golden fixture's generation source.
 * Note: it never writes the FDA disclaimer (code inserts it), per contract.
 */

const responses: Record<string, unknown> = {
  title: {
    productName: 'BrandX Probiotic',
    primaryKeyword: 'probiotic supplement',
    title:
      'BrandX Probiotic Supplement 50 Billion CFU, 10 Strains with Prebiotic, 60 Vegan Capsules, Digestive Balance and Gut Health Support for Women, Men, Shelf Stable, Non-GMO, Gluten Free, Two Month Supply',
    title75: 'BrandX Probiotic Supplement 50 Billion CFU, 10 Strains, 60 Capsules',
    itemHighlights: 'Vegan gluten free gut health support for women and men, shelf stable prebiotic blend, two month supply, non-GMO',
  },
  bullets: {
    bullets: [
      { text: 'DIGESTIVE BALANCE SUPPORT: A 50 Billion CFU blend of 10 strains helps maintain healthy gut flora when everyday eating feels heavy or unpredictable*', useCaseAnchor: 'daily digestive balance', claimBearing: true },
      { text: 'TRAVEL AND ROUTINE CHANGES: Shelf-stable capsules need no refrigeration, so your routine keeps working through trips, commutes, and busy weeks', useCaseAnchor: 'travel routine', claimBearing: false },
      { text: 'ONE CAPSULE DAILY: 60 vegetable capsules provide a full two-month supply at one capsule per day, taken with or without food', useCaseAnchor: 'simple daily habit', claimBearing: false },
      { text: 'QUALITY YOU CAN VERIFY: Third-party tested, Non-GMO and gluten free, manufactured in a cGMP facility in the USA', useCaseAnchor: 'quality verification', claimBearing: false },
      { text: 'MADE FOR SENSITIVE ROUTINES: Vegan, unflavored and free of major allergens per the label, designed for adults seeking steady digestive comfort support*', useCaseAnchor: 'sensitive users', claimBearing: true },
    ],
  },
  description: {
    description:
      'BrandX Probiotic is a 50 Billion CFU, 10-strain probiotic supplement designed to support digestive balance and healthy gut flora for adults.\n\nWho it is for: adults who want steady digestive comfort support through changing routines, travel, and busy schedules.\n\nHow to use: take one capsule daily with water, with or without food. Each bottle contains 60 vegetable capsules, a two-month supply.\n\nQuality and safety: third-party tested, Non-GMO, gluten free, vegan, and shelf stable with no refrigeration required. Manufactured in a cGMP facility in the USA. If you are pregnant, nursing, or taking medication, consult your physician before use. Keep out of reach of children.',
  },
  backend: {
    backendSearchTerms:
      'probiotico acidophilus flora restore culturas vivas digestion aid microbiome pastillas probioticas belly comfort probotic probyotic vientre salud digestivo',
  },
  attributes: {
    attributes: {
      brand_name: 'BrandX',
      manufacturer: 'BrandX Labs LLC',
      primary_supplement_type: 'Probiotic',
      supplement_type: 'Probiotic; Prebiotic',
      recommended_browse_nodes: '3774321',
      item_form: 'Capsule',
      dosage_form: 'Vegetable Capsule',
      serving_size: '1 Capsule',
      servings_per_container: '60',
      unit_count: '60',
      unit_count_type: 'Count',
      maximum_dosage: '50 Billion CFU',
      directions_for_use: 'Take 1 capsule daily with water, with or without food.',
      target_gender: 'Unisex',
      age_range_description: 'Adult',
      diet_type: 'Vegan; Gluten Free',
      material_features: 'Vegan; Non-GMO; Gluten Free',
      product_benefit: 'Digestive Balance Support; Gut Flora Support',
      recommended_uses_for_product: 'Daily digestive support',
      specific_uses_for_product: 'Digestive balance during travel; Daily gut flora maintenance',
      active_ingredients: 'Probiotic Blend (10 strains, 50 Billion CFU); Prebiotic Fiber',
      ingredients: 'Probiotic Blend (10 strains, 50 Billion CFU); Prebiotic Fiber; Vegetable Cellulose Capsule; Rice Flour',
      allergen_information: 'Free from major allergens per label',
      safety_warning: 'If pregnant, nursing, or taking medication, consult your physician before use. Keep out of reach of children.',
      legal_disclaimer_description: '[SYSTEM_DISCLAIMER]',
      size_name: '60 Count (Pack of 1)',
      flavor_name: 'Unflavored',
      container_type: 'Bottle',
      item_weight: '2.4 Ounces',
      country_of_origin: 'USA',
      fulfillment_channel: 'FBA',
    },
  },
  aplus: {
    modules: [
      { id: 'brand-story', headline: 'The BrandX Story', body: 'BrandX Probiotic began with a simple idea: digestive support should fit real routines. Every batch of BrandX Probiotic is third-party tested and made in a cGMP facility in the USA.', claimBearing: false },
      { id: 'hero', headline: 'BrandX Probiotic — Balance You Can Build On', body: 'BrandX Probiotic delivers a 50 Billion CFU blend of 10 strains with prebiotic fiber to support digestive balance and healthy gut flora.', claimBearing: true },
      { id: 'ingredients', headline: 'What Is Inside', body: 'A 10-strain probiotic blend at 50 Billion CFU with prebiotic fiber, in a vegan vegetable capsule with rice flour. Free from major allergens per the label. Non-GMO and gluten free.', claimBearing: false },
      { id: 'how-to-use', headline: 'One Capsule, Once a Day', body: 'Take one capsule daily with water, with or without food. Each bottle holds 60 capsules — a two-month supply. Shelf stable, no refrigeration required.', claimBearing: false },
      { id: 'who-its-for', headline: 'Who It Is For', body: 'Adults who want steady digestive comfort support: frequent travelers, busy professionals, and anyone building a consistent gut-health routine. Unlike typical refrigerated options, BrandX travels with you.', claimBearing: true },
    ],
    comparison: {
      rows: [
        { label: 'Potency', ours: '50 Billion CFU blend of 10 strains', typical: 'Single-strain formulas at lower CFU counts' },
        { label: 'Storage', ours: 'Shelf stable, no refrigeration', typical: 'Often requires refrigeration' },
        { label: 'Supply', ours: '60 capsules, two-month supply at 1 daily', typical: '30-count bottles, one month' },
        { label: 'Diet', ours: 'Vegan, Non-GMO, gluten free', typical: 'Gelatin capsules, unverified sourcing' },
      ],
    },
    faq: [
      { q: 'How many CFU does it contain?', a: 'Each bottle contains a 50 Billion CFU blend of 10 probiotic strains with prebiotic fiber.', claimBearing: false },
      { q: 'Do I need to refrigerate it?', a: 'No. The formula is shelf stable — no refrigeration required.', claimBearing: false },
      { q: 'How long does one bottle last?', a: 'Each bottle has 60 capsules. At one capsule daily, that is a two-month supply.', claimBearing: false },
      { q: 'Is it vegan and gluten free?', a: 'Yes — vegan vegetable capsules, Non-GMO and gluten free per the label.', claimBearing: false },
      { q: 'What does it support?', a: 'It supports digestive balance and healthy gut flora as part of a daily routine.', claimBearing: true },
    ],
  },
  images: {
    imagePlan: [
      { slot: 1, purpose: 'main-white-background', spec: 'Pure white RGB 255/255/255 background; bottle fills ≥85% of frame; longest side ≥1000px', notes: 'Front label fully legible; no badges or text overlays' },
      { slot: 2, purpose: 'value-prop-infographic', spec: '1000px+; brand palette; ≤5 icon callouts', notes: '50 Billion CFU blend, 10 strains, vegan, shelf stable, two-month supply' },
      { slot: 3, purpose: 'supplement-facts-panel', spec: 'REAL PHOTOGRAPH of the printed Supplement Facts panel — never AI-generated or altered; sharp, evenly lit, fully readable', notes: 'Show full panel and ingredient list' },
      { slot: 4, purpose: 'ingredient-story', spec: '1000px+; macro texture or strain-diagram illustration', notes: '10-strain blend with prebiotic fiber; name key strains' },
      { slot: 5, purpose: 'how-to-use-routine', spec: '1000px+; 3-step layout', notes: 'One capsule daily, with or without food, morning routine framing' },
      { slot: 6, purpose: 'trust-heritage', spec: '1000px+; factual badges only (third-party tested, cGMP, Non-GMO)', notes: 'No ratings, guarantees, or unsubstantiated claims' },
      { slot: 7, purpose: 'lifestyle-outcome', spec: '1000px+; adult using product in daily/travel context', notes: 'Situational: packing a travel bag; steady-routine feeling' },
    ],
  },
  qa: {
    qa: [
      { q: 'How many capsules per serving?', a: 'One capsule is a full serving. Each bottle contains 60 capsules.', claimBearing: false },
      { q: 'How many CFU per bottle blend?', a: 'The blend delivers 50 Billion CFU across 10 strains.', claimBearing: false },
      { q: 'When should I take it?', a: 'Take one capsule daily with water, with or without food, at any consistent time.', claimBearing: false },
      { q: 'Does it need refrigeration?', a: 'No — it is shelf stable. Store in a cool, dry place.', claimBearing: false },
      { q: 'Is it vegan?', a: 'Yes, the capsules are vegetable-based and the formula is vegan.', claimBearing: false },
      { q: 'Is it gluten free?', a: 'Yes, it is gluten free per the label.', claimBearing: false },
      { q: 'Who is it for?', a: 'Adults seeking daily digestive balance support, including frequent travelers.', claimBearing: true },
      { q: 'What does it support?', a: 'It supports digestive balance and healthy gut flora.', claimBearing: true },
      { q: 'How long until I notice a difference?', a: 'Routines differ; many people give any new supplement several weeks of consistent daily use.', claimBearing: true },
      { q: 'Does it contain allergens?', a: 'It is free from major allergens per the label. Always review the ingredient list.', claimBearing: false },
      { q: 'Where is it made?', a: 'It is manufactured in a cGMP facility in the USA and third-party tested.', claimBearing: false },
      { q: 'How long does one bottle last?', a: 'At one capsule daily, the 60-count bottle lasts two months.', claimBearing: false },
      { q: 'Can I take it with other supplements?', a: 'If you take medication or other supplements, consult your physician first.', claimBearing: false },
    ],
  },
};

export const mockLlm: LlmClient = async ({ user }) => {
  // Route on distinctive task text per group prompt.
  const key = user.includes('Generate the title group')
    ? 'title'
    : user.includes('Write exactly 5 bullets')
      ? 'bullets'
      : user.includes('Write the product description')
        ? 'description'
        : user.includes('Backend search terms')
          ? 'backend'
          : user.includes('Fill the structured attribute set')
            ? 'attributes'
            : user.includes('A+ content')
              ? 'aplus'
              : user.includes('image/creative plan')
                ? 'images'
                : user.includes('Q&A pairs seeding')
                  ? 'qa'
                  : null;
  if (!key) throw new Error(`mockLlm: unrecognized prompt: ${user.slice(0, 120)}`);
  return JSON.stringify(responses[key]);
};
