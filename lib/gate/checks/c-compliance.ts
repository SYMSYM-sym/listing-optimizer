import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import { activeDiseaseNouns } from './pack';
import { customerSurfaces, fail, scanSurfacesForBanned } from './shared';
import type { GateContext } from './types';

export function c5Disclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const out: Failure[] = [];
  if (normalize(l.fdaDisclaimer) !== normalize(cp.disclaimer)) {
    out.push(fail('C5', 'fdaDisclaimer', l.fdaDisclaimer.slice(0, 80), 'fdaDisclaimer must equal the canonical constant verbatim'));
  }
  if (!normalize(l.description).includes(normalize(cp.disclaimer))) {
    out.push(fail('C5', 'description', 'disclaimer missing', 'The exact verbatim disclaimer must appear inside the description'));
  }
  return out;
}

export function c6BannedTerms(
  l: OptimizedListing,
  pack: KnowledgePack,
  ctx: GateContext,
): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const nouns = activeDiseaseNouns(cp, ctx.subcategories);
  return scanSurfacesForBanned(customerSurfaces(l), cp, nouns, 'C6');
}

export function c7BrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const productName = normalize(l.productName).toLowerCase();
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = l.attributes[key];
    if (!value) continue;
    const brand = normalize(value).toLowerCase();
    if (!brand || productName.includes(brand)) continue;
    for (const [field, text] of customerSurfaces(l)) {
      if (normalize(text).toLowerCase().includes(brand)) {
        out.push(fail('C7', field, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from customer copy`));
      }
    }
    for (const [attr, av] of Object.entries(l.attributes)) {
      if (attr === 'brand_name' || attr === 'manufacturer') continue;
      if (normalize(av).toLowerCase().includes(brand)) {
        out.push(fail('C7', `attributes.${attr}`, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from this attribute`));
      }
    }
  }
  return out;
}

export function c8ProductNameLead(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName);
  if (!normalize(l.title).startsWith(name)) {
    out.push(fail('C8', 'title', l.title.slice(0, 60), 'The customer product name must START the title'));
  }
  if (!normalize(l.description).includes(name)) {
    out.push(fail('C8', 'description', 'product name missing', 'The product name must appear in the description'));
  }
  return out;
}
