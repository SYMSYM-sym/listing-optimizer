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
  { match: (f) => f === 'keywords' || f.startsWith('keywords['), group: 'keywords' },
];

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
): RepairRoute {
  const field = String(failure?.field ?? '');
  const checkId = String(failure?.checkId ?? '');
  // The documented exclusions are consulted FIRST: `aplus.fdaDisclaimer` would
  // otherwise be swallowed by the `aplus` prefix row and burn rounds on a field
  // the model is forbidden to write.
  const excluded = NOT_REGENERABLE.find((r) => r.match(field, checkId));
  if (excluded) return { kind: 'not-regenerable', id: excluded.id, why: excluded.why };
  const row = table.find((r) => r.match(field, checkId));
  return row ? { kind: 'group', group: row.group } : { kind: 'unroutable' };
}

/** The owning group, or null when nothing regenerable owns the failure. */
export function fieldToGroup(
  failure: Failure,
  table: FieldRoutingTable = FIELD_TO_GROUP,
): GroupName | null {
  const route = routeFailure(failure, table);
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
): RoutingGap[] {
  const out = new Map<string, RoutingGap>();
  for (const f of Array.isArray(failures) ? failures : []) {
    if (routeFailure(f, table).kind !== 'unroutable') continue;
    const gap = { checkId: String(f?.checkId ?? ''), field: String(f?.field ?? '') };
    out.set(`${gap.checkId}:${gap.field}`, gap);
  }
  return [...out.values()];
}
