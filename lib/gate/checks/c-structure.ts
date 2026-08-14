import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import { fail } from './shared';

/**
 * C20 — STRUCTURAL COMPLETENESS of the output contract.
 *
 * Every other check reads a surface; none of them noticed when a whole surface
 * was simply ABSENT. A listing with `qa: undefined`, an empty `imagePlan`, no
 * `attributes` or an `aplusContent` without modules therefore returned
 * `pass:true` with zero signal — the deliverable was empty, not compliant.
 * (Before the null-safety pass it was worse: those shapes made `runGate`
 * THROW, which is a fail-OPEN in practice because the caller never receives a
 * `verified:false`.)
 *
 * This check is deliberately SHAPE-only: it asserts presence and non-emptiness
 * of the contract's required collections and identity strings. It says nothing
 * about how GOOD the content is — the quality floors live in C1-C19/A1-A9.
 * It also does NOT enforce the "~15 Q&A / ~7 image slots" guidance, because
 * those are targets in the contract, not hard limits.
 */
const CHECK_ID = 'C20';

const blank = (v: unknown): boolean => !normalize(typeof v === 'string' ? v : v == null ? '' : String(v));

export function c20Structure(l: OptimizedListing, _pack: KnowledgePack): Failure[] {
  const out: Failure[] = [];

  for (const key of ['productName', 'primaryKeyword'] as const) {
    if (blank(l[key])) {
      out.push(fail(CHECK_ID, key, '(empty)', `${key} is missing — the contract requires it on every listing`));
    }
  }

  const attributes = l.attributes;
  if (!attributes || typeof attributes !== 'object' || Object.keys(attributes).length === 0) {
    out.push(fail(CHECK_ID, 'attributes', '(empty)', 'The structured attribute set is missing or empty'));
  }

  if (!l.facts || typeof l.facts !== 'object') {
    out.push(fail(CHECK_ID, 'facts', '(missing)', 'The canonical facts block is missing — C12 has nothing to compare against'));
  }

  const qa = l.qa;
  if (!Array.isArray(qa) || qa.length === 0) {
    out.push(fail(CHECK_ID, 'qa', '(empty)', 'The Q&A layer is missing or empty'));
  } else {
    qa.forEach((item, i) => {
      if (!item || blank(item.q) || blank(item.a)) {
        out.push(fail(CHECK_ID, `qa[${i}]`, '(empty)', 'Every Q&A pair needs a real question and a real answer'));
      }
    });
  }

  const imagePlan = l.imagePlan;
  if (!Array.isArray(imagePlan) || imagePlan.length === 0) {
    out.push(fail(CHECK_ID, 'imagePlan', '(empty)', 'The image plan is missing or empty'));
  } else {
    imagePlan.forEach((slot, i) => {
      if (!slot || blank(slot.purpose) || blank(slot.spec)) {
        out.push(fail(CHECK_ID, `imagePlan[${i}]`, '(empty)', 'Every image slot needs a purpose and a spec'));
      }
    });
  }

  const a = l.aplusContent;
  if (!a || typeof a !== 'object') {
    out.push(fail(CHECK_ID, 'aplusContent', '(missing)', 'A+ content is missing entirely'));
    return out;
  }
  if (!Array.isArray(a.modules) || a.modules.length === 0) {
    out.push(fail(CHECK_ID, 'aplusContent', 'no modules', 'A+ content must contain real-text modules'));
  }
  if (!Array.isArray(a.faq) || a.faq.length === 0) {
    out.push(fail(CHECK_ID, 'aplusContent', 'no faq', 'A+ content must contain an FAQ block'));
  }
  if (!a.comparison || !Array.isArray(a.comparison.rows)) {
    out.push(fail(CHECK_ID, 'aplusContent', 'no comparison', 'A+ content must contain a comparison block'));
  }
  return out;
}

/**
 * GEN — a generation GROUP that could not be produced (D1).
 *
 * WHY THIS CHECK EXISTS. Until D1, a group whose output was truncated or
 * unparseable after its reparse retry threw out of the engine and the route
 * answered 502: three live ASINs, eight attempts, eight 502s and not one
 * report. Losing the whole run over one group is the wrong trade — the
 * operator wants the seven groups that DID come back, plus the truth about the
 * one that did not. So the engine degrades the group and records its name on
 * `degradedGroups`.
 *
 * The moment it does that, "the run completed" stops meaning "the run is
 * complete", and the ONLY thing standing between a crashed group and a
 * `verified:true` is this check. It is therefore blocking, it names the group,
 * and it holds no opinion about which groups matter: any degraded group fails
 * the run. In particular the keyword artifact is BOTH an advisory deliverable
 * AND the input to C28, so a keywords group that died must never be able to
 * present itself as a listing with nothing to check — C28 reports the empty
 * artifact, and this check reports why it is empty.
 *
 * It is deliberately NOT repairable by regeneration (`fieldToGroup` maps no
 * field of the form `generation.*`): the group already had its two attempts
 * inside the boundary, and spending repair rounds — each one a fresh set of
 * LLM calls — on a group that has just failed twice is how a run walks into
 * the platform's own duration ceiling and 502s anyway.
 */
export function genDegradedGroups(l: OptimizedListing): Failure[] {
  const groups = Array.isArray(l.degradedGroups) ? l.degradedGroups : [];
  return groups
    .map((g) => normalize(typeof g === 'string' ? g : String(g ?? '')).trim())
    .filter((g) => g !== '')
    .map((g) =>
      fail(
        'GEN',
        `generation.${g}`,
        '(no valid output)',
        `The '${g}' group returned nothing this run could validate, so that part of the listing is missing or stale. The run is UNVERIFIED by construction — re-run it, and if it repeats, the group's prompt and schema disagree or its output budget is too small for the artifact it asks for`,
      ),
    );
}
