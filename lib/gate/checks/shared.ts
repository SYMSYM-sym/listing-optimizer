import type { AplusContent, CompliancePack, Failure, OptimizedListing } from '@/lib/types';
import { hasNegationContext, normalize, scanTerms, subtractDisclaimers, termRegex } from '../util';

export const fail = (checkId: string, field: string, context: string, fix: string): Failure => ({
  checkId,
  field,
  context: context.slice(0, 220),
  fix,
});

/** Customer-surface set (compliance-scanned fields — every buyer-facing surface). */
export function customerSurfaces(l: OptimizedListing): [string, string][] {
  const out: [string, string][] = [
    ['title', l.title],
    ['title75', l.title75],
    ['itemHighlights', l.itemHighlights],
    ['description', l.description],
    ['backendSearchTerms', l.backendSearchTerms],
    ...l.bullets.map((b, i) => [`bullets[${i}]`, b] as [string, string]),
  ];
  // Q&A (brain/02 + brain/05: disease terms banned on every surface including Q&A)
  l.qa.forEach((item, i) => {
    out.push([`qa[${i}].q`, item.q]);
    out.push([`qa[${i}].a`, item.a]);
  });
  // Image plan copy can also carry claims
  l.imagePlan.forEach((slot, i) => {
    out.push([`imagePlan[${i}].purpose`, slot.purpose]);
    out.push([`imagePlan[${i}].spec`, slot.spec]);
    out.push([`imagePlan[${i}].notes`, slot.notes]);
  });
  // Attribute values (disclaimer constant is subtracted by scanSurfacesForBanned).
  // Skip brand_name/manufacturer — backend-only identity fields checked by C7 separately.
  for (const [key, value] of Object.entries(l.attributes)) {
    if (key === 'brand_name' || key === 'manufacturer') continue;
    out.push([`attributes.${key}`, value]);
  }
  return out;
}

/** Every A+ text field (headlines, bodies, subcopy, comparison cells, FAQ q/a). */
export function aplusSurfaces(a: AplusContent): [string, string][] {
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

export function scanSurfacesForBanned(
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

export const PER_SERVING_RE = /(\d[\d,.]*)\s*(mg|mcg|g|iu|cfu|billion(?:\s+cfu)?)\b[^.]{0,40}?\bper\s+serving/gi;
export const DELIVERS_RE = /\b(delivers?|provides?|contains?)\b[^.]{0,40}?(\d[\d,.]*)\s*(mg|mcg|g|iu|cfu|billion(?:\s+cfu)?)\b[^.]{0,30}?\bper\s+serving/gi;

export function potencyPhrasingOver(surfaces: [string, string][], checkId: string): Failure[] {
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

export function fictionOver(surfaces: [string, string][], cp: CompliancePack, checkId: string): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    for (const m of scanTerms(text, cp.fictionPhrases)) {
      out.push(fail(checkId, field, m.context, `Known-false descriptor '${m.term}' must never resurface`));
    }
  }
  return out;
}

export type Dimension = 'potency' | 'count' | 'days';

const UNIT_DIMENSION: [RegExp, Dimension][] = [
  [/^(mg|mcg|g|iu)$/i, 'potency'],
  [/^(billion\s+cfu|billion|cfu)$/i, 'potency'],
  [/^(capsule|capsules|gummy|gummies|softgel|softgels|tablet|tablets|count)$/i, 'count'],
  [/^(day|days)$/i, 'days'],
];

export interface UnitNumber {
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

function unitFamily(unit: string): string {
  if (/billion|cfu/.test(unit)) return 'cfu';
  return unit;
}

export function factConsistencyOver(
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
      1, 2, 3, 4,
    ].filter((n): n is number => typeof n === 'number'),
  );
  const allowedDays = new Set<number>(
    [facts.daySupply].filter((n): n is number => typeof n === 'number'),
  );

  for (const [field, textRaw] of surfaces) {
    const text = normalize(textRaw);
    const nums = extractUnitNumbers(text);

    if (potencyFact) {
      const sameUnit = nums.filter(
        (n) => n.dimension === 'potency' && unitFamily(n.unit) === unitFamily(potencyFact.unit),
      );
      for (const n of sameUnit) {
        if (n.value !== potencyFact.value) {
          out.push(fail(checkId, field, n.raw, `Potency '${n.raw}' disagrees with canonical facts.potency '${facts.potency}'`));
        }
      }
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
