import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { hasNegationContext, normalize } from '../util';
import { crossPackActionPairedNouns, crossPackDiseaseNouns } from './pack';
import { allergenMentioned, presentAllergens } from './c-quality';
import {
  aplusSurfaces,
  fail,
  fictionOver,
  potencyPhrasingOver,
  prohibitedMarketingPatterns,
  scanSurfacesForBanned,
} from './shared';

export function a1AplusDisclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const a = l.aplusContent;
  const out: Failure[] = [];
  if (!a) return [fail('A1', 'aplusContent', '(missing)', 'A+ content is missing entirely')];
  if (normalize(a.fdaDisclaimer ?? '') !== normalize(cp.disclaimer)) {
    out.push(fail('A1', 'aplus.fdaDisclaimer', normalize(a.fdaDisclaimer ?? '').slice(0, 80), 'A+ fdaDisclaimer must equal the canonical constant verbatim'));
  }
  const want = normalize(cp.disclaimer);
  for (const m of a.modules ?? []) {
    if (m?.claimBearing && !normalize(m.body ?? '').includes(want)) {
      out.push(fail('A1', `aplus.modules[${m?.id ?? ''}]`, 'claim-bearing module missing disclaimer', 'Each claim-bearing A+ module must contain the verbatim disclaimer'));
    }
  }
  (a.faq ?? []).forEach((f, i) => {
    if (f?.claimBearing && !normalize(f.a ?? '').includes(want)) {
      out.push(fail('A1', `aplus.faq[${i}]`, 'claim-bearing FAQ answer missing disclaimer', 'Each claim-bearing FAQ answer must contain the verbatim disclaimer'));
    }
  });
  return out;
}

/** A2 — same CROSS-PACK union lexicon as C6, applied to every A+ text field. */
export function a2AplusBannedTerms(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  return scanSurfacesForBanned(
    aplusSurfaces(l.aplusContent),
    cp,
    crossPackDiseaseNouns(pack),
    'A2',
    crossPackActionPairedNouns(pack),
  );
}

export function a3AplusBrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const productName = normalize(l.productName ?? '').toLowerCase();
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = (l.attributes ?? {})[key];
    if (!value) continue;
    const brand = normalize(value).toLowerCase();
    if (!brand || productName.includes(brand)) continue;
    for (const [field, text] of aplusSurfaces(l.aplusContent)) {
      if (normalize(text).toLowerCase().includes(brand)) {
        out.push(fail('A3', field, `contains backend-only '${value}'`, `Remove the backend-only ${key} string from A+ content`));
      }
    }
  }
  return out;
}

export function a4AplusProductName(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName ?? '').toLowerCase();
  const a = l.aplusContent;
  if (!a) return [fail('A4', 'aplusContent', '(missing)', 'A+ content is missing entirely')];
  // Module-id cues are PACK DATA (`rules.aplusModuleCues`) — no id literal here.
  const cues = pack.rules.aplusModuleCues;
  const brandStory = (a.modules ?? []).find((m) => (m?.id ?? '').includes(cues.brandStory));
  const hero = (a.modules ?? []).find((m) => (m?.id ?? '').includes(cues.hero)) ?? (a.modules ?? [])[0];
  if (!brandStory || !normalize(`${brandStory.headline} ${brandStory.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', `aplus.modules[${cues.brandStory}]`, brandStory ? 'product name missing' : `no '${cues.brandStory}' module`, `Product name must appear in the '${cues.brandStory}' module`));
  }
  if (!hero || !normalize(`${hero.headline} ${hero.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', `aplus.modules[${cues.hero}]`, hero ? 'product name missing' : `no '${cues.hero}' module`, `Product name must appear in the '${cues.hero}' module`));
  }
  return out;
}

export function a5AplusPotencyPhrasing(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  return potencyPhrasingOver(aplusSurfaces(l.aplusContent), pack.rules.units, 'A5', pack.rules.attributeGuard);
}

export function a6AplusFictionPhrases(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp || cp.fictionPhrases.length === 0) return [];
  return fictionOver(aplusSurfaces(l.aplusContent), cp, 'A6');
}

export function a7AplusAllergen(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const present = presentAllergens(l, cp);
  if (present.length === 0) return [];
  const cue = cp.allergenFields.aplusModuleIdCue;
  const ingredientsModule = (l.aplusContent?.modules ?? []).find((m) => (m?.id ?? '').includes(cue));
  const out: Failure[] = [];
  for (const rule of present) {
    const text = ingredientsModule ? `${ingredientsModule.headline} ${ingredientsModule.body} ${ingredientsModule.subcopy ?? ''}` : '';
    if (!ingredientsModule || !allergenMentioned(text, rule, cp)) {
      out.push(fail('A7', `aplus.modules[${ingredientsModule?.id ?? cue}]`, ingredientsModule ? `does not declare ${rule.class}` : `no '${cue}' module`, `Declare the allergen ('${rule.canonicalString}') in the A+ '${cue}' module`));
    }
  }
  return out;
}

/**
 * A8 — prohibited marketing on A+ surfaces.
 * The pattern lexicon is PACK DATA (`rules.prohibitedMarketing.patterns`) —
 * this module holds no literals, so the gate stays category-agnostic. C19
 * applies the same pack lexicon to every non-A+ surface, and BOTH read it
 * through `prohibitedMarketingPatterns` so the word-form macro is expanded
 * once, identically, for both checks.
 */
/** Compiled pack patterns cached by source string (see C18/C19 for the rationale). */
const APLUS_PATTERN_CACHE = new Map<string, RegExp>();
function aplusPatternRe(source: string): RegExp {
  let re = APLUS_PATTERN_CACHE.get(source);
  if (!re) {
    re = new RegExp(source, 'gi');
    APLUS_PATTERN_CACHE.set(source, re);
  }
  re.lastIndex = 0;
  return re;
}

export function a8AplusProhibitedMarketing(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const patterns = prohibitedMarketingPatterns(pack);
  if (patterns.length === 0) return [];
  const out: Failure[] = [];
  for (const [field, textRaw] of aplusSurfaces(l.aplusContent)) {
    const text = normalize(textRaw);
    for (const [source, label] of patterns) {
      if (!source) continue;
      const re = aplusPatternRe(source);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!hasNegationContext(text, m.index)) {
          out.push(fail('A8', field, m[0], `Prohibited A+ marketing: ${label}`));
        }
      }
    }
  }
  return out;
}

/**
 * A9 — A+ comparison + who-it's-for presence (quality floor).
 * Thresholds/cues come from pack.rules — not category-hard-coded.
 */
export function a9AplusComparisonAndAudience(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];
  const minRows = pack.rules.aplusComparisonMinRows;
  const rows = (l.aplusContent?.comparison?.rows ?? []).length;
  if (rows < minRows) {
    out.push(
      fail(
        'A9',
        'aplus.comparison',
        `${rows} rows`,
        `A+ comparison must have ≥${minRows} rows framing ours vs a typical alternative`,
      ),
    );
  }
  const cues = pack.rules.whoItsForCues.map((c) => c.toLowerCase());
  const hay = normalize(
    [
      ...(l.aplusContent?.modules ?? []).map((m) => `${m?.id ?? ''} ${m?.headline ?? ''} ${m?.body ?? ''} ${m?.subcopy ?? ''}`),
      ...(l.aplusContent?.faq ?? []).map((f) => `${f?.q ?? ''} ${f?.a ?? ''}`),
    ].join(' '),
  ).toLowerCase();
  const hit = cues.some((c) => hay.includes(c));
  if (!hit) {
    out.push(
      fail(
        'A9',
        'aplusContent',
        'no who-it\'s-for cue found',
        `Include a who-it's-for / best-for / ideal-for statement in an A+ module or FAQ (cues from pack.rules.whoItsForCues)`,
      ),
    );
  }
  return out;
}
