import type { AuditGap, CompliancePack, KnowledgePack, OptimizedListing } from '@/lib/types';
import { allergenMentioned, presentAllergens } from '@/lib/gate/checks';
import { normalize } from '@/lib/gate/util';

/**
 * WS4 — BULLET-ARCHITECTURE LINTS (advisory, never a gate rule).
 *
 * The five bullets are the listing's only repeated persuasion surface, and the
 * failure mode is not illegality — it is five paraphrases of the same
 * sentence, an anchor reused twice, a declared slot job nobody wrote, or an
 * allergen declaration that opens a bullet instead of closing it. None of that
 * can be a gate check: strategy is a judgement about copy, and blocking a
 * publish over word order would be over-blocking (which this project treats as
 * exactly as severe as a bypass). So it lives HERE, as audit gaps, where an
 * operator reads it and decides.
 *
 * Severities, deliberately:
 *  - P1 for the AM-3 allergen POSITION rule. It is the only lint about a
 *    LEGALLY REQUIRED sentence: the declaration is present (C9 enforces that
 *    and is untouched), but reading it as the bullet's headline is a real
 *    conversion and comprehension cost.
 *  - P2 for the slot-job and anchor lints — pure strategy.
 *
 * All vocabulary is PACK DATA (`rules.bulletArchitecture`,
 * `compliancePack.allergen*`): this module authors no cue list of its own.
 */

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Index at which a bullet's allergen DECLARATION starts, or -1.
 *
 * The declaration is located by the pack's own declaration verb — the same
 * token `allergenMentioned` requires — so the lint and C9 agree on what a
 * declaration is.
 */
function declarationStart(bullet: string, cp: CompliancePack): number {
  const verb = cp.allergenFields?.declarationVerb?.trim().toLowerCase();
  if (!verb) return -1;
  return normalize(bullet).toLowerCase().indexOf(verb);
}

export function bulletArchitectureGaps(
  proposed: OptimizedListing,
  pack: KnowledgePack,
): AuditGap[] {
  const gaps: AuditGap[] = [];
  // `String(...)`: the audit must survive malformed structural input exactly
  // as the gate does — a numeric bullet is REPORTED, never thrown on.
  const bullets = (Array.isArray(proposed.bullets) ? proposed.bullets : []).map((b) => String(b ?? ''));
  const arch = pack.rules?.bulletArchitecture;
  const slots = arch?.slots ?? [];

  // --- 1. SLOT JOBS: is each declared job visibly attempted? ---
  // The question the lint can honestly ask is a weak one (does this bullet use
  // ANY of the vocabulary its job implies?), so it is asked weakly: one gap per
  // unfilled slot, severity P2, phrased as a prompt to look rather than a verdict.
  slots.forEach((slot, i) => {
    const cues = (slot.cues ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
    const text = normalize(bullets[i] ?? '').toLowerCase();
    if (text === '') {
      gaps.push({
        field: `bullets[${i}]`,
        current: 'n/a',
        proposed: `${slot.id} — ${slot.job}`,
        why: `Bullet architecture: slot ${slot.id} is empty. Every slot is separately indexed surface; an unwritten one is lost.`,
        severity: 'P2',
      });
      return;
    }
    if (cues.length === 0) return;
    if (cues.some((c) => text.includes(c))) return;
    gaps.push({
      field: `bullets[${i}]`,
      current: clip(bullets[i] ?? ''),
      proposed: `${slot.id} — ${slot.job}`,
      why: `Bullet architecture: slot ${slot.id} does not read as filled (${slot.guidance}). Check that this bullet is doing its declared job rather than repeating another slot's.`,
      severity: 'P2',
    });
  });

  // --- 2. ANCHORS: one per bullet, all distinct. ---
  const anchors = (proposed.bulletAnchors ?? []).map((a) => (a ?? '').trim());
  const filled = anchors.filter((a) => a !== '');
  const distinct = new Set(filled.map((a) => a.toLowerCase()));
  if (anchors.length > 0 && (filled.length < bullets.length || distinct.size < filled.length)) {
    gaps.push({
      field: 'bullets',
      current: 'n/a',
      proposed: anchors.join(' | '),
      why:
        distinct.size < filled.length
          ? 'Bullet architecture: two bullets share a situational anchor — each bullet should anchor a DIFFERENT moment, audience or environment.'
          : 'Bullet architecture: a bullet carries no situational anchor — an unanchored bullet is a claim nothing can quote back to a shopper.',
      severity: 'P2',
    });
  }

  // --- 3. AM-3: the allergen declaration must TRAIL, never lead. ---
  const cp = pack.compliancePack;
  const pos = arch?.allergenPosition;
  if (cp && pos?.mustTrail) {
    const window = pos.leadWindow > 0 ? pos.leadWindow : 40;
    for (const rule of presentAllergens(proposed, cp)) {
      bullets.forEach((bullet, i) => {
        if (!allergenMentioned(bullet, rule, cp)) return;
        const at = declarationStart(bullet, cp);
        // "Leading" = inside the opening window AND in the bullet's first half.
        // The second clause is what keeps a SHORT bullet honest: a 60-char
        // bullet whose declaration starts at character 35 is trailing, even
        // though 35 is inside the window.
        if (at < 0 || at >= window || at >= normalize(bullet).length / 2) return;
        gaps.push({
          field: `bullets[${i}]`,
          current: clip(bullet),
          proposed: `Move the '${rule.canonicalString}' declaration to the END of the bullet as a trailing clause`,
          why: `AM-3: the allergen declaration opens this bullet (character ${at}). The declaration stays required in this bullet — C9 is unchanged — but it belongs in the trailing clause: leading with it turns a benefit slot into a warning label.`,
          severity: 'P1',
        });
      });
    }
  }

  // --- 4. The UNENFORCED direction of C25 (marker without a declared claim). ---
  // Gate C25 enforces claimBearing => marker only; failing the reverse would
  // pressure the generator to DROP markers, so it is reported here instead.
  const marker = pack.rules?.style?.claimMarker?.trim();
  const flags = proposed.bulletClaimBearing;
  if (marker && Array.isArray(flags)) {
    bullets.forEach((bullet, i) => {
      if (!bullet.trimEnd().endsWith(marker)) return;
      if (flags[i] !== false) return;
      gaps.push({
        field: `bullets[${i}]`,
        current: clip(bullet),
        proposed: `Either flag this bullet as claim-bearing or drop the trailing '${marker}'`,
        why: `Claim-marker discipline: this bullet carries the '${marker}' claim marker but was not generated as claim-bearing. Over-disclosure is never blocked — but a marker on a non-claim line trains readers to ignore it.`,
        severity: 'P2',
      });
    });
  }

  return gaps;
}
