import type { Facts, ListingSnapshot } from '@/lib/types';

/**
 * DETERMINISTIC Facts producer — the canonical numeric truths every surface
 * must agree with (C12). Reads the snapshot's structured attributes first;
 * derived values are computed once here. Facts are never LLM-guessed.
 */

function parseLeadingNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? Number.parseFloat(m[1]) : undefined;
}

/** Extract a unit-anchored potency phrase (e.g. "50 Billion CFU", "1000 mg"). */
export function extractPotency(
  text: string,
  factUnits: string[],
): string | undefined {
  const units = [...factUnits].sort((a, b) => b.length - a.length);
  for (const unit of units) {
    if (!/^(mg|mcg|g|iu|cfu|billion cfu|billion)$/i.test(unit)) continue;
    const re = new RegExp(
      `(\\d[\\d,.]*)\\s*(${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`,
      'i',
    );
    const m = text.match(re);
    if (m?.[1] && m[2]) {
      const num = m[1].replace(/,/g, '');
      const idx = m.index ?? 0;
      const after = text.slice(idx + m[0].length, idx + m[0].length + 8);
      const suffix = /^\s*cfu/i.test(after) ? `${m[2]} CFU` : m[2];
      return `${num} ${suffix}`.replace(/\s+/g, ' ');
    }
  }
  return undefined;
}

/** Parse "10 strains" / "10-in-1" style blend counts from label copy. */
export function extractFormulaCount(text: string): number | undefined {
  const strain = text.match(/(\d+)\s*-?\s*strains?\b/i);
  if (strain?.[1]) return Number.parseInt(strain[1], 10);
  const inOne = text.match(/\b(\d+)\s*in\s*1\b/i);
  if (inOne?.[1]) return Number.parseInt(inOne[1], 10);
  return undefined;
}

/** Parse "take 1 capsule daily" style directions → units consumed per day. */
export function parsePerDay(directions: string | undefined): number | undefined {
  if (!directions) return undefined;
  const d = directions.toLowerCase();
  const m = d.match(
    /(\d+)\s*(?:capsule|capsules|gummy|gummies|softgel|softgels|tablet|tablets|scoop|scoops)s?[^.]{0,40}?(?:daily|per day|a day|each day)/,
  );
  if (m?.[1]) return Number.parseInt(m[1], 10);
  if (/(?:daily|per day|a day|once a day)/.test(d)) return 1;
  return undefined;
}

export function buildFacts(snapshot: ListingSnapshot, factUnits: string[]): Facts {
  const a = snapshot.attributes;

  const unitCount = parseLeadingNumber(a.unit_count);
  const servings = parseLeadingNumber(a.servings_per_container);
  const servingSize = a.serving_size?.trim();

  const perDay =
    parsePerDay(a.directions_for_use) ??
    (servingSize ? parseLeadingNumber(servingSize) : undefined);

  let daySupply: number | undefined;
  if (unitCount && perDay && perDay > 0) {
    daySupply = Math.floor(unitCount / perDay);
  } else if (servings) {
    daySupply = Math.floor(servings);
  }

  const potency =
    extractPotency(a.maximum_dosage ?? '', factUnits) ??
    extractPotency(snapshot.title, factUnits);

  const formulaCount =
    extractFormulaCount(a.active_ingredients ?? '') ??
    extractFormulaCount(a.maximum_dosage ?? '') ??
    extractFormulaCount(snapshot.title) ??
    extractFormulaCount(snapshot.description);

  const facts: Facts = {};
  if (potency) facts.potency = potency;
  if (formulaCount) facts.formulaCount = formulaCount;
  if (unitCount) facts.unitCount = unitCount;
  if (servings) facts.servings = servings;
  if (servingSize) facts.servingSize = servingSize;
  if (daySupply) facts.daySupply = daySupply;
  if (a.item_weight) facts.weight = a.item_weight.trim();
  const price = a.standard_price ?? snapshot.price;
  if (price) facts.price = price;
  return facts;
}
