import 'server-only';

import type {
  AttributeField,
  CompliancePack,
  KnowledgePack,
  Principle,
  RuleSet,
} from '@/lib/types';
import rulesJson from '@/knowledge/rules.json';
import complianceJson from '@/knowledge/compliance.supplements.json';
import attributeSchemaJson from '@/knowledge/attribute-schema.supplements.json';
import cosmeticsComplianceJson from '@/knowledge/compliance.cosmetics.json';
import cosmeticsAttributeSchemaJson from '@/knowledge/attribute-schema.cosmetics.json';
import principlesJson from '@/knowledge/principles.json';
import suspicionGenericJson from '@/knowledge/suspicion.generic.json';

/**
 * Assembles KnowledgePacks from compiled knowledge/*.json (brain/ is the
 * source of truth; the numbers here are asserted against brain/ in tests).
 * All category-specific data lives in packs — never in engine/gate code.
 */

export type PackId = 'supplements' | 'cosmetics' | 'generic';

const rules: RuleSet = rulesJson as unknown as RuleSet;
const principles: Principle[] = principlesJson as Principle[];
const genericSuspicionLexicon: string[] = suspicionGenericJson.suspicionLexicon;

/**
 * EVERY compliance module in the project, assembled HERE (pack data), so
 * `lib/gate` can union the disease/drug lexicons without naming a category.
 *
 * A drug claim is illegal whatever the product is. Attaching this only to the
 * generic pack meant the cosmetics pack — whose own lexicon has no `cancer`,
 * `diabetes`, `arthritis` or `hypertension` — returned `pass:true, verified:true`
 * for a bullet reading "Cures cancer and reverses diabetes in eight weeks".
 * Every pack now carries the same cross-check set.
 */
const ALL_COMPLIANCE_PACKS: CompliancePack[] = [
  complianceJson as CompliancePack,
  cosmeticsComplianceJson as CompliancePack,
];

export function loadPack(id: PackId): KnowledgePack {
  if (id === 'supplements') {
    return {
      id: 'supplements',
      rules,
      crossCheckCompliancePacks: ALL_COMPLIANCE_PACKS,
      requiresCompliance: true,
      compliancePack: complianceJson as CompliancePack,
      attributeSchema: attributeSchemaJson as AttributeField[],
      principles,
      suspicionLexicon: [],
    };
  }
  if (id === 'cosmetics') {
    return {
      id: 'cosmetics',
      rules,
      crossCheckCompliancePacks: ALL_COMPLIANCE_PACKS,
      requiresCompliance: true,
      compliancePack: cosmeticsComplianceJson as CompliancePack,
      attributeSchema: cosmeticsAttributeSchemaJson as AttributeField[],
      principles,
      suspicionLexicon: [],
    };
  }
  return {
    id: 'generic',
    // The generic pack is the ONLY pack that may legitimately ship without a
    // compliance module. Two independent backstops guard it: the suspicion
    // lexicon (vocabulary heuristic) and the regulated packs' disease/drug
    // lexicons (`crossCheckCompliancePacks`), which make a generic-routed
    // listing that names a disease fail CLOSED.
    crossCheckCompliancePacks: ALL_COMPLIANCE_PACKS,
    requiresCompliance: false,
    rules,
    compliancePack: null,
    attributeSchema: [],
    principles,
    suspicionLexicon: genericSuspicionLexicon,
  };
}
