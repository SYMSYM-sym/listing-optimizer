import type { KeywordRules, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { demandRecaptureBlock, keywordVocabularyBlock, snapshotBlock } from './shared';

/**
 * WS3 — the KEYWORD REFERENCE prompt (playbook Phase 7).
 *
 * WHY IT RUNS LAST (phase 3, after every copy group). The reference is about
 * the FINISHED listing — which terms it targets, which it deliberately avoids,
 * and which demand it recaptures — so it is written against copy that exists
 * rather than copy that is being written at the same instant.
 *
 * WHAT IS NO LONGER ASKED FOR: the PLACEMENT MAP. This prompt used to require
 * the model to state which surfaces its own copy had placed each term on, and
 * on all three live ASINs it was wrong 21–22 times per run ("declared placed
 * on 'title' but does not appear there"), never converging, because each
 * repair round invented a fresh set of confident wrong claims. Whether an
 * exact string occurs in an exact field is a fact CODE CAN COMPUTE, so code
 * computes it (`lib/engine/keywordPlacement.ts`) from these very strings and
 * the gate re-derives it independently. Worker != checker: the model is asked
 * only for what it alone can judge — which terms matter, why, and which ones
 * must be kept OUT. Asking for a field and then overwriting it would spend
 * output tokens on drift.
 *
 * QUALITATIVE BY MANDATE. The playbook forbids search-volume tools, and this
 * system calls none: a term earns its tier from evidence that can be pointed
 * at, never from a number an API returned. The instruction says so explicitly
 * so the model does not invent one.
 *
 * E4 — WHAT `candidate` AND `not-targeted` ACTUALLY MEAN, said here because a
 * live run got it wrong 77 times in one artifact. Both words describe a term
 * that is ABSENT FROM THE COPY PRINTED ABOVE; the run that failed wrote them
 * over the product's own ingredient names, which are in the title, the
 * attributes, the A+ and the FAQ because the listing is about them. That is a
 * claim about the copy, so code now measures it and corrects the row — and the
 * instruction below states the meaning plainly, because a status the model
 * understands is one code has to correct less often.
 *
 * E6 — WHAT `negative` IS FOR, said here for the same reason and from the same
 * kind of pack line. Two live runs used it as a bin for "terms I chose not to
 * target" and put the product's OWN ingredient and its OWN diet attribute on it;
 * the copy carries both legitimately, C28 reported them correctly, and the run
 * could not converge, because `negative` is the ONE status derivation must never
 * overwrite — for a genuine rival, presence in the copy IS the violation. The
 * incoherent classification is rejected in code at the derivation boundary; the
 * `negativeScopeNote` line rendered below is what stops it being proposed.
 *
 * J2 — HOW MANY NEGATIVES, AND WHERE THEY COME FROM. A live run produced ZERO
 * negative rows (`C28 | keywords | 0 negative term(s)`). Every note above tells
 * the model what `negative` is FOR; none of them said the reference owes a
 * MINIMUM number of them, because `minNegatives` was pack data the gate read and
 * the prompt did not render — `maxTerms` and `whyMaxChars` were both rendered,
 * the one number a run can FAIL on was not. And the only source those notes led
 * with is "every rival brand name", which on a run with no operator competitor
 * ASINs asks the model to invent companies. Both halves are fixed below: the
 * floor is rendered from the same pack number the gate enforces, and
 * `negativeSourceNote` (pack data) names the source that is available on every
 * run — the vocabulary the compliance rules rule out, which C28 already credits
 * toward the floor — while refusing the invention of a rival outright.
 */
export interface KeywordSurfacesView {
  title: string;
  title75: string;
  itemHighlights: string;
  bullets: string[];
  description: string;
  backendSearchTerms: string;
  attributes: Record<string, string>;
}

export function keywordSurfacesOf(l: {
  title: string;
  title75: string;
  itemHighlights: string;
  bullets: string[];
  description: string;
  backendSearchTerms: string;
  attributes: Record<string, string>;
}): KeywordSurfacesView {
  return {
    title: l.title,
    title75: l.title75,
    itemHighlights: l.itemHighlights,
    bullets: l.bullets,
    description: l.description,
    backendSearchTerms: l.backendSearchTerms,
    attributes: l.attributes,
  };
}

/** The A+/FAQ/Q&A text a term may also be declared on. */
function extraSurfaces(l: Partial<OptimizedListing>): string {
  const a = l.aplusContent;
  const aplus = (a?.modules ?? [])
    .map((m) => `${m.headline} ${m.body}${m.subcopy ? ` ${m.subcopy}` : ''}`)
    .join(' | ');
  const faq = (a?.faq ?? []).map((f) => `${f.q} ${f.a}`).join(' | ');
  const qa = (l.qa ?? []).map((f) => `${f.q} ${f.a}`).join(' | ');
  const lines: string[] = [];
  if (aplus.trim()) lines.push(`aplus: ${aplus.slice(0, 1600)}`);
  if (faq.trim()) lines.push(`faq: ${faq.slice(0, 1200)}`);
  if (qa.trim()) lines.push(`qa: ${qa.slice(0, 1200)}`);
  return lines.join('\n');
}

export function keywordsPrompt(
  snapshot: ListingSnapshot,
  emitted: KeywordSurfacesView & Partial<OptimizedListing>,
  kr: KeywordRules | undefined,
): string {
  const vocabulary = keywordVocabularyBlock(kr);
  const recapture = demandRecaptureBlock(kr);
  // D1 — the artifact is a LIST, and a list with no stated end is what ran the
  // group into the output-token ceiling on every live run (truncated JSON, then
  // a truncated retry, then a 502). Both caps are pack data and BOTH are stated
  // here, because the schema that enforces them and the budget that pays for
  // them are computed from the same two numbers.
  const budget =
    typeof kr?.maxTerms === 'number' && kr.maxTerms > 0
      ? `- SIZE: at most ${kr.maxTerms} rows in total, across every status. This is a hard limit — a reference that runs past it is cut off mid-row and cannot be read at all.`
      : '';
  const whyLimit =
    typeof kr?.whyMaxChars === 'number' && kr.whyMaxChars > 0
      ? `, at most ${kr.whyMaxChars} characters`
      : '';
  // The OWN-BRAND line, from PACK DATA (this module holds no lexicon). A live
  // run put the subject product's own brand on the negative list, and C28 then
  // correctly failed it for appearing in the brand attributes it must appear
  // in, so the run could not converge. Code rejects the classification at the
  // derivation boundary; this stops it being proposed in the first place.
  const ownBrand =
    typeof kr?.ownBrandNote === 'string' && kr.ownBrandNote.trim() !== ''
      ? `- ${kr.ownBrandNote.trim()}`
      : '';
  // E6 — the SCOPE of `negative`, from PACK DATA (this module holds no lexicon).
  // The own-brand line above covers ONE instance of a class; this covers the
  // class. A live run used the negative list as a bin for "terms I chose not to
  // target" and put the product's own ingredient and its own diet attribute on
  // it; the copy legitimately carried both, C28 correctly reported them, and the
  // run could not converge — `negative` is the one status the derivation must
  // never overwrite, because for a genuine rival its presence in the copy IS the
  // violation. Code rejects the incoherent classification at the derivation
  // boundary; this line stops it being proposed.
  const negativeScope =
    typeof kr?.negativeScopeNote === 'string' && kr.negativeScopeNote.trim() !== ''
      ? `- ${kr.negativeScopeNote.trim()}`
      : '';
  // J2 — THE FLOOR, AND WHERE THE ROWS THAT MEET IT COME FROM.
  //
  // Live, ASIN B00IO89MYA: `C28 | keywords | 0 negative term(s)`. The model
  // wrote no negative rows at all — and nothing it had been shown ever told it
  // that a MINIMUM existed. `minNegatives` was pack data read only by the gate:
  // `maxTerms` and `whyMaxChars` were both rendered here, the floor was not, so
  // the one number the artifact could FAIL on was the one number the writer was
  // never given. The instructions that did mention `negative` said what the
  // status is for, never how many the reference owes.
  //
  // The number alone would not have been enough, and that is the second half of
  // the fix. The only source those instructions led with is "every rival brand
  // name" — and on a run with no operator competitor ASINs the model has NO
  // rival-brand knowledge, so an instruction to record them is an instruction to
  // invent companies. That cannot converge honestly. The source that is always
  // available is the vocabulary the compliance rules rule out, which is printed
  // in this same prompt and which C28 already credits toward the floor (a
  // compliance-owned negative is DEFERRED to the check that owns it and still
  // counts). `negativeSourceNote` is PACK DATA saying exactly that, including
  // the refusal to invent a competitor — this module holds no lexicon and no
  // instruction of its own.
  const floor =
    typeof kr?.minNegatives === 'number' && kr.minNegatives > 0
      ? `- FLOOR: at least ${kr.minNegatives} rows must carry the "must appear nowhere" status. This is checked: a reference that records fewer is sent back, and one that records none has not done the job at all.`
      : '';
  const negativeSource =
    typeof kr?.negativeSourceNote === 'string' && kr.negativeSourceNote.trim() !== ''
      ? `- ${kr.negativeSourceNote.trim()}`
      : '';
  const surfaces = [
    'THE FINISHED COPY (read it — this is the listing your reference describes, and the placement map is computed from these exact strings):',
    `title: ${emitted.title}`,
    `title75: ${emitted.title75}`,
    `itemHighlights: ${emitted.itemHighlights}`,
    ...(emitted.bullets ?? []).map((b, i) => `bullet${i + 1}: ${b}`),
    `description: ${(emitted.description ?? '').slice(0, 1800)}`,
    `backend: ${emitted.backendSearchTerms}`,
    `attributes: ${JSON.stringify(emitted.attributes ?? {}).slice(0, 1600)}`,
    extraSurfaces(emitted),
  ]
    .filter((s) => s.trim() !== '')
    .join('\n');

  return `${snapshotBlock(snapshot)}

${surfaces}

${vocabulary}

TASK: The keyword reference for this listing — one row per term.

${budget}
${recapture}
- QUALITATIVE ONLY. Never cite, invent or imply a search-volume figure: a row earns its tier from evidence you can point at (what the category leaders lead with, what the label states, what a shopper would type), never from a number.
- DO NOT list surfaces, and do not say where a term sits. The placement map is computed from the copy above after you answer (see the STATUS note above) — a list you write here would only be overwritten, so spend the words on WHICH terms belong in the reference and WHY.
- Choose the status from the vocabulary above. The judgements are yours: what must appear nowhere (every rival brand name and every term the compliance rules above forbid), what is deliberately left alone, what is held back for a later cycle, and what demand is recaptured through a compliant cluster named in "via".
- THE TWO ABSENCE WORDS ARE FOR TERMS THE COPY ABOVE DOES NOT CARRY. "Held back for a later cycle" and "deliberately left alone" both say the term is NOT in this listing. Every ingredient you can read in the copy above, every spec it states and every phrase it uses IS in this listing — such a row is a placement, and code records it as one from the copy itself. Spend those two statuses on terms you are choosing to leave out.
- "why" is required on every row: ONE short sentence of evidence${whyLimit}. It is evidence, not an essay.
- A row that says a rival's brand name, or any term the compliance rules above forbid, belongs on the negative list. Every negative row states its reason in "why".
${floor}
${negativeSource}
${negativeScope}
${ownBrand}
- Cover the listing properly WITHIN THAT BUDGET: the head terms, the named entities, the qualifier and trust terms, the buyer-language phrases, the invisible-only variants, and the terms this listing deliberately leaves alone. Spend the rows on the terms that decide the listing; a near-duplicate of a row you have already written earns nothing.

Return JSON: { "keywords": [{ "term", "tier", "status", "why", "via", "home" } ...] }
"via" is required for recaptured demand; "home" is required for a future-cycle row; both are omitted elsewhere. There is no "surfaces" field — the placement map is computed from the copy above.`;
}
