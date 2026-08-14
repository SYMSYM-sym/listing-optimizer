import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { inflectAll, normalize, scanTerms, subtractDisclaimers, termRegex } from '../util';
import type { GateContext } from './types';
import { allGeneratedSurfaces, disclaimerVariantsOf, diseaseNegationOptions, fail } from './shared';

const UNION_CACHE = new WeakMap<CompliancePack, string[]>();
const ACTION_VERB_CACHE = new WeakMap<CompliancePack, string[]>();

/**
 * EVERY disease noun the pack knows: core ∪ the union of ALL subcategory lists.
 *
 * A drug claim is illegal whatever the product is — a probiotic listing may no
 * more claim to cure an eye condition than an eye supplement may. Scoping the
 * lexicon to the DETECTED subcategories therefore under-enforced by design; the
 * gate now always scans the whole union. Detection survives only for the
 * fail-closed PACK rule and for ordering the prompt injection.
 */
export function allDiseaseNouns(cp: CompliancePack): string[] {
  const cached = UNION_CACHE.get(cp);
  if (cached) return cached;
  const union = [
    ...new Set([
      ...(cp.coreDiseaseNouns ?? []),
      ...Object.values(cp.diseaseNounsBySubcategory ?? {}).flat(),
      // Prescription-drug names ride the SAME path: "works like a natural
      // Ozempic" is a drug claim, and the pack keeps the lexicon.
      ...(cp.prescriptionDrugNames ?? []),
    ]),
  ];
  UNION_CACHE.set(cp, union);
  return union;
}

/**
 * The SAME full union, ordered so the detected subcategories come first.
 * Ordering only — never a filter: prompt injection uses it so the most relevant
 * terms lead the list, and the generator is still shown everything the gate
 * enforces.
 */
export function activeDiseaseNouns(cp: CompliancePack, subcategories: string[]): string[] {
  const relevant = new Set(subcategories.flatMap((s) => cp.diseaseNounsBySubcategory[s] ?? []));
  const union = allDiseaseNouns(cp);
  return [...union.filter((n) => relevant.has(n)), ...union.filter((n) => !relevant.has(n))];
}

/**
 * Every compliance module reachable from this pack: its own (if any) plus every
 * module the pack ASSEMBLER attached as a cross-check (`crossCheckCompliancePacks`,
 * built in knowledge/ — this module still names no category).
 */
export function reachableCompliancePacks(pack: KnowledgePack): CompliancePack[] {
  const out: CompliancePack[] = [];
  const seen = new Set<CompliancePack>();
  for (const cp of [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]) {
    if (!cp || seen.has(cp)) continue;
    seen.add(cp);
    out.push(cp);
  }
  return out;
}

const CROSS_NOUN_CACHE = new WeakMap<KnowledgePack, string[]>();
const CROSS_PAIRED_CACHE = new WeakMap<KnowledgePack, string[]>();

/**
 * The disease/drug lexicon C6 and A2 actually scan: the UNION over EVERY
 * compliance module the pack can reach.
 *
 * Rationale, stated by the project's own rule: a drug claim is illegal whatever
 * the product is. Scoping the scan to the ROUTED pack's own lexicon meant a
 * listing routed to one pack could claim to cure cancer and reverse diabetes and
 * come back `pass:true, verified:true`, because those nouns live only in the
 * other pack's lexicon.
 */
export function crossPackDiseaseNouns(pack: KnowledgePack): string[] {
  const cached = CROSS_NOUN_CACHE.get(pack);
  if (cached) return cached;
  const union = [...new Set(reachableCompliancePacks(pack).flatMap(allDiseaseNouns))];
  CROSS_NOUN_CACHE.set(pack, union);
  return union;
}

/** The same union for the ACTION-PAIRED tier (see `CompliancePack.actionPairedNouns`). */
export function crossPackActionPairedNouns(pack: KnowledgePack): string[] {
  const cached = CROSS_PAIRED_CACHE.get(pack);
  if (cached) return cached;
  const union = [
    ...new Set(reachableCompliancePacks(pack).flatMap((cp) => cp.actionPairedNouns ?? [])),
  ];
  CROSS_PAIRED_CACHE.set(pack, union);
  return union;
}

/**
 * The set injected into the PROMPT: the pack's own union first (ordered by the
 * detected subcategories), then every cross-pack noun, then the action-paired
 * tier. The generator must be told EVERYTHING the gate can fail it on — the
 * cross-pack union is now part of that.
 */
export function promptDiseaseNouns(pack: KnowledgePack, subcategories: string[]): string[] {
  const cp = pack.compliancePack;
  const out = new Set<string>(cp ? activeDiseaseNouns(cp, subcategories) : []);
  for (const n of crossPackDiseaseNouns(pack)) out.add(n);
  for (const n of crossPackActionPairedNouns(pack)) out.add(n);
  return [...out];
}

/**
 * Therapeutic-ACTION verbs (relieves / eases / reverses / shrinks …).
 *
 * The pack ships ROOTS; every inflection is generated in code, so the class is
 * covered without the pack (or the gate) carrying a hand-written word list.
 * These never create a failure on their own — they VETO negation suppression:
 * "Never any junk - relieves arthritis" is a drug claim, not a disclaimer.
 */
export function diseaseActionVerbs(cp: CompliancePack): string[] {
  const cached = ACTION_VERB_CACHE.get(cp);
  if (cached) return cached;
  const verbs = [...new Set([...cp.diseaseVerbs, ...inflectAll(cp.diseaseActionVerbRoots ?? [])])];
  ACTION_VERB_CACHE.set(cp, verbs);
  return verbs;
}

// ---------------------------------------------------------------------------
// PACK-INTEGRITY MANIFEST
// ---------------------------------------------------------------------------

/**
 * One required piece of a compliance-bearing pack.
 *
 * Every check in this gate is only as strong as the pack data behind it, so
 * emptying ANY of these lists used to silently disarm the corresponding check
 * while the gate still returned `pass:true` with zero signal. The manifest
 * turns that fail-OPEN into a blocking `PACK` failure that NAMES the missing
 * piece.
 *
 * The list is DECLARED (not inferred), so adding a new pack-driven check means
 * adding one row here; `tests/redteam4.gate.test.ts` empties every row in turn
 * and additionally asserts that every row has a mutation, so a row cannot be
 * added without a test.
 */
export interface PackPiece {
  /** Stable id used in the failure context and in the test table. */
  id: string;
  /** What silently breaks when this piece is empty (rendered into the fix text). */
  disarms: string;
  /** True when the piece is present AND non-empty. */
  present: (pack: KnowledgePack, cp: CompliancePack) => boolean;
}

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.filter((x) => x !== undefined && x !== null && String(x).trim() !== '').length > 0;
const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const nonEmptyPairs = (v: unknown): boolean =>
  Array.isArray(v) && v.some((row) => Array.isArray(row) && nonEmptyString(row[0]));
/**
 * A C21 target list. An entry is either a bare term or a CONTEXT-QUALIFIED
 * object (`SemanticTarget`) — `nonEmptyList` alone would accept `[{ term: '' }]`
 * because `String({})` is not blank, so the term itself is what is checked.
 */
const nonEmptyTargets = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.some((entry) =>
    typeof entry === 'string'
      ? nonEmptyString(entry)
      : nonEmptyString((entry as { term?: unknown } | null)?.term),
  );

/**
 * REQUIRED pieces for a pack that carries a compliance module.
 *
 * Coverage note (deliberately precise, not aspirational): this manifest
 * asserts PRESENCE and NON-EMPTINESS of the pieces below. It does NOT validate
 * their contents — a pack that ships one junk disease noun still passes the
 * manifest.
 *
 * The membership TEST is one question: does emptying this piece DISARM a check
 * (fail-open)? If yes it is required. Two classes are therefore deliberately
 * NOT required:
 *
 *  (a) data that only WIDENS a check — `diseaseActionVerbRoots`,
 *      `negationMetaPhrases`, `fictionPhrases`, `acceptedDisclaimerVariants`,
 *      `subcategoryKeywords`, `prescriptionDrugNames`,
 *      `semanticDrugClaims.determinerScopedTargets` (rule 1 stays armed on the
 *      plain target list without it) and `approvedClaimTemplates`, which is
 *      PREVENTION ONLY — it is rendered into the system prompt and enforces
 *      nothing, so its absence cannot fail a check open. It has its own
 *      superset test against the rendered prompt instead. An empty value is a
 *      legitimate configuration, not a disarmed check;
 *
 *  (b) FALSE-POSITIVE REDUCERS — `allergenCompoundExclusions`,
 *      `benignContextPhrases`, `semanticDrugClaims.safeContextPhrases` and
 *      `rules.style.allCapsRunExempt`, `lawfulQualifiers` and
 *      `naturalStateSafePhrases`. Emptying one of these makes the gate
 *      STRICTER, not weaker: the failure mode is over-blocking lawful copy, and
 *      over-blocking is caught by `tests/falsePositives.gate.test.ts`, not by a
 *      fail-closed PACK rule. Requiring them here would report a pack that is
 *      merely blunt as a pack that is unsafe, which is the wrong signal.
 */
export const REQUIRED_PACK_PIECES: readonly PackPiece[] = [
  {
    id: 'compliancePack.coreDiseaseNouns',
    disarms: 'the always-on disease-term scan (C6/A2)',
    present: (_p, cp) => nonEmptyList(cp.coreDiseaseNouns),
  },
  {
    id: 'compliancePack.diseaseVerbs',
    disarms: 'the drug-claim verb scan (C6/A2)',
    present: (_p, cp) => nonEmptyList(cp.diseaseVerbs),
  },
  {
    id: 'compliancePack.diseaseNounsBySubcategory',
    disarms: 'every subcategory disease lexicon (C6/A2)',
    present: (_p, cp) =>
      !!cp.diseaseNounsBySubcategory &&
      Object.values(cp.diseaseNounsBySubcategory).some((list) => nonEmptyList(list)),
  },
  {
    id: 'compliancePack.superlativeBans',
    disarms: 'the banned-marketing-phrase half of C19',
    present: (_p, cp) => nonEmptyList(cp.superlativeBans),
  },
  {
    id: 'compliancePack.allergenRules',
    disarms: 'the allergen declaration checks (C9/A7)',
    present: (_p, cp) => nonEmptyList(cp.allergenRules),
  },
  {
    id: 'compliancePack.allergenFields',
    disarms: 'the attribute lookup behind the allergen checks (C9/A7)',
    present: (_p, cp) =>
      !!cp.allergenFields &&
      nonEmptyString(cp.allergenFields.labelList) &&
      nonEmptyString(cp.allergenFields.declaration) &&
      nonEmptyString(cp.allergenFields.declarationVerb) &&
      nonEmptyString(cp.allergenFields.aplusModuleIdCue),
  },
  {
    id: 'compliancePack.allergenDeclarationSurfaces',
    disarms:
      'the ATTRIBUTE and DESCRIPTION legs of the allergen triple declaration (C9) — the operator override may drop the BULLET leg only; switching off either of the other two would leave a declarable allergen undeclared in structured data or in the field the customer actually reads',
    // Absent object => every leg enforced (the strict default). Present object
    // => the two non-overridable legs must not be switched off.
    present: (_p, cp) => {
      const s = cp.allergenDeclarationSurfaces;
      if (!s) return true;
      return s.attribute !== false && s.description !== false;
    },
  },
  {
    id: 'compliancePack.noAllergenPhrases',
    disarms: 'the banned allergen-absence phrasing check (C9)',
    present: (_p, cp) => nonEmptyList(cp.noAllergenPhrases),
  },
  {
    id: 'compliancePack.actionPairedNouns',
    disarms: 'the therapeutic-action tier of C6/A2 (e.g. "cures menopause")',
    present: (_p, cp) => nonEmptyList(cp.actionPairedNouns),
  },
  {
    id: 'compliancePack.naturalStates',
    disarms:
      'the natural-state half of C22 — without it a therapeutic-action claim on a natural state, and the abnormal form of one, are both invisible',
    present: (_p, cp) => nonEmptyList(cp.naturalStates),
  },
  {
    id: 'compliancePack.normalSymptomologyNouns',
    disarms:
      'the normal-symptomology half of C22 — the mild form of a symptom would still be lawful, but its abnormal form would no longer be reported',
    present: (_p, cp) => nonEmptyList(cp.normalSymptomologyNouns),
  },
  {
    id: 'compliancePack.abnormalOnlySymptomNouns',
    disarms:
      'the abnormality rule over the symptom words a structure/function claim may lawfully address — without it "severe hot flashes" reads as ordinary copy',
    present: (_p, cp) => nonEmptyList(cp.abnormalOnlySymptomNouns),
  },
  {
    id: 'compliancePack.abnormalityMarkers',
    disarms:
      'both abnormality rules of C22 (a marker beside a natural state, and two markers naming an abnormal condition)',
    present: (_p, cp) => nonEmptyList(cp.abnormalityMarkers),
  },
  {
    id: 'compliancePack.ingredientAttributeKeys',
    disarms:
      'the ATTRIBUTED-figure half of C12 — without the keys an attributed potency figure can never be verified against the ingredient breakdown, so every attributed conflict is accepted',
    present: (_p, cp) => nonEmptyList(cp.ingredientAttributeKeys),
  },
  {
    id: 'compliancePack.semanticDrugClaims.pathologicalActionVerbs',
    disarms: 'the pathological-action half of C21 ("shrinks the lump")',
    present: (_p, cp) => nonEmptyList(cp.semanticDrugClaims?.pathologicalActionVerbs),
  },
  {
    id: 'compliancePack.semanticDrugClaims.anatomicalTargets',
    disarms: 'the body-structure target list C21 pairs its action verbs with',
    present: (_p, cp) => nonEmptyTargets(cp.semanticDrugClaims?.anatomicalTargets),
  },
  {
    id: 'compliancePack.semanticDrugClaims.replacementCues',
    disarms: 'the therapy-replacement half of C21 ("throw away your inhaler")',
    present: (_p, cp) => nonEmptyList(cp.semanticDrugClaims?.replacementCues),
  },
  {
    id: 'compliancePack.semanticDrugClaims.medicalDeviceOrTherapyNouns',
    disarms: 'the device/therapy list C21 pairs its replacement cues with',
    present: (_p, cp) => nonEmptyList(cp.semanticDrugClaims?.medicalDeviceOrTherapyNouns),
  },
  {
    id: 'compliancePack.semanticDrugClaims.functionRestorationVerbs',
    disarms: 'the function-restoration half of C21 ("restores sight")',
    present: (_p, cp) => nonEmptyList(cp.semanticDrugClaims?.functionRestorationVerbs),
  },
  {
    id: 'compliancePack.semanticDrugClaims.lostFunctionNouns',
    disarms: 'the lost-function list C21 pairs its restoration verbs with',
    present: (_p, cp) => nonEmptyList(cp.semanticDrugClaims?.lostFunctionNouns),
  },
  {
    id: 'compliancePack.semanticDrugClaims.patterns',
    disarms:
      'the literal-pattern tier of C21 (physician-withdrawal, stop-your-medication and ICD diagnosis codes)',
    present: (_p, cp) => nonEmptyPairs(cp.semanticDrugClaims?.patterns),
  },
  {
    id: 'compliancePack.disclaimer',
    disarms: 'the verbatim-disclaimer checks (C5/A1)',
    present: (_p, cp) => nonEmptyString(cp.disclaimer),
  },
  {
    id: 'rules.style',
    disarms: 'the entire style/formatting gate (C17) and the bullet claim-marker rule (C25)',
    present: (p) => {
      const st = p.rules?.style;
      if (!st) return false;
      return (
        typeof st.allCapsMinWordLen === 'number' && st.allCapsMinWordLen > 0 &&
        typeof st.allCapsRunMin === 'number' && st.allCapsRunMin >= 2 &&
        nonEmptyList(st.bannedSymbols) &&
        nonEmptyList(st.bannedChars) &&
        nonEmptyList(st.bannedCharsSurfaces) &&
        nonEmptyList(st.titleTermBans) &&
        nonEmptyList(st.titleTermBanSurfaces) &&
        nonEmptyString(st.bulletTrailingPunctuation) &&
        nonEmptyString(st.claimMarker) &&
        nonEmptyString(st.asinPattern) &&
        nonEmptyString(st.emojiPattern) &&
        nonEmptyString(st.htmlTagPattern) &&
        nonEmptyList(st.descriptionAllowedHtml) &&
        typeof st.descriptionMaxBytes === 'number' && st.descriptionMaxBytes > 0
      );
    },
  },
  {
    id: 'rules.prohibitedContent.patterns',
    disarms: 'the prohibited detail-page content scan (C18)',
    present: (p) => nonEmptyPairs(p.rules?.prohibitedContent?.patterns),
  },
  {
    id: 'rules.prohibitedContent.surfaces',
    disarms: 'every surface C18 would scan',
    present: (p) => nonEmptyList(p.rules?.prohibitedContent?.surfaces),
  },
  {
    id: 'rules.prohibitedMarketing.patterns',
    disarms: 'the prohibited-marketing scan (C19/A8)',
    present: (p) => nonEmptyPairs(p.rules?.prohibitedMarketing?.patterns),
  },
  {
    id: 'rules.prohibitedMarketing.surfaces',
    disarms: 'every surface C19 would scan',
    present: (p) => nonEmptyList(p.rules?.prohibitedMarketing?.surfaces),
  },
  {
    id: 'attributeSchema',
    disarms:
      'the attribute-completeness check (C23) — an empty schema means no required or filter-facet field can ever be reported missing',
    present: (p) =>
      Array.isArray(p.attributeSchema) &&
      p.attributeSchema.some((f) => typeof f?.field === 'string' && f.field.trim() !== ''),
  },
  {
    id: 'attributeSchema.enums',
    disarms:
      'the ENUM half of C23 (R3) — a field the schema types as a closed set with no set left to compare against accepts any value, and the marketplace rejects it at feed time instead',
    // The invariant, enforced as a manifest rule: EVERY enum-typed field must
    // carry a non-empty value set. A pack that declares no enum field at all
    // passes vacuously — it has no enum rule to disarm.
    present: (p) =>
      Array.isArray(p.attributeSchema) &&
      p.attributeSchema
        .filter((f) => f?.valueType === 'enum')
        .every((f) => nonEmptyList(f.enum)),
  },
  {
    id: 'compliancePack.noAllergenCanonical',
    disarms:
      'the none-style allergen declaration rule (C23 R4) — without the canonical string a listing with no declarable allergen can leave the declaration attribute blank or fill it with unverifiable free text',
    present: (_p, cp) => nonEmptyString(cp.noAllergenCanonical),
  },
  {
    id: 'compliancePack.ingredientSubsetRule',
    disarms:
      'C26 \u2014 without the attribute pair an active ingredient declared nowhere in the full label list can never be reported, and an undeclared ingredient is what marketplace ingredient-match enforcement suppresses listings for',
    present: (_p, cp) =>
      !!cp.ingredientSubsetRule &&
      nonEmptyString(cp.ingredientSubsetRule.subsetKey) &&
      nonEmptyString(cp.ingredientSubsetRule.supersetKey),
  },
  {
    id: 'rules.attributeGuard',
    disarms:
      'C24 \u2014 the dosage/strength/potency ATTRIBUTE guard. Without the key pattern (or with no unit dimension left to guard) a hero figure can sit in structured, filter-fed data stating the number as a dose, and C12 cannot see it because the number agrees with the facts',
    present: (p) => {
      const g = p.rules?.attributeGuard;
      if (!g || !nonEmptyString(g.keyPattern) || !nonEmptyList(g.unitDimensions)) return false;
      // A dimension that names no units guards nothing.
      return g.unitDimensions.some((d) => nonEmptyList(p.rules?.units?.dimensions?.[d]));
    },
  },
  {
    id: 'rules.outputHygiene.asciiOnly',
    disarms: 'the ASCII half of C27 \u2014 non-ASCII characters would ship into the feed unreported',
    present: (p) => p.rules?.outputHygiene?.asciiOnly === true,
  },
  {
    id: 'rules.outputHygiene.aiTellPhrases',
    disarms: 'the AI-tell half of C27',
    present: (p) => nonEmptyList(p.rules?.outputHygiene?.aiTellPhrases),
  },
  {
    id: 'rules.outputHygiene.instructionFragments',
    disarms: 'the leaked-instruction half of C27',
    present: (p) => nonEmptyList(p.rules?.outputHygiene?.instructionFragments),
  },
  {
    id: 'rules.outputHygiene.surfaces',
    disarms: 'every surface C27 would scan',
    present: (p) => nonEmptyList(p.rules?.outputHygiene?.surfaces),
  },
  {
    id: 'rules.units.dimensions',
    disarms: 'the unit-anchored potency + fact-consistency checks (C10/C12/A5)',
    present: (p) => {
      const dims = p.rules?.units?.dimensions;
      return !!dims && Object.values(dims).some((list) => nonEmptyList(list));
    },
  },
];

/** Ids of every manifest row — the test table is asserted against this. */
export const requiredPackPieceIds: string[] = REQUIRED_PACK_PIECES.map((p) => p.id);

/** Missing/empty required pieces, in manifest order. */
export function missingPackPieces(pack: KnowledgePack): string[] {
  const cp = pack.compliancePack;
  if (!cp) return pack.requiresCompliance ? ['compliancePack'] : [];
  const missing: string[] = [];
  for (const piece of REQUIRED_PACK_PIECES) {
    let ok = false;
    try {
      ok = piece.present(pack, cp);
    } catch {
      ok = false;
    }
    if (!ok) missing.push(piece.id);
  }
  return missing;
}

const disarmedBy = (ids: string[]): string =>
  REQUIRED_PACK_PIECES.filter((p) => ids.includes(p.id))
    .map((p) => `${p.id} (${p.disarms})`)
    .join('; ');

/**
 * The REGULATED-CATEGORY cross-check lexicon.
 *
 * A pack with no compliance module switches off C5/C6/C9/C10/C11/A1/A2 (they
 * all early-return on `!cp`). The suspicion lexicon alone is a vocabulary
 * heuristic, so this second, independent backstop asks a blunter question: does
 * the generated listing name a DISEASE or a PRESCRIPTION DRUG at all?
 *
 * The lexicons come off `pack.crossCheckCompliancePacks` — PACK DATA assembled
 * in knowledge/, so this module still names no category. It is a safety
 * cross-check, not a routing decision: a product routed to a pack with no
 * compliance module can never come back `verified` while making drug claims.
 */
function crossCheckHits(pack: KnowledgePack, hay: string): { term: string; context: string }[] {
  const out: { term: string; context: string }[] = [];
  for (const cp of pack.crossCheckCompliancePacks ?? []) {
    const nouns = allDiseaseNouns(cp);
    if (nouns.length === 0) continue;
    const disclaimers = disclaimerVariantsOf(cp).map(normalize);
    const m = scanTerms(subtractDisclaimers(hay, disclaimers), nouns, diseaseNegationOptions(cp))[0];
    if (m) out.push({ term: m.term, context: m.context });
  }
  return out;
}

/**
 * FAIL-CLOSED rule.
 *
 * Four layers:
 *  1. A pack that DECLARES it needs a compliance module but ships none is
 *     blocking (`requiresCompliance`), whatever the copy says.
 *  2. Every required pack piece must be present and non-empty — see the
 *     manifest above. Emptying one now NAMES itself in a blocking failure
 *     instead of silently switching its check off.
 *  3. A pack with no compliance module and no declared requirement still fails
 *     closed when the LISTING smells like a regulated category
 *     (`suspicionLexicon`). The haystack is the ENTIRE generated listing —
 *     title/bullets/description/backend/Q&A/image plan/attributes/facts/A+ —
 *     plus the snapshot text. It used to be `snapshotText + title +
 *     description` only, so a listing whose BULLETS, A+ modules, Q&A or
 *     attributes carried the regulated vocabulary was invisible to it.
 *  4. Belt and braces: a pack with no compliance module that nonetheless
 *     mentions a disease or a prescription drug ANYWHERE in the listing is
 *     blocking, whatever its vocabulary looks like (see `crossCheckLexicon`).
 */
export function packFailClosed(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) {
    if (pack.requiresCompliance) {
      return [
        fail(
          'PACK',
          'compliance',
          `pack '${pack.id}' requires a compliance module but ships none (missing: compliancePack)`,
          'compliance pack incomplete for this category — restore the compliance module before trusting a pass',
        ),
      ];
    }
    const out: Failure[] = [];
    const hay = normalize(
      [ctx.snapshotText ?? '', ...allGeneratedSurfaces(l).map(([, text]) => text)].join(' \n '),
    );
    // WORD BOUNDARIES, not substrings: the lexicon carries short forms ('ct',
    // 'mg', 'iu') that as raw substrings would match 'produ-ct', 'i-m-age' and
    // 'premi-u-m' and block every listing on earth.
    const hit = (pack.suspicionLexicon ?? []).find((t) => t.trim() && termRegex(t).test(hay));
    if (hit) {
      out.push(
        fail(
          'PACK',
          'compliance',
          `pack '${pack.id}' has no compliance module but listing matches suspicion term '${hit}'`,
          'compliance pack incomplete for this category — route to a pack with a compliance module before trusting a pass',
        ),
      );
    }
    const cross = crossCheckHits(pack, hay)[0];
    if (cross) {
      out.push(
        fail(
          'PACK',
          'compliance',
          `pack '${pack.id}' has no compliance module but listing contains the disease/drug term '${cross.term}': ${cross.context}`,
          'compliance pack incomplete for this category — a listing that names a disease or a prescription drug must be routed to a pack with a compliance module before trusting a pass',
        ),
      );
    }
    return out;
  }

  const missing = missingPackPieces(pack);
  if (missing.length > 0) {
    return [
      fail(
        'PACK',
        'compliance',
        `missing or empty pack piece(s): ${missing.join(', ')}`,
        `compliance pack incomplete for this category — ${disarmedBy(missing) || missing.join(', ')} — populate before trusting a pass`,
      ),
    ];
  }

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
