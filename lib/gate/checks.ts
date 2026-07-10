import type {
  AplusContent,
  CompliancePack,
  Failure,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';
import {
  hasNegationContext,
  normalize,
  scanTerms,
  subtractDisclaimers,
  termRegex,
  tokenSet,
  utf8Bytes,
} from './util';

/**
 * Verify-gate checks C1–C12, C15, C16 + A1–A8 as PURE functions.
 * C13/C14 are source-project-only and intentionally NOT implemented.
 * The gate REPORTS; it never mutates content.
 */

export interface GateContext {
  /** Subcategories detected for the snapshot (drives the C6 noun union). */
  subcategories: string[];
  /** Text used for the category-agnostic suspicion fail-closed check. */
  snapshotText?: string;
}

const fail = (checkId: string, field: string, context: string, fix: string): Failure => ({
  checkId,
  field,
  context: context.slice(0, 220),
  fix,
});

/** Customer-surface set (compliance-scanned fields). */
function customerSurfaces(l: OptimizedListing): [string, string][] {
  return [
    ['title', l.title],
    ['title75', l.title75],
    ['itemHighlights', l.itemHighlights],
    ['description', l.description],
    ['backendSearchTerms', l.backendSearchTerms],
    ...l.bullets.map((b, i) => [`bullets[${i}]`, b] as [string, string]),
  ];
}

/** Every A+ text field (headlines, bodies, subcopy, comparison cells, FAQ q/a). */
function aplusSurfaces(a: AplusContent): [string, string][] {
  const out: [string, string][] = [];
  a.modules.forEach((m) => {
    out.push([`aplus.modules[${m.id}].headline`, m.headline]);
    out.push([`aplus.modules[${m.id}].body`, m.body]);
    if (m.subcopy) out.push([`aplus.modules[${m.id}].subcopy`, m.subcopy]);
  });
  a.comparison.rows.forEach((r, i) => {
    out.push([`aplus.comparison[${i}].label`, r.label]);
    out.push([`aplus.comparison[${i}].ours`, r.ours]);
    out.push([`aplus.comparison[${i}].typical`, r.typical]);
  });
  a.faq.forEach((f, i) => {
    out.push([`aplus.faq[${i}].q`, f.q]);
    out.push([`aplus.faq[${i}].a`, f.a]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// C-series
// ---------------------------------------------------------------------------

export function c1TitleLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return l.title.length <= pack.rules.titleMaxLegacy
    ? []
    : [fail('C1', 'title', `${l.title.length} chars`, `Shorten title to ≤${pack.rules.titleMaxLegacy} chars`)];
}

export function c2Bullets(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (l.bullets.length !== pack.rules.bulletCount) {
    out.push(fail('C2', 'bullets', `${l.bullets.length} bullets`, `Exactly ${pack.rules.bulletCount} bullets required`));
  }
  l.bullets.forEach((b, i) => {
    if (b.length > pack.rules.bulletMax) {
      out.push(fail('C2', `bullets[${i}]`, `${b.length} chars`, `Shorten bullet to ≤${pack.rules.bulletMax} chars`));
    }
  });
  return out;
}

export function c3BackendBytes(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const bytes = utf8Bytes(l.backendSearchTerms);
  return bytes <= pack.rules.backendMaxBytes
    ? []
    : [fail('C3', 'backendSearchTerms', `${bytes} UTF-8 bytes`, `Reduce to ≤${pack.rules.backendMaxBytes} bytes — exceeding de-indexes the whole field`)];
}

export function c4DescriptionLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return l.description.length <= pack.rules.descriptionMax
    ? []
    : [fail('C4', 'description', `${l.description.length} chars`, `Shorten description to ≤${pack.rules.descriptionMax} chars`)];
}

export function c5Disclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const out: Failure[] = [];
  if (normalize(l.fdaDisclaimer) !== normalize(cp.disclaimer)) {
    out.push(fail('C5', 'fdaDisclaimer', l.fdaDisclaimer.slice(0, 80), 'fdaDisclaimer must equal the canonical constant verbatim'));
  }
  if (!normalize(l.description).includes(normalize(cp.disclaimer))) {
    out.push(fail('C5', 'description', 'disclaimer missing', 'The exact verbatim disclaimer must appear inside the description'));
  }
  return out;
}

/** Disease nouns for the detected subcategories: core + union of subcategory lists. */
export function activeDiseaseNouns(cp: CompliancePack, subcategories: string[]): string[] {
  const subs = subcategories.flatMap((s) => cp.diseaseNounsBySubcategory[s] ?? []);
  return [...new Set([...cp.coreDiseaseNouns, ...subs])];
}

/** Fail-closed rule — an empty disease-noun pack must never launder a pass. */
export function packFailClosed(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (cp) {
    const nonEmptySubs = ctx.subcategories.filter(
      (s) => (cp.diseaseNounsBySubcategory[s] ?? []).length > 0,
    );
    if (ctx.subcategories.length === 0 || nonEmptySubs.length === 0) {
      return [
        fail(
          'PACK',
          'compliance',
          `detected subcategories: [${ctx.subcategories.join(', ') || 'none'}]`,
          'compliance pack incomplete for this category — populate disease nouns before trusting a pass',
        ),
      ];
    }
    return [];
  }
  // No compliance module (e.g. generic pack): category-agnostic suspicion
  // check from PACK DATA. If the product smells like a regulated category,
  // fail closed instead of silently skipping compliance.
  const hay = normalize(
    `${ctx.snapshotText ?? ''} ${l.title} ${l.description}`,
  ).toLowerCase();
  const hit = pack.suspicionLexicon.find((t) => hay.includes(t.toLowerCase()));
  if (hit) {
    return [
      fail(
        'PACK',
        'compliance',
        `pack '${pack.id}' has no compliance module but product matches suspicion term '${hit}'`,
        'compliance pack incomplete for this category — route to a pack with a compliance module before trusting a pass',
      ),
    ];
  }
  return [];
}

function scanSurfacesForBanned(
  surfaces: [string, string][],
  cp: CompliancePack,
  nouns: string[],
  checkId: string,
): Failure[] {
  const out: Failure[] = [];
  const disclaimers = [cp.disclaimer, ...cp.auditAcceptDisclaimers];
  for (const [field, textRaw] of surfaces) {
    const text = subtractDisclaimers(normalize(textRaw), disclaimers.map(normalize));
    for (const m of scanTerms(text, nouns)) {
      out.push(fail(checkId, field, m.context, `Remove banned disease term '${m.term}' — reframe as a structure/function state`));
    }
    // treat/cure/prevent within ~25 chars of a disease noun
    for (const verb of cp.diseaseVerbs) {
      const vre = termRegex(verb);
      let vm: RegExpExecArray | null;
      while ((vm = vre.exec(text)) !== null) {
        if (hasNegationContext(text, vm.index)) continue;
        const windowText = text.slice(vm.index, vm.index + verb.length + 25);
        const nounHit = nouns.find((n) => termRegex(n).test(windowText));
        if (nounHit) {
          out.push(fail(checkId, field, text.slice(Math.max(0, vm.index - 30), vm.index + 60), `Drug-claim pattern '${verb} … ${nounHit}' — prohibited`));
        }
      }
    }
  }
  return out;
}

export function c6BannedTerms(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return []; // packFailClosed handles the no-module case
  const nouns = activeDiseaseNouns(cp, ctx.subcategories);
  return scanSurfacesForBanned(customerSurfaces(l), cp, nouns, 'C6');
}

/** Backend-only brand string must not leak into customer fields. */
export function c7BrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const productName = normalize(l.productName).toLowerCase();
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = l.attributes[key];
    if (!value) continue;
    const brand = normalize(value).toLowerCase();
    if (!brand || productName.includes(brand)) continue; // customer-facing brand — not backend-only
    for (const [field, text] of customerSurfaces(l)) {
      if (normalize(text).toLowerCase().includes(brand)) {
        out.push(fail('C7', field, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from customer copy`));
      }
    }
    for (const [attr, av] of Object.entries(l.attributes)) {
      if (attr === 'brand_name' || attr === 'manufacturer') continue;
      if (normalize(av).toLowerCase().includes(brand)) {
        out.push(fail('C7', `attributes.${attr}`, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from this attribute`));
      }
    }
  }
  return out;
}

export function c8ProductNameLead(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName);
  if (!normalize(l.title).startsWith(name)) {
    out.push(fail('C8', 'title', l.title.slice(0, 60), 'The customer product name must START the title'));
  }
  if (!normalize(l.description).includes(name)) {
    out.push(fail('C8', 'description', 'product name missing', 'The product name must appear in the description'));
  }
  return out;
}

/** Allergens present = any allergenRule whose source pattern matches the ingredients. */
export function presentAllergens(l: OptimizedListing, cp: CompliancePack) {
  const ingredients = normalize(
    `${l.attributes.ingredients ?? ''} ${l.attributes.allergen_information ?? ''}`,
  ).toLowerCase();
  return cp.allergenRules.filter((r) =>
    new RegExp(`\\b(?:${r.source})\\b`, 'i').test(ingredients),
  );
}

/** Order-independent matcher: 'contains' + class-or-source tokens co-occur. */
function allergenMentioned(text: string, rule: { class: string; source: string }): boolean {
  const t = normalize(text).toLowerCase();
  const classRe = new RegExp(`\\b${rule.class.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const sourceRe = new RegExp(`\\b(?:${rule.source})\\b`, 'i');
  return /contains/.test(t) && (classRe.test(t) || sourceRe.test(t));
}

export function c9Allergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const out: Failure[] = [];
  const all = `${l.title} ${l.description} ${l.bullets.join(' ')} ${Object.values(l.attributes).join(' ')}`;
  const present = presentAllergens(l, cp);
  if (present.length === 0) {
    return [];
  }
  if (/no known allergens/i.test(all)) {
    out.push(fail('C9', 'attributes.allergen_information', '"No Known Allergens" used', 'Never use "No Known Allergens" when a declarable allergen is present'));
  }
  for (const rule of present) {
    if (l.attributes.allergen_information !== rule.canonicalString) {
      out.push(fail('C9', 'attributes.allergen_information', l.attributes.allergen_information ?? '(empty)', `allergen_information must equal exactly '${rule.canonicalString}'`));
    }
    if (!l.bullets.some((b) => allergenMentioned(b, rule))) {
      out.push(fail('C9', 'bullets', `no bullet declares ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in at least one bullet`));
    }
    if (!allergenMentioned(l.description, rule)) {
      out.push(fail('C9', 'description', `description does not declare ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in the description`));
    }
  }
  return out;
}

const PER_SERVING_RE = /(\d[\d,.]*)\s*(mg|mcg|g|iu|cfu|billion(?:\s+cfu)?)\b[^.]{0,40}?\bper\s+serving/gi;
const DELIVERS_RE = /\b(delivers?|provides?|contains?)\b[^.]{0,40}?(\d[\d,.]*)\s*(mg|mcg|g|iu|cfu|billion(?:\s+cfu)?)\b[^.]{0,30}?\bper\s+serving/gi;

export function c10PotencyPhrasing(l: OptimizedListing): Failure[] {
  return potencyPhrasingOver(customerSurfaces(l), 'C10');
}

function potencyPhrasingOver(surfaces: [string, string][], checkId: string): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    for (const re of [PER_SERVING_RE, DELIVERS_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!hasNegationContext(text, m.index)) {
          out.push(fail(checkId, field, m[0], 'Attach the headline potency to the blend/formula, never "per serving"'));
        }
      }
    }
  }
  return out;
}

export function c11FictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return []; // no-op when empty
  return fictionOver(customerSurfaces(l), cp, 'C11');
}

function fictionOver(surfaces: [string, string][], cp: CompliancePack, checkId: string): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    for (const m of scanTerms(text, cp.fictionPhrases)) {
      out.push(fail(checkId, field, m.context, `Known-false descriptor '${m.term}' must never resurface`));
    }
  }
  return out;
}

// --- C12: unit-anchored fact consistency ---

type Dimension = 'potency' | 'count' | 'days';

const UNIT_DIMENSION: [RegExp, Dimension][] = [
  [/^(mg|mcg|g|iu)$/i, 'potency'],
  [/^(billion\s+cfu|billion|cfu)$/i, 'potency'],
  [/^(capsule|capsules|gummy|gummies|softgel|softgels|tablet|tablets|count)$/i, 'count'],
  [/^(day|days)$/i, 'days'],
];

interface UnitNumber {
  value: number;
  unit: string;
  dimension: Dimension;
  raw: string;
  index: number;
}

export function extractUnitNumbers(text: string): UnitNumber[] {
  const out: UnitNumber[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)[\s-]*(billion\s+cfu|billion|mg|mcg|g|iu|cfu|capsules?|gummies|gummy|softgels?|tablets?|count|days?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const numStr = m[1];
    const unitStr = m[2];
    if (!numStr || !unitStr) continue;
    const dim = UNIT_DIMENSION.find(([u]) => u.test(unitStr))?.[1];
    if (!dim) continue;
    out.push({
      value: Number.parseFloat(numStr.replace(/,/g, '')),
      unit: unitStr.toLowerCase().replace(/\s+/g, ' '),
      dimension: dim,
      raw: m[0],
      index: m.index,
    });
  }
  return out;
}

function parsePotencyFact(potency: string | undefined): UnitNumber | null {
  if (!potency) return null;
  const nums = extractUnitNumbers(potency);
  return nums[0] ?? null;
}

export function c12FactConsistency(l: OptimizedListing): Failure[] {
  return factConsistencyOver(customerSurfaces(l), l, 'C12');
}

function factConsistencyOver(
  surfaces: [string, string][],
  l: OptimizedListing,
  checkId: string,
): Failure[] {
  const out: Failure[] = [];
  const facts = l.facts;
  const potencyFact = parsePotencyFact(facts.potency);
  const allowedCounts = new Set<number>(
    [facts.unitCount, facts.servings, facts.daySupply, facts.formulaCount,
      ...(facts.servingSize ? extractUnitNumbers(facts.servingSize).map((n) => n.value) : []),
      // small per-day quantities are legitimate ("one/two capsules daily")
      1, 2, 3, 4,
    ].filter((n): n is number => typeof n === 'number'),
  );
  const allowedDays = new Set<number>(
    [facts.daySupply].filter((n): n is number => typeof n === 'number'),
  );

  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    const nums = extractUnitNumbers(text);

    // potency: any potency-dimension number with the SAME unit as the fact must match it
    if (potencyFact) {
      const sameUnit = nums.filter(
        (n) => n.dimension === 'potency' && unitFamily(n.unit) === unitFamily(potencyFact.unit),
      );
      for (const n of sameUnit) {
        if (n.value !== potencyFact.value) {
          out.push(fail(checkId, field, n.raw, `Potency '${n.raw}' disagrees with canonical facts.potency '${facts.potency}'`));
        }
      }
      // internal conflict: two different values in the same unit family within one surface
      const distinct = new Set(sameUnit.map((n) => n.value));
      if (distinct.size > 1) {
        out.push(fail(checkId, field, [...distinct].join(' vs '), 'Two different potency figures in one surface — internal conflict'));
      }
    }

    for (const n of nums) {
      if (n.dimension === 'count' && allowedCounts.size > 0 && !allowedCounts.has(n.value)) {
        out.push(fail(checkId, field, n.raw, `Count '${n.raw}' matches no canonical fact (unitCount=${facts.unitCount}, servings=${facts.servings})`));
      }
      if (n.dimension === 'days' && allowedDays.size > 0 && !allowedDays.has(n.value)) {
        out.push(fail(checkId, field, n.raw, `Day figure '${n.raw}' disagrees with facts.daySupply=${facts.daySupply}`));
      }
    }
  }
  return out;
}

function unitFamily(unit: string): string {
  if (/billion|cfu/.test(unit)) return 'cfu';
  return unit;
}

export function c15NewTitlePolicy(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (l.title75.length > pack.rules.title75Max) {
    out.push(fail('C15', 'title75', `${l.title75.length} chars`, `title75 must be ≤${pack.rules.title75Max} chars`));
  }
  if (!normalize(l.title75).startsWith(normalize(l.productName))) {
    out.push(fail('C15', 'title75', l.title75.slice(0, 60), 'title75 must start with the product name'));
  }
  if (l.itemHighlights.length > pack.rules.itemHighlightsMax) {
    out.push(fail('C15', 'itemHighlights', `${l.itemHighlights.length} chars`, `itemHighlights must be ≤${pack.rules.itemHighlightsMax} chars`));
  }
  return out;
}

/** C16 (quality, deterministic): backend terms must not repeat title-surface words. */
export function c16BackendDedup(l: OptimizedListing): Failure[] {
  const titleTokens = tokenSet(`${l.title} ${l.title75} ${l.itemHighlights}`);
  const backendTokens = tokenSet(l.backendSearchTerms);
  const overlap = [...backendTokens].filter((t) => titleTokens.has(t));
  return overlap.length === 0
    ? []
    : [fail('C16', 'backendSearchTerms', overlap.join(', '), 'Backend search terms must not repeat any title/title75/itemHighlights word — replace with synonyms/misspellings/other-language variants')];
}

// ---------------------------------------------------------------------------
// A-series (over AplusContent)
// ---------------------------------------------------------------------------

export function a1AplusDisclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const a = l.aplusContent;
  const out: Failure[] = [];
  if (normalize(a.fdaDisclaimer) !== normalize(cp.disclaimer)) {
    out.push(fail('A1', 'aplus.fdaDisclaimer', a.fdaDisclaimer.slice(0, 80), 'A+ fdaDisclaimer must equal the canonical constant verbatim'));
  }
  const want = normalize(cp.disclaimer);
  for (const m of a.modules) {
    if (m.claimBearing && !normalize(m.body).includes(want)) {
      out.push(fail('A1', `aplus.modules[${m.id}]`, 'claim-bearing module missing disclaimer', 'Each claim-bearing A+ module must contain the verbatim disclaimer'));
    }
  }
  a.faq.forEach((f, i) => {
    if (f.claimBearing && !normalize(f.a).includes(want)) {
      out.push(fail('A1', `aplus.faq[${i}]`, 'claim-bearing FAQ answer missing disclaimer', 'Each claim-bearing FAQ answer must contain the verbatim disclaimer'));
    }
  });
  return out;
}

export function a2AplusBannedTerms(l: OptimizedListing, pack: KnowledgePack, ctx: GateContext): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const nouns = activeDiseaseNouns(cp, ctx.subcategories);
  return scanSurfacesForBanned(aplusSurfaces(l.aplusContent), cp, nouns, 'A2');
}

export function a3AplusBrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const productName = normalize(l.productName).toLowerCase();
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = l.attributes[key];
    if (!value) continue;
    const brand = normalize(value).toLowerCase();
    if (!brand || productName.includes(brand)) continue;
    for (const [field, text] of aplusSurfaces(l.aplusContent)) {
      if (normalize(text).toLowerCase().includes(brand)) {
        out.push(fail('A3', field, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from A+ content`));
      }
    }
  }
  return out;
}

export function a4AplusProductName(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName).toLowerCase();
  const a = l.aplusContent;
  const brandStory = a.modules.find((m) => m.id.includes('brand'));
  const hero = a.modules.find((m) => m.id.includes('hero')) ?? a.modules[0];
  if (!brandStory || !normalize(`${brandStory.headline} ${brandStory.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', 'aplus.modules[brand-story]', brandStory ? 'product name missing' : 'no brand-story module', 'Product name must appear in the Brand-Story module'));
  }
  if (!hero || !normalize(`${hero.headline} ${hero.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', 'aplus.modules[hero]', hero ? 'product name missing' : 'no hero module', 'Product name must appear in the hero module'));
  }
  return out;
}

export function a5AplusPotencyPhrasing(l: OptimizedListing): Failure[] {
  return potencyPhrasingOver(aplusSurfaces(l.aplusContent), 'A5');
}

export function a6AplusFictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return [];
  return fictionOver(aplusSurfaces(l.aplusContent), cp, 'A6');
}

export function a7AplusAllergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const present = presentAllergens(l, cp);
  if (present.length === 0) return [];
  const ingredientsModule = l.aplusContent.modules.find((m) => m.id.includes('ingredient'));
  const out: Failure[] = [];
  for (const rule of present) {
    const text = ingredientsModule ? `${ingredientsModule.headline} ${ingredientsModule.body} ${ingredientsModule.subcopy ?? ''}` : '';
    if (!ingredientsModule || !allergenMentioned(text, rule)) {
      out.push(fail('A7', 'aplus.modules[ingredients]', ingredientsModule ? `does not declare ${rule.class}` : 'no ingredients module', `Declare the allergen ('${rule.canonicalString}') in the A+ ingredients module`));
    }
  }
  return out;
}

const A8_PATTERNS: [RegExp, string][] = [
  [/\$\s*\d/g, 'price / $ figure'],
  [/\b(?:cents?|dollars?)\s+(?:a|per)\s+day\b/gi, 'per-day price framing'],
  [/\bbuy\s+now\b/gi, '"buy now" CTA'],
  [/\bsubscribe\s*(?:&|and)\s*save\b/gi, '"subscribe & save"'],
  [/\bhurry\b/gi, 'urgency'],
  [/\btoday\s+only\b/gi, 'urgency'],
  [/\blimited\s+time\b/gi, 'urgency'],
  [/\bmoney[- ]back\b/gi, 'guarantee'],
  [/\bguarantee[ds]?\b/gi, 'guarantee'],
  [/#\s?1\b/g, '"#1" claim'],
  [/\bbest[- ]?sell(?:er|ing)\b/gi, 'best-seller claim'],
  [/\b\d(?:\.\d)?\s*[- ]?star\b/gi, 'star-rating claim'],
  [/\b[\d,]+\+?\s*(?:customer\s+)?reviews\b/gi, 'review-count claim'],
];

export function a8AplusProhibitedMarketing(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of aplusSurfaces(l.aplusContent)) {
    const text = normalize(textRaw);
    for (const [re, label] of A8_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!hasNegationContext(text, m.index)) {
          out.push(fail('A8', field, m[0], `Prohibited A+ marketing: ${label}`));
        }
      }
    }
  }
  return out;
}
