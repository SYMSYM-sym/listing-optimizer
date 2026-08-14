import type {
  KnowledgePack,
  ListingSnapshot,
  PrincipleScore,
  Scorecard,
} from '@/lib/types';
import { extractUnitNumbers } from '@/lib/gate/checks';
import { tokenSet } from '@/lib/gate/util';
import { buildFacts } from '@/lib/engine/facts';

/**
 * Deterministic scorer of the CURRENT listing against the pack principles.
 * Principles that cannot be assessed from public data score 'unknown' and are
 * EXCLUDED from the denominator (renormalized) — never silently scored 0.
 */

type Verdict = PrincipleScore['score'];

/**
 * NULL-SAFE surface coercion — defence in depth beside `proposedAsSnapshot`.
 *
 * Every judge below reads free-form listing text. A malformed value must lower
 * a SCORE, never throw: a thrown scorer escapes `buildAudit` and the caller
 * never receives `verified:false` at all, which is a fail-OPEN in practice.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);
const value: Record<Verdict, number> = { full: 1, partial: 0.5, none: 0, unknown: 0 };

/**
 * WS6 — facts about a listing that are NOT visible in a public snapshot.
 *
 * Three principles score `unknown` for a scraped listing because the data is
 * simply not public: the backend search terms are seller-private (P3), the
 * seeded Q&A layer is not in the PDP payload (P12), and review language is not
 * in the snapshot at all (P11). For the PROPOSED listing we DO hold two of
 * them, and WS9 supplies the third when the operator pastes review text.
 *
 * ABSENT means UNCHANGED: with no inputs every judge below behaves exactly as
 * it did before, so the current-listing scorecard is bit-for-bit what it was.
 * A known input can only move a principle OFF `unknown` — it can never change
 * how a principle that was already scorable is judged.
 */
export interface ScoreInputs {
  /** Backend search terms, when known (the proposed listing's are). */
  backendSearchTerms?: string;
  /** The seeded Q&A layer, when known. */
  qa?: { q: string; a: string }[];
}

interface SnapshotView {
  s: ListingSnapshot;
  pack: KnowledgePack;
  allText: string;
  aplusText: string;
  inputs: ScoreInputs;
}

function judge(id: string, v: SnapshotView): { score: Verdict; rationale: string } {
  const { s, pack } = v;
  switch (id) {
    case 'P1': {
      const kws = Object.values(pack.compliancePack?.subcategoryKeywords ?? {}).flat();
      const head = str(s.title).slice(0, 75).toLowerCase();
      if (kws.some((k) => head.includes(k))) return { score: 'full', rationale: 'Category keyword present in the first 75 title chars.' };
      if (kws.some((k) => str(s.title).toLowerCase().includes(k))) return { score: 'partial', rationale: 'Category keyword in title but not front-loaded.' };
      return { score: 'none', rationale: 'No category-defining keyword found early in the title.' };
    }
    case 'P2': {
      const words = str(s.title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      const over = [...counts.entries()].filter(([, c]) => c > 2);
      if (over.length > 0) return { score: 'none', rationale: `Words repeated >2× in title: ${over.map(([w]) => w).join(', ')}.` };
      const twice = [...counts.entries()].filter(([, c]) => c === 2);
      return twice.length > 2
        ? { score: 'partial', rationale: 'Several title words repeated twice — wasted indexed space.' }
        : { score: 'full', rationale: 'No wasteful word repetition in the title.' };
    }
    case 'P3': {
      // UNKNOWN unless the caller supplies the field (see `ScoreInputs`).
      const backend = v.inputs.backendSearchTerms;
      if (backend === undefined) {
        return { score: 'unknown', rationale: 'Backend search terms are seller-private — not publicly visible.' };
      }
      const terms = tokenSet(backend);
      if (terms.size === 0) {
        return { score: 'none', rationale: 'Backend search terms are empty — the sparse-retrieval leg is unused.' };
      }
      // The field's whole job is to carry what visible copy does NOT say, so a
      // term already indexed in the title surfaces is a wasted byte.
      const visible = tokenSet(`${str(s.title)} ${strings(s.bullets).join(' ')}`);
      const wasted = [...terms].filter((t) => visible.has(t));
      const rationale = `${terms.size} distinct backend token(s); ${wasted.length} already indexed in visible copy.`;
      if (wasted.length === 0) return { score: 'full', rationale };
      return wasted.length * 2 <= terms.size
        ? { score: 'partial', rationale }
        : { score: 'none', rationale };
    }
    case 'P4': {
      const fields = pack.attributeSchema;
      if (fields.length === 0) return { score: 'unknown', rationale: 'No attribute schema for this pack.' };
      const filled = fields.filter((f) => str(s.attributes?.[f.field]).trim() !== '').length;
      const ratio = filled / fields.length;
      const facet = fields.filter((f) => f.filterFacet);
      const facetFilled = facet.filter((f) => str(s.attributes?.[f.field]).trim() !== '').length;
      const rationale = `${filled}/${fields.length} schema fields visible (${facetFilled}/${facet.length} filter facets).`;
      if (ratio >= 0.7) return { score: 'full', rationale };
      if (ratio >= 0.35) return { score: 'partial', rationale };
      return { score: 'none', rationale };
    }
    case 'P5': {
      const depth = str(s.category).split('>').filter(Boolean).length;
      if (depth >= 3) return { score: 'full', rationale: `Category path depth ${depth} — reasonably specific node (validate in Product Classifier).` };
      if (depth === 2) return { score: 'partial', rationale: 'Category path is shallow — a tighter node likely exists.' };
      return { score: 'none', rationale: 'No specific browse node visible.' };
    }
    case 'P6': {
      const tokens = tokenSet(`${str(s.title)} ${strings(s.bullets).join(' ')}`);
      const rationale = `${tokens.size} distinct content tokens across title+bullets.`;
      if (tokens.size >= 60) return { score: 'full', rationale };
      if (tokens.size >= 30) return { score: 'partial', rationale };
      return { score: 'none', rationale };
    }
    case 'P7': {
      const markers = /\b(for|when|during|while|helps|after|before|routine|daily)\b/i;
      const bullets = strings(s.bullets);
      const hits = bullets.filter((b) => markers.test(b)).length;
      const rationale = `${hits}/${bullets.length} bullets carry situational framing.`;
      if (bullets.length === 0) return { score: 'none', rationale: 'No bullets.' };
      if (hits >= Math.ceil(bullets.length * 0.8)) return { score: 'full', rationale };
      if (hits >= Math.ceil(bullets.length * 0.4)) return { score: 'partial', rationale };
      return { score: 'none', rationale };
    }
    case 'P8': {
      const bullets = strings(s.bullets);
      const anchored = bullets.filter((b) => /^[A-Z][A-Z0-9 &'-]{3,40}:/.test(b.trim())).length;
      const rationale = `${anchored}/${bullets.length} bullets open with a distinct anchor hook.`;
      if (bullets.length === 0) return { score: 'none', rationale: 'No bullets.' };
      if (anchored >= 4) return { score: 'full', rationale };
      if (anchored >= 2) return { score: 'partial', rationale };
      return { score: 'none', rationale };
    }
    case 'P9': {
      const t = v.allText.toLowerCase();
      return /\b(unlike|compared to|vs\.?|versus|typical|other brands|alternatives)\b/.test(t)
        ? { score: 'full', rationale: 'Comparative framing present.' }
        : { score: 'none', rationale: 'No comparative framing (vs alternatives / who it is best for).' };
    }
    case 'P10': {
      if (v.aplusText.length > 300) return { score: 'full', rationale: 'A+ present with substantial extractable text.' };
      if (v.aplusText.length > 0) return { score: 'partial', rationale: 'A+ present but thin extractable text.' };
      return { score: 'none', rationale: 'No A+ text detected — AI/voice engines have nothing to read.' };
    }
    case 'P11':
      return { score: 'unknown', rationale: 'Review-language mirroring requires review data — not assessed.' };
    case 'P12': {
      const qa = v.inputs.qa;
      if (qa === undefined) {
        return { score: 'unknown', rationale: 'Q&A layer not visible from the public snapshot.' };
      }
      const answered = qa.filter((f) => (f?.q ?? '').trim() !== '' && (f?.a ?? '').trim() !== '');
      const rationale = `${answered.length} prepared Q&A pair(s).`;
      if (answered.length >= 15) return { score: 'full', rationale };
      if (answered.length >= 5) return { score: 'partial', rationale };
      return { score: 'none', rationale };
    }
    case 'P13': {
      const bans = pack.compliancePack?.superlativeBans ?? [];
      const t = v.allText.toLowerCase();
      const hit = bans.find((b) => t.includes(b.toLowerCase()));
      const stars = /\b\d(?:\.\d)?\s*[- ]?star|\b[\d,]+\+?\s*reviews\b/i.test(t);
      if (hit || stars) return { score: 'none', rationale: `Forbidden social proof/superlative present${hit ? ` ('${hit}')` : ' (star/review claim)'}.` };
      return { score: 'full', rationale: 'No forbidden superlatives or review claims found.' };
    }
    case 'P14': {
      const facts = buildFacts(s, pack);
      if (!facts.potency && !facts.unitCount) return { score: 'unknown', rationale: 'Too few structured facts to test consistency.' };
      const surfaces = [str(s.title), ...strings(s.bullets), str(s.description)];
      const conflicts: string[] = [];
      // Potency units + their equivalence families are PACK DATA — no unit literal here.
      const families = pack.rules.units.families;
      const familyOf = (unit: string): string =>
        families.find((f) => f.some((u) => u.toLowerCase() === unit))?.[0]?.toLowerCase() ?? unit;
      for (const surface of surfaces) {
        const nums = extractUnitNumbers(surface, pack.rules.units).filter(
          (n) => n.dimension === 'potency',
        );
        const byFamily = new Map<string, Set<number>>();
        for (const n of nums) {
          const key = familyOf(n.unit);
          const set = byFamily.get(key) ?? new Set<number>();
          set.add(n.value);
          byFamily.set(key, set);
        }
        for (const distinct of byFamily.values()) {
          if (distinct.size > 1) conflicts.push([...distinct].join(' vs '));
        }
      }
      return conflicts.length > 0
        ? { score: 'none', rationale: `Potency figures conflict within a surface: ${conflicts.join('; ')}.` }
        : { score: 'full', rationale: 'Recurring numeric facts agree across visible surfaces.' };
    }
    default:
      return { score: 'unknown', rationale: 'Process rule — not a property of a listing snapshot.' };
  }
}

export function scoreAgainstPrinciples(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  inputs: ScoreInputs = {},
): Scorecard {
  const raw = snapshot.raw as { aplusText?: string } | null;
  const view: SnapshotView = {
    s: snapshot,
    pack,
    allText: `${str(snapshot.title)} ${strings(snapshot.bullets).join(' ')} ${str(snapshot.description)}`,
    aplusText: raw?.aplusText ?? '',
    inputs,
  };
  const perPrinciple: PrincipleScore[] = pack.principles.map((p) => {
    if (!p.scorable) {
      return { id: p.id, score: 'unknown', rationale: p.rubric ?? 'Process rule — not scored.' };
    }
    const { score, rationale } = judge(p.id, view);
    return { id: p.id, score, rationale };
  });

  // Renormalize over scorable + known principles (unknowns excluded from the
  // denominator — an un-auditable principle must never deflate the score).
  let num = 0;
  let den = 0;
  for (const p of pack.principles) {
    const ps = perPrinciple.find((x) => x.id === p.id);
    if (!p.scorable || !ps || ps.score === 'unknown') continue;
    num += p.weight * value[ps.score];
    den += p.weight;
  }
  const total = den === 0 ? 0 : Math.round((num / den) * 100);
  return { total, perPrinciple };
}
