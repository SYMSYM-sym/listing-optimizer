import { describe, expect, it } from 'vitest';
import { loadPack } from '@/lib/knowledge/loadPack';

describe('phase-0 harness', () => {
  it('loads the supplements pack stub with correct hard limits', () => {
    const pack = loadPack('supplements');
    expect(pack.id).toBe('supplements');
    expect(pack.rules.backendMaxBytes).toBe(249);
    expect(pack.rules.title75Max).toBe(75);
    expect(pack.rules.itemHighlightsMax).toBe(125);
    expect(pack.rules.bulletCount).toBe(5);
    expect(pack.rules.bulletMax).toBe(255);
    expect(pack.rules.descriptionMax).toBe(2000);
    expect(pack.compliancePack?.disclaimer).toContain(
      'These statements have not been evaluated by the Food and Drug Administration.',
    );
  });

  it('generic pack has no compliance module', () => {
    expect(loadPack('generic').compliancePack).toBeNull();
  });
});
