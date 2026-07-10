import type { ListingSnapshot } from '@/lib/types';
import { snapshotBlock } from './shared';

export function attributesPrompt(snapshot: ListingSnapshot, schemaFields: string, hasCompliance: boolean): string {
  const complianceFields = hasCompliance
    ? `- "active_ingredients" must be a subset of "ingredients" (actives only; full label list in ingredients).
- "allergen_information": exact canonical string if an allergen is present, else "Free from major allergens per label" ONLY if the label says so, else omit.
- "legal_disclaimer_description": write the literal string "[SYSTEM_DISCLAIMER]" — the system replaces it.`
    : `- Fill only fields applicable to this product category.`;
  return `${snapshotBlock(snapshot)}

TASK: Fill the structured attribute set (underscore_case keys) using ONLY facts derivable from the current listing data. Schema (field | required | example):
${schemaFields}
- Fill every applicable field; prioritize filter-facet fields.
${complianceFields}
- "recommended_browse_nodes": suggest the tightest plausible node id from the category path (it is a suggestion for operator confirmation).
Return JSON: { "attributes": { field: value, ... } }`;
}
