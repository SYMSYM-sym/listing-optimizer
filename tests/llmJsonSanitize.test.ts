import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Test the JSON control-char sanitizer via generateGroup's extract path by
// importing a tiny re-export — exercise through a mock LLM that returns raw newlines.
import { generateGroup } from '@/lib/engine/llm';

describe('generateGroup JSON control-char tolerance', () => {
  it('parses LLM JSON that contains raw newlines inside string values', async () => {
    const schema = z.object({ description: z.string().min(10) });
    const llm = async () =>
      '{\n  "description": "Line one.\n\nLine two with a paragraph break."\n}';
    const out = await generateGroup(llm, 'description', 'sys', 'user', schema, 500);
    expect(out.description).toContain('Line one.');
    expect(out.description).toContain('Line two');
  });
});
