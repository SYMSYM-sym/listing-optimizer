import type { Failure, KnowledgePack, OptimizedListing } from '@/lib/types';
import { normalize } from '../util';
import { collectSurfaces } from './c-prohibited';
import { fail } from './shared';

/**
 * C27 — OUTPUT HYGIENE.
 *
 * Three properties of machine-written copy that every other check is blind to,
 * all pack-driven (`rules.outputHygiene`):
 *
 *  1. PURE ASCII. The engine folds typographic punctuation to ASCII at emit
 *     (`lib/engine/typography.ts`), so anything non-ASCII that survives is a
 *     real character — a smart symbol the fold deliberately leaves alone, a
 *     zero-width character, an accented word, a stray glyph — and a human has
 *     to decide about it. The check runs on the RAW surface text, never on
 *     `normalize()` output, because normalization is exactly the pass that
 *     would hide the thing being looked for (it folds accents, decodes
 *     entities and strips invisibles). Surface groups listed in
 *     `asciiExemptSurfaces` are exempt from THIS rule only — the backend
 *     search-term field exists to carry other-language variants, and a
 *     diacritic there is the query, not a defect.
 *
 *  2. NO AI-TELL PHRASES. Stock model phrasing ("delve", "look no further",
 *     "unlock the power") is not illegal, but it is the single clearest signal
 *     to a reader that nobody wrote this listing. Pack list.
 *
 *  3. NO LEAKED INSTRUCTION FRAGMENTS. A live run once shipped an image brief
 *     that quoted our own compliance instruction back at us. Any fragment of
 *     the prompt scaffolding — a JSON directive, a block header, an assistant
 *     preamble, a fenced code marker — is a defect on a customer surface.
 *     Pack list.
 *
 * Both phrase scans run over `normalize()`d, lower-cased text so an entity- or
 * accent-obfuscated tell is still caught; the ASCII scan runs over the raw
 * string. Emptying any of the three lists disarms that third of the check,
 * which is why all three are `REQUIRED_PACK_PIECES` rows.
 */
const CHECK_ID = 'C27';

/** Index of the first non-ASCII character, or -1. */
function firstNonAscii(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return i;
  }
  return -1;
}

/** The surface GROUP a collected field name belongs to ('bullets[2]' -> 'bullets'). */
const groupOf = (field: string): string => field.split(/[[.]/)[0] ?? field;

const around = (text: string, at: number): string =>
  text.slice(Math.max(0, at - 25), at + 25).trim();

export function c27OutputHygiene(l: OptimizedListing, pack: KnowledgePack): Failure[] {
  const rules = pack.rules?.outputHygiene;
  if (!rules) return [];
  const want = new Set((rules.surfaces ?? []).filter((s) => String(s).trim() !== ''));
  if (want.size === 0) return [];
  const surfaces = collectSurfaces(l, want, pack.rules?.factFields?.price);
  const tells = (rules.aiTellPhrases ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const fragments = (rules.instructionFragments ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  // ASCII-exempt groups: see `asciiExemptSurfaces` — the phrase scans below
  // still run over them, only the ASCII rule is lifted.
  const asciiExempt = new Set(
    (rules.asciiExemptSurfaces ?? []).map((s) => s.trim()).filter(Boolean),
  );
  const out: Failure[] = [];

  for (const { field, text } of surfaces) {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    if (raw === '') continue;

    if (rules.asciiOnly && !asciiExempt.has(groupOf(field))) {
      const at = firstNonAscii(raw);
      if (at >= 0) {
        const ch = raw[at]!;
        const code = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
        out.push(
          fail(
            CHECK_ID,
            field,
            `non-ASCII U+${code} at ${at}: ${around(raw, at)}`,
            `Replace the non-ASCII character U+${code} with its ASCII equivalent. The engine already folds typographic punctuation at emit, so this one is a symbol, an invisible character or a non-Latin glyph — decide it deliberately rather than shipping it into a feed.`,
          ),
        );
      }
    }

    const hay = normalize(raw).toLowerCase();
    const tell = tells.find((t) => hay.includes(t));
    if (tell) {
      out.push(
        fail(
          CHECK_ID,
          field,
          `AI-tell phrase '${tell}'`,
          `Rewrite without '${tell}'. Stock model phrasing tells a reader nobody wrote this listing.`,
        ),
      );
    }
    const fragment = fragments.find((t) => hay.includes(t));
    if (fragment) {
      out.push(
        fail(
          CHECK_ID,
          field,
          `leaked instruction fragment '${fragment}'`,
          `Remove '${fragment}' — it is a fragment of the generator's own instructions, not product copy.`,
        ),
      );
    }
  }
  return out;
}
