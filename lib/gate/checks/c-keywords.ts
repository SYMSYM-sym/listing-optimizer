import type {
  Failure,
  KeywordRules,
  KeywordStatus,
  KeywordTerm,
  KnowledgePack,
  OptimizedListing,
} from '@/lib/types';
import { arr, normalize, subtractDisclaimers, termRegex } from '../util';
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
 *                    rather than relying on someone remembering.
 *   `candidate`    — a term held back for PPC / off-site / the next copy cycle.
 *                    It must NOT be in the current published copy, or the
 *                    "not yet" is a fiction.
 *   `captured-via` — NOT scanned (the term is deliberately absent), but the
 *                    compliant route MUST be documented in `via` (K4). An
 *                    undocumented captured-via is a banned term with a label on it.
 *   `not-targeted` — NOT scanned; a deliberate strategy call.
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
 * PACK-DRIVEN. Every surface name, status word and threshold comes from
 * `rules.keywordRules`; this module holds none. `visibleSurfaces`,
 * `backendSurfaces`, `statuses` and `minNegatives` are all
 * `REQUIRED_PACK_PIECES` rows, because emptying any of them disarms a leg.
 */
const CHECK_ID = 'C28';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Every A+ text field, flattened. */
function aplusText(l: OptimizedListing): string {
  const a = l.aplusContent;
  if (!a || typeof a !== 'object') return '';
  const parts: string[] = [];
  for (const m of arr<{ headline?: unknown; body?: unknown; subcopy?: unknown }>(a.modules)) {
    parts.push(str(m?.headline), str(m?.body), str(m?.subcopy));
  }
  for (const r of arr<{ label?: unknown; ours?: unknown; typical?: unknown }>(a.comparison?.rows)) {
    parts.push(str(r?.label), str(r?.ours), str(r?.typical));
  }
  return parts.join(' \n ');
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

export function c28KeywordPlacement(l: OptimizedListing, pack: KnowledgePack): Failure[] {
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
        // K4: the demand is recaptured through a DOCUMENTED compliant route.
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
        break;
      }
      default:
        // 'not-targeted' — a deliberate strategy call, deliberately not scanned.
        break;
    }
  });

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
