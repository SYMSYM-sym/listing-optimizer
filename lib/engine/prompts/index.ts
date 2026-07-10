import type { KnowledgePack, ListingSnapshot } from '@/lib/types';
import type { TitlePolicy } from '@/lib/env';
import { aplusPrompt } from './aplus';
import { attributesPrompt } from './attributes';
import { backendPrompt } from './backend';
import { bulletsPrompt } from './bullets';
import { descriptionPrompt } from './description';
import { imagesPrompt } from './images';
import { qaPrompt } from './qa';
import { buildSystemPrompt } from './system';
import { titlePrompt } from './title';

export { buildSystemPrompt };

/** Per-group prompt builders — rule-injected from the active pack. */
export function buildGroupPrompts(pack: KnowledgePack, titlePolicy: TitlePolicy = 'dual') {
  const hasCompliance = pack.compliancePack !== null;
  return {
    title: (s: ListingSnapshot) => titlePrompt(s, titlePolicy),
    bullets: (s: ListingSnapshot) => bulletsPrompt(s),
    description: (s: ListingSnapshot) => descriptionPrompt(s, hasCompliance),
    backend: (s: ListingSnapshot) => backendPrompt(s),
    attributes: (s: ListingSnapshot, schemaFields: string) =>
      attributesPrompt(s, schemaFields, hasCompliance),
    aplus: (s: ListingSnapshot) => aplusPrompt(s),
    images: (s: ListingSnapshot) => imagesPrompt(s, pack),
    qa: (s: ListingSnapshot) => qaPrompt(s),
  };
}
