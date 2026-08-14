import { describe, expect, it } from 'vitest';
import { generateGroup, type LlmClient } from '@/lib/engine/llm';
import { imagesGroupSchemaFor } from '@/lib/engine/schemas';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * D2 — `imagePlan[].slot`: the WS8 PROMPT and the WS8 SCHEMA disagreed.
 *
 * Live evidence, on every one of three ASINs:
 *   {"event":"llm.reparse","group":"images","error":"ZodError",
 *    "issuePaths":["imagePlan.0.slot", … ,"imagePlan.7.slot"]}
 *
 * The schema wanted `z.number().int().min(1).max(9)`; the prompt rendered each
 * slot as `(1) "main-white-background" — …` and never said which of the two
 * the `slot` field took, so the model wrote the quoted LABEL. Eight rows, a
 * wasted reparse round on every run.
 *
 * Both halves are asserted here, PARAMETERIZED over the pack's own slot rows so
 * a fix written to one payload cannot make the suite pass:
 *  - the prompt states the permitted values verbatim;
 *  - the documented shape validates on the FIRST attempt (no reparse);
 *  - a wrong slot id still FAILS. The schema was not loosened to a string.
 */
const pack = loadPack('supplements');
const arch = pack.rules.imageArchitecture!;
const specs = arch.slots;
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const prompt = buildGroupPrompts(pack).images(snapshot);
const schema = imagesGroupSchemaFor(arch);

const videoBrief = {
  aspect: arch.video!.aspect,
  durationSeconds: arch.video!.minSeconds,
  shots: ['Open on the product in a real room', 'Hand lifts the pack', 'Close on the front label'],
  onScreenText: ['One a day', 'Made to a published standard'],
  notes: 'Shot vertical throughout.',
};

/** The plan exactly as the prompt documents it: the slot NUMBER, nothing else. */
const documentedPlan = (slotOf: (s: (typeof specs)[number]) => unknown) =>
  specs.map((s) => ({
    slot: slotOf(s),
    purpose: s.purpose,
    spec: 'A real photograph, longest side 1000px or more, evenly lit and fully readable',
    notes: 'Layout guidance for this frame',
    altText: 'The product on a plain background, front label readable',
  }));

/** A stub client that answers once and counts how many times it was asked. */
function stub(payload: unknown): { llm: LlmClient; calls: () => number } {
  let calls = 0;
  return {
    llm: async () => {
      calls++;
      return JSON.stringify(payload);
    },
    calls: () => calls,
  };
}

describe('D2 — the images prompt and the images schema agree about `slot`', () => {
  it('the prompt states every permitted slot value, verbatim from the pack', () => {
    for (const s of specs) {
      expect(prompt).toContain(`"slot": ${s.slot}`);
    }
    // and it says the field is an id rather than the wording beside it
    expect(prompt).toMatch(/"slot": the whole number/);
  });

  it('the shape the prompt documents parses on the FIRST attempt', async () => {
    const { llm, calls } = stub({ imagePlan: documentedPlan((s) => s.slot), videoBrief });
    const out = await generateGroup(llm, 'images', 'sys', prompt, schema, 3500);
    expect(calls()).toBe(1); // no reparse round was needed
    expect(out.imagePlan.map((r) => r.slot)).toEqual(specs.map((s) => s.slot));
  });

  it('the same number written as a string, and the slot\'s own purpose label, resolve to the id', () => {
    const asString = schema.safeParse({ imagePlan: documentedPlan((s) => String(s.slot)), videoBrief });
    expect(asString.success).toBe(true);
    expect(asString.success && asString.data.imagePlan.map((r) => r.slot)).toEqual(specs.map((s) => s.slot));

    // The label spelling is the one the prompt itself puts in front of the model.
    const asLabel = schema.safeParse({ imagePlan: documentedPlan((s) => s.purpose), videoBrief });
    expect(asLabel.success).toBe(true);
    expect(asLabel.success && asLabel.data.imagePlan.map((r) => r.slot)).toEqual(specs.map((s) => s.slot));
  });

  it.each(specs.map((s) => s.slot))('a wrong slot id in place of %i still fails', (id) => {
    const bad = schema.safeParse({
      imagePlan: documentedPlan((s) => (s.slot === id ? 'hero-shot' : s.slot)),
      videoBrief,
    });
    expect(bad.success).toBe(false);
    expect(bad.success === false && bad.error.issues.some((i) => i.path.join('.').endsWith('slot'))).toBe(true);
  });

  it('a slot id outside the pack architecture fails — the field is not a free string', () => {
    const out = schema.safeParse({
      imagePlan: documentedPlan((s) => (s.slot === specs[0]!.slot ? specs.length + 1 : s.slot)),
      videoBrief,
    });
    expect(out.success).toBe(false);
  });

  it('the schema length follows the pack, not a literal', () => {
    const short = schema.safeParse({ imagePlan: documentedPlan((s) => s.slot).slice(1), videoBrief });
    expect(short.success).toBe(false);
  });
});
