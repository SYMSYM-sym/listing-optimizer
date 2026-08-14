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
- EVERY value is a JSON string, including the ones whose example is a bare figure: write the digits inside quotes ("60"), never as a bare number, and never as a list or a nested object.
- Fill EVERY schema field listed above — all of them, never a subset. A missing field is lost discovery surface and is deterministically checked.
- When a field genuinely does not apply to this product, still return it with the explicit none-style value its schema example shows (the example column above states it) — never omit the field and never leave it blank.
- Prioritize accuracy on filter-facet fields; they power customer-facing filters.
- The schema above is DELIBERATELY INCOMPLETE. Fields whose value is owned by the seller account (identifiers, offer terms) are withheld because you cannot know them; their absence is intentional, not an oversight. Return ONLY the keys listed above — never add a key you were not shown, and never guess a value for one.
${complianceFields}
- "recommended_browse_nodes": suggest the tightest plausible node id from the category path (it is a suggestion for operator confirmation).
Return JSON: { "attributes": { field: value, ... } }`;
}
