'use client';

import { useState } from 'react';
import rules from '@/knowledge/rules.json';
import type { Audit, Failure, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { toMarkdown } from '@/lib/export/markdown';
import type { GroupName } from '@/lib/engine/optimize';
import { CopyButton, Field, SeverityBadge } from './ui';

export type ResultsTab = 'listing' | 'aplus' | 'images' | 'qa' | 'audit';

export interface ResultsModel {
  optimized: OptimizedListing;
  audit: Audit;
  detection: { packId: string; subcategories: string[] };
  iterations?: number;
  snapshot?: ListingSnapshot;
  runId?: string | null;
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
}: {
  result: ResultsModel;
  headers: HeadersInit;
  onUpdated: (next: ResultsModel) => void;
}) {
  const [tab, setTab] = useState<ResultsTab>('listing');
  const [regenerating, setRegenerating] = useState<GroupName | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);

  const verified = result.audit.verified;
  const gateFailures = result.audit.gateResult.failures;

  function downloadMarkdown() {
    const md = toMarkdown(result.optimized, result.audit);
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `listing-${result.optimized.productName.replace(/\W+/g, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
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
      };
      onUpdated({
        ...result,
        optimized: body.optimized,
        audit: body.audit,
        detection: body.detection,
      });
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : 'Regenerate failed');
    } finally {
      setRegenerating(null);
    }
  }

  const canRegen = Boolean(result.snapshot);

  return (
    <>
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
          <CopyButton text={toMarkdown(result.optimized, result.audit)} label="Copy everything as Markdown" />
          <button
            onClick={downloadMarkdown}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            ↓ download Markdown
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
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="text-sm font-medium text-zinc-200 mb-3">
              Current listing vs optimization principles — {result.audit.scorecard.total}/100
            </h3>
            <ul className="space-y-1.5">
              {result.audit.scorecard.perPrinciple.map((p) => (
                <li key={p.id} className="text-xs flex gap-2">
                  <span
                    className={`w-14 shrink-0 font-mono ${p.score === 'full' ? 'text-emerald-400' : p.score === 'partial' ? 'text-amber-400' : p.score === 'none' ? 'text-red-400' : 'text-zinc-600'}`}
                  >
                    {p.id} {p.score === 'unknown' ? '—' : p.score}
                  </span>
                  <span className="text-zinc-400">{p.rationale}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
            <h3 className="text-sm font-medium text-zinc-200 mb-3">
              Gaps — current → proposed ({result.audit.gaps.length})
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
                {result.audit.gaps.map((g, i) => (
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
