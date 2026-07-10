import type {
  AuditGap,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { activeDiseaseNouns } from '@/lib/gate/checks';
import { normalize, scanTerms, subtractDisclaimers, utf8Bytes } from '@/lib/gate/util';

/**
 * Field-by-field gaps between the CURRENT listing and the PROPOSED one.
 * Severity: P0 = compliance/limit violation in the current listing;
 * P1 = missing high-value coverage or empty ⭐ filter attributes;
 * P2 = polish.
 */

const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function diff(
  current: ListingSnapshot,
  proposed: OptimizedListing,
  pack: KnowledgePack,
  subcategories: string[],
): AuditGap[] {
  const gaps: AuditGap[] = [];
  const cp = pack.compliancePack;

  // --- P0: compliance violations in the CURRENT listing ---
  if (cp) {
    const nouns = activeDiseaseNouns(cp, subcategories);
    const surfaces: [string, string][] = [
      ['title', current.title],
      ['description', current.description],
      ...current.bullets.map((b, i) => [`bullets[${i}]`, b] as [string, string]),
    ];
    const disclaimers = [cp.disclaimer, ...cp.auditAcceptDisclaimers].map(normalize);
    for (const [field, textRaw] of surfaces) {
      const text = subtractDisclaimers(normalize(textRaw), disclaimers);
      for (const m of scanTerms(text, nouns)) {
        gaps.push({
          field,
          current: clip(m.context),
          proposed: 'Structure/function reframing (see proposed copy)',
          why: `Current listing uses the banned disease term '${m.term}' — disease claims risk suppression/enforcement.`,
          severity: 'P0',
        });
      }
    }
    const claimMarkers = /\b(supports?|helps?|promotes?|boosts?|improves?)\b/i;
    const hasClaims = claimMarkers.test(`${current.bullets.join(' ')} ${current.description}`);
    const hasDisclaimer = disclaimers.some((d) => normalize(current.description).includes(d));
    if (hasClaims && !hasDisclaimer) {
      gaps.push({
        field: 'description',
        current: 'Benefit claims present without the FDA disclaimer',
        proposed: 'Verbatim 21 CFR 101.93 disclaimer appended to the description',
        why: 'Structure/function claims require the verbatim FDA disclaimer wherever they appear.',
        severity: 'P0',
      });
    }
  }

  // --- limits in the current listing ---
  if (current.title.length > pack.rules.titleMaxLegacy) {
    gaps.push({ field: 'title', current: `${current.title.length} chars`, proposed: `${proposed.title.length} chars (≤${pack.rules.titleMaxLegacy})`, why: 'Current title exceeds the hard limit.', severity: 'P0' });
  }
  if (current.title.length > pack.rules.title75Max) {
    gaps.push({
      field: 'title75',
      current: `${current.title.length}-char title; no 75-char variant`,
      proposed: clip(proposed.title75),
      why: 'Amazon\'s 75-char title policy (eff. Jul 27 2026) will AI-rewrite longer titles — a controlled 75-char title beats an automated rewrite.',
      severity: 'P1',
    });
  }
  gaps.push({
    field: 'itemHighlights',
    current: 'unknown',
    proposed: clip(proposed.itemHighlights),
    why: 'Item Highlights (≤125 chars, searchable) absorbs title overflow under the new policy; not visible publicly — enter when your template supports it.',
    severity: 'P1',
  });
  current.bullets.forEach((b, i) => {
    if (b.length > pack.rules.bulletMax) {
      gaps.push({ field: `bullets[${i}]`, current: `${b.length} chars`, proposed: `≤${pack.rules.bulletMax} chars`, why: 'Bullet exceeds the hard limit.', severity: 'P0' });
    }
  });
  if (current.bullets.length < pack.rules.bulletCount) {
    gaps.push({ field: 'bullets', current: `${current.bullets.length} bullets`, proposed: `${pack.rules.bulletCount} bullets, one situational anchor each`, why: 'Unused bullet slots are lost indexing and persuasion surface.', severity: 'P1' });
  }
  if (current.description.length > pack.rules.descriptionMax) {
    gaps.push({ field: 'description', current: `${current.description.length} chars`, proposed: `≤${pack.rules.descriptionMax}`, why: 'Description exceeds the schema maximum.', severity: 'P0' });
  }

  // --- backend: never publicly visible ---
  gaps.push({
    field: 'backendSearchTerms',
    current: 'unknown',
    proposed: `${utf8Bytes(proposed.backendSearchTerms)} bytes of synonyms/misspellings/other-language variants (≤${pack.rules.backendMaxBytes})`,
    why: 'Current backend terms are seller-private and cannot be audited from the PDP; the proposed set is deduplicated against all title surfaces.',
    severity: 'P1',
  });

  // --- ⭐ filter attributes ---
  const facets = pack.attributeSchema.filter((f) => f.filterFacet);
  const emptyFacets = facets.filter((f) => !(current.attributes[f.field] ?? '').trim());
  if (emptyFacets.length > 0) {
    gaps.push({
      field: 'attributes',
      current: `${emptyFacets.length} empty filter-facet fields: ${emptyFacets.map((f) => f.field).join(', ')}`,
      proposed: 'All applicable ⭐ fields populated',
      why: 'Empty filter facets exclude the listing from customer filters and add COSMO retrieval uncertainty.',
      severity: 'P1',
    });
  }

  // --- images / A+ ---
  if (current.images.length < 7) {
    gaps.push({ field: 'imagePlan', current: `${current.images.length} gallery images`, proposed: '7-slot creative plan (main, infographic, real facts panel, ingredients, how-to, trust, lifestyle)', why: 'Under-filled gallery loses conversion and AI-visual coverage.', severity: 'P2' });
  }
  const rawView = current.raw as { aplusText?: string } | null;
  if (!rawView?.aplusText) {
    gaps.push({ field: 'aplusContent', current: 'No extractable A+ text detected', proposed: `${proposed.aplusContent.modules.length} real-text modules + comparison + FAQ`, why: 'AI/voice engines read A+ text even though classic A9 ignores it; image-only A+ is invisible to them.', severity: 'P1' });
  }

  // --- quality lint (advisory, deterministic) ---
  const nameLen = proposed.productName.length;
  const postName = proposed.title.slice(nameLen, nameLen + 75).toLowerCase();
  if (!postName.includes(proposed.primaryKeyword.toLowerCase())) {
    gaps.push({ field: 'title', current: clip(current.title, 80), proposed: clip(proposed.title, 80), why: `Quality lint: primary keyword '${proposed.primaryKeyword}' should sit immediately after the product name.`, severity: 'P2' });
  }
  const anchors = proposed.bulletAnchors ?? [];
  if (new Set(anchors.filter(Boolean)).size < anchors.length) {
    gaps.push({ field: 'bullets', current: 'n/a', proposed: anchors.join(' | '), why: 'Quality lint: bullet use-case anchors should be distinct (one per major use-case).', severity: 'P2' });
  }
  const whoFor = proposed.aplusContent.modules.some((m) => /who/i.test(m.id) || /who it'?s for|who it is for/i.test(`${m.headline} ${m.body}`)) ||
    proposed.qa.some((q) => /who is it for|who it'?s for/i.test(q.q));
  if (!whoFor) {
    gaps.push({ field: 'aplusContent', current: 'n/a', proposed: 'Add a who-it\'s-for module/FAQ', why: 'Quality lint: comparison + who-it\'s-for is a major AI query class.', severity: 'P2' });
  }

  // --- explicit current-vs-proposed copy deltas (visible fields) ---
  if (normalize(current.title) !== normalize(proposed.title)) {
    gaps.push({
      field: 'title',
      current: clip(current.title, 120),
      proposed: clip(proposed.title, 120),
      why: 'Title restructured for product-name lead, keyword front-loading, and limit-safe length under the new 75-char policy.',
      severity: 'P2',
    });
  }
  if (
    current.bullets.length === pack.rules.bulletCount &&
    proposed.bullets.length === pack.rules.bulletCount
  ) {
    const changed = current.bullets.filter(
      (b, i) => normalize(b) !== normalize(proposed.bullets[i] ?? ''),
    ).length;
    if (changed >= 3) {
      gaps.push({
        field: 'bullets',
        current: clip(current.bullets[0] ?? '', 100),
        proposed: clip(proposed.bullets[0] ?? '', 100),
        why: `${changed}/5 bullets rewritten with distinct situational anchors and compliant structure/function framing.`,
        severity: 'P2',
      });
    }
  }

  return gaps;
}
