import type {
  CompliancePack,
  Failure,
  KnowledgePack,
  OptimizedListing,
  SemanticDrugClaims,
} from '@/lib/types';
import { normalize, subtractDisclaimers } from '../util';
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
 *  - the scan runs over the NORMALIZED surface text. C6's de-obfuscation,
 *    doubled-letter and separator-split passes are NOT applied here, so
 *    `shr1nks the lump` is caught by neither check;
 *  - it is a proximity heuristic, not a parser: it reports a verb/cue followed
 *    by its noun inside `proximityWindow` characters and cannot tell who the
 *    subject is;
 *  - `safeContextPhrases` (pack data) are blanked out first, which is what
 *    keeps required safety copy ("do not stop taking your medication") clean.
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

/** Longest-first alternation over pack tokens; inner whitespace stays flexible. */
function alternation(tokens: string[]): string | null {
  const cleaned = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (cleaned.length === 0) return null;
  return cleaned.map((t) => escapeRe(t).replace(/\s+/g, '\\s+')).join('|');
}

interface ProximityRule {
  /** Stable id rendered into the failure fix text. */
  id: string;
  /** Verb/cue side. */
  head: RegExp;
  /** Noun side, matched inside the window that follows the head. */
  noun: RegExp;
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
   * spans costs one regex replace per pack phrase, and the overwhelming
   * majority of surfaces contain no head token at all, so the expensive work is
   * gated behind this single test. Blanking only ever REMOVES text, so a
   * surface with no head match in the raw text can have none after blanking.
   */
  anyHead: RegExp | null;
}

const CACHE = new WeakMap<SemanticDrugClaims, Compiled>();

function nounRe(source: string | null): RegExp | null {
  return source ? new RegExp(`\\b(?:${source})\\b`, 'i') : null;
}

function compile(sdc: SemanticDrugClaims): Compiled {
  const cached = CACHE.get(sdc);
  if (cached) return cached;

  const rules: ProximityRule[] = [];

  const pathVerbs = alternation(sdc.pathologicalActionVerbs ?? []);
  const plainTargets = alternation(sdc.anatomicalTargets ?? []);
  const scopedTargets = alternation(sdc.determinerScopedTargets ?? []);
  // A determiner-scoped target counts only when a determiner points at it.
  const scopedSource = scopedTargets
    ? `(?:${alternation(DETERMINERS)})\\s+(?:${scopedTargets})`
    : null;
  const targetSource = [plainTargets, scopedSource].filter(Boolean).join('|') || null;
  if (pathVerbs && targetSource) {
    rules.push({
      id: 'pathological-action',
      head: new RegExp(`\\b(?:${pathVerbs})\\b`, 'gi'),
      noun: nounRe(targetSource)!,
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — acting on a body structure is a drug claim; describe a structure/function benefit instead`,
    });
  }

  const cues = alternation(sdc.replacementCues ?? []);
  const therapy = alternation(sdc.medicalDeviceOrTherapyNouns ?? []);
  if (cues && therapy) {
    rules.push({
      id: 'therapy-replacement',
      head: new RegExp(`\\b(?:${cues})\\b`, 'gi'),
      noun: nounRe(therapy)!,
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — claiming a product replaces or ends the need for a medical therapy or device is a drug claim`,
    });
  }

  const restoreVerbs = alternation(sdc.functionRestorationVerbs ?? []);
  const lostFunctions = alternation(sdc.lostFunctionNouns ?? []);
  if (restoreVerbs && lostFunctions) {
    rules.push({
      id: 'function-restoration',
      head: new RegExp(`\\b(?:${restoreVerbs})\\b`, 'gi'),
      noun: nounRe(lostFunctions)!,
      describe: (h, n) =>
        `Drug-claim shape '${h} … ${n}' — restoring a lost bodily function is a drug claim`,
    });
  }

  const patterns = (sdc.patterns ?? [])
    .filter((row) => Array.isArray(row) && typeof row[0] === 'string' && row[0].trim())
    .map((row) => ({ re: new RegExp(row[0]!, 'gi'), label: row[1] ?? 'prohibited claim' }));

  // ONE alternation, not one regex per phrase: blanking runs on every surface
  // that contains a head token, and 25 separate passes over the text was the
  // dominant cost of this check.
  const safeSource = alternation(sdc.safeContextPhrases ?? []);
  const safe = safeSource ? new RegExp(`(?:${safeSource})`, 'gi') : null;

  const headSource = alternation([
    ...(sdc.pathologicalActionVerbs ?? []),
    ...(sdc.replacementCues ?? []),
    ...(sdc.functionRestorationVerbs ?? []),
  ]);

  const compiled: Compiled = {
    window: typeof sdc.proximityWindow === 'number' && sdc.proximityWindow > 0 ? sdc.proximityWindow : 40,
    rules,
    patterns,
    safe,
    anyHead: headSource ? new RegExp(`\\b(?:${headSource})\\b`, 'i') : null,
  };
  CACHE.set(sdc, compiled);
  return compiled;
}

/**
 * Safety spans blanked out, LENGTH PRESERVED so every proximity window still
 * lines up with the original text (the same technique the allergen compound
 * exclusions use).
 */
function blankSafeSpans(text: string, safe: RegExp | null): string {
  if (!safe) return text;
  safe.lastIndex = 0;
  return text.replace(safe, (m) => ' '.repeat(m.length));
}

function scanSurface(text: string, sdc: SemanticDrugClaims): { context: string; fix: string }[] {
  const { window, rules, patterns, safe, anyHead } = compile(sdc);
  const hasHead = anyHead !== null && anyHead.test(text);
  const scanned = hasHead ? blankSafeSpans(text, safe) : text;
  const out: { context: string; fix: string }[] = [];
  const seen = new Set<string>();

  for (const rule of hasHead ? rules : []) {
    rule.head.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.head.exec(scanned)) !== null) {
      if (m[0].length === 0) {
        rule.head.lastIndex += 1;
        continue;
      }
      const from = m.index + m[0].length;
      // Stop at the sentence boundary: a claim does not straddle a full stop.
      const tail = scanned.slice(from, from + window).split(/[.!?\n]/)[0] ?? '';
      const hit = rule.noun.exec(tail);
      if (!hit) continue;
      const key = `${rule.id}|${m[0].toLowerCase()}|${hit[0].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        context: text.slice(Math.max(0, m.index - 20), from + window).trim(),
        fix: rule.describe(m[0], hit[0]),
      });
    }
  }

  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    const m = re.exec(scanned);
    if (!m) continue;
    const key = `p|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      context: text.slice(m.index, m.index + m[0].length).trim(),
      fix: `Remove the ${label} — this is a drug claim whatever vocabulary it is written in`,
    });
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
 * enforced if another reachable pack lists it. That is why 'plaque' is
 * determiner-scoped on BOTH packs rather than dropped from one of them.
 */
const REACH_CACHE = new WeakMap<KnowledgePack, SemanticDrugClaims | null>();

const uniq = (lists: (string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => l ?? [])),
];

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
      anatomicalTargets: uniq(blocks.map((b) => b.anatomicalTargets)),
      determinerScopedTargets: uniq(blocks.map((b) => b.determinerScopedTargets)),
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
