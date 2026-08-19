import type { Failure } from '@/lib/types';
import type { GroupName } from './optimize';

/**
 * WHICH GENERATION GROUP OWNS A GATE FAILURE — the repair loop's routing table,
 * lifted out of `repair.ts` so it has ONE home and more than one reader.
 *
 * WHY IT MOVED. A failure whose `field` matches no row here can never be
 * regenerated: the loop adds no group for it, burns every remaining round on
 * the other failures and the run ends `verified:false` on a defect the model
 * could trivially have fixed. That happened live on B00EEEITVA — `videoBrief.*`
 * had no row at all, so a C10 potency-phrasing failure on
 * `videoBrief.onScreenText[1]` was structurally unrepairable while the very
 * same sentence in a bullet was repaired in one round.
 *
 * The table therefore needs an ORACLE (see `tests/repairRouting.oracle.test.ts`,
 * which enumerates every field the gate can emit and asserts each one resolves
 * here), and the audit needs to be able to SAY that a field did not resolve
 * (see `unroutableFailures` below and `lib/audit/buildAudit.ts`). Neither reader
 * can live inside `repair.ts`: it pulls in the whole generator. This module is
 * types-only at compile time and holds no I/O, so anything may read it.
 *
 * It holds NO domain vocabulary — only OUTPUT-CONTRACT field names, which are
 * the same in every category (`tests/category.literals.test.ts`).
 */

/** A routing table is a list of matchers; the FIRST match wins. */
export type FieldRoutingTable = ReadonlyArray<{
  match: (field: string, checkId: string) => boolean;
  group: GroupName;
}>;

/**
 * Explicit ownership table: gate failure field -> prompt group that owns repair.
 *
 * Every row is a PREFIX/EQUALITY test on the output-contract field path the
 * checks emit (see `lib/gate/checks/shared.ts` — `customerSurfaces`,
 * `aplusSurfaces`, `attributeComplianceSurfaces`, `factsComplianceSurfaces` —
 * plus the per-check literals in `c-structure.ts`, `c-images.ts`,
 * `c-keywords.ts` and `a-aplus.ts`).
 */
export const FIELD_TO_GROUP: FieldRoutingTable = [
  { match: (f) => f === 'title' || f === 'title75' || f === 'itemHighlights' || f === 'productName' || f === 'primaryKeyword', group: 'title' },
  { match: (f) => f.startsWith('bullets'), group: 'bullets' },
  { match: (f) => f === 'description', group: 'description' },
  { match: (f) => f === 'backendSearchTerms', group: 'backend' },
  { match: (f) => f === 'attributes' || f.startsWith('attributes.'), group: 'attributes' },
  // `facts.*` is now a scanned surface (C6). The facts block is produced
  // deterministically from the snapshot alongside the attribute group, so the
  // attributes group owns any repair round a facts failure triggers.
  { match: (f) => f === 'facts' || f.startsWith('facts.'), group: 'attributes' },
  { match: (f) => f.startsWith('aplus') || f === 'aplusContent', group: 'aplus' },
  { match: (f) => f.startsWith('imagePlan'), group: 'images' },
  /**
   * THE B00EEEITVA HOLE. `videoBrief` is produced by the IMAGES group — one
   * call returns `{ imagePlan, videoBrief }` (see `optimize.ts` phase 2 and
   * `prompts/images.ts`), so the images group is the only thing that can
   * rewrite a shot list or an on-screen string. Every C29 field
   * (`videoBrief`, `.aspect`, `.durationSeconds`, `.shots`, `.onScreenText`)
   * and every scanned-surface field (`videoBrief.shots[i]`,
   * `videoBrief.onScreenText[i]`, `videoBrief.notes`) is covered by the same
   * prefix.
   */
  { match: (f) => f.startsWith('videoBrief'), group: 'images' },
  { match: (f) => f.startsWith('qa'), group: 'qa' },
  // WS3 — C28 reports against `keywords[i]`; the keyword group owns the repair.
  //
  // N1 — WITH ONE EXCEPTION, WHICH IS RESOLVED ABOVE THIS TABLE. A C28 failure
  // that names an offending SURFACE is about the COPY, not about the row; see
  // `SURFACE_TO_GROUP` and `routeFailure` below. This row still owns every
  // artifact-side C28 failure: an over-declared `placed` row, a `captured-via`
  // row with no route, a `minNegatives` shortfall, an unknown status, an
  // undocumented row.
  { match: (f) => f === 'keywords' || f.startsWith('keywords['), group: 'keywords' },
];

/**
 * WHICH GENERATION GROUP AUTHORS A SCANNED **SURFACE** — the second half of the
 * routing question, and the one the field table cannot answer.
 *
 * ============================================================================
 * THE LIVE DEFECT (B00EEEITVA, N1)
 * ============================================================================
 * One failure, and the run ended `verified:false` with every repair round spent:
 *
 *   C28 | keywords[6] | negative term 'dairy free' appears on 'title'
 *
 * The catch is CORRECT and must stay: the label declares `Contains: Milk`
 * (the strain is grown on a dairy medium) and the generated title claimed
 * "Dairy Free", which is a false allergen claim. What could not happen was the
 * REPAIR. The failure is reported on `keywords[6]` because C28's job is to
 * verify the keyword reference row by row, so the field table above routed it
 * to the `keywords` group — and the keyword group cannot touch the title. The
 * loop rewrote the reference until it ran out of rounds while the offending two
 * words sat in the copy, owned by a group no round ever called.
 *
 * ============================================================================
 * WHY A SECOND TABLE RATHER THAN MORE ROWS IN THE FIRST
 * ============================================================================
 * The two tables answer different questions over different vocabularies.
 * `FIELD_TO_GROUP` maps an OUTPUT-CONTRACT FIELD PATH (`videoBrief.shots[0]`,
 * `aplus.modules[hero].body`) to the group that emits it. This one maps a
 * SURFACE NAME from the keyword rules' own vocabulary (`rules.keywordRules`
 * `visibleSurfaces` / `backendSurfaces`) — `bullet3`, `faq`, `video` — which is
 * what C28 actually holds at the point it fails, and which its surface readers
 * (`keywordSurfaceText`) already resolve to text. Folding one into the other
 * would mean either the check inventing field paths it does not have, or this
 * module guessing which of two vocabularies a string belongs to.
 *
 * IT READS THE STRUCTURED `surface`, NEVER THE PROSE. The surface name is on
 * the `Failure` (see `lib/types.ts`); nothing here parses `context`. A routing
 * table that reads English is a routing table that breaks the day someone
 * rewords a failure message, which is the class of bug this module exists to
 * stop, not to add.
 *
 * NO DOMAIN VOCABULARY, same as the table above: `knowledge/rules.json` ships
 * ONE `keywordRules` block for every category, so these names are as
 * category-independent as `title` and `description` already were.
 */
export type SurfaceRoutingTable = ReadonlyArray<{
  match: (surface: string) => boolean;
  group: GroupName;
}>;

export const SURFACE_TO_GROUP: SurfaceRoutingTable = [
  { match: (s) => s === 'title' || s === 'title75' || s === 'itemHighlights', group: 'title' },
  // The reader resolves `bullet<N>` for any N, so the row does too.
  { match: (s) => s === 'bullets' || /^bullet\d+$/i.test(s), group: 'bullets' },
  { match: (s) => s === 'description', group: 'description' },
  { match: (s) => s === 'backend', group: 'backend' },
  { match: (s) => s === 'attributes', group: 'attributes' },
  // The FAQ is part of the A+ payload (`aplusContent.faq`) and is written by
  // the A+ prompt, so both names route to the one group that can rewrite them.
  { match: (s) => s === 'aplus' || s === 'faq', group: 'aplus' },
  { match: (s) => s === 'qa', group: 'qa' },
  // One images call returns `{ imagePlan, videoBrief }` — the same coupling the
  // `videoBrief` row above records.
  { match: (s) => s === 'images' || s === 'video', group: 'images' },
];

/** The group that authors a surface, or null when this module has no row. */
export function surfaceToGroup(
  surface: string | null | undefined,
  table: SurfaceRoutingTable = SURFACE_TO_GROUP,
): GroupName | null {
  const name = String(surface ?? '').trim();
  if (!name) return null;
  return table.find((r) => r.match(name))?.group ?? null;
}

/**
 * FAILURES NOTHING CAN REGENERATE — stated, not left to fall off the end.
 *
 * These are the failures for which "no owning group" is the CORRECT answer.
 * Each row carries the reason, because the difference between this list and an
 * accidental omission is the entire defect this module exists to prevent: an
 * omission looks exactly like a deliberate exclusion at the call site, and the
 * loop spins either way. Anything matching a row here is reported as a
 * terminal, non-regenerable failure; anything matching NEITHER list is a
 * ROUTING GAP and is reported as one.
 *
 * Nothing here makes a failure disappear. Every one of them is still a gate
 * failure, so `verified` (which is exactly `gateResult.pass`) is still false.
 */
export const NOT_REGENERABLE: ReadonlyArray<{
  id: string;
  match: (field: string, checkId: string) => boolean;
  why: string;
}> = [
  {
    id: 'PACK',
    match: (_f, checkId) => checkId === 'PACK',
    why: 'A pack gap is a defect in the KNOWLEDGE, not in the copy — no generator can produce the missing pack piece, so the loop short-circuits instead of regenerating.',
  },
  {
    id: 'GATE',
    match: (_f, checkId) => checkId === 'GATE',
    why: 'The named check THREW instead of returning a verdict. That is a bug in the checker, not in the copy — regenerating would ask the model to fix our code.',
  },
  {
    id: 'GEN',
    match: (f) => f.startsWith('generation.'),
    why: 'The group already failed twice inside its own generation boundary (see `genDegradedGroups` in lib/gate/checks/c-structure.ts). Spending repair rounds on it is how a run walks into the platform duration ceiling.',
  },
  {
    id: 'disclaimer',
    match: (f) => f === 'fdaDisclaimer' || f === 'aplus.fdaDisclaimer',
    why: 'The disclaimer is CODE-inserted verbatim from the pack and the model is explicitly forbidden to write it, so no regeneration round can change this field. A failure here means the pack constant and the emitted constant disagree.',
  },
];

/** What the repair loop should do with one failure. */
export type RepairRoute =
  | { kind: 'group'; group: GroupName }
  | { kind: 'not-regenerable'; id: string; why: string }
  | { kind: 'unroutable' };

/**
 * Route ONE failure.
 *
 * `table` is injectable so the oracle can prove it is not vacuous: run the same
 * resolution with a row deleted and the field it covered must come back
 * `unroutable`. Production callers never pass it.
 */
export function routeFailure(
  failure: Failure,
  table: FieldRoutingTable = FIELD_TO_GROUP,
  surfaceTable: SurfaceRoutingTable = SURFACE_TO_GROUP,
): RepairRoute {
  const field = String(failure?.field ?? '');
  const checkId = String(failure?.checkId ?? '');
  // The documented exclusions are consulted FIRST: `aplus.fdaDisclaimer` would
  // otherwise be swallowed by the `aplus` prefix row and burn rounds on a field
  // the model is forbidden to write.
  const excluded = NOT_REGENERABLE.find((r) => r.match(field, checkId));
  if (excluded) return { kind: 'not-regenerable', id: excluded.id, why: excluded.why };
  /**
   * N1 — A FAILURE THAT NAMES AN OFFENDING SURFACE IS ROUTED BY THAT SURFACE.
   *
   * Consulted BEFORE the field table, because the whole point is that `field`
   * gives the WRONG answer for these: `keywords[6]` resolves perfectly well to
   * the keyword group, and that is precisely the loop that never converged.
   * Only a check that knows its `field` is not the thing to rewrite sets
   * `surface` at all (today: C28's `negative` leg and its automatic
   * rival-brand leg), so no existing failure changes route.
   *
   * INSTEAD OF THE FIELD'S GROUP, NOT IN ADDITION TO IT — deliberately:
   *
   *  1. `RepairRoute` names ONE owner, and the loop feeds the failure's text
   *     into THAT group's regeneration prompt. Handing "remove 'dairy free'
   *     from the title" to the keyword prompt as well asks the reference author
   *     to do something it cannot do, which is how a prompt earns a confidently
   *     wrong edit.
   *  2. The reference is re-read anyway. `runRepairLoop`'s WS3 coupling adds
   *     the `keywords` group to any round that regenerates ANY copy group, and
   *     `optimize()` re-derives every row's placement from the copy that
   *     actually ships on every round. So the artifact is rebuilt against the
   *     repaired title in the SAME round — "in addition" without a second
   *     owner, and without a second concept in this module.
   *
   * A surface this module cannot map is `unroutable`, NOT a silent fall-back to
   * the field row. Falling back would reinstate exactly the non-converging loop
   * this exists to end, and would do it invisibly; `unroutable` is reported by
   * `unroutableFailures`, by the audit and on the ship sheet. A pack that adds a
   * surface therefore has to add a row here, and the oracle asserts every
   * surface the shipped pack declares already has one.
   */
  const surface = String(failure?.surface ?? '').trim();
  if (surface) {
    const group = surfaceToGroup(surface, surfaceTable);
    return group ? { kind: 'group', group } : { kind: 'unroutable' };
  }
  const row = table.find((r) => r.match(field, checkId));
  return row ? { kind: 'group', group: row.group } : { kind: 'unroutable' };
}

/** The owning group, or null when nothing regenerable owns the failure. */
export function fieldToGroup(
  failure: Failure,
  table: FieldRoutingTable = FIELD_TO_GROUP,
  surfaceTable: SurfaceRoutingTable = SURFACE_TO_GROUP,
): GroupName | null {
  const route = routeFailure(failure, table, surfaceTable);
  return route.kind === 'group' ? route.group : null;
}

/** One routing gap, in the shape the audit and the exporters report it. */
export interface RoutingGap {
  checkId: string;
  field: string;
}

/**
 * The failures that resolve to NEITHER a generation group NOR a documented
 * non-regenerable class — i.e. the bug class this module exists to name.
 *
 * Deduplicated on `checkId:field` so a check that fires on twenty rows of the
 * same surface reports one gap, not twenty.
 */
export function unroutableFailures(
  failures: readonly Failure[] | null | undefined,
  table: FieldRoutingTable = FIELD_TO_GROUP,
  surfaceTable: SurfaceRoutingTable = SURFACE_TO_GROUP,
): RoutingGap[] {
  const out = new Map<string, RoutingGap>();
  for (const f of Array.isArray(failures) ? failures : []) {
    if (routeFailure(f, table, surfaceTable).kind !== 'unroutable') continue;
    const gap = { checkId: String(f?.checkId ?? ''), field: String(f?.field ?? '') };
    out.set(`${gap.checkId}:${gap.field}`, gap);
  }
  return [...out.values()];
}
