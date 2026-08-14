import type { ListingSnapshot, OptimizedListing } from '@/lib/types';

/**
 * REALISTIC NON-REGULATED LISTINGS.
 *
 * Eight ordinary products, written the way their real listings are written.
 * They exist so the "is this a regulated category?" backstops can be measured
 * against the products they are NOT meant to block: before round 6 every one of
 * these produced a blocking PACK failure from the suspicion lexicon (`count`,
 * `daily`, `blend`, `powder`, `extract`, `drops`, `serving`, `mg`, `iu`).
 */
export interface NonRegulatedProduct {
  productName: string;
  keyword: string;
  category: string;
  bullets: [string, string, string, string, string];
  description: string;
  backend: string;
  attributes: Record<string, string>;
}

export const NON_REGULATED_PRODUCTS: NonRegulatedProduct[] = [
  {
    productName: 'Kaffa Burr Coffee Grinder',
    keyword: 'Conical Burr Mill with 30 Grind Settings',
    category: 'Home & Kitchen > Kitchen & Dining > Coffee, Tea & Espresso',
    bullets: [
      'Even grounds every morning: 30 stepped settings take you from fine espresso to coarse French press without guesswork',
      'Quiet motor: the geared drive runs slower and cooler, so beans keep their aroma while you fill the hopper',
      'Easy cleanup: the removable catch bin and burr assembly rinse under the tap and click back in one motion',
      'Built to last: stainless conical burrs stay sharp through years of weekend brewing and weekday routines',
      'Counter friendly: a narrow footprint tucks beside the kettle and the short cord keeps the worktop tidy',
    ],
    description:
      'Kaffa Burr Coffee Grinder brings cafe consistency to a home worktop.\n\nWho it is for: home brewers who switch between espresso, pour over and French press and want the same grind twice.\n\nHow to use: fill the hopper, choose a setting, and press the dial. Wipe the burrs with the brush after heavy use.',
    backend: 'kafe grindr cafetiere espressomuhle molinillo koffiemolen kaffee',
    attributes: { unit_count: '1 count', brand_name: 'Kaffa', item_form: 'Electric', material: 'Stainless steel', color: 'Matte black' },
  },
  {
    productName: 'Lumenary LED Desk Lamp',
    keyword: 'Dimmable Task Light with USB-C Charging Port',
    category: 'Tools & Home Improvement > Lighting & Ceiling Fans > Lamps',
    bullets: [
      'Light you can tune: five brightness levels and three colour temperatures move from warm reading to bright drafting',
      'Charge while you work: the USB-C port on the base tops up a phone or tablet without another wall plug',
      'Stays where you put it: a weighted base and two hinges hold the head over a keyboard or a sketchbook',
      'Flicker free panel: the diffused strip spreads light across the whole desk instead of a single hot spot',
      'Simple memory: the touch strip remembers the last setting so the lamp returns to your preferred level',
    ],
    description:
      'Lumenary LED Desk Lamp is a task light for people who work late at a small desk.\n\nWho it is for: students, hobbyists and anyone sharing a room who needs directed light without lighting the whole space.\n\nHow to use: unfold the arm, plug in the adapter, and hold the touch strip to dim.',
    backend: 'lampara escritorio schreibtischleuchte bureaulamp study lite dimable',
    attributes: { unit_count: '1 count', brand_name: 'Lumenary', material: 'Aluminium', color: 'White', item_form: 'Corded' },
  },
  {
    productName: 'PawNest Orthopedic Dog Bed',
    keyword: 'Memory Foam Pet Mattress with Washable Cover',
    category: 'Pet Supplies > Dogs > Beds, Furniture & Mats',
    bullets: [
      'Support where it matters: a solid memory foam core holds an older dog level instead of letting it sink to the floor',
      'Cover comes off: the zip cover machine washes and goes back on without wrestling the foam',
      'Stays put on wood: a gripped underside keeps the bed from sliding when a big dog flops down',
      'Bolstered sides: a raised edge gives a head rest for dogs that like to curl against something',
      'Two sizes of home: the low profile slides under a desk or sits inside most wire crates',
    ],
    description:
      'PawNest Orthopedic Dog Bed is a foam mattress for dogs that have stopped enjoying the floor.\n\nWho it is for: older or larger dogs, and households where the bed has to look tidy in a living room.\n\nHow to use: unroll, let the foam expand overnight, then zip on the cover.',
    backend: 'hundebett panier chien cama perro matress orthopadisch kussen',
    attributes: { unit_count: '1 count', brand_name: 'PawNest', material: 'Memory foam', color: 'Grey', size_name: 'Large' },
  },
  {
    productName: 'Tarelo Digital Kitchen Scale',
    keyword: 'Precision Food Weighing Platform with Tare Function',
    category: 'Home & Kitchen > Kitchen & Dining > Measuring Tools & Scales',
    bullets: [
      'Reads what you add: the tare button zeroes the platform so you can weigh straight into a mixing bowl',
      'Four units: switch between grams, ounces, pounds and millilitres with one press on the side',
      'Wipes clean: the sealed glass top has no seams for flour to hide in, so a damp cloth finishes the job',
      'Slim enough to store: it slides into a drawer beside the chopping boards when the baking is done',
      'Steady readings: four load sensors settle quickly even when the bowl is off centre',
    ],
    description:
      'Tarelo Digital Kitchen Scale is a flat weighing platform for baking and portioning.\n\nWho it is for: bakers following weight based recipes and anyone tracking what goes into a lunchbox.\n\nHow to use: press on, place the bowl, press tare, then add your ingredient.',
    backend: 'bascula cocina kuchenwaage balance cuisine wiegen platfrom precission',
    attributes: { unit_count: '1 count', brand_name: 'Tarelo', material: 'Tempered glass', color: 'Silver', item_form: 'Battery powered' },
  },
  {
    productName: 'The Longford Tide',
    keyword: 'A Novel of the Irish Coast, Paperback',
    category: 'Books > Literature & Fiction > Contemporary',
    bullets: [
      'A coastal story: a returning daughter, a shuttered hotel and a village that has already decided what happened',
      'Told in two seasons: chapters alternate between the summer of the closure and the winter she comes back',
      'Book club ready: fifteen discussion questions and a map of the harbour are printed in the back matter',
      'Readable type: a generous point size and matt paper make long evening chapters easier on the eyes',
      'Travels well: a light paperback that survives a coat pocket and a rainy platform',
    ],
    description:
      'The Longford Tide is a contemporary novel set across two seasons on the Irish coast.\n\nWho it is for: readers of literary family drama and anyone who reads a book club pick every month.\n\nHow to use: begin at chapter one; the discussion questions at the back are best saved until the end.',
    backend: 'roman irlandais irische romane novela costera fiction paperbak litrary',
    attributes: { unit_count: '1 count', brand_name: 'Longford', material: 'Paper', size_name: 'Paperback', color: 'Multicolour' },
  },
  {
    productName: 'Solvent Grip Yoga Mat',
    keyword: 'Non Slip Exercise Mat with Alignment Lines',
    category: 'Sports & Outdoors > Sports > Yoga',
    bullets: [
      'Grip when you sweat: a textured top layer holds a plank position instead of sliding out from under you',
      'Lines that help: printed alignment marks show where hands and feet belong in a standing sequence',
      'Cushioned without wobble: six millimetres of closed cell foam pads the knees and still feels stable',
      'Carries flat or rolled: the included strap doubles as a stretching aid at the end of a session',
      'Wipes down fast: a closed surface means sweat sits on top and comes off with a cloth',
    ],
    description:
      'Solvent Grip Yoga Mat is a textured exercise mat for studio and living room practice.\n\nWho it is for: beginners who want alignment marks and regulars who dislike a mat that creeps.\n\nHow to use: unroll textured side up, wipe after class, and store rolled rather than folded.',
    backend: 'tapis yogamatte esterilla colchoneta exercize matt nonslip',
    attributes: { unit_count: '1 count', brand_name: 'Solvent', material: 'Closed cell foam', color: 'Teal', size_name: 'Standard' },
  },
  {
    productName: 'Auralite Bluetooth Speaker',
    keyword: 'Portable Waterproof Sound Bar for Outdoors',
    category: 'Electronics > Portable Audio & Video > Portable Speakers',
    bullets: [
      'Sound that carries: a passive radiator adds low end so a garden party does not sound thin',
      'Rain is fine: a sealed housing and gasketed ports shrug off a shower and a splash from the pool',
      'Long sessions: a full charge covers an afternoon of playback and tops up over USB-C in an hour',
      'Pair two: link a second unit for left and right channels across a patio',
      'Grab and go: a braided loop clips to a rucksack and the rubber ends survive being set down on stone',
    ],
    description:
      'Auralite Bluetooth Speaker is a sealed portable speaker built for outdoor listening.\n\nWho it is for: campers, cyclists and anyone who wants music on a balcony without a mains socket.\n\nHow to use: hold the power button to pair, then connect from your phone settings.',
    backend: 'altavoz portatil lautsprecher enceinte blutooth speeker waterproff',
    attributes: { unit_count: '1 count', brand_name: 'Auralite', material: 'Silicone', color: 'Slate', item_form: 'Rechargeable' },
  },
  {
    productName: 'Verdant Shield Phone Case',
    keyword: 'Shockproof Cover with Raised Camera Bezel',
    category: 'Cell Phones & Accessories > Cases, Holsters & Sleeves',
    bullets: [
      'Corners take the hit: reinforced bumpers absorb a drop from a jacket pocket to a paving slab',
      'Lens sits proud: a raised bezel keeps the camera glass off the table when you put the phone down',
      'Buttons still click: moulded covers keep the original travel instead of turning the volume keys mushy',
      'Charges through: the back is thin enough for a wireless pad and thick enough to matter',
      'Grip you notice: a lightly textured edge stops the phone from sliding off a car seat',
    ],
    description:
      'Verdant Shield Phone Case is a two layer protective cover with reinforced corners.\n\nWho it is for: commuters and site workers who drop a handset more than they would like to admit.\n\nHow to use: peel the film, seat the top edge first, then press the corners home.',
    backend: 'coque telephone handyhulle funda movil protectiv cove shockproff',
    attributes: { unit_count: '1 count', brand_name: 'Verdant', material: 'Polycarbonate', color: 'Forest green', size_name: 'Standard' },
  },
];

/** A ListingSnapshot for the routing half of the test. */
export function snapshotOf(p: NonRegulatedProduct): ListingSnapshot {
  return {
    asin: 'B0NONREG01',
    url: 'https://www.amazon.com/dp/B0NONREG01',
    title: `${p.productName} ${p.keyword}`,
    bullets: [...p.bullets],
    description: p.description,
    category: p.category,
    subcategory: [],
    attributes: p.attributes,
    images: [],
    price: '',
    raw: {},
  };
}

/** A complete, contract-shaped OptimizedListing for the gate half of the test. */
export function listingOf(p: NonRegulatedProduct): OptimizedListing {
  const name = p.productName;
  return {
    title: `${name} ${p.keyword}`,
    title75: `${name} ${p.keyword}`.slice(0, 75).trim(),
    itemHighlights: p.keyword,
    bullets: [...p.bullets],
    description: p.description,
    backendSearchTerms: p.backend,
    attributes: p.attributes,
    facts: {},
    fdaDisclaimer: '',
    aplusContent: {
      fdaDisclaimer: '',
      modules: [
        { id: 'brand-story', headline: `${name} - made for everyday use`, body: `${name} is built around one job and does it without fuss.`, claimBearing: false },
        { id: 'hero', headline: `${name} at a glance`, body: `${name} pairs a simple shape with materials chosen to last.`, claimBearing: false },
        { id: 'who-its-for', headline: 'Who it is for', body: p.description.split('Who it is for:')[1]?.split('\n')[0]?.trim() ?? 'Everyday households.', claimBearing: false },
      ],
      comparison: {
        rows: [
          { label: 'Materials', ours: 'Chosen for durability', typical: 'Lightest available option' },
          { label: 'Cleaning', ours: 'Wipes or washes clean', typical: 'Spot clean only' },
          { label: 'Packaging', ours: 'Plain recyclable card', typical: 'Moulded plastic tray' },
        ],
      },
      faq: [
        { q: 'How do I look after it?', a: 'Wipe it down and store it dry between uses.', claimBearing: false },
        { q: 'What is in the box?', a: 'The unit, a short manual and the accessories listed above.', claimBearing: false },
      ],
    },
    imagePlan: [
      { slot: 1, purpose: 'main-white-background', spec: '2000px long side; pure white; product fills the frame', notes: 'No overlay text' },
      { slot: 2, purpose: 'in-context lifestyle', spec: '1600px; natural light; product in use', notes: 'Show scale against a familiar object' },
    ],
    qa: [
      { q: 'Does it arrive assembled?', a: 'Yes, it arrives ready to use.', claimBearing: false },
      { q: 'How is it cleaned?', a: 'A damp cloth is enough for everyday marks.', claimBearing: false },
    ],
    primaryKeyword: p.keyword,
    productName: name,
    state: 'draft',
  };
}
