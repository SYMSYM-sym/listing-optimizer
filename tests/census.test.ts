import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGate } from '@/lib/gate/runGate';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { GateContext } from '@/lib/gate/checks';
import type { OptimizedListing } from '@/lib/types';

/**
 * THE CHECK-ID CENSUS IS PINNED TO THE WIRING.
 *
 * `CONFORMANCE-DEVIATIONS.md` §4.1 claims authority over which check ids this
 * app runs and how many there are. It was WRONG: it said "total distinct ids
 * 40" and omitted `GEN` entirely — the D1 fail-closed check that turns a
 * degraded generation group into a blocking failure — which had been wired into
 * `runGate` without the census being updated. A count that lives only in prose
 * goes stale exactly the way a coverage claim in a commit message does (§1 of
 * that file records that lesson about C28 and the ALT surfaces).
 *
 * So the census is DERIVED here, from the `guarded('…')` rows in
 * `lib/gate/runGate.ts`, and this test fails if the document and the code
 * disagree about any of it. Adding a check now forces the document to change in
 * the same commit.
 *
 * `GATE` is the one id that is deliberately NOT in the wiring: it is emitted BY
 * the boundary when a check throws. It is asserted separately, and asserted to
 * be reachable rather than merely mentioned.
 */

const ROOT = join(process.cwd());
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const RUN_GATE = src('lib/gate/runGate.ts');
const DOC = src('CONFORMANCE-DEVIATIONS.md');

/** Every id `runGate` wires, in wiring order, read off the source. */
const wired: string[] = [...RUN_GATE.matchAll(/guarded\(\s*'([A-Z0-9]+)'/g)].map((m) => m[1]!);

const numbered = (prefix: string): number[] =>
  wired
    .filter((id) => new RegExp(`^${prefix}\\d+$`).test(id))
    .map((id) => Number(id.slice(prefix.length)))
    .sort((a, b) => a - b);

const cNumbers = numbered('C');
const aNumbers = numbered('A');
const nonNumbered = wired.filter((id) => !/^[CA]\d+$/.test(id));

/** The boundary id. Not wired — produced by `guarded` itself. */
const BOUNDARY_ID = 'GATE';
const TOTAL = wired.length + 1;

describe('the check-id census matches the gate wiring', () => {
  it('every wired id is unique — a duplicated row would double-count a check', () => {
    expect(new Set(wired).size).toBe(wired.length);
  });

  it('the C family is exactly C1–C12 + C15–C31, with the C13/C14 gap intact', () => {
    const expected = [
      ...Array.from({ length: 12 }, (_, i) => i + 1),
      ...Array.from({ length: 17 }, (_, i) => i + 15),
    ];
    expect(cNumbers).toEqual(expected);
    expect(cNumbers).toHaveLength(29);
    expect(cNumbers).not.toContain(13);
    expect(cNumbers).not.toContain(14);
  });

  it('the A family is exactly A1–A9', () => {
    expect(aNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('the non-numbered wired ids are exactly PACK and GEN, and both come FIRST (fail-closed)', () => {
    expect(nonNumbered.sort()).toEqual(['GEN', 'PACK']);
    expect(wired[0]).toBe('PACK');
    expect(wired[1]).toBe('GEN');
  });

  it('GATE is emitted by the boundary, not wired — and it really is reachable', () => {
    expect(wired).not.toContain(BOUNDARY_ID);
    expect(RUN_GATE).toContain(`checkId: '${BOUNDARY_ID}'`);
    // Reachable, not merely mentioned: a pack whose shape makes a check throw
    // must come back as a blocking GATE failure rather than as an exception.
    const pack = loadPack('supplements');
    const hostile = { ...pack, rules: null } as unknown as typeof pack;
    const ctx: GateContext = { subcategories: [] };
    const result = runGate({} as OptimizedListing, hostile, ctx);
    expect(result.pass).toBe(false);
    const boundary = result.failures.filter((f) => f.checkId === BOUNDARY_ID);
    expect(boundary.length, JSON.stringify(result.failures.map((f) => f.checkId))).toBeGreaterThan(0);
    // It NAMES the check that threw, so nobody tries to fix the copy in response
    // to a bug in the checker, and it says the run is unverified.
    expect(wired).toContain(boundary[0]!.field);
    expect(boundary[0]!.fix).toContain('UNVERIFIED');
  });

  it('the TOTAL is 41 — 29 + 9 + PACK + GEN + GATE', () => {
    expect(TOTAL).toBe(41);
    expect(cNumbers.length + aNumbers.length + nonNumbered.length + 1).toBe(TOTAL);
  });
});

describe('CONFORMANCE-DEVIATIONS.md §4.1 states the census the code actually has', () => {
  it('the family counts in the table are the derived ones', () => {
    expect(DOC).toContain(`| C-checks | \`C1\`–\`C12\`, \`C15\`–\`C31\` | **${cNumbers.length}** |`);
    expect(DOC).toContain(`| A-checks (A+ content) | \`A1\`–\`A9\` | **${aNumbers.length}** |`);
    expect(DOC).toContain(`| **total distinct ids** | | **${TOTAL}** |`);
  });

  it('every non-numbered id has its own row in the table — GEN included', () => {
    for (const id of [...nonNumbered, BOUNDARY_ID]) {
      expect(DOC, id).toMatch(new RegExp(`\\|[^|\\n]*\\| \`${id}\` \\| 1 \\|`));
    }
  });

  it('the stale number is gone', () => {
    expect(DOC).not.toContain('| **total distinct ids** | | **40** |');
  });
});
