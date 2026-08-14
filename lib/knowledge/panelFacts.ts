import type { ListingSnapshot } from '@/lib/types';

/**
 * WS5.5 / AM-5 #4 — THE OPERATOR PANEL CONFIRMATION.
 *
 * THE GAP THIS CLOSES. Every canonical fact this app enforces is EXTRACTED —
 * parsed out of a scraped detail page by `lib/engine/facts.ts`. That is the
 * "facts fragility" open item: a live page whose structured attributes are
 * missing, stale or written in someone else's house style produces a facts
 * block that is thin or simply wrong, and C12 then holds every surface to it.
 * The plan's answer is not a better parser. It is the person sitting in front
 * of the physical label: the operator reads the values off the panel, confirms
 * them, and for THAT RUN they are product truth.
 *
 * THE CONTRACT, deliberately narrow and deliberately per-run:
 *
 *  - AUTHORITATIVE, not advisory. A confirmed value OVERLAYS the scraped
 *    attribute of the same key before the facts producer reads it, so the
 *    canonical facts block — the thing the prompts are given and C12 measures
 *    every surface against — carries the operator's number, not the page's.
 *  - PER RUN. It arrives on the request body and lives exactly as long as the
 *    request. Nothing here writes to `knowledge/`, and nothing merges it into
 *    the pack: it is a fact about ONE product on ONE day, which is precisely
 *    why it cannot be pack data. (Contrast `fictionPhrases`, which is also
 *    per-run but merges into a CLONE of the compliance pack because C11 reads
 *    it from there.)
 *  - NON-MUTATING. The caller's snapshot and attribute map are never written
 *    to; the overlay is built fresh.
 *  - ABSENT MEANS UNCHANGED. With no panel supplied every downstream call is
 *    handed the very same object it was handed before this existed, so the
 *    behaviour is byte-identical. `tests/operatorInputs.panel.test.ts` asserts
 *    that rather than assuming it.
 *
 * WHAT IT IS NOT. It is not a way to license a claim. A confirmed panel changes
 * what the canonical NUMBER is; it cannot make an unlawful phrasing lawful, it
 * cannot satisfy a disclaimer, and it does not touch C24 — a dosage-keyed
 * attribute asserting a hero figure fails whether or not the figure is
 * confirmed, because C24's objection is to stating the number AS A DOSE in
 * filter-fed structured data, not to the number being wrong.
 */
export type PanelFacts = Record<string, string>;

/** A panel is a handful of confirmed label values, not a document. */
const MAX_ENTRIES = 40;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 200;

/**
 * Normalize an untrusted request field into a panel, or `undefined`.
 *
 * `undefined` (never `{}`) for anything unusable, so the "absent means
 * unchanged" contract above is a single `if` at every call site rather than a
 * per-caller emptiness convention.
 */
export function normalizePanelFacts(input: unknown): PanelFacts | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: PanelFacts = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_ENTRIES) break;
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.trim();
    const value = rawValue.trim();
    // An empty confirmed value is not a confirmation of emptiness — it is a
    // blank box the operator did not fill in, and blanking a scraped fact from
    // a blank box would silently delete truth rather than supply it.
    if (!key || !value) continue;
    if (key.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) continue;
    out[key] = value;
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * The attribute map the FACTS PRODUCER should read for this run.
 *
 * Returns the caller's own map by REFERENCE when there is no panel — the
 * byte-identical guarantee, made structural.
 */
export function panelAttributes(
  attributes: Readonly<Record<string, string>>,
  panel?: PanelFacts,
): Readonly<Record<string, string>> {
  if (!panel) return attributes;
  return { ...attributes, ...panel };
}

/**
 * The snapshot as the operator confirmed it — used where a whole snapshot,
 * rather than its attribute map, is the unit of work.
 */
export function withPanelFacts(
  snapshot: ListingSnapshot,
  panel?: PanelFacts,
): ListingSnapshot {
  if (!panel) return snapshot;
  return { ...snapshot, attributes: { ...snapshot.attributes, ...panel } };
}
