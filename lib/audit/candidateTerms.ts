import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import {
  crossPackActionPairedNouns,
  crossPackDiseaseNouns,
  reachableCompliancePacks,
} from '@/lib/gate/checks';
import { normalize, phraseSource } from '@/lib/gate/util';

/**
 * brain/02 — THE CANDIDATE-NOUN PROPOSER (advisory, never a failure).
 *
 * A LEXICON CANNOT REPORT ITS OWN BLIND SPOT. The oral/dental nouns were
 * missing from the supplements pack for months; every run over a dental
 * listing came back clean, and the gate was working perfectly — it simply had
 * never been told those words existed. No check can catch that class, because
 * the check IS the list.
 *
 * So this reads the SOURCE listing (the seller's own copy, which names the
 * condition it is really sold for) and proposes condition-like terms the pack
 * does not already know, for whoever owns the lexicon. Two heuristics, both
 * PACK DATA (`compliancePack.candidateTermHeuristics`):
 *
 *   A. MORPHOLOGY — a word carrying a medical ending (-itis, -osis, -emia,
 *      -algia, -pathy …). 'Gingivitis' is a candidate the moment it appears,
 *      whatever the pack knows.
 *   B. ADJACENCY — the noun a therapeutic verb acts on ("helps with X",
 *      "relief from X"). What a seller claims to act on is, by construction,
 *      what they think the product treats.
 *
 * Everything already in the enforced lexicon is removed — a term the gate
 * already knows is not a proposal — as are pack stopwords, short words and
 * bare numbers. The result is a short ADVISORY list. It never enters
 * `verified`, never becomes a gap and never blocks anything: it is a message
 * to a human about the CHECKER, not about the copy.
 */

/** Words are compared lower-case; the display form keeps the first casing seen. */
const MAX_TERMS = 12;
const MIN_LEN = 5;

function sourceText(current: ListingSnapshot): string {
  return normalize(
    [
      current.title ?? '',
      ...(Array.isArray(current.bullets) ? current.bullets : []),
      current.description ?? '',
      ...Object.values(current.attributes ?? {}),
    ].join(' \n '),
  );
}

export function candidateTerms(current: ListingSnapshot, pack: KnowledgePack): string[] {
  const cp = pack.compliancePack;
  const h = cp?.candidateTermHeuristics;
  if (!h) return [];
  const suffixes = (h.medicalSuffixes ?? []).map((x) => x.toLowerCase()).filter(Boolean);
  const cues = (h.therapeuticVerbCues ?? []).map((x) => x.toLowerCase()).filter(Boolean);
  const stop = new Set((h.stopwords ?? []).map((x) => x.toLowerCase()));
  if (suffixes.length === 0 && cues.length === 0) return [];

  // KNOWN = everything the gate already enforces, across every reachable
  // compliance module, plus the natural-state and symptom vocabularies.
  const known = new Set<string>();
  for (const term of [...crossPackDiseaseNouns(pack), ...crossPackActionPairedNouns(pack)]) {
    known.add(term.toLowerCase());
  }
  // NOTE the loop variable is `compliance`, not `module`: `module` is a reserved
  // CommonJS binding and shadowing it is a real hazard in a Next.js bundle
  // (`@next/next/no-assign-module-variable`). Rename only — same iteration, same
  // terms, same order.
  for (const compliance of reachableCompliancePacks(pack)) {
    for (const term of [
      ...(compliance.naturalStates ?? []),
      ...(compliance.normalSymptomologyNouns ?? []),
      ...(compliance.abnormalOnlySymptomNouns ?? []),
    ]) {
      known.add(term.toLowerCase());
    }
  }
  const isKnown = (word: string): boolean =>
    known.has(word) || [...known].some((k) => k.includes(' ') && k.includes(word));

  const text = sourceText(current);
  const lower = text.toLowerCase();
  const words = text.split(/[^A-Za-z-]+/).filter(Boolean);
  const found = new Map<string, string>();

  const propose = (raw: string): void => {
    const word = raw.replace(/^-+|-+$/g, '');
    const key = word.toLowerCase();
    if (key.length < MIN_LEN) return;
    if (stop.has(key) || isKnown(key)) return;
    if (!/^[a-z-]+$/i.test(word)) return;
    // Cheap part-of-speech filter: a condition noun is not a participle or an
    // adverb. Costs nothing and removes most of the adjacency noise.
    if (/(ing|ly)$/i.test(key)) return;
    if (!found.has(key)) found.set(key, word);
  };

  // --- A. morphology ---
  for (const word of words) {
    const key = word.toLowerCase();
    if (suffixes.some((suffix) => key.endsWith(suffix))) propose(word);
  }

  // --- B. adjacency to a therapeutic cue ---
  // WORD BOUNDARIES, not substrings. A raw `indexOf` made 'heal' match inside
  // "healthy" and proposed the next word along, which is how "supports healthy
  // gut flora" produced 'flora' as a candidate CONDITION. A proposer that
  // cries wolf is one a lexicon owner stops reading.
  for (const cue of cues) {
    const re = new RegExp(`\\b${phraseSource(cue)}\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const from = m.index + m[0].length;
      // The OBJECT of the cue: same clause only (a cue cannot reach across a
      // full stop or a comma — "to treat gingivitis. Users report…" must not
      // propose 'Users'), and only the first two words, which is where an
      // object noun actually sits.
      const clause = text.slice(from, from + 60).split(/[.,;:!?()]/)[0] ?? '';
      const tail = clause.split(/[^A-Za-z-]+/).filter(Boolean);
      for (const word of tail.slice(0, 2)) propose(word);
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
    }
  }

  return [...found.values()].sort((a, b) => a.localeCompare(b)).slice(0, MAX_TERMS);
}
