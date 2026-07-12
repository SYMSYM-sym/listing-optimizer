import 'server-only';
import { env } from '@/lib/env';
import type {
  AplusContent,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { sanitizeBackendSearchTerms } from './backendSanitize';
import { sanitizeBullets } from './bulletSanitize';
import { buildFacts } from './facts';
import { generateGroup, type LlmClient } from './llm';
import { buildGroupPrompts, buildSystemPrompt } from './prompts';
import {
  aplusGroupSchema,
  attributesGroupSchema,
  backendGroupSchema,
  bulletsGroupSchema,
  descriptionGroupSchema,
  imagesGroupSchema,
  qaGroupSchema,
  titleGroupSchema,
} from './schemas';

/** Groups the repair loop can regenerate independently. */
export type GroupName =
  | 'title'
  | 'bullets'
  | 'description'
  | 'backend'
  | 'attributes'
  | 'aplus'
  | 'images'
  | 'qa';

export const ALL_GROUPS: GroupName[] = [
  'title',
  'bullets',
  'description',
  'backend',
  'attributes',
  'aplus',
  'images',
  'qa',
];

/**
 * Deterministic disclaimer assembly (generation policy, NOT gate laundering):
 * the verbatim constant is code-inserted where the contract requires it;
 * the LLM never writes it. The gate independently verifies afterwards.
 */
function appendDisclaimer(text: string, disclaimer: string): string {
  return text.includes(disclaimer) ? text : `${text.trimEnd()}\n\n${disclaimer}`;
}

export interface OptimizeOptions {
  /** Regenerate only these groups, merging over `base` (repair loop). */
  groups?: GroupName[];
  base?: OptimizedListing;
  /** Failure context per group, injected into regeneration prompts. */
  failureContext?: Partial<Record<GroupName, string>>;
}

export async function optimize(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  llm: LlmClient,
  opts: OptimizeOptions = {},
): Promise<OptimizedListing> {
  const facts = buildFacts(snapshot, pack.compliancePack?.factUnits ?? []);
  const system = buildSystemPrompt(pack, facts);
  const groupPrompts = buildGroupPrompts(pack, env.titlePolicy());
  const disclaimer = pack.compliancePack?.disclaimer ?? '';
  const groups = opts.groups ?? ALL_GROUPS;
  const run = <T>(g: GroupName, fn: () => Promise<T>, fallback: T | undefined): Promise<T> => {
    if (!groups.includes(g) && fallback !== undefined) return Promise.resolve(fallback);
    return fn();
  };
  const withCtx = (g: GroupName, prompt: string): string => {
    const ctx = opts.failureContext?.[g];
    return ctx
      ? `${prompt}\n\nPREVIOUS ATTEMPT FAILED THESE DETERMINISTIC CHECKS — fix them without weakening the copy:\n${ctx}`
      : prompt;
  };

  const schemaFields = pack.attributeSchema
    .map((f) => `${f.field} | ${f.required ? 'required' : 'optional'} | ${f.example}`)
    .join('\n');

  const base = opts.base;

  // Title runs first so backend generation knows the optimized title-surface
  // stems (C16). Remaining groups still fan out in parallel.
  const title = await run(
    'title',
    () =>
      generateGroup(
        llm,
        'title',
        system,
        withCtx('title', groupPrompts.title(snapshot)),
        titleGroupSchema,
        1000,
      ),
    base && {
      productName: base.productName,
      primaryKeyword: base.primaryKeyword,
      title: base.title,
      title75: base.title75,
      itemHighlights: base.itemHighlights,
    },
  );

  const titleSurfaces = {
    title: title.title,
    title75: title.title75,
    itemHighlights: title.itemHighlights,
  };

  const [bullets, description, backend, attributes, aplus, images, qa] =
    await Promise.all([
      run('bullets', () => generateGroup(llm, 'bullets', system, withCtx('bullets', groupPrompts.bullets(snapshot)), bulletsGroupSchema, 2000),
        base && { bullets: base.bullets.map((text, i) => ({ text, useCaseAnchor: base.bulletAnchors?.[i] ?? '', claimBearing: text.trimEnd().endsWith('*') })) }),
      run('description', () => generateGroup(llm, 'description', system, withCtx('description', groupPrompts.description(snapshot)), descriptionGroupSchema, 2000),
        base && { description: stripDisclaimer(base.description, disclaimer) }),
      run('backend', () => generateGroup(llm, 'backend', system, withCtx('backend', groupPrompts.backend(snapshot, titleSurfaces)), backendGroupSchema, 600),
        base && { backendSearchTerms: base.backendSearchTerms }),
      run('attributes', () => generateGroup(llm, 'attributes', system, withCtx('attributes', groupPrompts.attributes(snapshot, schemaFields)), attributesGroupSchema, 3000),
        base && { attributes: base.attributes }),
      run('aplus', () => generateGroup(llm, 'aplus', system, withCtx('aplus', groupPrompts.aplus(snapshot)), aplusGroupSchema, 6000),
        base && { modules: base.aplusContent.modules.map((m) => ({ ...m, body: stripDisclaimer(m.body, disclaimer) })), comparison: base.aplusContent.comparison, faq: base.aplusContent.faq.map((f) => ({ ...f, a: stripDisclaimer(f.a, disclaimer) })) }),
      run('images', () => generateGroup(llm, 'images', system, withCtx('images', groupPrompts.images(snapshot)), imagesGroupSchema, 2500),
        base && { imagePlan: base.imagePlan }),
      run('qa', () => generateGroup(llm, 'qa', system, withCtx('qa', groupPrompts.qa(snapshot)), qaGroupSchema, 3500),
        base && { qa: base.qa.map((f) => ({ ...f, a: stripDisclaimer(f.a, disclaimer) })) }),
    ]);

  // --- deterministic assembly ---
  const finalDescription = disclaimer
    ? appendDisclaimer(description.description, disclaimer)
    : description.description;

  const finalAttributes = { ...attributes.attributes };
  if (disclaimer) {
    finalAttributes.legal_disclaimer_description = disclaimer; // replaces [SYSTEM_DISCLAIMER]
  } else {
    delete finalAttributes.legal_disclaimer_description;
  }

  const aplusContent: AplusContent = {
    fdaDisclaimer: disclaimer,
    modules: aplus.modules.map((m) => ({
      ...m,
      body: m.claimBearing && disclaimer ? appendDisclaimer(m.body, disclaimer) : m.body,
    })),
    comparison: aplus.comparison,
    faq: aplus.faq.map((f) => ({
      ...f,
      a: f.claimBearing && disclaimer ? appendDisclaimer(f.a, disclaimer) : f.a,
    })),
  };

  return {
    title: title.title,
    title75: title.title75,
    itemHighlights: title.itemHighlights,
    bullets: sanitizeBullets(
      bullets.bullets.map((b) => b.text),
      pack.rules.bulletMax,
    ),
    bulletAnchors: bullets.bullets.map((b) => b.useCaseAnchor),
    description: finalDescription,
    // Deterministic C3/C16 cleanup after LLM (gate still re-validates).
    backendSearchTerms: sanitizeBackendSearchTerms(
      backend.backendSearchTerms,
      titleSurfaces,
      pack.rules.backendMaxBytes,
    ),
    attributes: finalAttributes,
    facts,
    fdaDisclaimer: disclaimer,
    aplusContent,
    imagePlan: images.imagePlan,
    qa: qa.qa.map((f) => ({
      ...f,
      a: f.claimBearing && disclaimer ? appendDisclaimer(f.a, disclaimer) : f.a,
    })),
    primaryKeyword: title.primaryKeyword,
    productName: title.productName,
    state: 'draft',
  };
}

function stripDisclaimer(text: string, disclaimer: string): string {
  if (!disclaimer) return text;
  return text.split(disclaimer).join('').trimEnd();
}
