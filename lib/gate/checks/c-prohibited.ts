import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { hasNegationContext, normalize, subtractDisclaimers, termRegex } from '../util';

interface ScanSurface {
  field: string;
  text: string;
}

/**
 * The surface set shared by C18 (prohibited detail-page content) and C19
 * (prohibited marketing). Which of these groups is actually scanned is PACK
 * DATA (`surfaces`), so the gate stays category-agnostic.
 */
function collectSurfaces(listing: OptimizedListing, want: Set<string>): ScanSurface[] {
  const surfaces: ScanSurface[] = [];
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
  // purpose/spec/notes are ALL creative copy — an overlay price or URL written
  // into `purpose` reaches the customer exactly like one written into `notes`.
  if (want.has('imagePlan')) {
    (listing.imagePlan ?? []).forEach((slot, i) => {
      surfaces.push({ field: `imagePlan[${i}].purpose`, text: slot.purpose });
      surfaces.push({ field: `imagePlan[${i}].spec`, text: slot.spec });
      surfaces.push({ field: `imagePlan[${i}].notes`, text: slot.notes });
    });
  }
  // Attribute VALUES render in the customer-facing detail table.
  if (want.has('attributes')) {
    for (const [key, value] of Object.entries(listing.attributes ?? {})) {
      surfaces.push({ field: `attributes.${key}`, text: value });
    }
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
  return surfaces;
}

function disclaimersOf(cp: CompliancePack | null | undefined): string[] {
  if (!cp) return [];
  return [cp.disclaimer, ...(cp.auditAcceptDisclaimers ?? [])].filter(Boolean);
}

/**
 * C18 — Prohibited detail-page content.
 *
 * Amazon bans price, availability and condition details, plus contact info
 * (email / URL / phone) and shipping offers, from titles, bullets, the
 * description, backend terms, attributes, Q&A, the image plan and A+ content.
 *
 * Everything scanned is PACK DATA (`rules.prohibitedContent`) so the gate stays
 * category-agnostic.
 * NOTE: unlike the disease-term scan, this check deliberately does NOT apply the
 * negation guard. A price, URL or availability claim is prohibited regardless of
 * surrounding wording — and a nearby innocent "no" (e.g. "contains no allergens
 * ... priced at 39 dollars") must not suppress the finding.
 *
 * Note the price patterns deliberately cover BOTH the "$19.95" symbol form and
 * the spelled-out "39 dollars and 95 cents" form — the latter is how a real
 * generated bullet slipped past the older A+-only, symbol-only check.
 */
export function c18ProhibitedContent(
  listing: OptimizedListing,
  pack: KnowledgePack,
): Failure[] {
  const cfg = pack.rules.prohibitedContent;
  if (!cfg || !Array.isArray(cfg.patterns) || cfg.patterns.length === 0) return [];

  const disclaimers = disclaimersOf(pack.compliancePack);
  const surfaces = collectSurfaces(listing, new Set(cfg.surfaces ?? []));

  const out: Failure[] = [];
  for (const { field, text } of surfaces) {
    // The verbatim disclaimer is required text — never scan it.
    const clean = subtractDisclaimers(normalize(text ?? ''), disclaimers);
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

/**
 * C19 — Prohibited MARKETING claims on EVERY surface.
 *
 * A8 only ever looked at A+ content, so "100% money back guarantee",
 * a guarantee, a rank claim or a false regulatory-approval claim sailed
 * through in a bullet, the
 * description, Q&A, an attribute value or an image brief. C19 closes that: it
 * scans the pack's `rules.prohibitedMarketing.patterns` PLUS the compliance
 * pack's `superlativeBans` across every surface the pack lists.
 *
 * Both lexicons are PACK DATA — this module hard-codes nothing.
 *
 * The tightened (clause-scoped) negation guard applies so genuinely negated
 * copy — an image brief saying "No ratings, guarantees, or unsubstantiated
 * claims" — is not reported, while a cue several words away can no longer
 * launder a real marketing claim.
 */
export function c19ProhibitedMarketing(
  listing: OptimizedListing,
  pack: KnowledgePack,
): Failure[] {
  const cfg = pack.rules.prohibitedMarketing;
  const cp = pack.compliancePack;
  const patterns = cfg?.patterns ?? [];
  const superlatives = cp?.superlativeBans ?? [];
  if (patterns.length === 0 && superlatives.length === 0) return [];

  const disclaimers = disclaimersOf(cp);
  const surfaces = collectSurfaces(listing, new Set(cfg?.surfaces ?? []));
  const neg = { mode: 'strict' as const, metaPhrases: cp?.negationMetaPhrases ?? [] };

  const out: Failure[] = [];
  for (const { field, text } of surfaces) {
    const clean = subtractDisclaimers(normalize(text ?? ''), disclaimers);
    if (!clean) continue;

    for (const [source, label] of patterns) {
      if (!source) continue;
      const re = new RegExp(source, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(clean)) !== null) {
        if (hasNegationContext(clean, m.index, neg)) continue;
        out.push({
          checkId: 'C19',
          field,
          context: m[0].trim(),
          fix: `Remove the ${label} — Amazon prohibits promotional, ranking, guarantee and review claims in listing content`,
        });
        break; // one finding per pattern per surface
      }
    }

    for (const term of superlatives) {
      if (!term.trim()) continue;
      const re = termRegex(term);
      let m: RegExpExecArray | null;
      while ((m = re.exec(clean)) !== null) {
        if (hasNegationContext(clean, m.index, neg)) continue;
        out.push({
          checkId: 'C19',
          field,
          context: clean.slice(Math.max(0, m.index - 20), m.index + term.length + 20),
          fix: `Remove the prohibited marketing phrase '${term}' — it is banned on every surface`,
        });
        break;
      }
    }
  }
  return out;
}
