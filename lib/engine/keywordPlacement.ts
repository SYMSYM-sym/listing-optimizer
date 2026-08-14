import { keywordSurfaceText } from '@/lib/gate/checks';
import { disclaimerVariantsOf } from '@/lib/gate/checks/shared';
import { normalize, subtractDisclaimers, termRegex } from '@/lib/gate/util';
import type {
  KeywordStatus,
  KeywordTerm,
  KnowledgePack,
  ListingSnapshot,
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
 * THE SECOND LIVE DEFECT THIS MODULE NOW ABSORBS — A `negative` ROW NAMING THE
 * SUBJECT PRODUCT'S OWN BRAND.
 *
 * Production, ASIN B00IO89MYA, one failure and the run could not converge:
 *
 *   C28 | keywords[21] | negative term 'instant immunity' appears on
 *       |              | 'attributes'
 *
 * `negative` means "a term that must appear NOWHERE", and its purpose is
 * RIVAL-BRAND exclusion (R50). The model classified the product's OWN brand
 * name as negative; C28 then correctly found it in `brand_name` /
 * `manufacturer`, where it MUST appear. The check was right about its rule and
 * the model was wrong about its input, so no amount of repair could clear it:
 * every compliant listing must carry its own brand in its brand attributes.
 *
 * WHY THE FIX IS CODE, NOT A BETTER PROMPT — the same principle that moved the
 * placement map here. "Is this term the subject product's own brand identity?"
 * is a fact CODE CAN COMPUTE EXACTLY: the brand identity is sitting in the
 * ingested snapshot (`brand_name`, `manufacturer`), in the run's resolved
 * canonical `productName`, and at the head of the scraped title. A term that
 * IS that identity is not a rival by construction, so `negative` is an
 * INCOHERENT classification of it and is rejected at this derivation boundary.
 *
 * NOT DELETED — RECLASSIFIED, AND SAID OUT LOUD. The row is not dropped (that
 * would hide a model error and silently shrink the artifact). Its real
 * placement is derived from the finished copy exactly like any other term, and
 * the correction is written onto `note`, so the audit and the ship sheet show
 * what code changed and why.
 *
 * CONSERVATIVE BY CONSTRUCTION, AND R50 IS UNTOUCHED. The exemption fires only
 * when the term, normalised, EQUALS one of the identity strings. A term that
 * merely shares a word with the brand is NOT exempt — a brand of the shape
 * "<Word> <Category>" exempts itself and never the category word that happens
 * to sit inside it. Nothing is read from the model: the identity comes from
 * the snapshot, plus the canonical product name the run pinned (itself held to
 * the snapshot's brand by C7 and to the title by C8/C15). Every genuine rival
 * brand marked `negative` still fails from every surface, the invisible ones
 * included — `tests/keywordDerivation.ownBrand.test.ts` plants one in each.
 *
 * THE FLOOR CANNOT BE GAMED. `minNegatives` is counted by C28 over the FINAL
 * artifact, so a reclassified row is no longer a negative when the floor is
 * measured: a run whose only negatives were self-references fails the floor
 * rather than satisfying it with its own name.
 */

/**
 * The statuses the MODEL owns. Each states an INTENT about a term rather than
 * a fact about the copy, so none of them is derivable and none is overwritten.
 * `captured-via` belongs here for a second reason: its whole meaning is that
 * the term is deliberately ABSENT, so deriving it would downgrade every
 * lawfully recaptured row and destroy K4.
 *
 * ONE EXCEPTION, and it is a coherence check rather than an override:
 * `negative` on a term that IS this run's own brand identity is not a
 * judgement the model is entitled to make — see the note above.
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

/**
 * Snapshot attribute keys that carry the SUBJECT PRODUCT'S OWN brand identity.
 *
 * Structural marketplace fields, not category vocabulary: the gate reads the
 * same two keys for brand leakage (C7) and the ship sheet renders them side by
 * side with the scraped values. Nothing here names a product category.
 */
const BRAND_IDENTITY_ATTRIBUTES = ['brand_name', 'manufacturer'] as const;

/**
 * The comparison key for identity matching: the SAME normalisation the rest of
 * the keyword code uses (`normalize` — entities, invisibles, accents, quote and
 * dash folding, whitespace collapse), then case-folded and stripped of
 * punctuation so `BrandX Labs, LLC.` and `brandx labs llc` are one string.
 */
const identityKey = (v: unknown): string =>
  normalize(str(v))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * THE SUBJECT PRODUCT'S OWN BRAND IDENTITY, resolved from the run rather than
 * from the model.
 *
 * FOUR SOURCES, each of which is the product's own name by definition:
 *   1-2. the ingested snapshot's `brand_name` and `manufacturer` — the live
 *        page's own brand fields;
 *   3.   the run's resolved canonical `productName` — the identifier C8/C15
 *        force to the head of the title and title75 and C7 holds to the
 *        snapshot's brand string, so it cannot quietly become a rival's name;
 *   4.   THE BRAND TOKEN IN THE TITLE — the leading words the scraped title and
 *        a declared brand string agree on, which is how a corporate suffix is
 *        handled ("Instant Immunity LLC" + title "Instant Immunity Support ..."
 *        yields "instant immunity"). It is bounded by BOTH strings and needs at
 *        least TWO words, so a single generic leading word can never become an
 *        exemption on its own.
 *
 * Returned as normalised keys, matched by EQUALITY only. A term that merely
 * contains, or is contained by, a brand string is not this product's identity
 * and is not exempted.
 */
export function ownBrandIdentity(
  listing: OptimizedListing,
  snapshot?: ListingSnapshot,
): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    const k = identityKey(v);
    if (k) out.add(k);
  };
  const attributes = snapshot?.attributes ?? {};
  for (const key of BRAND_IDENTITY_ATTRIBUTES) add(attributes[key]);
  add(listing?.productName);

  const titleWords = identityKey(snapshot?.title).split(' ').filter(Boolean);
  if (titleWords.length > 0) {
    for (const declared of [...out]) {
      const words = declared.split(' ').filter(Boolean);
      let k = 0;
      while (k < words.length && k < titleWords.length && words[k] === titleWords[k]) k++;
      // k === words.length is the declared string itself, already present.
      if (k >= 2 && k < words.length) out.add(words.slice(0, k).join(' '));
    }
  }
  return out;
}

export function deriveKeywordPlacement(
  rows: KeywordTerm[],
  listing: OptimizedListing,
  pack: KnowledgePack,
  /**
   * The INGESTED snapshot, the only non-model source of the product's own brand
   * identity. Optional so a caller holding a listing but no snapshot (a stored
   * run re-derived against fresh copy, a stateless audit) still works — and it
   * fails toward KEEPING the negative: with no snapshot the identity narrows to
   * the canonical product name, so fewer rows are exempted, never more.
   */
  snapshot?: ListingSnapshot,
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

  // Resolved ONCE per run, from the snapshot and the pinned canonical name.
  const identity = ownBrandIdentity(listing, snapshot);

  return rows.map((raw) => {
    const row = (raw ?? {}) as KeywordTerm;
    const term = str(row.term).trim();
    // A row with no term is malformed input; C28 reports it. Derivation leaves
    // it exactly as it arrived so the check sees the real thing.
    if (!term) return row;

    const status = str(row.status).trim() as KeywordStatus;
    // THE INCOHERENT CLASSIFICATION, rejected at the boundary. `negative` means
    // "appears nowhere" and exists to keep RIVAL brands out (R50); the subject
    // product's own brand is not a rival and MUST appear in its own brand
    // attributes, so the run could never converge on it. Equality against the
    // resolved identity only — a term that merely shares a word with the brand
    // is left exactly where the model put it.
    const selfBrand = status === 'negative' && identity.has(identityKey(term));

    if (!selfBrand && MODEL_OWNED_STATUSES.includes(status)) {
      // The model's judgement stands. It declares no surfaces any more, so the
      // list is emptied rather than carried: an intent row places nothing.
      return { ...row, surfaces: [] };
    }

    // Never a silent deletion: the correction is recorded on the row so the
    // audit and the ship sheet show what code changed, and why.
    const correction = selfBrand
      ? `Derived: '${term}' is this product's OWN brand identity (its brand, its manufacturer` +
        ` or its canonical product name), so it cannot be a rival-brand negative — a listing must` +
        ` carry its own brand. The row was reclassified from 'negative' and its placement read off` +
        ` the finished copy.`
      : '';

    const visibleHits = visible.filter((name) => carries(name, term));
    const backendHits = backend.filter((name) => carries(name, term));

    // The whole-bullets aggregate and a specific slot are the SAME fact stated
    // twice; when a slot matched, the aggregate is dropped so the placement map
    // an operator reads names the slot rather than both.
    const trimmed = visibleHits.some((n) => BULLET_SLOT_RE.test(n))
      ? visibleHits.filter((n) => n.toLowerCase() !== BULLET_AGGREGATE)
      : visibleHits;

    if (trimmed.length > 0) {
      return {
        ...row,
        status: 'placed' as KeywordStatus,
        surfaces: [...trimmed, ...backendHits],
        ...(correction ? { note: correction } : {}),
      };
    }
    if (backendHits.length > 0) {
      return {
        ...row,
        status: 'backend' as KeywordStatus,
        surfaces: [...backendHits],
        ...(correction ? { note: correction } : {}),
      };
    }
    return {
      ...row,
      status: 'candidate' as KeywordStatus,
      surfaces: [],
      note: correction
        ? `${correction} The finished copy carries it on no surface the pack knows, so the row is` +
          ` recorded as candidate.`
        : `Derived: the finished copy carries this term on no surface the pack knows, so the row` +
          ` was downgraded from '${status || '(none)'}' to candidate rather than left claiming a placement.`,
    };
  });
}
