import type { OptimizedListing } from '@/lib/types';

/**
 * TYPOGRAPHIC NORMALIZATION AT EMIT (generation policy, NOT gate laundering).
 *
 * Models write typographer's punctuation: curly quotes, en/em dashes, ellipsis
 * characters, non-breaking spaces. On a marketplace listing those are a real
 * defect — the description budget is counted in UTF-8 BYTES (an em dash is
 * three), feed pipelines mangle them, and the same sentence pasted twice can
 * differ by an invisible character. So the ENGINE emits ASCII: the substitution
 * happens once, here, at assembly, and the gate then INDEPENDENTLY verifies
 * that what was emitted really is ASCII (C27). Worker != checker is preserved:
 * this module never sees a gate result and the gate never calls it.
 *
 * WHAT IS DELIBERATELY *NOT* SUBSTITUTED, and why. Every character below is a
 * pure typographic variant of an ASCII character, so replacing one cannot make
 * a failing listing pass any check. These are NOT touched:
 *
 *   - the banned SYMBOL class (trademark/registered/copyright, currency signs):
 *     C17 fails them by design, and silently rewriting one would be exactly the
 *     "mutate content to force a pass" this project forbids;
 *   - emoji: same reason (C17 again);
 *   - zero-width and other invisible characters: the de-obfuscation passes in
 *     `lib/gate/util` exist precisely because an attacker hides a banned term
 *     behind one. Stripping them here would erase the evidence. They are
 *     non-ASCII, so C27 reports them instead;
 *   - anything with an accent or a non-Latin script: a real word, not
 *     punctuation. C27 reports it and a human decides.
 */

/** Typographic variant -> ASCII. Punctuation and spacing ONLY. */
const SUBSTITUTIONS: [RegExp, string][] = [
  // curly single quotes + prime
  [/[‘’‚‛′]/g, "'"],
  // curly double quotes + double prime
  [/[“”„‟″]/g, '"'],
  // hyphen/dash family + minus sign
  [/[‐‑‒–—―−]/g, '-'],
  // horizontal ellipsis
  [/…/g, '...'],
  // fraction slash
  [/⁄/g, '/'],
  // comparison + arithmetic operators (spec shorthand: ">=85% fill", "<=5 icons")
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≠/g, '!='],
  [/±/g, '+/-'],
  [/×/g, 'x'],
  [/÷/g, '/'],
  // non-breaking, en/em/thin/hair, narrow-no-break, medium-math and ideographic spaces
  [/[  -   　]/g, ' '],
];

/** ASCII-fold the typographic punctuation in one string. */
export function toAsciiTypography(text: string): string {
  let out = typeof text === 'string' ? text : text == null ? '' : String(text);
  for (const [re, to] of SUBSTITUTIONS) out = out.replace(re, to);
  return out;
}

/**
 * Apply `toAsciiTypography` to every GENERATED copy surface of an assembled
 * listing.
 *
 * Explicitly untouched: `facts` (deterministically produced from the source
 * snapshot, not written by the model), `fdaDisclaimer` and
 * `aplusContent.fdaDisclaimer` (verbatim legal constants — C5/A1 compare them
 * character for character, so this module must never be in a position to edit
 * one), `state`, the keyword REFERENCE (`keywords[]` — an operator-facing
 * planning artifact, not published copy, and not a surface any content check
 * reads), and the parallel bookkeeping arrays.
 *
 * ---------------------------------------------------------------------------
 * P3 — THE THREE MODEL-WRITTEN SURFACES THIS FUNCTION USED TO MISS
 * ---------------------------------------------------------------------------
 * `imagePlan[].altText`, `aplusContent.modules[].bannerAltText` and the whole
 * of `videoBrief` are written by the model exactly like the copy around them,
 * and they were passing through unfolded — `altText` and `bannerAltText`
 * because their branches listed their siblings and not them, `videoBrief`
 * because it had no branch at all and rode the spread.
 *
 * That mattered, and in the OVER-BLOCKING direction. C27 judges every surface
 * POST-fold and its stated premise is *"the engine already folded this text, so
 * anything non-ASCII that survives is a real character a human must decide
 * about."* On these three the premise was simply false: a curly apostrophe the
 * model wrote into an ALT string was reported as a decision for a human, while
 * the identical apostrophe one field over in `imagePlan[].notes` was folded and
 * never seen — and the repair loop cannot converge on a character class it is
 * not told is mechanical. The fold covers them now, so the premise is true for
 * every surface C27 scans except `facts`, which is the ONE deliberate carve-out
 * (`asciiExemptSurfaces`) and is deliberate for the opposite reason: facts are
 * not model-written at all.
 *
 * NOTHING IS LAUNDERED BY THIS. The substitution table above is punctuation and
 * spacing only: banned symbols, currency signs, emoji, zero-width characters and
 * accented or non-Latin words are all left exactly as written, so every C17 and
 * C27 finding that could fire on these fields before still fires. What stops
 * firing is the smart quote — which is what the fold is for.
 *
 * THE FOLD NEVER INVENTS A KEY. Four things are OPTIONAL in the output
 * contract — `aplusContent.modules[].subcopy`, `aplusContent.modules[].bannerAltText`,
 * `imagePlan[].altText` and `videoBrief` itself — and each is rebuilt only when
 * the object actually carries it, so a text-only module does not come back with
 * a fabricated `subcopy: ''` and a run with no brief does not come back with an
 * empty one. (C29 reports an absent `videoBrief` as its own failure, which is
 * why that whole branch is guarded rather than spread.)
 *
 * WHAT THIS PARAGRAPH USED TO CLAIM, AND WHY IT WAS WRONG. It said
 * "OPTIONALITY IS PRESERVED … folding must not turn `undefined` into `''` and
 * convert 'missing' into 'empty', so each is rebuilt only when it is actually
 * there" — stated as a property of the whole function. It is not one: inside a
 * PRESENT `videoBrief`, `t(video.aspect)` and `t(video.notes)` coerce
 * `undefined` to `''` and the two array fields coerce a non-array to `[]`. That
 * is correct rather than an oversight, and the reason is the contract, not the
 * fold: `VideoBrief` declares all five fields REQUIRED, so there is no
 * "missing notes" state to preserve — only malformed output, which the coercion
 * hands to the checks in the shape the type promises instead of propagating a
 * hole. The rule the code actually follows is the one stated above: a field is
 * guarded exactly when the CONTRACT makes it optional.
 *
 * The old sentence also over-claimed about the checks. C30 reports an absent
 * `imagePlan[].altText` and an empty one identically ("(empty)"), and an absent
 * `bannerAltText` not at all — so no guard here is load-bearing for a gate
 * verdict. What they are load-bearing for is the emitted JSON, which is
 * persisted and exported.
 */
export function normalizeListingTypography(l: OptimizedListing): OptimizedListing {
  const t = toAsciiTypography;
  const video = l.videoBrief;
  return {
    ...l,
    ...(video
      ? {
          videoBrief: {
            ...video,
            aspect: t(video.aspect),
            shots: (Array.isArray(video.shots) ? video.shots : []).map(t),
            onScreenText: (Array.isArray(video.onScreenText) ? video.onScreenText : []).map(t),
            notes: t(video.notes),
          },
        }
      : {}),
    title: t(l.title),
    title75: t(l.title75),
    itemHighlights: t(l.itemHighlights),
    bullets: (Array.isArray(l.bullets) ? l.bullets : []).map(t),
    description: t(l.description),
    backendSearchTerms: t(l.backendSearchTerms),
    productName: t(l.productName),
    primaryKeyword: t(l.primaryKeyword),
    bulletAnchors: l.bulletAnchors?.map(t),
    attributes: Object.fromEntries(
      Object.entries(l.attributes ?? {}).map(([k, v]) => [k, t(v)]),
    ),
    aplusContent: {
      ...l.aplusContent,
      modules: (l.aplusContent?.modules ?? []).map((m) => ({
        ...m,
        headline: t(m.headline),
        body: t(m.body),
        ...(m.subcopy === undefined ? {} : { subcopy: t(m.subcopy) }),
        ...(m.bannerAltText === undefined ? {} : { bannerAltText: t(m.bannerAltText) }),
      })),
      comparison: {
        rows: (l.aplusContent?.comparison?.rows ?? []).map((r) => ({
          label: t(r.label),
          ours: t(r.ours),
          typical: t(r.typical),
        })),
      },
      faq: (l.aplusContent?.faq ?? []).map((f) => ({ ...f, q: t(f.q), a: t(f.a) })),
    },
    imagePlan: (Array.isArray(l.imagePlan) ? l.imagePlan : []).map((s) => ({
      ...s,
      purpose: t(s.purpose),
      spec: t(s.spec),
      notes: t(s.notes),
      ...(s.altText === undefined ? {} : { altText: t(s.altText) }),
    })),
    qa: (l.qa ?? []).map((f) => ({ ...f, q: t(f.q), a: t(f.a) })),
  };
}
