import { describe, expect, it } from 'vitest';
import {
  sanitizeBackendSearchTerms,
  forbiddenBackendStems,
} from '@/lib/engine/backendSanitize';
import { utf8Bytes } from '@/lib/shared/utf8Bytes';

const surfaces = {
  title: 'Culturelle Probiotic Supplement Digestive Health 30 Capsules',
  title75: 'Culturelle Probiotic Digestive Support',
  itemHighlights: 'Immune support daily probiotic capsules',
};

describe('sanitizeBackendSearchTerms', () => {
  it('strips stems that overlap title surfaces (C16)', () => {
    const out = sanitizeBackendSearchTerms(
      'probiotico digestivo flora intestinal probiotic capsules salud',
      surfaces,
      249,
    );
    const stems = forbiddenBackendStems(surfaces);
    expect(stems).toContain('probiotic');
    expect(out.toLowerCase()).not.toMatch(/\bprobiotic\b/);
    expect(out.toLowerCase()).not.toMatch(/\bcapsule/);
    expect(out).toMatch(/flora|intestinal|salud|probiotico|digestivo/i);
  });

  it('truncates to max UTF-8 bytes at word boundary (C3)', () => {
    const long = Array.from({ length: 80 }, (_, i) => `synonym${i}xx`).join(' ');
    const out = sanitizeBackendSearchTerms(long, surfaces, 249);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(249);
    expect(out.endsWith(' ')).toBe(false);
  });
});
