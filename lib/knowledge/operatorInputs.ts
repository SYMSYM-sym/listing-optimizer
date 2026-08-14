import type { KnowledgePack } from '@/lib/types';

/**
 * R45 — PER-RUN OPERATOR INPUTS.
 *
 * `fictionPhrases` is the C11 list: descriptors an operator KNOWS to be false
 * for this product — a blend name a previous copy generation invented, a
 * superseded ingredient count, a retired claim that keeps coming back because
 * it is still in someone's paste buffer. The shipped list is empty by design
 * (`knowledge/compliance.*.json`), because a fiction is a fact about ONE
 * product and one run, and the person who knows it is the operator sitting in
 * front of the listing.
 *
 * So it arrives on the REQUEST and lives for exactly one run:
 *
 *  - MERGED, never replaced: the pack's own entries always still apply, so an
 *    operator input can only ever make the gate stricter. There is no request
 *    shape that removes a phrase.
 *  - CLONED, never mutated: `loadPack` hands back the imported JSON singletons,
 *    so writing to `compliancePack.fictionPhrases` would leak one run's inputs
 *    into every later run in the same process. This returns a new pack with a
 *    new compliance object and leaves the module-level data untouched.
 *  - NOT PERSISTED: nothing here writes to `knowledge/`. The next run starts
 *    from the shipped list again.
 *
 * C11 itself is unchanged — it reads `compliancePack.fictionPhrases` exactly as
 * before and fails closed on a match.
 */

/** Defensive cap: an operator list is a handful of phrases, not a corpus. */
const MAX_PHRASES = 100;
/** A one- or two-character "phrase" would match everywhere. */
const MIN_LENGTH = 3;

export function withOperatorFictionPhrases(
  pack: KnowledgePack,
  phrases: unknown,
): KnowledgePack {
  const cp = pack.compliancePack;
  if (!cp || !Array.isArray(phrases)) return pack;
  const seen = new Set(cp.fictionPhrases.map((p) => p.toLowerCase()));
  const extra: string[] = [];
  for (const raw of phrases) {
    if (typeof raw !== 'string') continue;
    const phrase = raw.trim();
    if (phrase.length < MIN_LENGTH) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(phrase);
    if (extra.length >= MAX_PHRASES) break;
  }
  if (extra.length === 0) return pack;
  return {
    ...pack,
    compliancePack: { ...cp, fictionPhrases: [...cp.fictionPhrases, ...extra] },
  };
}
