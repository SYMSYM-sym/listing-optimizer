import 'server-only';
import { env } from '@/lib/env';
import type {
  AplusContent,
  KeywordStatus,
  KeywordTerm,
  KeywordTier,
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
} from '@/lib/types';
import { logServer } from '@/lib/server/log';
import { sanitizeBackendSearchTerms } from './backendSanitize';
import { sanitizeBullets } from './bulletSanitize';
import { buildFacts } from './facts';
import { normalizeListingTypography } from './typography';
import { generateGroup, type LlmClient } from './llm';
import { buildGroupPrompts, buildSystemPrompt } from './prompts';
import {
  aplusGroupSchema,
  keywordsGroupSchema,
  attributesGroupSchema,
  backendGroupSchema,
  bulletsGroupSchema,
  descriptionGroupSchema,
  imagesGroupSchema,
  qaGroupSchema,
  titleGroupSchema,
} from './schemas';

/** Groups the repair loop can regenerate independently. */
export type GroupName =
  | 'title'
  | 'bullets'
  | 'description'
  | 'backend'
  | 'attributes'
  | 'aplus'
  | 'images'
  | 'qa'
  | 'keywords';

export const ALL_GROUPS: GroupName[] = [
  'title',
  'bullets',
  'description',
  'backend',
  'attributes',
  'aplus',
  'images',
  'qa',
  // WS3 — PHASE 3. Runs AFTER every copy group because it READS the finished
  // surfaces; see the phase-3 comment below.
  'keywords',
];

/**
 * Deterministic disclaimer assembly (generation policy, NOT gate laundering):
 * the verbatim constant is code-inserted where the contract requires it;
 * the LLM never writes it. The gate independently verifies afterwards.
 */
function appendDisclaimer(text: string, disclaimer: string): string {
  return text.includes(disclaimer) ? text : `${text.trimEnd()}\n\n${disclaimer}`;
}

/**
 * Pin the canonical product name across repair regenerations.
 *
 * WHY THIS IS NOT GATE LAUNDERING — read before "simplifying" it away.
 * `productName` is a canonical IDENTIFIER, not generated copy. Three checks
 * require the SAME identifier to appear on surfaces owned by DIFFERENT prompt
 * groups: C8 (must start `title`, must appear in `description`), C15 (must
 * start `title75`) and A4 (must appear in the A+ brand-story and hero modules).
 * A repair round that regenerates ONLY the title group therefore cannot be
 * allowed to invent a new name: the description and the A+ modules were written
 * in an earlier round against the old one, so a rename instantly breaks A4/C8
 * and the loop oscillates (fix C15 → break A4 → fix A4 → break C15).
 *
 * Pinning keeps that identifier stable. It rewrites NOTHING else: no title, no
 * title75, no bullet, no description sentence, no A+ body is touched. The gate
 * then re-validates every surface independently and fails closed exactly as
 * before — if the regenerated `title`/`title75` do not actually LEAD with the
 * pinned name, or the A+ modules do not actually contain it, C8/C15/A4 still
 * fail and the run is still reported unverified. This is the opposite of
 * mutating copy to force a pass: it removes a moving target so the gate's
 * verdict is about the copy rather than about which name the model felt like
 * using this round.
 */
export function pinProductName(
  listing: OptimizedListing,
  pinned: string | undefined,
): OptimizedListing {
  if (!pinned || listing.productName === pinned) return listing;
  // Observability: the model TRIED to rename mid-run. Log the fact and the
  // lengths only — never the copy itself (see lib/server/log.ts contract).
  logServer('repair.product_name_pinned', {
    pinnedLength: pinned.length,
    regeneratedLength: listing.productName?.length ?? 0,
  });
  return { ...listing, productName: pinned };
}

export interface OptimizeOptions {
  /** Regenerate only these groups, merging over `base` (repair loop). */
  groups?: GroupName[];
  base?: OptimizedListing;
  /** Failure context per group, injected into regeneration prompts. */
  failureContext?: Partial<Record<GroupName, string>>;
}

export async function optimize(
  snapshot: ListingSnapshot,
  pack: KnowledgePack,
  llm: LlmClient,
  opts: OptimizeOptions = {},
): Promise<OptimizedListing> {
  const facts = buildFacts(snapshot, pack);
  // Detected subcategories flow in on the snapshot (pipeline enriches it) so
  // the prompt teaches exactly the noun set the gate will enforce.
  const system = buildSystemPrompt(pack, facts, snapshot.subcategory ?? []);
  const groupPrompts = buildGroupPrompts(pack, env.titlePolicy());
  const disclaimer = pack.compliancePack?.disclaimer ?? '';
  const groups = opts.groups ?? ALL_GROUPS;
  const run = <T>(g: GroupName, fn: () => Promise<T>, fallback: T | undefined): Promise<T> => {
    if (!groups.includes(g) && fallback !== undefined) return Promise.resolve(fallback);
    return fn();
  };
  const withCtx = (g: GroupName, prompt: string): string => {
    const ctx = opts.failureContext?.[g];
    return ctx
      ? `${prompt}\n\nPREVIOUS ATTEMPT FAILED THESE DETERMINISTIC CHECKS — fix them without weakening the copy:\n${ctx}`
      : prompt;
  };

  /**
   * OPERATOR-OWNED fields are withheld from the prompt entirely.
   *
   * The model cannot know a price, a SKU, a GTIN, a model number or an offer
   * condition — they are seller-account facts. Showing the key and asking for
   * a value guarantees an invented one, and an invented price is a WRONG price
   * on a live listing. They are filtered out here, the prompt says a withheld
   * class exists (so an omission is not read as an oversight), any that the
   * model volunteers anyway are deleted from the assembled output below, and
   * C23 exempts them from completeness. Four independent places, because a
   * single one of them is a single point of failure.
   */
  const generatedSchemaFields = pack.attributeSchema.filter((f) => f.source !== 'operator');
  const operatorOwnedFields = pack.attributeSchema.filter((f) => f.source === 'operator');
  const schemaFields = generatedSchemaFields
    .map((f) => `${f.field} | ${f.required ? 'required' : 'optional'} | ${f.example}`)
    .join('\n');

  const base = opts.base;
  // A repair regeneration (`base` present) must reuse the ALREADY-CHOSEN
  // product name rather than invent a new one — see pinProductName above.
  const pinnedProductName = base?.productName ?? '';

  // ---------------------------------------------------------------------------
  // PHASE 1 — resolve the canonical product name (one short call, ~3s).
  //
  // WHY THIS PHASE EXISTS. `productName` is invented by the TITLE group, but
  // three deterministic checks demand that exact identifier on surfaces owned by
  // OTHER groups: C8 (must START `title` and APPEAR in `description`), C15 (must
  // START `title75`) and A4 (must appear in the A+ brand-story AND hero
  // modules). While all eight groups fanned out together, `description` and
  // `aplus` were being written at the same instant the name was being chosen —
  // they could not possibly embed it, and satisfied C8/A4 only by luck, when the
  // model happened to echo the source listing's name. Pinning the name across
  // repair rounds stopped it OSCILLATING but could not create knowledge that did
  // not exist: the live failure simply moved to `verified:false [C8, A4, A4]`
  // with `description`/`aplus` regenerated and still nameless.
  //
  // So the title group runs ALONE first, and phase 2 is told what it chose.
  // (Phase 1 also gives the backend group the optimized title-surface stems it
  // needs for C16 — that is why the title call was already hoisted here.)
  //
  // COST. Phase 1 is one small call; phase 2 keeps the full 7-way parallel
  // fan-out, so total latency is one short call above the old shape — never
  // eight serialized calls. And when `title` is NOT in the regenerate set,
  // `run()` returns the `base` slice and phase 1 makes NO call at all.
  const title = await run(
    'title',
    () =>
      generateGroup(
        llm,
        'title',
        system,
        withCtx('title', groupPrompts.title(snapshot, pinnedProductName)),
        titleGroupSchema,
        1000,
      ),
    base && {
      productName: base.productName,
      primaryKeyword: base.primaryKeyword,
      title: base.title,
      title75: base.title75,
      itemHighlights: base.itemHighlights,
    },
  );

  const titleSurfaces = {
    title: title.title,
    title75: title.title75,
    itemHighlights: title.itemHighlights,
  };

  // The identifier phase 2 must embed. On a repair regeneration the PINNED name
  // wins (it is what the assembled listing will carry — see pinProductName), so
  // a title group that drifts cannot mislead the groups downstream of it.
  const canonicalProductName = (pinnedProductName || title.productName || '').trim();
  logServer('optimize.canonical_name_resolved', {
    // Never the copy itself (lib/server/log.ts contract) — shape only.
    // `run()` skips the call only when the group is out of scope AND a `base`
    // slice exists to fall back on — mirror that exactly.
    phase1Generated: groups.includes('title') || !base,
    pinned: pinnedProductName !== '',
    nameLength: canonicalProductName.length,
    phase2Groups: ALL_GROUPS.filter((g) => g !== 'title' && g !== 'keywords' && groups.includes(g)),
  });

  // ---------------------------------------------------------------------------
  // PHASE 2 — the remaining seven groups, still fully in PARALLEL. Groups that
  // must embed or respect the identifier are handed `canonicalProductName`;
  // `run()` still honours `opts.groups`, so a repair round regenerates only what
  // was asked for and everything else falls back to `base`.
  const [bullets, description, backend, attributes, aplus, images, qa] =
    await Promise.all([
      run('bullets', () => generateGroup(llm, 'bullets', system, withCtx('bullets', groupPrompts.bullets(snapshot, canonicalProductName)), bulletsGroupSchema, 2000),
        base && { bullets: base.bullets.map((text, i) => ({ text, useCaseAnchor: base.bulletAnchors?.[i] ?? '', claimBearing: text.trimEnd().endsWith('*') })) }),
      run('description', () => generateGroup(llm, 'description', system, withCtx('description', groupPrompts.description(snapshot, canonicalProductName)), descriptionGroupSchema, 2000),
        base && { description: stripDisclaimer(base.description, disclaimer) }),
      run('backend', () => generateGroup(llm, 'backend', system, withCtx('backend', groupPrompts.backend(snapshot, titleSurfaces)), backendGroupSchema, 600),
        base && { backendSearchTerms: base.backendSearchTerms }),
      run('attributes', () => generateGroup(llm, 'attributes', system, withCtx('attributes', groupPrompts.attributes(snapshot, schemaFields)), attributesGroupSchema, 3000),
        base && { attributes: base.attributes }),
      run('aplus', () => generateGroup(llm, 'aplus', system, withCtx('aplus', groupPrompts.aplus(snapshot, canonicalProductName)), aplusGroupSchema, 6000),
        base && { modules: base.aplusContent.modules.map((m) => ({ ...m, body: stripDisclaimer(m.body, disclaimer) })), comparison: base.aplusContent.comparison, faq: base.aplusContent.faq.map((f) => ({ ...f, a: stripDisclaimer(f.a, disclaimer) })) }),
      run('images', () => generateGroup(llm, 'images', system, withCtx('images', groupPrompts.images(snapshot)), imagesGroupSchema, 3500),
        base && {
          imagePlan: base.imagePlan.map((s) => ({ ...s, altText: s.altText ?? '' })),
          // WS8: a repair round that does not regenerate the images group must
          // carry the stored brief forward unchanged, not invent an empty one —
          // C29 would then report a missing brief the round never touched.
          videoBrief: base.videoBrief ?? { aspect: '', durationSeconds: 0, shots: [], onScreenText: [], notes: '' },
        }),
      run('qa', () => generateGroup(llm, 'qa', system, withCtx('qa', groupPrompts.qa(snapshot, canonicalProductName)), qaGroupSchema, 3500),
        base && { qa: base.qa.map((f) => ({ ...f, a: stripDisclaimer(f.a, disclaimer) })) }),
    ]);

  // --- deterministic assembly ---
  const finalDescription = disclaimer
    ? appendDisclaimer(description.description, disclaimer)
    : description.description;

  const finalAttributes = { ...attributes.attributes };
  // Belt and braces for the operator-owned class: the prompt never showed
  // these keys, but a model that volunteers one anyway must not have it
  // survive into a stored run — a hallucinated price is worse than a blank.
  for (const f of operatorOwnedFields) {
    delete finalAttributes[f.field];
  }
  if (disclaimer) {
    finalAttributes.legal_disclaimer_description = disclaimer; // replaces [SYSTEM_DISCLAIMER]
  } else {
    delete finalAttributes.legal_disclaimer_description;
  }

  const aplusContent: AplusContent = {
    fdaDisclaimer: disclaimer,
    modules: aplus.modules.map((m) => ({
      ...m,
      body: m.claimBearing && disclaimer ? appendDisclaimer(m.body, disclaimer) : m.body,
    })),
    comparison: aplus.comparison,
    faq: aplus.faq.map((f) => ({
      ...f,
      a: f.claimBearing && disclaimer ? appendDisclaimer(f.a, disclaimer) : f.a,
    })),
  };

  const assembled: OptimizedListing = {
    title: title.title,
    title75: title.title75,
    itemHighlights: title.itemHighlights,
    bullets: sanitizeBullets(
      bullets.bullets.map((b) => b.text),
      pack.rules.bulletMax,
    ),
    bulletAnchors: bullets.bullets.map((b) => b.useCaseAnchor),
    // The generator's OWN claim-bearing declaration, carried onto the contract
    // so gate C25 can hold the emitted string to it (worker != checker: the
    // Zod refinement ran before deterministic assembly, so it cannot vouch for
    // what was finally emitted).
    bulletClaimBearing: bullets.bullets.map((b) => b.claimBearing === true),
    description: finalDescription,
    // Deterministic C3/C16 cleanup after LLM (gate still re-validates).
    backendSearchTerms: sanitizeBackendSearchTerms(
      backend.backendSearchTerms,
      titleSurfaces,
      pack.rules.backendMaxBytes,
    ),
    attributes: finalAttributes,
    facts,
    fdaDisclaimer: disclaimer,
    aplusContent,
    imagePlan: images.imagePlan,
    videoBrief: images.videoBrief,
    qa: qa.qa.map((f) => ({
      ...f,
      a: f.claimBearing && disclaimer ? appendDisclaimer(f.a, disclaimer) : f.a,
    })),
    primaryKeyword: title.primaryKeyword,
    productName: title.productName,
    // WS3 — filled by PHASE 3 below, from the FINAL copy.
    keywords: base?.keywords ?? [],
    state: 'draft',
  };

  // Belt-and-braces: the prompt asks for the pinned name; this guarantees it.
  // TYPOGRAPHY is folded to ASCII last, at emit, so every stored/exported
  // surface is byte-stable (see lib/engine/typography.ts — punctuation only,
  // and gate C27 re-checks the result independently).
  const copy = normalizeListingTypography(
    pinProductName(assembled, pinnedProductName || undefined),
  );

  // ---------------------------------------------------------------------------
  // PHASE 3 — the KEYWORD REFERENCE (WS3).
  //
  // WHY IT IS A THIRD PHASE rather than a ninth parallel call. The reference
  // declares WHERE each term sits and gate C28 verifies every one of those
  // declarations against the emitted strings. A declaration written at the same
  // instant as the copy could only be a guess — which is exactly the
  // hand-written "all placed" checkmark the playbook names as the pattern that
  // failed nine times. So this call is handed the FINISHED, typography-folded
  // surfaces and asked to READ them; the gate then re-derives the truth
  // independently and fails closed on any disagreement.
  //
  // COST: one short call, and only when `keywords` is in scope — a repair round
  // that regenerates nothing else makes no other call at all.
  const keywords = await run(
    'keywords',
    () =>
      generateGroup(
        llm,
        'keywords',
        system,
        withCtx('keywords', groupPrompts.keywords(snapshot, copy)),
        keywordsGroupSchema,
        3000,
      ),
    base && { keywords: base.keywords ?? [] },
  );

  return { ...copy, keywords: normalizeKeywords(keywords.keywords) };
}

/**
 * Deterministic tidy-up of the keyword artifact.
 *
 * Trims, drops blank rows and de-duplicates on the term. It does NOT rewrite a
 * status, a surface list or a tier: doing so would launder exactly the
 * disagreement C28 exists to report. The only thing removed is noise that
 * could never be a meaningful declaration in the first place.
 */
export function normalizeKeywords(rows: unknown): KeywordTerm[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: KeywordTerm[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const term = String(r.term ?? '').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const surfaces = Array.isArray(r.surfaces)
      ? [...new Set(r.surfaces.map((s) => String(s ?? '').trim()).filter(Boolean))]
      : [];
    const row: KeywordTerm = {
      term,
      tier: r.tier as KeywordTier,
      status: String(r.status ?? '').trim() as KeywordStatus,
      surfaces,
      why: String(r.why ?? '').trim(),
    };
    const via = String(r.via ?? '').trim();
    if (via) row.via = via;
    const home = String(r.home ?? '').trim();
    if (home) row.home = home;
    out.push(row);
  }
  return out;
}

function stripDisclaimer(text: string, disclaimer: string): string {
  if (!disclaimer) return text;
  return text.split(disclaimer).join('').trimEnd();
}
