import { describe, expect, it } from 'vitest';
import { optimize } from '@/lib/engine/optimize';
import { toMarkdown } from '@/lib/export/markdown';
import { toSellerCentralDescription } from '@/lib/export/descriptionHtml';
import { buildAudit } from '@/lib/audit/buildAudit';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const ctx = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

describe('toSellerCentralDescription', () => {
  it('turns a blank line into <br><br>', () => {
    expect(toSellerCentralDescription('One.\n\nTwo.')).toBe('One.<br><br>Two.');
  });

  it('turns a single newline into a single <br>', () => {
    expect(toSellerCentralDescription('One.\nTwo.')).toBe('One.<br>Two.');
  });

  it('collapses runs of blank lines to one paragraph gap', () => {
    expect(toSellerCentralDescription('A\n\n\n\nB')).toBe('A<br><br>B');
  });

  it('treats a whitespace-only line as a paragraph break', () => {
    expect(toSellerCentralDescription('A\n   \nB')).toBe('A<br><br>B');
  });

  it('normalises CRLF and CR line endings', () => {
    expect(toSellerCentralDescription('A\r\n\r\nB')).toBe('A<br><br>B');
    expect(toSellerCentralDescription('A\rB')).toBe('A<br>B');
  });

  it('trims leading/trailing whitespace so no stray break is emitted', () => {
    expect(toSellerCentralDescription('\n\n  A\n\nB  \n\n')).toBe('A<br><br>B');
  });

  it('is a no-op on single-paragraph text', () => {
    expect(toSellerCentralDescription('Just one paragraph.')).toBe('Just one paragraph.');
  });

  it('returns an empty string for empty input', () => {
    expect(toSellerCentralDescription('')).toBe('');
    expect(toSellerCentralDescription('   \n  ')).toBe('');
  });

  it('inserts NO tag other than <br> and escapes nothing', () => {
    const src = 'Cost < 5 & "quality" > rest\n\n50% off? no.';
    const out = toSellerCentralDescription(src);
    expect(out.replace(/<br>/g, '')).toBe(src.replace(/\n\n/g, ''));
    // only <br> may appear as an actual HTML element
    expect(out.match(/<\s*\/?\s*(?!br\s*\/?\s*>)[A-Za-z][A-Za-z0-9]*\b[^>]*>/g)).toBeNull();
    expect(out).toContain('&');
    expect(out).toContain('"quality"');
  });

  it('is lossless: stripping the <br> tags back out restores the text', () => {
    const src = 'Para one.\n\nPara two line one.\nLine two.\n\nPara three.';
    const restored = toSellerCentralDescription(src)
      .replace(/<br><br>/g, '\n\n')
      .replace(/<br>/g, '\n');
    expect(restored).toBe(src);
  });

  it('preserves every paragraph of the real generated description', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const paragraphs = listing.description.split(/\n\s*\n/).filter(Boolean);
    expect(paragraphs.length).toBeGreaterThan(1);
    const out = toSellerCentralDescription(listing.description);
    expect(out).toContain('<br><br>');
    expect(out).not.toContain('\n');
    for (const p of paragraphs) {
      expect(out).toContain(p.trim());
    }
  });
});

describe('markdown export exposes the <br> variant', () => {
  it('includes a clearly labelled Seller Central section alongside the plain text', async () => {
    const listing = await optimize(snapshot, pack, mockLlm);
    const audit = buildAudit(snapshot, listing, pack, ctx);
    const md = toMarkdown(listing, audit);
    expect(md).toContain('## Description (plain text');
    expect(md).toContain('## Description — Seller Central `<br>` variant');
    expect(md).toContain(toSellerCentralDescription(listing.description));
    // the canonical plain-text description is still exported verbatim
    expect(md).toContain(listing.description);
  });
});
