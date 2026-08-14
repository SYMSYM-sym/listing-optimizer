import { parseAsin } from '@/lib/ingest/parseAsin';

/**
 * THE OPTIONAL OPERATOR INPUTS, parsed once — the form's half of WS5.5/WS9/R45.
 *
 * Four per-run inputs already existed on the API and had no way in: pasted
 * review text (WS9), competitor ASINs (WS9), known-false phrases (R45/C11) and
 * the confirmed label panel (WS5.5). They are all OPTIONAL and all per-run:
 * nothing here is stored, and none of them is required for a run.
 *
 * ONE RULE GOVERNS THE WHOLE MODULE: an operator who touches none of these
 * fields must send exactly the body that was sent before they existed. So
 * `buildOperatorInputs` OMITS a key entirely rather than sending `''`, `[]` or
 * `{}` — an empty string in `reviewsText` would flip `usedReviews` and score
 * principle P11 against a corpus nobody supplied, and an empty object in
 * `panelFacts` would be a confirmation of nothing. Absence and emptiness are
 * different statements and the request body says which one it means.
 *
 * Parsing lives here rather than inline in the component so it is testable
 * without a DOM — see `tests/operatorInputs.form.test.ts`.
 */

/** The playbook's Phase 4 benchmarks 3–4 competitors; the route caps at 4 too. */
export const MAX_COMPETITOR_ASINS = 4;

/**
 * Competitor ASINs from free text: newline-, comma- or space-separated, bare
 * ASINs or full product URLs. Invalid entries are DROPPED rather than sent —
 * the route would drop them anyway, and showing the operator the accepted list
 * is how they find out they pasted a search URL.
 */
export function parseCompetitorAsins(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const asin = parseAsin(trimmed);
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);
    out.push(asin);
    if (out.length >= MAX_COMPETITOR_ASINS) break;
  }
  return out;
}

/** One known-false descriptor per line (C11). Blank lines are not phrases. */
export function parseFictionPhrases(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const phrase = line.trim();
    // Matches the server-side floor in lib/knowledge/operatorInputs.ts: a one-
    // or two-character "phrase" would match everywhere.
    if (phrase.length < 3) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}

/**
 * Confirmed label values, one `key: value` per line.
 *
 * The KEY is the structured attribute key the fact producer reads
 * (`rules.factFields`), which is why the field's help text — pack data —
 * carries the example. A line with no separator is not a confirmation of
 * anything and is skipped rather than guessed at.
 */
export function parsePanelFacts(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

export interface OperatorInputForm {
  reviewsText: string;
  competitorAsins: string;
  fictionPhrases: string;
  panelFacts: string;
}

export const EMPTY_OPERATOR_INPUTS: OperatorInputForm = {
  reviewsText: '',
  competitorAsins: '',
  fictionPhrases: '',
  panelFacts: '',
};

export interface OperatorInputBody {
  reviewsText?: string;
  competitorAsins?: string[];
  fictionPhrases?: string[];
  panelFacts?: Record<string, string>;
}

/** The request-body fragment. Untouched fields contribute NO key at all. */
export function buildOperatorInputs(form: OperatorInputForm): OperatorInputBody {
  const body: OperatorInputBody = {};
  if (form.reviewsText.trim()) body.reviewsText = form.reviewsText;
  const asins = parseCompetitorAsins(form.competitorAsins);
  if (asins.length > 0) body.competitorAsins = asins;
  const phrases = parseFictionPhrases(form.fictionPhrases);
  if (phrases.length > 0) body.fictionPhrases = phrases;
  const panel = parsePanelFacts(form.panelFacts);
  if (Object.keys(panel).length > 0) body.panelFacts = panel;
  return body;
}

/**
 * The subset a REGENERATE call carries.
 *
 * A regeneration must not be a way to escape a per-run input the operator set:
 * the phrases still apply (C11 reads them) and the confirmed panel is still
 * product truth. Review text and competitors are not here because they feed
 * the ORIGINAL generation and the benchmark, both of which a single-group
 * regeneration does not redo — the route accepts neither.
 */
export function regenerateOperatorInputs(form: OperatorInputForm): OperatorInputBody {
  const { fictionPhrases, panelFacts } = buildOperatorInputs(form);
  return {
    ...(fictionPhrases ? { fictionPhrases } : {}),
    ...(panelFacts ? { panelFacts } : {}),
  };
}
