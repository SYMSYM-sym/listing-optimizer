import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { hasNegationContext, normalize } from '../util';
import { activeDiseaseNouns } from './pack';
import { allergenMentioned, presentAllergens } from './c-quality';
import { aplusSurfaces, fail, fictionOver, potencyPhrasingOver, scanSurfacesForBanned } from './shared';
import type { GateContext } from './types';

export function a1AplusDisclaimer(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const a = l.aplusContent;
  const out: Failure[] = [];
  if (normalize(a.fdaDisclaimer) !== normalize(cp.disclaimer)) {
    out.push(fail('A1', 'aplus.fdaDisclaimer', a.fdaDisclaimer.slice(0, 80), 'A+ fdaDisclaimer must equal the canonical constant verbatim'));
  }
  const want = normalize(cp.disclaimer);
  for (const m of a.modules) {
    if (m.claimBearing && !normalize(m.body).includes(want)) {
      out.push(fail('A1', `aplus.modules[${m.id}]`, 'claim-bearing module missing disclaimer', 'Each claim-bearing A+ module must contain the verbatim disclaimer'));
    }
  }
  a.faq.forEach((f, i) => {
    if (f.claimBearing && !normalize(f.a).includes(want)) {
      out.push(fail('A1', `aplus.faq[${i}]`, 'claim-bearing FAQ answer missing disclaimer', 'Each claim-bearing FAQ answer must contain the verbatim disclaimer'));
    }
  });
  return out;
}

export function a2AplusBannedTerms(l: OptimizedListing, pack: KnowledgePack, ctx: GateContext): Failure[] {
  const cp = pack.compliancePack;
  if (!cp) return [];
  const nouns = activeDiseaseNouns(cp, ctx.subcategories);
  return scanSurfacesForBanned(aplusSurfaces(l.aplusContent), cp, nouns, 'A2');
}

export function a3AplusBrandLeakage(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const productName = normalize(l.productName).toLowerCase();
  for (const key of ['brand_name', 'manufacturer'] as const) {
    const value = l.attributes[key];
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

export function a4AplusProductName(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  const name = normalize(l.productName).toLowerCase();
  const a = l.aplusContent;
  const brandStory = a.modules.find((m) => m.id.includes('brand'));
  const hero = a.modules.find((m) => m.id.includes('hero')) ?? a.modules[0];
  if (!brandStory || !normalize(`${brandStory.headline} ${brandStory.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', 'aplus.modules[brand-story]', brandStory ? 'product name missing' : 'no brand-story module', 'Product name must appear in the Brand-Story module'));
  }
  if (!hero || !normalize(`${hero.headline} ${hero.body}`).toLowerCase().includes(name)) {
    out.push(fail('A4', 'aplus.modules[hero]', hero ? 'product name missing' : 'no hero module', 'Product name must appear in the hero module'));
  }
  return out;
}

export function a5AplusPotencyPhrasing(l: OptimizedListing): Failure[] {
  return potencyPhrasingOver(aplusSurfaces(l.aplusContent), 'A5');
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
  const ingredientsModule = l.aplusContent.modules.find((m) => m.id.includes('ingredient'));
  const out: Failure[] = [];
  for (const rule of present) {
    const text = ingredientsModule ? `${ingredientsModule.headline} ${ingredientsModule.body} ${ingredientsModule.subcopy ?? ''}` : '';
    if (!ingredientsModule || !allergenMentioned(text, rule)) {
      out.push(fail('A7', 'aplus.modules[ingredients]', ingredientsModule ? `does not declare ${rule.class}` : 'no ingredients module', `Declare the allergen ('${rule.canonicalString}') in the A+ ingredients module`));
    }
  }
  return out;
}

const A8_PATTERNS: [RegExp, string][] = [
  [/\$\s*\d/g, 'price / $ figure'],
  [/\b(?:cents?|dollars?)\s+(?:a|per)\s+day\b/gi, 'per-day price framing'],
  [/\bbuy\s+now\b/gi, '"buy now" CTA'],
  [/\bsubscribe\s*(?:&|and)\s*save\b/gi, '"subscribe & save"'],
  [/\bhurry\b/gi, 'urgency'],
  [/\btoday\s+only\b/gi, 'urgency'],
  [/\blimited\s+time\b/gi, 'urgency'],
  [/\bmoney[- ]back\b/gi, 'guarantee'],
  [/\bguarantee[ds]?\b/gi, 'guarantee'],
  [/#\s?1\b/g, '"#1" claim'],
  [/\bbest[- ]?sell(?:er|ing)\b/gi, 'best-seller claim'],
  [/\b\d(?:\.\d)?\s*[- ]?star\b/gi, 'star-rating claim'],
  [/\b[\d,]+\+?\s*(?:customer\s+)?reviews\b/gi, 'review-count claim'],
];

export function a8AplusProhibitedMarketing(l: OptimizedListing): Failure[] {
  const out: Failure[] = [];
  for (const [field, textRaw] of aplusSurfaces(l.aplusContent)) {
    const text = normalize(textRaw);
    for (const [re, label] of A8_PATTERNS) {
      re.lastIndex = 0;
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
