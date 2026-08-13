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
- Fill EVERY schema field listed above — all of them, never a subset. A missing field is lost discovery surface and is deterministically checked.
- When a field genuinely does not apply to this product, still return it with the explicit none-style value its schema example shows (the example column above states it) — never omit the field and never leave it blank.
- Prioritize accuracy on filter-facet fields; they power customer-facing filters.
${complianceFields}
- "recommended_browse_nodes": suggest the tightest plausible node id from the category path (it is a suggestion for operator confirmation).
Return JSON: { "attributes": { field: value, ... } }`;
}
