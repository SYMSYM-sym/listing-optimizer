import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAudit } from '@/lib/audit/buildAudit';
import { rulesStaleness } from '@/lib/audit/staleness';
import { optimize } from '@/lib/engine/optimize';
import { fieldToGroup } from '@/lib/engine/repair';
import type { GateContext } from '@/lib/gate/checks';
import { c17Style } from '@/lib/gate/checks';
import { runGate } from '@/lib/gate/runGate';
import { mapProduct } from '@/lib/ingest/providers/rainforest';
import { toSnapshot } from '@/lib/ingest/toSnapshot';
import { loadPack } from '@/lib/knowledge/loadPack';
import type { Failure, OptimizedListing, RuleSet } from '@/lib/types';
import rulesJson from '@/knowledge/rules.json';
import { mockLlm } from './fixtures/mockLlm';
import { rainforestSample } from './fixtures/rainforest.sample';

const pack = loadPack('supplements');
const ctx: GateContext = { subcategories: ['probiotic', 'digestive'] };
const snapshot = toSnapshot(mapProduct('B0TESTASIN', rainforestSample.product, rainforestSample));

let clean: OptimizedListing;
beforeAll(async () => {
  clean = await optimize(snapshot, pack, mockLlm);
});

const mut = (fn: (l: OptimizedListing) => void): OptimizedListing => {
  const copy = JSON.parse(JSON.stringify(clean)) as OptimizedListing;
  fn(copy);
  return copy;
};
/** C17 failures only — other checks are covered by tests/gate.test.ts. */
const c17 = (l: OptimizedListing): Failure[] =>
  runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C17');

describe('C17 pass fixtures (no false positives)', () => {
  it('the clean golden fixture produces ZERO C17 failures', () => {
    expect(c17(clean)).toEqual([]);
    expect(c17Style(clean, pack)).toEqual([]);
  });

  it('allow-listed acronyms are never flagged ("50 Billion CFU", USDA, HPLC)', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Verified potency: a 50 Billion CFU blend, USDA certified and HPLC tested for identity';
    });
    expect(c17(l)).toEqual([]);
  });

  it('short acronyms below the pack minimum word length are never flagged (mg, IU, CFU, USA)', () => {
    const l = mut((x) => {
      x.bullets[2] = 'Simple daily dose: 60 capsules with 400 IU and 250 mg of prebiotic fiber, made in the USA';
    });
    expect(c17(l)).toEqual([]);
  });

  it('a bullet ending with the "*" claim marker passes', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Travel ready routine: shelf-stable capsules need no refrigeration on the road*';
    });
    expect(c17(l)).toEqual([]);
  });

  it('a bullet ending with ")" passes', () => {
    const l = mut((x) => {
      x.bullets[1] = 'Travel ready routine: shelf-stable capsules need no refrigeration (no cooler needed)';
    });
    expect(c17(l)).toEqual([]);
  });

  it('"?" in the description is not a banned-character violation (scan is scoped by the pack)', () => {
    const l = mut((x) => {
      x.description = x.description.replace('Who it is for:', 'Not sure if it fits your routine? Who it is for:');
    });
    expect(c17(l).filter((f) => f.field === 'description')).toEqual([]);
  });

  it('a description carrying only <br> tags passes rules 8 and 9', () => {
    const l = mut((x) => {
      x.description = x.description.replace('Who it is for:', 'Extra line.<br><br>Who it is for:');
    });
    expect(c17(l).filter((f) => f.field === 'description')).toEqual([]);
  });

  it('the clean description is inside the UTF-8 byte cap', () => {
    const bytes = new TextEncoder().encode(clean.description).length;
    expect(bytes).toBeLessThanOrEqual(pack.rules.style.descriptionMaxBytes);
    expect(c17(clean).filter((f) => f.field === 'description')).toEqual([]);
  });

  it('the verbatim FDA disclaimer is never scanned as a style violation', () => {
    const l = mut((x) => {
      const hero = x.aplusContent.modules.find((m) => m.id.includes('hero'))!;
      hero.body = `${hero.body}\n\n${x.fdaDisclaimer}`;
    });
    expect(c17(l)).toEqual([]);
  });
});

describe('C17 fail fixtures (one per sub-rule)', () => {
  it('rule 1 — ALL-CAPS bullet hook fails and reports the offending words', () => {
    const l = mut((x) => {
      x.bullets[0] = 'PROBIOTICS FOR DIGESTIVE BALANCE: A 50 Billion CFU blend of 10 strains for daily use*';
    });
    const f = c17(l).find((y) => y.field === 'bullets[0]');
    expect(f).toBeTruthy();
    expect(f?.checkId).toBe('C17');
    expect(f?.context).toContain('PROBIOTICS');
    expect(f?.context).toContain('DIGESTIVE');
    expect(f?.context).not.toContain('CFU');
    expect(f?.fix.toLowerCase()).toContain('sentence case');
  });

  it('rule 1 — ALL-CAPS in an A+ module headline fails on the A+ field', () => {
    const l = mut((x) => {
      x.aplusContent.modules[0]!.headline = 'THE BRAND STORY';
    });
    const f = c17(l).find((y) => y.field.startsWith('aplus.modules'));
    expect(f?.field).toContain('headline');
    expect(f?.context).toContain('STORY');
  });

  it('rule 1 — ALL-CAPS in a comparison cell and an FAQ answer fails', () => {
    const l = mut((x) => {
      x.aplusContent.comparison.rows[0]!.ours = 'STRONGEST blend of 10 strains';
      x.aplusContent.faq[1]!.a = 'NEVER needs refrigeration';
    });
    const fields = c17(l).map((y) => y.field);
    expect(fields.some((f) => f.includes('comparison'))).toBe(true);
    expect(fields.some((f) => f.includes('faq'))).toBe(true);
  });

  it('rule 2 — a bullet starting with a lowercase letter fails', () => {
    const l = mut((x) => {
      x.bullets[1] = 'travel and routine changes: shelf-stable capsules need no refrigeration on the road';
    });
    const f = c17(l).find((y) => y.fix.includes('capital letter'));
    expect(f?.field).toBe('bullets[1]');
  });

  it('rule 3 — a bullet ending with "." fails', () => {
    const l = mut((x) => {
      x.bullets[2] = 'One capsule daily: 60 vegetable capsules provide a full two-month supply.';
    });
    const f = c17(l).find((y) => y.fix.includes('trailing punctuation'));
    expect(f?.field).toBe('bullets[2]');
  });

  it('rule 3 — punctuation hiding behind the "*" claim marker still fails', () => {
    const l = mut((x) => {
      x.bullets[0] = 'Digestive balance support: a 50 Billion CFU blend of 10 strains for daily use.*';
    });
    expect(c17(l).some((y) => y.field === 'bullets[0]' && y.fix.includes('trailing punctuation'))).toBe(true);
  });

  it('rule 4 — a trademark symbol fails', () => {
    const l = mut((x) => {
      x.bullets[3] = 'Quality you can verify: BrandX Probiotic™ is third-party tested and Non-GMO';
    });
    const f = c17(l).find((y) => y.field === 'bullets[3]');
    expect(f?.context).toContain('™');
  });

  it('rule 4 — an emoji fails on any scanned surface', () => {
    const l = mut((x) => {
      x.itemHighlights = 'Vegan gluten free gut support 🔥 shelf stable prebiotic blend, two month supply';
    });
    const f = c17(l).find((y) => y.field === 'itemHighlights' && y.fix.toLowerCase().includes('emoji'));
    expect(f).toBeTruthy();
  });

  it('rule 5 — a banned character in the title fails', () => {
    const l = mut((x) => {
      x.title = `${x.productName} Supplement 50 Billion CFU! 60 Vegan Capsules`;
    });
    const f = c17(l).find((y) => y.field === 'title' && y.fix.includes('banned character'));
    expect(f?.context).toContain('!');
  });

  it('rule 6 — an ASIN in customer copy fails', () => {
    const l = mut((x) => {
      x.description = x.description.replace('Who it is for:', 'See also B0ABCDEFGH. Who it is for:');
    });
    const f = c17(l).find((y) => y.field === 'description' && y.fix.includes('ASIN'));
    expect(f?.context).toContain('B0ABCDEFGH');
  });

  it('rule 7 — "Best Seller" in the title fails', () => {
    const l = mut((x) => {
      x.title = `${x.productName} Best Seller Supplement 50 Billion CFU, 60 Vegan Capsules`;
    });
    const terms = c17(l).filter((y) => y.field === 'title' && y.fix.includes('promotional term'));
    expect(terms.length).toBeGreaterThanOrEqual(1);
    expect(terms.map((t) => t.context)).toContain('best seller');
  });

  it('rule 7 — promotional terms in title75/itemHighlights fail, but not in the description', () => {
    const l = mut((x) => {
      x.title75 = `${x.productName} Cheapest 50 Billion CFU Probiotic`;
      x.itemHighlights = 'Free shipping vegan gluten free gut support, shelf stable, two month supply';
      x.description = x.description.replace('Who it is for:', 'On sale reasoning is not our thing. Who it is for:');
    });
    const fields = c17(l).filter((y) => y.fix.includes('promotional term')).map((y) => y.field);
    expect(fields).toContain('title75');
    expect(fields).toContain('itemHighlights');
    expect(fields).not.toContain('description');
  });
  it('rule 8 — a <p> tag in the description fails', () => {
    const l = mut((x) => {
      x.description = `<p>${x.description}</p>`;
    });
    const f = c17(l).find((y) => y.field === 'description' && y.fix.includes('HTML tag'));
    expect(f?.checkId).toBe('C17');
    expect(f?.context).toContain('<p>');
    expect(f?.fix).toContain('<br>');
  });

  it('rule 8 — <b>, <ul>, <li>, <strong>, <em> and <div> all fail', () => {
    for (const tag of ['b', 'ul', 'li', 'strong', 'em', 'div']) {
      const l = mut((x) => {
        x.description = x.description.replace('Who it is for:', `<${tag}>Who it is for:</${tag}>`);
      });
      const f = c17(l).find((y) => y.field === 'description' && y.fix.includes('HTML tag'));
      expect(f, `<${tag}> must be flagged`).toBeTruthy();
      expect(f?.context).toContain(`<${tag}>`);
    }
  });

  it('rule 8 — <br/> and <br /> are accepted variants of the allowed tag', () => {
    const l = mut((x) => {
      x.description = x.description.replace('Who it is for:', 'A<br/>B<br />C Who it is for:');
    });
    expect(c17(l).filter((y) => y.fix.includes('HTML tag'))).toEqual([]);
  });

  it('rule 9 — a description over the UTF-8 byte cap fails on bytes', () => {
    const cap = pack.rules.style.descriptionMaxBytes;
    const l = mut((x) => {
      // multibyte padding: 1 char = 2 bytes, so this breaks the BYTE cap
      x.description = `${x.description}\n\nQualität ${'ä'.repeat(cap)}`;
    });
    const f = c17(l).find((y) => y.field === 'description' && y.fix.includes('UTF-8 bytes'));
    expect(f?.checkId).toBe('C17');
    expect(f?.context).toContain('bytes');
    expect(Number.parseInt(f!.context, 10)).toBeGreaterThan(cap);
  });
});

describe('C17 is category-agnostic and pack-driven', () => {
  it('reads every threshold and list from pack.rules.style', () => {
    const style = pack.rules.style;
    expect(style.allCapsMinWordLen).toBe(4);
    expect(style.allCapsAllowlist).toEqual(expect.arrayContaining(['CFU', 'IU', 'GMP', 'NSF', 'USDA', 'USA']));
    expect(style.bulletMustStartCapital).toBe(true);
    expect(style.bulletNoTrailingPunctuation).toBe(true);
    expect(style.bulletTrailingAllowed).toEqual(expect.arrayContaining(['*', ')']));
    // Trademark/copyright marks PLUS every non-USD currency symbol a price can hide behind.
    expect(style.bannedSymbols).toEqual(['™', '®', '©', '€', '£', '¥', '₹', '₩', '¢']);
    expect(style.bannedChars).toEqual(['!', '$', '?', '_', '{', '}', '^', '¬', '¦']);
    expect(style.noAsinInCopy).toBe(true);
    expect(style.emojiCheck).toBe(true);
    expect(style.titleTermBans).toEqual(
      expect.arrayContaining(['free shipping', 'best seller', 'bestseller', 'top rated', '#1', 'cheapest', 'on sale', 'hot deal', 'clearance']),
    );
    expect(style.descriptionAllowedHtml).toEqual(['br']);
    // Round 5: the CHARACTER cap (rules.descriptionMax = 2000, enforced by C4)
    // is authoritative. The byte cap is a 4x backstop so accented/non-English
    // copy that satisfies the documented character limit cannot be blocked.
    expect(style.descriptionMaxBytes).toBe(4 * 2000);
  });

  it('emptying the pack lists disarms the check — nothing is hard-coded in the gate', () => {
    const bare = JSON.parse(JSON.stringify(pack)) as typeof pack;
    bare.rules.style = {
      ...bare.rules.style,
      allCapsMinWordLen: 999,
      allCapsRunMin: 0, // FIX D: the shouting-run rule is pack-driven too
      bulletMustStartCapital: false,
      bulletNoTrailingPunctuation: false,
      bannedSymbols: [],
      bannedChars: [],
      noAsinInCopy: false,
      emojiCheck: false,
      titleTermBans: [],
    };
    const shouty = mut((x) => {
      x.bullets[0] = 'ALL CAPS SHOUTING WITH A TRAILING PERIOD.';
      x.title = `${x.productName} Best Seller! B0ABCDEFGH ™`;
    });
    expect(c17Style(shouty, bare)).toEqual([]);
  });

  it('no style lexicon is hard-coded in lib/gate or lib/engine', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    for (const root of ['lib/gate', 'lib/engine']) {
      for (const f of walk(join(process.cwd(), root))) {
        const src = readFileSync(f, 'utf8').toLowerCase();
        for (const literal of ['best seller', 'free shipping', 'clearance', 'top rated', '™', '®', '€']) {
          expect(src.includes(literal), `${f} must not hard-code style lists`).toBe(false);
        }
      }
    }
  });
});

describe('C17 repair ownership', () => {
  it('maps each C17 field to the group that owns the regeneration', () => {
    const g = (field: string) => fieldToGroup({ checkId: 'C17', field, context: '', fix: '' });
    expect(g('title')).toBe('title');
    expect(g('title75')).toBe('title');
    expect(g('itemHighlights')).toBe('title');
    expect(g('bullets[2]')).toBe('bullets');
    expect(g('description')).toBe('description');
    expect(g('aplus.modules[hero].headline')).toBe('aplus');
    expect(g('aplus.comparison[0].ours')).toBe('aplus');
    expect(g('aplus.faq[1].a')).toBe('aplus');
  });
});

describe('expanded compliance lexicon', () => {
  const cp = pack.compliancePack!;
  const GENERIC_WELLNESS_WORDS = [
    'support', 'health', 'wellness', 'stress', 'energy', 'immune', 'immunity',
    'sleep', 'mood', 'focus', 'balance',
  ];

  it('keeps all 26 subcategory lists and every one is NON-EMPTY (fail-closed depends on it)', () => {
    const map = cp.diseaseNounsBySubcategory;
    expect(Object.keys(map)).toHaveLength(26);
    for (const [k, v] of Object.entries(map)) {
      expect(v.length, `subcategory '${k}' must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('is substantially expanded (core + per-subcategory)', () => {
    expect(cp.coreDiseaseNouns.length).toBeGreaterThanOrEqual(100);
    const total = Object.values(cp.diseaseNounsBySubcategory).reduce((a, v) => a + v.length, 0);
    expect(total).toBeGreaterThanOrEqual(500);
    for (const [k, v] of Object.entries(cp.diseaseNounsBySubcategory)) {
      expect(v.length, `subcategory '${k}'`).toBeGreaterThanOrEqual(10);
    }
  });

  it('never contains generic wellness words that would false-positive compliant copy', () => {
    const lists = [cp.coreDiseaseNouns, ...Object.values(cp.diseaseNounsBySubcategory)];
    for (const list of lists) {
      for (const term of list) {
        expect(GENERIC_WELLNESS_WORDS).not.toContain(term.toLowerCase());
      }
    }
  });

  it('has no duplicate entries inside any single list', () => {
    const lists: [string, string[]][] = [
      ['core', cp.coreDiseaseNouns],
      ...Object.entries(cp.diseaseNounsBySubcategory),
    ];
    for (const [name, list] of lists) {
      expect(new Set(list.map((t) => t.toLowerCase())).size, `${name} has duplicates`).toBe(list.length);
    }
  });

  it('the clean golden fixture stays green against the UNION of every subcategory list', () => {
    const all = Object.keys(cp.diseaseNounsBySubcategory);
    const result = runGate(clean, pack, { subcategories: all });
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('the negation guard still exempts the verbatim disclaimer wording', () => {
    const l = mut((x) => {
      x.description = x.description.replace(
        'Who it is for:',
        'This product is not intended to diagnose, treat, cure, or prevent any disease. Who it is for:',
      );
    });
    expect(runGate(l, pack, ctx).failures.filter((f) => f.checkId === 'C6')).toEqual([]);
  });

  it('newly added terms are actually enforced', () => {
    const l = mut((x) => { x.bullets[0] = 'Helps with diverticulosis and peptic ulcer discomfort every day*'; });
    expect(runGate(l, pack, ctx).failures.some((f) => f.checkId === 'C6')).toBe(true);
  });
});

describe('rule staleness (non-blocking)', () => {
  const rules = pack.rules;

  it('the rule snapshot is dated and carries a staleness horizon', () => {
    expect(rulesJson.verifiedAsOf).toBe('2026-07-29');
    expect(rules.verifiedAsOf).toBe('2026-07-29');
    expect(rules.staleAfterDays).toBe(90);
    // the re-verified July 2026 policy values are unchanged
    expect(rules.title75Max).toBe(75);
    expect(rules.itemHighlightsMax).toBe(125);
    expect(rules.bulletCount).toBe(5);
    expect(rules.bulletMax).toBe(255);
  });

  it('is not stale inside the horizon', () => {
    const r = rulesStaleness(rules, new Date('2026-09-01T00:00:00Z'));
    expect(r.stale).toBe(false);
    expect(r.notice).toBeUndefined();
  });

  it('is stale past the horizon and explains why', () => {
    const r = rulesStaleness(rules, new Date('2027-01-01T00:00:00Z'));
    expect(r.stale).toBe(true);
    expect(r.ageDays).toBeGreaterThan(90);
    expect(r.notice).toContain('2026-07-29');
    expect(r.notice).toContain('does not affect the verify gate');
  });

  it('fails safe (stale) when verifiedAsOf is unreadable', () => {
    const broken = { ...rules, verifiedAsOf: '' } as RuleSet;
    expect(rulesStaleness(broken).stale).toBe(true);
  });

  it('never becomes a gate failure and never changes `verified`', () => {
    const stale: RuleSet = { ...pack.rules, verifiedAsOf: '2000-01-01' };
    const stalePack = { ...pack, rules: stale };
    const gate = runGate(clean, stalePack, ctx);
    expect(gate.pass).toBe(true);
    expect(gate.failures).toEqual([]);
    const audit = buildAudit(snapshot, clean, stalePack, ctx);
    expect(audit.rulesStale).toBe(true);
    expect(audit.rulesStaleNotice).toBeTruthy();
    expect(audit.verified).toBe(true);
    expect(audit.verified).toBe(audit.gateResult.pass);
  });

  it('surfaces the flag on every audit payload', () => {
    const audit = buildAudit(snapshot, clean, pack, ctx);
    expect(typeof audit.rulesStale).toBe('boolean');
    expect(audit.verified).toBe(audit.gateResult.pass);
  });
});
