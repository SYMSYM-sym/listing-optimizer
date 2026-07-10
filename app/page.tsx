'use client';

import { useState } from 'react';
import rules from '@/knowledge/rules.json';
import type { Audit, Failure, IngestError, ListingSnapshot, OptimizedListing } from '@/lib/types';
import { toMarkdown } from '@/lib/export/markdown';
import { CopyButton, Field, SeverityBadge, Steps, type StepState } from './ui';

type Provider = 'rainforest' | 'firecrawl' | 'paste';
type Tab = 'listing' | 'aplus' | 'images' | 'qa' | 'audit';

interface RunResult {
  optimized: OptimizedListing;
  audit: Audit;
  detection: { packId: string; subcategories: string[] };
  iterations: number;
}

/** True when the verify gate flagged this listing field (exact or indexed, e.g. bullets[2]). */
function gateFailedOn(failures: Failure[], field: string): boolean {
  return failures.some(
    (f) => f.field === field || f.field.startsWith(`${field}[`) || f.field.startsWith(`${field}.`),
  );
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState<Provider>('rainforest');
  const [pasteHtml, setPasteHtml] = useState('');
  const [manual, setManual] = useState({ title: '', bullets: '', description: '', category: '' });
  const [pasteMode, setPasteMode] = useState<'html' | 'manual'>('html');
  const [token, setToken] = useState('');
  const [ingestState, setIngestState] = useState<StepState>('idle');
  const [optimizeState, setOptimizeState] = useState<StepState>('idle');
  const [verifyState, setVerifyState] = useState<StepState>('idle');
  const [auditState, setAuditState] = useState<StepState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [suggestPaste, setSuggestPaste] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [tab, setTab] = useState<Tab>('listing');
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { 'x-app-token': token } : {}),
  };

  async function run() {
    setError(null);
    setSuggestPaste(false);
    setResult(null);
    setRunning(true);
    setElapsedSec(0);
    const tick = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    setIngestState('running');
    setOptimizeState('idle');
    setVerifyState('idle');
    setAuditState('idle');
    try {
      const body: Record<string, unknown> = { url };
      if (provider === 'paste') {
        if (pasteMode === 'html') body.pasteHtml = pasteHtml;
        else
          body.manualFields = {
            title: manual.title,
            bullets: manual.bullets.split('\n').filter(Boolean),
            description: manual.description,
            category: manual.category,
          };
      }
      const ingestRes = await fetch('/api/ingest', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!ingestRes.ok) {
        const e = (await ingestRes.json()) as IngestError;
        setIngestState('error');
        setError(`${e.code}: ${e.message}`);
        setSuggestPaste(Boolean(e.suggestPaste));
        return;
      }
      const snapshot = (await ingestRes.json()) as ListingSnapshot;
      setIngestState('done');
      setOptimizeState('running');
      setVerifyState('running');
      setAuditState('running');
      const optRes = await fetch('/api/optimize', { method: 'POST', headers, body: JSON.stringify({ snapshot }) });
      if (!optRes.ok) {
        const e = (await optRes.json()) as { code: string; message: string };
        setOptimizeState('error');
        setVerifyState('error');
        setAuditState('error');
        setError(`${e.code}: ${e.message}`);
        return;
      }
      const r = (await optRes.json()) as RunResult;
      setOptimizeState('done');
      setVerifyState(r.audit.verified ? 'done' : 'error');
      setAuditState('done');
      setResult(r);
      setTab('listing');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected failure');
      setIngestState((s) => (s === 'running' ? 'error' : s));
      setOptimizeState((s) => (s === 'running' ? 'error' : s));
      setVerifyState((s) => (s === 'running' ? 'error' : s));
      setAuditState((s) => (s === 'running' ? 'error' : s));
    } finally {
      window.clearInterval(tick);
      setRunning(false);
    }
  }

  function downloadMarkdown() {
    if (!result) return;
    const md = toMarkdown(result.optimized, result.audit);
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `listing-${result.optimized.productName.replace(/\W+/g, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const verified = result?.audit.verified ?? false;
  const gateFailures = result?.audit.gateResult.failures ?? [];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 pb-24">
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Listing Optimizer</h1>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="access token (if set)"
            className="w-44 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs placeholder:text-zinc-600 focus:outline-none"
          />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 pt-8 space-y-6">
        {/* Input */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="flex gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !running && run()}
              placeholder="https://www.amazon.com/dp/B0XXXXXXXX"
              className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-sm placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            <button
              onClick={run}
              disabled={running}
              className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 transition-colors"
            >
              {running ? `Running… ${elapsedSec}s` : 'Optimize'}
            </button>
          </div>
          {running && (
            <p className="text-xs text-zinc-500">
              Optimize fans out 8 LLM groups in parallel, then may run up to a few repair rounds. Typical wall-clock is 1–3 minutes — the timer above shows progress while you wait.
            </p>
          )}
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Ingestion:</span>
            {(['rainforest', 'firecrawl', 'paste'] as Provider[]).map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className={`rounded-full border px-3 py-1 transition-colors ${provider === p ? 'border-emerald-600 bg-emerald-950 text-emerald-300' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'}`}
              >
                {p}
              </button>
            ))}
            <span className="ml-2 text-zinc-600">
              server uses its configured provider; choose paste to supply the page yourself
            </span>
          </div>
          {provider === 'paste' && (
            <div className="space-y-3">
              <div className="flex gap-2 text-xs">
                <button onClick={() => setPasteMode('html')} className={`rounded px-2 py-1 border ${pasteMode === 'html' ? 'border-emerald-600 text-emerald-300' : 'border-zinc-800 text-zinc-400'}`}>page source HTML</button>
                <button onClick={() => setPasteMode('manual')} className={`rounded px-2 py-1 border ${pasteMode === 'manual' ? 'border-emerald-600 text-emerald-300' : 'border-zinc-800 text-zinc-400'}`}>manual fields</button>
              </div>
              {pasteMode === 'html' ? (
                <textarea
                  value={pasteHtml}
                  onChange={(e) => setPasteHtml(e.target.value)}
                  placeholder="View the product page source (Ctrl+U), select all, paste here (≤4MB)"
                  rows={5}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
                />
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  <input value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} placeholder="Product title" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm" />
                  <textarea value={manual.bullets} onChange={(e) => setManual({ ...manual, bullets: e.target.value })} placeholder="Bullets — one per line" rows={4} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm" />
                  <textarea value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} placeholder="Description" rows={3} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm" />
                  <input value={manual.category} onChange={(e) => setManual({ ...manual, category: e.target.value })} placeholder="Category (e.g. Health & Household > Vitamins & Dietary Supplements > Probiotics)" className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm" />
                </div>
              )}
            </div>
          )}
          <Steps
            steps={[
              { name: 'Ingest', state: ingestState },
              { name: 'Optimize', state: optimizeState, detail: result ? `${result.iterations} repair round(s)` : undefined },
              { name: 'Verify gate', state: verifyState, detail: result ? (verified ? 'PASS' : `${result.audit.gateResult.failures.length} failures`) : undefined },
              { name: 'Audit', state: auditState },
            ]}
          />
          {error && (
            <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
              {suggestPaste && <span className="block mt-1 text-red-200">Tip: switch ingestion to <b>paste</b> and supply the page source or manual fields.</span>}
            </div>
          )}
        </section>

        {result && (
          <>
            {/* Status + export bar */}
            <section className={`rounded-xl border p-4 flex flex-wrap items-center justify-between gap-3 ${verified ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}`}>
              <div className="text-sm">
                {verified ? (
                  <span className="text-emerald-300 font-medium">✅ Verified — all gate checks passed ({result.detection.packId} pack{result.detection.subcategories.length > 0 ? `: ${result.detection.subcategories.join(', ')}` : ''})</span>
                ) : (
                  <span className="text-red-300 font-medium">⛔ Not verified — {result.audit.gateResult.failures.length} blocking failure(s). Export-final is locked; see the Audit tab.</span>
                )}
                {result.detection.packId === 'generic' && (
                  <span className="ml-2 rounded bg-amber-950 border border-amber-800 px-2 py-0.5 text-xs text-amber-300">compliance not evaluated for this category</span>
                )}
              </div>
              <div className="flex gap-2">
                <CopyButton text={JSON.stringify({ optimized: result.optimized, audit: result.audit }, null, 2)} label="copy all as JSON" />
                <button onClick={downloadMarkdown} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700">↓ download Markdown</button>
                <button
                  disabled={!verified}
                  title={verified ? 'Marks the export as final' : 'Blocked: the verify gate is failing — a listing that fails the gate is never exported as final'}
                  className="rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed border-emerald-700 bg-emerald-900/60 text-emerald-200"
                  onClick={downloadMarkdown}
                >
                  ⬇ export final
                </button>
              </div>
            </section>

            {/* Tabs */}
            <nav className="flex gap-1 border-b border-zinc-800">
              {(
                [
                  ['listing', 'Listing'],
                  ['aplus', 'A+ Content'],
                  ['images', 'Images'],
                  ['qa', 'Q&A'],
                  ['audit', `Audit (${result.audit.scorecard.total}/100)`],
                ] as [Tab, string][]
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
                <Field label="Title — legacy" text={result.optimized.title} limit={rules.titleMaxLegacy} gateFailed={gateFailedOn(gateFailures, 'title')} />
                <Field label="Title 75 — primary (policy eff. Jul 27 2026)" text={result.optimized.title75} limit={rules.title75Max} gateFailed={gateFailedOn(gateFailures, 'title75')} />
                <Field label="Item Highlights (searchable; enter when your template supports it)" text={result.optimized.itemHighlights} limit={rules.itemHighlightsMax} gateFailed={gateFailedOn(gateFailures, 'itemHighlights')} />
                {result.optimized.bullets.map((b, i) => (
                  <Field key={i} label={`Bullet ${i + 1}${result.optimized.bulletAnchors?.[i] ? ` — ${result.optimized.bulletAnchors[i]}` : ''}`} text={b} limit={rules.bulletMax} gateFailed={gateFailedOn(gateFailures, `bullets[${i}]`)} />
                ))}
                <Field label="Description" text={result.optimized.description} limit={rules.descriptionMax} gateFailed={gateFailedOn(gateFailures, 'description')} />
                <Field label="Backend search terms" text={result.optimized.backendSearchTerms} limit={rules.backendMaxBytes} unit="bytes" mono gateFailed={gateFailedOn(gateFailures, 'backendSearchTerms')} />
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-zinc-200">Attributes ({Object.keys(result.optimized.attributes).length})</h3>
                    <CopyButton text={JSON.stringify(result.optimized.attributes, null, 2)} label="copy all" />
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {Object.entries(result.optimized.attributes).map(([k, v]) => (
                        <tr key={k} className="border-t border-zinc-800/60">
                          <td className="py-1.5 pr-3 font-mono text-zinc-400 align-top whitespace-nowrap">{k}</td>
                          <td className="py-1.5 text-zinc-300">{v}</td>
                          <td className="py-1.5 pl-2 text-right"><CopyButton text={v} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {tab === 'aplus' && (
              <section className="space-y-4">
                {result.optimized.aplusContent.modules.map((m) => (
                  <div key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-zinc-200">[{m.id}] {m.headline} {m.claimBearing && <span className="text-xs text-amber-400">claim-bearing</span>}</h3>
                      <CopyButton text={`${m.headline}\n\n${m.body}${m.subcopy ? `\n\n${m.subcopy}` : ''}`} />
                    </div>
                    <p className="text-sm text-zinc-300 whitespace-pre-wrap">{m.body}</p>
                    {m.subcopy && <p className="mt-2 text-xs text-zinc-500 italic">{m.subcopy}</p>}
                  </div>
                ))}
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-zinc-200">Comparison</h3>
                    <CopyButton text={result.optimized.aplusContent.comparison.rows.map((r) => `${r.label}: ${r.ours} | typical: ${r.typical}`).join('\n')} />
                  </div>
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-zinc-500"><th className="py-1"></th><th className="py-1">Ours</th><th className="py-1">Typical</th></tr></thead>
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
                      <div><p className="text-sm text-zinc-200 font-medium">Q: {f.q}</p><p className="text-sm text-zinc-400 whitespace-pre-wrap">A: {f.a}</p></div>
                      <CopyButton text={`Q: ${f.q}\nA: ${f.a}`} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {tab === 'images' && (
              <section className="grid gap-4 sm:grid-cols-2">
                {result.optimized.imagePlan.map((s) => (
                  <div key={s.slot} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-medium text-zinc-200">Slot {s.slot} — {s.purpose}</h3>
                      <CopyButton text={`${s.purpose}\nSpec: ${s.spec}\nNotes: ${s.notes}`} />
                    </div>
                    <p className="text-xs text-zinc-400">{s.spec}</p>
                    <p className="mt-1 text-xs text-zinc-500">{s.notes}</p>
                  </div>
                ))}
              </section>
            )}

            {tab === 'qa' && (
              <section className="space-y-3">
                {result.optimized.qa.map((f, i) => (
                  <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-zinc-200">Q: {f.q} {f.claimBearing && <span className="text-xs text-amber-400">claim-bearing</span>}</p>
                      <p className="mt-1 text-sm text-zinc-400 whitespace-pre-wrap">A: {f.a}</p>
                    </div>
                    <CopyButton text={`Q: ${f.q}\nA: ${f.a}`} />
                  </div>
                ))}
              </section>
            )}

            {tab === 'audit' && (
              <section className="space-y-5">
                <div className={`rounded-lg border p-4 ${verified ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-900 bg-red-950/30'}`}>
                  <h3 className="text-sm font-semibold mb-2">{verified ? '✅ Verify gate: PASS' : `⛔ Verify gate: ${result.audit.gateResult.failures.length} blocking failure(s)`}</h3>
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
                  <h3 className="text-sm font-medium text-zinc-200 mb-3">Current listing vs optimization principles — {result.audit.scorecard.total}/100</h3>
                  <ul className="space-y-1.5">
                    {result.audit.scorecard.perPrinciple.map((p) => (
                      <li key={p.id} className="text-xs flex gap-2">
                        <span className={`w-14 shrink-0 font-mono ${p.score === 'full' ? 'text-emerald-400' : p.score === 'partial' ? 'text-amber-400' : p.score === 'none' ? 'text-red-400' : 'text-zinc-600'}`}>{p.id} {p.score === 'unknown' ? '—' : p.score}</span>
                        <span className="text-zinc-400">{p.rationale}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 overflow-x-auto">
                  <h3 className="text-sm font-medium text-zinc-200 mb-3">Gaps — current → proposed ({result.audit.gaps.length})</h3>
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-zinc-500"><th className="py-1 pr-2">Sev</th><th className="py-1 pr-2">Field</th><th className="py-1 pr-2">Current</th><th className="py-1 pr-2">Proposed</th><th className="py-1">Why</th></tr></thead>
                    <tbody>
                      {result.audit.gaps.map((g, i) => (
                        <tr key={i} className="border-t border-zinc-800/60 align-top">
                          <td className="py-2 pr-2"><SeverityBadge s={g.severity} /></td>
                          <td className="py-2 pr-2 font-mono text-zinc-400 whitespace-nowrap">{g.field}</td>
                          <td className="py-2 pr-2 text-zinc-400 max-w-56">{g.current === 'unknown' ? <span className="italic text-zinc-600">unknown (not publicly visible)</span> : g.current}</td>
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
        )}
      </div>
    </main>
  );
}
