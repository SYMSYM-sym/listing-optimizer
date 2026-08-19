/**
 * ===========================================================================
 * K1 — THE DESCRIPTION CLAMP: the description is the LAST capped surface that
 *      relies on the model's own counting, and it stops relying on it here.
 * ===========================================================================
 *
 * THREE OVERSHOOTS, TWO FIX ATTEMPTS, AND A PATTERN THAT DOES NOT END.
 *
 *   pre-margin    stated 1842 (the cliff)    model wrote 1930   +88    C4 FAILED
 *   pre-margin    stated 1842 (the cliff)    model wrote 1861   +19    C4 FAILED
 *   post-margin   stated 1731, margin 111    model wrote 1851   +120   C4 FAILED
 *
 * The margin (`DESCRIPTION_MARGIN_FRACTION`, 6% of the writable budget) was
 * sized against the first two observations. The next observation beat it. That
 * is not an argument that 6% was chosen carelessly — it is the argument that
 * ANY percentage fitted to past overshoots is a prediction about a tail nobody
 * has seen. A fourth overshoot larger than whatever margin is chosen next is
 * not unlikely; on this evidence it is the expected outcome, and each one costs
 * a whole run.
 *
 * WHY THE DESCRIPTION IS THE ONLY SURFACE STILL DOING THIS. The H1 round asked
 * the same question of every other capped surface and wrote the answer down as
 * executable evidence (`tests/c4.descriptionBudget.test.ts`, "H1 — the other
 * capped surfaces"):
 *
 *   bullets (C2)   `sanitizeBullets` truncates each bullet to `bulletMax`
 *                  (less one for the claim marker) at a word boundary, BEFORE
 *                  the gate ever sees the listing.
 *   backend (C3)   `sanitizeBackendSearchTerms` truncates at a word boundary to
 *                  `backendMaxBytes`, likewise before the gate.
 *
 * An overshoot on either of those cannot reach its check from a generated run
 * at all. The description is the only capped surface with no clamp, and it is
 * the only capped surface that keeps failing. The margin is the difference: it
 * ASKS the model to leave room, where a clamp does not ask.
 *
 * ---------------------------------------------------------------------------
 * IS THIS "MUTATING CONTENT TO FORCE A GATE PASS"? NO — AND THE DISTINCTION IS
 * STRUCTURAL, NOT A TECHNICALITY.
 *
 * The prohibition exists to stop one specific move: seeing a gate failure and
 * editing the copy until the failure goes away, which turns the gate into a
 * report on the editor rather than on the listing. Four properties separate
 * this clamp from that move:
 *
 *   1. IT IS UNCONDITIONAL, NOT GATE-DRIVEN. It runs in the same deterministic
 *      assembly step on EVERY run, beside `sanitizeBullets` and
 *      `sanitizeBackendSearchTerms`. It never reads a `Failure`, a `GateResult`
 *      or a repair context — none of those are in scope where it is called. A
 *      run that would have passed and a run that would have failed are treated
 *      identically.
 *   2. IT ACTS ON WHAT THE ENGINE ALREADY OWNS. `optimize()` assembles the
 *      description: it appends the compliance disclaimer the model is forbidden
 *      to write. The string C4 measures was never the model's text alone, and
 *      its length was never a quantity the model controlled. Fixing that length
 *      in the step that creates it is the honest place for it.
 *   3. THE CHECKER IS UNCHANGED AND STILL INDEPENDENT. C4's trigger does not
 *      move by one character: empty, or assembled length over
 *      `rules.descriptionMax`. The whole gate re-validates the clamped listing
 *      from scratch afterwards, and if the clamp broke something the gate says
 *      so and the run is unverified. The clamp can only make copy SHORTER, and
 *      shortening cannot manufacture a substantiated claim, a present
 *      disclaimer or a missing declaration out of nothing.
 *   4. IT FAILS CLOSED WHERE IT CANNOT ACT CLEANLY. With no paragraph, sentence
 *      or word boundary to cut at, it changes nothing and C4 fails honestly. It
 *      is never allowed to invent a boundary in order to pass.
 *
 * The precedent was accepted for the two surfaces that already clamp, under
 * this codebase's own heading ("generation policy, not gate laundering").
 * Declining to apply it to the third — the one that actually keeps failing —
 * would be a distinction between surfaces, not a principle.
 *
 * VERDICT: not a violation. It is applied.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLAMP MAY AND MAY NOT DO.
 *
 *   - It cuts the MODEL'S OWN TEXT ONLY, before the disclaimer is appended
 *     (`lib/engine/optimize.ts`). The disclaimer is therefore never truncated,
 *     never partially removed and never re-ordered: it is added to an
 *     already-clamped body.
 *   - It NEVER cuts mid-word. It prefers a paragraph break, then a sentence
 *     end, and falls back to a word boundary — the same last resort
 *     `sanitizeBullets` uses. If none of the three exists inside the budget it
 *     does nothing at all rather than cut a word in half.
 *   - It never cuts so deep that the description stops being one: a boundary
 *     shallower than `KEEP_FLOOR_FRACTION` of the budget is not used, and if
 *     that leaves nothing usable the text is returned unchanged — C4 then
 *     fails, the repair loop gets its round, and nothing has been gutted
 *     silently.
 *   - It is IDEMPOTENT: clamped output is inside the budget, so a repair round
 *     carrying the previous body forward clamps it to itself.
 *   - A description already inside the budget is returned BYTE-IDENTICAL — the
 *     same string, not a trimmed or re-spaced copy of it.
 *
 * VISIBILITY. A clamp is never silent: `optimize()` logs it, records
 * `descriptionClamped` on the listing (ABSENT when nothing was cut, so an
 * ordinary run is byte-for-byte the object it was) and the Ship Sheet prints a
 * note beside the description saying how much the model wrote and how much
 * shipped.
 *
 * THIS MODULE HOLDS NO DOMAIN LITERAL. It is a string function over a number.
 */

/** What `clampDescription` did, for the caller to log, record and render. */
export interface DescriptionClampResult {
  /** The body to ship. Identical to the input when nothing was cut. */
  text: string;
  /** True only when `text` differs from the input. */
  clamped: boolean;
  /** Length of the text the model wrote. */
  writtenChars: number;
  /** Length of the text that survives (=== `writtenChars` when not clamped). */
  keptChars: number;
}

/**
 * The shallowest cut point that is still a description.
 *
 * A boundary further back than this throws away more than a third of the
 * writable budget, which trades a length failure for a thin-content one — the
 * same defect facing the other way. Below it the clamp declines to act.
 */
export const KEEP_FLOOR_FRACTION = 0.6;

/**
 * A sentence end: terminal punctuation, any closing quote or bracket that
 * belongs to it, followed by whitespace or the end of the window. Deliberately
 * dumb — it carries no abbreviation list and needs none, because a cut after
 * "e.g." is still a cut between words, never inside one.
 */
const SENTENCE_END = /[.!?]+["'”’)\]]*(?=\s|$)/g;

/** Trailing connectives left dangling by a cut — never a full stop. */
const DANGLING_TAIL = /[,;:–—-]+$/;

/**
 * Clamp `raw` to at most `budget` characters at a paragraph, sentence or word
 * boundary. Returns the input unchanged when it already fits, when `budget` is
 * not a usable positive number, or when no clean boundary exists.
 */
export function clampDescription(raw: unknown, budget: number): DescriptionClampResult {
  const text = typeof raw === 'string' ? raw : '';
  const unchanged: DescriptionClampResult = {
    text,
    clamped: false,
    writtenChars: text.length,
    keptChars: text.length,
  };
  if (!Number.isFinite(budget) || budget <= 0) return unchanged;
  if (text.length <= budget) return unchanged;

  const window = text.slice(0, budget);
  const floor = Math.floor(budget * KEEP_FLOOR_FRACTION);

  // A paragraph break: cut BEFORE it, so the surviving text ends on a whole
  // paragraph and the blank-line structure the prompt asks for stays intact.
  const paragraph = window.lastIndexOf('\n\n');

  // The last sentence end inside the window: cut AFTER its punctuation.
  let sentence = -1;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(window); m !== null; m = SENTENCE_END.exec(window)) {
    sentence = m.index + m[0].length;
    // The class is one-or-more so a zero-width match is impossible, but a
    // stalled `lastIndex` would loop forever; step it defensively.
    if (SENTENCE_END.lastIndex <= m.index) SENTENCE_END.lastIndex = m.index + 1;
  }

  // The LATEST structural boundary wins, not paragraphs-first: a sentence end
  // at 1840 keeps more of the writer's work than a paragraph break at 1200,
  // and both are clean.
  const structural = Math.max(paragraph, sentence);
  let end = structural >= floor ? structural : -1;
  if (end < 0) {
    const word = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
    if (word >= floor) end = word;
  }
  // No paragraph, no sentence, no word: there is no honest cut here. Leave the
  // text alone and let C4 report the overshoot.
  if (end < 0) return unchanged;

  const kept = text.slice(0, end).trimEnd().replace(DANGLING_TAIL, '').trimEnd();
  if (!kept || kept === text) return unchanged;
  return { text: kept, clamped: true, writtenChars: text.length, keptChars: kept.length };
}
