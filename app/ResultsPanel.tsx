'use client';

import { useState } from 'react';
import rules from '@/knowledge/rules.json';
import type { Audit, Failure, GenerationFailure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { toMarkdown } from '@/lib/export/markdown';
import type { GroupName } from '@/lib/engine/optimize';
import { toSellerCentralDescription } from '@/lib/export/descriptionHtml';
import { downloadShipSheet, openShipSheet } from './shipSheetClient';
import { isBulletArchitectureGap } from '@/lib/shared/bulletLintTags';
import {
  GENERATION_FAILURE_CAVEAT,
  GENERATION_FAILURE_HEADING,
  generationFailureDetail,
} from '@/lib/shared/generationFailure';
import { regenerateOperatorInputs, EMPTY_OPERATOR_INPUTS, type OperatorInputForm } from './operatorInputs';
import { CopyButton, Field, SeverityBadge } from './ui';

export type ResultsTab = 'listing' | 'aplus' | 'images' | 'keywords' | 'qa' | 'audit';

export interface ResultsModel {
  optimized: OptimizedListing;
  audit: Audit;
  detection: { packId: string; subcategories: string[] };
  iterations?: number;
  snapshot?: ListingSnapshot;
  runId?: string | null;
  /**
   * U1 — the upstream generation failure this run hit, when it hit one.
   *
   * Carried from the `/api/optimize` (or `/api/regenerate`) response and
   * rendered by `GenerationFailureBanner` ABOVE everything else. Absent/null on
   * every healthy run.
   *
   * U3 — a run REPLAYED FROM HISTORY now carries it too. It is persisted on the
   * run record (`runs.generation_failure`) and read back by `/api/runs/[id]`,
   * so re-opening yesterday's degraded run renders the SAME banner from the
   * SAME component rather than eleven gate failures with no stated cause.
   */
  generationFailure?: GenerationFailure | null;
}

/**
 * U1 — THE RUN DEGRADED BECAUSE THE UPSTREAM API DID, AND NOBODY WAS TOLD.
 *
 * The live outage: the credit balance hit zero, every generation group failed
 * with a 400 `invalid_request_error`, every group degraded, and the gate — doing
 * exactly its job on the empty surfaces that resulted — reported eleven blocking
 * failures (A4, A9, C1, C2, C3, C15, C20, C23, C28, C29, GEN). The API response
 * already carried `generationFailure`; nothing rendered it. What the operator
 * saw was a results panel full of compliance failures, and the only two
 * conclusions available from that screen were "this tool is broken" and "my
 * listing is catastrophic". The true one — GENERATION NEVER RAN — was invisible.
 *
 * So it is stated here, first, before anything a reader could mistake for a
 * judgement of their listing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not suppress, filter, collapse or
 * grey out a single gate failure. Those failures are the honest output of a run
 * in which the copy was never written, and hiding them would be mutating what
 * the checker reported — the one thing this codebase never does. The banner
 * adds a sentence of CONTEXT above them and changes nothing below it.
 *
 * It also decides nothing: `verified` is computed only in
 * `lib/audit/buildAudit.ts`, from the gate, and no branch here is reachable
 * from it. A degraded run is `verified:false` with or without this banner, and
 * both export paths stay locked behind that verdict (the Ship Sheet omits its
 * copy buttons and its clipboard script wholesale on an unverified run; the
 * Markdown export leads with `NOT VERIFIED ... do not publish`; `export final`
 * is `disabled`).
 *
 * The colour is AMBER, not the red the gate uses. Red on this screen means "a
 * check failed on your listing". This is not that, and giving it the same
 * colour would have been one more way to read it as one more compliance
 * problem.
 */
export function GenerationFailureBanner({ failure }: { failure?: GenerationFailure | null }) {
  if (!failure) return null;
  // U3 — the heading, the identity line and the caveat sentence come from
  // `lib/shared/generationFailure`, which is also what the Markdown record and
  // the Ship Sheet print. One wording, three media.
  const detail = generationFailureDetail(failure);
  return (
    <section
      role="alert"
      data-testid="generation-failure-banner"
      className="rounded-xl border-2 border-amber-500 bg-amber-950/40 p-4 space-y-2"
    >
      <div className="text-sm font-semibold text-amber-200">⚠ {GENERATION_FAILURE_HEADING}</div>
      <div className="text-sm text-amber-100">{failure.summary}</div>
      <div className="font-mono text-xs text-amber-300/90">{detail}</div>
      <div className="text-sm text-amber-100/90">
        The copy for this run was never written, so the gate below graded empty and partial fields.{' '}
        <strong className="text-amber-200">{GENERATION_FAILURE_CAVEAT}</strong>{' '}
        They are the honest result of a run whose generation did not happen — they are left visible
        rather than hidden, because the checker&apos;s output is never edited. Nothing here is
        exportable: the run is unverified, so the Ship Sheet and export-final stay locked. Re-run
        once the upstream API is healthy.
      </div>
    </section>
  );
}

/** Status colouring for the keyword table — the six C28 statuses. */
function statusColor(status: string): string {
  switch (status) {
    case 'placed':
      return 'text-emerald-400';
    case 'backend':
      return 'text-sky-400';
    case 'negative':
      return 'text-red-400';
    case 'captured-via':
      return 'text-amber-400';
    default:
      return 'text-zinc-400';
  }
}

function gateFailedOn(failures: Failure[], field: string): boolean {
  return failures.some(
    (f) => f.field === field || f.field.startsWith(`${field}[`) || f.field.startsWith(`${field}.`),
  );
}

function SectionHeader({
  title,
  group,
  regenerating,
  onRegenerate,
}: {
  title: string;
  group: GroupName;
  regenerating: GroupName | null;
  onRegenerate?: (group: GroupName) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="text-sm font-semibold text-zinc-200 tracking-wide uppercase">{title}</h2>
      {onRegenerate && (
        <button
          type="button"
          disabled={regenerating !== null}
          onClick={() => onRegenerate(group)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
        >
          {regenerating === group ? '◐ Regenerating…' : '↻ Regenerate'}
        </button>
      )}
    </div>
  );
}

export function ResultsPanel({
  result,
  headers,
  onUpdated,
  operatorInputs = EMPTY_OPERATOR_INPUTS,
}: {
  result: ResultsModel;
  headers: HeadersInit;
  onUpdated: (next: ResultsModel) => void;
  /**
   * The per-run operator inputs the run was started with. A REGENERATION must
   * carry the ones that still apply (C11 phrases, the confirmed panel), or a
   * single-group regenerate becomes a way to escape them. Defaulted so the
   * history view — which replays a stored run and has no form beside it —
   * behaves exactly as it did.
   */
  operatorInputs?: OperatorInputForm;
}) {
  const [tab, setTab] = useState<ResultsTab>('listing');
  const [regenerating, setRegenerating] = useState<GroupName | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);

  const verified = result.audit.verified;
  const gateFailures = result.audit.gateResult.failures;

  function downloadMarkdown() {
    const md = toMarkdown(result.optimized, result.audit, result.generationFailure);
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `listing-${result.optimized.productName.replace(/\W+/g, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * The ship sheet is SERVER-generated from the STORED run, so it needs a run
   * id. A run that was never persisted (no store configured) has none — the
   * buttons are disabled and say why rather than silently producing a sheet
   * built from client state that nothing re-verified.
   */
  async function shipSheet(mode: 'open' | 'download') {
    if (!result.runId) return;
    setRegenError(null);
    setSheetBusy(true);
    try {
      if (mode === 'open') await openShipSheet(result.runId, headers);
      else await downloadShipSheet(result.runId, headers, result.optimized.productName);
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : 'Ship sheet failed');
    } finally {
      setSheetBusy(false);
    }
  }

  async function regenerate(group: GroupName) {
    if (!result.snapshot) {
      setRegenError('No snapshot available for regenerate (reload the run from History).');
      return;
    }
    setRegenError(null);
    setRegenerating(group);
    try {
      const res = await fetch('/api/regenerate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          snapshot: result.snapshot,
          listing: result.optimized,
          group,
          runId: result.runId ?? undefined,
          ...regenerateOperatorInputs(operatorInputs),
        }),
      });
      if (!res.ok) {
        const e = (await res.json()) as { code?: string; message?: string };
        setRegenError(`${e.code ?? 'ERROR'}: ${e.message ?? 'Regenerate failed'}`);
        return;
      }
      const body = (await res.json()) as {
        optimized: OptimizedListing;
        audit: Audit;
        detection: { packId: string; subcategories: string[] };
        generationFailure?: GenerationFailure;
      };
      onUpdated({
        ...result,
        optimized: body.optimized,
        audit: body.audit,
        detection: body.detection,
        // A regeneration that ALSO failed upstream replaces the notice; one
        // that succeeded does NOT clear it, because it only rewrote ONE group.
        // The other eight are still whatever the failed run left behind, and a
        // banner that vanished the moment a single group came back would be
        // telling the operator the run recovered when it did not.
        generationFailure: body.generationFailure ?? result.generationFailure ?? null,
      });
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : 'Regenerate failed');
    } finally {
      setRegenerating(null);
    }
  }

  const canRegen = Boolean(result.snapshot);
  const keywords = result.optimized.keywords ?? [];
  const coverage = result.audit.keywordCoverage;
  // WS4 — the bullet-architecture lints travel in `audit.gaps`; they are
  // ADVISORY strategy notes rather than field-level diffs, so they get their
  // own section instead of being read as one more row about a bullet's text.
  // The partition uses the tags the producer builds its `why` strings from
  // (lib/shared/bulletLintTags.ts), so the two cannot drift.
  const bulletLints = result.audit.gaps.filter(isBulletArchitectureGap);
  const fieldGaps = result.audit.gaps.filter((g) => !isBulletArchitectureGap(g));
  const register = result.audit.substantiationRegister ?? [];
  const candidates = result.audit.candidateTerms ?? [];
  const benchmark = result.audit.benchmark;
  const before = result.audit.scorecard;
  const after = result.audit.scorecardProposed;

  return (
    <>
      {/*
        U1 — FIRST, above the verdict and above every failure. A reader who
        stops after the top of the screen must still have been told that
        generation failed upstream; one who reads on sees every gate failure,
        unfiltered, exactly as the checker reported them.
      */}
      <GenerationFailureBanner failure={result.generationFailure} />

      <section
        className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-3 ${verified ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}`}
      >
        <div className="text-sm">
          {verified ? (
            <span className="text-emerald-300 font-medium">
              ✅ Verified — all gate checks passed ({result.detection.packId} pack
              {result.detection.subcategories.length > 0 ? `: ${result.detection.subcategories.join(', ')}` : ''})
            </span>
          ) : (
            <span className="text-red-300 font-medium">
              ⛔ Not verified — {result.audit.gateResult.failures.length} blocking failure(s). Export-final is locked;
              see the Audit tab.
            </span>
          )}
          {result.detection.packId === 'generic' && (
            <span className="ml-2 rounded bg-amber-950 border border-amber-800 px-2 py-0.5 text-xs text-amber-300">
              compliance not evaluated for this category
            </span>
          )}
          {result.runId && (
            <span className="ml-2 text-xs text-zinc-500 font-mono">run {result.runId.slice(0, 8)}…</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={JSON.stringify({ optimized: result.optimized, audit: result.audit }, null, 2)}
            label="copy all as JSON"
          />
          <CopyButton
            text={toMarkdown(result.optimized, result.audit, result.generationFailure)}
            label="Copy everything as Markdown"
          />
          <button
            onClick={downloadMarkdown}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            ↓ download Markdown
          </button>
          <button
            disabled={!result.runId || sheetBusy}
            title={
              result.runId
                ? 'Opens the operator paste sheet (regenerated server-side from the stored run)'
                : 'Ship Sheet needs a stored run — the run store is not configured on the server'
            }
            onClick={() => void shipSheet('open')}
            className="rounded-md border border-amber-800 bg-amber-950/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sheetBusy ? '◐ …' : '⧉ Ship Sheet'}
          </button>
          <button
            disabled={!result.runId || sheetBusy}
            title={
              result.runId
                ? 'Downloads the operator paste sheet as a standalone HTML file'
                : 'Ship Sheet needs a stored run — the run store is not configured on the server'
            }
            onClick={() => void shipSheet('download')}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↓ Ship Sheet
          </button>
          <button
            disabled={!verified}
            title={
              verified
                ? 'Marks the export as final'
                : 'Blocked: the verify gate is failing — a listing that fails the gate is never exported as final'
            }
            className="rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed border-emerald-700 bg-emerald-900/60 text-emerald-200"
            onClick={downloadMarkdown}
          >
            ⬇ export final
          </button>
        </div>
      </section>

      {regenError && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-300">{regenError}</div>
      )}

      <nav className="flex gap-1 border-b border-zinc-800">
        {(
          [
            ['listing', 'Listing'],
            ['aplus', 'A+ Content'],
            ['images', 'Images'],
            ['keywords', `Keywords (${result.optimized.keywords?.length ?? 0})`],
            ['qa', 'Q&A'],
            ['audit', `Audit (${result.audit.scorecard.total}/100)`],
          ] as [ResultsTab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${tab === t ? 'border-emerald-500 text-emerald-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'listing' && (
        <section className="space-y-4">
          <SectionHeader
            title="Titles"
            group="title"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          <Field
            label="Title — legacy"
            text={result.optimized.title}
            limit={rules.titleMaxLegacy}
            gateFailed={gateFailedOn(gateFailures, 'title')}
          />
          <Field
            label="Title 75 — primary (policy eff. Jul 27 2026)"
            text={result.optimized.title75}
            limit={rules.title75Max}
            gateFailed={gateFailedOn(gateFailures, 'title75')}
          />
          <Field
            label="Item Highlights (searchable; enter when your template supports it)"
            text={result.optimized.itemHighlights}
            limit={rules.itemHighlightsMax}
            gateFailed={gateFailedOn(gateFailures, 'itemHighlights')}
          />

          <SectionHeader
            title="Bullets"
            group="bullets"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          {result.optimized.bullets.map((b, i) => (
            <Field
              key={i}
              label={`Bullet ${i + 1}${result.optimized.bulletAnchors?.[i] ? ` — ${result.optimized.bulletAnchors[i]}` : ''}`}
              text={b}
              limit={rules.bulletMax}
              gateFailed={gateFailedOn(gateFailures, `bullets[${i}]`)}
            />
          ))}

          <SectionHeader
            title="Description"
            group="description"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          <Field
            label="Description"
            text={result.optimized.description}
            limit={rules.descriptionMax}
            gateFailed={gateFailedOn(gateFailures, 'description')}
            copyLabel="Copy (plain)"
            note="Amazon's description field accepts only the <br> tag. Paste the plain text to keep it simple, or use the <br> variant to preserve these paragraph breaks in Seller Central."
            actions={
              <CopyButton
                text={toSellerCentralDescription(result.optimized.description)}
                label="Copy for Seller Central (<br>)"
              />
            }
          />

          <SectionHeader
            title="Backend search terms"
            group="backend"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          <Field
            label="Backend search terms"
            text={result.optimized.backendSearchTerms}
            limit={rules.backendMaxBytes}
            unit="bytes"
            mono
            gateFailed={gateFailedOn(gateFailures, 'backendSearchTerms')}
          />

          <SectionHeader
            title="Attributes"
            group="attributes"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-zinc-200">
                Attributes ({Object.keys(result.optimized.attributes).length})
              </h3>
              <CopyButton text={JSON.stringify(result.optimized.attributes, null, 2)} label="Copy all attributes" />
            </div>
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(result.optimized.attributes).map(([k, v]) => (
                  <tr key={k} className="border-t border-zinc-800/60">
                    <td className="py-1.5 pr-3 font-mono text-zinc-400 align-top whitespace-nowrap">{k}</td>
                    <td className="py-1.5 text-zinc-300">{v}</td>
                    <td className="py-1.5 pl-2 text-right">
                      <CopyButton text={`${k}: ${v}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'aplus' && (
        <section className="space-y-4">
          <SectionHeader
            title="A+ Content"
            group="aplus"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          {result.optimized.aplusContent.modules.map((m) => (
            <div key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  [{m.id}]{' '}
                  {m.claimBearing && <span className="text-xs text-amber-400">claim-bearing</span>}
                </h3>
                <CopyButton text={`${m.headline}\n\n${m.body}${m.subcopy ? `\n\n${m.subcopy}` : ''}`} label="copy module" />
              </div>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-zinc-100">{m.headline}</p>
                <CopyButton text={m.headline} label="headline" />
              </div>
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm text-zinc-300 whitespace-pre-wrap">{m.body}</p>
                <CopyButton text={m.body} label="body" />
              </div>
              {m.subcopy && (
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-zinc-500 italic">{m.subcopy}</p>
                  <CopyButton text={m.subcopy} label="subcopy" />
                </div>
              )}
            </div>
          ))}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-zinc-200">Comparison</h3>
              <CopyButton
                text={result.optimized.aplusContent.comparison.rows
                  .map((r) => `${r.label}: ${r.ours} | typical: ${r.typical}`)
                  .join('\n')}
              />
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1"></th>
                  <th className="py-1">Ours</th>
                  <th className="py-1">Typical</th>
                </tr>
              </thead>
              <tbody>
                {result.optimized.aplusContent.comparison.rows.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-800/60">
                    <td className="py-2 pr-3 text-zinc-400">{r.label}</td>
                    <td className="py-2 pr-3 text-zinc-200">{r.ours}</td>
                    <td className="py-2 text-zinc-400">{r.typical}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3">
            <h3 className="text-sm font-medium text-zinc-200">A+ FAQ</h3>
            {result.optimized.aplusContent.faq.map((f, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-t border-zinc-800/60 pt-2">
                <div>
                  <p className="text-sm text-zinc-200 font-medium">Q: {f.q}</p>
                  <p className="text-sm text-zinc-400 whitespace-pre-wrap">A: {f.a}</p>
                </div>
                <CopyButton text={`Q: ${f.q}\nA: ${f.a}`} />
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'images' && (
        <section className="space-y-4">
          <SectionHeader
            title="Image plan"
            group="images"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {result.optimized.imagePlan.map((s) => (
              <div key={s.slot} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-medium text-zinc-200">
                    Slot {s.slot} — {s.purpose}
                  </h3>
                  <CopyButton text={`${s.purpose}\nSpec: ${s.spec}\nNotes: ${s.notes}`} />
                </div>
                <p className="text-xs text-zinc-400">{s.spec}</p>
                <p className="mt-1 text-xs text-zinc-500">{s.notes}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/*
        WS3 — THE KEYWORD REFERENCE.

        The SURFACES column is DERIVED: code reads the finished copy and
        records where each term actually landed (the model is not asked — when
        it was, it was wrong ~21 times per live run and the repair loop could
        never converge). Gate C28 then re-verifies the whole artifact
        independently: every `backend` term sits in the search-terms field and
        nowhere a customer reads, every `negative` term appears NOWHERE at all.
        Rendering it is not decoration — the playbook's own failure mode was a
        hand-written "all placed" checklist, and this is the view where an
        operator sees the computed version of it.
      */}
      {tab === 'keywords' && (
        <section className="space-y-4">
          <SectionHeader
            title="Keyword reference"
            group="keywords"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          {keywords.length === 0 ? (
            <p className="text-sm text-zinc-500">
              This run carries no keyword artifact. A stored run created before the keyword system existed will show
              none; a fresh run cannot — C28 fails a listing with an empty reference.
            </p>
          ) : (
            <>
              {coverage && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-zinc-200">
                      Coverage — {coverage.total} term(s), machine-verified
                    </h3>
                    <CopyButton text={JSON.stringify(coverage, null, 2)} label="copy coverage JSON" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(coverage.byStatus).map(([status, n]) => (
                      <span
                        key={status}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                      >
                        {status} <span className="tabular-nums text-zinc-500">{n}</span>
                      </span>
                    ))}
                  </div>
                  {coverage.negatives.length > 0 && (
                    <p className="mt-3 text-xs text-zinc-500">
                      <span className="text-emerald-400">{coverage.negatives.length} negative term(s)</span> verified to
                      appear nowhere at all — rival brand names belong here (R50), not in the copy.
                    </p>
                  )}
                  {coverage.recaptured.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {coverage.recaptured.map((r) => (
                        <li key={r.term} className="text-xs text-zinc-400">
                          <span className="font-mono text-zinc-300">{r.term}</span> → captured via {r.via}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-zinc-200">Terms ({keywords.length})</h3>
                  <CopyButton text={JSON.stringify(keywords, null, 2)} label="copy keywords JSON" />
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-zinc-500 border-b border-zinc-800">
                      <th className="py-1 pr-3">Term</th>
                      <th className="py-1 pr-3">Tier</th>
                      <th className="py-1 pr-3">Status</th>
                      <th className="py-1 pr-3" title="Computed from the finished copy — not declared">
                        Surfaces (derived)
                      </th>
                      <th className="py-1">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keywords.map((k, i) => (
                      <tr key={`${k.term}-${i}`} className="border-t border-zinc-800/60 align-top">
                        <td className="py-2 pr-3 font-mono text-zinc-200">{k.term}</td>
                        <td className="py-2 pr-3 text-zinc-500">{String(k.tier)}</td>
                        <td className={`py-2 pr-3 font-medium ${statusColor(k.status)}`}>{k.status}</td>
                        <td className="py-2 pr-3 text-zinc-400">
                          {k.surfaces && k.surfaces.length > 0 ? (
                            <span className="font-mono">{k.surfaces.join(', ')}</span>
                          ) : k.via ? (
                            <span className="italic text-zinc-600">via {k.via}</span>
                          ) : k.home ? (
                            <span className="italic text-zinc-600">home: {k.home}</span>
                          ) : (
                            <span className="italic text-zinc-600">none — deliberately</span>
                          )}
                        </td>
                        <td className="py-2 text-zinc-500">
                          {k.why}
                          {k.note && <span className="block text-zinc-600 italic">{k.note}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'qa' && (
        <section className="space-y-3">
          <SectionHeader
            title="Q&A"
            group="qa"
            regenerating={regenerating}
            onRegenerate={canRegen ? regenerate : undefined}
          />
          {result.optimized.qa.map((f, i) => (
            <div
              key={i}
              className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 flex items-start justify-between gap-3"
            >
              <div>
                <p className="text-sm font-medium text-zinc-200">
                  Q: {f.q} {f.claimBearing && <span className="text-xs text-amber-400">claim-bearing</span>}
                </p>
                <p className="mt-1 text-sm text-zinc-400 whitespace-pre-wrap">A: {f.a}</p>
              </div>
              <CopyButton text={`Q: ${f.q}\nA: ${f.a}`} />
            </div>
          ))}
        </section>
      )}

      {tab === 'audit' && (
        <section className="space-y-5">
          <div
            className={`rounded-lg border p-4 ${verified ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}`}
          >
            <h3 className="text-sm font-semibold mb-2">
              {verified
                ? '✅ Verify gate: PASS'
                : `⛔ Verify gate: ${result.audit.gateResult.failures.length} blocking failure(s)`}
            </h3>
            {!verified && (
              <ul className="space-y-2">
                {result.audit.gateResult.failures.map((f, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-mono text-red-300">[{f.checkId}]</span>{' '}
                    <span className="text-zinc-300">{f.field}</span>
                    <span className="block text-xs text-zinc-500">{f.context}</span>
                    <span className="block text-xs text-amber-300">fix: {f.fix}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {result.audit.rulesStale && (
            <div className="rounded-lg border border-amber-900 bg-amber-950/30 p-4">
              <h3 className="text-sm font-semibold text-amber-200 mb-1">
                ⚠️ Rule snapshot may be stale (non-blocking)
              </h3>
              <p className="text-xs text-amber-100/80">
                {result.audit.rulesStaleNotice ??
                  'Re-verify the time-sensitive Amazon limits in the knowledge pack.'}
              </p>
            </div>
          )}
          {/*
            The attribute template has its OWN verification date and its own
            horizon: policy limits and category templates move for different
            reasons and are re-verified by different work, so a fresh rule
            snapshot must not mask a stale schema. Advisory exactly like the
            notice above — neither ever touches `verified`.
          */}
          {result.audit.attributeSchemaStale && (
            <div className="rounded-lg border border-amber-900 bg-amber-950/30 p-4">
              <h3 className="text-sm font-semibold text-amber-200 mb-1">
                ⚠️ Attribute schema may be stale (non-blocking)
              </h3>
              <p className="text-xs text-amber-100/80">
                {result.audit.attributeSchemaStaleNotice ??
                  'Re-verify the category attribute template (Category Listing Report) against the knowledge pack.'}
              </p>
            </div>
          )}
          {/*
            WS6 — BEFORE -> AFTER, by the SAME scorer.

            `scorecardProposed` is the identical judge run over the proposed
            listing, so the two columns are comparable by construction. It is
            never a verdict: `verified` is exactly `gateResult.pass`, and a
            listing can score well and still be blocked.
          */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-zinc-200">
                Optimization principles — current {before.total}/100
                {after && (
                  <>
                    {' '}
                    <span className="text-zinc-600">→</span>{' '}
                    <span className={after.total >= before.total ? 'text-emerald-300' : 'text-amber-300'}>
                      proposed {after.total}/100
                    </span>
                  </>
                )}
              </h3>
              {after && (
                <span className="text-xs text-zinc-500">
                  same scorer, both sides — a score is never a verdict; the gate is
                </span>
              )}
            </div>
            <ul className="space-y-1.5">
              {before.perPrinciple.map((p) => {
                const post = after?.perPrinciple.find((q) => q.id === p.id);
                return (
                  <li key={p.id} className="text-xs flex gap-2">
                    <span
                      className={`w-14 shrink-0 font-mono ${p.score === 'full' ? 'text-emerald-400' : p.score === 'partial' ? 'text-amber-400' : p.score === 'none' ? 'text-red-400' : 'text-zinc-600'}`}
                    >
                      {p.id} {p.score === 'unknown' ? '—' : p.score}
                    </span>
                    {post && (
                      <span
                        className={`w-20 shrink-0 font-mono ${post.score === 'full' ? 'text-emerald-400' : post.score === 'partial' ? 'text-amber-400' : post.score === 'none' ? 'text-red-400' : 'text-zinc-600'}`}
                        title={post.rationale}
                      >
                        → {post.score === 'unknown' ? '—' : post.score}
                      </span>
                    )}
                    <span className="text-zinc-400">{p.rationale}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/*
            R33/R38 — THE SUBSTANTIATION REGISTER.

            Every other compliance check asks "is this phrasing allowed?"; this
            one asks "can we prove it?", which is the question the marketplace
            actually asks when it sends a compliance request. The app cannot
            hold a certificate, so it can only ever say WHERE a claim is being
            made and whether the source listing was already making it. A
            PENDING row is a claim the generator introduced by itself.
          */}
          {register.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-zinc-200">
                  Substantiation register — {register.filter((r) => r.status === 'PENDING').length} pending /{' '}
                  {register.length}
                </h3>
                <CopyButton text={JSON.stringify(register, null, 2)} label="copy register" />
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1 pr-2">Status</th>
                    <th className="py-1 pr-2">Claim</th>
                    <th className="py-1 pr-2">Surfaces</th>
                    <th className="py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {register.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-800/60 align-top">
                      <td className="py-2 pr-2">
                        <span
                          className={`rounded border px-1.5 py-0.5 font-semibold ${r.status === 'PENDING' ? 'border-amber-800 bg-amber-950 text-amber-300' : 'border-emerald-800 bg-emerald-950 text-emerald-300'}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-zinc-200">{r.claim}</td>
                      <td className="py-2 pr-2 font-mono text-zinc-500">{r.surface}</td>
                      <td className="py-2 text-zinc-500">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            WS4 — BULLET ARCHITECTURE (advisory).

            Never a gate rule: a bullet whose declared job is unwritten, or
            whose allergen declaration leads instead of trails, is copy written
            in the wrong order, and blocking a publish over word order would be
            over-blocking — which this project treats as exactly as severe as a
            bypass. So it is shown, and the operator decides.
          */}
          {bulletLints.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <h3 className="text-sm font-medium text-zinc-200 mb-3">
                Bullet architecture — advisory ({bulletLints.length})
              </h3>
              <ul className="space-y-2">
                {bulletLints.map((g, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <SeverityBadge s={g.severity} />
                    <span className="font-mono text-zinc-400 whitespace-nowrap">{g.field}</span>
                    <span className="text-zinc-500">
                      {g.why} <span className="text-zinc-300">→ {g.proposed}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/*
            brain/02 — CANDIDATE TERMS. Condition-like vocabulary seen in the
            SOURCE listing that the lexicon does not know. A proposal for the
            lexicon owner, never a statement about this copy.
          */}
          {candidates.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-zinc-200">
                  Candidate terms for lexicon review ({candidates.length})
                </h3>
                <CopyButton text={candidates.join('\n')} label="copy terms" />
              </div>
              <p className="mb-2 text-xs text-zinc-500">
                Condition-like words found in the CURRENT listing that the compliance lexicon does not contain. They say
                nothing about the proposed copy — they are a question for whoever owns the lexicon.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((t) => (
                  <span key={t} className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/*
            WS9 — COMPETITOR BENCHMARK. Structural facts only: no rival copy
            and no rival brand name, because their framing is takedown risk
            rather than inspiration and their brand belongs on the keyword
            NEGATIVE list.
          */}
          {benchmark && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
              <h3 className="text-sm font-medium text-zinc-200 mb-3">
                Competitor benchmark — {benchmark.ingested}/{benchmark.requested} ingested
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1 pr-2">ASIN</th>
                    <th className="py-1 pr-2">Title chars</th>
                    <th className="py-1 pr-2">Bullets</th>
                    <th className="py-1 pr-2">Attributes</th>
                    <th className="py-1">A+</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { row: benchmark.subject, label: 'PROPOSED' },
                    { row: benchmark.current, label: 'CURRENT' },
                    ...benchmark.rows.map((row) => ({ row, label: '' })),
                  ].map(({ row, label }, i) => (
                    <tr key={`${row.asin}-${i}`} className="border-t border-zinc-800/60">
                      <td className="py-2 pr-2 font-mono text-zinc-300">
                        {label ? <span className="text-emerald-400">{label}</span> : row.asin}
                        {row.status === 'failed' && (
                          <span className="ml-2 text-amber-400" title={row.note}>
                            not ingested
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-2 tabular-nums text-zinc-400">{row.titleLength ?? '—'}</td>
                      <td className="py-2 pr-2 tabular-nums text-zinc-400">{row.bulletCount ?? '—'}</td>
                      <td className="py-2 pr-2 tabular-nums text-zinc-400">{row.attributeCount ?? '—'}</td>
                      <td className="py-2 text-zinc-400">
                        {row.status === 'failed' ? '—' : row.aplusPresent ? 'yes' : 'no'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
            <h3 className="text-sm font-medium text-zinc-200 mb-3">
              Gaps — current → proposed ({fieldGaps.length})
            </h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="py-1 pr-2">Sev</th>
                  <th className="py-1 pr-2">Field</th>
                  <th className="py-1 pr-2">Current</th>
                  <th className="py-1 pr-2">Proposed</th>
                  <th className="py-1">Why</th>
                </tr>
              </thead>
              <tbody>
                {fieldGaps.map((g, i) => (
                  <tr key={i} className="border-t border-zinc-800/60 align-top">
                    <td className="py-2 pr-2">
                      <SeverityBadge s={g.severity} />
                    </td>
                    <td className="py-2 pr-2 font-mono text-zinc-400 whitespace-nowrap">{g.field}</td>
                    <td className="py-2 pr-2 text-zinc-400 max-w-56">
                      {g.current === 'unknown' ? (
                        <span className="italic text-zinc-600">unknown (not publicly visible)</span>
                      ) : (
                        g.current
                      )}
                    </td>
                    <td className="py-2 pr-2 text-zinc-300 max-w-56">{g.proposed}</td>
                    <td className="py-2 text-zinc-500">{g.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
