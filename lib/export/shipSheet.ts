import rulesJson from '@/knowledge/rules.json';
import type {
  AttributeField,
  Audit,
  Failure,
  KnowledgePack,
  OptimizedListing,
  OperatorChecklist,
  RuleSet,
} from '@/lib/types';
import { utf8Bytes } from '@/lib/shared/utf8Bytes';
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

export function buildShipSheet(run: ShipSheetRun): string {
  const l = run.optimized;
  const audit = run.audit;
  const rules: RuleSet = run.pack?.rules ?? DEFAULT_RULES;
  const schema: AttributeField[] = run.pack?.attributeSchema ?? [];
  const checklist: OperatorChecklist = rules.operatorChecklist ?? FALLBACK_CHECKLIST;

  // The gate result decides EVERY affordance on the sheet.
  const verified = audit?.verified === true;
  const copyable = verified;
  const failures = audit?.gateResult?.failures ?? [];

  const schemaOf = (field: string): AttributeField | undefined =>
    schema.find((f) => f.field === field);

  const bullets = l.bullets ?? [];
  const attributes = l.attributes ?? {};
  const qa = l.qa ?? [];
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
ol{margin:8px 0 0;padding-left:20px}li{margin:5px 0}
ul.ops{margin:8px 0 0;padding-left:20px}
</style></head><body><div class=w>
<h1>${esc(productName)} — Ship Sheet</h1>
<p class=sub>${run.asin ? `ASIN ${esc(run.asin)} · ` : ''}rendered ${esc(generatedAt)} from the stored run. GENERATED — never hand-edit; regenerate after any change. Every count below is re-measured at render time.</p>`;

  // --- verify / blocking banner ---
  h += verified
    ? '<div class=banner><b>✓ Verified for publish.</b> Every deterministic check passed on this exact copy. Paste in the order below.</div>'
    : blockingBanner(failures);

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
  const backendBrand = attributes.brand_name ?? attributes.manufacturer ?? '';
  h +=
    '<p class=sub style="margin-top:10px">⚠ <code>brand_name</code> / <code>manufacturer</code> = ' +
    `"${esc(backendBrand)}" — backend only, never in customer copy.</p>`;

  // -------------------------------------------------------------------------
  // 6 · A+ content modules
  // -------------------------------------------------------------------------
  h += '<h2>6 · A+ content modules</h2>';
  const modules = aplus?.modules ?? [];
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
  });
  const rows = aplus?.comparison?.rows ?? [];
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
    '<div class=note><b>⚠ Answers only.</b> Answering customer questions from the seller account is fine;' +
    ' creating questions about your own product is not. Use these as prepared ANSWERS when a real customer asks.</div></div>';

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
    (checklist.publishOrder ?? []).map((s) => `<li>${esc(s)}</li>`).join('') +
    '</ol>';
  h += `<div class=note>${esc(checklist.propagationNote)}</div>`;
  h += `<div class=note>${esc(checklist.browseNodeNote)}</div>`;
  if ((checklist.opsPlaceholders ?? []).length > 0) {
    h +=
      '<div style="margin-top:12px"><b>Operator-supplied (not generated here)</b></div><ul class=ops>' +
      checklist.opsPlaceholders.map((s) => `<li>${esc(s)}</li>`).join('') +
      '</ul>';
  }
  h += '</div>';

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
