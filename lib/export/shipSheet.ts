import rulesJson from '@/knowledge/rules.json';
import type {
  AttributeField,
  Audit,
  ListingSnapshot,
  MarketplaceChecklistItem,
  Failure,
  KnowledgePack,
  OptimizedListing,
  OperatorChecklist,
  RuleSet,
} from '@/lib/types';
import { utf8Bytes } from '@/lib/shared/utf8Bytes';
import { arr } from '@/lib/gate/util';
import { toSellerCentralDescription } from './descriptionHtml';

/**
 * THE SHIP SHEET — the single document an operator actually pastes from.
 *
 * WHY IT EXISTS (and why it is not "the Markdown export with nicer fonts").
 * The Markdown export is a RECORD; the ship sheet is a PROCEDURE. It is opened
 * next to Seller Central and worked top to bottom: one copy button per field,
 * every count re-measured in front of the operator, the entry ORDER stated
 * before the first paste, and the two facts that silently cost money — the
 * backend brand must never reach customer copy, and the browse node goes in
 * LAST — printed where they are read rather than filed somewhere else.
 *
 * STRUCTURE, ORDER and the VERBATIM WARNING TEXT are ported from the harness
 * kit's `scripts/ship-sheet.mjs` (a generator whose output an operator has
 * already shipped from), not invented here. What is new is that our runs are
 * GATED, so the sheet can be gate-aware in a way that static generator was not:
 *
 *   COUNTS ARE RECOMPUTED, NEVER CARRIED. Every number in section 8 is
 *   measured from `run.optimized` at render time — from the same value the
 *   copy button serves. A stale count on a ship sheet is worse than no count:
 *   it tells the operator a field is inside its limit while they paste one
 *   that is not. Nothing here caches, rounds or hard-codes a measurement.
 *
 *   AN UNVERIFIED SHEET MUST NOT LOOK SHIPPABLE. When `audit.verified` is
 *   false the verify banner is replaced by a blocking one naming every failing
 *   check, and EVERY copy button and the clipboard script are omitted
 *   entirely — not disabled, omitted. This mirrors the export-final lock in
 *   the results UI: a listing that fails the gate is never handed over in a
 *   form that can be pasted by muscle memory.
 *
 * SELF-CONTAINED: the return value is a complete HTML document with inlined
 * CSS and (when verified) an inlined clipboard script. It is regenerated from
 * the stored run on every request and never persisted, so it cannot drift from
 * the run the way the kit's checked-in `SHIP-SHEET.html` could.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Structurally compatible with a stored `RunRecord` (so a route can pass the
 * row straight through) and with the in-memory results model.
 *
 * `pack` is optional so the builder stays a PURE function with no server-only
 * import; without it the shipped rule snapshot supplies the limits and the
 * schema-driven per-attribute notes are simply absent.
 */
export interface ShipSheetRun {
  optimized: OptimizedListing;
  audit: Audit;
  asin?: string;
  product_name?: string;
  created_at?: string;
  /** Supplies limits, the attribute-schema notes and the operator checklist. */
  pack?: Pick<KnowledgePack, 'rules' | 'attributeSchema'>;
  /**
   * WS10 — the SCRAPED listing, so the sheet can show the brand identity that
   * came off the live page next to the generated one. Optional: a sheet built
   * without it simply omits the scraped column.
   */
  snapshot?: Pick<ListingSnapshot, 'attributes'>;
}

const DEFAULT_RULES = rulesJson as unknown as RuleSet;

/**
 * The DEFAULT publish procedure, used only when the pack ships none.
 *
 * The pack's `rules.operatorChecklist` is the source of truth (see
 * `knowledge/rules.json`); this fallback exists so the builder never renders a
 * sheet with NO entry order at all, which is the one failure mode worse than a
 * slightly generic one.
 */
const FALLBACK_CHECKLIST: OperatorChecklist = {
  publishOrder: [
    'Title + Item Highlights (Product Identity)',
    'Bullets (Key Product Features)',
    'Description — paste as ONE line; the <br> tags render the paragraphs',
    'Backend search terms (Keywords tab, Search Terms field)',
    'Attributes — every blank costs a customer-facing search filter',
    'A+ content from the module copy below',
    'Subscribe & Save enrolment — enrol the SKU once the offer is live and in stock',
    'Recommended browse node LAST — set it only after everything above is saved',
  ],
  propagationNote:
    'Allow up to 48 hours for saved changes to propagate to the live detail page. Do NOT re-submit the same edit while it is propagating.',
  browseNodeNote:
    'The recommended browse node is a SUGGESTION only — confirm it in the Product Classifier, and enter it LAST.',
  opsPlaceholders: [],
};

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** HTML TEXT escaping. */
const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * HTML ATTRIBUTE escaping — quotes included.
 *
 * `data-v` carries a literal listing value into an attribute, and listing copy
 * routinely contains quotes and apostrophes. Escaping only `&<>` (as the kit's
 * generator did) would let a value containing a double quote break out of the
 * attribute and silently truncate what the copy button serves.
 */
const escAttr = (s: unknown): string => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardOpts {
  label: string;
  field: string;
  value: string;
  /** Right-hand meta line (limit + measurement). */
  meta?: string;
  note?: string;
  /** Copy buttons are omitted wholesale on an unverified sheet. */
  copyable: boolean;
}

/** One field card: header, value box, copy button, operator note. */
function card(o: CardOpts): string {
  const id = `v_${o.field.replace(/\W+/g, '_')}`;
  const button = o.copyable ? `<button class=cp data-t="${escAttr(id)}">⧉ Copy</button>` : '';
  return (
    `<div class=f data-sheet="${escAttr(o.field)}">` +
    `<div class=fh><div><b>${esc(o.label)}</b> <code>${esc(o.field)}</code></div>` +
    `<div class=meta>${o.meta ? esc(o.meta) : ''} · <b>${o.value.length}</b> chars</div></div>` +
    `<div class=bx id="${escAttr(id)}">${esc(o.value)}</div>` +
    button +
    (o.note ? `<div class=note>${esc(o.note)}</div>` : '') +
    '</div>'
  );
}

/** One row of the RECOMPUTED counts table. */
function countRow(label: string, measured: string, limit: string, ok: boolean): string {
  return (
    `<tr><td>${esc(label)}</td><td class=v>${esc(measured)}</td><td>${esc(limit)}</td>` +
    `<td class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</td></tr>`
  );
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

/**
 * The BLOCKING banner. It names every DISTINCT failing checkId first (so the
 * operator sees the shape of the problem), then every failure's field, context
 * and fix (so they can act without opening the app).
 */
function blockingBanner(failures: Failure[]): string {
  const ids = [...new Set(failures.map((f) => f.checkId))];
  const rows = failures
    .map(
      (f) =>
        `<tr><td><code>${esc(f.checkId)}</code></td><td><code>${esc(f.field)}</code></td>` +
        `<td>${esc(f.context)}</td><td>${esc(f.fix)}</td></tr>`,
    )
    .join('');
  return (
    '<div class=block><b>⛔ NOT VERIFIED — do not publish this listing.</b>' +
    ` ${failures.length} blocking gate failure(s) across ${ids.length} check(s): ` +
    `${ids.map((i) => `<code>${esc(i)}</code>`).join(' ')}.` +
    ' Copy buttons are withheld until the gate is green — fix the failures below and re-run.' +
    '<table style="margin-top:12px"><tr><th>Check</th><th>Field</th><th>Context</th><th>Fix</th></tr>' +
    rows +
    '</table></div>'
  );
}

/** Entry ORDER + the propagation warning. Both are pack data. */
function entryOrderBanner(cl: OperatorChecklist): string {
  const steps = (cl.publishOrder ?? []).map((s) => `<li>${esc(s)}</li>`).join('');
  return (
    '<div class=ord><b>Entry order.</b> Work top to bottom — the order matters.' +
    `<ol>${steps}</ol>` +
    `<div class=note>${esc(cl.propagationNote)}</div>` +
    `<div class=note>${esc(cl.browseNodeNote)}</div>` +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * The seeded-Q&A policy note, rendered from `rules.postPublish.qaPolicy`.
 *
 * Empty when the pack ships none — an exporter states what the pack says and
 * never invents a policy sentence of its own. `tests/knowledge.test.ts` asserts
 * the shipped pack carries both halves, so the sheet an operator actually gets
 * always prints them.
 */
function qaPolicyNote(rules: RuleSet): string {
  const policy = rules.postPublish?.qaPolicy;
  const notes = arr<string>(policy?.notes).filter((s) => typeof s === 'string' && s.trim() !== '');
  if (!policy?.headline?.trim() && notes.length === 0) return '';
  return (
    '<div class=note>' +
    (policy?.headline?.trim() ? `<b>⚠ ${esc(policy.headline)}</b> ` : '') +
    notes.map((s) => esc(s)).join(' ') +
    '</div>'
  );
}

export function buildShipSheet(run: ShipSheetRun): string {
  const l = run.optimized;
  const audit = run.audit;
  const rules: RuleSet = run.pack?.rules ?? DEFAULT_RULES;
  const schema: AttributeField[] = run.pack?.attributeSchema ?? [];
  const checklist: OperatorChecklist = rules.operatorChecklist ?? FALLBACK_CHECKLIST;

  // The gate result decides EVERY affordance on the sheet.
  const verified = audit?.verified === true;
  const copyable = verified;
  const failures = arr<Failure>(audit?.gateResult?.failures);

  const schemaOf = (field: string): AttributeField | undefined =>
    schema.find((f) => f.field === field);

  // WS10 — Array.isArray, not `?? []`: the sheet has to RENDER a malformed
  // run, because it is where the operator reads why it was blocked.
  const bullets = arr<string>(l.bullets);
  const attributes: Record<string, string> =
    l.attributes && typeof l.attributes === 'object' ? (l.attributes as Record<string, string>) : {};
  const qa = arr<{ q?: string; a?: string }>(l.qa);
  const aplus = l.aplusContent;

  // --- RECOMPUTED measurements (never carried from the run) ---
  const descriptionChars = (l.description ?? '').length;
  const descriptionBytes = utf8Bytes(l.description ?? '');
  const backendBytes = utf8Bytes(l.backendSearchTerms ?? '');
  const attributeCount = Object.keys(attributes).length;
  const qaCount = qa.length;

  const productName = l.productName || run.product_name || 'Listing';
  const generatedAt = new Date().toISOString().slice(0, 10);

  let h =
    '<!doctype html><html lang=en><head><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    `<title>${esc(productName)} — Ship Sheet${run.asin ? ` (ASIN ${esc(run.asin)})` : ''}</title>
<style>
:root{--bg:#0b0f17;--card:#121826;--txt:#e8edf6;--mut:#9fb0c9;--acc:#ff9900;--good:#86efac;--bad:#fca5a5;--line:rgba(255,255,255,.1)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.w{max-width:1000px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:23px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 20px}
.f{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:13px 15px;margin:0 0 13px}
.fh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:8px;flex-wrap:wrap}
code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:12.5px;color:#cfe0ff}
.meta{color:var(--mut);font-size:12.3px;white-space:nowrap}
.bx{background:#0a0e16;border:1px solid var(--line);border-radius:8px;padding:11px 13px;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}
.cp{margin-top:9px;background:var(--acc);color:#0b0f17;border:0;border-radius:8px;padding:7px 15px;font-weight:800;font-size:13px;cursor:pointer}
.cp.ok{background:var(--good)}
.note{color:#fcd34d;font-size:12.4px;margin-top:8px}
table{width:100%;border-collapse:collapse;font-size:13.4px;background:var(--card);border-radius:11px;overflow:hidden}
th,td{padding:8px 11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:rgba(255,255,255,.04);color:var(--mut);font-weight:600}
td.v{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.ok{color:var(--good)}
.bad{color:var(--bad);font-weight:700}
.banner{background:rgba(134,239,172,.08);border:1px solid rgba(134,239,172,.35);border-radius:11px;padding:14px 16px;margin:0 0 22px;font-size:14px}
.banner b{color:var(--good)}
.block{background:rgba(252,165,165,.08);border:1px solid rgba(252,165,165,.45);border-radius:11px;padding:14px 16px;margin:0 0 22px;font-size:14px}
.block b{color:var(--bad)}
.ord{background:rgba(255,153,0,.07);border:1px solid rgba(255,153,0,.3);border-radius:11px;padding:14px 16px;margin:0 0 22px;font-size:14px}
.stale{background:rgba(255,153,0,.06);border:1px dashed rgba(255,153,0,.35);border-radius:11px;padding:11px 14px;margin:0 0 18px;font-size:13px;color:var(--mut)}
.strat{background:rgba(207,224,255,.06);border:1px solid rgba(207,224,255,.25);border-radius:11px;padding:12px 15px;margin:0 0 18px;font-size:13.5px}
.kwnote{background:rgba(207,224,255,.06);border:1px solid rgba(207,224,255,.25);border-radius:11px;padding:12px 15px;margin:0 0 14px;font-size:13.3px}
ol{margin:8px 0 0;padding-left:20px}li{margin:5px 0}
ul.ops{margin:8px 0 0;padding-left:20px}
</style></head><body><div class=w>
<h1>${esc(productName)} — Ship Sheet</h1>
<p class=sub>${run.asin ? `ASIN ${esc(run.asin)} · ` : ''}rendered ${esc(generatedAt)} from the stored run. GENERATED — never hand-edit; regenerate after any change. Every count below is re-measured at render time.</p>`;

  // --- R48 STRATEGY NOTE (pack data) ---
  // The positioning anchor is rendered in the HEADER, above the banners, because
  // it is the one thing on the sheet that an operator can undo by hand: a later
  // "improvement" that re-frames the copy around a headline number quietly
  // reverses the position the whole listing was written to hold. It is
  // GUIDANCE, not a check — nothing on this sheet gates on it.
  const positioning = rules.positioningAnchor;
  if (positioning?.sheetNote) {
    h += `<div class=strat><b>${esc(positioning.headline || positioning.id)}</b> ${esc(positioning.sheetNote)}</div>`;
  }

  // --- verify / blocking banner ---
  h += verified
    ? '<div class=banner><b>✓ Verified for publish.</b> Every deterministic check passed on this exact copy. Paste in the order below.</div>'
    : blockingBanner(failures);

  /**
   * REPAIR-ROUTING GAPS — a DEFECT REPORT, printed next to the failures it
   * explains.
   *
   * When a gate failure's field belongs to no generation group, the repair
   * loop could not have fixed it however many rounds it was given. Without
   * this the sheet shows a stubborn compliance failure and nothing
   * distinguishes it from copy the model refused to correct, which is exactly
   * how the B00EEEITVA `videoBrief` hole survived a live run. It is never a
   * softening: every field named here is also in the blocking table above.
   */
  const routingGaps = arr<{ checkId?: unknown; field?: unknown }>(
    (audit as { routingGaps?: unknown } | null | undefined)?.routingGaps,
  );
  if (routingGaps.length > 0) {
    h +=
      '<div class=block><b>⚠ Unroutable failure(s) — this is a defect in this app, not in the copy.</b>' +
      ' The repair loop has no generation group for the field(s) below, so no number of rounds could have fixed them: ' +
      routingGaps
        .map((g) => `<code>${esc(String(g?.checkId ?? ''))} ${esc(String(g?.field ?? ''))}</code>`)
        .join(' ') +
      '. Report it — the run stays UNVERIFIED either way.</div>';
  }

  // --- advisory staleness notices (never affect `verified`) ---
  if (audit?.rulesStale) {
    h += `<div class=stale>⏳ ${esc(audit.rulesStaleNotice ?? 'Rule snapshot is stale — re-verify the time-sensitive marketplace limits.')}</div>`;
  }
  if (audit?.attributeSchemaStale) {
    h += `<div class=stale>⏳ ${esc(audit.attributeSchemaStaleNotice ?? 'Attribute schema snapshot is stale — re-verify the category attribute template.')}</div>`;
  }

  // --- entry order ---
  h += entryOrderBanner(checklist);

  // -------------------------------------------------------------------------
  // 1 · Title & Item Highlights
  // -------------------------------------------------------------------------
  h += '<h2>1 · Title &amp; Item Highlights</h2>';
  h += card({
    label: 'Published title',
    field: 'title75',
    value: l.title75 ?? '',
    meta: `≤${rules.title75Max} chars (published cap)`,
    note: 'This is what publishes.',
    copyable,
  });
  h += card({
    label: 'Item Highlights',
    field: 'itemHighlights',
    value: l.itemHighlights ?? '',
    meta: `≤${rules.itemHighlightsMax} chars (searchable field)`,
    note: 'Comma-separated phrases, not sentences.',
    copyable,
  });
  h += card({
    label: 'Keyword source (reference only)',
    field: 'title',
    value: l.title ?? '',
    meta: `≤${rules.titleMaxLegacy} chars (reference only)`,
    note: 'Do NOT paste this into the published title field.',
    copyable,
  });

  // -------------------------------------------------------------------------
  // 2 · Bullets
  // -------------------------------------------------------------------------
  h += `<h2>2 · Bullets — exactly ${rules.bulletCount}</h2>`;
  bullets.forEach((b, i) => {
    h += card({
      label: `Bullet ${i + 1}`,
      field: `bullet_point${i + 1}`,
      value: b ?? '',
      meta: `≤${rules.bulletMax} chars`,
      copyable,
    });
  });

  // -------------------------------------------------------------------------
  // 3 · Description — the `<br>` variant is what actually gets pasted.
  // -------------------------------------------------------------------------
  h += '<h2>3 · Description</h2>';
  h += card({
    label: 'Product description',
    field: 'description',
    value: toSellerCentralDescription(l.description ?? ''),
    meta: `≤${rules.descriptionMax} chars · ${descriptionBytes} bytes`,
    note: 'Paste exactly as shown, on one line. The <br> tags render the paragraphs.',
    copyable,
  });
  // WS10 — R12 and R11. Two rendering facts that decide whether this field
  // works, printed beside the field rather than filed somewhere else.
  const surfaceNotes = rules.copySurfaceNotes;
  if (surfaceNotes?.descriptionWithAplus) {
    h += `<div class=kwnote>${esc(surfaceNotes.descriptionWithAplus)}</div>`;
  }
  if (surfaceNotes?.mobileFrontLoad) {
    h += `<div class=kwnote>${esc(surfaceNotes.mobileFrontLoad)}</div>`;
  }

  // -------------------------------------------------------------------------
  // 4 · Backend search terms
  // -------------------------------------------------------------------------
  h += '<h2>4 · Backend search terms</h2>';
  h += card({
    label: 'Search terms',
    field: 'backendSearchTerms',
    value: l.backendSearchTerms ?? '',
    meta: `≤${rules.backendMaxBytes} bytes · ${backendBytes} used`,
    note: 'No commas needed. Never repeat title words.',
    copyable,
  });

  // -------------------------------------------------------------------------
  // 5 · Attributes
  // -------------------------------------------------------------------------
  h += '<h2>5 · Attributes</h2><table><tr><th>Field</th><th>Value</th><th></th></tr>';
  for (const [k, v] of Object.entries(attributes)) {
    const f = schemaOf(k);
    const notes: string[] = [];
    // `suggestOnly` gets the sheet's own canonical phrasing; the schema's own
    // note restates the same caveat at length, so printing both just makes the
    // operator read the important line twice.
    if (f?.suggestOnly) notes.push('suggest only — confirm in Product Classifier; enter LAST');
    else if (f?.note) notes.push(f.note);
    if (f?.source === 'operator') notes.push('operator-owned — this app never generates it');
    if (f?.pendingTemplateConfirm) {
      notes.push('template key pending confirmation against the category Listing Report');
    }
    const noteHtml = notes.length > 0 ? `<div class=note>${esc(notes.join(' · '))}</div>` : '';
    const btn = copyable
      ? `<button class=cp data-v="${escAttr(v)}" style="margin:0;padding:4px 10px">⧉</button>`
      : '';
    h += `<tr><td><code>${esc(k)}</code>${noteHtml}</td><td class=v>${esc(v)}</td><td>${btn}</td></tr>`;
  }
  h += '</table>';
  // WS10 — BRAND IDENTITY, generated beside SCRAPED.
  //
  // The generated value is what this run proposes; the scraped one is what the
  // live page actually carries, and the two disagreeing is exactly the case an
  // operator needs to see before anything reaches a feed. A scraped brand
  // string is a seller-entered value on somebody's page, not a Brand Registry
  // fact, so it is rendered with a CONFIRM marker rather than as an answer.
  const scrapedAttributes = run.snapshot?.attributes ?? {};
  const brandFields = ['brand_name', 'manufacturer'] as const;
  h += '<table style="margin-top:10px"><tr><th>Field</th><th>Proposed</th><th>Scraped from the live page</th></tr>';
  for (const field of brandFields) {
    const generated = attributes[field] ?? '';
    const scraped = scrapedAttributes[field] ?? '';
    const disagree = scraped !== '' && generated !== '' && scraped !== generated;
    h +=
      `<tr><td><code>${esc(field)}</code></td><td class=v>${esc(generated) || '<i>—</i>'}</td>` +
      `<td class="${disagree ? 'bad' : 'v'}">${esc(scraped) || '<i>not on the scraped page</i>'}` +
      (scraped ? `<div class=note>⚠ ${esc(rules.copySurfaceNotes?.brandConfirm ?? 'CONFIRM — scraped value.')}</div>` : '') +
      (disagree ? '<div class=note>⚠ This disagrees with the proposed value — resolve before entering either.</div>' : '') +
      '</td></tr>';
  }
  h += '</table>';
  h +=
    '<p class=sub style="margin-top:10px">⚠ <code>brand_name</code> / <code>manufacturer</code> are ' +
    'backend only, never in customer copy.</p>';

  // -------------------------------------------------------------------------
  // 6 · A+ content modules
  // -------------------------------------------------------------------------
  h += '<h2>6 · A+ content modules</h2>';
  // WS8 — A+ DISCLOSURES (pack data). Three things an operator otherwise finds
  // out after building the pack: the Brand Story is a separate brand-level
  // carousel this copy does not populate, banners carry their own ALT (the
  // invisible surface where a stale template's rival brand name survives), and
  // the carousel is TRIMMED on render so a long card set does not all display.
  // Premium A+ is declared out of scope here rather than silently unsupported.
  const aplusNotes = rules.imageArchitecture?.aplusNotes;
  if (aplusNotes) {
    for (const note of [
      aplusNotes.brandStoryCard,
      aplusNotes.bannerAlt,
      aplusNotes.carouselTrim,
      aplusNotes.premiumScope,
    ]) {
      if (note) h += `<div class=kwnote>${esc(note)}</div>`;
    }
  }
  const modules = arr<NonNullable<typeof aplus>['modules'][number]>(aplus?.modules);
  modules.forEach((m, i) => {
    h += card({
      label: `Module ${i + 1} (${m.id}) — headline`,
      field: `aplus_${m.id}_headline`,
      value: m.headline ?? '',
      copyable,
    });
    if (m.subcopy) {
      h += card({
        label: `Module ${i + 1} (${m.id}) — subcopy`,
        field: `aplus_${m.id}_subcopy`,
        value: m.subcopy,
        copyable,
      });
    }
    h += card({
      label: `Module ${i + 1} (${m.id}) — body`,
      field: `aplus_${m.id}_body`,
      value: m.body ?? '',
      copyable,
    });
    if (m.bannerAltText) {
      h += card({
        label: `Module ${i + 1} (${m.id}) — banner ALT`,
        field: `aplus_${m.id}_banner_alt`,
        value: m.bannerAltText,
        meta: `≤${rules.imageArchitecture?.altMax ?? 100} chars`,
        note: 'Set on the banner image itself. Invisible on the page — check the LIVE value on day one.',
        copyable,
      });
    }
  });
  const rows = arr<{ label: string; ours: string; typical: string }>(aplus?.comparison?.rows);
  if (rows.length > 0) {
    h +=
      '<div class=f><div class=fh><div><b>Comparison table</b> <code>aplus_comparison</code></div></div>' +
      `<table style="margin-top:6px"><tr><th>Row</th><th>${esc(productName)}</th><th>Typical</th></tr>` +
      rows
        .map(
          (r) =>
            `<tr><td>${esc(r.label)}</td><td class=v>${esc(r.ours)}</td><td class=v>${esc(r.typical)}</td></tr>`,
        )
        .join('') +
      '</table></div>';
  }

  // -------------------------------------------------------------------------
  // 7 · Seeded Q&A — one copyable blob.
  // -------------------------------------------------------------------------
  const qaBlob = qa.map((f) => `${f.q}\nA: ${f.a}`).join('\n\n');
  h += `<h2>7 · Seeded Q&amp;A — ${qaCount} pairs</h2>`;
  h +=
    '<div class=f><div class=bx id="v_qa">' +
    esc(qaBlob) +
    '</div>' +
    (copyable ? `<button class=cp data-t="v_qa">⧉ Copy all ${qaCount}</button>` : '') +
    // PACK DATA, not a literal: the answers-only policy AND the two-week
    // answering cadence both come off `rules.postPublish.qaPolicy`. The
    // playbook says to encode the rule on the sheet itself; encoding half of it
    // from memory is how the cadence went missing in the first place.
    qaPolicyNote(rules) +
    '</div>';

  // -------------------------------------------------------------------------
  // 8 · Verified counts — EVERY number measured HERE, from the same values the
  //     cards above serve. Nothing on this table is carried or hard-coded.
  // -------------------------------------------------------------------------
  h += '<h2>8 · Verified counts</h2><table><tr><th>Field</th><th>Measured</th><th>Limit</th><th></th></tr>';
  const t75 = (l.title75 ?? '').length;
  h += countRow('title75', `${t75} chars`, `${rules.title75Max}`, t75 <= rules.title75Max);
  const ih = (l.itemHighlights ?? '').length;
  h += countRow('itemHighlights', `${ih} chars`, `${rules.itemHighlightsMax}`, ih <= rules.itemHighlightsMax);
  const tl = (l.title ?? '').length;
  h += countRow('title (keyword source)', `${tl} chars`, `${rules.titleMaxLegacy}`, tl <= rules.titleMaxLegacy);
  bullets.forEach((b, i) => {
    const n = (b ?? '').length;
    h += countRow(`bullet ${i + 1}`, `${n} chars`, `${rules.bulletMax}`, n <= rules.bulletMax);
  });
  h += countRow('bullet count', `${bullets.length}`, `${rules.bulletCount}`, bullets.length === rules.bulletCount);
  h += countRow(
    'description',
    `${descriptionChars} chars / ${descriptionBytes} bytes`,
    `${rules.descriptionMax}`,
    descriptionChars <= rules.descriptionMax,
  );
  h += countRow(
    'backend search terms',
    `${backendBytes} bytes`,
    `${rules.backendMaxBytes}`,
    backendBytes <= rules.backendMaxBytes,
  );
  h += countRow('attributes (pasteable)', `${attributeCount}`, '—', attributeCount > 0);
  h += countRow('Q&A pairs', `${qaCount}`, '—', qaCount > 0);
  h += '</table>';

  // -------------------------------------------------------------------------
  // 9 · Operator checklist — pack-driven PROCEDURE, not copy.
  // -------------------------------------------------------------------------
  h += '<h2>9 · Operator checklist</h2><div class=f>';
  h +=
    '<div><b>Publish order</b></div><ol>' +
    arr<string>(checklist.publishOrder).map((s) => `<li>${esc(s)}</li>`).join('') +
    '</ol>';
  h += `<div class=note>${esc(checklist.propagationNote)}</div>`;
  h += `<div class=note>${esc(checklist.browseNodeNote)}</div>`;
  if (arr<string>(checklist.opsPlaceholders).length > 0) {
    h +=
      '<div style="margin-top:12px"><b>Operator-supplied (not generated here)</b></div><ul class=ops>' +
      arr<string>(checklist.opsPlaceholders).map((s) => `<li>${esc(s)}</li>`).join('') +
      '</ul>';
  }
  h += '</div>';

  // -------------------------------------------------------------------------
  // 10 · Substantiation register — R33/R38. The one section that is about
  //      EVIDENCE rather than copy: every trust claim the listing makes, where
  //      it makes it, and whether the source listing was already making it. A
  //      PENDING row is not a gate failure (no app can see a certificate) — it
  //      is the operator's sign-off queue, and the "Made in USA" problem lives
  //      in it: a claim the generator introduced by itself reads exactly like
  //      one the seller has held on file for years.
  // -------------------------------------------------------------------------
  const register = arr<NonNullable<Audit['substantiationRegister']>[number]>(audit?.substantiationRegister);
  h += '<h2>10 · Substantiation register — sign off before publishing</h2>';
  if (register.length === 0) {
    h += '<p class=sub>No certification, origin or testing claim was detected in this listing.</p>';
  } else {
    const pending = register.filter((r) => r.status === 'PENDING').length;
    h +=
      '<p class=sub>' +
      `${register.length} claim(s) detected, ${pending} with no evidence in the source listing. ` +
      'A claim marked PENDING must not publish until you can name the artifact behind it — a certificate, a lab report, an invoice, a sales record.</p>';
    h += '<table><tr><th>Claim</th><th>Appears on</th><th>Status</th><th>Note</th></tr>';
    for (const row of register) {
      const cls = row.status === 'PENDING' ? 'bad' : 'ok';
      h +=
        `<tr><td>${esc(row.claim)}</td><td class=v>${esc(row.surface)}</td>` +
        `<td class="${cls}">${esc(row.status)}</td><td>${esc(row.note ?? '')}</td></tr>`;
    }
    h += '</table>';
  }

  // -------------------------------------------------------------------------
  // 11 · Candidate terms — brain/02. ADVISORY, and about the CHECKER rather
  //      than the copy: condition-like words the SOURCE listing uses that the
  //      compliance lexicon does not know. A blind spot cannot report itself,
  //      so this is the only place one becomes visible.
  // -------------------------------------------------------------------------
  const candidates = arr<string>(audit?.candidateTerms);
  if (candidates.length > 0) {
    h += '<h2>11 · Candidate terms (advisory — lexicon review)</h2><div class=f>';
    h +=
      '<p class=sub style="margin:0 0 8px">These condition-like words appear in the SOURCE listing but are not in the compliance lexicon. ' +
      'They are NOT failures and nothing was blocked because of them — pass them to whoever owns the lexicon so the next run can enforce them.</p>';
    h += `<div class=bx>${esc(candidates.join(', '))}</div></div>`;
  }

  // -------------------------------------------------------------------------
  // 11b · Visual production pack — WS8. PROMPTS, never rendered assets: the
  //       operator controls the render and the spend. Slot 1 and the regulated
  //       panel slot carry machine-checked requirements (C29), and every ALT
  //       string is length-checked (C30) — so what is printed here is verified,
  //       not merely present.
  // -------------------------------------------------------------------------
  const imagePlan = arr<NonNullable<OptimizedListing['imagePlan']>[number]>(l.imagePlan);
  const altMax = rules.imageArchitecture?.altMax ?? 100;
  if (imagePlan.length > 0) {
    h += `<h2>12 · Visual production pack — ${imagePlan.length} slots + video</h2>`;
    h +=
      '<p class=sub>Briefs only. Render them yourself: two of these images may never be AI-generated or AI-altered, and the panel photograph is a compliance document.</p>';
    h += `<table><tr><th>#</th><th>Purpose</th><th>Spec</th><th>Notes</th><th>ALT (\u2264${altMax})</th></tr>`;
    for (const slot of imagePlan) {
      const alt = slot?.altText ?? '';
      const altClass = alt.length > altMax ? 'bad' : 'v';
      h +=
        `<tr><td>${esc(slot?.slot)}</td><td class=v>${esc(slot?.purpose)}</td>` +
        `<td>${esc(slot?.spec)}</td><td>${esc(slot?.notes)}</td>` +
        `<td class="${altClass}">${esc(alt)}<div class=note>${alt.length}/${altMax}</div></td></tr>`;
    }
    h += '</table>';
  }
  const brief = l.videoBrief;
  if (brief) {
    h +=
      `<div class=f><div class=fh><div><b>Video brief</b> <code>videoBrief</code></div>` +
      `<div class=meta>${esc(brief.aspect)} · ${esc(brief.durationSeconds)}s</div></div>` +
      `<ol>${arr<string>(brief.shots).map((b) => `<li>${esc(b)}</li>`).join('')}</ol>` +
      `<div class=note>On-screen text (scanned exactly like a bullet): ${esc(arr<string>(brief.onScreenText).join(' | '))}</div>` +
      (brief.notes ? `<div class=note>${esc(brief.notes)}</div>` : '') +
      '</div>';
  }

  // -------------------------------------------------------------------------
  // 13 · Keyword reference — WS3. The one section on this sheet that is about
  //      what the listing DELIBERATELY does not say as much as what it does.
  //      The "Derived placement" column is COMPUTED from the exact strings the
  //      cards above serve — nobody, human or model, types it — and gate C28
  //      re-verifies the whole table independently. The playbook is explicit
  //      that the hand-written version of this table is the pattern that failed
  //      nine times; the model's own version of it was wrong ~21 times per live
  //      run, which is why neither is asked for.
  // -------------------------------------------------------------------------
  const coverage = audit?.keywordCoverage;
  const keywordRules = rules.keywordRules;
  h += '<h2>13 · Keyword reference</h2>';
  if (!coverage || coverage.total === 0) {
    h += '<p class=sub>No keyword reference is attached to this run.</p>';
  } else {
    if (keywordRules?.sheetNote) {
      h += `<div class=kwnote>${esc(keywordRules.sheetNote)}</div>`;
    }
    const placed = arr<NonNullable<Audit['keywordCoverage']>['placed'][number]>(coverage.placed);
    const backendOnly = arr<{ term: string; why: string; note?: string }>(coverage.backendOnly);
    const negatives = arr<{ term: string; why: string }>(coverage.negatives);
    const recaptured = arr<{ term: string; via: string; why: string }>(coverage.recaptured);
    const candidatesKw = arr<{ term: string; home: string; why: string; note?: string }>(coverage.candidates);
    const notTargeted = arr<{ term: string; why: string }>(coverage.notTargeted);
    if (placed.length > 0) {
      h += '<table><tr><th>Term</th><th>Tier</th><th>Derived placement (computed from the copy)</th><th>Why</th></tr>';
      for (const r of placed) {
        h +=
          `<tr><td class=v>${esc(r.term)}</td><td>${esc(String(r.tier))}</td>` +
          `<td class=v>${esc(r.surfaces.join(', '))}</td><td>${esc([r.why, r.note].filter(Boolean).join(' — '))}</td></tr>`;
      }
      h += '</table>';
    }
    if (backendOnly.length > 0) {
      h +=
        '<div class=f><div class=fh><div><b>Backend only</b> <code>keywords.backend</code></div></div>' +
        `<div class=bx>${esc(backendOnly.map((r) => r.term).join(', '))}</div>` +
        backendOnly
          .filter((r) => r.note)
          .map((r) => `<div class=note>${esc(r.term)}: ${esc(r.note!)}</div>`)
          .join('') +
        '<div class=note>Verified present in the search-terms field and absent from every visible surface. Never repeat one in customer copy — the bytes are the point.</div></div>';
    }
    if (negatives.length > 0) {
      h += '<div class=f><div class=fh><div><b>Negative list — must appear NOWHERE</b></div></div>';
      h += '<table style="margin-top:6px"><tr><th>Term</th><th>Why</th></tr>';
      for (const r of negatives) {
        h += `<tr><td class=v>${esc(r.term)}</td><td>${esc(r.why)}</td></tr>`;
      }
      h +=
        '</table><div class=note>Each was verified absent from every surface, backend included. A rival brand name in ALT text or copy is invisible on the page and a real trademark exposure.</div></div>';
    }
    if (recaptured.length > 0) {
      h += '<div class=f><div class=fh><div><b>Demand recapture (K4)</b></div></div>';
      h += '<table style="margin-top:6px"><tr><th>Demand we do not write</th><th>How it still reaches this listing</th></tr>';
      for (const r of recaptured) {
        h += `<tr><td class=v>${esc(r.term)}</td><td>${esc(r.via)}</td></tr>`;
      }
      h +=
        '</table><div class=note>This map is why the term below is absent. Before anyone re-adds one because it has volume: the volume is already being captured, and this row says how.</div></div>';
    }
    if (candidatesKw.length > 0 || notTargeted.length > 0) {
      h += '<div class=f><div class=fh><div><b>Held back and deliberately skipped</b></div></div>';
      h += '<table style="margin-top:6px"><tr><th>Term</th><th>Status</th><th>Why / where it lives</th></tr>';
      for (const r of candidatesKw) {
        h += `<tr><td class=v>${esc(r.term)}</td><td>candidate</td><td>${esc([r.home, r.why, r.note].filter(Boolean).join(' — '))}</td></tr>`;
      }
      for (const r of notTargeted) {
        h += `<tr><td class=v>${esc(r.term)}</td><td>not targeted</td><td>${esc(r.why)}</td></tr>`;
      }
      h +=
        '</table><div class=note>Recorded so a later session can tell a deliberate omission from an oversight. A candidate must stay out of published copy until the thing that blocks it is held.</div></div>';
    }
  }

  // -------------------------------------------------------------------------
  // 14 · Score, BEFORE and AFTER — WS6.
  //
  //      Until this section existed the sheet (and the results panel) showed
  //      ONE number, and that number graded the listing the operator was about
  //      to REPLACE. Beside a green verify banner it reads as a grade for the
  //      new copy, which it never was. Both sides are scored by the SAME
  //      scorer over the same principles.
  //
  //      A principle the CURRENT listing cannot be graded on stays `unknown`
  //      and is excluded from that side's denominator — so the two totals are
  //      each renormalized over what is knowable about that side. The
  //      per-principle table below is the honest view; the header note says so
  //      rather than leaving the operator to infer it.
  // -------------------------------------------------------------------------
  const before = audit?.scorecard;
  const after = audit?.scorecardProposed;
  if (before || after) {
    h += '<h2>14 · Score — before &rarr; after</h2>';
    h +=
      '<div class=f><div class=fh><div><b>Principle score</b></div>' +
      `<div class=meta>current <b>${before ? before.total : '—'}</b> &rarr; proposed <b>${after ? after.total : '—'}</b> / 100</div></div>` +
      '<div class=note>Each side is scored over the principles that are KNOWABLE for it and renormalized, so a principle marked unknown deflates neither number. ' +
      'This is a content score, not the verify verdict: the gate decides whether this listing may publish.</div></div>';
    if (before && after && Array.isArray(before.perPrinciple) && Array.isArray(after.perPrinciple)) {
      const rows = before.perPrinciple.map((b) => ({
        id: b?.id,
        before: b,
        after: arr<{ id: string; score: string; rationale: string }>(after.perPrinciple).find((x) => x?.id === b?.id),
      }));
      h += '<table><tr><th>Principle</th><th>Current</th><th>Proposed</th><th>Why (proposed)</th></tr>';
      for (const r of rows.filter(Boolean)) {
        const a = r.after;
        const moved = a && a.score !== r.before?.score;
        h +=
          `<tr><td><code>${esc(r.id)}</code></td>` +
          `<td>${esc(r.before?.score)}</td>` +
          `<td class="${moved ? 'ok' : ''}">${esc(a?.score ?? '—')}</td>` +
          `<td>${esc(a?.rationale ?? '')}</td></tr>`;
      }
      h += '</table>';
    }
  }

  // -------------------------------------------------------------------------
  // 15 · Post-publish — WS6 (P15 timing) and WS7 (marketplace/ops).
  //
  //      GUIDANCE TIER, stated plainly at the top of the section: every item
  //      here is an account-side action this app can surface and cannot
  //      perform. Rendered from pack data so a rule change is a data edit.
  // -------------------------------------------------------------------------
  const postPublish = rules.postPublish;
  const timing = postPublish?.timingAdvisory;
  if (timing?.headline || (postPublish?.marketplaceChecklist ?? []).length > 0) {
    h += '<h2>15 · After you publish</h2>';
    h +=
      '<p class=sub>Everything in this section happens in your Seller Central account and in your own records. ' +
      'This app surfaces it; it cannot do it, and nothing here was checked.</p>';
  }
  if (timing?.headline) {
    h += `<div class=f><div class=fh><div><b>${esc(timing.headline)}</b> <code>${esc(timing.id)}</code></div></div>`;
    h += `<ul class=ops>${arr<string>(timing.notes).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
  }

  // --- WS7: the MARKETPLACE / OPS checklist (pack data) ---
  //
  // It replaces two hand-written `opsPlaceholders` lines that named a topic
  // without stating the rule, its effective date, or the consequence of
  // missing it. Each row now carries a LANE (what it protects), the DATE where
  // the rule has one, and a VOLATILE marker where the underlying list moves —
  // because the one thing worse than not having the approved-provider list is
  // having last quarter's copy of it and believing it.
  const marketplace = arr<MarketplaceChecklistItem>(postPublish?.marketplaceChecklist);
  if (marketplace.length > 0) {
    if (postPublish?.marketplaceChecklistNote) {
      h += `<div class=stale>${esc(postPublish.marketplaceChecklistNote)}</div>`;
    }
    h += '<table><tr><th>#</th><th>Lane</th><th>Action</th><th>Why / how</th></tr>';
    for (const item of marketplace) {
      const flags: string[] = [];
      if (item.dated) flags.push(item.dated);
      if (item.volatile) flags.push('re-verify live — this list moves');
      const flagHtml =
        flags.length > 0 ? `<div class=note>\u26a0 ${esc(flags.join(' · '))}</div>` : '';
      h +=
        `<tr><td><code>${esc(item.id)}</code></td><td>${esc(item.lane)}</td>` +
        `<td><b>${esc(item.title)}</b>${flagHtml}</td><td>${esc(item.detail)}</td></tr>`;
    }
    h += '</table>';
  }

  // -------------------------------------------------------------------------
  // 16 · Competitor benchmark — WS9. Structural facts only, measured the same
  //      way on every row including ours. There is no rival COPY here and no
  //      rival brand name: their non-compliant framing is takedown risk rather
  //      than inspiration, and their brand belongs on the negative keyword
  //      list. A row we could not ingest is printed AS failed — a benchmark
  //      that silently dropped it would read as "they have no A+".
  // -------------------------------------------------------------------------
  const benchmark = audit?.benchmark;
  if (benchmark && typeof benchmark === 'object') {
    h += '<h2>16 · Competitor benchmark</h2>';
    h += `<p class=sub>${benchmark.ingested} of ${benchmark.requested} competitor ASIN(s) ingested. Structural comparison only — no rival copy is reproduced here, and a rival brand name belongs on the negative keyword list, not in your listing.</p>`;
    h += '<table><tr><th>ASIN</th><th>Title chars</th><th>Bullets</th><th>Attributes</th><th>A+</th></tr>';
    const bmRow = (label: string, r: typeof benchmark.subject, emphasis = false): string => {
      if (!r || r.status !== 'ok') {
        return `<tr><td class=v>${esc(label)}</td><td colspan=4 class=bad>not ingested — ${esc(r.note ?? '')}</td></tr>`;
      }
      const cell = (v: unknown): string => `<td class=v>${esc(v)}</td>`;
      return (
        `<tr><td class=v>${emphasis ? `<b>${esc(label)}</b>` : esc(label)}</td>` +
        cell(r.titleLength) +
        cell(r.bulletCount) +
        cell(r.attributeCount) +
        `<td class="${r.aplusPresent ? 'ok' : 'bad'}">${r.aplusPresent ? 'yes' : 'no'}</td></tr>`
      );
    };
    h += bmRow(`${benchmark.subject?.asin} (proposed)`, benchmark.subject ?? { asin: '', status: 'failed' }, true);
    h += bmRow(`${benchmark.current?.asin} (current)`, benchmark.current ?? { asin: '', status: 'failed' });
    for (const r of arr<typeof benchmark.subject>(benchmark.rows)) h += bmRow(r?.asin ?? '', r ?? { asin: '', status: 'failed' });
    h += '</table>';
  }

  // -------------------------------------------------------------------------
  // 17 · Review language the compliance filter DROPPED — WS9.
  //      Printed because an operator who pastes reviews and sees nothing
  //      change will assume the feature is broken. It is not: these fragments
  //      were rejected by the SAME lexicon the gate enforces, which is exactly
  //      the "reviews may carry symptom words, your copy may not" rule.
  // -------------------------------------------------------------------------
  const rejected = arr<{ fragment?: string; why?: string }>(audit?.reviewLanguageRejected);
  if (rejected.length > 0) {
    h += '<h2>17 · Review phrasing that was not used</h2>';
    h +=
      '<p class=sub>Reviewers may lawfully write things your listing may not. These fragments were screened out of the copy guidance by the same compliance lexicon the gate enforces.</p>';
    h += '<table><tr><th>Fragment</th><th>Why it was not mirrored</th></tr>';
    for (const r of rejected.slice(0, 40).filter(Boolean)) {
      h += `<tr><td>${esc(r?.fragment)}</td><td class=bad>${esc(r?.why)}</td></tr>`;
    }
    h += '</table>';
  }

  h += '</div>';

  // -------------------------------------------------------------------------
  // Clipboard script — OMITTED on an unverified sheet, together with every
  // button it would drive.
  // -------------------------------------------------------------------------
  if (copyable) {
    h += `<script>
document.querySelectorAll('.cp').forEach(function(b){b.onclick=function(){
  var t=b.dataset.t?document.getElementById(b.dataset.t).textContent:b.dataset.v;
  navigator.clipboard.writeText(t).then(function(){
    var o=b.textContent;b.textContent='✓ Copied';b.classList.add('ok');
    setTimeout(function(){b.textContent=o;b.classList.remove('ok')},1400);
  });
};});
</script>`;
  }

  h += '</body></html>';
  return h;
}
