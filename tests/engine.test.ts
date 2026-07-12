import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFacts, extractFormulaCount, extractPotency, parsePerDay } from '@/lib/engine/facts';
import { optimize } from '@/lib/engine/optimize';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { ListingSnapshot } from '@/lib/types';
import { rainforestSample } from './fixtures/rainforest.sample';
import { mockLlm } from './fixtures/mockLlm';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const DISCLAIMER = pack.compliancePack!.disclaimer;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listTsFiles(p));
    else if (ent.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('deterministic facts producer', () => {
  it('extracts unit-anchored potency', () => {
    expect(extractPotency('Probiotic 50 Billion CFU capsules', pack.compliancePack!.factUnits)).toBe('50 Billion CFU');
    expect(extractPotency('Turmeric 1,000 mg extract', pack.compliancePack!.factUnits)).toBe('1000 mg');
    expect(extractPotency('no numbers here', pack.compliancePack!.factUnits)).toBeUndefined();
  });
  it('extracts formula / strain counts', () => {
    expect(extractFormulaCount('10-strain probiotic blend')).toBe(10);
    expect(extractFormulaCount('5 in 1 daily formula')).toBe(5);
    expect(extractFormulaCount('Immunity Complete 20-in-1 Multivitamin')).toBe(20);
    expect(extractFormulaCount('plain text')).toBeUndefined();
  });
  it('parses per-day directions', () => {
    expect(parsePerDay('Take 2 capsules daily with food')).toBe(2);
    expect(parsePerDay('Take once a day')).toBe(1);
    expect(parsePerDay(undefined)).toBeUndefined();
  });
  it('builds facts from the fixture snapshot (never LLM-guessed)', () => {
    const facts = buildFacts(snapshot, pack.compliancePack!.factUnits);
    expect(facts.unitCount).toBe(60);
    expect(facts.servingSize).toBe('1 Capsule');
    expect(facts.potency).toBe('50 Billion CFU');
    expect(facts.formulaCount).toBe(10);
    expect(facts.weight).toBe('2.4 Ounces');
    expect(facts.price).toBe('$24.99');
    expect(facts.daySupply).toBe(60);
  });
});

describe('optimize (mock LLM — golden generation fixture)', () => {
  it('returns a complete OptimizedListing', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.title).toBeTruthy();
    expect(listing.title75).toBeTruthy();
    expect(listing.itemHighlights).toBeTruthy();
    expect(listing.bullets).toHaveLength(5);
    expect(listing.description.length).toBeGreaterThan(100);
    expect(listing.backendSearchTerms).toBeTruthy();
    expect(Object.keys(listing.attributes).length).toBeGreaterThan(20);
    expect(listing.facts.potency).toBe('50 Billion CFU');
    expect(listing.aplusContent.modules.length).toBeGreaterThanOrEqual(5);
    expect(listing.aplusContent.comparison.rows.length).toBeGreaterThanOrEqual(3);
    expect(listing.aplusContent.faq.length).toBeGreaterThanOrEqual(5);
    expect(listing.imagePlan).toHaveLength(7);
    expect(listing.qa.length).toBeGreaterThanOrEqual(15);
    expect(listing.state).toBe('draft');
  });

  it('inserts the verbatim disclaimer via CODE: description + claim-bearing A+/QA; bullets carry only *', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.description).toContain(DISCLAIMER);
    expect(listing.fdaDisclaimer).toBe(DISCLAIMER);
    expect(listing.aplusContent.fdaDisclaimer).toBe(DISCLAIMER);
    expect(listing.attributes.legal_disclaimer_description).toBe(DISCLAIMER);
    for (const m of listing.aplusContent.modules) {
      if (m.claimBearing) expect(m.body).toContain(DISCLAIMER);
    }
    for (const f of [...listing.aplusContent.faq, ...listing.qa]) {
      if (f.claimBearing) expect(f.a).toContain(DISCLAIMER);
    }
    for (const b of listing.bullets) {
      expect(b).not.toContain(DISCLAIMER);
    }
    expect(listing.bullets.some((b) => b.trimEnd().endsWith('*'))).toBe(true);
  });

  it('title precedence: product name leads; primary keyword front-loaded after it', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.title.startsWith(listing.productName)).toBe(true);
    expect(listing.title75.startsWith(listing.productName)).toBe(true);
    expect(listing.description).toContain(listing.productName);
    const pkWords = listing.primaryKeyword.toLowerCase().split(/\s+/);
    expect(pkWords.some((w) => listing.title.toLowerCase().includes(w))).toBe(true);
  });

  it('fans out 8 parallel LLM calls on a full optimize run', async () => {
    let calls = 0;
    const counting: typeof mockLlm = async (req) => {
      calls++;
      return mockLlm(req);
    };
    await optimize(snapshot, pack, counting);
    expect(calls).toBe(8);
  });

  it('generic pack omits FDA disclaimer assembly', async () => {
    const generic = loadPack('generic');
    const tongs: ListingSnapshot = {
      asin: 'B0TONGS',
      url: 'https://www.amazon.com/dp/B0TONGS',
      title: 'SteelPro Kitchen Tongs 12-Inch Stainless',
      bullets: ['Sturdy build', 'b', 'c', 'd', 'e'],
      description: 'SteelPro Kitchen Tongs are stainless utensils for daily cooking.',
      category: 'Kitchen & Dining > Utensils',
      subcategory: [],
      attributes: { unit_count: '1 Count', item_weight: '8 Ounces' },
      images: [],
      price: '$14.99',
      raw: {},
    };
    const listing = await optimize(tongs, generic, mockLlm);
    expect(listing.fdaDisclaimer).toBe('');
    expect(listing.description).not.toContain(DISCLAIMER);
    expect(listing.attributes.legal_disclaimer_description).toBeUndefined();
  });

  it('regenerates ONLY requested groups in repair mode', async () => {
    const base = await optimize(snapshot, pack, mockLlm);
    let calls = 0;
    const counting: typeof mockLlm = async (req) => {
      calls++;
      return mockLlm(req);
    };
    const repaired = await optimize(snapshot, pack, counting, {
      groups: ['backend'],
      base,
      failureContext: { backend: 'C3: backend exceeds 249 bytes' },
    });
    expect(calls).toBe(1);
    expect(repaired.title).toBe(base.title);
    expect(repaired.description).toBe(base.description);
  });

  it('no category-specific strings hard-coded in engine files', async () => {
    const engineRoot = join(process.cwd(), 'lib/engine');
    for (const f of listTsFiles(engineRoot)) {
      const rel = f.replace(`${process.cwd()}\\`, '').replace(`${process.cwd()}/`, '');
      const src = readFileSync(f, 'utf8').toLowerCase();
      expect(src.includes('supplement facts'), `${rel} must not hard-code categories`).toBe(false);
      expect(src.includes('probiotic'), `${rel} must not hard-code categories`).toBe(false);
    }
  });
});
