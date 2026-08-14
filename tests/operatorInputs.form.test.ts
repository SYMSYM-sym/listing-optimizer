import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOperatorInputs,
  EMPTY_OPERATOR_INPUTS,
  MAX_COMPETITOR_ASINS,
  parseCompetitorAsins,
  parseFictionPhrases,
  parsePanelFacts,
  regenerateOperatorInputs,
  type OperatorInputForm,
} from '@/app/operatorInputs';
import { isBulletArchitectureGap, BULLET_LINT_PREFIXES } from '@/lib/shared/bulletLintTags';
import { normalizePanelFacts } from '@/lib/knowledge/panelFacts';

/**
 * F4 — THE THREE UI LEGS THAT SHIPPED AS API-ONLY, plus the panel confirm.
 *
 * `reviewsText`, `competitorAsins`, `fictionPhrases`, `panelFacts` and the
 * `keywords` artifact were all built, all tested server-side, and all
 * unreachable: the app had ZERO references to any of them. Two kinds of
 * assertion close that, because either alone would be weak:
 *
 *  1. THE PARSERS, in both directions. An empty field must contribute NO key
 *     (absence and emptiness are different statements — `reviewsText: ''`
 *     would flip P11 from "unscored" to "scored against nothing"), and a
 *     filled one must produce exactly what the route accepts.
 *  2. THE COMPONENTS REFERENCE THEM. The original finding was literally "zero
 *     references in app/", so a source-level assertion is the one that would
 *     have caught it. It is coarse on purpose: it fails if a leg is deleted,
 *     and it cannot be satisfied by a parser nobody renders.
 */

const src = (file: string): string => readFileSync(join(process.cwd(), 'app', file), 'utf8');

const form = (over: Partial<OperatorInputForm> = {}): OperatorInputForm => ({
  ...EMPTY_OPERATOR_INPUTS,
  ...over,
});

// ===========================================================================
// 1 — ABSENT: an untouched form sends the body that was sent before
// ===========================================================================

describe('operator inputs — untouched fields contribute NO key', () => {
  it('an empty form produces an empty body', () => {
    expect(buildOperatorInputs(EMPTY_OPERATOR_INPUTS)).toEqual({});
    expect(regenerateOperatorInputs(EMPTY_OPERATOR_INPUTS)).toEqual({});
  });

  it('whitespace-only input is still absent, never an empty value', () => {
    const body = buildOperatorInputs(
      form({ reviewsText: '   \n ', competitorAsins: '  ', fictionPhrases: '\n\n', panelFacts: '  \n' }),
    );
    expect(body).toEqual({});
    expect('reviewsText' in body).toBe(false);
    expect('panelFacts' in body).toBe(false);
  });

  it('junk that parses to nothing is absent rather than empty', () => {
    const body = buildOperatorInputs(
      form({ competitorAsins: 'not-an-asin, https://example.com', fictionPhrases: 'ab\nx', panelFacts: 'no separator here' }),
    );
    expect(body).toEqual({});
  });
});

// ===========================================================================
// 2 — PRESENT: exactly what the routes accept
// ===========================================================================

describe('operator inputs — parsing', () => {
  it('accepts bare ASINs and product URLs, dedupes, and caps at the route cap', () => {
    const raw = [
      'B0TESTASIN',
      'b0testasin',
      'https://www.amazon.com/dp/B0AAAAAAA1',
      'B0BBBBBBB2, B0CCCCCCC3',
      'B0DDDDDDD4 B0EEEEEEE5',
    ].join('\n');
    const asins = parseCompetitorAsins(raw);
    expect(asins.length).toBe(MAX_COMPETITOR_ASINS);
    expect(new Set(asins).size).toBe(asins.length);
    expect(asins[0]).toBe('B0TESTASIN');
    expect(asins).toContain('B0AAAAAAA1');
  });

  it('drops entries the route would drop anyway', () => {
    expect(parseCompetitorAsins('SHORT, waaaaaaaaytoolong, ??????????')).toEqual([]);
  });

  it('takes one fiction phrase per line, deduped, with the server-side length floor', () => {
    expect(parseFictionPhrases('triple-strength complex\n  ab  \nTriple-Strength Complex\n\nretired blend name')).toEqual([
      'triple-strength complex',
      'retired blend name',
    ]);
  });

  it('takes confirmed panel values as key: value lines, values may contain colons', () => {
    expect(parsePanelFacts('serving_size: 1 Capsule\nunit_count: 60 Count\nnote: see: label')).toEqual({
      serving_size: '1 Capsule',
      unit_count: '60 Count',
      note: 'see: label',
    });
  });

  it('what the form produces survives the SERVER-side normalizer unchanged', () => {
    const panel = parsePanelFacts('serving_size: 1 Capsule\nmaximum_dosage: 50 Billion CFU');
    expect(normalizePanelFacts(panel)).toEqual(panel);
  });

  it('a fully filled form produces every key, and regenerate carries the three that still apply', () => {
    const filled = form({
      reviewsText: 'It fits my morning routine.',
      competitorAsins: 'B0TESTASIN',
      fictionPhrases: 'triple-strength complex',
      panelFacts: 'unit_count: 90 Count',
    });
    expect(buildOperatorInputs(filled)).toEqual({
      reviewsText: 'It fits my morning routine.',
      competitorAsins: ['B0TESTASIN'],
      fictionPhrases: ['triple-strength complex'],
      panelFacts: { unit_count: '90 Count' },
    });
    // A regeneration must not escape C11 phrases or the confirmed panel, and it
    // must not LOSE the operator's review language: a regenerated group written
    // without the mined buyer phrasing stops mirroring the operator's buyers
    // while every other group still does. COMPETITORS are still not sent —
    // they feed the benchmark, which a single-group regeneration does not
    // re-ingest, and the route does not accept them.
    expect(regenerateOperatorInputs(filled)).toEqual({
      reviewsText: 'It fits my morning routine.',
      fictionPhrases: ['triple-strength complex'],
      panelFacts: { unit_count: '90 Count' },
    });
  });
});

// ===========================================================================
// 3 — THE COMPONENTS ACTUALLY RENDER THEM (the original finding)
// ===========================================================================

describe('the UI reaches every leg that used to be API-only', () => {
  it('the request form wires all four optional inputs', () => {
    const page = src('page.tsx');
    for (const marker of [
      'buildOperatorInputs',
      'operatorInputs.reviewsText',
      'operatorInputs.competitorAsins',
      'operatorInputs.fictionPhrases',
      'operatorInputs.panelFacts',
      'MAX_COMPETITOR_ASINS',
    ]) {
      expect(page, marker).toContain(marker);
    }
    // the panel's operator-facing wording is PACK DATA, not a component literal
    expect(page).toContain('rules.operatorPanel?.inputLabel');
    expect(page).toContain('rules.operatorPanel?.inputHelp');
  });

  it('the results panel renders the keyword artifact and the coverage summary', () => {
    const panel = src('ResultsPanel.tsx');
    expect(panel).toContain("'keywords'");
    expect(panel).toContain('result.optimized.keywords');
    expect(panel).toContain('result.audit.keywordCoverage');
    // term / tier / status / surfaces / why — the five columns the audit asked for
    for (const column of ['k.term', 'k.tier', 'k.status', 'k.surfaces', 'k.why']) {
      expect(panel, column).toContain(column);
    }
  });

  it('the results panel renders every advisory section that was built and never shown', () => {
    const panel = src('ResultsPanel.tsx');
    for (const marker of [
      'result.audit.substantiationRegister',
      'result.audit.candidateTerms',
      'result.audit.benchmark',
      'result.audit.scorecardProposed',
      'isBulletArchitectureGap',
    ]) {
      expect(panel, marker).toContain(marker);
    }
  });

  it('regeneration carries the per-run inputs forward', () => {
    expect(src('ResultsPanel.tsx')).toContain('regenerateOperatorInputs(operatorInputs)');
  });
});

// ===========================================================================
// 4 — the gap partition the advisory section depends on
// ===========================================================================

describe('bullet-architecture gap tagging', () => {
  it('recognises a lint and only a lint', () => {
    for (const prefix of BULLET_LINT_PREFIXES) {
      expect(isBulletArchitectureGap({ why: `${prefix} something` }), prefix).toBe(true);
    }
    expect(isBulletArchitectureGap({ why: 'Title: the product name must come first' })).toBe(false);
    expect(isBulletArchitectureGap({})).toBe(false);
    expect(isBulletArchitectureGap({ why: 42 })).toBe(false);
  });
});
