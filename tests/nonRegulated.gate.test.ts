import { describe, expect, it } from 'vitest';
import { runGate } from '@/lib/gate/runGate';
import { detectCategory } from '@/lib/knowledge/detectCategory';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { KnowledgePack, OptimizedListing } from '@/lib/types';
import { NON_REGULATED_PRODUCTS, listingOf, snapshotOf } from './fixtures/nonRegulated';

/**
 * NON-REGULATED PRODUCTS MUST BE USABLE.
 *
 * A usability audit put eight ordinary products through the tool and all eight
 * came back with a BLOCKING `PACK` failure, because the generic pack's suspicion
 * lexicon carried ordinary retail vocabulary — `count`, `daily`, `blend`,
 * `powder`, `extract`, `drops`, `serving`, `mg`, `iu`. A gate that cannot process
 * a coffee grinder is not a gate, it is a wall.
 *
 * Over-blocking and under-blocking are the same defect, so the fail-CLOSED half
 * is asserted in the same file: a genuine regulated listing that lands on the
 * generic pack must still be stopped.
 */

/** The pre-round-6 lexicon, verbatim — used to prove this suite is not vacuous. */
const OLD_SUSPICION_LEXICON = [
  'blend', 'botanical', 'caplet', 'caplets', 'capsule', 'capsules', 'cfu', 'chew', 'chewable',
  'chews', 'count', 'ct', 'daily', 'dietary supplement', 'drops', 'extract', 'greens', 'gummies',
  'gummy', 'herbal', 'iu', 'lozenge', 'mcg', 'mg', 'powder', 'probiotic', 'proprietary blend',
  'scoop', 'serving', 'serving size', 'servings', 'servings per container', 'softgel', 'softgels',
  'supplement', 'supplement facts', 'supplements', 'tablet', 'tablets', 'tincture', 'vitamin',
  'vitamins',
];

describe('non-regulated products route to generic and pass the gate clean', () => {
  it.each(NON_REGULATED_PRODUCTS.map((p) => [p.productName, p] as const))(
    '%s routes to the generic pack',
    (_name, product) => {
      expect(detectCategory(snapshotOf(product)).packId).toBe('generic');
    },
  );

  it.each(NON_REGULATED_PRODUCTS.map((p) => [p.productName, p] as const))(
    '%s passes runGate with ZERO failures',
    (_name, product) => {
      const snapshot = snapshotOf(product);
      const detection = detectCategory(snapshot);
      const pack = loadPack(detection.packId);
      const gate = runGate(listingOf(product), pack, {
        subcategories: detection.subcategories,
        snapshotText: snapshot.title,
      });
      expect(gate.failures).toEqual([]);
      expect(gate.pass).toBe(true);
    },
  );

  it('is NOT vacuous — the pre-fix lexicon blocked every one of them', () => {
    const pack = loadPack('generic');
    const withOldLexicon: KnowledgePack = { ...pack, suspicionLexicon: OLD_SUSPICION_LEXICON };
    const blocked = NON_REGULATED_PRODUCTS.filter((product) => {
      const snapshot = snapshotOf(product);
      return runGate(listingOf(product), withOldLexicon, {
        subcategories: [],
        snapshotText: snapshot.title,
      }).failures.some((f) => f.checkId === 'PACK');
    });
    expect(blocked.length).toBe(NON_REGULATED_PRODUCTS.length);
  });
});

describe('the generic pack still fails CLOSED for regulated copy', () => {
  const pack = loadPack('generic');
  const base = (): OptimizedListing => listingOf(NON_REGULATED_PRODUCTS[0]!);

  it.each([
    ['a real dosage-form listing', 'Vegan Capsules, 60 count with a proprietary blend'],
    ['explicit label vocabulary', 'Supplement Facts panel with servings per container listed'],
    ['a probiotic', 'Shelf stable probiotic for adults'],
  ])('%s still raises the blocking PACK failure', (_why, copy) => {
    const l = base();
    l.bullets[1] = `Good to know: ${copy}`;
    const gate = runGate(l, pack, { subcategories: [] });
    expect(gate.failures.some((f) => f.checkId === 'PACK')).toBe(true);
  });

  it('a drug claim on a generic-routed listing is caught by the cross-pack backstop, not the lexicon', () => {
    const l = base();
    l.bullets[1] = 'Good to know: this grinder reverses diabetes and shrinks tumors';
    const failures = runGate(l, pack, { subcategories: [] }).failures;
    const packFailures = failures.filter((f) => f.checkId === 'PACK');
    expect(packFailures.length).toBeGreaterThan(0);
    expect(packFailures.map((f) => f.context).join(' ')).toContain('disease/drug term');
  });
});
