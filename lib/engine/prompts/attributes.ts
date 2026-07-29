import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

/** `packRules` are the category's own attribute instructions (pack data). */
export function attributesPrompt(snapshot: ListingSnapshot, schemaFields: string, packRules: string[]): string {
  const complianceFields = packRules.length > 0
    ? packRules.map((line) => `- ${line}`).join('\n')
    : `- Fill only fields applicable to this product category.`;
  return `${snapshotBlock(snapshot)}

TASK: Fill the structured attribute set (underscore_case keys) using ONLY facts derivable from the current listing data. Schema (field | required | example):
${schemaFields}
- Fill every applicable field; prioritize filter-facet fields.
${complianceFields}
- "recommended_browse_nodes": suggest the tightest plausible node id from the category path (it is a suggestion for operator confirmation).
Return JSON: { "attributes": { field: value, ... } }`;
}
