import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import { customerSurfaces, fail, factConsistencyOver, fictionOver, potencyPhrasingOver } from './shared';

/** Allergens present = any allergenRule whose source pattern matches the ingredients. */
export function presentAllergens(l: OptimizedListing, cp: CompliancePack) {
  const ingredients = normalize(
    `${l.attributes.ingredients ?? ''} ${l.attributes.allergen_information ?? ''}`,
  ).toLowerCase();
  return cp.allergenRules.filter((r) =>
    new RegExp(`\\b(?:${r.source})\\b`, 'i').test(ingredients),
  );
}

/** Order-independent matcher: 'contains' + class-or-source tokens co-occur. */
export function allergenMentioned(text: string, rule: { class: string; source: string }): boolean {
  const t = normalize(text).toLowerCase();
  const classRe = new RegExp(`\\b${rule.class.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const sourceRe = new RegExp(`\\b(?:${rule.source})\\b`, 'i');
  return /contains/.test(t) && (classRe.test(t) || sourceRe.test(t));
}

export function c9Allergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const out: Failure[] = [];
  const all = `${l.title} ${l.description} ${l.bullets.join(' ')} ${Object.values(l.attributes).join(' ')}`;
  const present = presentAllergens(l, cp);
  if (present.length === 0) return [];
  if (/no known allergens/i.test(all)) {
    out.push(fail('C9', 'attributes.allergen_information', '"No Known Allergens" used', 'Never use "No Known Allergens" when a declarable allergen is present'));
  }
  for (const rule of present) {
    if (l.attributes.allergen_information !== rule.canonicalString) {
      out.push(fail('C9', 'attributes.allergen_information', l.attributes.allergen_information ?? '(empty)', `allergen_information must equal exactly '${rule.canonicalString}'`));
    }
    if (!l.bullets.some((b) => allergenMentioned(b, rule))) {
      out.push(fail('C9', 'bullets', `no bullet declares ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in at least one bullet`));
    }
    if (!allergenMentioned(l.description, rule)) {
      out.push(fail('C9', 'description', `description does not declare ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in the description`));
    }
  }
  return out;
}

export function c10PotencyPhrasing(l: OptimizedListing): Failure[] {
  return potencyPhrasingOver(customerSurfaces(l), 'C10');
}

export function c11FictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return [];
  return fictionOver(customerSurfaces(l), cp, 'C11');
}

export function c12FactConsistency(l: OptimizedListing): Failure[] {
  return factConsistencyOver(customerSurfaces(l), l, 'C12');
}
