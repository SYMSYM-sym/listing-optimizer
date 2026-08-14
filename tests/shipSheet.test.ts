import { beforeAll, describe, expect, it } from 'vitest';
import { buildAudit } from '@/lib/audit/buildAudit';
import { optimize } from '@/lib/engine/optimize';
import { buildShipSheet, type ShipSheetRun } from '@/lib/export/shipSheet';
import { toSellerCentralDescription } from '@/lib/export/descriptionHtml';
import type { GateContext } from '@/lib/gate/checks';
import { utf8Bytes } from '@/lib/gate/util';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Audit, OptimizedListing } from '@/lib/types';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

/**
 * SHIP SHEET.
 *
 * The sheet is the document an operator pastes from, so the tests that matter
 * are the ones a wrong sheet would pass:
 *
 *  - COUNTS MOVE. It is not enough that a number is present or that it equals
 *    a constant: a hard-coded ✓ column (which is what the harness kit shipped)
 *    passes both of those. Every counts cell is therefore compared against a
 *    value RECOMPUTED in the test, the listing is then CHANGED and the same
 *    cell is asserted to have changed with it, and an over-limit field is
 *    asserted to render ✗.
 *  - AN UNVERIFIED SHEET IS NOT PASTEABLE. No verified banner, every failing
 *    check named, and zero copy buttons and zero script — omitted, not
 *    disabled.
 */

const pack = loadPack('supplements');
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'], snapshotText: snapshot.title };

let listing: OptimizedListing;
let audit: Audit;
let html: string;

const sheetFor = (l: OptimizedListing, a: Audit): string =>
  buildShipSheet({ optimized: l, audit: a, asin: 'B0TESTASIN', pack } satisfies ShipSheetRun);

const clone = (l: OptimizedListing): OptimizedListing =>
  JSON.parse(JSON.stringify(l)) as OptimizedListing;

beforeAll(async () => {
  listing = await optimize(snapshot, pack, mockLlm);
  audit = buildAudit(snapshot, listing, pack, ctx);
  html = sheetFor(listing, audit);
});

/** The measured/limit/mark cells of one counts row, by its label. */
function countsRow(doc: string, label: string): { measured: string; limit: string; mark: string } {
  const re = new RegExp(
    `<tr><td>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</td><td class=v>([^<]*)</td><td>([^<]*)</td><td class="(ok|bad)">(✓|✗)</td></tr>`,
  );
  const m = re.exec(doc);
  if (!m) throw new Error(`counts row '${label}' not found`);
  return { measured: m[1]!, limit: m[2]!, mark: m[4]! };
}

describe('ship sheet — verified run', () => {
  it('the fixture run is verified (otherwise every assertion below is vacuous)', () => {
    expect(audit.verified).toBe(true);
  });

  it('renders a complete standalone HTML document with inlined CSS', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link');
  });

  it('shows the verified banner and the copy script', () => {
    expect(html).toContain('✓ Verified for publish.');
    expect(html).toContain('<script>');
    expect(html).toContain("'✓ Copied'");
    expect(html).toContain('1400');
  });

  it('renders the eight sections IN ORDER', () => {
    const order = [
      '1 · Title &amp; Item Highlights',
      '2 · Bullets — exactly 5',
      '3 · Description',
      '4 · Backend search terms',
      '5 · Attributes',
      '6 · A+ content modules',
      '7 · Seeded Q&amp;A',
      '8 · Verified counts',
      '9 · Operator checklist',
    ];
    let cursor = -1;
    for (const heading of order) {
      const at = html.indexOf(heading);
      expect(at, `section '${heading}' present`).toBeGreaterThan(-1);
      expect(at, `section '${heading}' in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('section 1 carries all three title cards with their notes', () => {
    expect(html).toContain('data-sheet="title75"');
    expect(html).toContain('This is what publishes.');
    expect(html).toContain('data-sheet="itemHighlights"');
    expect(html).toContain('Comma-separated phrases, not sentences.');
    expect(html).toContain('data-sheet="title"');
    expect(html).toContain('Do NOT paste this into the published title field.');
  });

  it('section 2 labels exactly five bullets bullet_point1..5', () => {
    for (let i = 1; i <= 5; i++) expect(html).toContain(`data-sheet="bullet_point${i}"`);
    expect(html).not.toContain('data-sheet="bullet_point6"');
  });

  it('the description card serves the <br> variant, not the plain text', () => {
    const brVariant = toSellerCentralDescription(listing.description);
    expect(brVariant).toContain('<br>');
    // Escaped for display; textContent (what the copy button reads) is the raw variant.
    expect(html).toContain(brVariant.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(html).toContain('The <br> tags render the paragraphs.'.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  });

  it('the backend card states the byte budget and the bytes used', () => {
    expect(html).toContain(`≤${pack.rules.backendMaxBytes} bytes · ${utf8Bytes(listing.backendSearchTerms)} used`);
    expect(html).toContain('No commas needed. Never repeat title words.');
  });

  it('the attribute table carries EVERY attribute plus the backend-brand warning', () => {
    for (const [k, v] of Object.entries(listing.attributes)) {
      expect(html, `attribute row '${k}'`).toContain(`<code>${k}</code>`);
      expect(html, `attribute value '${k}'`).toContain(
        String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      );
    }
    expect(html).toContain('<code>brand_name</code> / <code>manufacturer</code>');
    expect(html).toContain('backend only, never in customer copy.');
    expect(html).toContain(listing.attributes.brand_name!);
  });

  it('renders the schema notes an operator needs: browse-node caveat and the legacy-field note', () => {
    // AM-4b: subject_keyword is kept, and the sheet says why it costs nothing.
    const legacy = pack.attributeSchema.find((f) => f.field === 'subject_keyword')!;
    expect(html).toContain(legacy.note!.replace(/&/g, '&amp;').replace(/’/g, '’'));
    // recommended_browse_nodes carries the canonical suggest-only phrasing.
    expect(html).toContain('suggest only — confirm in Product Classifier; enter LAST');
  });

  it('renders the A+ comparison as a real table, not a blob', () => {
    expect(html).toContain('<b>Comparison table</b>');
    for (const r of listing.aplusContent.comparison.rows) {
      expect(html).toContain(`<td>${r.label}</td>`);
    }
  });

  it('seeds Q&A as one copyable blob with the VERBATIM answers-only warning', () => {
    expect(html).toContain(`7 · Seeded Q&amp;A — ${listing.qa.length} pairs`);
    expect(html).toContain('data-t="v_qa"');
    expect(html).toContain(
      '<b>⚠ Answers only.</b> Answering customer questions from the seller account is fine;' +
        ' creating questions about your own product is not. Use these as prepared ANSWERS when a real customer asks.',
    );
    // the blob shape: "q\nA: a", pairs separated by a blank line
    const first = listing.qa[0]!;
    expect(html).toContain(`${first.q}\nA: ${first.a}`);
  });

  /**
   * F3 — the CADENCE half of the Q&A rule.
   *
   * The playbook states the rule three times and says to encode it on the ship
   * sheet itself; the sheet carried the answers-only half and dropped the
   * two-week spread, which is the half that stops a day-one burst of seller
   * answers from reading as manufactured Q&A. It is PACK DATA now, so this
   * asserts the rendered document — not the constant.
   */
  it('prints the two-week answering cadence verbatim, from pack data', () => {
    const policy = pack.rules.postPublish?.qaPolicy;
    expect(policy, 'the shipped pack must carry rules.postPublish.qaPolicy').toBeTruthy();
    expect(html).toContain('spread over the first two weeks');
    for (const note of policy!.notes) expect(html).toContain(note.replace(/&/g, '&amp;'));
    expect(html).toContain(`<b>⚠ ${policy!.headline}</b>`);
  });

  /**
   * BOTH DIRECTIONS for a pack-sourced string: a pack that ships no policy
   * renders no policy note, and the exporter never substitutes a sentence of
   * its own. The note is the pack's statement or it is nothing.
   */
  it('renders NO policy note when the pack ships none (no invented literal)', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as typeof pack;
    delete bare.rules.postPublish?.qaPolicy;
    const doc = buildShipSheet({ optimized: listing, audit, asin: 'B0TESTASIN', pack: bare });
    expect(doc).not.toContain('spread over the first two weeks');
    expect(doc).not.toContain('⚠ Answers only.');
  });

  it('the entry-order banner names Subscribe & Save and puts the browse node LAST', () => {
    const banner = html.slice(html.indexOf('<div class=ord>'), html.indexOf('<h2>1 · '));
    expect(banner).toContain('Entry order.');
    expect(banner).toContain('Subscribe &amp; Save');
    expect(banner).toContain('LAST');
    // the node step is genuinely the final one
    const steps = [...banner.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]!);
    expect(steps.length).toBeGreaterThanOrEqual(8);
    expect(steps[steps.length - 1]).toContain('LAST');
    expect(banner).toContain('48 hours');
    expect(banner).toContain('Do NOT re-submit');
  });

  it('the operator checklist renders the publish order and the browse-node caveat', () => {
    const section = html.slice(
      html.indexOf('<h2>9 · Operator checklist'),
      html.indexOf('<h2>10 ·'),
    );
    expect(section).toContain('Publish order');
    expect(section).toContain('Product Classifier');
  });

  /**
   * WS7 moved the two hand-written ops reminders out of `opsPlaceholders` and
   * into the structured post-publish checklist, which states the rule, its
   * effective date and what happens if it is missed. The topics must still be
   * on the sheet — just in the section that can carry them properly.
   */
  it('the account-side obligations moved to the post-publish section, not off the sheet', () => {
    const post = html.slice(html.indexOf('<h2>15 · After you publish'));
    expect(post).toContain('cGMP');
    expect(post).toContain('rating defence');
    expect(post).toContain('4.0');
  });
});

describe('ship sheet — counts are RECOMPUTED, never carried', () => {
  it('every counts cell equals a value recomputed from the listing', () => {
    expect(countsRow(html, 'title75')).toMatchObject({
      measured: `${listing.title75.length} chars`,
      limit: `${pack.rules.title75Max}`,
      mark: '✓',
    });
    expect(countsRow(html, 'itemHighlights').measured).toBe(`${listing.itemHighlights.length} chars`);
    expect(countsRow(html, 'title (keyword source)').measured).toBe(`${listing.title.length} chars`);
    listing.bullets.forEach((b, i) => {
      expect(countsRow(html, `bullet ${i + 1}`)).toMatchObject({
        measured: `${b.length} chars`,
        limit: `${pack.rules.bulletMax}`,
        mark: '✓',
      });
    });
    expect(countsRow(html, 'description').measured).toBe(
      `${listing.description.length} chars / ${utf8Bytes(listing.description)} bytes`,
    );
    expect(countsRow(html, 'backend search terms').measured).toBe(
      `${utf8Bytes(listing.backendSearchTerms)} bytes`,
    );
    expect(countsRow(html, 'attributes (pasteable)').measured).toBe(
      `${Object.keys(listing.attributes).length}`,
    );
    expect(countsRow(html, 'Q&amp;A pairs').measured).toBe(`${listing.qa.length}`);
  });

  it('a number MOVES when the listing changes (a hard-coded table would not)', () => {
    const shorter = clone(listing);
    shorter.title75 = shorter.title75.slice(0, 20);
    shorter.bullets[2] = 'Short bullet';
    shorter.qa = shorter.qa.slice(0, 3);
    const moved = sheetFor(shorter, audit);

    expect(countsRow(moved, 'title75').measured).toBe('20 chars');
    expect(countsRow(moved, 'title75').measured).not.toBe(countsRow(html, 'title75').measured);
    expect(countsRow(moved, 'bullet 3').measured).toBe(`${'Short bullet'.length} chars`);
    expect(countsRow(moved, 'Q&amp;A pairs').measured).toBe('3');
    expect(moved).toContain('7 · Seeded Q&amp;A — 3 pairs');
  });

  it('byte counts move on a MULTI-BYTE change, not just a length change', () => {
    const multibyte = clone(listing);
    multibyte.backendSearchTerms = 'süß grüntee';
    const moved = sheetFor(multibyte, audit);
    expect(countsRow(moved, 'backend search terms').measured).toBe(
      `${utf8Bytes('süß grüntee')} bytes`,
    );
    expect(utf8Bytes('süß grüntee')).toBeGreaterThan('süß grüntee'.length);
  });

  it('renders ✗ — not ✓ — when a field is over its limit', () => {
    const over = clone(listing);
    over.title75 = 'x'.repeat(pack.rules.title75Max + 1);
    over.bullets[0] = 'y'.repeat(pack.rules.bulletMax + 5);
    over.backendSearchTerms = 'z'.repeat(pack.rules.backendMaxBytes + 10);
    const sheet = sheetFor(over, audit);
    expect(countsRow(sheet, 'title75').mark).toBe('✗');
    expect(countsRow(sheet, 'bullet 1').mark).toBe('✗');
    expect(countsRow(sheet, 'backend search terms').mark).toBe('✗');
    // untouched rows are unaffected
    expect(countsRow(sheet, 'bullet 2').mark).toBe('✓');
  });

  it('a wrong bullet COUNT is reported ✗ as well', () => {
    const four = clone(listing);
    four.bullets = four.bullets.slice(0, 4);
    expect(countsRow(sheetFor(four, audit), 'bullet count').mark).toBe('✗');
  });
});

describe('ship sheet — UNVERIFIED runs must not look shippable', () => {
  let blocked: string;
  let failedAudit: Audit;

  beforeAll(() => {
    const bad = clone(listing);
    bad.title75 = 'x'.repeat(pack.rules.title75Max + 40);
    bad.bullets[1] = 'Cures diabetes and reverses arthritis in eight weeks*';
    failedAudit = buildAudit(snapshot, bad, pack, ctx);
    blocked = sheetFor(bad, failedAudit);
  });

  it('the mutated run really does fail the gate', () => {
    expect(failedAudit.verified).toBe(false);
    expect(failedAudit.gateResult.failures.length).toBeGreaterThan(0);
  });

  it('shows NO verified banner and a blocking one instead', () => {
    expect(blocked).not.toContain('✓ Verified for publish.');
    expect(blocked).toContain('⛔ NOT VERIFIED — do not publish this listing.');
  });

  it('names every DISTINCT failing checkId, and each failure field/context/fix', () => {
    const ids = [...new Set(failedAudit.gateResult.failures.map((f) => f.checkId))];
    expect(ids.length).toBeGreaterThan(1);
    for (const id of ids) expect(blocked, `check ${id} named`).toContain(`<code>${id}</code>`);
    for (const f of failedAudit.gateResult.failures) {
      expect(blocked, `field ${f.field}`).toContain(f.field);
      expect(blocked, `fix for ${f.checkId}`).toContain(
        f.fix.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      );
    }
  });

  it('omits EVERY copy button and the clipboard script entirely', () => {
    expect(blocked).not.toContain('class=cp');
    expect(blocked).not.toContain('data-t=');
    expect(blocked).not.toContain('data-v=');
    expect(blocked).not.toContain('<script>');
    expect(blocked).not.toContain('navigator.clipboard');
    // the copy is still SHOWN — it is the paste affordance that is withheld
    expect(blocked).toContain('data-sheet="title75"');
  });
});

describe('ship sheet — escaping', () => {
  it('a value containing a double quote cannot break out of the data-v attribute', () => {
    const quoted = clone(listing);
    quoted.attributes.flavor_name = 'He said "hi" <b>now</b>';
    const sheet = sheetFor(quoted, audit);
    expect(sheet).toContain('&quot;hi&quot;');
    expect(sheet).not.toContain('data-v="He said "hi"');
    expect(sheet).not.toContain('<b>now</b>');
  });
});
