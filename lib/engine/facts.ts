import type { Facts, KnowledgePack, ListingSnapshot, UnitRules } from '@/lib/types';

/**
 * DETERMINISTIC Facts producer — the canonical numeric truths every surface
 * must agree with (C12). Reads the snapshot's structured attributes first;
 * derived values are computed once here. Facts are never LLM-guessed.
 *
 * Every unit, dosage form and attribute key it needs is PACK DATA
 * (`rules.units`, `rules.factFields`) — this module holds no category lexicon.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest-first alternation source for pack tokens (inner whitespace flexible). */
function alternationSource(tokens: string[]): string {
  return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRe(t).replace(/\s+/g, '\\s+'))
    .join('|');
}

function parseLeadingNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? Number.parseFloat(m[1]) : undefined;
}

/**
 * Extract a unit-anchored potency phrase (e.g. "50 Billion CFU", "1000 mg").
 * `potencyUnits` comes from `rules.units.dimensions.potency`.
 */
export function extractPotency(
  text: string,
  potencyUnits: string[],
): string | undefined {
  // Longest-first so a compound unit ("50 Billion CFU") wins over its prefix.
  const units = [...potencyUnits].sort((a, b) => b.length - a.length);
  for (const unit of units) {
    const re = new RegExp(`(\\d[\\d,.]*)\\s*(${escapeRe(unit.trim()).replace(/\s+/g, '\\s+')})\\b`, 'i');
    const m = text.match(re);
    if (m?.[1] && m[2]) {
      return `${m[1].replace(/,/g, '')} ${m[2]}`.replace(/\s+/g, ' ');
    }
  }
  return undefined;
}

/** Parse "10 strains" / "10-in-1" style blend counts from label copy. */
export function extractFormulaCount(text: string): number | undefined {
  const strain = text.match(/(\d+)\s*-?\s*strains?\b/i);
  if (strain?.[1]) return Number.parseInt(strain[1], 10);
  const inOne = text.match(/\b(\d+)\s*-?\s*in\s*-?\s*1\b/i);
  if (inOne?.[1]) return Number.parseInt(inOne[1], 10);
  return undefined;
}

/**
 * Parse "take 1 <dosage form> daily" style directions → units consumed per day.
 * The dosage-form vocabulary is PACK DATA (`rules.units.dosageForms`).
 */
export function parsePerDay(
  directions: string | undefined,
  dosageForms: string[],
): number | undefined {
  if (!directions) return undefined;
  const d = directions.toLowerCase();
  const forms = alternationSource(dosageForms);
  if (forms) {
    const m = d.match(
      new RegExp(`(\\d+)\\s*(?:${forms})s?[^.]{0,40}?(?:daily|per day|a day|each day)`),
    );
    if (m?.[1]) return Number.parseInt(m[1], 10);
  }
  if (/(?:daily|per day|a day|once a day)/.test(d)) return 1;
  return undefined;
}

export function buildFacts(snapshot: ListingSnapshot, pack: KnowledgePack): Facts {
  const a = snapshot.attributes;
  const f = pack.rules.factFields;
  const units: UnitRules = pack.rules.units;
  const potencyUnits = units.dimensions?.potency ?? [];

  const unitCount = parseLeadingNumber(a[f.unitCount]);
  const servings = parseLeadingNumber(a[f.servings]);
  const servingSize = a[f.servingSize]?.trim();

  const perDay =
    parsePerDay(a[f.directions], units.dosageForms ?? []) ??
    (servingSize ? parseLeadingNumber(servingSize) : undefined);

  let daySupply: number | undefined;
  if (unitCount && perDay && perDay > 0) {
    daySupply = Math.floor(unitCount / perDay);
  } else if (servings) {
    daySupply = Math.floor(servings);
  }

  const potencySources = [...f.potencySources.map((k) => a[k] ?? ''), snapshot.title];
  let potency: string | undefined;
  for (const source of potencySources) {
    potency = extractPotency(source, potencyUnits);
    if (potency) break;
  }

  const formulaSources = [
    ...f.formulaCountSources.map((k) => a[k] ?? ''),
    snapshot.title,
    snapshot.description,
  ];
  let formulaCount: number | undefined;
  for (const source of formulaSources) {
    formulaCount = extractFormulaCount(source);
    if (formulaCount) break;
  }

  const facts: Facts = {};
  if (potency) facts.potency = potency;
  if (formulaCount) facts.formulaCount = formulaCount;
  if (unitCount) facts.unitCount = unitCount;
  if (servings) facts.servings = servings;
  if (servingSize) facts.servingSize = servingSize;
  if (daySupply) facts.daySupply = daySupply;
  const weight = a[f.weight];
  if (weight) facts.weight = weight.trim();
  const price = a[f.price] ?? snapshot.price;
  if (price) facts.price = price;
  return facts;
}
