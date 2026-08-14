import { describe, expect, it } from 'vitest';
import { buildGroupPrompts } from '@/lib/engine/prompts';
import { optimize } from '@/lib/engine/optimize';
import {
  crossPackActionPairedNouns,
  crossPackDiseaseNouns,
  diseaseActionVerbs,
  reachableCompliancePacks,
} from '@/lib/gate/checks/pack';
import { termRegex } from '@/lib/gate/util';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * PROMPT HYGIENE — an instruction must never forbid a term BY NAMING IT.
 *
 * A real production run on an ordinary probiotic listing came back
 * `verified:false` with `[C6] imagePlan[3].notes … Remove banned term
 * 'disease'`: the generated image brief read "…avoid disease words or clinical
 * claims…". The gate was right — an image brief is customer-adjacent copy and
 * is scanned exactly like a bullet — but the text it flagged was OUR OWN
 * compliance instruction, echoed back by the model. Self-referential, and to an
 * operator it simply looks broken.
 *
 * The fix is never to GENERATE the offending text (C6/C19 are untouched and the
 * image plan is still fully scanned). This file makes the class structurally
 * impossible to regress:
 *
 *  1. every PER-GROUP task instruction is scanned for the vocabulary the gate
 *     bans, so a prompt that names a banned term fails CI;
 *  2. the image plan produced by `optimize()` is scanned for the same
 *     vocabulary, so a brief that carries one fails CI.
 *
 * DELIBERATE EXCEPTIONS, and why they are not scanned here:
 *  - the SYSTEM prompt (`buildSystemPrompt`) must enumerate the full enforced
 *    lexicon — `tests/redteam3.gate.test.ts` asserts the injected noun set is a
 *    SUPERSET of the gate-enforced set, and `tests/redteam4.gate.test.ts` does
 *    the same for the C18/C19 labels. A generator that is not shown the lexicon
 *    is failed on a rule it was never told;
 *  - the STYLE block (`styleRulesBlock`, injected ahead of `TASK:` in several
 *    groups) lists `rules.style.titleTermBans` for the same reason.
 *  Both are enumerations of DATA, not sentences of the form "avoid <banned
 *  word>", and neither sits inside the task instruction a brief paraphrases.
 */

const PACK_IDS = ['supplements', 'cosmetics'] as const;

/** An empty emitted-surface view for the WS3 keyword prompt (see below). */
const EMPTY_SURFACES = {
  title: '',
  title75: '',
  itemHighlights: '',
  bullets: [] as string[],
  description: '',
  backendSearchTerms: '',
  attributes: {} as Record<string, string>,
};

const snapshot: ListingSnapshot = toSnapshot(
  mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample),
);

/**
 * The bare THERAPEUTIC-VERB union (diseaseVerbs + every inflection of
 * diseaseActionVerbRoots, cross-pack) a TASK INSTRUCTION must never name.
 *
 * The live-run regression this closes: the images prompt used to instruct
 * "describe what each ingredient is, not what it treats" — and the model
 * echoed "treats" into a customer-adjacent brief, which the gate then rightly
 * flagged. A verb the instruction names only to forbid still lands in the
 * output, exactly like the noun class above. The same exclusions apply: the
 * SYSTEM prompt and the style block must enumerate the enforced rules and are
 * not scanned (see the header note), but nothing after `TASK:` may carry a
 * bare therapeutic verb.
 *
 * Bare verbs are NOT added to the generated-output scan: a lone verb in copy
 * is not a violation (the gate only fails a verb paired with a noun/state),
 * so scanning output for them would fail lawful structure/function copy.
 */
function verbHits(pack: KnowledgePack, text: string): string[] {
  const hits = new Set<string>();
  for (const cp of reachableCompliancePacks(pack)) {
    for (const verb of diseaseActionVerbs(cp)) {
      if (verb.trim() && termRegex(verb).test(text)) hits.add(`therapeutic verb '${verb}'`);
    }
  }
  return [...hits];
}

/** The banned vocabulary a generated surface is measured against. */
function bannedHits(pack: KnowledgePack, text: string): string[] {
  const hits: string[] = [];
  const cp = pack.compliancePack;
  for (const noun of [...crossPackDiseaseNouns(pack), ...crossPackActionPairedNouns(pack)]) {
    if (noun.trim() && termRegex(noun).test(text)) hits.push(`disease noun '${noun}'`);
  }
  for (const term of cp?.superlativeBans ?? []) {
    if (term.trim() && termRegex(term).test(text)) hits.push(`superlative ban '${term}'`);
  }
  for (const [source, label] of pack.rules.prohibitedMarketing?.patterns ?? []) {
    const m = source ? new RegExp(source, 'i').exec(text) : null;
    if (m) hits.push(`prohibited marketing (${label}): '${m[0]}'`);
  }
  for (const [source, label] of pack.rules.prohibitedContent?.patterns ?? []) {
    const m = source ? new RegExp(source, 'i').exec(text) : null;
    if (m) hits.push(`prohibited content (${label}): '${m[0]}'`);
  }
  return hits;
}

/**
 * The instruction half of a group prompt: everything AFTER `TASK:`.
 *
 * What precedes it is the SOURCE listing (`snapshotBlock` — the operator's own
 * copy, which we do not author) and, in some groups, the style block. The task
 * instruction is the part the model paraphrases into its output.
 */
const taskInstruction = (prompt: string): string => prompt.split('TASK:').slice(1).join('TASK:');

describe.each(PACK_IDS)('prompt hygiene — %s group prompts name no banned term', (packId) => {
  const pack = loadPack(packId);
  const g = buildGroupPrompts(pack);
  const prompts: [string, string][] = [
    ['title', g.title(snapshot)],
    ['bullets', g.bullets(snapshot)],
    ['description', g.description(snapshot)],
    ['backend', g.backend(snapshot)],
    ['attributes', g.attributes(snapshot, 'field | required | example')],
    ['aplus', g.aplus(snapshot)],
    ['images', g.images(snapshot)],
    ['qa', g.qa(snapshot)],
    // WS3 — the keyword prompt is scanned like every other task instruction.
    // It is handed an EMPTY surface view on purpose: the finished copy it
    // normally embeds is the listing's own (already gate-scanned) text, and
    // what this suite is about is the INSTRUCTION we author.
    ['keywords', g.keywords(snapshot, EMPTY_SURFACES)],
  ];

  it.each(prompts)('the %s task instruction carries no banned vocabulary', (_group, prompt) => {
    const instruction = taskInstruction(prompt);
    expect(instruction.length).toBeGreaterThan(0);
    expect(bannedHits(pack, instruction)).toEqual([]);
  });

  it.each(prompts)('the %s task instruction names no bare therapeutic verb', (_group, prompt) => {
    const instruction = taskInstruction(prompt);
    expect(instruction.length).toBeGreaterThan(0);
    expect(verbHits(pack, instruction)).toEqual([]);
  });
});

describe('prompt hygiene — the generated image plan carries no banned vocabulary', () => {
  it.each(PACK_IDS)('%s: imagePlan purpose/spec/notes are clean', async (packId) => {
    const pack = loadPack(packId);
    const listing = await optimize(snapshot, pack, mockLlm);
    expect(listing.imagePlan.length).toBeGreaterThanOrEqual(8);
    const offenders: string[] = [];
    // WS8: ALT text and the video brief are customer-facing too, and the ALT
    // string is the one an operator never looks at again.
    for (const [i, text] of (listing.videoBrief?.onScreenText ?? []).entries()) {
      for (const hit of bannedHits(pack, text)) offenders.push(`videoBrief.onScreenText[${i}]: ${hit}`);
    }
    for (const [i, text] of (listing.videoBrief?.shots ?? []).entries()) {
      for (const hit of bannedHits(pack, text)) offenders.push(`videoBrief.shots[${i}]: ${hit}`);
    }
    listing.imagePlan.forEach((slot, i) => {
      for (const key of ['purpose', 'spec', 'notes', 'altText'] as const) {
        const text = String(slot?.[key] ?? '');
        for (const hit of bannedHits(pack, text)) {
          offenders.push(`imagePlan[${i}].${key}: ${hit} — ${text}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  /**
   * The guard has to be able to FAIL: the exact brief the live run produced is
   * rejected by the same scan, so this file is not a tautology.
   */
  /**
   * The verb guard has to be able to FAIL too: the exact instruction the
   * forensic run traced the echoed "treats" back to is rejected by the same
   * scan, so the verb tier is not a tautology either.
   */
  it('the instruction that provoked the echoed verb ("not what it treats") IS caught', () => {
    const pack = loadPack('supplements');
    const hits = verbHits(pack, 'describe what each ingredient is, not what it treats');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.join(' ')).toContain('treat');
  });

  it('the live-run brief that started this ("avoid disease words") IS caught', () => {
    const pack = loadPack('supplements');
    const hits = bannedHits(
      pack,
      'Show brand history in neutral factual terms, avoid disease words or clinical claims',
    );
    expect(hits.some((h) => h.includes("disease noun 'disease'"))).toBe(true);
  });
});
