import { identityKey, ownBrandIdentity } from '@/lib/engine/keywordPlacement';
import { normalize } from '@/lib/gate/util';
import type { CompetitorIngestion, ListingSnapshot, OptimizedListing } from '@/lib/types';

/**
 * WS9 → R50 — THE COMPETITORS THE OPERATOR SUPPLIED BECOME AN AUTOMATIC
 * RIVAL-BRAND NEGATIVE SET FOR THE RUN.
 *
 * THE HOLE THIS CLOSES. C28 enforces "a `negative` term appears nowhere", and
 * that is the whole of the app's R50 (rival-brand exclusion) enforcement. Every
 * word of it is conditioned on the MODEL having written `negative` in the row.
 * The four-test screen that would otherwise catch a mislabelled row reads the
 * compliance pack's disease nouns, action-paired nouns and superlative bans —
 * and a rival BRAND NAME is in none of those lexicons, because a brand name is
 * not a lexicon item, it is a fact about the market. So a rival brand the model
 * labelled `placed` sailed straight through: C28 guaranteed LABELLED-NEGATIVE
 * absence, never RIVAL absence.
 *
 * THE SIGNAL THAT DOES NOT ASK THE MODEL ANYTHING. The operator typed the
 * competitor ASINs. WS9 already INGESTS them (`audit.benchmark` measures their
 * snapshots), and each snapshot carries the rival's brand in the same two
 * marketplace fields the subject's own identity is read from. That is a fact
 * code can compute exactly, from an input the operator supplied — the same
 * argument that moved the placement map and the own-brand coherence check into
 * code.
 *
 * FOUR BOUNDS, and each one exists to stop this from over-blocking. Over-
 * blocking lawful copy is treated in this project as exactly as severe as a
 * bypass, and an automatic negative that fires on ordinary prose would be
 * exactly that:
 *
 *   1. NEVER FIRES WHEN NO COMPETITORS WERE SUPPLIED. No competitor list, an
 *      empty one, or one whose every entry failed to ingest => the empty set,
 *      and C28 behaves byte-for-byte as it did before this existed.
 *   2. STRUCTURAL BRAND FIELDS ONLY (`brand_name`, `manufacturer`) — the same
 *      two keys `ownBrandIdentity` reads and C7 enforces. The rival's TITLE is
 *      deliberately not mined: guessing where a brand ends inside a title is
 *      the unreliable step, and a wrong guess here blocks lawful copy.
 *   3. THE SUBJECT'S OWN IDENTITY IS SUBTRACTED, by the same normalised
 *      EQUALITY `ownBrandIdentity` matches on. An operator who pastes their own
 *      ASIN into the competitor box (or a rival who genuinely shares the
 *      subject's brand string) must not turn the listing's own brand into a
 *      term it may not carry — a listing MUST carry its own brand, so that
 *      would be an unwinnable run, which is the precise defect the own-brand
 *      reclassification was written to end.
 *   4. A SINGLE-WORD BRAND IS NEVER ADMITTED. This is the same ">= 2 agreeing
 *      words" bound `ownBrandIdentity` uses on the title token, applied in the
 *      same conservative direction. Brands that ARE one ordinary word exist,
 *      and a one-word automatic negative would fire on ordinary prose and fail
 *      lawful copy that never mentioned anybody. The cost is recorded as a
 *      known limitation in `CONFORMANCE-DEVIATIONS.md` rather than traded away
 *      silently.
 *
 * WHAT IT IS NOT. It is not a lexicon and it holds no literal: every string
 * comes from a page the operator asked for, at run time. It does not touch the
 * keyword artifact, so `minNegatives` still counts only the rows the reference
 * itself records and supplying competitors can never satisfy the floor.
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** The same two structural keys the own-brand identity is read from. */
const BRAND_FIELDS = ['brand_name', 'manufacturer'] as const;

/** The `ownBrandIdentity` title-token bound, reused: one word is never enough. */
const MIN_BRAND_WORDS = 2;

/**
 * Resolve the automatic rival-brand negative set for a run.
 *
 * Returns SCAN-READY strings (normalised the way every keyword surface is
 * normalised) so C28 can match them with the very `termRegex` it uses for a
 * model-declared `negative` row. Returns `[]` — never `undefined` — so a caller
 * that spreads it into a context is always spreading the same shape.
 */
export function rivalBrandNames(
  competitors: CompetitorIngestion[] | undefined,
  /** The listing, when the caller has one (the repair loop runs before it exists). */
  listing: OptimizedListing | undefined,
  snapshot?: ListingSnapshot,
): string[] {
  // BOUND 1 — no competitors, no leg.
  if (!Array.isArray(competitors) || competitors.length === 0) return [];

  // BOUND 3 — the subject's own identity, resolved exactly as the derivation
  // boundary resolves it, so the two can never disagree about what "our own
  // brand" means.
  const own = ownBrandIdentity(listing, snapshot);

  const byKey = new Map<string, string>();
  for (const c of competitors) {
    const attributes = c?.snapshot?.attributes ?? {};
    // BOUND 2 — structural brand fields only.
    for (const field of BRAND_FIELDS) {
      const raw = str(attributes[field]).trim();
      if (!raw) continue;
      const key = identityKey(raw);
      if (!key) continue;
      // BOUND 4 — a single-word brand is never admitted.
      if (key.split(' ').filter(Boolean).length < MIN_BRAND_WORDS) continue;
      // BOUND 3, applied.
      if (own.has(key)) continue;
      const scan = normalize(raw).trim();
      if (!scan) continue;
      if (!byKey.has(key)) byKey.set(key, scan);
    }
  }
  return [...byKey.values()];
}
