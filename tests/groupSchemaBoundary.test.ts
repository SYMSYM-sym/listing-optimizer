import { describe, expect, it } from 'vitest';
import {
  APLUS_BODY_MIN_CHARS,
  APLUS_HEADLINE_MIN_CHARS,
  aplusGroupSchema,
  attributesGroupSchema,
} from '@/lib/engine/schemas';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * D3 + D4 — two more prompt/schema disagreements that reparsed on EVERY live
 * run and that the deterministic golden mock (which returns a hand-written,
 * already-valid payload) can never reach.
 *
 *   {"event":"llm.reparse","group":"attributes","error":"ZodError",
 *    "issuePaths":["attributes.servings_per_container","attributes.unit_count"]}
 *   {"event":"llm.reparse","group":"aplus","error":"ZodError",
 *    "issuePaths":["modules.5.body"]}
 *
 * Both are asserted in BOTH directions: the shape the prompt now documents
 * parses, and the shape that is genuinely wrong still fails.
 */
const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const prompts = buildGroupPrompts(pack);

describe('D3 — attribute values: numbers are coerced, malformed values are not', () => {
  /** The rows whose pack `valueType` is a number — the two the live run failed on. */
  const numericFields = pack.attributeSchema
    .filter((f) => f.valueType === 'number' && f.source !== 'operator')
    .map((f) => f.field);

  it('the pack really does declare numeric-valued attribute rows', () => {
    expect(numericFields.length).toBeGreaterThan(0);
  });

  it('the prompt states that every value comes back as a string', () => {
    const schemaFields = pack.attributeSchema
      .filter((f) => f.source !== 'operator')
      .map((f) => `${f.field} | ${f.required ? 'required' : 'optional'} | ${f.example}`)
      .join('\n');
    expect(prompts.attributes(snapshot, schemaFields)).toMatch(/EVERY value is a JSON string/);
  });

  it.each(numericFields)('%s returned as a bare number is accepted, as its own digits', (field) => {
    const out = attributesGroupSchema.safeParse({ attributes: { [field]: 60, brand_name: 'BrandX' } });
    expect(out.success).toBe(true);
    expect(out.success && out.data.attributes[field]).toBe('60');
  });

  it('a boolean is accepted as its own spelling', () => {
    const out = attributesGroupSchema.safeParse({ attributes: { some_flag: true } });
    expect(out.success && out.data.attributes.some_flag).toBe('true');
  });

  it.each([
    ['null', null],
    ['an array', ['60', '30']],
    ['an object', { value: 60 }],
    ['NaN', Number.NaN],
  ])('%s is still REJECTED — coercion is not "accept anything"', (_label, value) => {
    const out = attributesGroupSchema.safeParse({ attributes: { unit_count: value } });
    expect(out.success).toBe(false);
  });
});

describe('D4 — A+ module body: the prompt states the floor the schema enforces', () => {
  const modules = (bodyOfLast: string) => {
    const ids = pack.rules.aplusModuleIds;
    return ids.map((id, i) => ({
      id,
      headline: `Headline ${i + 1}`,
      body: i === ids.length - 1 ? bodyOfLast : 'A body long enough to be a real module of A+ content.',
      claimBearing: false,
    }));
  };
  const rest = {
    comparison: {
      rows: [
        { label: 'Potency', ours: 'A', typical: 'B' },
        { label: 'Storage', ours: 'A', typical: 'B' },
        { label: 'Supply', ours: 'A', typical: 'B' },
      ],
    },
    faq: Array.from({ length: 5 }, (_, i) => ({
      q: `Question number ${i + 1}?`,
      a: 'An answer with enough text.',
      claimBearing: false,
    })),
  };

  it('the prompt states both floors, and the numbers come from the schema itself', () => {
    const text = prompts.aplus(snapshot, 'BrandX Probiotic');
    expect(text).toContain(`at least ${APLUS_BODY_MIN_CHARS} characters`);
    expect(text).toContain(`at least ${APLUS_HEADLINE_MIN_CHARS} characters`);
    expect(text).toMatch(/the LAST module as fully as the first/);
  });

  it('a body at exactly the stated floor parses', () => {
    const out = aplusGroupSchema.safeParse({ modules: modules('x'.repeat(APLUS_BODY_MIN_CHARS)), ...rest });
    expect(out.success).toBe(true);
  });

  it('a body one character short of the stated floor still fails', () => {
    const out = aplusGroupSchema.safeParse({
      modules: modules('x'.repeat(APLUS_BODY_MIN_CHARS - 1)),
      ...rest,
    });
    expect(out.success).toBe(false);
    expect(out.success === false && out.error.issues.some((i) => i.path.join('.').endsWith('body'))).toBe(true);
  });

  it('a module with no body at all still fails', () => {
    const withoutBody = modules('x'.repeat(APLUS_BODY_MIN_CHARS)).map((m, i, all) =>
      i === all.length - 1 ? { id: m.id, headline: m.headline, claimBearing: false } : m,
    );
    const out = aplusGroupSchema.safeParse({ modules: withoutBody, ...rest });
    expect(out.success).toBe(false);
  });
});
