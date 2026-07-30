import type { AllergenRule, CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import {
  aplusFactSurfaces,
  attributeComplianceSurfaces,
  customerSurfaces,
  fail,
  factConsistencyOver,
  fictionOver,
  potencyPhrasingOver,
} from './shared';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which attribute holds the label/ingredient list, which one holds the canonical
 * declaration, and what a declaration sounds like — ALL pack data
 * (`compliancePack.allergenFields`). The gate names no attribute key itself.
 */
function allergenFields(cp: CompliancePack) {
  return cp.allergenFields;
}

/** Allergens present = any declaration rule whose source pattern matches the label list. */
export function presentAllergens(l: OptimizedListing, cp: CompliancePack) {
  const f = allergenFields(cp);
  const attrs = l.attributes ?? {};
  const labelText = normalize(
    `${attrs[f.labelList] ?? ''} ${attrs[f.declaration] ?? ''}`,
  ).toLowerCase();
  return (cp.allergenRules ?? []).filter((r) =>
    new RegExp(`\\b(?:${r.source})\\b`, 'i').test(labelText),
  );
}

/** Order-independent matcher: the pack's declaration verb + class-or-source tokens co-occur. */
export function allergenMentioned(text: string, rule: AllergenRule, cp: CompliancePack): boolean {
  const t = normalize(text).toLowerCase();
  const classRe = new RegExp(`\\b${escapeRe(rule.class.toLowerCase())}\\b`, 'i');
  const sourceRe = new RegExp(`\\b(?:${rule.source})\\b`, 'i');
  const verbRe = new RegExp(escapeRe(allergenFields(cp).declarationVerb.toLowerCase()), 'i');
  return verbRe.test(t) && (classRe.test(t) || sourceRe.test(t));
}

export function c9Allergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const f = allergenFields(cp);
  const declarationField = `attributes.${f.declaration}`;
  const out: Failure[] = [];
  const attrs = l.attributes ?? {};
  const all = `${l.title ?? ''} ${l.description ?? ''} ${(l.bullets ?? []).map((b) => b ?? '').join(' ')} ${Object.values(attrs).join(' ')}`;
  const present = presentAllergens(l, cp);
  if (present.length === 0) return [];
  const normalizedAll = normalize(all).toLowerCase();
  for (const phrase of cp.noAllergenPhrases ?? []) {
    if (!phrase.trim()) continue;
    if (normalizedAll.includes(phrase.trim().toLowerCase())) {
      out.push(fail('C9', declarationField, `"${phrase}" used`, `Never use "${phrase}" when a declarable allergen is present`));
    }
  }
  for (const rule of present) {
    if (attrs[f.declaration] !== rule.canonicalString) {
      out.push(fail('C9', declarationField, attrs[f.declaration] ?? '(empty)', `${f.declaration} must equal exactly '${rule.canonicalString}'`));
    }
    if (!(l.bullets ?? []).some((b) => allergenMentioned(b ?? '', rule, cp))) {
      out.push(fail('C9', 'bullets', `no bullet declares ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in at least one bullet`));
    }
    if (!allergenMentioned(l.description ?? '', rule, cp)) {
      out.push(fail('C9', 'description', `description does not declare ${rule.class}`, `Declare the allergen ('${rule.canonicalString}') in the description`));
    }
  }
  return out;
}

export function c10PotencyPhrasing(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return potencyPhrasingOver(customerSurfaces(l), pack.rules.units, 'C10');
}

export function c11FictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return [];
  return fictionOver(customerSurfaces(l), cp, 'C11');
}

/**
 * C12 — every unit-anchored figure must agree with the canonical facts, on
 * EVERY first-person surface: customer copy, A+ content and attribute values.
 * The scan stays unit-anchored, so bare numbers ("10 strains", "3774321") are
 * ignored; only figures carrying a pack unit are measured.
 */
export function c12FactConsistency(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const surfaces = [
    ...customerSurfaces(l),
    ...aplusFactSurfaces(l.aplusContent),
    ...attributeComplianceSurfaces(l),
  ];
  return factConsistencyOver(surfaces, l, pack.rules.units, 'C12');
}
