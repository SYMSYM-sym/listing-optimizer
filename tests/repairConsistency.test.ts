import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { runRepairLoop } from '@/lib/engine/repair';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * REGRESSION: the repair loop used to oscillate because `productName` moved.
 *
 * Live evidence (3 consecutive production runs): `productName` is produced by
 * the TITLE group, but three checks require that same identifier on surfaces
 * owned by OTHER groups — C8 (starts `title`, appears in `description`),
 * C15 (starts `title75`) and A4 (appears in the A+ brand-story + hero modules).
 * When a C15 failure caused the loop to regenerate ONLY the title group, the
 * model returned a DIFFERENT, shorter product name, which instantly invalidated
 * the description and the A+ modules written in the previous round:
 *   it=1 groups=[title,aplus] [C1,A4,A9] → it=2 groups=[title] [C1] → [C8,A4,A4]
 *
 * The deterministic suite could never catch this: `mockLlm` returns the SAME
 * fixture for every call, so the name cannot move. The mock below is
 * purpose-built to reproduce the live behaviour — it renames on regeneration
 * exactly as the live model did, and it only stops when the prompt pins it.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const pack = loadPack('supplements');
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** What the first pass chose — long, and too long to lead a ≤75 title75 tail. */
const LONG_NAME = 'BrandX Health and Wellness Daily Probiotic';
/** What the live model silently switched to on regeneration. */
const SHORT_NAME = 'BrandX Daily Probiotic';

const TAIL =
  'Supplement 50 Billion CFU, 10 Strains with Prebiotic, 60 Vegan Capsules, Digestive Balance and Gut Support for Women, Men, Shelf Stable, Non-GMO, Gluten Free';
const HIGHLIGHTS =
  'Vegan gluten free gut support for women and men, shelf stable prebiotic blend, two month supply, non-GMO';

/** Round 1: correct name, but title75 is 93 chars → C15 fails. */
const TITLE_ROUND_1 = {
  productName: LONG_NAME,
  primaryKeyword: 'probiotic supplement',
  title: `${LONG_NAME} ${TAIL}`,
  title75: `${LONG_NAME} Supplement 50 Billion CFU, 10 Strains, 60 Capsules`,
  itemHighlights: HIGHLIGHTS,
};
/** The bug: regeneration renames the product to fit title75 into 75 chars. */
const TITLE_RENAMED = {
  ...TITLE_ROUND_1,
  productName: SHORT_NAME,
  title: `${SHORT_NAME} ${TAIL}`,
  title75: `${SHORT_NAME} Supplement 50 Billion CFU, 10 Strains`,
};
/** The fixed behaviour: keep the pinned name, cut the KEYWORD TAIL instead. */
const TITLE_PINNED_OK = {
  ...TITLE_ROUND_1,
  title75: `${LONG_NAME} 50 Billion CFU, 10 Strains`,
};

const isTitlePrompt = (user: string): boolean => user.includes('Generate the title group');
const isPinnedTo = (user: string, name: string): boolean =>
  user.includes(`PINNED product name: ${name}`);

/**
 * Non-title groups delegate to the compliant golden fixture, with the product
 * name swapped to LONG_NAME — i.e. the description and the A+ brand-story/hero
 * modules embed the name the FIRST pass chose, which is the whole point.
 */
async function otherGroups(req: Parameters<LlmClient>[0]): Promise<string> {
  return (await mockLlm(req)).split('BrandX Probiotic').join(LONG_NAME);
}

/** Simulates the live model: renames unless the prompt pins the name. */
function scenarioLlm(): LlmClient & { titleCalls: () => number } {
  let titleCalls = 0;
  const llm = (async (req) => {
    if (!isTitlePrompt(req.user)) return otherGroups(req);
    titleCalls++;
    if (titleCalls === 1) return JSON.stringify(TITLE_ROUND_1);
    // Regeneration: obey the pin if it is there, otherwise drift (the live bug).
    return JSON.stringify(isPinnedTo(req.user, LONG_NAME) ? TITLE_PINNED_OK : TITLE_RENAMED);
  }) as LlmClient & { titleCalls: () => number };
  llm.titleCalls = () => titleCalls;
  return llm;
}

/** Simulates a model that IGNORES the pin — used to prove the gate still bites. */
const stubbornLlm: LlmClient = async (req) =>
  isTitlePrompt(req.user) ? JSON.stringify(TITLE_RENAMED) : otherGroups(req);

describe('repair consistency: productName is pinned across regenerations', () => {
  it('the scenario reproduces the live starting point: exactly one C15 failure', async () => {
    const listing = await optimize(snapshot, pack, scenarioLlm());
    expect(listing.productName).toBe(LONG_NAME);
    expect(listing.title75.length).toBeGreaterThan(pack.rules.title75Max);
    const failures = runGate(listing, pack, ctx).failures;
    expect(failures.map((f) => f.checkId)).toEqual(['C15']);
  });

  it('WITHOUT the pin, a title-only rename breaks C8 + A4 (the oscillation)', async () => {
    // Pre-fix behaviour, constructed directly: body copy from round 1 (LONG_NAME
    // in the description and the A+ modules) merged with a renamed title group.
    const drifted = await optimize(snapshot, pack, stubbornLlm);
    expect(drifted.productName).toBe(SHORT_NAME);
    const ids = runGate(drifted, pack, ctx).failures.map((f) => `${f.checkId}:${f.field}`);
    // Exactly the live signature: `done verified:false [C8,A4,A4]`.
    expect(ids).toContain('C8:description');
    expect(ids.filter((i) => i.startsWith('A4:'))).toHaveLength(2);
  });

  it('the title prompt states the pin only on repair regenerations', () => {
    const prompts = buildGroupPrompts(pack);
    const firstPass = prompts.title(snapshot);
    const repair = prompts.title(snapshot, LONG_NAME);
    expect(firstPass).not.toContain('PINNED product name');
    expect(repair).toContain(`PINNED product name: ${LONG_NAME}`);
    expect(repair).toMatch(/Do not shorten, expand, re-order or rephrase it/);
    expect(repair).toMatch(/cut the KEYWORD TAIL, never the product name/);
  });

  it('optimize() pins base.productName into the title prompt on regeneration', async () => {
    const base = await optimize(snapshot, pack, scenarioLlm());
    const seen: string[] = [];
    const spy: LlmClient = async (req) => {
      if (isTitlePrompt(req.user)) seen.push(req.user);
      return isTitlePrompt(req.user) ? JSON.stringify(TITLE_PINNED_OK) : otherGroups(req);
    };
    await optimize(snapshot, pack, spy, { groups: ['title'], base });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`PINNED product name: ${LONG_NAME}`);
  });

  it('WITH the pin, runRepairLoop converges: zero failures, name unchanged', async () => {
    const llm = scenarioLlm();
    const { listing, gateResult, iterations } = await runRepairLoop(
      snapshot,
      pack,
      llm,
      ctx,
      3,
    );
    expect(gateResult.failures).toEqual([]);
    expect(gateResult.pass).toBe(true);
    expect(iterations).toBe(1);
    // The canonical identifier survived the regeneration...
    expect(listing.productName).toBe(LONG_NAME);
    // ...and the surfaces other groups own still carry it (C8 + A4 hold).
    expect(listing.description).toContain(LONG_NAME);
    const modules = listing.aplusContent.modules;
    expect(modules.find((m) => m.id.includes('brand'))?.body).toContain(LONG_NAME);
    expect(modules.find((m) => m.id.includes('hero'))?.headline).toContain(LONG_NAME);
    // ...and the title surfaces genuinely lead with it — not patched, generated.
    expect(listing.title.startsWith(LONG_NAME)).toBe(true);
    expect(listing.title75.startsWith(LONG_NAME)).toBe(true);
    expect(listing.title75.length).toBeLessThanOrEqual(pack.rules.title75Max);
  });

  it('runPipeline reaches verified:true on the scenario that used to oscillate', async () => {
    const result = await runPipeline(snapshot, scenarioLlm(), 3);
    expect(result.audit.verified).toBe(true);
    expect(result.audit.gateResult.failures).toEqual([]);
    expect(result.optimized.state).toBe('verified');
    expect(result.optimized.productName).toBe(LONG_NAME);
  });

  it('a model that ignores the pin is OVERRIDDEN in code and logged', async () => {
    const base = await optimize(snapshot, pack, scenarioLlm());
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let merged;
    let lines: string[];
    try {
      merged = await optimize(snapshot, pack, stubbornLlm, { groups: ['title'], base });
      // Read the calls BEFORE restoring — mockRestore() also clears them.
      lines = info.mock.calls.map((c) => String(c[0]));
    } finally {
      info.mockRestore();
    }
    const events = lines
      .filter((line) => line.includes('repair.product_name_pinned'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      pinnedLength: LONG_NAME.length,
      regeneratedLength: SHORT_NAME.length,
    });
    // The canonical identifier wins...
    expect(merged.productName).toBe(LONG_NAME);
  });

  it('the pin is NOT gate laundering: overriding the name does not buy a pass', async () => {
    // A model that ignores the pin gets its productName restored — but its
    // titles still lead with the OLD name, so the gate rejects the listing.
    // Nothing but the canonical identifier is ever rewritten.
    const base = await optimize(snapshot, pack, scenarioLlm());
    const merged = await optimize(snapshot, pack, stubbornLlm, { groups: ['title'], base });
    expect(merged.productName).toBe(LONG_NAME);
    // Generated copy is untouched: the title group's own words survive verbatim.
    expect(merged.title).toBe(TITLE_RENAMED.title);
    expect(merged.title75).toBe(TITLE_RENAMED.title75);
    const ids = runGate(merged, pack, ctx).failures.map((f) => `${f.checkId}:${f.field}`);
    expect(ids).toContain('C8:title');
    expect(ids).toContain('C15:title75');
  });

  it('the loop-level guard holds the first-pass name even across rounds', async () => {
    // runRepairLoop re-asserts its own canonical value after every round, so a
    // stubborn model can never drift the identifier — it just stays unverified.
    const { listing, gateResult } = await runRepairLoop(snapshot, pack, stubbornLlm, ctx, 3);
    expect(listing.productName).toBe(SHORT_NAME); // first pass owns the choice
    expect(gateResult.pass).toBe(false);
  });
});
