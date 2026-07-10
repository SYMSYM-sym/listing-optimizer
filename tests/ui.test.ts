import { describe, expect, it } from 'vitest';
import rules from '@/knowledge/rules.json';
import { optimize } from '@/lib/engine/optimize';
import { runGate } from '@/lib/gate/runGate';
import { utf8Bytes as gateUtf8Bytes } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { utf8Bytes as sharedUtf8Bytes } from '@/lib/shared/utf8Bytes';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

describe('dashboard counters vs gate limits', () => {
  it('shared utf8Bytes matches gate utf8Bytes on multibyte strings', () => {
    for (const s of ['ascii only', 'äöü probiotic', 'ä'.repeat(130), 'probiotico ñ']) {
      expect(sharedUtf8Bytes(s)).toBe(gateUtf8Bytes(s));
    }
  });

  it('char/byte counts agree with gate pass/fail on the compliant fixture', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.title.length).toBeLessThanOrEqual(rules.titleMaxLegacy);
    expect(listing.title75.length).toBeLessThanOrEqual(rules.title75Max);
    expect(listing.itemHighlights.length).toBeLessThanOrEqual(rules.itemHighlightsMax);
    expect(listing.description.length).toBeLessThanOrEqual(rules.descriptionMax);
    for (const b of listing.bullets) {
      expect(b.length).toBeLessThanOrEqual(rules.bulletMax);
    }
    expect(sharedUtf8Bytes(listing.backendSearchTerms)).toBeLessThanOrEqual(rules.backendMaxBytes);
    const gate = runGate(listing, pack, ctx);
    expect(gate.pass).toBe(true);
  });

  it('over-limit backend bytes fail C3 with the same count the UI would show', () => {
    const over = 'ä'.repeat(130);
    const bytes = sharedUtf8Bytes(over);
    expect(bytes).toBeGreaterThan(rules.backendMaxBytes);
    const listing = {
      title: 'T',
      title75: 'T',
      itemHighlights: 'h',
      bullets: ['a', 'b', 'c', 'd', 'e'],
      description: 'desc with enough length to pass minimum checks here for the test case only',
      backendSearchTerms: over,
      attributes: {},
      facts: {},
      fdaDisclaimer: pack.compliancePack!.disclaimer,
      aplusContent: { fdaDisclaimer: pack.compliancePack!.disclaimer, modules: [], comparison: { rows: [] }, faq: [] },
      imagePlan: [],
      qa: [],
      primaryKeyword: 'k',
      productName: 'T',
      state: 'draft' as const,
    };
    const f = runGate(listing, pack, ctx).failures.find((x) => x.checkId === 'C3');
    expect(f?.context).toContain(String(bytes));
  });
});

describe('gateFailedOn field matching (UI helper logic)', () => {
  function gateFailedOn(failures: { field: string }[], field: string): boolean {
    return failures.some(
      (f) => f.field === field || f.field.startsWith(`${field}[`) || f.field.startsWith(`${field}.`),
    );
  }

  it('matches exact and indexed fields', () => {
    const failures = [
      { field: 'bullets[2]' },
      { field: 'backendSearchTerms' },
      { field: 'attributes.allergen_information' },
    ];
    expect(gateFailedOn(failures, 'bullets[2]')).toBe(true);
    expect(gateFailedOn(failures, 'backendSearchTerms')).toBe(true);
    expect(gateFailedOn(failures, 'attributes')).toBe(true);
    expect(gateFailedOn(failures, 'title')).toBe(false);
  });
});
