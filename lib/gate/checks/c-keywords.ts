import type {
  Failure,
  KeywordRules,
  KeywordStatus,
  KeywordTerm,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';
import { arr, normalize, subtractDisclaimers, termRegex } from '../util';
import type { GateContext } from './types';
import { disclaimerVariantsOf, fail } from './shared';
import { crossPackActionPairedNouns, crossPackDiseaseNouns } from './pack';

/**
 * C28 — KEYWORD PLACEMENT (WS3).
 *
 * WHY THIS CHECK EXISTS. The playbook's Phase 7 builds a keyword reference
 * naming every term the listing targets, deliberately avoids, or captures
 * indirectly — and it says, in as many words, that the reference's "all
 * placed" checkmarks were hand-written in the source project and that this is
 * the pattern that failed nine times. A machine check is what turns "all
 * content is based on the keyword reference" from a DESCRIPTION into an
 * ENFORCED INVARIANT. So:
 *
 *   `placed`       — every declared surface must ACTUALLY carry the term.
 *   `backend`      — must sit in the backend field and NOWHERE a customer reads.
 *   `negative`     — must appear NOWHERE at all. This is where rival brand names
 *                    live (R50): invisible on the page and a real trademark
 *                    exposure, so it gets a deterministic check of its own
 *                    rather than relying on someone remembering. The SUBJECT
 *                    product's own brand is not a rival and can never be one:
 *                    a live run marked it `negative` and this check correctly
 *                    failed it for appearing in `brand_name`/`manufacturer`,
 *                    where a compliant listing MUST carry it. That is fixed
 *                    where the incoherence is (the derivation boundary in
 *                    `lib/engine/keywordPlacement.ts` reclassifies the row and
 *                    records the correction on `note`) — NOT here. This leg is
 *                    unchanged: whatever reaches it saying `negative` is still
 *                    scanned on every surface, the invisible ones included.
 *   `candidate`    — a term held back for PPC / off-site / the next copy cycle.
 *                    It must NOT be in the current published copy, or the
 *                    "not yet" is a fiction. A live run wrote this status over
 *                    the product's OWN ingredient names and this leg reported
 *                    77 of them in one artifact — correctly, every time: the
 *                    terms were in the title, the attributes, the A+ and the
 *                    FAQ. The incoherence is fixed where it is made, at the
 *                    derivation boundary (`lib/engine/keywordPlacement.ts` now
 *                    derives this status like any other placement claim and
 *                    records the correction on `note`), NOT here. This leg is
 *                    byte-for-byte unchanged, which is what still catches a
 *                    STORED or hand-edited artifact.
 *   `captured-via` — the term is deliberately ABSENT and the demand is reached
 *                    through a compliant cluster instead, so BOTH halves are
 *                    checked: the route MUST be documented in `via` (K4), and
 *                    the term itself must appear NOWHERE — the same
 *                    everywhere-scan `candidate` gets, because the two statuses
 *                    make the same claim about the copy. While only `via` was
 *                    checked the status was a documented way to ship a banned
 *                    term: an undocumented captured-via is a banned term with a
 *                    label on it, and a documented one whose term is in the copy
 *                    is the same thing with better paperwork.
 *   `not-targeted` — NOT scanned here; the same absence claim as `candidate`
 *                    with a different strategy behind it, and it is derived at
 *                    the same boundary for the same reason. This check's
 *                    silence on it is deliberate and unchanged: the pair are
 *                    distinguished by INTENT, which no scan can read.
 *
 * WHERE THE ROWS COME FROM NOW, and why this check did not shrink. The
 * `surfaces` list and the placement status are no longer written by the model:
 * it was asserting where its own copy had put a term and was wrong 21-22 times
 * per live run on all three ASINs, and the repair loop could not converge
 * because each regeneration produced a fresh set of confident wrong claims.
 * `lib/engine/keywordPlacement.ts` DERIVES them from the finished copy using
 * the very reader below, so the artifact reaching this check is true by
 * construction. That derivation covers every status that states A FACT ABOUT
 * THE COPY — `placed`, `backend`, and (since E4) the two absence claims
 * `candidate` and `not-targeted`; only `negative` and `captured-via`, which
 * state an INTENT, are carried through untouched. Not one rule here was
 * relaxed for any of it: the placement leg stays because a STORED or
 * hand-edited artifact never went through that derivation, and the negative /
 * backend-leak / candidate / captured-via / four-test / closed-world /
 * minNegatives / fail-closed legs are all untouched. What disappeared is a
 * class of failure, not a class of enforcement.
 *
 * THE FOUR-TEST SCREEN (K4), reusing the gate's OWN lexicons. A term the
 * compliance pack already bans can never be `placed` or `backend`, whatever
 * the model declared: the screen's legality leg is not a second opinion, it is
 * the same lexicon C6/C19 enforce, asked one step earlier. That is what makes
 * it impossible for a named-condition keyword to be marked as targeted.
 *
 * CLOSED WORLD, BOTH DIRECTIONS. A declared surface outside the pack's
 * vocabulary is a failure, and a surface IN the pack's vocabulary that this
 * module cannot resolve to text is ALSO a failure — a surface name that
 * silently resolves to nothing would vouch for every term declared on it.
 *
 * EVERY CUSTOMER-READABLE STRING IS A SURFACE. The reader below must cover the
 * same text the operator ships, not a convenient subset of it: A+ banner ALT
 * and the 9:16 video brief are both customer-facing and both INVISIBLE on the
 * page, which is precisely where a stale agency template's rival brand name
 * survives. While `aplus` skipped `bannerAltText` and the video brief had no
 * surface name at all, a `negative` term planted in either produced no failure
 * and a verified run — R50 defeated by an omission in a reader. Both are
 * covered now; `tests/keywordPlacement.surfaces.test.ts` holds every leg in
 * both directions.
 *
 * PACK-DRIVEN. Every surface name, status word and threshold comes from
 * `rules.keywordRules`; this module holds none. `visibleSurfaces`,
 * `backendSurfaces`, `statuses` and `minNegatives` are all
 * `REQUIRED_PACK_PIECES` rows, because emptying any of them disarms a leg.
 */
const CHECK_ID = 'C28';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * Every A+ text field, flattened — INCLUDING the banner ALT strings.
 *
 * `bannerAltText` was missing from this reader while `aplus` was the declared
 * surface name for the whole module set, which made A+ ALT a hole with exactly
 * the shape R50 warns about: a rival brand name left in an old agency
 * template's ALT is invisible on the page, is a real trademark exposure, and
 * produced ZERO C28 failures. It is customer-facing text on a customer-facing
 * module and every other content scan already reads it (`aplusSurfaces` in
 * ./shared), so it is read here too.
 */
function aplusText(l: OptimizedListing): string {
  const a = l.aplusContent;
  if (!a || typeof a !== 'object') return '';
  const parts: string[] = [];
  for (const m of arr<{
    headline?: unknown;
    body?: unknown;
    subcopy?: unknown;
    bannerAltText?: unknown;
  }>(a.modules)) {
    parts.push(str(m?.headline), str(m?.body), str(m?.subcopy), str(m?.bannerAltText));
  }
  for (const r of arr<{ label?: unknown; ours?: unknown; typical?: unknown }>(a.comparison?.rows)) {
    parts.push(str(r?.label), str(r?.ours), str(r?.typical));
  }
  return parts.join(' \n ');
}

/**
 * EVERY string field of the 9:16 VIDEO BRIEF, flattened.
 *
 * The brief had no surface name at all, so a term planted in
 * `videoBrief.onScreenText` or `videoBrief.notes` sat outside C28's world
 * entirely: a NEGATIVE term (where rival brand names live, R50) was scanned
 * against a corpus that did not contain it, and a backend-only term could sit
 * in on-screen copy without tripping the leak rule. `VideoBrief`'s own note
 * says why that is wrong — the on-screen strings are read by the same OCR that
 * reads the images, so they ARE copy.
 *
 * Every string field is read, `aspect` and `notes` as well as the two arrays:
 * a surface reader that covers only part of its object is the same hole one
 * level down. `durationSeconds` is a number and can carry no term.
 */
function videoText(l: OptimizedListing): string {
  const v = l.videoBrief;
  if (!v || typeof v !== 'object') return '';
  return [
    str(v.aspect),
    ...arr<unknown>(v.shots).map(str),
    ...arr<unknown>(v.onScreenText).map(str),
    str(v.notes),
  ].join(' \n ');
}

/**
 * Resolve ONE declared surface name to its text.
 *
 * Returns `null` for a name this module does not know how to read — which the
 * caller turns into a FAILURE, never a skip.
 */
export function keywordSurfaceText(l: OptimizedListing, name: string): string | null {
  const bullets = arr<unknown>(l.bullets);
  const bulletMatch = /^bullet(\d+)$/i.exec(name);
  if (bulletMatch) {
    const idx = Number(bulletMatch[1]) - 1;
    // An out-of-range slot resolves to the EMPTY STRING, not to null: the
    // surface NAME is known, the slot is simply unfilled, and a term declared
    // on an unfilled slot must fail as unplaced.
    return idx >= 0 ? str(bullets[idx]) : null;
  }
  switch (name) {
    case 'title':
      return str(l.title);
    case 'title75':
      return str(l.title75);
    case 'itemHighlights':
      return str(l.itemHighlights);
    case 'bullets':
      return bullets.map(str).join(' \n ');
    case 'description':
      return str(l.description);
    case 'backend':
      return str(l.backendSearchTerms);
    case 'attributes':
      return Object.values(l.attributes && typeof l.attributes === 'object' ? l.attributes : {}).map(str).join(' \n ');
    case 'aplus':
      return aplusText(l);
    case 'video':
      return videoText(l);
    case 'faq':
      return arr<{ q?: unknown; a?: unknown }>(l.aplusContent?.faq).map((f) => `${str(f?.q)} ${str(f?.a)}`).join(' \n ');
    case 'qa':
      return arr<{ q?: unknown; a?: unknown }>(l.qa).map((f) => `${str(f?.q)} ${str(f?.a)}`).join(' \n ');
    case 'images':
      return arr<{ purpose?: unknown; spec?: unknown; notes?: unknown; altText?: unknown }>(l.imagePlan)
        .map((s) => `${str(s?.purpose)} ${str(s?.spec)} ${str(s?.notes)} ${str(s?.altText)}`)
        .join(' \n ');
    default:
      return null;
  }
}

const present = (hay: string, term: string): boolean => termRegex(term).test(hay);

/**
 * The FOUR-TEST SCREEN's legality leg: the gate's OWN banned lexicons.
 * Reused, never re-authored — see the header note.
 */
function bannedLexicon(pack: KnowledgePack): string[] {
  const out = new Set<string>();
  for (const n of crossPackDiseaseNouns(pack)) if (n.trim()) out.add(n);
  for (const n of crossPackActionPairedNouns(pack)) if (n.trim()) out.add(n);
  for (const cp of [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]) {
    for (const s of cp?.superlativeBans ?? []) if (s.trim()) out.add(s);
  }
  return [...out];
}

export function c28KeywordPlacement(
  l: OptimizedListing,
  pack: KnowledgePack,
  /**
   * Optional so a caller holding only a listing and a pack still works exactly
   * as before. `ctx.rivalBrands` is the AUTOMATIC negative set (see below);
   * absent or empty => not one byte of this check's behaviour changes.
   */
  ctx?: GateContext,
): Failure[] {
  const kr: KeywordRules | undefined = pack.rules?.keywordRules;
  // No pack rules => nothing to enforce. That is not a silent pass:
  // `rules.keywordRules.*` are REQUIRED_PACK_PIECES rows, so a
  // compliance-bearing pack that ships none already fails CLOSED at PACK.
  if (!kr) return [];

  const out: Failure[] = [];
  const terms = l.keywords;

  if (!Array.isArray(terms) || terms.length === 0) {
    return [
      fail(
        CHECK_ID,
        'keywords',
        '(empty)',
        'The keyword reference is missing or empty — every term the listing targets, avoids or recaptures must be declared so its placement can be verified',
      ),
    ];
  }

  const visible = (kr.visibleSurfaces ?? []).filter((s) => str(s).trim() !== '');
  const backendSurfaces = (kr.backendSurfaces ?? []).filter((s) => str(s).trim() !== '');
  const known = new Set([...visible, ...backendSurfaces]);
  const statuses = new Set((kr.statuses ?? []).filter((s) => str(s).trim() !== ''));
  const disclaimers = [pack.compliancePack, ...(pack.crossCheckCompliancePacks ?? [])]
    .filter((cp): cp is NonNullable<typeof cp> => !!cp)
    .flatMap((cp) => disclaimerVariantsOf(cp))
    .map(normalize);

  // CLOSED WORLD, the other direction.
  for (const name of known) {
    if (keywordSurfaceText(l, name) === null) {
      out.push(
        fail(
          CHECK_ID,
          'keywords',
          `surface '${name}'`,
          'The pack declares a keyword surface the gate cannot read — add a resolver or remove the surface, never leave it silently unscanned',
        ),
      );
    }
  }

  const banned = bannedLexicon(pack);
  const hayCache = new Map<string, string | null>();
  const hayOf = (name: string): string | null => {
    if (!hayCache.has(name)) {
      const raw = keywordSurfaceText(l, name);
      hayCache.set(name, raw === null ? null : subtractDisclaimers(normalize(raw), disclaimers));
    }
    return hayCache.get(name) ?? null;
  };
  const everywhere = (): { name: string; hay: string }[] =>
    [...known]
      .map((name) => ({ name, hay: hayOf(name) }))
      .filter((e): e is { name: string; hay: string } => e.hay !== null);

  let negatives = 0;

  terms.forEach((raw, i) => {
    const field = `keywords[${i}]`;
    const t = (raw ?? {}) as Partial<KeywordTerm>;
    const term = str(t.term).trim();
    const status = str(t.status).trim() as KeywordStatus;

    if (!term) {
      out.push(fail(CHECK_ID, field, '(empty term)', 'Every keyword row needs a term'));
      return;
    }
    if (!str(t.why).trim()) {
      out.push(
        fail(
          CHECK_ID,
          field,
          `'${term}' has no evidence`,
          'Every keyword row must state WHY it carries its tier and status — an undocumented row cannot be reviewed or defended',
        ),
      );
    }
    if (!statuses.has(status)) {
      out.push(
        fail(
          CHECK_ID,
          field,
          `'${term}' status '${status || '(none)'}'`,
          `Status must be one of: ${[...statuses].join(', ')}`,
        ),
      );
      return;
    }

    const declared = (Array.isArray(t.surfaces) ? t.surfaces : [])
      .map((s) => str(s).trim())
      .filter(Boolean);
    for (const name of declared) {
      if (!known.has(name)) {
        out.push(
          fail(
            CHECK_ID,
            field,
            `'${term}' declares unknown surface '${name}'`,
            `Declared surfaces must come from the pack vocabulary: ${[...known].join(', ')}`,
          ),
        );
      }
    }

    // --- the four-test screen (legality leg) ---
    if (status === 'placed' || status === 'backend') {
      const hit = banned.find((b) => termRegex(b).test(normalize(term)));
      if (hit) {
        out.push(
          fail(
            CHECK_ID,
            field,
            `'${term}' matches the banned lexicon ('${hit}')`,
            'A term the compliance lexicon bans can never be targeted — record it as negative, or as captured-via with the compliant cluster named in `via`',
          ),
        );
      }
    }

    switch (status) {
      case 'placed': {
        if (declared.length === 0) {
          out.push(
            fail(
              CHECK_ID,
              field,
              `'${term}' is placed but declares no surface`,
              'A placed term must declare at least one surface, so the placement can be verified',
            ),
          );
          break;
        }
        for (const name of declared) {
          const hay = hayOf(name);
          if (hay === null) continue; // already reported as unknown/unreadable
          if (!present(hay, term)) {
            out.push(
              fail(
                CHECK_ID,
                field,
                `'${term}' is declared placed on '${name}' but does not appear there`,
                `Write '${term}' into ${name}, or correct the row's declared surfaces — a hand-written placement claim is what this check exists to stop`,
              ),
            );
          }
        }
        break;
      }
      case 'backend': {
        const inBackend = backendSurfaces.some((name) => {
          const hay = hayOf(name);
          return hay !== null && present(hay, term);
        });
        if (!inBackend) {
          out.push(
            fail(
              CHECK_ID,
              field,
              `'${term}' is backend-only but is not in the backend field`,
              `Add '${term}' to the backend search terms, or change its status`,
            ),
          );
        }
        for (const { name, hay } of everywhere()) {
          if (backendSurfaces.includes(name)) continue;
          if (present(hay, term)) {
            out.push(
              fail(
                CHECK_ID,
                field,
                `'${term}' is backend-only but also appears on visible surface '${name}'`,
                'A backend-only term buys discovery the visible copy cannot spend characters on — repeating it visibly wastes the byte budget and breaks the declaration',
              ),
            );
          }
        }
        break;
      }
      case 'negative': {
        negatives++;
        for (const { name, hay } of everywhere()) {
          if (present(hay, term)) {
            out.push(
              fail(
                CHECK_ID,
                field,
                `negative term '${term}' appears on '${name}'`,
                `Remove '${term}' from ${name} — it is on the negative list (${str(t.why).trim() || 'no reason recorded'})`,
              ),
            );
          }
        }
        break;
      }
      case 'candidate': {
        for (const { name, hay } of everywhere()) {
          if (present(hay, term)) {
            out.push(
              fail(
                CHECK_ID,
                field,
                `candidate term '${term}' already appears on '${name}'`,
                `A candidate is held back for a later cycle — remove '${term}' from ${name}, or promote the row to placed and declare its surfaces`,
              ),
            );
          }
        }
        break;
      }
      case 'captured-via': {
        // K4, LEG ONE — the recapture ROUTE must be documented.
        if (!str(t.via).trim()) {
          out.push(
            fail(
              CHECK_ID,
              field,
              `'${term}' is captured-via with no route recorded`,
              'Name the compliant cluster this demand reaches the listing through in `via` — an undocumented recapture is what lets a later cycle re-add the banned term',
            ),
          );
        }
        // K4, LEG TWO — the term itself must be ABSENT EVERYWHERE. This is not
        // an extra rule bolted on: it is what `captured-via` MEANS. The status
        // says the demand reaches the listing through a DIFFERENT cluster
        // BECAUSE the term itself cannot be written, so a `captured-via` row
        // whose term is sitting in the copy is a contradiction in its own
        // terms. While only `via` was checked, the label was a way to say "this
        // term is banned" and ship it anyway: a rival brand row flipped from
        // `negative` to `captured-via` with any route string, plus the brand in
        // an image ALT, produced ZERO failures and a verified run — the exact
        // R50 bypass item 1 of CONFORMANCE-DEVIATIONS.md closed for a reader
        // hole, reopened through a status word. The scan is the SAME one
        // `candidate` gets above, over the SAME `everywhere()` corpus, because
        // the two statuses make the same claim about the copy.
        for (const { name, hay } of everywhere()) {
          if (present(hay, term)) {
            out.push(
              fail(
                CHECK_ID,
                field,
                `captured-via term '${term}' appears on '${name}'`,
                `A captured-via row states the term is deliberately ABSENT and the demand is reached through '${str(t.via).trim() || '(no route recorded)'}' instead — remove '${term}' from ${name}, or record the row for what it is`,
              ),
            );
          }
        }
        break;
      }
      default:
        // 'not-targeted' — a deliberate strategy call, deliberately not scanned.
        break;
    }
  });

  // =========================================================================
  // THE AUTOMATIC RIVAL-BRAND NEGATIVES — a signal that does NOT read a label.
  // =========================================================================
  //
  // Everything above this line is conditioned on what the MODEL wrote in
  // `status`. That is the right split for an INTENT (only judgement can say a
  // term is being held back), and it is a hole for a FACT: a rival brand the
  // model happens to label `placed` is in no lexicon the four-test screen
  // reads — that screen covers the compliance pack's disease nouns,
  // action-paired nouns and superlative bans, and a brand name is none of
  // those — so C28 guaranteed LABELLED-NEGATIVE absence rather than RIVAL
  // absence.
  //
  // The operator hands the run its own answer: the competitor ASINs they typed
  // are INGESTED (WS9), and each ingested snapshot carries the rival's brand in
  // its own marketplace brand fields. `lib/audit/rivalBrands.ts` resolves that
  // into this list and the AUDIT supplies it, so no route can forget it and the
  // gate itself stays free of ingestion. Each name is then treated EXACTLY as a
  // model-declared `negative` row would be: the same `everywhere()` corpus, the
  // same `termRegex`, the same "appears nowhere" rule.
  //
  // CONSERVATIVE BY CONSTRUCTION — the bounds live in the resolver, not here:
  // the set is empty unless competitors were actually supplied, the subject's
  // OWN identity is subtracted from it, and a single-word brand is never
  // admitted. See that module's header for why each bound exists.
  //
  // IT CANNOT INFLATE THE FLOOR. These names are not rows in the artifact and
  // `negatives` is not incremented here: `minNegatives` still counts only what
  // the reference itself records, so supplying competitors can never be a way
  // to satisfy the floor without writing the rows.
  const declaredNegatives = new Set(
    terms
      .filter((raw) => str((raw as Partial<KeywordTerm> | null)?.status).trim() === 'negative')
      .map((raw) => normalize(str((raw as Partial<KeywordTerm> | null)?.term)).trim().toLowerCase()),
  );
  for (const brand of ctx?.rivalBrands ?? []) {
    const name = str(brand).trim();
    if (!name) continue;
    // Already recorded as a negative by the reference itself — the leg above
    // scans it and reports it; saying the same thing twice helps nobody.
    if (declaredNegatives.has(normalize(name).toLowerCase())) continue;
    for (const { name: surface, hay } of everywhere()) {
      if (present(hay, name)) {
        out.push(
          fail(
            CHECK_ID,
            'keywords',
            `ingested competitor brand '${name}' appears on '${surface}'`,
            `'${name}' is the brand of a competitor ASIN the operator supplied for this run, so it is a rival brand by construction — remove it from ${surface}. A rival's name in our copy is trademark exposure (R50) whatever status the keyword reference gives it, and it belongs on the negative list rather than in the listing`,
          ),
        );
      }
    }
  }

  // THE FLOOR COUNTS ONLY SURVIVING NEGATIVES. `negatives` was incremented in
  // the loop above, over the FINAL artifact — so a row the derivation
  // reclassified (the subject product's own brand can never be a rival, see
  // lib/engine/keywordPlacement.ts) no longer carries `negative` here and is
  // not counted. A run whose only negatives were self-references therefore
  // FAILS this floor rather than satisfying it with its own name.
  const min = typeof kr.minNegatives === 'number' ? kr.minNegatives : 0;
  if (negatives < min) {
    out.push(
      fail(
        CHECK_ID,
        'keywords',
        `${negatives} negative term(s)`,
        `The keyword reference must record at least ${min} negative terms — the banned vocabulary and every rival brand name belong on it, or the next copy cycle re-adds them`,
      ),
    );
  }

  return out;
}
