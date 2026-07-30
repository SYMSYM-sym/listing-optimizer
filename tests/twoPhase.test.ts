import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { ALL_GROUPS, optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { runPipeline } from '@/lib/pipeline/run';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * REGRESSION: two-phase generation — the groups that must EMBED the product
 * name are now generated AFTER it is known.
 *
 * Live evidence (4 consecutive production runs). `productName` is invented by
 * the TITLE group, but three deterministic checks demand that exact identifier
 * on surfaces owned by OTHER groups: C8 (starts `title`, APPEARS in
 * `description`), C15 (starts `title75`) and A4 (appears in the A+ brand-story
 * AND hero modules). Because `description` and `aplus` were generated in the
 * SAME parallel fan-out as `title`, they could not possibly know which name the
 * title group was choosing — they satisfied C8/A4 only by luck, whenever the
 * model happened to echo the SOURCE listing's name. Pinning the name across
 * repair rounds (the previous fix) stopped it oscillating but created no
 * knowledge, so the failure simply moved: the latest run ended
 * `verified:false [C8, A4, A4, A9]` after two repair rounds, with `description`
 * and `aplus` regenerated and STILL nameless.
 *
 * The deterministic suite could never catch this, because `mockLlm` returns one
 * fixture whose description and A+ modules already contain the very name its
 * title response returns — the luck case, permanently. The mock below is
 * purpose-built to reproduce the live behaviour instead:
 *
 *  - the title group invents a name that appears NOWHERE in the source listing;
 *  - the description/A+ groups emit that name ONLY if the prompt states it, and
 *    otherwise fall back to the source listing's name — exactly like a model
 *    that is being asked to write about a product it has not been named.
 */

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const pack = loadPack('supplements');
const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

/** The name the golden fixture (and the source listing) uses. */
const SOURCE_NAME = 'BrandX Probiotic';
/**
 * The name the title group invents. Same length as SOURCE_NAME so every golden
 * surface stays inside its byte/char caps after substitution — the ONLY variable
 * under test is whether a group knows the name, never whether copy still fits.
 */
const INVENTED_NAME = 'BrandX Gut Renew';

const isTitlePrompt = (user: string): boolean => user.includes('Generate the title group');
const isDescriptionPrompt = (user: string): boolean => user.includes('Write the product description');
const isAplusPrompt = (user: string): boolean => user.includes('A+ content');

/** What a group can learn from its prompt — nothing more. */
const canonicalNameIn = (user: string): string | null =>
  /CANONICAL product name: "([^"]+)"/.exec(user)?.[1] ?? null;

const withName = (json: string, name: string): string => json.split(SOURCE_NAME).join(name);

/**
 * The live model, mocked.
 *
 * TITLE always renames to INVENTED_NAME (the case the old fan-out could not
 * survive). Every other group returns the compliant golden copy, which names
 * the SOURCE product — UNLESS its prompt states the canonical name, in which
 * case it writes that instead. No group is ever handed the name out of band.
 */
function twoPhaseAwareLlm(): LlmClient & { calls: () => string[] } {
  const calls: string[] = [];
  const llm = (async (req) => {
    const user = req.user;
    calls.push(isTitlePrompt(user) ? 'title' : isDescriptionPrompt(user) ? 'description' : isAplusPrompt(user) ? 'aplus' : 'other');
    const golden = await mockLlm(req);
    if (isTitlePrompt(user)) return withName(golden, INVENTED_NAME);
    const told = canonicalNameIn(user);
    return told ? withName(golden, told) : golden;
  }) as LlmClient & { calls: () => string[] };
  llm.calls = () => calls;
  return llm;
}

/**
 * The PRE-FIX arrangement, constructed directly: identical to the mock above
 * except the body groups never read the canonical name, i.e. they are generated
 * with no knowledge of what the title group chose. Proves the assertions below
 * are not vacuous.
 */
const nameBlindLlm: LlmClient = async (req) => {
  const golden = await mockLlm(req);
  return isTitlePrompt(req.user) ? withName(golden, INVENTED_NAME) : golden;
};

describe('two-phase generation: the canonical product name is known before it is embedded', () => {
  it('the invented name appears NOWHERE in the source listing (the mock is honest)', () => {
    const source = `${snapshot.title} ${snapshot.bullets.join(' ')} ${snapshot.description}`;
    expect(source).toContain(SOURCE_NAME);
    expect(source).not.toContain(INVENTED_NAME);
  });

  it('a FIRST-PASS description prompt and A+ prompt both state the canonical name', async () => {
    // This is the thing that was impossible before: on a first pass there is no
    // `base`, so the only way these prompts can carry the name is if the title
    // group has already run.
    const seen: Record<string, string> = {};
    const spy: LlmClient = async (req) => {
      if (isDescriptionPrompt(req.user)) seen.description = req.user;
      if (isAplusPrompt(req.user)) seen.aplus = req.user;
      const golden = await mockLlm(req);
      return isTitlePrompt(req.user) ? withName(golden, INVENTED_NAME) : golden;
    };
    await optimize(snapshot, pack, spy);
    expect(seen.description).toContain(`CANONICAL product name: "${INVENTED_NAME}"`);
    expect(seen.aplus).toContain(`CANONICAL product name: "${INVENTED_NAME}"`);
    // …and it says what the checks actually require of each surface.
    expect(seen.description).toMatch(/description MUST contain that exact string/);
    expect(seen.aplus).toContain(pack.rules.aplusModuleCues.brandStory);
    expect(seen.aplus).toContain(pack.rules.aplusModuleCues.hero);
  });

  it('with the name injected, a first pass already satisfies C8 + A4', async () => {
    const listing = await optimize(snapshot, pack, twoPhaseAwareLlm());
    expect(listing.productName).toBe(INVENTED_NAME);
    expect(listing.title.startsWith(INVENTED_NAME)).toBe(true);
    expect(listing.title75.startsWith(INVENTED_NAME)).toBe(true);
    expect(listing.description).toContain(INVENTED_NAME);
    const modules = listing.aplusContent.modules;
    const cues = pack.rules.aplusModuleCues;
    expect(modules.find((m) => m.id.includes(cues.brandStory))?.body).toContain(INVENTED_NAME);
    expect(modules.find((m) => m.id.includes(cues.hero))?.headline).toContain(INVENTED_NAME);
    expect(runGate(listing, pack, ctx).failures).toEqual([]);
  });

  it('runPipeline reaches verified:true with ZERO failures on the live scenario', async () => {
    const result = await runPipeline(snapshot, twoPhaseAwareLlm(), 3);
    expect(result.audit.gateResult.failures).toEqual([]);
    expect(result.audit.verified).toBe(true);
    expect(result.optimized.state).toBe('verified');
    expect(result.optimized.productName).toBe(INVENTED_NAME);
    // Converged on the FIRST pass — no repair round was needed at all.
    expect(result.iterations).toBe(0);
  });

  it('NON-VACUOUS: generating description/aplus without the name reproduces [C8, A4, A4]', async () => {
    const blind = await optimize(snapshot, pack, nameBlindLlm);
    expect(blind.productName).toBe(INVENTED_NAME);
    // The body copy names the SOURCE product, because nothing told it otherwise.
    expect(blind.description).toContain(SOURCE_NAME);
    expect(blind.description).not.toContain(INVENTED_NAME);
    const ids = runGate(blind, pack, ctx).failures.map((f) => `${f.checkId}:${f.field}`);
    // Exactly the live signature: the TITLE surfaces are fine, the embedded
    // surfaces are not.
    expect(ids).toContain('C8:description');
    expect(ids).not.toContain('C8:title');
    expect(ids.filter((i) => i.startsWith('A4:'))).toHaveLength(2);
  });

  it('and that pre-fix arrangement cannot be repaired into a pass either', async () => {
    // The repair loop regenerates description+aplus — but a name-blind generator
    // gets the same prompt back and writes the same nameless copy, which is
    // precisely why the live run ended unverified after two rounds.
    const result = await runPipeline(snapshot, nameBlindLlm, 2);
    expect(result.audit.verified).toBe(false);
    const ids = result.audit.gateResult.failures.map((f) => f.checkId);
    expect(ids).toContain('C8');
    expect(ids).toContain('A4');
  });
});

describe('two-phase generation: call budget and opts.groups', () => {
  it('a full first pass costs exactly 8 calls — 1 phase-1 + 7 phase-2, no duplicate title', async () => {
    const llm = twoPhaseAwareLlm();
    await optimize(snapshot, pack, llm);
    const calls = llm.calls();
    expect(calls).toHaveLength(ALL_GROUPS.length);
    expect(calls).toHaveLength(8);
    expect(calls.filter((c) => c === 'title')).toHaveLength(1);
    expect(calls.filter((c) => c === 'description')).toHaveLength(1);
    expect(calls.filter((c) => c === 'aplus')).toHaveLength(1);
    // Phase 1 is first; the other seven are the parallel fan-out behind it.
    expect(calls[0]).toBe('title');
  });

  it('phase 1 is SKIPPED when title is not being regenerated — no extra LLM call', async () => {
    const base = await optimize(snapshot, pack, twoPhaseAwareLlm());
    const llm = twoPhaseAwareLlm();
    await optimize(snapshot, pack, llm, { groups: ['description', 'aplus'], base });
    const calls = llm.calls();
    // Exactly the two requested groups. The name came off `base`, not the model.
    expect(calls.sort()).toEqual(['aplus', 'description']);
    expect(calls).not.toContain('title');
  });

  it('a title-only repair costs exactly ONE call and still pins the base name', async () => {
    const base = await optimize(snapshot, pack, twoPhaseAwareLlm());
    const llm = twoPhaseAwareLlm();
    const merged = await optimize(snapshot, pack, llm, { groups: ['title'], base });
    expect(llm.calls()).toEqual(['title']);
    expect(merged.productName).toBe(base.productName);
  });

  it('a repair that regenerates description/aplus is told the PINNED name', async () => {
    const base = await optimize(snapshot, pack, twoPhaseAwareLlm());
    const seen: Record<string, string> = {};
    const spy: LlmClient = async (req) => {
      if (isDescriptionPrompt(req.user)) seen.description = req.user;
      if (isAplusPrompt(req.user)) seen.aplus = req.user;
      const told = canonicalNameIn(req.user);
      const golden = await mockLlm(req);
      return told ? withName(golden, told) : golden;
    };
    await optimize(snapshot, pack, spy, { groups: ['description', 'aplus'], base });
    expect(seen.description).toContain(`CANONICAL product name: "${INVENTED_NAME}"`);
    expect(seen.aplus).toContain(`CANONICAL product name: "${INVENTED_NAME}"`);
  });
});

describe.each(['supplements', 'cosmetics'] as const)(
  'A+ prompt requirements rendered from pack data — %s',
  (packId) => {
    const p = loadPack(packId);
    const prompts = buildGroupPrompts(p);

    it("A9: the A+ prompt demands a who-it's-for statement using the cues the gate scans", () => {
      const aplus = prompts.aplus(snapshot);
      expect(p.rules.whoItsForCues.length).toBeGreaterThan(0);
      for (const cue of p.rules.whoItsForCues) {
        expect(aplus).toContain(`"${cue}"`);
      }
      expect(aplus).toMatch(/AUDIENCE \(deterministically checked\)/);
      // …and the comparison row floor is read off the pack too, not hard-coded.
      expect(aplus).toContain(`≥${p.rules.aplusComparisonMinRows}`);
    });

    it('no canonical-name block is rendered when no name is known yet', () => {
      for (const prompt of [
        prompts.description(snapshot),
        prompts.aplus(snapshot),
        prompts.bullets(snapshot),
        prompts.qa(snapshot),
      ]) {
        expect(prompt).not.toContain('CANONICAL product name');
      }
    });

    it('every embedding group carries the name once it IS known', () => {
      const name = 'Acme Example Name';
      for (const prompt of [
        prompts.description(snapshot, name),
        prompts.aplus(snapshot, name),
        prompts.bullets(snapshot, name),
        prompts.qa(snapshot, name),
      ]) {
        expect(prompt).toContain(`CANONICAL product name: "${name}"`);
      }
    });
  },
);
