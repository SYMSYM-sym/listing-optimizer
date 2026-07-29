import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * CATEGORY-AGNOSTICISM ENFORCER.
 *
 * The engine and the gate must hold NO domain lexicon: every category-specific
 * word lives in `knowledge/*.json` pack data. The previous version of this
 * guard grepped 2–3 strings in `lib/engine` only, which is why hard-coded
 * supplement units ("mg|mcg|cfu"), dosage forms ("capsule|gummy|softgel"), the
 * phrase "per serving", the attribute keys `ingredients` /
 * `allergen_information` and the literal "No Known Allergens" survived inside
 * `lib/gate`.
 *
 * This scan covers BOTH `lib/engine/**` and `lib/gate/**`, strips comments
 * (which may legitimately explain a rule) and fails on any remaining
 * occurrence. See ALLOWLIST below — it has exactly one entry.
 */

const ROOTS = ['lib/engine', 'lib/gate'];

/**
 * The ONLY allowed occurrence. `fdaDisclaimer` is a field name in the shipped
 * OUTPUT CONTRACT (`OptimizedListing` / `AplusContent`) and is persisted inside
 * every stored run's jsonb, so renaming it would break already-saved history.
 * It carries no lexicon: the disclaimer TEXT is pack data
 * (`compliancePack.disclaimer`) and the gate only ever compares against that.
 */
const ALLOWLIST = ['fdaDisclaimer'];

/**
 * Pure DATA words. None of these can legitimately be an identifier, a message
 * or a pattern in category-agnostic code — if one appears, a lexicon leaked in.
 */
const DOMAIN_LITERALS = [
  // category + product-form vocabulary
  'supplement',
  'probiotic',
  'capsule',
  'gummy',
  'gummies',
  'softgel',
  'tablet',
  // measurement units
  'cfu',
  'mcg',
  'billion cfu',
  // dosage phrasing
  'per serving',
  'per dose',
  // allergen phrasing
  'no known allergens',
  // regulator
  'fda',
  // marketing phrases
  'buy now',
  'shop now',
  'subscribe',
  'money-back',
  'money back',
  'best seller',
  'bestseller',
  'free shipping',
  'top rated',
  'clearance',
];

/** Attribute KEYS that name a category's label fields. */
const DOMAIN_ATTRIBUTE_KEYS = ['ingredients', 'active_ingredients', 'allergen_information'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Remove `//` and block comments while leaving strings, template literals and
 * regex literals intact (a lexicon hidden in a regex must still be caught).
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const d = src[i]!;
        out += d;
        i++;
        if (d === '\\') {
          if (i < src.length) {
            out += src[i];
            i++;
          }
          continue;
        }
        if (d === quote) break;
      }
      prevSignificant = quote;
      continue;
    }
    // regex literal: a '/' in a position where a value may start
    if (c === '/' && (prevSignificant === '' || '(,=:[!&|?{};+-*%~^'.includes(prevSignificant))) {
      out += c;
      i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i]!;
        out += d;
        i++;
        if (d === '\\') {
          if (i < src.length) {
            out += src[i];
            i++;
          }
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      prevSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

/**
 * Regex whitespace atoms collapse to a real space so a lexicon cannot hide as
 * `per\\s+serving` / `billion\\s+cfu` inside a pattern.
 */
export function flattenPatternWhitespace(code: string): string {
  return code.replace(/\\+s[+*]?/g, ' ');
}

function codeOf(file: string): string {
  let code = stripComments(readFileSync(file, 'utf8'));
  for (const allowed of ALLOWLIST) code = code.split(allowed).join('');
  return flattenPatternWhitespace(code);
}

const FILES = ROOTS.flatMap((r) => walk(join(process.cwd(), r)));

describe('lib/engine + lib/gate hold NO domain lexicon', () => {
  it('scans every source file under both roots', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('the comment stripper keeps strings and regex literals', () => {
    expect(stripComments("const a = 'x'; // capsule\n")).toBe("const a = 'x'; \n");
    expect(stripComments('/* capsule */ const re = /mg|mcg/;')).toBe(' const re = /mg|mcg/;');
    expect(stripComments("const re = /[^a-z'-]/g; // note\n")).toContain("/[^a-z'-]/g");
    expect(flattenPatternWhitespace('/per\\s+serving/')).toBe('/per serving/');
  });

  for (const literal of DOMAIN_LITERALS) {
    it(`no source outside comments contains "${literal}"`, () => {
      const offenders = FILES.filter((f) => codeOf(f).toLowerCase().includes(literal)).map((f) =>
        relative(process.cwd(), f),
      );
      expect(offenders, `"${literal}" must live in knowledge/*.json, not in code`).toEqual([]);
    });
  }

  for (const key of DOMAIN_ATTRIBUTE_KEYS) {
    it(`no source reads the attribute key "${key}" directly`, () => {
      const patterns = [
        // any property access — `a.active_ingredients`, `l.attributes.ingredients`
        new RegExp(`\\.\\s*${key}\\b`),
        new RegExp(`\\[\\s*['"\`]${key}['"\`]`),
        new RegExp(`['"\`]${key}['"\`]`),
      ];
      const offenders = FILES.filter((f) => {
        const code = codeOf(f);
        return patterns.some((re) => re.test(code));
      }).map((f) => relative(process.cwd(), f));
      expect(offenders, `attribute key "${key}" must come from compliancePack.allergenFields`).toEqual([]);
    });
  }

  it('the enforcer actually CATCHES the pre-fix code (not a vacuous pass)', () => {
    // Verbatim from the shipped lib/gate/checks/shared.ts + c-quality.ts.
    const preFix = [
      "export const PER_SERVING_RE = /(\\d[\\d,.]*)\\s*(mg|mcg|g|iu|cfu|billion(?:\\s+cfu)?)\\b[^.]{0,40}?\\bper\\s+serving/gi;",
      "const UNIT_DIMENSION = [[/^(capsule|capsules|gummy|gummies|softgel|tablet)$/i, 'count']];",
      "const ingredients = normalize(`${l.attributes.ingredients ?? ''} ${l.attributes.allergen_information ?? ''}`);",
      "const formulaCount = extractFormulaCount(a.active_ingredients ?? '');",
      "if (/no known allergens/i.test(all)) { out.push(fail('C9', 'attributes.allergen_information', '\"No Known Allergens\" used', '')); }",
    ].join('\n');
    const code = flattenPatternWhitespace(stripComments(preFix)).toLowerCase();
    const caught = DOMAIN_LITERALS.filter((l) => code.includes(l));
    expect(caught).toEqual(
      expect.arrayContaining(['capsule', 'gummy', 'gummies', 'softgel', 'tablet', 'cfu', 'mcg', 'per serving', 'no known allergens']),
    );
    for (const key of DOMAIN_ATTRIBUTE_KEYS) {
      expect(
        new RegExp(`\\.\\s*${key}\\b`).test(code) || new RegExp(`['\"\`]${key}['\"\`]`).test(code),
        key,
      ).toBe(true);
    }
  });

  it('the allowlist stays at exactly one documented entry', () => {
    expect(ALLOWLIST).toEqual(['fdaDisclaimer']);
  });
});
