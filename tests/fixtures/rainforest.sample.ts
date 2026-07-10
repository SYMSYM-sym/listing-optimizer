/**
 * Sanitized, representative Rainforest `type=product` response shape for a
 * supplement ASIN (structure mirrors docs.trajectdata.com; values neutral).
 * Replayed through mapProduct + labelMap so normalization is exercised.
 */
export const rainforestSample = {
  request_info: { success: true },
  product: {
    asin: 'B0TESTASIN',
    title:
      'BrandX Probiotic 50 Billion CFU, 60 Vegetable Capsules, Digestive Support Supplement for Women and Men',
    brand: 'BrandX',
    feature_bullets: [
      'SUPPORTS DIGESTIVE BALANCE: 50 Billion CFU blend supports healthy gut flora*',
      'QUALITY YOU CAN TRUST: Third-party tested, Non-GMO, gluten free',
      '60 VEGETABLE CAPSULES: Two-month supply at one capsule daily',
      'SHELF-STABLE FORMULA: No refrigeration required',
      'MADE IN THE USA: Manufactured in a cGMP facility',
    ],
    description:
      'BrandX Probiotic delivers a 50 Billion CFU blend of 10 strains to support digestive balance and immune function.',
    main_image: { link: 'https://m.media-amazon.com/images/I/main.jpg' },
    images: [
      { link: 'https://m.media-amazon.com/images/I/alt1.jpg', variant: 'PT01' },
      { link: 'https://m.media-amazon.com/images/I/alt2.jpg', variant: 'PT02' },
    ],
    attributes: [
      { name: 'Brand', value: 'BrandX' },
      { name: 'Item Form', value: 'Capsule' },
      { name: 'Flavor', value: 'Unflavored' },
      { name: 'Unit Count', value: '60 Count' },
      { name: 'Item Weight', value: '2.4 Ounces' },
      { name: 'Age Range (Description)', value: 'Adult' },
    ],
    specifications: [
      { name: 'Primary Supplement Type', value: 'Probiotic' },
      { name: 'Serving Size', value: '1 Capsule' },
      { name: 'Diet Type', value: 'Vegan, Gluten Free' },
      { name: 'Manufacturer', value: 'BrandX Labs LLC' },
      { name: 'Country of Origin', value: 'USA' },
      { name: 'Best Sellers Rank', value: '#100 in Health' },
    ],
    categories: [
      { name: 'Health & Household', category_id: '3760901' },
      { name: 'Vitamins & Dietary Supplements', category_id: '3764441' },
      { name: 'Probiotics', category_id: '3774321' },
    ],
    buybox_winner: { price: { raw: '$24.99' } },
    rating: 4.5,
    a_plus_content: { body_text: 'Why BrandX? Our 10-strain blend...' },
    important_information: {
      sections: [
        {
          title: 'Legal Disclaimer',
          body: 'Statements regarding dietary supplements have not been evaluated by the FDA.',
        },
      ],
    },
  },
};
