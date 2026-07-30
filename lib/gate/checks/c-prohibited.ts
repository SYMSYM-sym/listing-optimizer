import type { CompliancePack, Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { CONCAT_MIN_TERM_LEN } from './shared';
import {
  deobfuscatedVariants,
  normalize,
  scanConcatenated,
  stripSeparators,
  subtractDisclaimers,
  termRegex,
} from '../util';

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
  const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  if (want.has('title')) surfaces.push({ field: 'title', text: s(listing.title) });
  if (want.has('title75')) surfaces.push({ field: 'title75', text: s(listing.title75) });
  if (want.has('itemHighlights')) surfaces.push({ field: 'itemHighlights', text: s(listing.itemHighlights) });
  if (want.has('bullets')) {
    (listing.bullets ?? []).forEach((b, i) => surfaces.push({ field: `bullets[${i}]`, text: s(b) }));
  }
  if (want.has('description')) surfaces.push({ field: 'description', text: s(listing.description) });
  if (want.has('backendSearchTerms')) {
    surfaces.push({ field: 'backendSearchTerms', text: s(listing.backendSearchTerms) });
  }
  if (want.has('qa')) {
    (listing.qa ?? []).forEach((item, i) => {
      surfaces.push({ field: `qa[${i}].q`, text: s(item?.q) });
      surfaces.push({ field: `qa[${i}].a`, text: s(item?.a) });
    });
  }
  // purpose/spec/notes are ALL creative copy — an overlay price or URL written
  // into `purpose` reaches the customer exactly like one written into `notes`.
  if (want.has('imagePlan')) {
    (listing.imagePlan ?? []).forEach((slot, i) => {
      surfaces.push({ field: `imagePlan[${i}].purpose`, text: s(slot?.purpose) });
      surfaces.push({ field: `imagePlan[${i}].spec`, text: s(slot?.spec) });
      surfaces.push({ field: `imagePlan[${i}].notes`, text: s(slot?.notes) });
    });
  }
  // Canonical FACTS are echoed verbatim into every repair prompt and into the
  // export, so a price/URL/marketing claim parked in one used to reach the
  // generator with neither C18 nor C19 ever reading it.
  // `facts.price` is exempted BY KEY (it legitimately holds the standard
  // price); every other fact string is scanned.
  if (want.has('facts')) {
    for (const [key, value] of Object.entries(listing.facts ?? {})) {
      if (key === 'price') continue;
      const text = s(value);
      if (text.trim()) surfaces.push({ field: `facts.${key}`, text });
    }
  }
  // Attribute VALUES render in the customer-facing detail table.
  if (want.has('attributes')) {
    for (const [key, value] of Object.entries(listing.attributes ?? {})) {
      surfaces.push({ field: `attributes.${key}`, text: s(value) });
    }
  }
  if (want.has('aplus') && listing.aplusContent) {
    const a = listing.aplusContent;
    (a.modules ?? []).forEach((m) =>
      surfaces.push({
        field: `aplus.modules[${m.id}]`,
        text: `${s(m?.headline)} ${s(m?.body)} ${s(m?.subcopy)}`,
      }),
    );
    (a.comparison?.rows ?? []).forEach((row, i) =>
      surfaces.push({ field: `aplus.comparison[${i}]`, text: `${s(row?.label)} ${s(row?.ours)} ${s(row?.typical)}` }),
    );
    (a.faq ?? []).forEach((f, i) => surfaces.push({ field: `aplus.faq[${i}]`, text: `${s(f?.q)} ${s(f?.a)}` }));
  }
  return surfaces;
}

/**
 * The variants EVERY C18/C19 pattern is run over.
 *
 * C18/C19 used to regex the normalized text ONLY, so the very same
 * de-obfuscation tricks the disease scan has defended against for two rounds
 * (`b-e-s-t s-e-l-l-e-r`, leetspeak) walked straight past the price, contact
 * and marketing patterns. They now share the disease scan's ADDITIVE variant
 * set — the untouched text is always variant #1, so nothing is weakened.
 *
 * Coverage note: the separator-STRIPPED variant is included as well, but the
 * pack patterns are written with `\s`/word boundaries, so most of them cannot
 * match a fully concatenated string. It is there for the patterns that can
 * (bare domains, symbol+digit), not as a general guarantee.
 */
function scanVariants(clean: string): string[] {
  const variants = new Set<string>(deobfuscatedVariants(clean));
  const { stripped } = stripSeparators(clean);
  if (stripped) variants.add(stripped);
  return [...variants];
}

/**
 * Compiled pack patterns, cached by SOURCE STRING.
 *
 * C18/C19 now run every pattern over several de-obfuscated variants of every
 * surface, so re-compiling the same source thousands of times per gate run was
 * the dominant cost. Each cached regex is reset before use (the `g` flag makes
 * `lastIndex` stateful).
 */
const PATTERN_CACHE = new Map<string, RegExp>();
function patternRe(source: string): RegExp {
  let re = PATTERN_CACHE.get(source);
  if (!re) {
    re = new RegExp(source, 'gi');
    PATTERN_CACHE.set(source, re);
  }
  re.lastIndex = 0;
  return re;
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
    const variants = scanVariants(clean);
    for (const entry of cfg.patterns) {
      const [source, label] = entry;
      if (!source) continue;
      // One finding per pattern per surface, whichever variant exposes it.
      for (const variant of variants) {
        const m = patternRe(source).exec(variant);
        if (!m) continue;
        out.push({
          checkId: 'C18',
          field,
          context: m[0].trim(),
          fix: `Remove the ${label} — Amazon prohibits price, availability, condition and contact details in listing content`,
        });
        break;
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
 * NOTE: exactly like C18, this check applies NO negation guard. A prohibited
 * marketing claim is prohibited whatever surrounds it, and every guard variant
 * shipped so far was bypassable by prefixing the claim with an unrelated
 * negation ("No fillers here, <claim>"). Copy that needs to ENUMERATE the
 * banned words (an internal image brief) must be phrased without them — the
 * shipped prompts are written that way.
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

  const out: Failure[] = [];
  // Superlative bans are de-obfuscated the same way, and additionally scanned
  // in the separator-STRIPPED variant (same threshold and the same token
  // anchoring as the disease-term concatenated pass).
  for (const { field, text } of surfaces) {
    const clean = subtractDisclaimers(normalize(text ?? ''), disclaimers);
    if (!clean) continue;
    const variants = scanVariants(clean);

    for (const [source, label] of patterns) {
      if (!source) continue;
      let hit: string | null = null;
      for (const variant of variants) {
        const m = patternRe(source).exec(variant);
        if (m) {
          hit = m[0].trim();
          break;
        }
      }
      if (hit !== null) {
        out.push({
          checkId: 'C19',
          field,
          context: hit,
          fix: `Remove the ${label} — Amazon prohibits promotional, ranking, guarantee and review claims in listing content`,
        });
      }
    }

    for (const term of superlatives) {
      if (!term.trim()) continue;
      let context: string | null = null;
      for (const variant of variants) {
        const re = termRegex(term);
        re.lastIndex = 0;
        const m = re.exec(variant);
        if (m) {
          context = variant.slice(Math.max(0, m.index - 20), m.index + term.length + 20);
          break;
        }
      }
      if (context === null) {
        const m = scanConcatenated(clean, [term], CONCAT_MIN_TERM_LEN)[0];
        if (m) context = m.context;
      }
      if (context !== null) {
        out.push({
          checkId: 'C19',
          field,
          context,
          fix: `Remove the prohibited marketing phrase '${term}' — it is banned on every surface`,
        });
      }
    }
  }
  return out;
}
