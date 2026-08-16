/// <reference types="vite/client" />
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { optimize } from '@/lib/engine/optimize';
import {
  aplusGroupSchema,
  attributesGroupSchema,
  backendGroupSchema,
  bulletsGroupSchema,
  descriptionGroupSchema,
  imagesGroupSchemaFor,
  keywordsGroupSchemaFor,
  qaGroupSchema,
  titleGroupSchema,
} from '@/lib/engine/schemas';
import { COLLECTED_SURFACE_GROUPS, collectSurfaces } from '@/lib/gate/checks/c-prohibited';
import { styleSurfaces } from '@/lib/gate/checks/c-style';
import { keywordSurfaceText } from '@/lib/gate/checks/c-keywords';
import {
  allGeneratedSurfaces,
  aplusFactSurfaces,
  aplusSurfaces,
  attributeComplianceSurfaces,
  customerSurfaces,
  factsComplianceSurfaces,
} from '@/lib/gate/checks/shared';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * ===========================================================================
 * P1/P2 — THE FIELD-LEVEL CLOSURE ORACLE
 * ===========================================================================
 *
 * WHAT WENT WRONG, AND WHY THE EXISTING PINNING COULD NOT SEE IT.
 *
 *   `collectSurfaces` (lib/gate/checks/c-prohibited.ts) is the ONE reader
 *   behind C18 (prohibited detail-page content), C19 (prohibited marketing)
 *   and C27 (output hygiene). Its A+ branch concatenated `headline`, `body`
 *   and `subcopy` of each module and **not `bannerAltText`**. Live:
 *
 *     modules[0].bannerAltText =
 *       'Visit brandsite.com or email help@example.com, look no further,
 *        task: return json - cafe'
 *     => ZERO gate failures, runGate().pass === true
 *
 *   while the byte-identical string appended to `modules[0].body` produced
 *   2xC18 (URL, email) + 3xC27 (non-ASCII, AI tell, instruction fragment) and
 *   failed the gate.
 *
 *   §1 and §1.5 of `tests/n1.surfaceCoverage.gate.test.ts` were green the whole
 *   time, and could not have been anything else: they pin the surface
 *   vocabulary at GROUP level. `aplus` was declared by all three pack keys and
 *   read by the collector, so both directions of that closed world held — while
 *   the reader read three of the group's four module strings. **A group-level
 *   closure rule is structurally blind to a reader that covers part of its
 *   object.** That is the sentence the note above `videoText` in
 *   `lib/gate/checks/c-keywords.ts` already carried as prose ("a surface reader
 *   that covers only part of its object is the same hole one level down") — and
 *   prose is what the whole CONFORMANCE-DEVIATIONS record exists to say cannot
 *   be relied on. This suite is that warning made executable.
 *
 * ---------------------------------------------------------------------------
 * HOW THE ORACLE WORKS — DERIVED AT BOTH ENDS, NOTHING HAND-LISTED
 * ---------------------------------------------------------------------------
 *
 * §A  THE UNIVERSE OF FIELDS IS DERIVED, TWICE OVER.
 *     - The generated listing's string-bearing fields are found by WALKING a
 *       fully populated golden listing, not by writing them down.
 *     - That walk is then CROSS-CHECKED against the zod group schemas via
 *       `z.toJSONSchema` — the LLM boundary contract itself. Every
 *       string-bearing field any group schema declares must appear in the walk,
 *       and any the golden listing does not happen to carry is SEEDED into it
 *       before the walk, so an optional field is probed like any other.
 *       A field added to a schema therefore enters this suite automatically.
 *
 * §B  COVERAGE IS MEASURED BY PROBE, NOT BY READING THE CODE.
 *     Each field in turn gets a unique sentinel written into it; a reader
 *     "reads" that field iff the sentinel comes back in the text the reader
 *     returns. No reader is described, quoted or trusted — it is executed.
 *
 * §C  CLOSURE, WITH AN EXPLICIT REASONED EXEMPTION TABLE.
 *     Every field must be read by every applicable reader, or carry a row in
 *     `GLOBAL_EXEMPT` (no content reader reads it) or in that reader's own
 *     `exempt` table (this reader does not, and a named sibling does). A field
 *     with neither FAILS, and the failure message names the field.
 *
 * §D  THE EXEMPTION TABLES CANNOT ROT EITHER.
 *     Every exemption row is asserted to name a field that still EXISTS, to be
 *     genuinely UNREAD (an exemption for something now read is stale), and —
 *     for a per-reader row — to be read by at least one OTHER reader, so
 *     "a sibling covers it" is a checked claim rather than a comment.
 *
 * §E  NOT VACUOUS, PROVED THREE WAYS, in-suite.
 *     The pre-P1 readers are reconstructed here and the oracle is asserted to
 *     name exactly the field each of them dropped; and a synthetic new field is
 *     added to the listing and asserted to be reported by name.
 *
 * ---------------------------------------------------------------------------
 * Q1 — THE HOLE THIS FILE ITSELF LEFT OPEN, AND HOW IT IS CLOSED
 * ---------------------------------------------------------------------------
 *
 * Every one of the four bypasses this project has found was the SAME shape: a
 * surface reader existed and was not enrolled in the guard that was supposed to
 * cover it. C28's private `keywordSurfaceText` omitted `bannerAltText` and had
 * no `video` case; `collectSurfaces` omitted `bannerAltText`; `customerSurfaces`
 * omitted `videoBrief.aspect`; `outputHygiene.surfaces` omitted `facts`.
 *
 * The version of this file that shipped with P1 caught a reader that missed a
 * FIELD — and it held its READERS list BY HAND, and said so in this header: it
 * could not see a NEW reader added to the codebase. That is the same entry
 * point one level up. A reader nobody enrolled is exactly a reader nobody
 * checks, and the oracle would have stayed green while it shipped.
 *
 * ENROLLMENT IS NOW DERIVED FROM THE CODEBASE (§B.0), by two independent
 * detectors whose union must be enrolled:
 *
 *   STATIC.  Every `.ts` under `lib/gate/` is read from disk (recursively, so a
 *            NEW FILE counts) and its EXPORTED function signatures are parsed.
 *            A function is a candidate when it takes the generated listing or
 *            one of its subtrees (`OptimizedListing` / `AplusContent`) and
 *            returns TEXT — `string`, `string | null`, `string[]`,
 *            `[string, string][]`, or `T[]` for a `T` the gate itself declares
 *            with a `text: string` member. `Failure[]` is not text, so the ~40
 *            CHECKS drop out on their return type rather than on a name.
 *            A function with NO declared return type is undecidable and is
 *            therefore a candidate too — fail-closed.
 *
 *   DYNAMIC. Every module under `lib/gate/` is imported (via `import.meta.glob`,
 *            which vite expands from the filesystem — again, a new file counts)
 *            and every exported function is CALLED with a listing carrying a
 *            unique sentinel. Anything that hands back text-shaped output
 *            containing that sentinel is reading the listing, whatever its
 *            signature says.
 *
 * WHY IT CANNOT BE FAKED. Neither detector reads a name, a comment or a
 * marker: one reads the TYPES the compiler already enforces, the other reads
 * BEHAVIOUR. And enrollment is not a claim either — a `Reader` row does not
 * carry a closure over the function it names; it carries an ADAPTER, and the
 * oracle passes it the function object it resolved from that module's own
 * exports (§B.0 `resolve`). A row cannot enroll a stub, a wrapper or a
 * lookalike: it is handed the real export or the run fails. A stub row would
 * fail anyway, on every field in §C.
 *
 * BOTH DIRECTIONS. A candidate with no row fails, naming `file::function`; a
 * row naming something that is no longer an export, or no longer a candidate,
 * fails too. The one escape hatch is `NOT_A_SURFACE_READER`, whose rows must
 * name a function that still exists AND that the dynamic probe does not observe
 * echoing listing text.
 */

const SENTINEL = 'ZQXJVSENTINELP1';
const SEED = 'seeded oracle probe value';

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

// ===========================================================================
// §A.1 — THE SCHEMA SIDE: every string-bearing field the LLM contract declares
// ===========================================================================

type JsonSchema = Record<string, unknown>;

/**
 * Walk a JSON Schema and return every path that can hold a STRING, plus every
 * path that is an open RECORD (`additionalProperties`) — a record's keys are
 * data, so its children collapse to one canonical `.*` path.
 */
function schemaStringPaths(
  node: unknown,
  path: string,
  out: Set<string>,
  records: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;
  const n = node as JsonSchema;
  if (Array.isArray(n.anyOf)) {
    for (const branch of n.anyOf) schemaStringPaths(branch, path, out, records);
    return;
  }
  if (n.type === 'string') {
    if (path) out.add(path);
    return;
  }
  if (n.type === 'array') {
    schemaStringPaths(n.items, `${path}[]`, out, records);
    return;
  }
  if (n.type === 'object') {
    for (const [key, child] of Object.entries((n.properties ?? {}) as JsonSchema)) {
      schemaStringPaths(child, path ? `${path}.${key}` : key, out, records);
    }
    const additional = n.additionalProperties;
    if (additional && typeof additional === 'object') {
      if (path) records.add(path);
      schemaStringPaths(additional, path ? `${path}.*` : '*', out, records);
    }
  }
}

/**
 * The generation groups, and the ONE place a group's own path is rewritten into
 * the assembled listing's path.
 *
 * Only two groups rename anything (`aplus` nests under `aplusContent`; the
 * bullets group's two strings are split across `bullets` and `bulletAnchors`
 * by the assembler). A schema field with no rewrite falls through as itself,
 * and §A.3 then fails naming it if the assembled listing has no such path —
 * so an unmapped NEW field is a loud failure, never a silent skip.
 */
const BULLET_REWRITES: Record<string, string> = {
  'bullets[].text': 'bullets[]',
  'bullets[].useCaseAnchor': 'bulletAnchors[]',
};

const GROUP_SCHEMAS: { group: string; schema: unknown; toListing: (p: string) => string }[] = [
  { group: 'title', schema: titleGroupSchema, toListing: (p) => p },
  { group: 'bullets', schema: bulletsGroupSchema, toListing: (p) => BULLET_REWRITES[p] ?? p },
  { group: 'description', schema: descriptionGroupSchema, toListing: (p) => p },
  { group: 'backend', schema: backendGroupSchema, toListing: (p) => p },
  { group: 'attributes', schema: attributesGroupSchema, toListing: (p) => p },
  { group: 'aplus', schema: aplusGroupSchema, toListing: (p) => `aplusContent.${p}` },
  {
    group: 'images',
    schema: imagesGroupSchemaFor(pack.rules.imageArchitecture),
    toListing: (p) => p,
  },
  { group: 'qa', schema: qaGroupSchema, toListing: (p) => p },
  {
    group: 'keywords',
    schema: keywordsGroupSchemaFor(pack.rules.keywordRules),
    toListing: (p) => p,
  },
];

const schemaPaths = new Set<string>();
const recordRoots = new Set<string>();
for (const { schema, toListing } of GROUP_SCHEMAS) {
  const raw = new Set<string>();
  const rawRecords = new Set<string>();
  schemaStringPaths(
    z.toJSONSchema(schema as never, { io: 'input', unrepresentable: 'any' }) as JsonSchema,
    '',
    raw,
    rawRecords,
  );
  for (const p of raw) schemaPaths.add(toListing(p));
  for (const r of rawRecords) recordRoots.add(toListing(r));
}

/**
 * String fields the ENGINE (not the LLM boundary) may add, which no group
 * schema declares and the healthy golden listing therefore does not carry.
 *
 * They are seeded so they are PROBED like everything else rather than silently
 * absent from the universe. This is the one list in this file that is written
 * by hand, and it is deliberately a list of SEEDS: a stale entry here can only
 * ever cost coverage of a field, never manufacture it — every seeded path still
 * has to satisfy the same closure rule as a walked one.
 */
const ENGINE_ADDED_OPTIONAL_PATHS = [
  // `lib/engine/keywordPlacement.ts` writes this only when derivation CHANGED a row.
  'keywords[].note',
  // D1 — written only when a generation group failed to validate.
  'degradedGroups[]',
];

// ===========================================================================
// §A.2 — THE LISTING SIDE: walk, and the path machinery the probe needs
// ===========================================================================

interface Leaf {
  /** e.g. `aplusContent.modules[0].bannerAltText` — where the sentinel goes. */
  concrete: string;
  /** e.g. `aplusContent.modules[].bannerAltText` — what a table row names. */
  canon: string;
}

function walkStrings(node: unknown, concrete: string, canon: string, out: Leaf[]): void {
  if (typeof node === 'string') {
    if (concrete) out.push({ concrete, canon });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkStrings(el, `${concrete}[${i}]`, `${canon}[]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    const isRecord = recordRoots.has(canon);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walkStrings(
        value,
        concrete ? `${concrete}.${key}` : key,
        canon ? `${canon}.${isRecord ? '*' : key}` : key,
        out,
      );
    }
  }
}

const listingLeaves = (l: OptimizedListing): Leaf[] => {
  const out: Leaf[] = [];
  walkStrings(l, '', '', out);
  return out;
};

/** Write `value` at a CONCRETE path (`a.b[2].c`). */
function setConcrete(root: unknown, concrete: string, value: string): void {
  const tokens = concrete.match(/[^.[\]]+/g) ?? [];
  let node = root as Record<string, unknown>;
  for (let i = 0; i < tokens.length - 1; i++) {
    node = node[tokens[i]!] as Record<string, unknown>;
  }
  node[tokens[tokens.length - 1]!] = value;
}

/**
 * Every concrete slot a CANONICAL path (`a.b[].c`, `attributes.*`) resolves to
 * in `root`, as setters. Used to SEED a declared-but-unpopulated field into
 * every position it can occupy.
 */
function canonSlots(root: unknown, canon: string): ((v: string) => void)[] {
  const tokens: ({ kind: 'key'; key: string } | { kind: 'index' } | { kind: 'wild' })[] = [];
  for (const seg of canon.split('.')) {
    const m = /^([^[]*)((?:\[\])*)$/.exec(seg);
    const name = m?.[1] ?? seg;
    if (name === '*') tokens.push({ kind: 'wild' });
    else if (name) tokens.push({ kind: 'key', key: name });
    for (let i = 0; i < ((m?.[2]?.length ?? 0) / 2); i++) tokens.push({ kind: 'index' });
  }
  const rec = (node: unknown, ti: number): ((v: string) => void)[] => {
    if (node == null) return [];
    const token = tokens[ti]!;
    const last = ti === tokens.length - 1;
    if (token.kind === 'key') {
      const obj = node as Record<string, unknown>;
      if (last) return [(v) => { obj[token.key] = v; }];
      return rec(obj[token.key], ti + 1);
    }
    if (token.kind === 'index') {
      if (!Array.isArray(node)) return [];
      if (last) return node.map((_, i) => (v: string) => { (node as unknown[])[i] = v; });
      return node.flatMap((el) => rec(el, ti + 1));
    }
    const obj = node as Record<string, unknown>;
    if (last) return Object.keys(obj).map((k) => (v: string) => { obj[k] = v; });
    return Object.values(obj).flatMap((val) => rec(val, ti + 1));
  };
  return rec(root, 0);
}

// ===========================================================================
// §B.0 — WHICH FUNCTIONS ARE SURFACE READERS, DERIVED FROM THE CODEBASE
// ===========================================================================

const GATE_ROOT = join(process.cwd(), 'lib', 'gate');

/** Every `.ts` under `lib/gate/`, relative and slash-normalised. */
function gateSources(dir = GATE_ROOT, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...gateSources(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * The MODULES, expanded from the filesystem by vite. A file added to
 * `lib/gate/` appears here on the next run without anyone editing a list — the
 * same property `gateSources` gives the static half.
 */
const GATE_MODULES = import.meta.glob('../lib/gate/**/*.ts') as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

const moduleKeyFor = (relative: string): string => `../lib/gate/${relative}`;

/**
 * TYPE NAMES the gate declares with a `text: string` member (`ScanSurface`,
 * `StyleSurface`). Derived by reading the sources, so a new surface record type
 * is recognised without being named here.
 */
function textBearingTypeNames(sources: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const src of sources.values()) {
    const re = /(?:export\s+)?(?:interface|type)\s+(\w+)\s*(?:=\s*)?\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (/\btext\s*\??\s*:\s*string\b/.test(m[2] ?? '')) out.add(m[1]!);
    }
  }
  return out;
}

/** Is a DECLARED return type a text shape rather than a verdict shape? */
function isTextReturn(returnType: string, textTypes: Set<string>): boolean {
  const t = returnType.replace(/\s+/g, ' ').trim().replace(/^\((.*)\)$/, '$1');
  if (/^string(\s*\|\s*(null|undefined))*$/.test(t)) return true;
  if (/^string\[\]$/.test(t)) return true;
  if (/^\[\s*string\s*,\s*string\s*\]\[\]$/.test(t)) return true;
  const named = /^(\w+)\[\]$/.exec(t);
  return named !== null && textTypes.has(named[1]!);
}

interface Candidate {
  file: string;
  name: string;
  /** How it was found — both detectors may claim the same function. */
  by: ('signature' | 'behaviour')[];
  why: string;
}

/**
 * STATIC DETECTOR. Parse every exported function signature in `lib/gate/**`.
 *
 * The parse is deliberately crude and deliberately FAIL-CLOSED: anything it
 * cannot decide (a missing return type) becomes a candidate that has to be
 * enrolled or explicitly excused. It cannot be satisfied by a name or a
 * comment, because what it reads is the type annotation the compiler enforces.
 */
function signatureCandidates(sources: Map<string, string>): Candidate[] {
  const textTypes = textBearingTypeNames(sources);
  const out: Candidate[] = [];
  for (const [file, src] of sources) {
    const re = /export\s+function\s+(\w+)\s*(<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Balance the parameter list, then take everything up to the body `{`.
      let i = re.lastIndex;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i]!;
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      const params = src.slice(re.lastIndex, i - 1);
      const bodyAt = src.indexOf('{', i);
      const returnType = src.slice(i, bodyAt < 0 ? i : bodyAt).replace(/^\s*:\s*/, '').trim();
      const takesListing = /\b(OptimizedListing|AplusContent)\b/.test(params);
      if (!takesListing) continue;
      if (returnType === '') {
        out.push({
          file,
          name: m[1]!,
          by: ['signature'],
          why: 'takes the listing and declares NO return type — undecidable, so treated as a reader',
        });
        continue;
      }
      if (isTextReturn(returnType, textTypes)) {
        out.push({
          file,
          name: m[1]!,
          by: ['signature'],
          why: `takes the listing and returns \`${returnType}\``,
        });
      }
    }
  }
  return out;
}

const PROBE = 'ZQXJVENROLLMENTPROBE';

/** Is a RUNTIME value text-shaped (strings, pairs of strings, `{text}` rows)? */
function isTextValue(v: unknown): boolean {
  if (typeof v === 'string') return true;
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (el) =>
      typeof el === 'string' ||
      (Array.isArray(el) && el.every((x) => typeof x === 'string')) ||
      (!!el && typeof el === 'object' && typeof (el as { text?: unknown }).text === 'string'),
  );
}

const containsProbe = (v: unknown): boolean => JSON.stringify(v ?? null)?.includes(PROBE) ?? false;

/**
 * BEHAVIOURAL DETECTOR. Call every exported function of every gate module with
 * a listing whose fields carry `PROBE`, and see which ones hand the probe back
 * as text.
 *
 * The argument VECTORS are best-effort — a function whose listing parameter is
 * not first, or that needs a companion argument this list does not guess, is
 * simply not detected HERE, and the static detector is what must hold. Adding a
 * vector can only ever find more readers, never fewer, which is why guessing is
 * safe in this direction.
 */
/**
 * `functionName -> the file that DEFINES it`, from the sources.
 *
 * `lib/gate/checks/index.ts` is a barrel: it re-exports `styleSurfaces`,
 * `keywordSurfaceText` and the rest, so the behavioural detector meets the same
 * function object twice and would otherwise demand a second row for the same
 * reader. Identity is the DEFINITION SITE. A re-export under a DIFFERENT name
 * does not resolve and stays a separate candidate — fail-closed.
 */
function definitionSites(sources: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/export\s+function\s+(\w+)/g)) out.set(m[1]!, file);
  }
  return out;
}

async function behaviourCandidates(
  probeListing: OptimizedListing,
  sites: Map<string, string>,
): Promise<Candidate[]> {
  const vectors: unknown[][] = [
    [probeListing],
    [probeListing.aplusContent],
    [probeListing, new Set(COLLECTED_SURFACE_GROUPS)],
    ...keywordSurfaceNames.map((n) => [probeListing, n]),
  ];
  const out: Candidate[] = [];
  for (const [key, load] of Object.entries(GATE_MODULES)) {
    const mod = await load();
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      for (const args of vectors) {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown)(...args);
        } catch {
          continue;
        }
        if (result instanceof Promise) continue;
        if (isTextValue(result) && containsProbe(result)) {
          const here = key.replace('../lib/gate/', '');
          out.push({
            file: sites.get(name) ?? here,
            name,
            by: ['behaviour'],
            why: 'returned text-shaped output containing a sentinel planted in the listing',
          });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Exported functions of `lib/gate/**` that a detector calls a surface reader
 * and that this oracle deliberately does NOT enrol.
 *
 * Every row is machine-checked below: the function must still be exported from
 * that file, and the behavioural probe must NOT observe it echoing listing text
 * (a row for something that really does read copy is stale and fails).
 */
const NOT_A_SURFACE_READER: Record<string, string> = {
  'checks/c-quality.ts::presentAllergens':
    'Returns the pack\'s own `allergenRules` rows that are PRESENT on the label — pack data filtered by the listing, never listing copy. It is a candidate only because it declares no return type, which is the fail-closed side of the static rule doing its job.',
};

// ===========================================================================
// §B — THE READERS, AND WHAT EACH ONE IS ALLOWED NOT TO READ
// ===========================================================================

/** Any surface reader, whatever its exact signature. */
type SurfaceFn = (...args: never[]) => unknown;

interface Reader {
  /** The EXPORTED NAME, checked against the module's own exports. */
  name: string;
  /** The file it is exported from, relative to `lib/gate/`. */
  file: string;
  /** The checks that read the listing through it. */
  checks: string;
  /**
   * The OBJECT this reader walks, when it is not the whole listing. Taken from
   * the function's own signature, not from a judgement about scope.
   */
  subtree?: string;
  /**
   * The ADAPTER: supplies the non-listing arguments and flattens the result.
   *
   * It receives `fn` rather than closing over the import, so the oracle decides
   * WHICH function this row measures — the one it resolved from `${file}`'s own
   * exports under `${name}`. A row therefore cannot quietly measure a copy, a
   * wrapper or a stub.
   */
  read: (fn: SurfaceFn, l: OptimizedListing) => (string | null)[];
  /** canonical path -> why THIS reader does not read it (a sibling must). */
  exempt: Record<string, string>;
}

const keywordSurfaceNames = [
  ...(pack.rules.keywordRules?.visibleSurfaces ?? []),
  ...(pack.rules.keywordRules?.backendSurfaces ?? []),
];

const READERS: Reader[] = [
  {
    name: 'collectSurfaces',
    file: 'checks/c-prohibited.ts',
    checks: 'C18 prohibited content / C19 prohibited marketing / C27 output hygiene',
    read: (fn, l) =>
      (fn as typeof collectSurfaces)(
        l,
        new Set(COLLECTED_SURFACE_GROUPS),
        pack.rules.factFields?.price,
      ).map((s) => s.text),
    exempt: {
      'facts.price':
        'Exempt BY KEY, not by omission: this is the field whose JOB is to hold the standard price, so C18 would report the canonical record for being what it is. Read by styleSurfaces (C17) and by factsComplianceSurfaces inside allGeneratedSurfaces, and it is never customer copy.',
    },
  },
  {
    name: 'styleSurfaces',
    file: 'checks/c-style.ts',
    checks: 'C17 style/formatting',
    read: (fn, l) => (fn as typeof styleSurfaces)(l).map((r) => r.text),
    exempt: {},
  },
  {
    name: 'customerSurfaces',
    file: 'checks/shared.ts',
    checks: 'C6 banned terms / C10 potency phrasing / C11 fiction / C12 fact consistency',
    read: (fn, l) => (fn as typeof customerSurfaces)(l).map(([, text]) => text),
    exempt: {
      'attributes.*':
        'attributeComplianceSurfaces reads every attribute value; they are kept out of this list because size/count attributes would false-trip the C12 figure comparison. C6 unions the two lists at its call site.',
      'facts.potency':
        '`factsComplianceSurfaces` reads every string fact, and C6 unions the two lists at its call site. They are kept apart because the canonical facts are the numbers C12 measures copy AGAINST, so they must not be measured against themselves.',
      'facts.servingSize': '`factsComplianceSurfaces` reads every string fact; C6 unions the two lists at its call site. See facts.potency.',
      'facts.weight': '`factsComplianceSurfaces` reads every string fact; C6 unions the two lists at its call site. See facts.potency.',
      'facts.price': '`factsComplianceSurfaces` reads every string fact; C6 unions the two lists at its call site. See facts.potency.',
      'aplusContent.modules[].headline':
        'A+ is read by `aplusSurfaces`, which A2/A5/A6/A8 scan directly and which C17 and C12 union in at their call sites. Folding it in here would double every A+ finding.',
      'aplusContent.modules[].body': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.modules[].subcopy': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.modules[].bannerAltText': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.comparison.rows[].label': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.comparison.rows[].ours': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.comparison.rows[].typical':
        'Read by `aplusSurfaces`. C12 uses `aplusFactSurfaces`, which drops exactly this cell, because it describes a TYPICAL ALTERNATIVE product and its figures are deliberately not ours.',
      'aplusContent.faq[].q': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
      'aplusContent.faq[].a': 'Read by `aplusSurfaces` — the A+ block has its own reader and its own checks (A2/A5/A6/A8).',
    },
  },
  {
    name: 'aplusSurfaces',
    file: 'checks/shared.ts',
    checks: 'A2/A5/A6/A8, the A+ half of C17, and (minus the typical column) C12',
    subtree: 'aplusContent',
    read: (fn, l) => (fn as typeof aplusSurfaces)(l.aplusContent).map(([, text]) => text),
    exempt: {},
  },
  {
    name: 'aplusFactSurfaces',
    file: 'checks/shared.ts',
    checks: 'the C12 fact-consistency scan over the A+ block',
    subtree: 'aplusContent',
    read: (fn, l) => (fn as typeof aplusFactSurfaces)(l.aplusContent).map(([, text]) => text),
    exempt: {
      'aplusContent.comparison.rows[].typical':
        'The `typical` cell describes a TYPICAL ALTERNATIVE product, so its figures are deliberately not ours and must never be measured against `facts`. Dropping exactly this cell is the entire reason this reader exists next to `aplusSurfaces`, which reads it.',
    },
  },
  {
    name: 'factsComplianceSurfaces',
    file: 'checks/shared.ts',
    checks: 'the canonical-facts half of C6 (unioned in at the call site)',
    subtree: 'facts',
    read: (fn, l) => (fn as typeof factsComplianceSurfaces)(l).map(([, text]) => text),
    exempt: {},
  },
  {
    name: 'attributeComplianceSurfaces',
    file: 'checks/shared.ts',
    checks: 'the attribute half of C6 (unioned in at the call site)',
    subtree: 'attributes',
    read: (fn, l) => (fn as typeof attributeComplianceSurfaces)(l).map(([, text]) => text),
    exempt: {},
  },
  {
    name: 'allGeneratedSurfaces',
    file: 'checks/shared.ts',
    checks: 'C21/C22 and the fail-closed cross-pack backstop in packFailClosed',
    read: (fn, l) => (fn as typeof allGeneratedSurfaces)(l).map(([, text]) => text),
    exempt: {},
  },
  {
    name: 'keywordSurfaceText',
    file: 'checks/c-keywords.ts',
    checks: 'C28 keyword placement (every name in the pack vocabulary)',
    read: (fn, l) =>
      keywordSurfaceNames.map((name) => (fn as typeof keywordSurfaceText)(l, name)),
    exempt: {
      'facts.potency':
        'The canonical facts are not a keyword SURFACE and are deliberately outside the pack vocabulary: they are deterministic source truth rebuilt identically from the snapshot every round, so no generation group authors them, a "placed on facts" claim is not expressible, and a term found in one could never be repaired away (the unwinnable-run shape). Read as CONTENT by collectSurfaces, styleSurfaces and allGeneratedSurfaces.',
      'facts.servingSize': 'See facts.potency — the canonical facts are not a keyword surface.',
      'facts.weight': 'See facts.potency — the canonical facts are not a keyword surface.',
      'facts.price': 'See facts.potency — the canonical facts are not a keyword surface.',
    },
  },
];

/**
 * Fields NO content reader reads, and why. These are the deliberate ones: each
 * row is a decision, and §D asserts each is still true.
 */
const GLOBAL_EXEMPT: Record<string, string> = {
  productName:
    'Published only INSIDE title / title75 / itemHighlights, which every reader scans. Reading it separately would report the same string twice and route the finding to the wrong group.',
  primaryKeyword:
    'An internal routing value the engine chose to drive the front-load lint. Never published on any surface.',
  'bulletAnchors[]':
    'Internal per-bullet situational-anchor labels. They feed the AUDIT lint only and are never published; the bullet TEXT they describe is scanned.',
  fdaDisclaimer:
    'The verbatim legal constant, code-inserted. C5/A1 compare it character for character and every content reader SUBTRACTS it before scanning, so reading it as copy would report required text as a violation.',
  'aplusContent.fdaDisclaimer': 'The same verbatim legal constant on the A+ block — see fdaDisclaimer.',
  'aplusContent.modules[].id':
    "The module's structural identity (a closed set the group schema pins: brand-story, hero, ...). Never rendered to a customer, and already carried in the FIELD NAME the readers emit, so scanning it would report the gate's own routing key as copy.",
  'keywords[].term':
    'The keyword REFERENCE is an operator-facing planning artifact, not published listing copy. Scanning it as copy would fail every `negative` row on the banned or rival term the row exists to record — it would disarm the very check the artifact arms. C28 is what verifies the reference, by measuring it AGAINST the copy.',
  'keywords[].tier': 'See keywords[].term — the reference is not published copy.',
  'keywords[].status': 'See keywords[].term — the reference is not published copy.',
  'keywords[].surfaces[]':
    'DERIVED surface NAMES (`title`, `bullet3`), computed by lib/engine/keywordPlacement.ts from the finished copy. Vocabulary, not prose.',
  'keywords[].why': 'See keywords[].term — the reference is not published copy.',
  'keywords[].via': 'See keywords[].term — the reference is not published copy.',
  'keywords[].home': 'See keywords[].term — the reference is not published copy.',
  'keywords[].note': 'See keywords[].term — and this one is written by the derivation, not by the model.',
  'degradedGroups[]':
    'Code-written GENERATION GROUP NAMES, never copy. Gate check GEN turns every entry into a failure, so this field can never be a quiet skip.',
  state: 'A lifecycle enum the engine sets; not copy.',
};

// ===========================================================================
// The probe
// ===========================================================================

let populated: OptimizedListing;
let leaves: Leaf[];
let unreadBy: Map<string, Leaf[]>;
let sources: Map<string, string>;
let candidates: Map<string, Candidate>;
/** reader name -> the function resolved from that reader's OWN module export. */
let resolved: Map<string, SurfaceFn>;

const clone = (l: OptimizedListing): OptimizedListing =>
  JSON.parse(JSON.stringify(l)) as OptimizedListing;

const key = (file: string, name: string): string => `${file}::${name}`;

/**
 * Fields a reader did NOT return the sentinel for.
 *
 * The function is taken from `resolved` — i.e. from the module's own exports —
 * and handed to the row's adapter. A row cannot substitute anything for it.
 */
function measure(readers: Reader[], base: OptimizedListing, all: Leaf[]): Map<string, Leaf[]> {
  const out = new Map<string, Leaf[]>(readers.map((r) => [r.name, []]));
  for (const leaf of all) {
    const probe = clone(base);
    setConcrete(probe, leaf.concrete, SENTINEL);
    for (const reader of readers) {
      if (reader.subtree && !leaf.canon.startsWith(`${reader.subtree}.`)) continue;
      const fn = resolved.get(reader.name);
      if (!fn) throw new Error(`no export resolved for reader ${reader.name}`);
      const seen = reader
        .read(fn, probe)
        .some((t) => typeof t === 'string' && t.includes(SENTINEL));
      if (!seen) out.get(reader.name)!.push(leaf);
    }
  }
  return out;
}

beforeAll(async () => {
  const golden = await optimize(snapshot, pack, mockLlm);
  populated = clone(golden);

  // SEED every declared field the golden listing does not happen to carry, so
  // an optional field is probed exactly like a required one.
  const present = new Set(listingLeaves(populated).map((l) => l.canon));
  for (const path of [...schemaPaths, ...ENGINE_ADDED_OPTIONAL_PATHS]) {
    if (present.has(path)) continue;
    const slots = canonSlots(populated, path);
    for (const set of slots) set(SEED);
    if (slots.length === 0 && path === 'degradedGroups[]') {
      (populated as { degradedGroups?: string[] }).degradedGroups = [SEED];
    }
  }

  leaves = listingLeaves(populated);

  // --- §B.0: derive the reader set from the codebase, then bind the rows ---
  sources = new Map(
    gateSources().map((rel) => [rel, readFileSync(join(GATE_ROOT, rel), 'utf8')]),
  );
  const probeListing = clone(populated);
  for (const leaf of listingLeaves(probeListing)) setConcrete(probeListing, leaf.concrete, PROBE);
  candidates = new Map();
  const sites = definitionSites(sources);
  for (const c of [
    ...signatureCandidates(sources),
    ...(await behaviourCandidates(probeListing, sites)),
  ]) {
    const existing = candidates.get(key(c.file, c.name));
    if (existing) existing.by.push(...c.by);
    else candidates.set(key(c.file, c.name), c);
  }

  resolved = new Map();
  for (const reader of READERS) {
    const load = GATE_MODULES[moduleKeyFor(reader.file)];
    if (!load) throw new Error(`reader ${reader.name} names a file that does not exist: ${reader.file}`);
    const mod = await load();
    const fn = mod[reader.name];
    if (typeof fn !== 'function') {
      throw new Error(`${reader.file} exports no function named '${reader.name}'`);
    }
    resolved.set(reader.name, fn as SurfaceFn);
  }

  unreadBy = measure(READERS, populated, leaves);
});

// ===========================================================================
// §B.0 — ENROLLMENT IS DERIVED, IN BOTH DIRECTIONS
// ===========================================================================

describe('§B.0 every surface reader in the codebase is enrolled in this oracle', () => {
  it('the detectors ran over the real tree and found something to detect', () => {
    expect(sources.size, 'no gate sources were read').toBeGreaterThanOrEqual(15);
    expect(Object.keys(GATE_MODULES).length).toBe(sources.size);
    // Both detectors must be alive: a silent zero from either would make the
    // enrollment check pass by finding nothing.
    const bySignature = [...candidates.values()].filter((c) => c.by.includes('signature'));
    const byBehaviour = [...candidates.values()].filter((c) => c.by.includes('behaviour'));
    expect(bySignature.length, 'the SIGNATURE detector found nothing').toBeGreaterThanOrEqual(6);
    expect(byBehaviour.length, 'the BEHAVIOUR detector found nothing').toBeGreaterThanOrEqual(4);
  });

  it('the checks are NOT swept in: a `Failure[]` return is not a surface read', () => {
    // ~40 exported checks take the listing and return verdicts. If the return
    // type stopped discriminating, this list would swallow them and the
    // enrollment assertion below would be unmeetable rather than meaningful.
    const names = [...candidates.values()].map((c) => c.name);
    for (const check of ['c17Style', 'c18ProhibitedContent', 'c27OutputHygiene', 'c6BannedTerms']) {
      expect(names, `${check} is a CHECK, not a reader`).not.toContain(check);
    }
  });

  it('every detected surface reader has a READERS row (or a reasoned exclusion)', () => {
    const enrolled = new Set(READERS.map((r) => key(r.file, r.name)));
    const unenrolled = [...candidates.entries()]
      .filter(([id]) => !enrolled.has(id) && !(id in NOT_A_SURFACE_READER))
      .map(([id, c]) => `${id} — ${c.why} [found by: ${[...new Set(c.by)].join(', ')}]`)
      .sort();
    expect(
      unenrolled,
      'these functions read the generated listing and return its text, and NOTHING in this oracle measures what they cover. ' +
        'That is the shape of all four bypasses this project has found. Add a READERS row, or a NOT_A_SURFACE_READER row saying why it is not one: ' +
        unenrolled.join(' | '),
    ).toEqual([]);
  });

  it('every READERS row names a function the detectors still recognise', () => {
    const stale = READERS.filter((r) => !candidates.has(key(r.file, r.name))).map(
      (r) => key(r.file, r.name),
    );
    expect(
      stale,
      `these rows name something the codebase no longer exports as a surface reader: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the resolved function IS the module export, not a closure the row supplied', () => {
    // The row hands over an ADAPTER; the oracle supplies the function. This
    // pins that: what §C measured is the export named in the row.
    expect(resolved.size).toBe(READERS.length);
    for (const reader of READERS) {
      expect(resolved.get(reader.name), reader.name).toBeTypeOf('function');
      expect((resolved.get(reader.name) as { name: string }).name, reader.name).toBe(reader.name);
    }
  });

  it('every NOT_A_SURFACE_READER row still exists and still does not read copy', async () => {
    const bad: string[] = [];
    for (const [id, why] of Object.entries(NOT_A_SURFACE_READER)) {
      const [file, name] = id.split('::') as [string, string];
      const load = GATE_MODULES[moduleKeyFor(file)];
      if (!load) {
        bad.push(`${id}: no such file`);
        continue;
      }
      const mod = await load();
      if (typeof mod[name] !== 'function') bad.push(`${id}: not an export`);
      // A row for a function the BEHAVIOURAL probe caught echoing listing text
      // is stale by definition — that is a reader, whatever the row says.
      if (candidates.get(id)?.by.includes('behaviour')) {
        bad.push(`${id}: the probe observed it returning listing text — it IS a reader`);
      }
      if (why.length < 40) bad.push(`${id}: no real reason recorded`);
    }
    expect(bad).toEqual([]);
  });
});

// ===========================================================================
// §A.3 — the universe is complete: schema ⊆ walk
// ===========================================================================

describe('§A the field universe is derived from the schemas AND from a populated listing', () => {
  it('every string-bearing field the group schemas declare exists in the walked listing', () => {
    const canon = new Set(leaves.map((l) => l.canon));
    const missing = [...schemaPaths].filter((p) => !canon.has(p)).sort();
    expect(
      missing,
      `these fields are declared by a generation-group schema but do not exist (or could not be seeded) in the assembled listing — add the assembler mapping, or the oracle is not covering them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the walk found the fields the P1 bypass and its sibling live in', () => {
    const canon = new Set(leaves.map((l) => l.canon));
    for (const p of [
      'aplusContent.modules[].bannerAltText',
      'videoBrief.aspect',
      'videoBrief.shots[]',
      'videoBrief.onScreenText[]',
      'videoBrief.notes',
      'imagePlan[].altText',
      'attributes.*',
      'facts.price',
    ]) {
      expect(canon, p).toContain(p);
    }
  });

  it('the universe is big enough to be worth asserting (a collapsed walk proves nothing)', () => {
    expect(leaves.length).toBeGreaterThan(120);
    expect(new Set(leaves.map((l) => l.canon)).size).toBeGreaterThan(30);
  });

  it('the path machinery round-trips: every walked field can actually be written to', () => {
    const broken: string[] = [];
    for (const leaf of leaves) {
      const probe = clone(populated);
      setConcrete(probe, leaf.concrete, SENTINEL);
      const back = listingLeaves(probe).find((l) => l.concrete === leaf.concrete);
      if (back === undefined) broken.push(leaf.concrete);
    }
    expect(broken, `the probe could not write these paths — every closure result below them is meaningless: ${broken.join(', ')}`).toEqual([]);
  });
});

// ===========================================================================
// §C — CLOSURE: every field, every applicable reader
// ===========================================================================

describe('§C every string field is read by every applicable reader, or exempted with a reason', () => {
  for (const reader of READERS) {
    it(`${reader.name} (${reader.checks})`, () => {
      const violations = unreadBy
        .get(reader.name)!
        .filter((l) => !(l.canon in GLOBAL_EXEMPT) && !(l.canon in reader.exempt));
      expect(
        violations.map((v) => v.concrete).sort(),
        `${reader.name} does not read these fields, and neither GLOBAL_EXEMPT nor its own exemption table says why. ` +
          `This is the P1 bug class: a reader that covers part of its object. ` +
          `Either read them, or add a reasoned exemption row: ` +
          `${[...new Set(violations.map((v) => v.canon))].join(', ')}`,
      ).toEqual([]);
    });
  }
});

// ===========================================================================
// §D — THE EXEMPTION TABLES CANNOT ROT
// ===========================================================================

describe('§D every exemption row is still true', () => {
  it('GLOBAL_EXEMPT names only fields that EXIST', () => {
    const canon = new Set(leaves.map((l) => l.canon));
    const ghosts = Object.keys(GLOBAL_EXEMPT).filter((p) => !canon.has(p)).sort();
    expect(ghosts, `GLOBAL_EXEMPT rows for fields that no longer exist: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('GLOBAL_EXEMPT names only fields NO reader reads (a row for a read field is stale)', () => {
    const stale: string[] = [];
    for (const path of Object.keys(GLOBAL_EXEMPT)) {
      const readers = READERS.filter(
        (r) =>
          (!r.subtree || path.startsWith(`${r.subtree}.`)) &&
          !unreadBy.get(r.name)!.some((l) => l.canon === path),
      );
      if (readers.length > 0) stale.push(`${path} (read by ${readers.map((r) => r.name).join(', ')})`);
    }
    expect(stale, `GLOBAL_EXEMPT is stale: ${stale.join(' | ')}`).toEqual([]);
  });

  it('every per-reader exemption names a field that EXISTS and that the reader really does not read', () => {
    const canon = new Set(leaves.map((l) => l.canon));
    const bad: string[] = [];
    for (const reader of READERS) {
      for (const path of Object.keys(reader.exempt)) {
        if (!canon.has(path)) bad.push(`${reader.name}: ${path} does not exist`);
        else if (!unreadBy.get(reader.name)!.some((l) => l.canon === path)) {
          bad.push(`${reader.name}: ${path} IS read — drop the exemption`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every per-reader exemption is covered by at least one OTHER reader (else it belongs in GLOBAL_EXEMPT)', () => {
    const orphans: string[] = [];
    for (const reader of READERS) {
      for (const path of Object.keys(reader.exempt)) {
        const covered = READERS.some(
          (other) =>
            other.name !== reader.name &&
            (!other.subtree || path.startsWith(`${other.subtree}.`)) &&
            !unreadBy.get(other.name)!.some((l) => l.canon === path),
        );
        if (!covered) orphans.push(`${reader.name}: ${path}`);
      }
    }
    expect(
      orphans,
      `these exemptions claim a sibling reader covers the field and none does: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('every exemption row carries an actual REASON, not a placeholder', () => {
    const rows: [string, string][] = [
      ...Object.entries(GLOBAL_EXEMPT),
      ...READERS.flatMap((r) => Object.entries(r.exempt)),
    ];
    for (const [path, reason] of rows) {
      expect(reason.length, `${path} has no real reason recorded`).toBeGreaterThan(40);
    }
  });
});

// ===========================================================================
// §E — NOT VACUOUS: the pre-P1 readers, reconstructed, and a synthetic field
// ===========================================================================

describe('§E the oracle catches exactly the field a reader drops', () => {
  /**
   * `collectSurfaces` EXACTLY as it stood before P1 — the A+ branch that never
   * looked at `bannerAltText`. Reconstructed by blanking the field the old
   * branch could not see, which is observationally identical to not reading it
   * and cannot drift out of step with the real reader's other branches.
   */
  const preP1Collect: Reader = {
    name: 'preP1Collect',
    file: 'checks/c-prohibited.ts',
    checks: 'reconstruction of the reader that shipped the bypass',
    read: (_fn, l) => {
      const blind = clone(l);
      for (const m of blind.aplusContent?.modules ?? []) delete m.bannerAltText;
      return collectSurfaces(
        blind,
        new Set(COLLECTED_SURFACE_GROUPS),
        pack.rules.factFields?.price,
      ).map((s) => s.text);
    },
    exempt: {},
  };

  /** `customerSurfaces` EXACTLY as it stood before P1: every video string but `aspect`. */
  const preP1Customer: Reader = {
    name: 'preP1Customer',
    file: 'checks/shared.ts',
    checks: 'reconstruction of the sibling three-of-four reader',
    read: (_fn, l) =>
      customerSurfaces(l)
        .filter(([field]) => field !== 'videoBrief.aspect')
        .map(([, text]) => text),
    exempt: {},
  };

  /** A reader that drops one image string, to show the oracle is not A+-specific. */
  const noAltText: Reader = {
    name: 'noAltText',
    file: 'checks/c-style.ts',
    checks: 'synthetic mutant: styleSurfaces minus imagePlan altText',
    read: (_fn, l) =>
      styleSurfaces(l)
        .filter((r) => !/^imagePlan\[\d+\]\.altText$/.test(r.field))
        .map((r) => r.text),
    exempt: {},
  };

  const newly = (mutant: Reader, baseline: string): string[] => {
    // The mutants are RECONSTRUCTIONS, not exports, so they are bound by hand;
    // every production row is bound from its module (see §B.0 `resolve`).
    resolved.set(mutant.name, (() => []) as SurfaceFn);
    const measured = measure([mutant], populated, leaves);
    const before = new Set(unreadBy.get(baseline)!.map((l) => l.canon));
    return [...new Set(measured.get(mutant.name)!.map((l) => l.canon))]
      .filter((c) => !before.has(c))
      .sort();
  };

  it('the PRE-P1 collectSurfaces is reported as unread on exactly `bannerAltText`', () => {
    expect(newly(preP1Collect, 'collectSurfaces')).toEqual([
      'aplusContent.modules[].bannerAltText',
    ]);
  });

  it('the PRE-P1 customerSurfaces is reported as unread on exactly `videoBrief.aspect`', () => {
    expect(newly(preP1Customer, 'customerSurfaces')).toEqual(['videoBrief.aspect']);
  });

  it('a reader that drops an image ALT string is reported on exactly that field', () => {
    expect(newly(noAltText, 'styleSurfaces')).toEqual(['imagePlan[].altText']);
  });

  it('a NEW string field with no reader and no exemption row FAILS, naming the field', () => {
    const withNew = clone(populated);
    for (const m of withNew.aplusContent.modules) {
      (m as unknown as Record<string, unknown>).sponsoredBadgeCaption = 'A brand new field nobody reads';
    }
    const all = listingLeaves(withNew);
    expect(all.some((l) => l.canon === 'aplusContent.modules[].sponsoredBadgeCaption')).toBe(true);

    const measured = measure(READERS, withNew, all);
    const applicable = READERS.filter(
      (r) => !r.subtree || 'aplusContent.modules[].sponsoredBadgeCaption'.startsWith(`${r.subtree}.`),
    );
    expect(applicable.length, 'no reader would have been measured at all').toBeGreaterThan(2);
    for (const reader of applicable) {
      const violations = measured
        .get(reader.name)!
        .filter((l) => !(l.canon in GLOBAL_EXEMPT) && !(l.canon in reader.exempt))
        .map((l) => l.canon);
      expect(violations, reader.name).toContain('aplusContent.modules[].sponsoredBadgeCaption');
    }
  });
});

// ===========================================================================
// §F — THE PROVEN EXPLOIT, END TO END
// ===========================================================================

describe('§F the reproduced bypass now fails, exactly as the same string in `body` does', () => {
  const PAYLOAD =
    'Visit brandsite.com or email help@example.com, look no further, task: return json – café';

  const kinds = (fs: { checkId: string; context: string }[]): string[] =>
    fs.map((f) => `${f.checkId}|${f.context.replace(/ at \d+:.*$/, '')}`).sort();

  it('planted in `aplusContent.modules[0].bannerAltText` it produces the SAME findings as in `body`', async () => {
    const { runGate } = await import('@/lib/gate/runGate');
    const ctx = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };
    const golden = await optimize(snapshot, pack, mockLlm);

    const inAlt = clone(golden);
    inAlt.aplusContent.modules[0]!.bannerAltText = PAYLOAD;
    const altResult = runGate(inAlt, pack, ctx);

    const inBody = clone(golden);
    inBody.aplusContent.modules[0]!.body = `${inBody.aplusContent.modules[0]!.body} ${PAYLOAD}`;
    const bodyResult = runGate(inBody, pack, ctx);

    expect(altResult.pass, 'the bypass must no longer verify').toBe(false);
    expect(altResult.failures.length).toBeGreaterThan(0);
    // the point of the fix: the two placements are now indistinguishable
    expect(kinds(altResult.failures)).toEqual(kinds(bodyResult.failures));
    expect(
      altResult.failures.every((f) => f.field === 'aplus.modules[brand-story]'),
      'every finding must route to the module that owns the ALT string',
    ).toBe(true);
  });
});
