import type {
  CompliancePack,
  Failure,
  KnowledgePack,
  OptimizedListing,
  SemanticDrugClaims,
  SemanticTarget,
  SemanticTargetEntry,
} from '@/lib/types';
import {
  collapseDoubles,
  concatAnchored,
  doubleCollapsedVariants,
  normalize,
  obfuscationVariants,
  subtractDisclaimers,
} from '../util';
import {
  allGeneratedSurfaces,
  disclaimerVariantsOf,
  fail,
} from './shared';

/**
 * C21 — SEMANTIC drug claims: the claim SHAPE, not its vocabulary.
 *
 * C6 scans a LEXICON (disease nouns, drug names, banned verbs). A drug claim
 * needs neither: "shrinks the lump in your breast", "clears the plaque out of
 * your arteries", "so you can throw away your inhaler", "ends the need for
 * dialysis" and "restores sight to failing eyes" contain no listed disease noun
 * and no listed verb, and every one of them passed the gate.
 *
 * C21 compiles three PROXIMITY rules plus a list of literal patterns from
 * `compliancePack.semanticDrugClaims` (PACK DATA — see `SemanticDrugClaims`).
 * This module names no body part, no device, no therapy and no verb: it holds
 * the structural glue only (word boundaries, the distance window, the
 * determiner class), so the gate stays category-agnostic.
 *
 * COVERAGE, stated plainly and deliberately not overstated:
 *  - the scan runs over the SAME ADDITIVE de-obfuscation variant set the
 *    prohibited-content scans use (`util.obfuscationVariants` plus the
 *    doubled-letter pass): confusable/homoglyph and small-caps folding come
 *    from `normalize`, then separator collapse, both leetspeak readings, the
 *    compatibility-punctuation fold, the doubled-letter collapse and the
 *    separator-STRIPPED variant. `shr1nks the lump`, `sh rinks the lump`,
 *    `cl3ars the plaque out of your arteries` and `ᴋɪʟʟꜱ the bad cells` all
 *    fail. The untouched text is always variant #1 — every class is additive
 *    and none of them replaces the surface the other checks read;
 *  - the STRIPPED variant has no word boundaries left, so it is scanned with a
 *    boundary-free rule set and every match is TOKEN-ANCHORED back against the
 *    original text (`concatAnchored`), which is what keeps `sh rinks` while
 *    rejecting the fragment matches a concatenated string manufactures
 *    (`clumps` -> `lump`). The determiner-scoped half of rule 1 survives there
 *    only because the determiner gap is relaxed to `\s*` for that class;
 *  - the DOUBLED-LETTER variants are scanned against a rule set whose pack
 *    terms are collapsed the same way (`collapseDoubles`), because collapsing
 *    only the text would break every term that legitimately doubles a letter;
 *  - it is a proximity heuristic, not a parser: it reports a verb/cue followed
 *    by its noun inside `proximityWindow` characters and cannot tell who the
 *    subject is;
 *  - `safeContextPhrases` (pack data) are blanked out of every variant first,
 *    which is what keeps required safety copy ("do not stop taking your
 *    medication") clean.
 *
 * CONTEXT-QUALIFIED TARGETS. A target noun can be ordinary English in one
 * domain and a pathology in another. The pack may therefore give a target a
 * `requiresContext` / `benignContext` list (see `SemanticTarget`); the gate
 * holds the window arithmetic and none of the words. That is what separates
 * "removes the plaque from your teeth" (lawful oral care) from "clears the
 * plaque out of your arteries" (a drug claim) without either a gate literal or
 * a blanket exemption for the noun.
 */

const CHECK_ID = 'C21';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Determiners that turn an ordinary noun into ONE named instance ("the growth"
 * vs "healthy hair growth"). Structural English, not a category lexicon — the
 * same class `shared.ts` already uses for attribution.
 */
const DETERMINERS = [
  'the', 'a', 'an', 'that', 'this', 'those', 'these', 'your', 'his', 'her',
  'their', 'its', 'my', 'our', 'any', 'every', 'each',
];

/**
 * How a variant CLASS is matched.
 *  - `spaced` — the text still has word separation: `\b` boundaries hold and a
 *    multi-word pack term needs at least one separator between its words.
 *  - `concat` — the separator-STRIPPED variant: there are no boundaries left,
 *    so `\b` is dropped and every inner gap becomes optional. Anchoring is
 *    re-imposed afterwards against the original text.
 */
type Mode = 'spaced' | 'concat';

const gapOf = (mode: Mode): string => (mode === 'concat' ? '\\s*' : '\\s+');

/** Longest-first alternation over pack tokens; inner whitespace stays flexible. */
function alternation(tokens: string[], mode: Mode): string | null {
  const cleaned = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (cleaned.length === 0) return null;
  const gap = gapOf(mode);
  return cleaned.map((t) => escapeRe(t).replace(/\s+/g, gap)).join('|');
}

/** Word-boundary wrapper — a no-op in a string that has no boundaries left. */
const bounded = (source: string, mode: Mode): string =>
  mode === 'concat' ? `(?:${source})` : `\\b(?:${source})\\b`;

const re = (source: string, mode: Mode, flags = 'i'): RegExp =>
  new RegExp(bounded(source, mode), flags);

/** A target entry normalised into its term plus its (possibly empty) context lists. */
interface TargetSpec {
  term: string;
  requiresContext: string[];
  benignContext: string[];
}

const list = (v: string[] | undefined): string[] =>
  (v ?? []).filter((x) => typeof x === 'string' && x.trim() !== '');

function targetSpec(entry: SemanticTargetEntry): TargetSpec | null {
  if (typeof entry === 'string') {
    return entry.trim() ? { term: entry.trim(), requiresContext: [], benignContext: [] } : null;
  }
  const term = typeof entry?.term === 'string' ? entry.term.trim() : '';
  if (!term) return null;
  return {
    term,
    requiresContext: list(entry.requiresContext),
    benignContext: list(entry.benignContext),
  };
}

const isQualified = (s: TargetSpec): boolean =>
  s.requiresContext.length > 0 || s.benignContext.length > 0;

/**
 * One noun side of a proximity rule.
 *
 * `requires` / `benign` are evaluated over a window of `contextWindow`
 * characters EITHER SIDE of the noun match, in the same variant text the noun
 * was found in.
 */
interface NounMatcher {
  re: RegExp;
  requires: RegExp | null;
  benign: RegExp | null;
}

const plainMatcher = (source: string, mode: Mode): NounMatcher => ({
  re: re(source, mode),
  requires: null,
  benign: null,
});

function qualifiedMatcher(source: string, spec: TargetSpec, mode: Mode): NounMatcher {
  const requires = alternation(spec.requiresContext, mode);
  const benign = alternation(spec.benignContext, mode);
  return {
    re: re(source, mode),
    requires: requires ? re(requires, mode) : null,
    benign: benign ? re(benign, mode) : null,
  };
}

interface ProximityRule {
  /** Stable id rendered into the failure fix text. */
  id: string;
  /** Verb/cue side. */
  head: RegExp;
  /** Noun side, matched inside the window that follows the head. */
  nouns: NounMatcher[];
  /** How the failure reads. */
  describe: (head: string, noun: string) => string;
}

interface Compiled {
  window: number;
  rules: ProximityRule[];
  patterns: { re: RegExp; label: string }[];
  safe: RegExp | null;
  /**
   * Cheap PRE-FILTER: every verb/cue in one alternation. Blanking the safety
   * spans costs one regex replace per variant, and the overwhelming majority of
   * surfaces contain no head token at all, so the expensive work is gated
   * behind this single test. Blanking only ever REMOVES text, so a variant with
   * no head match before blanking can have none after it.
   */
  anyHead: RegExp | null;
}

/**
 * Rule 1's noun side: ONE alternation for every unqualified target (the common
 * case, one regex), then one matcher per CONTEXT-QUALIFIED target because each
 * carries its own context test.
 */
function targetMatchers(sdc: SemanticDrugClaims, mode: Mode): NounMatcher[] {
  const plain = (sdc.anatomicalTargets ?? []).map(targetSpec).filter((s): s is TargetSpec => !!s);
  const scoped = (sdc.determinerScopedTargets ?? [])
    .map(targetSpec)
    .filter((s): s is TargetSpec => !!s);

  const determiners = alternation(DETERMINERS, mode);
  // A determiner-scoped target counts only when a determiner points at it.
  const scopeOf = (source: string): string | null =>
    determiners ? `(?:${determiners})${gapOf(mode)}(?:${source})` : null;

  const out: NounMatcher[] = [];
  const simple: string[] = [];
  const simplePlain = alternation(plain.filter((s) => !isQualified(s)).map((s) => s.term), mode);
  if (simplePlain) simple.push(simplePlain);
  const simpleScoped = alternation(scoped.filter((s) => !isQualified(s)).map((s) => s.term), mode);
  const simpleScopedSource = simpleScoped ? scopeOf(simpleScoped) : null;
  if (simpleScopedSource) simple.push(simpleScopedSource);
  if (simple.length > 0) out.push(plainMatcher(simple.join('|'), mode));

  for (const spec of plain.filter(isQualified)) {
    const source = alternation([spec.term], mode);
    if (source) out.push(qualifiedMatcher(source, spec, mode));
  }
  for (const spec of scoped.filter(isQualified)) {
    const source = alternation([spec.term], mode);
    const scopedSource = source ? scopeOf(source) : null;
    if (scopedSource) out.push(qualifiedMatcher(scopedSource, spec, mode));
  }
  return out;
}

function compile(sdc: SemanticDrugClaims, mode: Mode): Compiled {
  const rules: ProximityRule[] = [];

  const pathVerbs = alternation(sdc.pathologicalActionVerbs ?? [], mode);
  const targets = targetMatchers(sdc, mode);
  if (pathVerbs && targets.length > 0) {
    rules.push({
      id: 'pathological-action',
      head: re(pathVerbs, mode, 'gi'),
      nouns: targets,
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — acting on a body structure is a drug claim; describe a structure/function benefit instead`,
    });
  }

  const cues = alternation(sdc.replacementCues ?? [], mode);
  const therapy = alternation(sdc.medicalDeviceOrTherapyNouns ?? [], mode);
  if (cues && therapy) {
    rules.push({
      id: 'therapy-replacement',
      head: re(cues, mode, 'gi'),
      nouns: [plainMatcher(therapy, mode)],
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — claiming a product replaces or ends the need for a medical therapy or device is a drug claim`,
    });
  }

  const restoreVerbs = alternation(sdc.functionRestorationVerbs ?? [], mode);
  const lostFunctions = alternation(sdc.lostFunctionNouns ?? [], mode);
  if (restoreVerbs && lostFunctions) {
    rules.push({
      id: 'function-restoration',
      head: re(restoreVerbs, mode, 'gi'),
      nouns: [plainMatcher(lostFunctions, mode)],
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — restoring a lost bodily function is a drug claim`,
    });
  }

  // The literal patterns are authored with `\s`/`\b` against ordinary prose, so
  // they are compiled for the SPACED classes only: run against a fully
  // concatenated string they can only misfire or (far more often) never match.
  const patterns =
    mode === 'concat'
      ? []
      : (sdc.patterns ?? [])
          .filter((row) => Array.isArray(row) && typeof row[0] === 'string' && row[0].trim())
          .map((row) => ({ re: new RegExp(row[0]!, 'gi'), label: row[1] ?? 'prohibited claim' }));

  // ONE alternation, not one regex per phrase: blanking runs on every variant
  // that contains a head token, and 25 separate passes over the text was the
  // dominant cost of this check.
  const safeSource = alternation(sdc.safeContextPhrases ?? [], mode);
  const safe = safeSource ? new RegExp(`(?:${safeSource})`, 'gi') : null;

  const headSource = alternation(
    [
      ...(sdc.pathologicalActionVerbs ?? []),
      ...(sdc.replacementCues ?? []),
      ...(sdc.functionRestorationVerbs ?? []),
    ],
    mode,
  );

  return {
    window:
      typeof sdc.proximityWindow === 'number' && sdc.proximityWindow > 0 ? sdc.proximityWindow : 40,
    rules,
    patterns,
    safe,
    anyHead: headSource ? re(headSource, mode) : null,
  };
}

/**
 * The three compiled rule sets a pack config produces, cached per config:
 *  - `spaced`    — for the untouched text and every separation-preserving variant;
 *  - `concat`    — for the separator-STRIPPED variant (boundary-free + anchored);
 *  - `collapsed` — for the doubled-letter variants, compiled from pack terms
 *                  collapsed the SAME way as the text.
 */
interface CompiledSet {
  spaced: Compiled;
  concat: Compiled;
  collapsed: Compiled;
}

const CACHE = new WeakMap<SemanticDrugClaims, CompiledSet>();

const collapseEntries = (entries: SemanticTargetEntry[] | undefined): SemanticTargetEntry[] =>
  (entries ?? []).map((entry) =>
    typeof entry === 'string'
      ? collapseDoubles(entry)
      : ({
          term: collapseDoubles(String(entry?.term ?? '')),
          requiresContext: list(entry?.requiresContext).map(collapseDoubles),
          benignContext: list(entry?.benignContext).map(collapseDoubles),
        } satisfies SemanticTarget),
  );

/**
 * The pack config with every TERM collapsed the way `collapseDoubles` collapses
 * the text. Collapsing only one side would break every term that legitimately
 * doubles a letter (`kills` -> `kils`), which is the same rule the disease
 * scan's `collapseDoublesTerms` follows.
 */
function collapsedConfig(sdc: SemanticDrugClaims): SemanticDrugClaims {
  const c = (v: string[] | undefined): string[] => [...new Set(list(v).map(collapseDoubles))];
  return {
    ...sdc,
    medicalDeviceOrTherapyNouns: c(sdc.medicalDeviceOrTherapyNouns),
    replacementCues: c(sdc.replacementCues),
    anatomicalTargets: collapseEntries(sdc.anatomicalTargets),
    determinerScopedTargets: collapseEntries(sdc.determinerScopedTargets),
    pathologicalActionVerbs: c(sdc.pathologicalActionVerbs),
    lostFunctionNouns: c(sdc.lostFunctionNouns),
    functionRestorationVerbs: c(sdc.functionRestorationVerbs),
    safeContextPhrases: c(sdc.safeContextPhrases),
    // Regex SOURCES are kept VERBATIM — collapsing one would mean rewriting it,
    // and a pattern that cannot match the collapsed text simply does not fire.
    // Keeping them armed here is what catches a doubled-letter diagnosis code
    // (`IICD-10 E11.9`), whose pattern has no doubled letter of its own.
    patterns: sdc.patterns,
  };
}

function compiledSet(sdc: SemanticDrugClaims): CompiledSet {
  const cached = CACHE.get(sdc);
  if (cached) return cached;
  const set: CompiledSet = {
    spaced: compile(sdc, 'spaced'),
    concat: compile(sdc, 'concat'),
    collapsed: compile(collapsedConfig(sdc), 'spaced'),
  };
  CACHE.set(sdc, set);
  return set;
}

/**
 * Safety spans blanked out, LENGTH PRESERVED so every proximity window (and,
 * for the stripped variant, every index in the anchoring map) still lines up
 * with the original text — the same technique the allergen compound exclusions
 * use.
 */
function blankSafeSpans(text: string, safe: RegExp | null): string {
  if (!safe) return text;
  safe.lastIndex = 0;
  return text.replace(safe, (m) => ' '.repeat(m.length));
}

interface Hit {
  context: string;
  fix: string;
}

/** Anchoring predicate: identity for a spaced variant, token-anchored for a stripped one. */
type Anchor = (start: number, end: number) => boolean;

const ALWAYS: Anchor = () => true;

/**
 * Run one compiled rule set over one variant.
 *
 * `seen` is shared across every variant of a surface, so the same claim found
 * in the primary text and again in three de-obfuscated variants is reported
 * ONCE.
 */
function scanVariant(
  text: string,
  compiled: Compiled,
  anchor: Anchor,
  seen: Set<string>,
  out: Hit[],
): void {
  const { window, rules, patterns, safe, anyHead } = compiled;
  const hasHead = anyHead !== null && anyHead.test(text);
  const scanned = hasHead ? blankSafeSpans(text, safe) : text;

  for (const rule of hasHead ? rules : []) {
    rule.head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.head.exec(scanned)) !== null) {
      if (m[0].length === 0) {
        rule.head.lastIndex += 1;
        continue;
      }
      const from = m.index + m[0].length;
      if (!anchor(m.index, from)) continue;
      // Stop at the sentence boundary: a claim does not straddle a full stop.
      const tail = scanned.slice(from, from + window).split(/[.!?\n]/)[0] ?? '';
      for (const noun of rule.nouns) {
        noun.re.lastIndex = 0;
        const hit = noun.re.exec(tail);
        if (!hit) continue;
        const nounStart = from + hit.index;
        const nounEnd = nounStart + hit[0].length;
        if (!anchor(nounStart, nounEnd)) continue;
        if (noun.requires || noun.benign) {
          const span = scanned.slice(Math.max(0, nounStart - window), nounEnd + window);
          if (noun.requires && !noun.requires.test(span)) continue;
          if (noun.benign && noun.benign.test(span)) continue;
        }
        const key = `${rule.id}|${m[0].toLowerCase()}|${hit[0].toLowerCase()}`;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({
          context: text.slice(Math.max(0, m.index - 20), from + window).trim(),
          fix: rule.describe(m[0], hit[0]),
        });
        break;
      }
    }
  }

  for (const { re: pattern, label } of patterns) {
    pattern.lastIndex = 0;
    const m = pattern.exec(scanned);
    if (!m) continue;
    const key = `p|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      context: text.slice(m.index, m.index + m[0].length).trim(),
      fix: `Remove the ${label} — this is a drug claim whatever vocabulary it is written in`,
    });
  }
}

/**
 * Every variant class, scanned with the rule set that class needs. ADDITIVE:
 * the untouched text is variant #1 and is scanned exactly as it always was.
 */
function scanSurface(text: string, sdc: SemanticDrugClaims): Hit[] {
  const set = compiledSet(sdc);
  const seen = new Set<string>();
  const out: Hit[] = [];

  const { spaced, stripped } = obfuscationVariants(text);
  for (const variant of spaced) scanVariant(variant, set.spaced, ALWAYS, seen, out);

  for (const variant of doubleCollapsedVariants(text)) {
    scanVariant(variant, set.collapsed, ALWAYS, seen, out);
  }

  if (stripped) {
    // Blanking preserves length, so the map built from the UNBLANKED stripped
    // text still addresses the same characters.
    const anchor: Anchor = (start, end) => concatAnchored(text, stripped.map, start, end);
    scanVariant(stripped.stripped, set.concat, anchor, seen, out);
  }
  return out;
}

/**
 * ONE config, unioned over every semantic-claim block the pack can reach — its
 * own compliance module plus every cross-check module the pack ASSEMBLER
 * attached, exactly like the C6 lexicon union.
 *
 * Rationale, the same as C6's: a drug claim is illegal whatever the product is,
 * so a listing routed to one pack is measured against every reachable pack's
 * shapes. Unioning into a SINGLE compiled config (rather than scanning each
 * config in turn) also means each surface is blanked and scanned once.
 *
 * Consequence worth stating: a term one pack deliberately omits is still
 * enforced if another reachable pack lists it. That is why the CONTEXT
 * QUALIFICATION on a shared target ('plaque') is carried identically by both
 * packs rather than relaxed on one of them.
 */
const REACH_CACHE = new WeakMap<KnowledgePack, SemanticDrugClaims | null>();

const uniq = (lists: (string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => l ?? [])),
];

/**
 * Target lists are unioned by VALUE, not by object identity: two packs shipping
 * the same qualified target would otherwise compile two identical matchers.
 */
const uniqTargets = (lists: (SemanticTargetEntry[] | undefined)[]): SemanticTargetEntry[] => {
  const byKey = new Map<string, SemanticTargetEntry>();
  for (const entry of lists.flatMap((l) => l ?? [])) {
    const key =
      typeof entry === 'string'
        ? `s:${entry}`
        : `o:${JSON.stringify([entry?.term, entry?.requiresContext, entry?.benignContext])}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
};

function reachableSemantics(pack: KnowledgePack): SemanticDrugClaims | null {
  const cached = REACH_CACHE.get(pack);
  if (cached !== undefined) return cached;
  const seen = new Set<CompliancePack>();
  const blocks: SemanticDrugClaims[] = [];
  for (const cp of [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]) {
    if (!cp || seen.has(cp)) continue;
    seen.add(cp);
    if (cp.semanticDrugClaims) blocks.push(cp.semanticDrugClaims);
  }
  let merged: SemanticDrugClaims | null = null;
  if (blocks.length === 1) {
    merged = blocks[0]!;
  } else if (blocks.length > 1) {
    const patternKeys = new Set<string>();
    merged = {
      proximityWindow: Math.max(...blocks.map((b) => b.proximityWindow || 0), 0),
      medicalDeviceOrTherapyNouns: uniq(blocks.map((b) => b.medicalDeviceOrTherapyNouns)),
      replacementCues: uniq(blocks.map((b) => b.replacementCues)),
      anatomicalTargets: uniqTargets(blocks.map((b) => b.anatomicalTargets)),
      determinerScopedTargets: uniqTargets(blocks.map((b) => b.determinerScopedTargets)),
      pathologicalActionVerbs: uniq(blocks.map((b) => b.pathologicalActionVerbs)),
      lostFunctionNouns: uniq(blocks.map((b) => b.lostFunctionNouns)),
      functionRestorationVerbs: uniq(blocks.map((b) => b.functionRestorationVerbs)),
      // Union of the FP-reducing spans: a phrase either pack considers safety
      // copy stays safety copy, which keeps the merge from over-blocking.
      safeContextPhrases: uniq(blocks.map((b) => b.safeContextPhrases)),
      patterns: blocks
        .flatMap((b) => b.patterns ?? [])
        .filter((row) => {
          const key = String(row?.[0] ?? '');
          if (!key || patternKeys.has(key)) return false;
          patternKeys.add(key);
          return true;
        }),
    };
  }
  REACH_CACHE.set(pack, merged);
  return merged;
}

export function c21SemanticDrugClaims(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const sdc = reachableSemantics(pack);
  if (!sdc) return [];
  const disclaimers = disclaimerVariantsOf(cp).map(normalize);

  const out: Failure[] = [];
  for (const [field, textRaw] of allGeneratedSurfaces(l)) {
    const text = subtractDisclaimers(normalize(textRaw ?? ''), disclaimers);
    if (!text.trim()) continue;
    for (const hit of scanSurface(text, sdc)) {
      out.push(fail(CHECK_ID, field, hit.context, hit.fix));
    }
  }
  return out;
}
