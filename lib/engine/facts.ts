import type { Facts, KnowledgePack, ListingSnapshot, UnitRules } from '@/lib/types';
import { SERVING_SIZE_MAX } from '@/lib/gate/checks/shared';

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

/**
 * Unit-anchored CONTAINER-COUNT extraction — "120 Capsules", "120 Count",
 * "120 ct", "120 Tablets". Every token comes off `rules.units.dimensions.count`
 * (PACK DATA), so this module still names no dosage form.
 *
 * WHY: `facts.unitCount` used to be read from the structured unit-count
 * attribute ONLY. A live snapshot whose attributes lacked that key — while its
 * TITLE ended "…, 120 Capsules" — produced facts of `{price, formulaCount}`,
 * and C12 then failed the truthful attribute "120 Count" for disagreeing with
 * facts that never held the count at all. The title and the remaining
 * snapshot attributes are now read as fallbacks, with two disciplines kept:
 *  - unit-anchored only: a bare number is never a count;
 *  - the LAST qualifying match wins in a title (the title-tail pattern —
 *    "…, 120 Capsules" sits at the end), and figures at or below
 *    `SERVING_SIZE_MAX` are ignored so serving phrasing ("2 Capsules Daily")
 *    can never masquerade as the container count.
 */
export function extractUnitCount(text: string, countUnits: string[]): number | undefined {
  const units = alternationSource(countUnits);
  if (!units || !text) return undefined;
  const re = new RegExp(`(?<![a-z0-9.])(\\d[\\d,]*)[\\s-]*(?:${units})(?![a-z])`, 'gi');
  let out: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number.parseInt(m[1]!.replace(/,/g, ''), 10);
    if (Number.isFinite(value) && value > SERVING_SIZE_MAX) out = value;
  }
  return out;
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

/**
 * WS5.5 — `panel` is the OPERATOR-CONFIRMED label reading for this run. When
 * supplied it OVERLAYS the scraped attributes of the same keys, so every fact
 * derived below is the operator's value in preference to the page's. Absent =>
 * `a` is the caller's own object, unchanged, and the whole producer is
 * byte-identical to what it was. See `lib/knowledge/panelFacts.ts`.
 */
export function buildFacts(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  panel?: Readonly<Record<string, string>>,
): Facts {
  const a = panel ? { ...snapshot.attributes, ...panel } : snapshot.attributes;
  const f = pack.rules.factFields;
  const units: UnitRules = pack.rules.units;
  const potencyUnits = units.dimensions?.potency ?? [];

  const countUnits = units.dimensions?.count ?? [];
  // Attribute values that may carry the container count. The serving-size and
  // directions attributes are excluded BY KEY (pack data): their counts are
  // per-dose figures, not the container count.
  const countAttrSources = Object.entries(a)
    .filter(([key]) => key !== f.unitCount && key !== f.servingSize && key !== f.directions)
    .map(([, value]) => value ?? '');
  const unitCount =
    parseLeadingNumber(a[f.unitCount]) ??
    extractUnitCount(snapshot.title, countUnits) ??
    countAttrSources
      .map((source) => extractUnitCount(source, countUnits))
      .find((n) => n !== undefined);
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
