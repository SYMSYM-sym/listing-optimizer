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

export function loadPack(id: PackId): KnowledgePack {
  if (id === 'supplements') {
    return {
      id: 'supplements',
      rules,
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
      compliancePack: cosmeticsComplianceJson as CompliancePack,
      attributeSchema: cosmeticsAttributeSchemaJson as AttributeField[],
      principles,
      suspicionLexicon: [],
    };
  }
  return {
    id: 'generic',
    rules,
    compliancePack: null,
    attributeSchema: [],
    principles,
    suspicionLexicon: genericSuspicionLexicon,
  };
}
