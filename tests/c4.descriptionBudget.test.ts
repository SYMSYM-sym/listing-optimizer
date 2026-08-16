import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@/lib/engine/llm';
import { optimize } from '@/lib/engine/optimize';
import { buildGroupPrompts, buildSystemPrompt } from '@/lib/engine/prompts';
import {
  DISCLAIMER_APPEND_SEPARATOR,
  c4DescriptionLength,
  descriptionBudget,
} from '@/lib/gate/checks/c-length';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { ListingSnapshot } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * C4 — THE DESCRIPTION BUDGET, AND WHY A REPAIR ROUND USED TO BE UNWINNABLE
 * ===========================================================================
 *
 * A live production run of ASIN B00EEEITVA ended `verified:false` on a SINGLE
 * C4 failure (one of six runs in the batch; the other five verified clean, and
 * the same ASIN verified on its other run). C4 routes correctly — `description`
 * has owned a row in `FIELD_TO_GROUP` since the table existed — so the loop DID
 * regenerate the right group, every round, and still did not converge.
 *
 * The cause was arithmetic, not routing. C4 measures the ASSEMBLED description,
 * which is the model's text PLUS the verbatim disclaimer `optimize()` appends
 * afterwards. Three places stated the budget and all three stated it wrong or
 * differently:
 *
 *   system prompt        "Description ≤2000 chars (leave ~250 chars headroom)"
 *   description prompt   "≤1700 chars"                (a hand-copied constant)
 *   C4's own fix line    "Shorten description to ≤2000 chars"
 *
 * The fix line is the one the repair loop feeds back verbatim
 * (`lib/engine/repair.ts` builds `[C4] description: <context> → FIX: <fix>`),
 * so it is the most specific and most recent instruction the model sees — and
 * a model that does exactly what it says writes 2000 characters, the engine
 * appends 158 more, and the next gate run reports the same failure. Obeying the
 * repair instruction REPRODUCED the defect. That is what the last three tests
 * below measure, in both directions.
 *
 * C4 IS NOT WEAKENED. Its trigger is byte-identical: empty, or assembled length
 * over `rules.descriptionMax`. Only the number it TELLS the model changed, and
 * every number now comes from one derived place (`descriptionBudget`).
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;

const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

/** Empty, so the prompt assertions read OUR text and never the source listing. */
const EMPTY_SNAPSHOT: ListingSnapshot = {
  asin: '', url: '', title: '', bullets: [], description: '', images: [],
  attributes: {}, category: '', subcategory: [], raw: null,
};

/**
 * `mockLlm` with the description group overridden to write EXACTLY `chars`
 * characters. Every other group is untouched, so the assembled listing is the
 * golden one with one surface resized — which is what makes the C4 result
 * attributable.
 */
const writes = (chars: number): LlmClient => (req) =>
  req.user.includes('Write the product description')
    ? Promise.resolve(JSON.stringify({ description: 'a'.repeat(chars) }))
    : mockLlm(req);

const c4Of = (l: Awaited<ReturnType<typeof optimize>>, pack: ReturnType<typeof loadPack>) =>
  c4DescriptionLength(l, pack);

describe.each(PACK_IDS)('C4 description budget — %s', (packId) => {
  const pack = loadPack(packId);
  const db = descriptionBudget(pack);
  const disclaimer = pack.compliancePack?.disclaimer ?? '';

  it('the budget is `descriptionMax` minus EXACTLY what the engine appends', () => {
    expect(db.max).toBe(pack.rules.descriptionMax);
    expect(db.reserve).toBe(DISCLAIMER_APPEND_SEPARATOR.length + disclaimer.length);
    expect(db.reserve).toBeGreaterThan(0);
    expect(db.budget + db.reserve).toBe(db.max);
  });

  it('a description written TO the budget survives the append and passes C4', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget));
    expect(listing.description.endsWith(disclaimer)).toBe(true);
    // The reserve is not an estimate: the assembled field lands exactly on the cap.
    expect(listing.description.length).toBe(db.max);
    expect(c4Of(listing, pack)).toEqual([]);
  });

  it('ONE character over the budget still fails C4 (the check is not weakened)', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget + 1));
    expect(listing.description.length).toBe(db.max + 1);
    const failures = c4Of(listing, pack);
    expect(failures.map((f) => f.checkId)).toEqual(['C4']);
  });

  it('the failure REPORTS both halves, so the number names text the model wrote', async () => {
    const listing = await optimize(snapshot, pack, writes(db.budget + 200));
    const failure = c4Of(listing, pack)[0]!;
    expect(failure.context).toContain(`${db.budget + 200} written`);
    expect(failure.context).toContain(`${db.reserve} appended`);
  });

  // -------------------------------------------------------------------------
  // THE CONVERGENCE PROPERTY — the point of the whole change
  // -------------------------------------------------------------------------

  it('OBEYING the C4 repair line converges in one round', async () => {
    const over = await optimize(snapshot, pack, writes(db.budget + 200));
    const failure = c4Of(over, pack)[0]!;
    // Exactly the string the repair loop pastes into the regeneration prompt.
    const repairLine = `[${failure.checkId}] ${failure.field}: ${failure.context} → FIX: ${failure.fix}`;
    const target = Number(/≤(\d+) chars/.exec(repairLine)?.[1]);
    expect(Number.isFinite(target), repairLine).toBe(true);

    const obedient = await optimize(snapshot, pack, writes(target));
    expect(c4Of(obedient, pack), `a model that writes ${target} chars must now pass`).toEqual([]);
  });

  it('the PRE-FIX repair line did NOT converge — aiming at descriptionMax still fails', async () => {
    // This is the live B00EEEITVA shape: the old fix said "Shorten description
    // to ≤2000 chars", the model complied, and C4 fired again on 2158.
    const obedientToTheOldLine = await optimize(snapshot, pack, writes(db.max));
    const failures = c4Of(obedientToTheOldLine, pack);
    expect(failures.map((f) => f.checkId)).toEqual(['C4']);
    expect(obedientToTheOldLine.description.length).toBe(db.max + db.reserve);
  });

  // -------------------------------------------------------------------------
  // THE PROMPTS AND THE GATE STATE THE SAME NUMBER
  // -------------------------------------------------------------------------

  it('every prompt that states the limit states the DERIVED budget, and no stale constant', () => {
    const system = buildSystemPrompt(pack, {}, []);
    const description = buildGroupPrompts(pack).description(EMPTY_SNAPSHOT);
    for (const [name, text] of [['system', system], ['description', description]] as const) {
      expect(text, `${name} must state the budget the model controls`).toContain(String(db.budget));
      expect(text, `${name} must state what is appended`).toContain(String(db.reserve));
    }
    // The two hand-copied constants this change deleted.
    for (const stale of ['1700', '~250 chars headroom']) {
      expect(`${system}\n${description}`, `stale constant '${stale}'`).not.toContain(stale);
    }
  });
});
