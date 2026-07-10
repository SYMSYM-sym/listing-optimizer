import { describe, expect, it } from 'vitest';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { mapAttributes, mapLabel } from '@/lib/ingest/labelMap';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { fromManualFields, fromPastedHtml, PasteError } from '@/lib/ingest/paste';
import { rainforestSample } from './fixtures/rainforest.sample';

const product = rainforestSample.product;

describe('rainforest mapping → snapshot (drift contract)', () => {
  const raw = mapProduct('B0TESTASIN', product, rainforestSample);
  const snapshot = toSnapshot(raw);

  it('maps every fixture attribute label or records it as unmapped (no silent drops)', () => {
    const labels = [...product.attributes, ...product.specifications].map((a) => a.name);
    const { attributes, unmapped } = mapAttributes(
      labels.map((name) => ({ name, value: 'x' })),
    );
    const accounted = Object.keys(attributes).length + unmapped.length;
    // internal '_'-prefixed labels (rank, reviews) are intentionally dropped
    const internal = labels.filter((l) => mapLabel(l)?.startsWith('_')).length;
    expect(accounted + internal).toBe(labels.length);
    // Drift alarm: fixture labels that SHOULD map must map.
    expect(unmapped.map((u) => u.name)).toEqual([]);
  });

  it('yields ≥8 mapped underscore_case fields from the recorded fixture', () => {
    expect(Object.keys(snapshot.attributes).length).toBeGreaterThanOrEqual(8);
    expect(snapshot.attributes.item_form).toBe('Capsule');
    expect(snapshot.attributes.primary_supplement_type).toBe('Probiotic');
    expect(snapshot.attributes.brand_name).toBe('BrandX');
    expect(snapshot.attributes.manufacturer).toBe('BrandX Labs LLC');
  });

  it('populates the snapshot core fields', () => {
    expect(snapshot.title).toContain('Probiotic');
    expect(snapshot.bullets).toHaveLength(5);
    expect(snapshot.images.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.category).toContain('Probiotics');
    expect(snapshot.price).toBe('$24.99');
    expect(snapshot.rating).toBe(4.5);
  });

  it('never fabricates backend search terms (seller-private)', () => {
    expect(Object.keys(snapshot.attributes)).not.toContain('generic_keyword');
    expect(JSON.stringify(snapshot)).not.toContain('generic_keyword');
  });
});

describe('paste fallback', () => {
  it('parses minimal PDP-shaped HTML', () => {
    const html = `<html><body>
      <span id="productTitle"> BrandX Probiotic 50 Billion CFU </span>
      <div id="feature-bullets"><ul>
        <li><span class="a-list-item">SUPPORTS DIGESTIVE BALANCE*</span></li>
        <li><span class="a-list-item">60 VEGETABLE CAPSULES</span></li>
      </ul></div>
      <div id="productDescription">BrandX Probiotic delivers a 50 Billion CFU blend.</div>
      <div id="prodDetails"><table>
        <tr><th>Item Form</th><td>Capsule</td></tr>
        <tr><th>Brand</th><td>BrandX</td></tr>
      </table></div>
      ${'<p>pad</p>'.repeat(20)}
    </body></html>`;
    const raw = fromPastedHtml(html, 'B0TESTASIN');
    expect(raw.title).toBe('BrandX Probiotic 50 Billion CFU');
    expect(raw.bullets).toHaveLength(2);
    expect(raw.attributesRaw).toContainEqual({ name: 'Item Form', value: 'Capsule' });
  });

  it('rejects rendered text (not HTML) with a typed error', () => {
    expect(() => fromPastedHtml('Just some plain product text with no tags', 'B0TESTASIN')).toThrow(
      PasteError,
    );
  });

  it('manual fields mode always works', () => {
    const raw = fromManualFields(
      { title: 'BrandX Probiotic', bullets: ['a', 'b'], description: 'desc' },
      'B0TESTASIN',
    );
    expect(toSnapshot(raw).title).toBe('BrandX Probiotic');
  });
});
