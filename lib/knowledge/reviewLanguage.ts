import type { CompliancePack, KnowledgePack } from '@/lib/types';
import {
  crossPackActionPairedNouns,
  crossPackDiseaseNouns,
  diseaseActionVerbs,
  reachableCompliancePacks,
} from '@/lib/gate/checks/pack';
import { normalize, termRegex, tokenSet } from '@/lib/gate/util';

/**
 * WS9 — MINING COMPLIANT PHRASING OUT OF OPERATOR-SUPPLIED REVIEW TEXT.
 *
 * WHY THIS IS THE ONLY SAFE SHAPE. The playbook is explicit: reviews may carry
 * symptom words because that is allowed CUSTOMER speech and the marketplace's
 * own review-summary model indexes them — but your copy mirrors only the
 * COMPLIANT HALVES. So review text is a source of phrasing, never a source of
 * claims, and the filter is not a judgement call: a sentence is rejected when
 * it matches the compliance lexicons the GATE already enforces. There is no
 * second opinion and no separate word list to drift.
 *
 * REJECTION IS RECORDED, not silent. A caller gets the rejected fragments and
 * the reason, so an operator can see that the two sentences they cared about
 * were dropped because they name a condition — rather than wondering why their
 * review text seemed to do nothing.
 *
 * NOTHING HERE IS PERSISTED and nothing here relaxes a check: mined phrasing
 * is prompt guidance, and every surface written from it is scanned by the gate
 * exactly as before.
 */

/** Defensive bounds — an operator pastes a page of reviews, not a corpus. */
const MAX_INPUT_CHARS = 20_000;
const MAX_PHRASES = 40;
const MIN_PHRASE_WORDS = 3;
const MAX_PHRASE_WORDS = 18;

export interface MinedReviewLanguage {
  /** Sentences that carry no banned vocabulary — safe to mirror. */
  phrases: string[];
  /** Fragments that were dropped, and why. */
  rejected: { fragment: string; why: string }[];
  /** Distinct lowercase content tokens across the compliant phrases. */
  tokens: string[];
}

const EMPTY: MinedReviewLanguage = { phrases: [], rejected: [], tokens: [] };

/** Every banned term the gate would fail, as one list. */
function bannedTerms(pack: KnowledgePack): { term: string; why: string }[] {
  const out: { term: string; why: string }[] = [];
  const seen = new Set<string>();
  const add = (term: string, why: string): void => {
    const t = term.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ term: t, why });
  };
  for (const n of crossPackDiseaseNouns(pack)) add(n, 'names a condition or a prescription drug');
  for (const n of crossPackActionPairedNouns(pack)) add(n, 'names a state a claim may not act on');
  const packs: CompliancePack[] = reachableCompliancePacks(pack);
  for (const cp of packs) {
    for (const v of diseaseActionVerbs(cp)) add(v, 'is a therapeutic action verb');
    for (const s of cp.superlativeBans ?? []) add(s, 'is a banned superlative or rank claim');
    for (const m of cp.abnormalityMarkers ?? []) add(m, 'marks an abnormal condition');
    for (const s of cp.abnormalOnlySymptomNouns ?? []) add(s, 'is a symptom word');
    for (const s of cp.normalSymptomologyNouns ?? []) add(s, 'is a symptom word');
  }
  return out;
}

/** Split into sentence-ish fragments without inventing an NLP dependency. */
function fragments(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|\r+|(?: - )|(?:; )/)
    .map((f) => normalize(f).trim())
    .filter(Boolean);
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function mineReviewLanguage(
  pack: KnowledgePack,
  reviewsText: unknown,
): MinedReviewLanguage {
  if (typeof reviewsText !== 'string') return EMPTY;
  const text = reviewsText.slice(0, MAX_INPUT_CHARS).trim();
  if (!text) return EMPTY;

  const banned = bannedTerms(pack);
  const phrases: string[] = [];
  const rejected: { fragment: string; why: string }[] = [];
  const seen = new Set<string>();

  for (const fragment of fragments(text)) {
    const words = wordCount(fragment);
    if (words < MIN_PHRASE_WORDS || words > MAX_PHRASE_WORDS) continue;
    const key = fragment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // The SAME lexicons the gate enforces — no second opinion.
    const hit = banned.find((b) => termRegex(b.term).test(fragment));
    if (hit) {
      rejected.push({ fragment, why: `'${hit.term}' ${hit.why}` });
      continue;
    }
    phrases.push(fragment);
    if (phrases.length >= MAX_PHRASES) break;
  }

  // The SAME tokenizer the scorer uses on the copy — a different one here
  // would make the overlap ratio meaningless (stemming and stopwords have to
  // match on both sides of the comparison).
  const tokens = [...tokenSet(phrases.join(' '))].filter((t) => t.length > 3);

  return { phrases, rejected, tokens };
}
