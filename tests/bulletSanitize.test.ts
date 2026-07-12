import { describe, expect, it } from 'vitest';
import { sanitizeBullets } from '@/lib/engine/bulletSanitize';

describe('sanitizeBullets', () => {
  it('truncates over-long bullets at a word boundary and keeps claim *', () => {
    const long = `${'WORD '.repeat(60).trim()}*`;
    expect(long.length).toBeGreaterThan(255);
    const [out] = sanitizeBullets([long], 255);
    expect(out!.length).toBeLessThanOrEqual(255);
    expect(out!.endsWith('*')).toBe(true);
    expect(out!.includes('WORD')).toBe(true);
  });

  it('leaves short bullets unchanged', () => {
    expect(sanitizeBullets(['SHORT BULLET: fine as is*'], 255)).toEqual(['SHORT BULLET: fine as is*']);
  });
});
