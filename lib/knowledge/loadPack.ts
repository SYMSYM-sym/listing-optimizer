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
import principlesJson from '@/knowledge/principles.json';

/**
 * Assembles KnowledgePacks from compiled knowledge/*.json (brain/ is the
 * source of truth; the numbers here are asserted against brain/ in tests).
 * All category-specific data lives in packs — never in engine/gate code.
 */

export type PackId = 'supplements' | 'generic';

const rules: RuleSet = rulesJson as RuleSet;
const principles: Principle[] = principlesJson as Principle[];

/**
 * Supplement-smell terms for the generic pack: if a pack has NO compliance
 * module but the snapshot matches this lexicon, the gate fails closed (PACK).
 * Shipped as data so the gate stays category-agnostic.
 */
const GENERIC_SUSPICION_LEXICON = [
  'supplement',
  'supplements',
  'dietary supplement',
  'vitamin',
  'vitamins',
  'capsule',
  'capsules',
  'gummy',
  'gummies',
  'softgel',
  'softgels',
  'probiotic',
  'cfu',
  'mg ',
  'mcg',
  'supplement facts',
  'serving size',
  'servings per container',
  'proprietary blend',
];

export function loadPack(id: PackId): KnowledgePack {
  if (id === 'supplements') {
    const compliancePack = complianceJson as CompliancePack;
    return {
      id: 'supplements',
      rules,
      compliancePack,
      attributeSchema: attributeSchemaJson as AttributeField[],
      principles,
      suspicionLexicon: [], // supplements pack HAS a compliance module; lexicon not needed
    };
  }
  return {
    id: 'generic',
    rules,
    compliancePack: null,
    attributeSchema: [],
    principles,
    suspicionLexicon: GENERIC_SUSPICION_LEXICON,
  };
}
