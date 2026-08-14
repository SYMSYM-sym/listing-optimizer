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
      { text: 'Digestive balance support: A 50 Billion CFU blend of 10 strains helps maintain healthy gut flora when everyday eating feels heavy or unpredictable*', useCaseAnchor: 'daily digestive balance', claimBearing: true },
      { text: 'Travel and routine changes: Shelf-stable capsules need no refrigeration, so your routine keeps working through trips, commutes, and busy weeks', useCaseAnchor: 'travel routine', claimBearing: false },
      { text: 'One capsule daily: 60 vegetable capsules provide a full two-month supply at one capsule per day, taken with or without food', useCaseAnchor: 'simple daily habit', claimBearing: false },
      { text: 'Quality you can verify: Third-party tested, Non-GMO and gluten free, manufactured in a cGMP facility in the USA', useCaseAnchor: 'quality verification', claimBearing: false },
      { text: 'Made for sensitive routines: Vegan, unflavored and free of major allergens per the label, designed for adults seeking steady digestive comfort support*', useCaseAnchor: 'sensitive users', claimBearing: true },
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
      item_type_keyword: 'probiotic-supplements',
      item_form: 'Capsule',
      dosage_form: 'Vegetable Capsule',
      serving_size: '1 Capsule',
      servings_per_container: '60',
      unit_count: '60',
      unit_count_type: 'Count',
      maximum_dosage: '1 Capsule Daily',
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
      scent_name: 'Unscented',
      container_type: 'Bottle',
      item_weight: '2.4 Ounces',
      country_of_origin: 'USA',
      standard_price: '24.99',
      fulfillment_channel: 'FBA',
      subject_keyword: 'daily probiotic',
    },
  },
  aplus: {
    modules: [
      { id: 'brand-story', bannerAltText: 'BrandX brand story banner: third-party tested, made in a cGMP facility in the USA', headline: 'The BrandX Story', body: 'BrandX Probiotic began with a simple idea: digestive support should fit real routines. Every batch of BrandX Probiotic is third-party tested and made in a cGMP facility in the USA.', claimBearing: false },
      { id: 'hero', bannerAltText: 'BrandX Probiotic hero banner: 50 Billion CFU blend of 10 strains', headline: 'BrandX Probiotic — Balance You Can Build On', body: 'BrandX Probiotic delivers a 50 Billion CFU blend of 10 strains with prebiotic fiber to support digestive balance and healthy gut flora.', claimBearing: true },
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
      { slot: 1, purpose: 'main-white-background', spec: 'A real photograph of the actual bottle on a pure white background, RGB 255/255/255; bottle fills at least 85% of the frame; longest side 1000px or more; never AI-generated', notes: 'Front label fully legible; no badges, borders or overlay text', altText: 'BrandX Probiotic bottle, 60 vegan capsules, on a plain white background' },
      { slot: 2, purpose: 'benefit-infographic', spec: '1000px or more; brand palette; up to five icon callouts; overlay text legible at phone size', notes: '50 Billion CFU blend, 10 strains, vegan, shelf stable, two-month supply', altText: 'Infographic: 50 Billion CFU blend of 10 strains, vegan, shelf stable' },
      { slot: 3, purpose: 'whats-inside-and-dosage', spec: '1000px or more; flat lay of the bottle beside one capsule with the daily routine stated', notes: 'One capsule daily; 60 capsules per bottle', altText: 'One capsule beside the bottle, showing the one-a-day routine and 60 count' },
      { slot: 4, purpose: 'named-entities-and-certifications', spec: '1000px or more; ingredient names written out in full with substantiated badges as legible marks', notes: 'Ten strains named individually; third-party tested, Non-GMO and gluten free badges', altText: 'Ten named probiotic strains with prebiotic fiber and third-party tested badge' },
      { slot: 5, purpose: 'lifestyle-in-the-intent-environment', spec: '1000px or more; adult packing the bottle into a travel bag in natural light', notes: 'Situational: the routine continuing through a trip', altText: 'Bottle packed into a travel bag, showing the routine continuing on a trip' },
      { slot: 6, purpose: 'facts-panel-photograph', spec: 'A real photograph of the printed panel on the physical label: sharp, evenly lit and fully readable, every row visible; never AI-generated and never AI-altered', notes: 'Show the full panel and the other-ingredients list', altText: 'Photograph of the printed supplement facts panel and ingredient list' },
      { slot: 7, purpose: 'own-line-comparison', spec: '1000px or more; two-column layout comparing this formula against a generic unnamed alternative', notes: 'No rival brand named anywhere in the frame', altText: 'Comparison of this shelf stable 10-strain formula against a typical option' },
      { slot: 8, purpose: 'routine-and-how-to-use', spec: '1000px or more; three-step layout showing morning routine placement and storage', notes: 'Take one capsule daily with water; store cool and dry', altText: 'Three step routine: one capsule daily with water, stored cool and dry' },
    ],
    videoBrief: {
      aspect: '9:16 vertical',
      durationSeconds: 30,
      shots: [
        'Open on the bottle in a real kitchen, in frame within the first second',
        'Hand picks up one capsule and takes it with water, in one unbroken shot',
        'Cut to the bottle packed into a travel bag as the routine continues',
        'Close on the front label with the count and the strain number readable',
      ],
      onScreenText: [
        '50 Billion CFU blend, 10 strains',
        'One capsule daily',
        'Shelf stable, no refrigeration',
        'Vegan, Non-GMO, gluten free',
      ],
      notes: 'Shot vertical throughout, never cropped from a wide edit. Assume it is watched muted.',
    },
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
      { q: 'What strains are included?', a: 'The blend combines 10 probiotic strains at 50 Billion CFU total.', claimBearing: false },
      { q: 'Is there a prebiotic included?', a: 'Yes, prebiotic fiber is included to help feed the probiotic strains.', claimBearing: false },
    ],
  },
  keywords: {
    keywords: [
      // Declared on `description` ONLY, deliberately: several suites mutate the
      // product NAME inside the title surfaces (tests/twoPhase, tests/repairConsistency),
      // and a fixture row that declared a placement those suites then invalidate
      // would report C28 against copy the suite meant to change. The title
      // surfaces stay covered by the rows below, whose terms the rename leaves
      // untouched — so nothing is weakened, only made rename-stable.
      { t: 'probiotic supplement', tier: 1, status: 'placed', surfaces: ['description'], evidence: 'Category head term; both lane leaders lead with it' },
      { t: 'digestive balance', tier: 1, status: 'placed', surfaces: ['title', 'bullet1', 'description', 'attributes', 'aplus'], evidence: 'The single intent cluster this listing owns' },
      { t: '50 billion cfu', tier: 2, status: 'placed', surfaces: ['title', 'title75', 'bullet1', 'description', 'aplus', 'faq'], evidence: 'The hero spec — panel-verifiable and blend-attached' },
      { t: 'prebiotic', tier: 2, status: 'placed', surfaces: ['title', 'itemHighlights', 'attributes', 'aplus'], evidence: 'Named entity assistants lift for what-is-in-it questions' },
      { t: 'vegan', tier: 3, status: 'placed', surfaces: ['title', 'itemHighlights', 'bullet5', 'description', 'attributes'], evidence: 'Filter facet and tie-breaker' },
      { t: 'shelf stable', tier: 3, status: 'placed', surfaces: ['itemHighlights', 'description'], evidence: 'Storage differentiator against refrigerated rivals' },
      { t: 'two month supply', tier: 3, status: 'placed', surfaces: ['itemHighlights'], evidence: 'Supply qualifier in the separately indexed header field' },
      { t: 'acidophilus', tier: 'backend', status: 'backend', surfaces: ['backend'], evidence: 'Common-name variant deliberately kept out of visible copy' },
      { t: 'probotic', tier: 'backend', status: 'backend', surfaces: ['backend'], evidence: 'Misspelling' },
      { t: 'probyotic', tier: 'backend', status: 'backend', surfaces: ['backend'], evidence: 'Misspelling' },
      { t: 'immune boost', tier: 'demand', status: 'captured-via', surfaces: [], via: 'the compliant daily wellness and everyday routine cluster the copy writes out in full', evidence: 'Boost framing is an efficacy shape this copy deliberately avoids' },
      { t: 'weight loss', tier: 'strategy', status: 'not-targeted', surfaces: [], evidence: 'No label substantiation; the adjacent intent converts badly' },
      { t: 'organic probiotic', tier: 'candidate', status: 'candidate', surfaces: [], home: 'PPC exact + off-site articles', evidence: 'Certification not held — keep out of published copy until it is' },
      { t: 'diabetes', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Named condition' },
      { t: 'detox', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Implied-treatment framing, unsubstantiated' },
      { t: 'miracle', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Unverifiable superlative' },
      { t: 'maximum strength', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Unverifiable superlative' },
      { t: 'greenluxe', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Rival brand / trademark exposure' },
      { t: 'clinically proven', tier: 'negative', status: 'negative', surfaces: [], evidence: 'Unsubstantiated clinical claim' },
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
              : user.includes('image plan plus a')
                ? 'images'
                : user.includes('Q&A pairs seeding')
                  ? 'qa'
                  : user.includes('TASK: The keyword reference')
                    ? 'keywords'
                    : null;
  if (!key) throw new Error(`mockLlm: unrecognized prompt: ${user.slice(0, 120)}`);
  return JSON.stringify(responses[key]);
};
