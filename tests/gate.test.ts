import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { fieldToGroup, runRepairLoop } from '@/lib/engine/repair';
import type { GateContext } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { hasNegationContext, normalize, tokenSet, utf8Bytes } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
const idsOf = (l: OptimizedListing) => runGate(l, pack, ctx).failures.map((f) => f.checkId);

describe('gate utilities', () => {
  it('normalize handles curly quotes, dashes, entities', () => {
    expect(normalize('“smart” – dash &amp; entity')).toBe('"smart" - dash & entity');
  });
  it('utf8Bytes counts bytes not chars', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('äöü')).toBe(6);
  });
  it('negation guard sees ~90 preceding chars', () => {
    const t = 'You should never say arthritis in copy';
    expect(hasNegationContext(t, t.indexOf('arthritis'))).toBe(true);
    const t2 = 'This helps with arthritis';
    expect(hasNegationContext(t2, t2.indexOf('arthritis'))).toBe(false);
  });
  it('tokenSet stems plurals and drops stopwords', () => {
    expect(tokenSet('Capsules for the Women')).toEqual(new Set(['capsule', 'women']));
  });
});

describe('runGate on the compliant fixture', () => {
  it('passes with zero failures', () => {
    const result = runGate(clean, pack, ctx);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

describe('C-series fail fixtures (exact checkId + field)', () => {
  it('C1 title over 200', () => {
    const l = mut((x) => { x.title = x.productName + ' y'.repeat(120); });
    expect(idsOf(l)).toContain('C1');
  });
  it('C2 six bullets / over-length bullet', () => {
    const six = mut((x) => { x.bullets.push('extra bullet'); });
    expect(idsOf(six)).toContain('C2');
    const long = mut((x) => { x.bullets[0] = 'A'.repeat(300); });
    const f = runGate(long, pack, ctx).failures.find((y) => y.checkId === 'C2');
    expect(f?.field).toBe('bullets[0]');
  });
  it('C3 backend over 249 UTF-8 BYTES (multibyte counted)', () => {
    const l = mut((x) => { x.backendSearchTerms = 'ä'.repeat(130); }); // 260 bytes, 130 chars
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C3');
    expect(f).toBeTruthy();
    expect(f?.context).toContain('260');
  });
  it('C4 description over 2000', () => {
    const l = mut((x) => { x.description = `${x.productName} ${'z '.repeat(1100)}${x.fdaDisclaimer}`; });
    expect(idsOf(l)).toContain('C4');
  });
  it('C5 wrong constant and missing in description', () => {
    const wrong = mut((x) => { x.fdaDisclaimer = 'Statements not evaluated by the FDA.'; });
    expect(idsOf(wrong)).toContain('C5');
    const missing = mut((x) => { x.description = x.description.replace(x.fdaDisclaimer, ''); });
    const f = runGate(missing, pack, ctx).failures.find((y) => y.checkId === 'C5');
    expect(f?.field).toBe('description');
  });
  it('C6 disease noun in a bullet (subcategory list)', () => {
    const l = mut((x) => { x.bullets[0] = 'GREAT FOR IBS: helps your ibs feel better*'; });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C6');
    expect(f?.field).toBe('bullets[0]');
  });
  it('C6 disease noun in a Q&A answer', () => {
    const l = mut((x) => {
      x.qa[0] = { q: 'Who is this for?', a: 'Anyone managing diabetes symptoms daily.', claimBearing: false };
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C6');
    expect(f?.field).toBe('qa[0].a');
  });
  it('C6 disease noun in imagePlan notes', () => {
    const l = mut((x) => {
      x.imagePlan[0] = { ...x.imagePlan[0]!, notes: 'Call out cancer support claim on overlay' };
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C6');
    expect(f?.field).toBe('imagePlan[0].notes');
  });
  it('C6 negation: "No disease language" in image notes is not a violation', () => {
    const l = mut((x) => {
      x.imagePlan[0] = { ...x.imagePlan[0]!, notes: 'Structure/function overlay only. No disease language, no guarantees.' };
    });
    expect(idsOf(l).filter((id) => id === 'C6')).toEqual([]);
  });
  it('C6 disease noun in an attribute value', () => {
    const l = mut((x) => {
      x.attributes.special_ingredients = 'Formulated for diabetes support';
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C6');
    expect(f?.field).toBe('attributes.special_ingredients');
  });
  it('C6 core noun in backend + treat/cure combo', () => {
    const l = mut((x) => { x.backendSearchTerms = 'remedio diabetes ayuda'; });
    expect(idsOf(l)).toContain('C6');
    const combo = mut((x) => { x.description = x.description.replace('Who it is for:', 'It can treat candida issues. Who it is for:'); });
    expect(idsOf(combo)).toContain('C6');
  });
  it('C6 negation guard: prohibiting a term is not a violation', () => {
    const l = mut((x) => { x.description = x.description.replace('Who it is for:', 'This product is not a treatment and makes no claims about diabetes. Who it is for:'); });
    expect(idsOf(l).filter((id) => id === 'C6')).toEqual([]);
  });
  it('C7 backend-only manufacturer leaking into a bullet', () => {
    const l = mut((x) => { x.bullets[1] = `Made by BrandX Labs LLC with care in the USA`; });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C7');
    expect(f?.field).toBe('bullets[1]');
  });
  it('C8 product name not leading the title', () => {
    const l = mut((x) => { x.title = `Probiotic Supplement by ${x.productName}`; });
    expect(idsOf(l)).toContain('C8');
  });
  it('C9 allergen present but not declared / "No Known Allergens"', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin; Rice Flour';
      x.attributes.allergen_information = 'No Known Allergens';
    });
    const ids = idsOf(l);
    expect(ids).toContain('C9');
    const fields = runGate(l, pack, ctx).failures.filter((y) => y.checkId === 'C9').map((y) => y.field);
    expect(fields).toContain('attributes.allergen_information');
    expect(fields).toContain('bullets');
    expect(fields).toContain('description');
  });
  it('C9 satisfied when canonical string + bullet + description declare it', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin; Rice Flour';
      x.attributes.allergen_information = 'Contains: Soy';
      x.bullets[3] = 'QUALITY YOU CAN VERIFY: Contains: Soy. Third-party tested, Non-GMO, made in a cGMP facility';
      x.description = x.description.replace('Quality and safety:', 'Contains: Soy. Quality and safety:');
    });
    expect(idsOf(l).filter((id) => id === 'C9')).toEqual([]);
  });
  it('C10 per-serving potency phrasing', () => {
    const l = mut((x) => { x.bullets[0] = 'POTENT: delivers 50 Billion CFU per serving for daily balance*'; });
    expect(idsOf(l)).toContain('C10');
  });
  it('C11 no-op when fictionPhrases empty; fires when populated', () => {
    const l = mut((x) => { x.description = x.description.replace('Who it is for:', 'Featuring the legendary moon-harvested enzyme. Who it is for:'); });
    expect(idsOf(l).filter((id) => id === 'C11')).toEqual([]);
    const packWithFiction: KnowledgePack = JSON.parse(JSON.stringify(pack));
    packWithFiction.compliancePack!.fictionPhrases = ['moon-harvested enzyme'];
    const r = runGate(l, packWithFiction, ctx);
    expect(r.failures.map((f) => f.checkId)).toContain('C11');
  });
  it('C12 potency conflict with facts', () => {
    const l = mut((x) => { x.bullets[0] = 'STRONG: a 90 Billion CFU blend supports daily balance*'; });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C12');
    expect(f?.field).toBe('bullets[0]');
  });
  it('C12 internal conflict (two potency figures in one surface)', () => {
    const l = mut((x) => { x.description = x.description.replace('a 50 Billion CFU, 10-strain', 'a 50 Billion CFU (also 80 Billion CFU), 10-strain'); });
    expect(idsOf(l)).toContain('C12');
  });
  it('C12 count that matches no canonical fact', () => {
    const l = mut((x) => { x.bullets[2] = 'SUPPLY: 90 capsules per bottle for your routine'; });
    expect(idsOf(l)).toContain('C12');
  });
  it('C15 title75 over 75 / wrong lead; highlights over 125', () => {
    const over = mut((x) => { x.title75 = `${x.productName} ${'k'.repeat(80)}`; });
    expect(idsOf(over)).toContain('C15');
    const lead = mut((x) => { x.title75 = `Probiotic ${x.productName}`; });
    expect(idsOf(lead)).toContain('C15');
    const hi = mut((x) => { x.itemHighlights = 'h'.repeat(130); });
    expect(idsOf(hi)).toContain('C15');
  });
  it('C16 backend repeating a title word', () => {
    const l = mut((x) => { x.backendSearchTerms += ' probiotic'; });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'C16');
    expect(f?.field).toBe('backendSearchTerms');
  });
});

describe('A-series fail fixtures', () => {
  it('A1 claim-bearing module missing disclaimer / wrong constant', () => {
    const l = mut((x) => {
      const m = x.aplusContent.modules.find((y) => y.claimBearing);
      m!.body = m!.body.replace(x.fdaDisclaimer, '');
    });
    expect(idsOf(l)).toContain('A1');
    const wrong = mut((x) => { x.aplusContent.fdaDisclaimer = 'nope'; });
    expect(idsOf(wrong)).toContain('A1');
  });
  it('A2 disease noun in comparison cell', () => {
    const l = mut((x) => { x.aplusContent.comparison.rows[0]!.ours = 'Helps with ibs unlike others'; });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'A2');
    expect(f?.field).toContain('comparison');
  });
  it('A3 backend-only brand in an A+ module', () => {
    const l = mut((x) => { x.aplusContent.modules[0]!.body += ' Crafted by BrandX Labs LLC.'; });
    expect(idsOf(l)).toContain('A3');
  });
  it('A4 product name missing from hero', () => {
    const l = mut((x) => {
      const hero = x.aplusContent.modules.find((m) => m.id.includes('hero'))!;
      hero.headline = 'Balance You Can Build On';
      hero.body = 'A blend to support digestive balance.' + (hero.claimBearing ? `\n\n${x.fdaDisclaimer}` : '');
    });
    expect(idsOf(l)).toContain('A4');
  });
  it('A5 per-serving phrasing in A+', () => {
    const l = mut((x) => { x.aplusContent.comparison.rows[0]!.ours = 'Provides 50 Billion CFU per serving'; });
    expect(idsOf(l)).toContain('A5');
  });
  it('A7 allergen missing from ingredients module', () => {
    const l = mut((x) => {
      x.attributes.ingredients = 'Probiotic Blend; Soy Lecithin';
      x.attributes.allergen_information = 'Contains: Soy';
      x.bullets[3] = 'NOTE: Contains: Soy — third-party tested and Non-GMO';
      x.description = x.description.replace('Quality and safety:', 'Contains: Soy. Quality and safety:');
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'A7');
    expect(f?.field).toContain('ingredients');
  });
  it('A6 fiction phrase in A+ module when pack populated', () => {
    const l = mut((x) => {
      x.aplusContent.modules[2]!.body = 'Featuring the moon-harvested enzyme for balance.';
    });
    expect(idsOf(l).filter((id) => id === 'A6')).toEqual([]);
    const packWithFiction: KnowledgePack = JSON.parse(JSON.stringify(pack));
    packWithFiction.compliancePack!.fictionPhrases = ['moon-harvested enzyme'];
    const f = runGate(l, packWithFiction, ctx).failures.find((y) => y.checkId === 'A6');
    expect(f?.field).toContain('aplus.modules');
  });
  it('A8 prohibited marketing (price, buy now, stars, guarantee)', () => {
    const l = mut((x) => {
      x.aplusContent.faq[0]!.a = 'Only $9.99 — buy now! Rated 5 stars in 2,000 reviews. Money-back guarantee. Hurry, today only.';
    });
    const labels = runGate(l, pack, ctx).failures.filter((y) => y.checkId === 'A8');
    expect(labels.length).toBeGreaterThanOrEqual(5);
  });
  it('A9 fails when comparison rows are below pack minimum', () => {
    const l = mut((x) => {
      x.aplusContent.comparison.rows = x.aplusContent.comparison.rows.slice(0, 1);
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'A9');
    expect(f?.field).toBe('aplus.comparison');
  });
  it('A9 fails when no who-it\'s-for cue is present', () => {
    const l = mut((x) => {
      x.aplusContent.modules = x.aplusContent.modules.map((m) =>
        m.id.includes('who')
          ? { ...m, id: 'audience', headline: 'Audience', body: 'Adults seeking daily balance support.' }
          : m,
      );
      x.aplusContent.faq = x.aplusContent.faq.map((f) =>
        /who/i.test(f.q) ? { ...f, q: 'What does it support?', a: f.a } : f,
      );
    });
    const f = runGate(l, pack, ctx).failures.find((y) => y.checkId === 'A9' && y.field === 'aplusContent');
    expect(f).toBeTruthy();
  });
  it('A9 passes on the compliant fixture', () => {
    expect(idsOf(clean).filter((id) => id === 'A9')).toEqual([]);
  });
});

describe('PACK fail-closed', () => {
  it('empty disease-noun list for detected subcategory → blocking PACK failure', () => {
    const emptyPack: KnowledgePack = JSON.parse(JSON.stringify(pack));
    emptyPack.compliancePack!.diseaseNounsBySubcategory = { probiotic: [] };
    const r = runGate(clean, emptyPack, { subcategories: ['probiotic'] });
    const f = r.failures.find((y) => y.checkId === 'PACK');
    expect(f?.field).toBe('compliance');
    expect(f?.fix).toContain('compliance pack incomplete');
    expect(r.pass).toBe(false);
  });
  it('no detected subcategory → fail closed', () => {
    const r = runGate(clean, pack, { subcategories: [] });
    expect(r.failures.some((y) => y.checkId === 'PACK')).toBe(true);
  });
  it('generic pack + supplement-smelling product → fail closed (bypass sealed)', () => {
    const generic = loadPack('generic');
    const r = runGate(clean, generic, { subcategories: [], snapshotText: snapshot.title });
    expect(r.failures.some((y) => y.checkId === 'PACK')).toBe(true);
  });
  it('generic pack + genuinely non-regulated product → no PACK failure', () => {
    const generic = loadPack('generic');
    const tongs = mut((x) => {
      x.title = 'SteelPro Kitchen Tongs 12-Inch Stainless';
      x.title75 = 'SteelPro Kitchen Tongs 12-Inch';
      x.productName = 'SteelPro Kitchen Tongs';
      x.description = 'SteelPro Kitchen Tongs are stainless utensils for daily cooking.';
      x.bullets = ['Sturdy build for daily flipping and serving tasks', 'b', 'c', 'd', 'e'];
      x.backendSearchTerms = 'pinzas cocina asador grill utensilio acero';
      x.itemHighlights = 'Locking design dishwasher safe utensil set piece';
      x.facts = {};
      x.attributes = {};
    });
    const r = runGate(tongs, generic, { subcategories: [], snapshotText: tongs.title });
    expect(r.failures.some((y) => y.checkId === 'PACK')).toBe(false);
  });
});

describe('composite negative fixture', () => {
  it('accumulates disease term + missing disclaimer + 6 bullets + over-byte backend + empty disease-noun list', () => {
    const emptyPack: KnowledgePack = JSON.parse(JSON.stringify(pack));
    emptyPack.compliancePack!.diseaseNounsBySubcategory = { probiotic: [] };
    const l = mut((x) => {
      x.bullets.push('SIXTH BULLET: helps with diabetes relief*');
      x.bullets[0] = 'GREAT FOR DIABETES: helps your diabetes feel better*';
      x.description = x.description.replace(x.fdaDisclaimer, '');
      x.backendSearchTerms = 'ä'.repeat(130);
    });
    const ids = runGate(l, emptyPack, { subcategories: ['probiotic'] }).failures.map((f) => f.checkId);
    expect(ids).toContain('PACK');
    expect(ids).toContain('C2');
    expect(ids).toContain('C3');
    expect(ids).toContain('C5');
    expect(ids).toContain('C6');
  });
});

describe('per-check pass on compliant fixture', () => {
  it('each C/A check returns zero failures on the clean listing', () => {
    const checks = [
      () => import('@/lib/gate/checks').then((m) => m.c1TitleLength(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c2Bullets(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c3BackendBytes(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c4DescriptionLength(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c5Disclaimer(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c6BannedTerms(clean, pack, ctx)),
      () => import('@/lib/gate/checks').then((m) => m.c7BrandLeakage(clean)),
      () => import('@/lib/gate/checks').then((m) => m.c8ProductNameLead(clean)),
      () => import('@/lib/gate/checks').then((m) => m.c9Allergen(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c10PotencyPhrasing(clean)),
      () => import('@/lib/gate/checks').then((m) => m.c11FictionPhrases(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c12FactConsistency(clean)),
      () => import('@/lib/gate/checks').then((m) => m.c15NewTitlePolicy(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.c16BackendDedup(clean)),
      () => import('@/lib/gate/checks').then((m) => m.a1AplusDisclaimer(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.a2AplusBannedTerms(clean, pack, ctx)),
      () => import('@/lib/gate/checks').then((m) => m.a3AplusBrandLeakage(clean)),
      () => import('@/lib/gate/checks').then((m) => m.a4AplusProductName(clean)),
      () => import('@/lib/gate/checks').then((m) => m.a5AplusPotencyPhrasing(clean)),
      () => import('@/lib/gate/checks').then((m) => m.a6AplusFictionPhrases(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.a7AplusAllergen(clean, pack)),
      () => import('@/lib/gate/checks').then((m) => m.a8AplusProhibitedMarketing(clean)),
      () => import('@/lib/gate/checks').then((m) => m.a9AplusComparisonAndAudience(clean, pack)),
    ];
    return Promise.all(checks.map((fn) => fn().then((f) => expect(f).toEqual([]))));
  });
});

describe('repair loop', () => {
  it('FIELD_TO_GROUP maps ownership correctly; PACK unrepairable', async () => {
    const { FIELD_TO_GROUP, fieldToGroup } = await import('@/lib/engine/repair');
    expect(FIELD_TO_GROUP.length).toBeGreaterThanOrEqual(7);
    expect(fieldToGroup({ checkId: 'C1', field: 'title', context: '', fix: '' })).toBe('title');
    expect(fieldToGroup({ checkId: 'C2', field: 'bullets[3]', context: '', fix: '' })).toBe('bullets');
    expect(fieldToGroup({ checkId: 'C3', field: 'backendSearchTerms', context: '', fix: '' })).toBe('backend');
    expect(fieldToGroup({ checkId: 'C9', field: 'attributes.allergen_information', context: '', fix: '' })).toBe('attributes');
    expect(fieldToGroup({ checkId: 'A1', field: 'aplus.modules[hero]', context: '', fix: '' })).toBe('aplus');
    expect(fieldToGroup({ checkId: 'PACK', field: 'compliance', context: '', fix: '' })).toBeNull();
  });

  it('deterministic backend sanitize clears over-byte C3 (generation policy, gate still re-runs)', async () => {
    // LLM always emits an over-byte backend; sanitize truncates to ≤249 UTF-8 bytes.
    const badBackendLlm: typeof mockLlm = async (req) => {
      const res = await mockLlm(req);
      if (req.user.includes('Backend search terms')) {
        return JSON.stringify({ backendSearchTerms: 'ä'.repeat(140) });
      }
      return res;
    };
    const outcome = await runRepairLoop(snapshot, pack, badBackendLlm, ctx, 2);
    expect(outcome.gateResult.failures.some((f) => f.checkId === 'C3')).toBe(false);
    expect(utf8Bytes(outcome.listing.backendSearchTerms)).toBeLessThanOrEqual(pack.rules.backendMaxBytes);
    expect(outcome.gateResult.pass).toBe(true);
  });

  it('regenerates only owning groups and terminates at the cap; persistent failure surfaced', async () => {
    // An LLM that ALWAYS produces an over-long title: unrepairable by regeneration within budget.
    const badTitleLlm: typeof mockLlm = async (req) => {
      const res = await mockLlm(req);
      if (req.user.includes('TASK: Generate the title group')) {
        const parsed = JSON.parse(res) as Record<string, unknown>;
        parsed.title = `BrandX ${'k'.repeat(220)}`;
        return JSON.stringify(parsed);
      }
      return res;
    };
    const calls: string[] = [];
    const counting: typeof mockLlm = async (req) => {
      calls.push(req.user.slice(0, 40));
      return badTitleLlm(req);
    };
    const outcome = await runRepairLoop(snapshot, pack, counting, ctx, 2);
    expect(outcome.gateResult.pass).toBe(false);
    expect(outcome.iterations).toBe(2);
    expect(outcome.gateResult.failures.some((f) => f.checkId === 'C1')).toBe(true);
    // initial full run = 8 calls; each repair round regenerates ONLY title (+retry inside generateGroup)
    expect(calls.length).toBeLessThanOrEqual(8 + 2 * 2);
  });

  it('PACK failure short-circuits before any repair round', async () => {
    let llmCalls = 0;
    const counting: typeof mockLlm = async (req) => { llmCalls++; return mockLlm(req); };
    const outcome = await runRepairLoop(snapshot, pack, counting, { subcategories: [] }, 3);
    expect(outcome.iterations).toBe(0);
    expect(llmCalls).toBe(8); // one full generation, zero repair rounds
    expect(outcome.gateResult.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('never mutates content to force a pass (repair regenerates; gate only reports)', async () => {
    const outcome = await runRepairLoop(snapshot, pack, mockLlm, ctx, 3);
    expect(outcome.gateResult.pass).toBe(true);
    expect(outcome.iterations).toBe(0); // clean fixture needs no repair
  });
});
