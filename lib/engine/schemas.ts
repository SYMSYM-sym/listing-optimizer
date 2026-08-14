import { z } from 'zod';

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

export const attributesGroupSchema = z.object({
  attributes: z.record(z.string(), z.string()),
});

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
          headline: z.string().min(3),
          body: z.string().min(30),
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
 * WS8 — 8 still slots + the 9:16 video brief.
 *
 * STRUCTURE ONLY, as everywhere at this boundary: the CONTENT of a brief (the
 * white-background/fill/pixel tokens, the real-photograph requirement) is
 * verified by gate C29 against the pack's slot specs, and the ALT cap by C30.
 * A schema that enforced the cap here would let a repair round satisfy Zod and
 * still ship an over-long ALT, because the schema runs before assembly.
 */
export const imagesGroupSchema = z.object({
  imagePlan: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(9),
        purpose: z.string().min(3),
        spec: z.string().min(10),
        notes: z.string(),
        altText: z.string().default(''),
      }),
    )
    .length(8),
  videoBrief: z.object({
    aspect: z.string().min(3),
    durationSeconds: z.preprocess(
      (v) => (typeof v === 'string' ? Number.parseInt(v, 10) : v),
      z.number().int().min(1).max(600),
    ),
    shots: z.array(z.string().min(5)).min(3),
    onScreenText: z.array(z.string().min(1)).min(2),
    notes: z.string().default(''),
  }),
});

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
 * well-shaped artifact; gate C28 is what verifies that a declaration is TRUE.
 * `tier` is coerced from the model's string ("1", "backend") because the kit's
 * schema mixes numeric tiers with label tiers in the same field.
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

export const keywordsGroupSchema = z.object({
  keywords: z
    .array(
      z.preprocess((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const o = raw as Record<string, unknown>;
        // The kit's artifact calls the term `t` and the rationale `evidence`;
        // accept both spellings so a model shown either shape validates first try.
        return {
          ...o,
          term: o.term ?? o.t ?? o.keyword ?? o.phrase,
          why: o.why ?? o.evidence ?? o.rationale ?? o.reason,
          surfaces: Array.isArray(o.surfaces) ? o.surfaces : o.surfaces == null ? [] : [o.surfaces],
        };
      }, z.object({
        term: z.string().min(2),
        tier: keywordTierField,
        status: z.string().min(3),
        surfaces: z.array(z.string()),
        why: z.string().min(3),
        via: z.string().optional(),
        home: z.string().optional(),
      })),
    )
    .min(8)
    .max(60),
});

export type TitleGroup = z.infer<typeof titleGroupSchema>;
export type BulletsGroup = z.infer<typeof bulletsGroupSchema>;
export type DescriptionGroup = z.infer<typeof descriptionGroupSchema>;
export type BackendGroup = z.infer<typeof backendGroupSchema>;
export type AttributesGroup = z.infer<typeof attributesGroupSchema>;
export type AplusGroup = z.infer<typeof aplusGroupSchema>;
export type ImagesGroup = z.infer<typeof imagesGroupSchema>;
export type QaGroup = z.infer<typeof qaGroupSchema>;
export type KeywordsGroup = z.infer<typeof keywordsGroupSchema>;
