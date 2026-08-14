import type {
  Failure,
  ImageArchitecture,
  ImageSpecTokenGroup,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';
import { arr, normalize } from '../util';
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
 * Plus the video brief: present, the pack's aspect RATIO (see `aspectMatches`
 * — the ratio is the fact, the pack's prose word for it is not), and a
 * duration inside the pack's window.
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

/**
 * Every W:H RATIO stated in a frame description, normalised (`09 : 16` ->
 * `9:16`).
 *
 * WHY A RATIO COMPARISON RATHER THAN A SUBSTRING. The pack states the frame as
 * an operator reads it — a ratio plus the prose word for it ("9:16 vertical").
 * The emitted `videoBrief.aspect` is a FIELD WHOSE WHOLE CONTENT IS THE RATIO,
 * so a brief that correctly says "9:16" did not contain the pack's whole
 * string and was reported as the WRONG FRAME on every live run, on all three
 * ASINs — a check demanding a prose token inside a field that carries none.
 * The FACT being checked is the ratio; the prose word is how the pack spells
 * it for a human. So the ratio is what is compared, in both strings, and the
 * pack keeps owning the number.
 *
 * STRICT, NOT LOOSE: EVERY ratio the brief mentions must be the pack's, and it
 * must mention at least one. "16:9 cropped to 9:16" therefore still fails —
 * that is the wide edit the failure text warns about — and so do "1:1", a
 * ratio-free "vertical", and an empty field.
 */
const RATIO_RE = /(\d{1,4})\s*:\s*(\d{1,4})/g;
const ratiosIn = (text: string): string[] =>
  [...normalize(text).matchAll(RATIO_RE)].map(([, w, h]) => `${Number(w)}:${Number(h)}`);

/**
 * Does the emitted frame description state the frame the pack specifies?
 * Exported for the both-direction suite, which drives it with the exact live
 * value ("9:16") as the passing case.
 */
export function aspectMatches(emitted: string, packAspect: string): boolean {
  const wanted = ratiosIn(packAspect);
  // A pack aspect with no ratio in it at all is not a ratio spec; fall back to
  // the containment rule so a pack that spells its frame some other way is
  // still enforced rather than silently unchecked.
  if (wanted.length === 0) {
    return normalize(emitted).toLowerCase().includes(packAspect.trim().toLowerCase());
  }
  const got = ratiosIn(emitted);
  return got.length > 0 && got.every((r) => wanted.includes(r));
}

export function c29ImagePlanContent(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const arch: ImageArchitecture | undefined = pack.rules?.imageArchitecture;
  // Absent architecture => nothing specified to check. Not a silent pass:
  // `rules.imageArchitecture.slots` is a REQUIRED_PACK_PIECES row, so a
  // compliance-bearing pack that ships none already fails CLOSED at PACK.
  if (!arch) return [];

  const out: Failure[] = [];
  const plan = arr<{ slot?: unknown; purpose?: unknown; spec?: unknown; notes?: unknown }>(l.imagePlan);
  const specs = arr<(typeof arch.slots)[number]>(arch.slots).filter((s) => typeof s?.slot === 'number');

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
    for (const group of arr<ImageSpecTokenGroup>(spec.requiredTokens)) {
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
      if (!aspectMatches(str(brief.aspect), video.aspect)) {
        out.push(
          fail(
            C29,
            'videoBrief.aspect',
            str(brief.aspect) || '(empty)',
            `The brief must state the ${video.aspect} frame — a wide edit cropped down is a different shot`,
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
      // STRINGS, not merely non-empty: a shot emitted as a number or an
      // object is malformed output, and coercing it would report the brief as
      // written when nobody could render it.
      const realStrings = (v: unknown): string[] =>
        arr<unknown>(v).filter((x) => typeof x === 'string' && normalize(x).trim() !== '') as string[];
      if (realStrings(brief.shots).length === 0) {
        out.push(fail(C29, 'videoBrief.shots', '(empty)', 'The brief needs a shot list of real strings'));
      }
      if (realStrings(brief.onScreenText).length === 0) {
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
  arr<{ altText?: unknown }>(l.imagePlan).forEach((slot, i) => {
    const raw = slot?.altText;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      out.push(
        fail(
          C30,
          `imagePlan[${i}].altText`,
          `(${typeof raw})`,
          'ALT text must be a string — a non-string value is malformed output, not a short ALT',
        ),
      );
      return;
    }
    const alt = str(raw);
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
  arr<{ bannerAltText?: unknown }>(l.aplusContent?.modules).forEach((m, i) => {
    const alt = m?.bannerAltText;
    if (alt === undefined || alt === null) return;
    if (typeof alt !== 'string') {
      out.push(
        fail(
          C30,
          `aplus.modules[${i}].bannerAltText`,
          `(${typeof alt})`,
          'A+ banner ALT text must be a string — a non-string value is malformed output',
        ),
      );
      return;
    }
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
