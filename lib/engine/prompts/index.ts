import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import type { TitlePolicy } from '@/lib/env';
import type { TitleSurfaces } from '../backendSanitize';
import { aplusPrompt } from './aplus';
import { attributesPrompt } from './attributes';
import { backendPrompt } from './backend';
import { bulletsPrompt } from './bullets';
import { descriptionPrompt } from './description';
import { imagesPrompt } from './images';
import { qaPrompt } from './qa';
import { styleRulesBlock } from './shared';
import { buildSystemPrompt } from './system';
import { titlePrompt } from './title';

export { buildSystemPrompt };
export { prohibitedContentBlock, prohibitedMarketingBlock, styleRulesBlock } from './shared';

/** Per-group prompt builders — rule-injected from the active pack. */
export function buildGroupPrompts(pack: KnowledgePack, titlePolicy: TitlePolicy = 'dual') {
  const hasCompliance = pack.compliancePack !== null;
  // Category-specific prompt lines come off the pack — never from this module.
  const packRules = pack.compliancePack?.promptRules ?? {};
  // Style rules are rendered from PACK DATA and injected into every copy group
  // that gate C17 scans, so repair rounds can actually fix a style failure.
  const styleBlock = styleRulesBlock(pack.rules.style);
  // `canonicalProductName` is the identifier PHASE 1 resolved (see optimize.ts).
  // Every group that must EMBED or RESPECT it takes it as an optional argument;
  // omitting it renders no block at all, so nothing here depends on a name.
  return {
    // `pinnedProductName` is set on REPAIR regenerations only — see optimize.ts.
    title: (s: ListingSnapshot, pinnedProductName?: string) =>
      titlePrompt(s, titlePolicy, styleBlock, pinnedProductName ?? ''),
    bullets: (s: ListingSnapshot, canonicalProductName?: string) =>
      bulletsPrompt(s, styleBlock, packRules.bullets ?? [], canonicalProductName ?? ''),
    description: (s: ListingSnapshot, canonicalProductName?: string) =>
      descriptionPrompt(s, hasCompliance, styleBlock, packRules.description ?? [], canonicalProductName ?? ''),
    // Title surfaces (when known) feed C16 forbidden stems into the backend prompt.
    backend: (s: ListingSnapshot, surfaces?: TitleSurfaces) => backendPrompt(s, surfaces),
    attributes: (s: ListingSnapshot, schemaFields: string) =>
      attributesPrompt(s, schemaFields, packRules.attributes ?? []),
    aplus: (s: ListingSnapshot, canonicalProductName?: string) =>
      aplusPrompt(s, pack, styleBlock, canonicalProductName ?? ''),
    images: (s: ListingSnapshot) => imagesPrompt(s, pack),
    qa: (s: ListingSnapshot, canonicalProductName?: string) =>
      qaPrompt(s, packRules.qa ?? [], canonicalProductName ?? ''),
  };
}
