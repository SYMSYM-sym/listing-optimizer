import type { AttributeField, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { presentAllergens } from './c-quality';
import { fail } from './shared';

/**
 * C23 — ATTRIBUTE DISCIPLINE (pack-driven; the schema is
 * `pack.attributeSchema` and the allergen phrasing is `compliancePack`, so
 * this module names no attribute key and no allergen phrase of its own).
 *
 * WHY: a live run produced 29 of the 35 schema attributes and still came back
 * with no signal about it — a previous run had filled all 35, so the loss was
 * pure regression that nothing enforced. Attributes are the DISCOVERY surface
 * (filter facets power customer-facing filters and COSMO retrieval), so a
 * silently missing one is lost surface, not a cosmetic gap.
 *
 * FOUR RULES, all pack-driven:
 *
 *  R1 COMPLETENESS —
 *   - a schema field marked `required` that is missing or blank is a FAILURE;
 *   - a FILTER-FACET field (`filterFacet: true`) that is missing or blank is a
 *     FAILURE even when the schema marks it optional — facets are the
 *     discovery surface and an empty one excludes the listing from filters;
 *   - every OTHER schema field (optional, non-facet) is NOT a gate failure
 *     when missing: it is reported as an audit GAP instead
 *     (`lib/audit/diff.ts`), because the schema itself declares it
 *     inapplicable-able. The generator is still instructed to fill every
 *     field, using the explicit none-style value the schema example shows.
 *
 *  R2 OPERATOR EXEMPTION — a field the schema marks `source: 'operator'` is
 *   never reported missing, whatever its `required`/`filterFacet` flags say.
 *   The app CANNOT know a price, a SKU, a GTIN, a model number or an offer
 *   condition: they are seller-account facts. Demanding them would force the
 *   generator to invent one, and an invented price is a WRONG price on a live
 *   listing — a materially worse outcome than a blank the operator fills in.
 *   A field with no declared `source` reads as `generated`, the stricter side.
 *
 *  R3 ENUM VALIDATION — where the schema declares a CLOSED value set
 *   (`enum`), a produced value outside it is a FAILURE. Amazon rejects a
 *   non-enum value at feed time, so an unchecked one turns into a suppressed
 *   listing rather than a bad one. Matching is trimmed + case-insensitive
 *   (marketplace enums are not case-sensitive) but otherwise exact. Fields
 *   whose value set is open in practice deliberately carry no `enum` — see
 *   `_declinedEnums` in the schema file; an over-tight enum would block a
 *   lawful value, which is worse than not checking.
 *
 *  R4 NONE-STYLE ALLERGEN DECLARATION (AM-4a) — when the label carries NO
 *   declarable allergen, the declaration attribute must equal the pack's
 *   `noAllergenCanonical` string EXACTLY. An empty declaration field reads as
 *   "not answered" and free-text variants are unverifiable. This is the
 *   COMPLEMENT of C9, which fires only when an allergen IS present; the two
 *   never run on the same listing, and C9's ban on `noAllergenPhrases`
 *   ("No Known Allergens") is untouched and independent.
 *
 * A pack with an EMPTY schema has no R1–R3 rule at all — which is why
 * `attributeSchema` is a required manifest piece on compliance-bearing packs
 * (`REQUIRED_PACK_PIECES`): emptying it would otherwise disarm this check
 * silently. `compliancePack.noAllergenCanonical` and the schema's enum lists
 * are manifest pieces for the same reason.
 */

const CHECK_ID = 'C23';

/** True when the produced attribute value is missing or effectively blank. */
const isBlank = (v: unknown): boolean => v == null || String(v).trim() === '';

/**
 * WHO OWNS the value. A field with no declared `source` reads as `generated` —
 * deliberately the stricter reading, since that is the one the gate enforces.
 */
const isOperatorOwned = (f: AttributeField): boolean => f.source === 'operator';

const norm = (v: string): string => v.trim().toLowerCase();

export function c23AttributeCompleteness(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const schema = pack.attributeSchema ?? [];
  const attrs = l.attributes ?? {};
  const out: Failure[] = [];

  for (const field of schema) {
    const name = field?.field?.trim();
    if (!name) continue;

    // --- R3: enum validation (runs on a PRESENT value, so it is independent
    //     of the completeness rule and of the operator exemption). ---
    const allowed = (field.enum ?? []).filter((v) => String(v).trim() !== '');
    const value = attrs[name];
    if (allowed.length > 0 && !isBlank(value)) {
      if (!allowed.some((a) => norm(a) === norm(String(value)))) {
        out.push(
          fail(
            CHECK_ID,
            `attributes.${name}`,
            `'${String(value)}' is not one of the values '${name}' accepts`,
            `Set '${name}' to exactly one of: ${allowed.join(' | ')}. The marketplace rejects an out-of-set value at feed time, which suppresses the listing rather than degrading it.`,
          ),
        );
      }
    }

    // --- R2: operator-owned fields are never reported missing. ---
    if (isOperatorOwned(field)) continue;

    // --- R1: completeness. ---
    if (!field.required && !field.filterFacet) continue; // optional non-facet → audit gap, not a failure
    if (!isBlank(value)) continue;
    const kind = field.required
      ? 'required by the schema'
      : 'a filter facet (customer-facing discovery surface)';
    out.push(
      fail(
        CHECK_ID,
        `attributes.${name}`,
        `'${name}' is missing or empty`,
        `Fill '${name}' — it is ${kind}. Every schema field must be produced; use the explicit none-style value the schema example shows when it does not apply.`,
      ),
    );
  }

  // --- R4: the none-style allergen declaration (AM-4a). ---
  out.push(...noneStyleAllergenDeclaration(l, pack));
  return out;
}

/**
 * AM-4a. Pack-driven end to end: the attribute KEY comes from
 * `compliancePack.allergenFields.declaration` and the required STRING from
 * `compliancePack.noAllergenCanonical`. This module holds neither.
 */
function noneStyleAllergenDeclaration(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const canonical = cp.noAllergenCanonical?.trim();
  const key = cp.allergenFields?.declaration?.trim();
  if (!canonical || !key) return []; // configured off → no rule (and a manifest failure elsewhere)
  // Only the NO-allergen case: when an allergen is present C9 owns the field.
  if (presentAllergens(l, cp).length > 0) return [];
  const value = (l.attributes ?? {})[key];
  if (value === canonical) return [];
  return [
    fail(
      CHECK_ID,
      `attributes.${key}`,
      isBlank(value) ? '(empty)' : String(value),
      `No declarable allergen is present, so '${key}' must equal exactly '${canonical}'. A blank reads as "not answered" and a free-text variant cannot be verified.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// C24 — the DOSAGE-ATTRIBUTE guard (AM-1)
// ---------------------------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest-first alternation over pack tokens, inner whitespace flexible. */
function alternation(tokens: string[]): string {
  return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRe(t).replace(/\s+/g, '\\s+'))
    .join('|');
}

/**
 * C24 — a dosage/strength/potency ATTRIBUTE may not assert a hero figure.
 *
 * Ported from the harness kit's `checkC24`. The kit's reasoning, which is the
 * whole point of the check: structured attributes are FILTER-FED. Copy that
 * says "50 Billion CFU blend" states a formula-level fact a reader can weigh
 * against the panel; the same figure sitting in `maximum_dosage` states it as
 * a DOSE, in a field that feeds filters and comparison widgets, with no
 * sentence around it to carry the attachment. That is an overstatement EVEN
 * WHEN THE NUMBER IS THE CANONICAL ONE — which is exactly why C12
 * (fact-consistency) cannot catch it: C12's question is "does this figure
 * agree with the facts?", and here it does. The fix is to remove the
 * attribute; the figure belongs in copy attached to the blend or formula.
 *
 * FULLY PACK-DRIVEN (`rules.attributeGuard`): the KEY pattern and the
 * dimension whose unit tokens count as hero units are both pack data, so this
 * module names neither an attribute key nor a unit. A legitimate dose-shaped
 * attribute that asserts NO hero unit (a serving size counted in dosage forms,
 * a dosage FORM) is untouched, which is the both-direction contract this check
 * ships with.
 *
 * ---------------------------------------------------------------------------
 * N2 — FLAGGED DIVERGENCE FROM THE KIT: the SPELLED-OUT figure now fails too.
 * ---------------------------------------------------------------------------
 * The kit's `checkC24` value shape is digit-anchored, so `"Fifty Billion CFU"`
 * in a dosage-keyed attribute used to pass while `"50 Billion CFU"` failed.
 * C12 could not catch it either — its scan is unit-anchored on digits for the
 * same reason. The two strings are the SAME assertion in a filter-fed field, so
 * the app now reads both. This is recorded as an intentional improvement over
 * kit parity in CONFORMANCE-DEVIATIONS.md item 2, not slipped in.
 *
 * THE FALSE-POSITIVE CONTROL, because that is the real risk here and words like
 * "one" and "ten" are everywhere in ordinary dose-form language:
 *   1. SCOPE. The leg inherits the check's whole scope — it runs ONLY on
 *      attribute values, and only on attributes whose KEY the pack's dosage
 *      pattern matches. Ordinary copy is never read by C24 at all.
 *   2. A HERO UNIT IS STILL REQUIRED. "One capsule daily", "two servings" and
 *      "thirty day supply" name a dosage FORM, a serving and a day — none of
 *      which is in the guarded (potency) dimension — so none of them can match
 *      however the number is written. That was already true of the digit leg;
 *      it is what makes this widening narrow.
 *   3. A CARDINAL MUST LEAD. `magnitudes` (hundred/…/billion) can only follow a
 *      cardinal, so a value that merely names its unit ("Billion CFU") is not
 *      read as a figure.
 *   4. THE SEPARATOR IS REQUIRED. Words are joined to their unit by at least
 *      one space or hyphen, and every token is word-bounded, so "ten gummies"
 *      cannot be read as "ten g".
 *   5. ABSENT PACK DATA = EXACT KIT PARITY. The leg is a widener; emptying it
 *      disarms nothing, it only restores the digit-anchored port.
 */
export function c24DosageAttributeGuard(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const guard = pack.rules?.attributeGuard;
  const keyPattern = guard?.keyPattern?.trim();
  if (!keyPattern) return [];
  const units = (guard?.unitDimensions ?? []).flatMap(
    (dim) => pack.rules?.units?.dimensions?.[dim] ?? [],
  );
  const unitSource = alternation(units);
  if (!unitSource) return [];
  let keyRe: RegExp;
  try {
    keyRe = new RegExp(keyPattern, 'i');
  } catch {
    return [];
  }
  // number (with separators) followed by a hero unit — the kit's value shape.
  const valueRes: RegExp[] = [new RegExp(`\\d[\\d,.]*\\s*(?:${unitSource})\\b`, 'i')];
  // N2 — the same shape written in words. Pack data; nothing below names a
  // number word. See the header for the five bounds that keep it narrow.
  const cardinalSource = alternation(guard?.spelledOutNumbers?.cardinals ?? []);
  if (cardinalSource) {
    const magnitudeSource = alternation(guard?.spelledOutNumbers?.magnitudes ?? []);
    const anyWord = magnitudeSource ? `${cardinalSource}|${magnitudeSource}` : cardinalSource;
    valueRes.push(
      new RegExp(
        `\\b(?:${cardinalSource})(?:[\\s-]+(?:${anyWord}))*[\\s-]+(?:${unitSource})\\b`,
        'i',
      ),
    );
  }
  const out: Failure[] = [];
  for (const [key, value] of Object.entries(l.attributes ?? {})) {
    if (!keyRe.test(key)) continue;
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (!valueRes.some((re) => re.test(text))) continue;
    out.push(
      fail(
        'C24',
        `attributes.${key}`,
        `'${key}' asserts '${text}'`,
        `A dosage/strength/potency attribute must not assert this figure — structured, filter-fed data states the number as a DOSE, which overstates the product even when the number is the canonical one. Remove '${key}'; the figure belongs in copy attached to the blend or formula.`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// C26 — active ingredients must be a SUBSET of the full ingredient list
// ---------------------------------------------------------------------------

/** Lower-case, punctuation-flattened comparison text. */
const flatten = (v: string): string =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The comparable WORDS of one declared ingredient.
 *
 * Amounts, units and parentheticals are dropped: the two attributes are
 * legitimately written in different styles ("Vitamin D3 (as cholecalciferol)
 * 25 mcg" against "Vitamin D3 (cholecalciferol), Rice Flour"), and comparing
 * them literally would report a formatting difference as an undeclared
 * ingredient. Words shorter than three characters go too — they are 'as', 'of'
 * and 'd3'-style fragments that match everywhere and prove nothing.
 */
function nameWords(token: string, amountRe: RegExp | null): string[] {
  let text = token.replace(/\([^)]*\)/g, ' ');
  // "Probiotic Blend 50 Billion CFU" and "Probiotic Blend" name the SAME
  // ingredient; the amount is a property of the panel, not of the name, and
  // the full label list routinely omits it. The unit vocabulary is pack data.
  if (amountRe) text = text.replace(amountRe, ' ');
  return [
    ...new Set(
      flatten(text)
        .split(' ')
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w)),
    ),
  ];
}

/** `number + pack unit` sequences, longest unit first. Null when the pack declares none. */
function amountPattern(pack: KnowledgePack): RegExp | null {
  const units = Object.values(pack.rules?.units?.dimensions ?? {}).flat();
  const source = alternation(units);
  return source ? new RegExp(`\\d[\\d,.]*\\s*(?:${source})\\b`, 'gi') : null;
}

/** Split a multivalue attribute into its declared entries. */
const entries = (value: string): string[] =>
  value
    .split(/[;\n|]+/)
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * C26 — `active_ingredients` ⊆ `ingredients` (both keys are PACK DATA:
 * `compliancePack.ingredientSubsetRule`).
 *
 * WHY IT IS A GATE CHECK. Amazon's ingredient-match enforcement reads every
 * ingredient claim against the same panel; an active ingredient that appears
 * in the actives field and NOWHERE in the full label list is either a copy
 * error or an undeclared ingredient, and both are suppression risks. The
 * output contract has stated this invariant since brain/05 and nothing
 * enforced it.
 *
 * DELIBERATELY TOLERANT. The comparison is on NAME WORDS after case,
 * punctuation, ordering, parentheticals and amounts are normalized away, and a
 * failure needs a word of the active's name to appear nowhere at all in the
 * full list. Over-blocking here would be worse than not checking: the two
 * fields are written in different registers by design, so a strict comparison
 * would fail honest labels.
 */
export function c26ActiveIngredientSubset(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const rule = pack.compliancePack?.ingredientSubsetRule;
  const subsetKey = rule?.subsetKey?.trim();
  const supersetKey = rule?.supersetKey?.trim();
  if (!subsetKey || !supersetKey) return [];
  const attrs = l.attributes ?? {};
  const subsetRaw = typeof attrs[subsetKey] === 'string' ? attrs[subsetKey] : '';
  if (subsetRaw.trim() === '') return []; // nothing declared → C23 owns the blank
  const supersetRaw = typeof attrs[supersetKey] === 'string' ? attrs[supersetKey] : '';
  const haystack = flatten(supersetRaw);
  const amountRe = amountPattern(pack);
  const out: Failure[] = [];
  for (const token of entries(subsetRaw)) {
    const words = nameWords(token, amountRe);
    if (words.length === 0) continue;
    const missing = words.filter((w) => !haystack.includes(w));
    if (missing.length === 0) continue;
    out.push(
      fail(
        'C26',
        `attributes.${subsetKey}`,
        `'${token}' is not declared in '${supersetKey}' (missing: ${missing.join(', ')})`,
        `Every active ingredient must also appear in '${supersetKey}' — the full label list is what the marketplace matches ingredient claims against. Add it to '${supersetKey}' if the panel declares it, or remove it from '${subsetKey}' if it does not.`,
      ),
    );
  }
  return out;
}
