import type {
  Failure,
  ImageArchitecture,
  ImageSpecTokenGroup,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';
import { normalize } from '../util';
import { fail } from './shared';

/**
 * C29 — IMAGE PLAN and VIDEO BRIEF *CONTENT* (WS8).
 *
 * WHY A CONTENT CHECK, when C20 already asserts the plan is non-empty. C20 is
 * shape: it knows a slot has a purpose and a spec. It cannot know whether the
 * spec SAYS anything. A brief for the main image reading "nice product shot,
 * good lighting" satisfies every structural rule in the system and renders an
 * image the marketplace rejects — and the two briefs where that matters most
 * are the two the playbook says may NEVER be AI-generated or AI-altered: the
 * main bottle photograph and the printed facts panel. The panel is a
 * compliance document and the anchor the marketplace's multimodal scan
 * compares the copy against; "never AI-generated" living only in a prompt is
 * an instruction, and an instruction is not a check.
 *
 * WHAT IT ASSERTS. For every slot the PACK specifies:
 *  - the slot exists in the emitted plan;
 *  - the emitted brief satisfies EVERY `requiredTokens` group on that slot,
 *    where a group is satisfied by ANY of its accepted spellings. The text
 *    searched is purpose + spec + notes together, because an operator reads
 *    the card, not one field of it.
 * Plus the video brief: present, the pack's aspect, and a duration inside the
 * pack's window.
 *
 * WHAT IT DOES NOT ASSERT. Nothing about slots the pack gives no tokens for,
 * and nothing about how GOOD a brief is. A token list is a floor.
 *
 * PACK-DRIVEN: every slot, token and bound comes from
 * `rules.imageArchitecture`; this module holds no spec literal.
 */
const C29 = 'C29';
const C30 = 'C30';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Case-folded haystack for one slot: the whole card, not one field of it. */
const slotText = (s: { purpose?: unknown; spec?: unknown; notes?: unknown }): string =>
  normalize(`${str(s?.purpose)} ${str(s?.spec)} ${str(s?.notes)}`).toLowerCase();

const groupSatisfied = (hay: string, group: ImageSpecTokenGroup): boolean =>
  (group?.anyOf ?? []).some((token) => {
    const t = normalize(String(token ?? '')).toLowerCase();
    return t !== '' && hay.includes(t);
  });

export function c29ImagePlanContent(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const arch: ImageArchitecture | undefined = pack.rules?.imageArchitecture;
  // Absent architecture => nothing specified to check. Not a silent pass:
  // `rules.imageArchitecture.slots` is a REQUIRED_PACK_PIECES row, so a
  // compliance-bearing pack that ships none already fails CLOSED at PACK.
  if (!arch) return [];

  const out: Failure[] = [];
  const plan = Array.isArray(l.imagePlan) ? l.imagePlan : [];
  const specs = (arch.slots ?? []).filter((s) => typeof s?.slot === 'number');

  if (specs.length > 0 && plan.length !== specs.length) {
    out.push(
      fail(
        C29,
        'imagePlan',
        `${plan.length} slot(s)`,
        `The visual pack is ${specs.length} slots — produce every one; a missing slot is an unfilled deliverable, not a shorter plan`,
      ),
    );
  }

  for (const spec of specs) {
    const emitted = plan.find((s) => Number(s?.slot) === spec.slot);
    if (!emitted) {
      out.push(
        fail(
          C29,
          `imagePlan[slot ${spec.slot}]`,
          '(missing)',
          `Slot ${spec.slot} (${spec.purpose}) is not in the plan — write its brief`,
        ),
      );
      continue;
    }
    const hay = slotText(emitted);
    for (const group of spec.requiredTokens ?? []) {
      if (!groupSatisfied(hay, group)) {
        out.push(
          fail(
            C29,
            `imagePlan[slot ${spec.slot}]`,
            `missing requirement: ${group.label}`,
            `Slot ${spec.slot} (${spec.purpose}) must state "${group.label}" in its brief — accepted wordings: ${(group.anyOf ?? []).join(', ')}. A requirement nobody wrote down is a requirement nobody renders`,
          ),
        );
      }
    }
  }

  // --- the video brief ---
  const video = arch.video;
  if (video?.aspect) {
    const brief = l.videoBrief;
    if (!brief || typeof brief !== 'object') {
      out.push(
        fail(
          C29,
          'videoBrief',
          '(missing)',
          `The visual pack includes a ${video.aspect} video brief — produce it alongside the still slots`,
        ),
      );
    } else {
      if (!normalize(str(brief.aspect)).toLowerCase().includes(video.aspect.toLowerCase())) {
        out.push(
          fail(
            C29,
            'videoBrief.aspect',
            str(brief.aspect) || '(empty)',
            `The brief must be for a ${video.aspect} frame — a wide edit cropped down is a different shot`,
          ),
        );
      }
      const seconds = Number(brief.durationSeconds);
      if (!Number.isFinite(seconds) || seconds < video.minSeconds || seconds > video.maxSeconds) {
        out.push(
          fail(
            C29,
            'videoBrief.durationSeconds',
            String(brief.durationSeconds ?? '(none)'),
            `Duration must be between ${video.minSeconds} and ${video.maxSeconds} seconds`,
          ),
        );
      }
      if (!Array.isArray(brief.shots) || brief.shots.filter((b) => normalize(str(b))).length === 0) {
        out.push(fail(C29, 'videoBrief.shots', '(empty)', 'The brief needs a shot list'));
      }
      if (
        !Array.isArray(brief.onScreenText) ||
        brief.onScreenText.filter((t) => normalize(str(t))).length === 0
      ) {
        out.push(
          fail(
            C29,
            'videoBrief.onScreenText',
            '(empty)',
            'List every on-screen string: it is watched muted, so the text carries the message — and it is scanned like a bullet',
          ),
        );
      }
    }
  }

  return out;
}

/**
 * C30 — ALT TEXT length (WS8).
 *
 * ALT is capped at `rules.imageArchitecture.altMax` characters per image and
 * is the one customer-facing surface that is invisible on the page — which is
 * exactly why a stale agency template naming a rival brand survives there for
 * years. Its CONTENT is scanned by the ordinary customer-surface checks
 * (C6/C17/C18/C19/C27 and the C28 negative list); this check owns the one
 * property none of them measures: the cap, and that the field was written at
 * all. An empty ALT is not "within the cap", it is an unfilled deliverable.
 *
 * A+ banner ALT rides the same cap and the same check, because it is the same
 * field on a different surface.
 */
export function c30ImageAltText(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const arch = pack.rules?.imageArchitecture;
  const max = arch?.altMax;
  if (!arch || typeof max !== 'number' || max <= 0) return [];

  const out: Failure[] = [];
  (Array.isArray(l.imagePlan) ? l.imagePlan : []).forEach((slot, i) => {
    const alt = str(slot?.altText);
    if (!normalize(alt)) {
      out.push(
        fail(
          C30,
          `imagePlan[${i}].altText`,
          '(empty)',
          `Every image needs paste-ready ALT text (≤${max} chars) — an empty ALT is an unfilled field, and it is where a stale template's rival brand name hides`,
        ),
      );
      return;
    }
    if (alt.length > max) {
      out.push(
        fail(
          C30,
          `imagePlan[${i}].altText`,
          `${alt.length} chars`,
          `Shorten the ALT text to ≤${max} chars`,
        ),
      );
    }
  });

  // A+ banner ALT is OPTIONAL (a text-only module has no banner), but a
  // present one is held to the same cap.
  (l.aplusContent?.modules ?? []).forEach((m, i) => {
    const alt = m?.bannerAltText;
    if (alt === undefined || alt === null) return;
    if (String(alt).length > max) {
      out.push(
        fail(
          C30,
          `aplus.modules[${i}].bannerAltText`,
          `${String(alt).length} chars`,
          `A+ banner ALT text rides the same ${max}-char cap as a gallery image — shorten it`,
        ),
      );
    }
  });

  return out;
}
