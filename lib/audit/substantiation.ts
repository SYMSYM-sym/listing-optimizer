import type {
  KnowledgePack,
  ListingSnapshot,
  OptimizedListing,
  SubstantiationClaim,
} from '@/lib/types';
import {
  aplusSurfaces,
  customerSurfaces,
  prohibitedMarketingPatterns,
} from '@/lib/gate/checks/shared';
import { normalize, packPattern, termRegex } from '@/lib/gate/util';

/**
 * R33/R38 — THE SUBSTANTIATION REGISTER.
 *
 * Every other check in this project asks "is this phrasing allowed?". This one
 * asks the question the marketplace actually asks: CAN YOU PROVE IT? A
 * certification, an origin statement, a testing claim or a units-sold figure is
 * lawful phrasing and unlawful marketing at the same time — the difference is
 * an artifact in the seller's filing cabinet, which no app can see.
 *
 * So the register never fails a run. It ENUMERATES: every claim the generated
 * listing makes, the surfaces it makes it on, and — the part that matters —
 * whether the SOURCE listing was already making it.
 *
 * ECHO-ONLY IS THE WHOLE POINT. A generator writing plausible trust copy will
 * happily add "Made in USA" to a listing that never said it: the phrase fits
 * the category, the tone and the gap in the bullet. Nothing in the copy marks
 * it as invented. Comparing against the SOURCE SNAPSHOT is the only signal
 * available: a claim present in the source is one the seller was already
 * publishing (`HELD` — confirm it), and a claim that appears only in the
 * generated copy is one this run introduced (`PENDING` — evidence it or cut
 * it).
 *
 * The token list is PACK DATA (`compliancePack.substantiationTokens`).
 *
 * ---------------------------------------------------------------------------
 * M1 — WHAT THE REGISTER MAY NOT OFFER: a claim the GATE BANS OUTRIGHT.
 *
 * The two lexicons overlap, and on the shipped packs they overlap in three
 * places at least: `\bclinically\s+(studied|...)`, `\baward[- ]winning\b` and
 * the regulatory-certification row all match text that C19/A8 fail on every
 * surface. Left alone, the register said `HELD — echoed from the source
 * listing, confirm the artifact is still on file` about a phrase section 3 of
 * the same ship sheet was telling the operator to delete, and section 10
 * invited them to sign it off. Two sections, one string, opposite
 * instructions.
 *
 * They are not both right. A substantiation row is a QUESTION FOR THE
 * OPERATOR — "can you prove this before it publishes?" — and that question is
 * only meaningful for copy that CAN publish. A prohibited-marketing hit cannot:
 * the gate fails it, `verified` is `gateResult.pass`, and the run is blocked
 * whatever the operator's filing cabinet holds. So the ban wins, and a hit
 * whose matched text is itself banned is dropped from the register rather than
 * offered for sign-off. Nothing is lost: C19 and A8 already report that exact
 * span, on that exact field, with a fix line.
 *
 * IT IS A COHERENCE RULE, NOT A NARROWING. The dropped rows are exactly the
 * ones that can only ever appear beside a hard failure; every claim that can
 * actually ship is still enumerated, and a row keeps the surfaces whose hits
 * are lawful even when another surface's hit is banned ("clinically tested" in
 * the description survives while "clinically studied" in a bullet does not).
 * Both lexicons stay PACK DATA and this module still holds no vocabulary.
 */

/** Everything a shopper can see in the SOURCE listing. */
function snapshotText(current: ListingSnapshot): string {
  const raw = current.raw as { aplusText?: string } | null | undefined;
  return normalize(
    [
      current.title ?? '',
      ...(Array.isArray(current.bullets) ? current.bullets : []),
      current.description ?? '',
      ...Object.values(current.attributes ?? {}),
      raw?.aplusText ?? '',
    ].join(' \n '),
  ).toLowerCase();
}

/**
 * Is this exact span one the prohibited-marketing lexicon fails?
 *
 * The SAME two lists C19/A8 compile (`rules.prohibitedMarketing.patterns` via
 * the shared macro expander, plus `compliancePack.superlativeBans`), applied to
 * the matched span rather than to the surface. The de-obfuscation passes are
 * deliberately not repeated: this asks whether the text the register is about
 * to offer is itself banned, and an obfuscated variant of it is C19's business,
 * not the register's.
 */
function gateBannedSpan(pack: KnowledgePack | null | undefined): (span: string) => boolean {
  if (!pack) return () => false;
  const patterns = prohibitedMarketingPatterns(pack)
    .map(([source]) => source)
    .filter((source): source is string => typeof source === 'string' && source !== '');
  const superlatives = (pack.compliancePack?.superlativeBans ?? []).filter((t) => t.trim() !== '');
  return (span: string): boolean => {
    if (!span.trim()) return false;
    for (const source of patterns) {
      let re: RegExp;
      try {
        // The SAME compiler C19/A8 use, so the register's idea of "the gate
        // already bans this span" cannot drift from the gate's — including the
        // word-join separator class (see `util.packPatternSource`).
        re = packPattern(source, 'i');
      } catch {
        continue; // a malformed pack row must not break the audit
      }
      if (re.test(span)) return true;
    }
    for (const term of superlatives) {
      const re = termRegex(term);
      re.lastIndex = 0;
      if (re.test(span)) return true;
    }
    return false;
  };
}

export function buildSubstantiationRegister(
  proposed: OptimizedListing,
  current: ListingSnapshot,
  pack: KnowledgePack | null | undefined,
): SubstantiationClaim[] {
  const cp = pack?.compliancePack;
  const rows = (cp?.substantiationTokens ?? []).filter(
    (row) => Array.isArray(row) && String(row[0] ?? '').trim() !== '',
  );
  if (rows.length === 0) return [];
  const source = snapshotText(current);
  // Attribute values are deliberately included: a certification parked in an
  // attribute publishes exactly as loudly as one in a bullet.
  const surfaces: [string, string][] = [
    ...customerSurfaces(proposed),
    ...aplusSurfaces(proposed.aplusContent),
    ...Object.entries(proposed.attributes ?? {}).map(
      ([k, v]) => [`attributes.${k}`, String(v ?? '')] as [string, string],
    ),
  ];

  const banned = gateBannedSpan(pack);
  const out: SubstantiationClaim[] = [];
  for (const row of rows) {
    const [pattern, display] = [String(row[0]), String(row[1] ?? row[0])];
    let re: RegExp;
    try {
      // `third-party tested` and `third party tested` are one token to claim
      // and one token to substantiate: same compiler, same separator class.
      re = packPattern(pattern, 'i');
    } catch {
      continue; // a malformed pack row must not break the audit
    }
    const hits: string[] = [];
    for (const [field, text] of surfaces) {
      if (text.trim() === '') continue;
      const m = re.exec(normalize(text));
      // The SPAN, not the surface: a bullet may carry a lawful token hit and a
      // banned one, and only the banned hit is the gate's business.
      if (!m || banned(m[0])) continue;
      hits.push(field);
    }
    if (hits.length === 0) continue;
    const evidenced = re.test(source);
    out.push({
      claim: display,
      // One row per CLAIM, not per surface: the operator signs off on the
      // claim once and needs to see everywhere it would publish.
      surface: hits.join(', '),
      status: evidenced ? 'HELD' : 'PENDING',
      note: evidenced
        ? 'echoed from the source listing — confirm the artifact is still on file'
        : 'not evidenced in source listing — name the artifact behind it or remove the claim before publishing',
    });
  }
  return out;
}

/**
 * The HEADER surfaces an UNEVIDENCED claim must stay off (title, published
 * title, Item Highlights).
 *
 * Header fields are what a moderator reads first and what every downstream
 * surface quotes, so an invented certification there is the one that travels.
 * Reported as a P1 audit gap by `lib/audit/diff.ts`; the prompt tells the
 * generator the same thing (`promptRules.title`).
 */
export const HEADER_SURFACES = ['title', 'title75', 'itemHighlights'];

export function unevidencedHeaderClaims(register: SubstantiationClaim[]): SubstantiationClaim[] {
  return register.filter(
    (r) =>
      r.status === 'PENDING' &&
      r.surface.split(',').some((s) => HEADER_SURFACES.includes(s.trim())),
  );
}
