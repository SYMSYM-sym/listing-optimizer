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
 *   MODEL  — the terms themselves (`term`, `tier`, `why`) and the TWO
 *            INTENT-BEARING statuses only it can judge:
 *              `negative`     — rival brands and banned vocabulary (R50),
 *              `captured-via` — banned demand reached through a compliant
 *                               route, named in `via` (K4).
 *            Neither is a claim about the copy; each is a judgement, and a
 *            judgement is exactly what a model is for. `candidate` and
 *            `not-targeted` sat in this list until E4 and never belonged
 *            there — see the third note below, which is the whole of why.
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
 * dropped and it is certainly not left saying `placed`. (A row that ALREADY
 * claims absence keeps its own word for it; see the third note.)
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
 * to sit inside it. NOTHING IS BELIEVED FROM THE MODEL UNCORROBORATED: sources
 * 1, 2 and 4 are the snapshot's own fields, and the one model-authored source
 * (`productName`) is admitted only when its leading words AGREE with the
 * scraped title or a declared snapshot brand — see `ownBrandIdentity`. An
 * earlier version of this note claimed the identity "comes from the snapshot"
 * while `productName` was in fact added unconditionally; setting `productName`
 * to a rival's brand exempted that rival's row, and the run only stayed
 * unverified because C7/C8/C15/A3/A4 co-fired on the same tampering. Every
 * genuine rival brand marked `negative` still fails from every surface, the
 * invisible ones included — `tests/keywordDerivation.ownBrand.test.ts` plants
 * one in each.
 *
 * THE FLOOR CANNOT BE GAMED. `minNegatives` is counted by C28 over the FINAL
 * artifact, so a reclassified row is no longer a negative when the floor is
 * measured: a run whose only negatives were self-references fails the floor
 * rather than satisfying it with its own name.
 */

/**
 * THE THIRD LIVE DEFECT — E2 DREW THE PARTITION IN THE WRONG PLACE, AND
 * `candidate` / `not-targeted` WERE ON THE WRONG SIDE OF IT.
 *
 * Production, ASIN B00IO89MYA, SEVENTY-SEVEN failures of one shape:
 *
 *   C28 | keywords[2] | candidate term "cat's claw" already appears on 'title'
 *   C28 | keywords[3] | candidate term 'quercetin' already appears on 'title'
 *       |             | /'bullet1'/'description'/'attributes'/'aplus'/'faq'/'qa'
 *   C28 | keywords[4] | candidate term 'vitamin c' already appears on … (x8)
 *
 * Those are the product's OWN INGREDIENT NAMES. They are in the title because
 * the title must name them; they are in the attributes because the attribute
 * template requires them; they are in the A+ and the FAQ because that is what
 * the copy is about. The model labelled them `candidate` — a status whose
 * whole meaning is "a term NOT currently in the copy, worth considering for a
 * later cycle" — while the copy it had just been shown was full of them.
 *
 * THIS IS THE IDENTICAL CLASS E2 FIXED, ONE STATUS-WORD FURTHER ALONG. E2's
 * argument was that a model must not be asked to assert A FACT ABOUT THE COPY
 * that code can compute exactly. Re-derive the partition from what each status
 * actually ASSERTS and two of the four E2 exempted turn out to be facts:
 *
 *   `negative`     — an INTENT: "exclude this rival brand". Model-owned.
 *                    Correctly exempt; C28 scans it for absence everywhere.
 *   `captured-via` — an INTENT: "reach this demand through another cluster
 *                    instead", with the route named in `via`. Model-owned.
 *                    Correctly exempt; C28 scans it for absence too, and
 *                    deriving it would downgrade every lawfully recaptured row
 *                    and destroy K4.
 *   `candidate`    — a CLAIM ABOUT THE COPY: "this term is not currently
 *                    used". Code can compute that exactly. DERIVED.
 *   `not-targeted` — also a CLAIM ABOUT THE COPY: "we are not going after this
 *                    term". If the term is all over the copy, it IS targeted,
 *                    whatever the row says. DERIVED.
 *
 * WHAT DERIVATION DOES TO THE TWO ABSENCE-CLAIM STATUSES, and what it
 * deliberately does NOT do. The term is looked for exactly as any other row's
 * term is:
 *   - on ≥1 VISIBLE surface  => `placed`, with the derived surface list;
 *   - only in the BACKEND    => `backend`;
 *   - NOWHERE                => THE MODEL'S OWN LABEL IS KEPT, surfaces empty.
 * That last leg is the point of the pair existing. "Held back for the next
 * copy cycle" and "deliberately left alone" are DIFFERENT strategy calls about
 * a term that is equally absent either way, and no amount of substring search
 * can tell them apart — so code decides the half it can measure (is the term
 * there?) and leaves the half it cannot (which kind of absence is meant) with
 * the only party that can judge it. Collapsing every absent row to `candidate`
 * would be the same error in the other direction: code overwriting a judgement
 * with a guess.
 *
 * NEVER SILENTLY. A label this module changes is recorded on `note`, exactly
 * as the own-brand reclassification is. A label it KEEPS is not annotated,
 * because nothing was changed.
 *
 * C28 IS NOT TOUCHED BY ANY OF THIS. Its `candidate` leg still fails a term
 * that is in the copy — which is precisely why a stored or hand-edited
 * artifact that never went through this derivation is still caught.
 */

/**
 * The statuses the MODEL owns. Each states an INTENT about a term rather than
 * a fact about the copy, so neither is derivable and neither is overwritten.
 * `captured-via` belongs here for a second reason: its whole meaning is that
 * the term is deliberately ABSENT, so deriving it would downgrade every
 * lawfully recaptured row and destroy K4.
 *
 * ONE EXCEPTION, and it is a coherence check rather than an override:
 * `negative` on a term that IS this run's own brand identity is not a
 * judgement the model is entitled to make — see the note above.
 *
 * THE ONE SOURCE OF TRUTH for the partition: this constant and
 * `ABSENCE_CLAIM_STATUSES` below are read by the derivation AND by the prompt
 * that tells the model which statuses are its own
 * (`lib/engine/prompts/shared.ts`), so the two can never drift apart.
 */
export const MODEL_OWNED_STATUSES: readonly KeywordStatus[] = ['negative', 'captured-via'];

/**
 * The statuses that make a CLAIM ABOUT THE COPY — "this term is absent from
 * it" — while still carrying a judgement code cannot make (WHICH KIND of
 * absence). Derived like any other row, with one difference: when the claim is
 * TRUE the model's own word for the absence is preserved rather than
 * normalised to `candidate`. See the note above for why both halves matter.
 */
export const ABSENCE_CLAIM_STATUSES: readonly KeywordStatus[] = ['candidate', 'not-targeted'];

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
export const identityKey = (v: unknown): string =>
  normalize(str(v))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const words = (key: string): string[] => key.split(' ').filter(Boolean);

/**
 * How many LEADING words two identity keys agree on.
 *
 * The one shared primitive behind both places identity is widened, so the two
 * can never drift into meaning different things by "agrees with".
 */
const agreeingPrefix = (a: string[], b: string[]): number => {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
};

/**
 * The minimum agreement that may widen the identity. TWO words, everywhere:
 * one leading word is generic often enough that agreeing on it says nothing,
 * and every widening here EXEMPTS a row from the negative scan.
 */
const MIN_AGREEING_WORDS = 2;

/**
 * THE SUBJECT PRODUCT'S OWN BRAND IDENTITY, resolved from the run rather than
 * from the model.
 *
 * FOUR SOURCES, each of which is the product's own name by definition:
 *   1-2. the ingested snapshot's `brand_name` and `manufacturer` — the live
 *        page's own brand fields;
 *   3.   the run's resolved canonical `productName`, ADMITTED ONLY WHEN IT
 *        AGREES WITH THE SNAPSHOT — see the next note, which is the whole of
 *        why this source is no longer taken on trust;
 *   4.   THE BRAND TOKEN IN THE TITLE — the leading words the scraped title and
 *        a declared brand string agree on, which is how a corporate suffix is
 *        handled ("Instant Immunity LLC" + title "Instant Immunity Support ..."
 *        yields "instant immunity"). It is bounded by BOTH strings and needs at
 *        least TWO words, so a single generic leading word can never become an
 *        exemption on its own.
 *
 * SOURCE 3 IS MODEL-AUTHORED, SO IT IS CORROBORATED BEFORE IT IS BELIEVED.
 * `productName` is written by the MODEL. The header of this module claimed the
 * identity "comes from the snapshot" and that claim was FALSE as written: a run
 * whose `productName` was set to a rival's brand exempted that rival's
 * `negative` row outright. (It was contained in practice — the same tampering
 * trips C7/C8/C15/A3/A4 and the run stayed unverified — but "another check
 * happens to co-fire" is exactly the crash-vs-detection confusion this project
 * refuses to rely on, and it is not a property of THIS function.) So
 * `productName` is admitted only when it AGREES with something the model did
 * not write: the scraped title, or a declared snapshot brand, over at least
 * MIN_AGREEING_WORDS leading words — the very rule source 4 already used, and
 * the reason a two-word bound is the right one is unchanged.
 *
 * WITH NO SNAPSHOT THE IDENTITY NARROWS TO NOTHING, and that is the correct
 * direction: there is then nothing to corroborate against, and this set only
 * ever REMOVES rows from the negative scan. Narrowing keeps the negative and
 * fails the run visibly; widening ships a rival brand. Never the second one.
 *
 * Returned as normalised keys, matched by EQUALITY only. A term that merely
 * contains, or is contained by, a brand string is not this product's identity
 * and is not exempted.
 */
export function ownBrandIdentity(
  /**
   * The listing, when there is one. A caller resolving the identity BEFORE
   * generation has none, and that is the narrow direction: the model-authored
   * `productName` source simply contributes nothing.
   */
  listing: OptimizedListing | undefined,
  snapshot?: ListingSnapshot,
): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    const k = identityKey(v);
    if (k) out.add(k);
  };
  // SOURCES 1-2 — the snapshot's own brand fields. Nothing the model wrote.
  const attributes = snapshot?.attributes ?? {};
  for (const key of BRAND_IDENTITY_ATTRIBUTES) add(attributes[key]);

  const titleWords = words(identityKey(snapshot?.title));
  // Snapshot-declared brands ONLY — the corroboration set for source 3 must not
  // include anything source 3 itself put there.
  const declaredKeys = [...out];

  // SOURCE 3 — the model-authored canonical name, CORROBORATED. It is admitted
  // only when its leading words agree with the scraped title or with a declared
  // snapshot brand. No snapshot => nothing agrees => it is not admitted, and the
  // identity narrows to empty rather than to whatever the model chose to write.
  const nameWords = words(identityKey(listing?.productName));
  if (
    nameWords.length > 0 &&
    (agreeingPrefix(nameWords, titleWords) >= MIN_AGREEING_WORDS ||
      declaredKeys.some((d) => agreeingPrefix(nameWords, words(d)) >= MIN_AGREEING_WORDS))
  ) {
    out.add(nameWords.join(' '));
  }

  // SOURCE 4 — the brand token the title and an already-admitted identity agree
  // on, which is how a corporate suffix is handled.
  if (titleWords.length > 0) {
    for (const declared of [...out]) {
      const declaredWords = words(declared);
      const k = agreeingPrefix(declaredWords, titleWords);
      // k === declaredWords.length is the declared string itself, already present.
      if (k >= MIN_AGREEING_WORDS && k < declaredWords.length) {
        out.add(declaredWords.slice(0, k).join(' '));
      }
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
   * fails toward KEEPING the negative: with no snapshot there is nothing to
   * corroborate the model-authored `productName` against, so the identity is
   * EMPTY and no row is exempted at all.
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

    // An ABSENCE-CLAIM row (`candidate` / `not-targeted`) is derived like any
    // other — the claim it makes is about the copy, and the copy is right
    // here. Its label survives ONLY the leg where the claim turns out true.
    const absenceClaim = ABSENCE_CLAIM_STATUSES.includes(status);

    // Never a silent deletion: the correction is recorded on the row so the
    // audit and the ship sheet show what code changed, and why.
    const correction = selfBrand
      ? `Derived: '${term}' is this product's OWN brand identity (its brand, its manufacturer` +
        ` or its canonical product name), so it cannot be a rival-brand negative — a listing must` +
        ` carry its own brand. The row was reclassified from 'negative' and its placement read off` +
        ` the finished copy.`
      : absenceClaim
        ? `Derived: the row said '${status}', which states this term is NOT in the copy — but the` +
          ` finished copy carries it. The status and the surfaces were read off the copy instead,` +
          ` because where a term sits is a fact code measures rather than a judgement.`
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
    // THE TERM IS GENUINELY ABSENT. An absence-claim row was RIGHT, so nothing
    // is changed and nothing is annotated: `candidate` and `not-targeted` are
    // two different strategy calls about an equally absent term, and which one
    // is meant is precisely the half of this that code cannot measure.
    if (absenceClaim) return { ...row, surfaces: [] };

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
