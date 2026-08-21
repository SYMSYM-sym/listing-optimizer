import { z } from 'zod';
import type { ImageArchitecture, KeywordRules } from '@/lib/types';

/**
 * Zod schemas per generation group — structural minimums enforced at the
 * LLM boundary (counts/shapes here; char/byte limits are the gate's job).
 */

/** Coerce missing/odd LLM claimBearing flags to boolean (default false). */
const claimBearingField = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0' || s === '') return false;
  }
  if (v === 1 || v === 0) return Boolean(v);
  // Missing/undefined → non-claim-bearing (safe default; disclaimer still code-inserted when true)
  return false;
}, z.boolean());

export const titleGroupSchema = z.object({
  productName: z.string().min(2),
  primaryKeyword: z.string().min(2),
  title: z.string().min(10),
  title75: z.string().min(10),
  itemHighlights: z.string().min(10),
});

export const bulletsGroupSchema = z.object({
  bullets: z
    .array(
      z
        .object({
          text: z.string().min(20),
          useCaseAnchor: z.string().min(2),
          claimBearing: claimBearingField,
        })
        .refine((b) => !b.claimBearing || b.text.trimEnd().endsWith('*'), {
          message: 'claim-bearing bullets must end with *',
        }),
    )
    .length(5),
});

export const descriptionGroupSchema = z.object({
  description: z.string().min(100),
});

export const backendGroupSchema = z.object({
  backendSearchTerms: z.string().min(10),
});

/**
 * D3 — every attribute VALUE is a string, and a number is accepted AS one.
 *
 * Live evidence, on every run:
 *   {"event":"llm.reparse","group":"attributes","error":"ZodError",
 *    "issuePaths":["attributes.servings_per_container","attributes.unit_count"]}
 *
 * Those two fields are the only rows the pack declares `valueType: "number"`,
 * and their example column reads `[N]` — so the prompt asked for a number and
 * the schema (`z.record(z.string(), z.string())`) demanded a string. The model
 * was right both times; the boundary disagreed with itself.
 *
 * The prompt now says the value is a JSON string on every row, and a scalar
 * arrives here as one: a finite number or a boolean is rendered with its own
 * canonical spelling and NOTHING else is. `null`, an array and an object are
 * still rejected — a coercion that accepted them would turn malformed output
 * ("[object Object]", "") into an attribute an operator then pastes into a
 * live listing, and C23 would count the field as filled.
 */
const attributeValue = z.preprocess((v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v;
  if (typeof v === 'boolean') return String(v);
  return v;
}, z.string());

export const attributesGroupSchema = z.object({
  attributes: z.record(z.string(), attributeValue),
});

/**
 * D4 — the A+ module floors, in ONE place.
 *
 * Live evidence, on every run:
 *   {"event":"llm.reparse","group":"aplus","error":"ZodError",
 *    "issuePaths":["modules.5.body"]}
 *
 * The schema required `body` to be at least 30 characters; the prompt stated
 * the module COUNT and the headline floor and said nothing at all about the
 * body, so the sixth module came back with a one-line body (or none) and the
 * run burned a reparse round on a rule it was never given. Both numbers are
 * exported and rendered into the prompt, so the instruction and the contract
 * cannot drift apart again.
 */
export const APLUS_HEADLINE_MIN_CHARS = 3;
export const APLUS_BODY_MIN_CHARS = 30;

export const aplusGroupSchema = z
  .object({
    modules: z
      .array(
        z.preprocess((raw) => {
          // LLMs often rename headline → title/heading on brand-story/hero; map aliases
          // so the first attempt validates without a costly reparse round.
          if (!raw || typeof raw !== 'object') return raw;
          const o = raw as Record<string, unknown>;
          const headline = o.headline ?? o.title ?? o.heading ?? o.header ?? o.name;
          return {
            ...o,
            headline: typeof headline === 'string' ? headline : headline != null ? String(headline) : undefined,
            body: o.body ?? o.text ?? o.copy ?? o.content,
          };
        }, z.object({
          id: z.string(),
          headline: z.string().min(APLUS_HEADLINE_MIN_CHARS),
          body: z.string().min(APLUS_BODY_MIN_CHARS),
          subcopy: z.string().optional(),
          claimBearing: claimBearingField,
          /** WS8 — ALT for the module banner; length is gate C30's job. */
          bannerAltText: z.string().optional(),
        })),
      )
      .min(5)
      .max(7),
    comparison: z.object({
      rows: z
        .array(
          z.preprocess((raw) => {
            if (!raw || typeof raw !== 'object') return raw;
            const o = raw as Record<string, unknown>;
            return {
              label: String(o.label ?? o.feature ?? o.name ?? o.dimension ?? ''),
              ours: String(o.ours ?? o.us ?? o.our ?? o.thisProduct ?? ''),
              typical: String(o.typical ?? o.theirs ?? o.competitor ?? o.other ?? o.alternative ?? ''),
            };
          }, z.object({
            label: z.string().min(1),
            ours: z.string().min(1),
            typical: z.string().min(1),
          })),
        )
        .min(3),
    }),
    faq: z
      .array(
        z.object({
          q: z.string().min(5),
          a: z.string().min(10),
          claimBearing: claimBearingField,
        }),
      )
      .min(5)
      .max(10),
  })
  .refine((v) => v.modules.some((m) => m.id === 'brand-story'), {
    message: 'A+ must include brand-story module',
  })
  .refine((v) => v.modules.some((m) => m.id === 'hero'), {
    message: 'A+ must include hero module',
  });

/**
 * WS8 — the still slots + the 9:16 video brief.
 *
 * SLOT IS A PACK ID, NOT A FREE LABEL (D2). Every live run failed
 * `imagePlan.0.slot`..`imagePlan.7.slot` because the schema demanded a NUMBER
 * while the prompt listed each slot as `(1) "main-white-background" — …` and
 * never said which of the two the field wanted; the model wrote the quoted
 * label. Both sides are fixed together: the prompt now states the permitted
 * values verbatim (they are rendered from the same `rules.imageArchitecture`
 * data this schema is built from), and the schema resolves the slot to the
 * pack's own id — accepting the number, the same number written as a string,
 * or that slot's documented purpose label — and REJECTS anything else. It is
 * deliberately NOT `z.string()`: C29 matches the emitted brief to its slot
 * spec by id and C30 caps that slot's ALT, so "which slot is this" has to stay
 * knowable.
 *
 * Everything else is STRUCTURE ONLY, as everywhere at this boundary: the
 * CONTENT of a brief (the background/fill/pixel tokens, the real-photograph
 * requirement) is verified by gate C29 against the pack's slot specs, and the
 * ALT cap by C30. A schema that enforced the cap here would let a repair round
 * satisfy Zod and still ship an over-long ALT, because the schema runs before
 * deterministic assembly.
 */
/** Fold a label to its comparison form: case, spacing and hyphens only. */
const labelKey = (v: string): string => v.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/**
 * The slot field for ONE pack's architecture. `ids` is the closed set of slot
 * ids the pack defines; `byLabel` maps each slot's documented purpose label to
 * that same id, so the one alternative spelling the prompt itself puts in front
 * of the model resolves instead of costing a reparse round.
 */
function slotField(specs: { slot: number; purpose: string }[]) {
  const ids = specs.map((s) => s.slot);
  const byLabel = new Map(specs.map((s) => [labelKey(String(s.purpose ?? '')), s.slot]));
  return z.preprocess((v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const raw = v.trim();
      const digits = raw.match(/^[^0-9]{0,8}?(\d{1,3})$/);
      if (digits) return Number(digits[1]);
      const byName = byLabel.get(labelKey(raw));
      if (byName !== undefined) return byName;
    }
    return v;
  }, z.number().int().refine((n) => ids.includes(n), {
    message: `slot must be one of the ids the pack defines: ${ids.join(', ')}`,
  }));
}

const videoBriefSchema = z.object({
  aspect: z.string().min(3),
  durationSeconds: z.preprocess(
    (v) => (typeof v === 'string' ? Number.parseInt(v, 10) : v),
    z.number().int().min(1).max(600),
  ),
  shots: z.array(z.string().min(5)).min(3),
  onScreenText: z.array(z.string().min(1)).min(2),
  notes: z.string().default(''),
});

/**
 * Build the images schema from the ACTIVE pack's slot architecture, so the
 * accepted slot ids and the required plan length are the pack's numbers rather
 * than literals kept in step by hand.
 */
export function imagesGroupSchemaFor(arch: ImageArchitecture | undefined) {
  const specs = (arch?.slots ?? [])
    .filter((s) => typeof s?.slot === 'number' && typeof s?.purpose === 'string')
    .map((s) => ({ slot: s.slot, purpose: s.purpose }));
  const item = z.object({
    slot: specs.length > 0 ? slotField(specs) : z.number().int().min(1),
    purpose: z.string().min(3),
    spec: z.string().min(10),
    notes: z.string(),
    altText: z.string().default(''),
  });
  return z.object({
    // No architecture => no declared plan length; the pack manifest already
    // fails such a pack closed at PACK, so this boundary must not also invent
    // a count of its own.
    imagePlan: specs.length > 0 ? z.array(item).length(specs.length) : z.array(item).min(1),
    videoBrief: videoBriefSchema,
  });
}

export const qaGroupSchema = z.object({
  qa: z
    .array(
      z.object({
        q: z.string().min(5),
        a: z.string().min(10),
        claimBearing: claimBearingField,
      }),
    )
    .min(15)
    .max(18),
});

/**
 * WS3 — the KEYWORD REFERENCE group.
 *
 * STRUCTURE ONLY, as everywhere else at this boundary: the schema guarantees a
 * well-shaped artifact; gate C28 is what verifies that a row is TRUE.
 * `tier` is coerced from the model's string ("1", "backend") because the kit's
 * schema mixes numeric tiers with label tiers in the same field.
 *
 * `surfaces` IS NOT ASKED FOR. The model was required to state which surfaces
 * its own copy had placed each term on, and it was wrong ~21 times per live
 * run on all three ASINs — a fact code can compute exactly, asked of a model
 * that could only guess. `lib/engine/keywordPlacement.ts` derives it from the
 * finished copy instead. Asking for a field only to overwrite it would spend
 * output tokens on drift, so the field is gone from the contract; a model that
 * volunteers one anyway has it stripped here (`z.object` drops unknown keys)
 * rather than half-honoured.
 */
const keywordTierField = z.preprocess((v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^[1-4]$/.test(s)) return Number(s);
    return s.toLowerCase();
  }
  return v;
}, z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.string().min(3)]));

/**
 * D1 — the artifact is BOUNDED, and the bound is pack data.
 *
 * Live evidence, on all three ASINs and on every attempt including the retry:
 *   {"event":"llm.group","group":"keywords","ms":25901,
 *    "stopReason":"max_tokens","outputTokens":3000}
 *   {"event":"llm.reparse","group":"keywords","error":"SyntaxError","issuePaths":[]}
 *
 * The schema allowed up to 60 rows with an unbounded `why`, the prompt asked
 * for full coverage and named no end, and the group was given 3000 output
 * tokens — so the model wrote until the ceiling cut it off mid-row and
 * `JSON.parse` threw. Raising the budget alone would only move the cliff:
 * whatever the ceiling is, an unbounded list eventually reaches it. So the
 * ARTIFACT is bounded (`maxTerms`, `whyMaxChars`), the same two numbers are
 * stated in the prompt, and the budget below is DERIVED from them.
 *
 * ===========================================================================
 * D1 RECURRED AT THE LARGE-INPUT END, AND THE ROW COUNT WAS THE BOUND THAT HAD
 * NO TOLERANCE. (Live, 24-run batch: `GEN | generation.keywords | (no valid
 * output)`, three occurrences, ALL on the same ASIN — the largest of the three
 * test listings, a twenty-ingredient formula. The other two ASINs went 8/8.)
 *
 * WHAT WAS MEASURED FIRST, because two plausible causes had to be ruled out
 * before anything was changed (numbers in `tests/keywordBudget.d1.test.ts`,
 * computed from these very functions rather than restated):
 *
 *   - THE BUDGET ARITHMETIC WAS NOT THE DEFECT. The schema's `why` tolerance is
 *     INSIDE the budget, not outside it: the budget's per-row prose allowance is
 *     the same `whyMaxChars x tolerance` figure the schema enforces, so a model
 *     writing to the STATED limit, and one writing to the tolerated limit, both
 *     fit. The largest artifact the old schema would accept came to ~4,982
 *     tokens against a ~5,500-token budget.
 *   - THE INPUT WAS NOT SQUEEZING THE OUTPUT. `max_tokens` is an OUTPUT bound;
 *     it is not shared with the prompt. Phase 3 carries the finished listing, so
 *     the keywords prompt does grow with the listing — ~13.1k input tokens on
 *     the small fixture against ~18.7k on a twenty-ingredient one — but both sit
 *     an order of magnitude inside the context window, and neither figure enters
 *     the output budget at all.
 *
 * WHAT DOES SCALE WITH THE INPUT IS THE ARTIFACT THE PROMPT ASKS FOR. Tier 2 is
 * defined in the pack vocabulary as "named entities — each component by its full
 * name", so a twenty-component formula owes twenty rows before a single head
 * term, qualifier, buyer phrase or `minNegatives` exclusion is written. The pack
 * calibrated `maxTerms: 28` against a listing with a fraction of that ("the
 * recorded golden reference uses 19"), and the cap does not move with the input.
 * The prompt therefore asks, on that ASIN, for an artifact the schema will not
 * accept — and `z.array().max()` rejects the WHOLE payload for the surplus, so
 * ~38 good rows are thrown away, the reparse re-asks the identical impossible
 * thing, and the group degrades. Nothing downstream even enforces `maxTerms`
 * (the gate reads `visibleSurfaces`, `statuses` and `minNegatives`, never the
 * cap), so the hard cliff bought nothing and cost the group.
 *
 * THE FIX IS THE ONE THIS FILE ALREADY USES FOR THE OTHER OVERSHOOTING FIELD.
 * `why` has stated a SHORTER limit in the prompt than the schema enforces since
 * D1, precisely "so an ordinary overshoot never costs a reparse round while the
 * hard bound the budget is computed from still holds". The row count overshoots
 * for exactly the same reason and gets exactly the same treatment: ONE tolerance
 * constant, applied to both, with the prompt still stating the pack's numbers and
 * the budget still derived from what the schema will actually accept.
 *
 * WHAT IS NOT DONE, deliberately. `maxTerms` is NOT lowered (`minNegatives` and
 * the four tiers need every row it allows) and it is NOT raised in the pack (the
 * model would then write to the larger number on every listing, large or small).
 * The tolerance is invisible to the prompt for the same reason the `why`
 * tolerance is: a limit the model is told about is a limit it writes to.
 * The artifact stays BOUNDED — the cliff moved, it did not disappear — and a
 * group that still cannot produce valid output still degrades and still blocks
 * at `GEN`, unchanged.
 */

/**
 * The slack the SCHEMA allows over the limit the PROMPT states, for the two
 * fields a model demonstrably overshoots: the row count and the `why` prose.
 *
 * ONE constant for both, because it is one policy — "state the target, accept an
 * ordinary overshoot, keep a hard bound the budget can be computed from". Two
 * numbers here would be two policies that drift.
 */
export const KEYWORD_SCHEMA_TOLERANCE = 1.5;

/**
 * The row count the SCHEMA accepts, as opposed to the `maxTerms` the prompt
 * states. `undefined` when the pack states no cap, which leaves the array
 * unbounded exactly as it was.
 *
 * Floored at `KEYWORD_MIN_TERMS` so a pack with a tiny `maxTerms` can never
 * produce the impossible `.min(8).max(6)` pair.
 */
export function keywordSchemaMaxTerms(kr: KeywordRules | undefined): number | undefined {
  const stated = typeof kr?.maxTerms === 'number' && kr.maxTerms > 0 ? kr.maxTerms : undefined;
  if (stated === undefined) return undefined;
  return Math.max(KEYWORD_MIN_TERMS, Math.ceil(stated * KEYWORD_SCHEMA_TOLERANCE));
}

/** The `why` length the SCHEMA accepts, as opposed to the stated `whyMaxChars`. */
export function keywordSchemaWhyMaxChars(kr: KeywordRules | undefined): number | undefined {
  const stated =
    typeof kr?.whyMaxChars === 'number' && kr.whyMaxChars > 0 ? kr.whyMaxChars : undefined;
  if (stated === undefined) return undefined;
  return Math.ceil(stated * KEYWORD_SCHEMA_TOLERANCE);
}

export function keywordsGroupSchemaFor(kr: KeywordRules | undefined) {
  const max = keywordSchemaMaxTerms(kr);
  const whyMax = keywordSchemaWhyMaxChars(kr);
  const row = z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const o = raw as Record<string, unknown>;
    // The kit's artifact calls the term `t` and the rationale `evidence`;
    // accept both spellings so a model shown either shape validates first try.
    return {
      ...o,
      term: o.term ?? o.t ?? o.keyword ?? o.phrase,
      why: o.why ?? o.evidence ?? o.rationale ?? o.reason,
    };
  }, z.object({
    term: z.string().min(2),
    tier: keywordTierField,
    status: z.string().min(3),
    // `why` is the row's only REQUIRED free prose. The prompt states a SHORTER
    // limit than this one, so an ordinary overshoot never costs a reparse round
    // while the hard bound the budget is computed from still holds. (`via` and
    // `home` are prose too, and are deliberately left unbounded — see the
    // headroom note on `keywordsMaxTokens`, which is what pays for them.)
    why: whyMax ? z.string().min(3).max(whyMax) : z.string().min(3),
    via: z.string().optional(),
    home: z.string().optional(),
  }));
  const list = z.array(row).min(KEYWORD_MIN_TERMS);
  return z.object({ keywords: max ? list.max(max) : list });
}

/** The floor: below this the reference cannot cover the listing at all. */
export const KEYWORD_MIN_TERMS = 8;

/**
 * D1 — the keywords group's OUTPUT BUDGET, derived from what the SCHEMA WILL
 * ACCEPT rather than from a parallel restatement of the pack numbers.
 *
 * Worst case for one row, measured against a pretty-printed row carrying every
 * optional field and the longest surface list the pack vocabulary allows:
 * ~400 characters of keys, punctuation, indentation, tier, status, surfaces,
 * `via` and `home`, plus the schema's `why` bound of prose. JSON of this shape
 * tokenizes at roughly 3 characters per token. It is a CEILING, not a target:
 * the prompt's caps are what the model actually writes to, and unused budget
 * costs nothing. The row no longer carries `surfaces` at all (it is derived),
 * which only makes the real row SMALLER than this ceiling.
 *
 * BOTH INPUTS ARE THE SCHEMA'S, NOT THE PROMPT'S, and that is the D1 property
 * restated correctly: the budget must pay for the largest artifact THE PARSER
 * WILL ACCEPT, because anything larger is rejected on shape and anything the
 * parser accepts must have been receivable. Reading the prompt's numbers here
 * while the schema enforced the tolerated ones is how a payload could be
 * schema-valid and still arrive truncated.
 *
 * WHY THERE IS EXPLICIT HEADROOM ON TOP OF THAT WORST CASE, and it is not
 * padding. `KEYWORD_ROW_FIXED_CHARS` is an ESTIMATE, not a bound: `via` and
 * `home` are free prose and the schema bounds NEITHER of them, so a row CAN
 * exceed the 400-character allowance and the sentence "the budget covers the
 * largest artifact the schema will accept" is only true up to that estimate.
 * Bounding those two fields instead was considered and rejected — the prompt
 * states no limit for them, so a schema limit would fail lawful output, and
 * over-blocking is treated here as exactly as severe as a bypass. The headroom
 * is the cheaper side of the same trade: it costs nothing when unused (billing
 * and latency follow tokens actually generated), and it buys the reparse retry a
 * COMPLETE payload to be rejected on — a precise `too_big` the second attempt
 * can act on, instead of a mid-row truncation it cannot.
 *
 * IT IS STILL A CLIFF, JUST FURTHER OUT. A model that ignores every stated cap
 * eventually exhausts this too; it then degrades, `GEN` blocks, and the run
 * comes back `verified:false`. That path is unchanged and is the fail-closed
 * direction.
 */
const KEYWORD_ROW_FIXED_CHARS = 400;
const KEYWORD_WRAPPER_CHARS = 64;
const CHARS_PER_TOKEN = 3;
/** See the note above: it pays for the two prose fields the schema cannot bound. */
export const KEYWORD_BUDGET_HEADROOM = 1.25;
/** The `why` bound assumed when a pack states none, before tolerance. */
const KEYWORD_DEFAULT_WHY_CHARS = 200;

export function keywordsMaxTokens(kr: KeywordRules | undefined): number {
  const max = keywordSchemaMaxTerms(kr) ?? KEYWORD_MIN_TERMS;
  const whyMax =
    keywordSchemaWhyMaxChars(kr) ??
    Math.ceil(KEYWORD_DEFAULT_WHY_CHARS * KEYWORD_SCHEMA_TOLERANCE);
  const chars = max * (KEYWORD_ROW_FIXED_CHARS + whyMax) + KEYWORD_WRAPPER_CHARS;
  return Math.ceil((chars * KEYWORD_BUDGET_HEADROOM) / CHARS_PER_TOKEN / 100) * 100;
}

export type TitleGroup = z.infer<typeof titleGroupSchema>;
export type BulletsGroup = z.infer<typeof bulletsGroupSchema>;
export type DescriptionGroup = z.infer<typeof descriptionGroupSchema>;
export type BackendGroup = z.infer<typeof backendGroupSchema>;
export type AttributesGroup = z.infer<typeof attributesGroupSchema>;
export type AplusGroup = z.infer<typeof aplusGroupSchema>;
export type ImagesGroup = z.infer<ReturnType<typeof imagesGroupSchemaFor>>;
export type QaGroup = z.infer<typeof qaGroupSchema>;
export type KeywordsGroup = z.infer<ReturnType<typeof keywordsGroupSchemaFor>>;
