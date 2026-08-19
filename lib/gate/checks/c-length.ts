import type {
  Failure,
  KnowledgePack,
  OptimizedListing,
  TitleWordRepetitionRules,
} from '@/lib/types';
import { arr, normalize, tokenSet, utf8Bytes } from '../util';
import { fail } from './shared';

/**
 * Stemmed lowercase content tokens of a title, minus the pack's stopwords.
 * Exported for the repetition test; holds no lexicon of its own.
 */
export function titleContentTokens(title: string, stopwords: string[]): string[] {
  const stop = new Set(stopwords.map((w) => w.toLowerCase()));
  return normalize(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w.length > 1 && !stop.has(w))
    .map((w) => w.replace(/'s$/, '').replace(/s$/, ''))
    .filter(Boolean);
}

/**
 * THE REPETITION COUNT C1 MEASURES, with the pack's COMPOUND-TAIL exemption.
 *
 * ---------------------------------------------------------------------------
 * THE LIVE OVER-BLOCK (ASIN B00EEEITVA, one failure, loop never converged):
 *
 *   C1 | title | 'free' x3
 *       FIX: No word may appear more than 2x in the title — replace the
 *            repeats of 'free' with distinct keywords
 *
 * The copy was LAWFUL. `titleContentTokens` keeps a hyphen INSIDE a token
 * (`[^a-z0-9\s'-]` -> space, split on whitespace), so two spellings of one
 * diet-claim list get opposite verdicts:
 *
 *   `Gluten Free, Dairy Free, Soy Free`  -> gluten|free|dairy|free|soy|free
 *                                          -> 'free' x3 -> C1 FAILS
 *   `Gluten-Free, Dairy-Free, Soy-Free`  -> gluten-free|dairy-free|soy-free
 *                                          -> PASSES
 *
 * Same meaning, same three claims, same customer — and the verdict turned on a
 * hyphen the marketplace does not care about. The stated fix is unactionable on
 * that shape (there is no synonym for the tail of each claim), which is why the
 * repair loop spent every round and the run shipped `verified:false`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A CAP RAISE. `max: 3` would license a THIRD occurrence of
 * EVERY word in the title, and three is exactly the canonical keyword-stuffing
 * shape this sub-rule exists to catch. (That is what separates this from the
 * R4/C31 precedent, where the number itself was measured to be wrong.) So the
 * cap does not move and the TRIGGER does not move: what changes is that a
 * qualifier tail attached to a DISTINCT head is counted as part of that
 * compound rather than as a bare repeat.
 *
 * THE EXEMPTION IS NARROW, and every one of these still counts:
 *   1. the HEAD word itself — `Gluten Free Gluten Free Gluten Free` fails on
 *      'gluten', because only the tail is ever exempt;
 *   2. a repeat of an ALREADY-WRITTEN compound — the second `Gluten Free` is a
 *      genuine repeat, so its tail is counted;
 *   3. a BARE tail with no head in front of it (`Free Free Free`);
 *   4. a tail whose head is ITSELF a tail (`... Free Free`), which is stuffing
 *      wearing a compound's clothes.
 *
 * `compoundTails` is PACK DATA and is a pure WIDENER: empty it and this
 * function counts exactly what it counted before the exemption existed.
 */
export function titleRepetitionCounts(
  title: string,
  repetition: TitleWordRepetitionRules,
): Map<string, number> {
  const tokens = titleContentTokens(title, repetition.stopwords ?? []);
  const tails = new Set(
    (repetition.compoundTails ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  const counts = new Map<string, number>();
  const writtenCompounds = new Set<string>();
  const bump = (token: string): void => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  };
  tokens.forEach((token, i) => {
    if (!tails.has(token)) {
      bump(token);
      return;
    }
    const head = i > 0 ? tokens[i - 1] : undefined;
    // (3) no head at all, and (4) a head that is itself a tail: not a compound.
    if (head === undefined || tails.has(head)) {
      bump(token);
      return;
    }
    const compound = `${head} ${token}`;
    // (2) the same compound a second time is a repeat, not a new claim.
    if (writtenCompounds.has(compound)) {
      bump(token);
      return;
    }
    writtenCompounds.add(compound);
    // The tail is exempt; the HEAD was counted on its own iteration (1).
  });
  return counts;
}

/**
 * C1 — title length PLUS the pack's title word-repetition rule.
 *
 * `rules.titleWordRepetition` documents "no word appears more than 2x in the
 * title" but nothing enforced it, so a keyword-stuffed title passed the gate.
 * Limit, stopwords and compound tails are PACK DATA.
 */
export function c1TitleLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  if (!normalize(l.title ?? '')) {
    out.push(fail('C1', 'title', '(empty)', 'Title is empty — a blank surface can never be verified'));
  }
  if ((l.title ?? '').length > pack.rules.titleMaxLegacy) {
    out.push(fail('C1', 'title', `${(l.title ?? '').length} chars`, `Shorten title to ≤${pack.rules.titleMaxLegacy} chars`));
  }
  const repetition = pack.rules.titleWordRepetition;
  if (repetition && repetition.max > 0) {
    const counts = titleRepetitionCounts(l.title, repetition);
    const over = [...counts.entries()].filter(([, n]) => n > repetition.max);
    for (const [word, n] of over) {
      out.push(
        fail(
          'C1',
          'title',
          `'${word}' x${n}`,
          `No word may appear more than ${repetition.max}x in the title — replace the repeats of '${word}' with distinct keywords`,
        ),
      );
    }
  }
  return out;
}

/**
 * C2 — bullet count, length AND structural validity.
 *
 * STRUCTURE is checked because the count/length rules alone accepted a
 * "5 bullets" listing that was really 2: an empty string, a whitespace-only
 * string, a bullet consisting only of the claim marker, a `null`, and a
 * duplicate of another bullet all counted as content. Each of those ships an
 * empty or repeated bullet slot to the customer, so each is a failure now.
 * The comparison for duplicates is done on NORMALIZED, case-folded text, so
 * re-casing or re-spacing a bullet does not launder the repeat.
 */
export function c2Bullets(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  // Array.isArray, not `?? []`: a `bullets` field the model emitted as a
  // string or an object must FAIL, never throw (a thrown gate is a fail-OPEN).
  const bullets = arr<unknown>(l.bullets);
  if (!Array.isArray(l.bullets)) {
    out.push(fail('C2', 'bullets', '(not a list)', 'The bullet block is not a list of strings — the contract requires exactly five'));
  }
  if (bullets.length !== pack.rules.bulletCount) {
    out.push(fail('C2', 'bullets', `${bullets.length} bullets`, `Exactly ${pack.rules.bulletCount} bullets required`));
  }
  const seen = new Map<string, number>();
  bullets.forEach((raw, i) => {
    const b = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
    if (b.length > pack.rules.bulletMax) {
      out.push(fail('C2', `bullets[${i}]`, `${b.length} chars`, `Shorten bullet to ≤${pack.rules.bulletMax} chars`));
    }
    const text = normalize(b);
    if (!text) {
      out.push(fail('C2', `bullets[${i}]`, '(empty)', 'Bullet is empty or whitespace-only — write real copy or remove the slot'));
      return;
    }
    // A LETTER is required, not merely an alphanumeric: `"*"`, `"---"` and a
    // bare `42` are all empty bullet slots as far as a customer is concerned.
    if (!/[a-z]/i.test(text)) {
      out.push(
        fail(
          'C2',
          `bullets[${i}]`,
          text.slice(0, 40),
          'Bullet has no words (markers, punctuation or digits only) — write real copy or remove the slot',
        ),
      );
      return;
    }
    const key = text.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      out.push(
        fail(
          'C2',
          `bullets[${i}]`,
          text.slice(0, 60),
          `Bullet duplicates bullets[${first}] — every bullet must cover a distinct use case`,
        ),
      );
      return;
    }
    seen.set(key, i);
  });
  return out;
}

export function c3BackendBytes(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const terms = l.backendSearchTerms ?? '';
  // An EMPTY backend field is not "compliant", it is an unfilled deliverable —
  // it used to pass silently because only the upper byte bound was checked.
  if (!normalize(terms)) {
    out.push(fail('C3', 'backendSearchTerms', '(empty)', 'Backend search terms are empty — fill the field with synonyms/misspellings/other-language variants'));
    return out;
  }
  const bytes = utf8Bytes(terms);
  if (bytes > pack.rules.backendMaxBytes) {
    out.push(fail('C3', 'backendSearchTerms', `${bytes} UTF-8 bytes`, `Reduce to ≤${pack.rules.backendMaxBytes} bytes — exceeding de-indexes the whole field`));
  }
  return out;
}

/**
 * The separator `lib/engine/optimize.ts` puts between the written description
 * and the code-inserted disclaimer.
 *
 * It lives HERE, next to the check that measures the assembled string, and the
 * engine imports it — the same direction `lib/engine/repair.ts` already imports
 * `runGate`. Two homes for this fact is precisely the drift that produced the
 * defect below: the engine knew what it appended and the gate knew what it
 * measured, and nothing made the two arithmetics agree.
 */
export const DISCLAIMER_APPEND_SEPARATOR = '\n\n';

export interface DescriptionBudget {
  /** `rules.descriptionMax` — the cap C4 enforces on the ASSEMBLED field. */
  max: number;
  /** Characters the engine appends afterwards (0 when the pack has no disclaimer). */
  reserve: number;
  /**
   * The HARD ceiling on the model's own text: `max - reserve`. Never below
   * zero. One character past this and the assembled field is over `max`, so it
   * is a CLIFF rather than a target — nothing is told to aim at it any more.
   */
  budget: number;
  /** `budget - target` — the safety margin, DERIVED here and nowhere else. */
  margin: number;
  /**
   * THE NUMBER EVERY PROMPT AND EVERY FIX LINE STATES: `budget - margin`.
   * See `DESCRIPTION_MARGIN_FRACTION` for why a stated target below the cliff
   * is the difference between a run that converges and one that does not.
   */
  target: number;
}

/**
 * THE SAFETY MARGIN, and why it is a fraction rather than a fixed count.
 *
 * THE LIVE DEFECT (ASIN B00IO89MYA):
 *
 *   C4 | description | 2019 chars (1861 written + 158 appended)
 *
 * Every number in the system was already correct. `descriptionBudget` derived
 * `max 2000`, `reserve 158`, `budget 1842`; the generation prompt and the C4
 * repair line both stated 1842, from that one arithmetic (Q3). The model wrote
 * 1861 — NINETEEN characters past a correctly-stated ceiling — and the
 * disclaimer then carried the assembled field 19 characters past the hard cap.
 * Nothing was miscomputed and nothing was mis-stated. The run failed because
 * the number it was told to hit was the exact number at which failure begins,
 * and a model asked for "≤1842 characters" lands near 1842 — sometimes on the
 * wrong side of it. Nineteen characters, after the loop has spent its rounds,
 * on copy that is otherwise fine.
 *
 * SO THE STATED TARGET MOVES DOWN AND THE CAP DOES NOT MOVE AT ALL. C4's
 * trigger is untouched — empty, or assembled length over `rules.descriptionMax`
 * — and `budget` still names the exact cliff. What changed is that no prompt
 * and no fix line names the cliff: they name `target`, a derived margin below
 * it, so an ordinary small overshoot of the STATED number still lands inside
 * the ENFORCED one.
 *
 * WHY A FRACTION, AND WHY 6%, SIZED AGAINST BOTH OBSERVED OVERSHOOTS. There are
 * two of them in the record, not one:
 *
 *   88 chars over a stated 1842  (4.78%) — CONFORMANCE-DEVIATIONS.md §13.2,
 *                                          assessed at the time as "a model
 *                                          overshoot, no change";
 *   19 chars over a stated 1842  (1.03%) — the run above.
 *
 * A margin sized to the SECOND alone would have left the FIRST failing, and
 * §13.2's own numbers say so — which is why that assessment is superseded here
 * rather than quietly repeated. 6% of the writable budget is 111 characters on
 * the supplements pack (1842 -> 1731): 1.26x the worst overshoot observed and
 * 5.8x the most recent one.
 *
 * A FRACTION RATHER THAN A COUNT because a fixed character count would be a
 * fourth hand-copied constant of exactly the kind this module exists to abolish,
 * and it would scale wrongly against any other `descriptionMax`.
 *
 * WHY NOT MORE. The margin is paid for in description length on EVERY run, and
 * the description is a real deliverable: it still has to cover what the product
 * is, who it is for, how to use it, and quality and safety (see
 * `descriptionPrompt`). At 6% the target keeps 94% of the writable budget and
 * 87% of the hard cap — 1731 characters is still a full-length description.
 * Trading a length failure for a thin-content one would be the same defect
 * facing the other way. And the margin does not have to cover the tail on its
 * own any more: an overshoot that DOES clear it now produces a repair line
 * stating `target` — a number below the cliff — so the next round has room too,
 * which is precisely what the pre-Q3 repair line did not have.
 *
 * APPLIED UNIFORMLY, INCLUDING WHEN `reserve` IS 0. Landing on a stated ceiling
 * is a property of stating a ceiling to a model, not a property of the
 * disclaimer: a pack with no compliance module has `budget === max` and the
 * same failure mode one character past it.
 */
export const DESCRIPTION_MARGIN_FRACTION = 0.06;

/**
 * THE ONE ARITHMETIC — the budget the generator actually controls.
 *
 * WHY THIS EXISTS (a live convergence failure, ASIN B00EEEITVA, one of six runs
 * in a batch; the other five and the same ASIN's other run verified clean).
 * That run ended `verified:false` on a SINGLE C4 failure, and the loop could not
 * have converged on it however many rounds it was given, because the three
 * places that stated the constraint stated three different things and the most
 * actionable of them was the wrong one:
 *
 *   - the SYSTEM prompt said "Description <=2000 chars (leave ~250 chars
 *     headroom)"  => 1750;
 *   - the DESCRIPTION group prompt said "<=1700 chars", a hand-computed
 *     constant that named neither `rules.descriptionMax` nor the disclaimer;
 *   - the repair round then fed the C4 failure back verbatim, and C4's own fix
 *     line said "Shorten description to <=2000 chars" while its context reported
 *     the length of the ASSEMBLED field — description PLUS the appended
 *     disclaimer. A model that does exactly what that line says targets 2000
 *     characters of its own text, the engine appends ~158 more, and the next
 *     gate run reports the same failure with a slightly different number. The
 *     instruction was self-defeating: obeying it reproduced the defect.
 *
 * C4 IS NOT WEAKENED BY ANY OF THIS. The verdict is unchanged in both
 * directions — the check still fails exactly when the ASSEMBLED description is
 * empty or longer than `rules.descriptionMax`, and `budget` is used only to say
 * something the model can act on. What changed is that the prompts and the fix
 * line now compute their number from `rules.descriptionMax` and the pack's own
 * disclaimer instead of carrying hand-copied constants.
 */
export function descriptionBudget(pack: KnowledgePack): DescriptionBudget {
  const max = pack.rules.descriptionMax;
  const disclaimer = pack.compliancePack?.disclaimer ?? '';
  const reserve = disclaimer ? DISCLAIMER_APPEND_SEPARATOR.length + disclaimer.length : 0;
  const budget = Math.max(0, max - reserve);
  // The margin is DERIVED here, in the one place, exactly as `budget` is — the
  // whole point of this function is that no prompt and no fix line ever carries
  // a number of its own.
  const margin = Math.ceil(budget * DESCRIPTION_MARGIN_FRACTION);
  return { max, reserve, budget, margin, target: Math.max(0, budget - margin) };
}

export function c4DescriptionLength(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const description = l.description ?? '';
  const out: Failure[] = [];
  if (!normalize(description)) {
    out.push(fail('C4', 'description', '(empty)', 'Description is empty — a blank surface can never be verified'));
  }
  const { max, reserve, target } = descriptionBudget(pack);
  if (description.length > max) {
    // The context names BOTH halves when the disclaimer is really on the end,
    // so the number the model is shown is one it can reconcile with the text it
    // wrote. The trigger above is untouched.
    const disclaimer = pack.compliancePack?.disclaimer ?? '';
    const appended = reserve > 0 && description.includes(disclaimer);
    const context = appended
      ? `${description.length} chars (${description.length - reserve} written + ${reserve} appended)`
      : `${description.length} chars`;
    out.push(
      fail(
        'C4',
        'description',
        context,
        appended
          ? `Shorten the description you WRITE to ≤${target} chars — the ${reserve}-char compliance disclaimer is appended afterwards by the system and counts toward the ≤${max} limit, so a rewrite aimed at ${max} fails again, and ${target} leaves room for the ordinary overshoot that produced this failure`
          : `Shorten description to ≤${target} chars — the hard limit is ${max}, and ${target} leaves room for the ordinary overshoot that produced this failure`,
      ),
    );
  }
  return out;
}

export function c15NewTitlePolicy(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const title75 = l.title75 ?? '';
  const itemHighlights = l.itemHighlights ?? '';
  if (!normalize(title75)) {
    out.push(fail('C15', 'title75', '(empty)', 'title75 is empty — a blank surface can never be verified'));
  }
  if (title75.length > pack.rules.title75Max) {
    out.push(fail('C15', 'title75', `${title75.length} chars`, `title75 must be ≤${pack.rules.title75Max} chars`));
  }
  if (!normalize(title75).startsWith(normalize(l.productName ?? ''))) {
    out.push(fail('C15', 'title75', title75.slice(0, 60), 'title75 must start with the product name'));
  }
  if (!normalize(itemHighlights)) {
    out.push(fail('C15', 'itemHighlights', '(empty)', 'itemHighlights is empty — a blank surface can never be verified'));
  }
  if (itemHighlights.length > pack.rules.itemHighlightsMax) {
    out.push(fail('C15', 'itemHighlights', `${itemHighlights.length} chars`, `itemHighlights must be ≤${pack.rules.itemHighlightsMax} chars`));
  }
  return out;
}

/** C16 (quality, deterministic): backend terms must not repeat title-surface words. */
export function c16BackendDedup(l: OptimizedListing): Failure[] {
  const titleTokens = tokenSet(`${l.title ?? ''} ${l.title75 ?? ''} ${l.itemHighlights ?? ''}`);
  const backendTokens = tokenSet(l.backendSearchTerms ?? '');
  const overlap = [...backendTokens].filter((t) => titleTokens.has(t));
  return overlap.length === 0
    ? []
    : [fail('C16', 'backendSearchTerms', overlap.join(', '), 'Backend search terms must not repeat any title/title75/itemHighlights word — replace with synonyms/misspellings/other-language variants')];
}
