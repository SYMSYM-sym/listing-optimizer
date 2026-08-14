import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/regenerate/route';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { optimize } from '@/lib/engine/optimize';
import { buyerLanguageBlock } from '@/lib/engine/prompts';
import { mineReviewLanguage } from '@/lib/knowledge/reviewLanguage';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';
import type { OptimizedListing } from '@/lib/types';

const snapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);
const pack = loadPack('supplements');

/** Real-shaped review text: some of it lawful to mirror, some of it not. */
const REVIEWS = [
  'I keep it in my travel bag and the routine never slips on a work trip.',
  'It cured my irritable bowel syndrome in two weeks.',
  'One capsule with breakfast and I am done for the day.',
  'No refrigeration needed which is the whole reason I switched.',
  'Best seller for a reason, an absolute miracle.',
].join('\n');

vi.mock('@/lib/server/guard', () => ({
  checkAccess: vi.fn(() => null),
}));

vi.mock('@/lib/engine/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engine/llm')>();
  return {
    ...actual,
    anthropicClient: vi.fn(),
  };
});

vi.mock('@/lib/store/runs', () => ({
  updateRun: vi.fn(),
}));

// Use the real optimize with mockLlm by stubbing anthropicClient to return mockLlm
import { anthropicClient } from '@/lib/engine/llm';
import { updateRun } from '@/lib/store/runs';
import { checkAccess } from '@/lib/server/guard';

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/regenerate', () => {
  let base: OptimizedListing;

  beforeEach(async () => {
    vi.mocked(anthropicClient).mockReturnValue(mockLlm as never);
    base = await optimize(snapshot, pack, mockLlm);
    // Mutate one group so we can prove regenerate only touches that group
    base = {
      ...base,
      backendSearchTerms: 'KEEP_THIS_BACKEND_MARKER_XYZ',
      title75: 'OLD_TITLE75_SHOULD_CHANGE',
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the access guard', async () => {
    vi.mocked(checkAccess).mockReturnValueOnce(
      Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) as never,
    );
    const res = await post({ snapshot, listing: base, group: 'title' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid group', async () => {
    const res = await post({ snapshot, listing: base, group: 'not-a-group' });
    expect(res.status).toBe(400);
    const e = await res.json();
    expect(e.code).toBe('BAD_REQUEST');
  });

  it('regenerates only the requested group over the base and re-audits', async () => {
    const res = await post({ snapshot, listing: base, group: 'title' });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Backend (other group) preserved from base
    expect(data.optimized.backendSearchTerms).toBe('KEEP_THIS_BACKEND_MARKER_XYZ');
    // Title group refreshed from mock LLM (not the OLD marker)
    expect(data.optimized.title75).not.toBe('OLD_TITLE75_SHOULD_CHANGE');
    expect(data.optimized.title75.length).toBeGreaterThan(0);
    // Audit always re-run
    expect(data.audit).toBeDefined();
    expect(typeof data.audit.verified).toBe('boolean');
    expect(data.audit.verified).toBe(data.audit.gateResult.pass);
    expect(data.group).toBe('title');
    expect(data.detection.packId).toBe('supplements');
  });

  // =========================================================================
  // G4 — THE OPERATOR'S REVIEW LANGUAGE SURVIVES A PER-GROUP REGENERATION
  // =========================================================================
  //
  // THE DEFECT. This route carried `fictionPhrases` and `panelFacts` and DROPPED
  // the WS9 review text. A regenerated group is written from scratch, so the one
  // group the operator asked to redo came back written WITHOUT the buyer-language
  // mirroring every other group had been written with — a listing that half
  // speaks the operator's buyers' language, with nothing anywhere saying so.
  //
  // BOTH DIRECTIONS. Present: the prompt changes exactly the way optimize's does
  // (the BUYER LANGUAGE block, carrying the mined phrasing and nothing the
  // compliance filter rejected). Absent: byte-identical to the pre-fix build.
  describe('WS9 review text (G4)', () => {
    /** Records every prompt the route hands the model. */
    function recordingLlm(): { prompts: string[]; llm: typeof mockLlm } {
      const prompts: string[] = [];
      const llm = (async (req: Parameters<typeof mockLlm>[0]) => {
        prompts.push(req.user);
        return mockLlm(req);
      }) as typeof mockLlm;
      return { prompts, llm };
    }

    async function promptsFor(body: Record<string, unknown>): Promise<string[]> {
      const { prompts, llm } = recordingLlm();
      vi.mocked(anthropicClient).mockReturnValue(llm as never);
      const res = await post({ snapshot, listing: base, group: 'bullets', ...body });
      expect(res.status).toBe(200);
      return prompts;
    }

    it('PRESENT: the regenerated group is shown the mined buyer language', async () => {
      const mined = mineReviewLanguage(pack, REVIEWS);
      expect(mined.phrases.length).toBeGreaterThan(0);
      const prompts = await promptsFor({ reviewsText: REVIEWS });
      const joined = prompts.join('\n');
      expect(joined).toContain('BUYER LANGUAGE');
      expect(joined).toContain(mined.phrases[0]!);
      expect(joined).toContain('Mirror the WORDING, never the claim');
    });

    it('PRESENT: the same block the OPTIMIZE path renders, not a second dialect', async () => {
      const mined = mineReviewLanguage(pack, REVIEWS);
      const block = buyerLanguageBlock(mined.phrases);
      expect(block.trim()).not.toBe('');
      const prompts = await promptsFor({ reviewsText: REVIEWS });
      expect(prompts.some((p) => p.includes(block.trim()))).toBe(true);
    });

    it('PRESENT: a fragment the compliance filter REJECTED never reaches the prompt', async () => {
      const mined = mineReviewLanguage(pack, REVIEWS);
      expect(mined.rejected.length).toBeGreaterThan(0);
      const joined = (await promptsFor({ reviewsText: REVIEWS })).join('\n');
      for (const r of mined.rejected) expect(joined).not.toContain(r.fragment);
    });

    it('ABSENT: the prompts are byte-identical to the pre-fix build', async () => {
      const withoutKey = await promptsFor({});
      const explicitlyEmpty = await promptsFor({ reviewsText: '   \n  ' });
      expect(withoutKey.join('\n')).not.toContain('BUYER LANGUAGE');
      // Emptiness is not presence: whitespace must not flip the input on.
      expect(explicitlyEmpty).toEqual(withoutKey);
    });

    it('the AUDIT is given the same evidence, so P11 is scored rather than left unknown', async () => {
      const { llm } = recordingLlm();
      vi.mocked(anthropicClient).mockReturnValue(llm as never);
      const withText = await (
        await post({ snapshot, listing: base, group: 'bullets', reviewsText: REVIEWS })
      ).json();
      const without = await (
        await post({ snapshot, listing: base, group: 'bullets' })
      ).json();
      const p11 = (r: { audit: { scorecard: { perPrinciple: { id: string; score: string }[] } } }) =>
        r.audit.scorecard.perPrinciple.find((p) => p.id === 'P11')!.score;
      expect(p11(without)).toBe('unknown');
      expect(p11(withText)).not.toBe('unknown');
    });
  });

  it('persists via updateRun when runId is supplied', async () => {
    const res = await post({
      snapshot,
      listing: base,
      group: 'description',
      runId: 'run-123',
    });
    expect(res.status).toBe(200);
    expect(updateRun).toHaveBeenCalledWith(
      'run-123',
      expect.objectContaining({
        optimized: expect.any(Object),
        audit: expect.any(Object),
        verified: expect.any(Boolean),
        score: expect.any(Number),
      }),
    );
  });
});
