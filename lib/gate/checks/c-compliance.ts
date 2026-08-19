import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import { crossPackActionPairedNouns, crossPackDiseaseNouns } from './pack';
import {
  attributeComplianceSurfaces,
  customerSurfaces,
  factsComplianceSurfaces,
  fail,
  scanSurfacesForBanned,
} from './shared';

export function c5Disclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const out: Failure[] = [];
  if (normalize(l.fdaDisclaimer ?? '') !== normalize(cp.disclaimer)) {
    out.push(fail('C5', 'fdaDisclaimer', normalize(l.fdaDisclaimer ?? '').slice(0, 80), 'fdaDisclaimer must equal the canonical constant verbatim'));
  }
  if (!normalize(l.description ?? '').includes(normalize(cp.disclaimer))) {
    out.push(fail('C5', 'description', 'disclaimer missing', 'The exact verbatim disclaimer must appear inside the description'));
  }
  return out;
}

/**
 * C6 — banned disease terms on every customer surface.
 *
 * The scanned lexicon is the CROSS-PACK union — every compliance module the pack
 * assembler attached, not just the routed pack's own list. A drug claim is
 * illegal whatever the product is, and scoping the scan to the routed pack meant
 * a listing routed to one pack could claim to cure cancer and reverse diabetes and
 * come back verified, because those nouns live only in the other pack's lexicon.
 * The DETECTED subcategories deliberately do not reach this check (they only
 * order the prompt injection and drive the fail-closed PACK rule).
 */
export function c6BannedTerms(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  return scanSurfacesForBanned(
    // `facts.*` string values are scanned too: they are echoed verbatim into
    // every repair prompt, so a claim parked there used to ride into the
    // generator with no check ever reading it.
    [...customerSurfaces(l), ...attributeComplianceSurfaces(l), ...factsComplianceSurfaces(l)],
    cp,
    crossPackDiseaseNouns(pack),
    'C6',
    crossPackActionPairedNouns(pack),
  );
}

/**
 * C7 — a backend-only brand/manufacturer string in customer copy.
 *
 * THE TRIGGER, THE SURFACES AND THE EXEMPTION ARE UNCHANGED, and deliberately
 * so. C7 skips entirely when `productName` contains the brand, which is the
 * whole rule: the brand enters copy ONLY as part of the canonical product name.
 * That is satisfiable in both directions and it does not fight C8/C15 — those
 * require the title to lead with the PRODUCT NAME, not with the brand, so a
 * brand-led product name satisfies C7, C8 and C15 at once.
 *
 * WHAT CHANGED IS THE MESSAGES, and the live run says why (ASIN B00IO89MYA):
 *
 *   C7 | description | contains backend-only 'Instant Immunity'
 *       FIX: Remove the backend-only brand_name string from customer copy
 *
 * That fix line names the ATTRIBUTE KEY, not the offending string, and offers
 * no replacement — while the failure routes to the `description` group, which
 * cannot take the other exit at all (`productName` is pinned by
 * `runRepairLoop` and owned by the title group). So the one group that could
 * act was told which key was upset rather than which characters to take out and
 * what to write instead. Each message now names the exact offending string, why
 * it is barred (the customer product name does not contain it) and the
 * canonical product name to use in its place.
 */
export function c7BrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const canonicalName = normalize(l.productName ?? '');
  const productName = canonicalName.toLowerCase();
  // The REASON half of every message, stated once: it is the product name that
  // decides whether this string is backend-only, so the product name is what
  // the message quotes.
  const because = canonicalName
    ? `the customer product name is '${canonicalName}', which does not contain it`
    : 'no customer product name is set, so no copy may carry it';
  const instead = canonicalName
    ? `write '${canonicalName}' wherever the product needs naming`
    : 'name the product with its canonical customer product name instead';
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = (l.attributes ?? {})[key];
    if (!value) continue;
    const brand = normalize(value).toLowerCase();
    if (!brand || productName.includes(brand)) continue;
    for (const [field, text] of customerSurfaces(l)) {
      if (normalize(text).toLowerCase().includes(brand)) {
        out.push(
          fail(
            'C7',
            field,
            `contains backend-only '${value}'`,
            `Take the exact string '${value}' (attributes.${key}) out of ${field} — ${because}, so it is a backend-only string that may not reach customer copy; ${instead}`,
          ),
        );
      }
    }
    for (const [attr, av] of Object.entries(l.attributes ?? {})) {
      if (attr === 'brand_name' || attr === 'manufacturer') continue;
      if (normalize(av).toLowerCase().includes(brand)) {
        out.push(
          fail(
            'C7',
            `attributes.${attr}`,
            `contains backend-only '${value}'`,
            `Take the exact string '${value}' (attributes.${key}) out of attributes.${attr} — ${because}, so it is a backend-only string that may not be echoed into another attribute; ${instead}`,
          ),
        );
      }
    }
  }
  return out;
}

export function c8ProductNameLead(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName ?? '');
  if (!normalize(l.title ?? '').startsWith(name)) {
    out.push(fail('C8', 'title', normalize(l.title ?? '').slice(0, 60), 'The customer product name must START the title'));
  }
  if (!normalize(l.description ?? '').includes(name)) {
    out.push(fail('C8', 'description', 'product name missing', 'The product name must appear in the description'));
  }
  return out;
}
