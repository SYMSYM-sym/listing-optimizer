'use client';

import { useCallback, useState } from 'react';
import type { IngestError, ListingSnapshot } from '@/lib/types';
import { Steps, type StepState } from './ui';
import { ResultsPanel, type ResultsModel } from './ResultsPanel';

type Provider = 'rainforest' | 'firecrawl' | 'paste';
type View = 'optimize' | 'history';

interface RunListItem {
  id: string;
  created_at: string;
  asin: string;
  product_name: string;
  verified: boolean;
  score: number;
  gaps: number;
  failure_ids: string[];
}

export default function Home() {
  const [view, setView] = useState<View>('optimize');
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
  const [result, setResult] = useState<ResultsModel | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  // History state
  const [historyItems, setHistoryItems] = useState<RunListItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [asinFilter, setAsinFilter] = useState('');
  const [historyResult, setHistoryResult] = useState<ResultsModel | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { 'x-app-token': token } : {}),
  };

  const loadHistory = useCallback(
    async (asin?: string) => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const q = new URLSearchParams({ limit: '50', offset: '0' });
        if (asin?.trim()) q.set('asin', asin.trim());
        const res = await fetch(`/api/runs?${q}`, { headers });
        if (!res.ok) {
          const e = (await res.json()) as { code?: string; message?: string };
          setHistoryError(`${e.code ?? 'ERROR'}: ${e.message ?? 'Failed to load history'}`);
          setHistoryItems([]);
          return;
        }
        const body = (await res.json()) as { runs: RunListItem[] };
        setHistoryItems(body.runs ?? []);
      } catch (e) {
        setHistoryError(e instanceof Error ? e.message : 'Failed to load history');
        setHistoryItems([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    // headers object identity changes each render — token is the real dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  async function openHistory() {
    setView('history');
    setHistoryResult(null);
    await loadHistory(asinFilter);
  }

  async function openRun(id: string) {
    setLoadingRunId(id);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/runs/${id}`, { headers });
      if (!res.ok) {
        const e = (await res.json()) as { code?: string; message?: string };
        setHistoryError(`${e.code ?? 'ERROR'}: ${e.message ?? 'Failed to load run'}`);
        return;
      }
      const body = (await res.json()) as {
        run: {
          id: string;
          snapshot: ListingSnapshot;
          optimized: ResultsModel['optimized'];
          audit: ResultsModel['audit'];
          pack_id: string;
        };
      };
      const run = body.run;
      setHistoryResult({
        optimized: run.optimized,
        audit: run.audit,
        detection: { packId: run.pack_id, subcategories: run.snapshot.subcategory ?? [] },
        snapshot: run.snapshot,
        runId: run.id,
      });
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Failed to load run');
    } finally {
      setLoadingRunId(null);
    }
  }

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
      const r = (await optRes.json()) as ResultsModel & { iterations: number; runId?: string | null };
      setOptimizeState('done');
      setVerifyState(r.audit.verified ? 'done' : 'error');
      setAuditState('done');
      // Keep snapshot so per-section Regenerate works on the live run
      setResult({
        optimized: r.optimized,
        audit: r.audit,
        detection: r.detection,
        iterations: r.iterations,
        snapshot,
        runId: r.runId ?? null,
      });
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

  const verified = result?.audit.verified ?? false;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 pb-24">
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold tracking-tight">Listing Optimizer</h1>
            <nav className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={() => setView('optimize')}
                className={`rounded-md px-3 py-1.5 ${view === 'optimize' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Optimize
              </button>
              <button
                type="button"
                onClick={() => void openHistory()}
                className={`rounded-md px-3 py-1.5 ${view === 'history' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                History
              </button>
            </nav>
          </div>
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
        {view === 'optimize' && (
          <>
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
                  Optimize fans out 8 LLM groups in parallel, then may run up to a few repair rounds. Typical wall-clock
                  is 1–3 minutes — the timer above shows progress while you wait.
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
                    <button
                      onClick={() => setPasteMode('html')}
                      className={`rounded px-2 py-1 border ${pasteMode === 'html' ? 'border-emerald-600 text-emerald-300' : 'border-zinc-800 text-zinc-400'}`}
                    >
                      page source HTML
                    </button>
                    <button
                      onClick={() => setPasteMode('manual')}
                      className={`rounded px-2 py-1 border ${pasteMode === 'manual' ? 'border-emerald-600 text-emerald-300' : 'border-zinc-800 text-zinc-400'}`}
                    >
                      manual fields
                    </button>
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
                      <input
                        value={manual.title}
                        onChange={(e) => setManual({ ...manual, title: e.target.value })}
                        placeholder="Product title"
                        className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                      />
                      <textarea
                        value={manual.bullets}
                        onChange={(e) => setManual({ ...manual, bullets: e.target.value })}
                        placeholder="Bullets — one per line"
                        rows={4}
                        className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                      />
                      <textarea
                        value={manual.description}
                        onChange={(e) => setManual({ ...manual, description: e.target.value })}
                        placeholder="Description"
                        rows={3}
                        className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                      />
                      <input
                        value={manual.category}
                        onChange={(e) => setManual({ ...manual, category: e.target.value })}
                        placeholder="Category (e.g. Health & Household > Vitamins & Dietary Supplements > Probiotics)"
                        className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                      />
                    </div>
                  )}
                </div>
              )}
              <Steps
                steps={[
                  { name: 'Ingest', state: ingestState },
                  {
                    name: 'Optimize',
                    state: optimizeState,
                    detail: result ? `${result.iterations ?? 0} repair round(s)` : undefined,
                  },
                  {
                    name: 'Verify gate',
                    state: verifyState,
                    detail: result
                      ? verified
                        ? 'PASS'
                        : `${result.audit.gateResult.failures.length} failures`
                      : undefined,
                  },
                  { name: 'Audit', state: auditState },
                ]}
              />
              {error && (
                <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                  {error}
                  {suggestPaste && (
                    <span className="block mt-1 text-red-200">
                      Tip: switch ingestion to <b>paste</b> and supply the page source or manual fields.
                    </span>
                  )}
                </div>
              )}
            </section>

            {result && (
              <ResultsPanel result={result} headers={headers} onUpdated={setResult} />
            )}
          </>
        )}

        {view === 'history' && (
          <>
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-200 tracking-wide uppercase">Run history</h2>
                <div className="flex gap-2">
                  <input
                    value={asinFilter}
                    onChange={(e) => setAsinFilter(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void loadHistory(asinFilter)}
                    placeholder="Filter by ASIN"
                    className="w-40 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void loadHistory(asinFilter)}
                    disabled={historyLoading}
                    className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    {historyLoading ? 'Loading…' : 'Search'}
                  </button>
                </div>
              </div>

              {historyError && (
                <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-sm text-red-300">
                  {historyError}
                </div>
              )}

              {!historyLoading && historyItems.length === 0 && !historyError && (
                <p className="text-sm text-zinc-500">
                  No saved runs yet. If the run store is not configured on the server, optimize still works but History
                  stays empty until the server-side Supabase URL and service role key are set.
                </p>
              )}

              {historyItems.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-zinc-500 border-b border-zinc-800">
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Product</th>
                        <th className="py-2 pr-3">ASIN</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyItems.map((item) => (
                        <tr
                          key={item.id}
                          className={`border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-800/40 ${historyResult?.runId === item.id ? 'bg-zinc-800/50' : ''}`}
                          onClick={() => void openRun(item.id)}
                        >
                          <td className="py-2.5 pr-3 text-zinc-400 whitespace-nowrap">
                            {new Date(item.created_at).toLocaleString()}
                            {loadingRunId === item.id && <span className="ml-2 text-amber-400">…</span>}
                          </td>
                          <td className="py-2.5 pr-3 text-zinc-200 max-w-xs truncate">{item.product_name || '—'}</td>
                          <td className="py-2.5 pr-3 font-mono text-zinc-400">{item.asin}</td>
                          <td className="py-2.5 pr-3">
                            {item.verified ? (
                              <span className="text-emerald-400">Verified</span>
                            ) : (
                              <span className="text-red-400">Blocked</span>
                            )}
                            {item.gaps > 0 && <span className="ml-1 text-zinc-600">· {item.gaps} gaps</span>}
                          </td>
                          <td className="py-2.5 tabular-nums text-zinc-300">{item.score}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {historyResult && (
              <>
                <button
                  type="button"
                  onClick={() => setHistoryResult(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  ← Back to list
                </button>
                <ResultsPanel result={historyResult} headers={headers} onUpdated={setHistoryResult} />
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
