import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize, subtractDisclaimers } from '../util';

/**
 * C18 — Prohibited detail-page content.
 *
 * Amazon bans price, availability and condition details, plus contact info
 * (email / URL / phone) and shipping offers, from titles, bullets, the
 * description, backend terms and A+ content.
 *
 * Everything scanned is PACK DATA (`rules.prohibitedContent`) so the gate stays
 * NOTE: unlike the disease-term scan, this check deliberately does NOT apply the
 * negation guard. A price, URL or availability claim is prohibited regardless of
 * surrounding wording — and a nearby innocent "no" (e.g. "contains no allergens
 * ... priced at 39 dollars") must not suppress the finding.
 *
 * category-agnostic. Note the price patterns deliberately cover BOTH the "$19.95"
 * symbol form and the spelled-out "39 dollars and 95 cents" form — the latter is
 * how a real generated bullet slipped past the older A+-only, symbol-only check.
 */
export function c18ProhibitedContent(
  listing: OptimizedListing,
  pack: KnowledgePack,
): Failure[] {
  const cfg = pack.rules.prohibitedContent;
  if (!cfg || !Array.isArray(cfg.patterns) || cfg.patterns.length === 0) return [];

  const disclaimer = pack.compliancePack?.disclaimer ?? '';
  const surfaces: { field: string; text: string }[] = [];
  const want = new Set(cfg.surfaces ?? []);

  if (want.has('title')) surfaces.push({ field: 'title', text: listing.title });
  if (want.has('title75')) surfaces.push({ field: 'title75', text: listing.title75 });
  if (want.has('itemHighlights')) surfaces.push({ field: 'itemHighlights', text: listing.itemHighlights });
  if (want.has('bullets')) {
    listing.bullets.forEach((b, i) => surfaces.push({ field: `bullets[${i}]`, text: b }));
  }
  if (want.has('description')) surfaces.push({ field: 'description', text: listing.description });
  if (want.has('backendSearchTerms')) {
    surfaces.push({ field: 'backendSearchTerms', text: listing.backendSearchTerms });
  }
  if (want.has('qa')) {
    (listing.qa ?? []).forEach((item, i) => {
      surfaces.push({ field: `qa[${i}].q`, text: item.q });
      surfaces.push({ field: `qa[${i}].a`, text: item.a });
    });
  }
  if (want.has('imagePlan')) {
    (listing.imagePlan ?? []).forEach((slot, i) => {
      surfaces.push({ field: `imagePlan[${i}].notes`, text: slot.notes });
    });
  }
  if (want.has('aplus') && listing.aplusContent) {
    const a = listing.aplusContent;
    a.modules.forEach((m) =>
      surfaces.push({
        field: `aplus.modules[${m.id}]`,
        text: `${m.headline} ${m.body} ${m.subcopy ?? ''}`,
      }),
    );
    a.comparison.rows.forEach((row, i) =>
      surfaces.push({ field: `aplus.comparison[${i}]`, text: `${row.label} ${row.ours} ${row.typical}` }),
    );
    a.faq.forEach((f, i) => surfaces.push({ field: `aplus.faq[${i}]`, text: `${f.q} ${f.a}` }));
  }

  const out: Failure[] = [];
  for (const { field, text } of surfaces) {
    // The verbatim disclaimer is required text — never scan it.
    const clean = subtractDisclaimers(normalize(text ?? ''), [disclaimer]);
    if (!clean) continue;
    for (const entry of cfg.patterns) {
      const [source, label] = entry;
      if (!source) continue;
      const re = new RegExp(source, 'gi');
      const m = re.exec(clean);
      if (m) {
        out.push({
          checkId: 'C18',
          field,
          context: m[0].trim(),
          fix: `Remove the ${label} — Amazon prohibits price, availability, condition and contact details in listing content`,
        });
      }
    }
  }
  return out;
}
