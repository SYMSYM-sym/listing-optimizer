import { keywordSurfaceText } from '@/lib/gate/checks';
import { disclaimerVariantsOf } from '@/lib/gate/checks/shared';
import { normalize, subtractDisclaimers, termRegex } from '@/lib/gate/util';
import type {
  KeywordStatus,
  KeywordTerm,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';

/**
 * WS3 — WHERE A TERM ACTUALLY SITS IS **DERIVED**, NEVER DECLARED.
 *
 * THE LIVE DEFECT THIS REPLACES. The keyword group was asked to state, for
 * every term, which surfaces its own copy had placed it on. Production, all
 * three ASINs, every single run:
 *
 *   C28 | keywords[2] 'digestive and immune support' declared placed on
 *       | 'title' but does not appear there
 *   C28 | keywords[4] 'lgg strain' declared placed on 'title'/'itemHighlights'
 *       | but does not appear there
 *   C28 | keywords[8] 'vegetarian capsules' declared placed on
 *       | 'bullet4'/'description' but does not appear there
 *
 * 21–22 of them per run, never converging: each repair round produced a FRESH
 * set of confident wrong claims, so the loop had nothing to converge onto.
 *
 * WHY IT COULD NEVER CONVERGE — AND WHY THE FIX IS NOT A BETTER PROMPT. The
 * project's own worker != checker principle says the model must not be asked
 * to assert a fact that CODE CAN COMPUTE EXACTLY. "Does this exact string
 * occur in that exact field" is such a fact: it is a substring search over
 * strings the pipeline is already holding. Asking a language model to perform
 * it, then having the gate perform it again and fail the run on every
 * disagreement, is a coin-flip dressed as a verification. So the self-report
 * is DELETED — not corrected, not re-prompted — and the map is computed.
 *
 * THE SPLIT OF LABOUR:
 *   MODEL  — the terms themselves (`term`, `tier`, `why`) and the four
 *            INTENT-BEARING statuses only it can judge:
 *              `negative`     — rival brands and banned vocabulary (R50),
 *              `not-targeted` — a deliberate strategy call,
 *              `candidate`    — held back for a later cycle,
 *              `captured-via` — banned demand reached through a compliant
 *                               route, named in `via` (K4).
 *            None of those is a claim about the copy; each is a judgement,
 *            and a judgement is exactly what a model is for.
 *   CODE   — `surfaces` and the PLACEMENT status of every other row, read off
 *            the finished copy through C28's OWN pack-driven surface readers
 *            (`keywordSurfaceText`), with the SAME disclaimer subtraction the
 *            check applies. Same reader, same corpus, same normalisation:
 *            what is derived here is by construction what C28 measures there.
 *
 * WHAT C28 STILL DOES, UNWEAKENED. Everything except the self-report class:
 * a `negative` term appearing ANYWHERE fails; a `backend` term on a visible
 * surface fails; a `captured-via` row with no `via` fails; a banned-lexicon
 * term that ends up targeted fails; an unknown surface name in pack config
 * fails; a missing or malformed artifact fails closed. The check keeps its
 * placement leg too, so a stored or hand-edited artifact that was never put
 * through this derivation is still verified against the copy. What can no
 * longer happen is the model being WRONG about a fact it was never in a
 * position to know.
 *
 * NEVER A SILENT LIE. A term the finished copy carries nowhere is DOWNGRADED
 * to `candidate` and the downgrade is recorded in `note` — it is not quietly
 * dropped and it is certainly not left saying `placed`.
 *
 * PACK-DRIVEN AND CLOSED-WORLD. Every surface name comes from
 * `rules.keywordRules`; a name this module cannot read is skipped HERE (so
 * derivation never invents a placement) and reported THERE by C28's
 * closed-world leg, which is the half that fails the run.
 */

/**
 * The statuses the MODEL owns. Each states an INTENT about a term rather than
 * a fact about the copy, so none of them is derivable and none is overwritten.
 * `captured-via` belongs here for a second reason: its whole meaning is that
 * the term is deliberately ABSENT, so deriving it would downgrade every
 * lawfully recaptured row and destroy K4.
 */
export const MODEL_OWNED_STATUSES: readonly KeywordStatus[] = [
  'negative',
  'not-targeted',
  'candidate',
  'captured-via',
];

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** A specific bullet slot (`bullet3`) as opposed to the whole-bullets aggregate. */
const BULLET_SLOT_RE = /^bullet\d+$/i;
const BULLET_AGGREGATE = 'bullets';

export function deriveKeywordPlacement(
  rows: KeywordTerm[],
  listing: OptimizedListing,
  pack: KnowledgePack,
): KeywordTerm[] {
  const kr = pack.rules?.keywordRules;
  // No pack rules => no surface vocabulary to read, so nothing can be derived.
  // Not a silent pass: `rules.keywordRules.*` are REQUIRED_PACK_PIECES rows and
  // such a pack already fails CLOSED at PACK.
  if (!kr) return rows;

  const clean = (names: unknown): string[] =>
    (Array.isArray(names) ? names : []).map((s) => str(s).trim()).filter(Boolean);
  const visible = clean(kr.visibleSurfaces);
  const backend = clean(kr.backendSurfaces);

  // The SAME subtraction C28 applies: the verbatim disclaimer is required legal
  // text, and a term that occurs only inside it has not been "placed" by the
  // copy. Deriving without this would manufacture placements the check then
  // refuses to confirm — the very disagreement being removed.
  const disclaimers = [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]
    .filter((cp): cp is NonNullable<typeof cp> => !!cp)
    .flatMap((cp) => disclaimerVariantsOf(cp))
    .map(normalize);

  const hay = new Map<string, string>();
  for (const name of [...visible, ...backend]) {
    const raw = keywordSurfaceText(listing, name);
    // A surface the reader cannot resolve is left OUT of the corpus rather
    // than treated as empty: C28's closed-world leg fails the run on it, and
    // derivation must never vouch for text it could not read.
    if (raw === null) continue;
    hay.set(name, subtractDisclaimers(normalize(raw), disclaimers));
  }

  const carries = (name: string, term: string): boolean => {
    const text = hay.get(name);
    return text !== undefined && termRegex(term).test(text);
  };

  return rows.map((raw) => {
    const row = (raw ?? {}) as KeywordTerm;
    const term = str(row.term).trim();
    // A row with no term is malformed input; C28 reports it. Derivation leaves
    // it exactly as it arrived so the check sees the real thing.
    if (!term) return row;

    const status = str(row.status).trim() as KeywordStatus;
    if (MODEL_OWNED_STATUSES.includes(status)) {
      // The model's judgement stands. It declares no surfaces any more, so the
      // list is emptied rather than carried: an intent row places nothing.
      return { ...row, surfaces: [] };
    }

    const visibleHits = visible.filter((name) => carries(name, term));
    const backendHits = backend.filter((name) => carries(name, term));

    // The whole-bullets aggregate and a specific slot are the SAME fact stated
    // twice; when a slot matched, the aggregate is dropped so the placement map
    // an operator reads names the slot rather than both.
    const trimmed = visibleHits.some((n) => BULLET_SLOT_RE.test(n))
      ? visibleHits.filter((n) => n.toLowerCase() !== BULLET_AGGREGATE)
      : visibleHits;

    if (trimmed.length > 0) {
      return { ...row, status: 'placed' as KeywordStatus, surfaces: [...trimmed, ...backendHits] };
    }
    if (backendHits.length > 0) {
      return { ...row, status: 'backend' as KeywordStatus, surfaces: [...backendHits] };
    }
    return {
      ...row,
      status: 'candidate' as KeywordStatus,
      surfaces: [],
      note:
        `Derived: the finished copy carries this term on no surface the pack knows, so the row` +
        ` was downgraded from '${status || '(none)'}' to candidate rather than left claiming a placement.`,
    };
  });
}
