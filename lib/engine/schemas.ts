import { z } from 'zod';

/**
 * Zod schemas per generation group — structural minimums enforced at the
 * LLM boundary (counts/shapes here; char/byte limits are the gate's job).
 */

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
          claimBearing: z.boolean(),
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
        z.object({
          id: z.string(),
          headline: z.string().min(3),
          body: z.string().min(30),
          subcopy: z.string().optional(),
          claimBearing: z.boolean(),
        }),
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
          claimBearing: z.boolean(),
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

export const imagesGroupSchema = z.object({
  imagePlan: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(9),
        purpose: z.string().min(3),
        spec: z.string().min(10),
        notes: z.string(),
      }),
    )
    .length(7),
});

export const qaGroupSchema = z.object({
  qa: z
    .array(
      z.object({
        q: z.string().min(5),
        a: z.string().min(10),
        claimBearing: z.boolean(),
      }),
    )
    .min(15)
    .max(18),
});

export type TitleGroup = z.infer<typeof titleGroupSchema>;
export type BulletsGroup = z.infer<typeof bulletsGroupSchema>;
export type DescriptionGroup = z.infer<typeof descriptionGroupSchema>;
export type BackendGroup = z.infer<typeof backendGroupSchema>;
export type AttributesGroup = z.infer<typeof attributesGroupSchema>;
export type AplusGroup = z.infer<typeof aplusGroupSchema>;
export type ImagesGroup = z.infer<typeof imagesGroupSchema>;
export type QaGroup = z.infer<typeof qaGroupSchema>;
