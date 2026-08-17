'use client';

import { useCallback, useState } from 'react';
import type { IngestError, ListingSnapshot } from '@/lib/types';
import rules from '@/knowledge/rules.json';
import {
  buildOperatorInputs,
  EMPTY_OPERATOR_INPUTS,
  MAX_COMPETITOR_ASINS,
  parseCompetitorAsins,
  type OperatorInputForm,
} from './operatorInputs';
import { Steps, type StepState } from './ui';
import { ResultsPanel, type ResultsModel } from './ResultsPanel';
import { openShipSheet } from './shipSheetClient';

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
  /** WS6 — set once the operator records the run as published. */
  published_at?: string | null;
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
  /**
   * The four OPTIONAL per-run operator inputs (WS9 reviews + competitors,
   * R45 fiction phrases, WS5.5 confirmed panel). All four already existed on
   * the API and had no way in; none of them is required, and leaving the
   * section closed sends exactly the body that was sent before it existed.
   */
  const [operatorInputs, setOperatorInputs] = useState<OperatorInputForm>(EMPTY_OPERATOR_INPUTS);
  const [showOperatorInputs, setShowOperatorInputs] = useState(false);
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
  const [publishingRunId, setPublishingRunId] = useState<string | null>(null);

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

  /**
   * WS6 — record a run as PUBLISHED.
   *
   * The button is only rendered for a VERIFIED, not-yet-published run, and the
   * route enforces the same rule server-side from the stored `audit.verified`
   * — the UI condition is a courtesy, never the guard.
   */
  async function publishRun(id: string) {
    setPublishingRunId(id);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/runs/${id}/publish`, { method: 'POST', headers });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        setHistoryError(`${e.code ?? 'ERROR'}: ${e.message ?? 'Publish failed'}`);
        return;
      }
      await loadHistory(asinFilter);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setPublishingRunId(null);
    }
  }

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
      const optRes = await fetch('/api/optimize', {
        method: 'POST',
        headers,
        // Untouched optional fields contribute NO key — see ./operatorInputs.
        body: JSON.stringify({ snapshot, ...buildOperatorInputs(operatorInputs) }),
      });
      if (!optRes.ok) {
        const e = (await optRes.json()) as { code: string; message: string };
        setOptimizeState('error');
        setVerifyState('error');
        setAuditState('error');
        setError(`${e.code}: ${e.message}`);
        return;
      }
      const r = (await optRes.json()) as ResultsModel & {
        iterations: number;
        runId?: string | null;
        /**
         * U1 — present ONLY when a call to the model API actually failed. The
         * route already sent it; until now nothing carried it into the panel,
         * so a run that degraded because the upstream API was down or unpaid
         * rendered as a wall of gate failures with no statement of cause.
         */
        generationFailure?: ResultsModel['generationFailure'];
      };
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
        generationFailure: r.generationFailure ?? null,
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
  const acceptedCompetitors = parseCompetitorAsins(operatorInputs.competitorAsins);
  const operatorInputBody = buildOperatorInputs(operatorInputs);
  /** What the closed panel advertises — counts only, never the operator's text. */
  const operatorInputSummary = [
    operatorInputBody.reviewsText ? 'reviews' : '',
    operatorInputBody.competitorAsins ? `${operatorInputBody.competitorAsins.length} competitor(s)` : '',
    operatorInputBody.fictionPhrases ? `${operatorInputBody.fictionPhrases.length} phrase(s)` : '',
    operatorInputBody.panelFacts ? `${Object.keys(operatorInputBody.panelFacts).length} panel value(s)` : '',
  ].filter(Boolean);

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
              {/*
                OPTIONAL OPERATOR INPUTS (WS9 / R45 / WS5.5).

                Collapsed by default and empty by default: a run that ignores
                this panel sends the same body it always did. Every control
                writes into one `OperatorInputForm`, and `buildOperatorInputs`
                decides what — if anything — reaches the request.
              */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60">
                <button
                  type="button"
                  aria-expanded={showOperatorInputs}
                  onClick={() => setShowOperatorInputs((v) => !v)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <span>
                    {showOperatorInputs ? '▾' : '▸'} Optional operator inputs
                    <span className="ml-2 text-zinc-600">
                      reviews · competitors · known-false phrases · confirmed panel
                    </span>
                  </span>
                  {operatorInputSummary.length > 0 && (
                    <span className="rounded bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-[11px] text-emerald-300">
                      {operatorInputSummary.join(' · ')}
                    </span>
                  )}
                </button>
                {showOperatorInputs && (
                  <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                    <div>
                      <label className="mb-1 block text-xs text-zinc-300" htmlFor="op-reviews">
                        Customer reviews — paste (optional)
                      </label>
                      <p className="mb-2 text-xs text-zinc-500">
                        Mined for COMPLIANT buyer phrasing only, through the gate&rsquo;s own lexicons; never copied
                        verbatim. Leaving it empty leaves principle P11 unscored rather than scoring it zero.
                      </p>
                      <textarea
                        id="op-reviews"
                        value={operatorInputs.reviewsText}
                        onChange={(e) => setOperatorInputs({ ...operatorInputs, reviewsText: e.target.value })}
                        placeholder="Paste review text — one review per block is fine"
                        rows={4}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs placeholder:text-zinc-600 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-zinc-300" htmlFor="op-competitors">
                        Competitor ASINs — up to {MAX_COMPETITOR_ASINS} (optional)
                      </label>
                      <p className="mb-2 text-xs text-zinc-500">
                        Bare ASINs or product URLs, separated by spaces, commas or newlines. Each one is a paid
                        ingestion call; a competitor that cannot be ingested is reported as failed and never loses the
                        run.
                      </p>
                      <input
                        id="op-competitors"
                        value={operatorInputs.competitorAsins}
                        onChange={(e) => setOperatorInputs({ ...operatorInputs, competitorAsins: e.target.value })}
                        placeholder="B0XXXXXXXX, B0YYYYYYYY"
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs placeholder:text-zinc-600 focus:outline-none"
                      />
                      {operatorInputs.competitorAsins.trim() !== '' && (
                        <p className="mt-1 text-xs text-zinc-500">
                          accepted:{' '}
                          {acceptedCompetitors.length > 0 ? (
                            <span className="font-mono text-zinc-300">{acceptedCompetitors.join(', ')}</span>
                          ) : (
                            <span className="text-amber-400">none — an ASIN is 10 characters, or paste the product URL</span>
                          )}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-zinc-300" htmlFor="op-fiction">
                        Known-false / superseded claims — one per line (optional)
                      </label>
                      <p className="mb-2 text-xs text-zinc-500">
                        Descriptors you KNOW are false for this product: an invented blend name, a retired count, a
                        claim that keeps coming back from someone&rsquo;s paste buffer. They are added to the gate&rsquo;s
                        own list for this run only — an operator input can only ever make the gate stricter, and nothing
                        here is saved.
                      </p>
                      <textarea
                        id="op-fiction"
                        value={operatorInputs.fictionPhrases}
                        onChange={(e) => setOperatorInputs({ ...operatorInputs, fictionPhrases: e.target.value })}
                        placeholder={'clinically formulated blend\ntriple-strength complex'}
                        rows={3}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs placeholder:text-zinc-600 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-zinc-300" htmlFor="op-panel">
                        {rules.operatorPanel?.inputLabel ?? 'Confirm label values (optional)'}
                      </label>
                      <p className="mb-2 text-xs text-zinc-500">{rules.operatorPanel?.inputHelp}</p>
                      <textarea
                        id="op-panel"
                        value={operatorInputs.panelFacts}
                        onChange={(e) => setOperatorInputs({ ...operatorInputs, panelFacts: e.target.value })}
                        placeholder={'serving_size: 1 Capsule\nunit_count: 60 Count\nmaximum_dosage: 50 Billion CFU'}
                        rows={4}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs placeholder:text-zinc-600 focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

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
              <ResultsPanel
                result={result}
                headers={headers}
                onUpdated={setResult}
                operatorInputs={operatorInputs}
              />
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
                        <th className="py-2 pr-3">Score</th>
                        <th className="py-2">Sheet</th>
                        <th className="py-2 pl-3">Publish</th>
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
                            {item.published_at ? (
                              <span
                                className="text-sky-300"
                                title={`Published ${new Date(item.published_at).toLocaleString()}`}
                              >
                                Published
                              </span>
                            ) : item.verified ? (
                              <span className="text-emerald-400">Verified</span>
                            ) : (
                              <span className="text-red-400">Blocked</span>
                            )}
                            {item.gaps > 0 && <span className="ml-1 text-zinc-600">· {item.gaps} gaps</span>}
                          </td>
                          <td className="py-2.5 pr-3 tabular-nums text-zinc-300">{item.score}</td>
                          <td className="py-2.5">
                            {/*
                              Per-row ship sheet. `stopPropagation` keeps the row's
                              open-run handler from firing as well, and the fetch
                              carries the same `x-app-token` header every other
                              history call uses — the route is behind requireAccess,
                              so a plain link would render a 401 in a new tab.
                            */}
                            <button
                              type="button"
                              title="Open the operator paste sheet for this run"
                              onClick={(e) => {
                                e.stopPropagation();
                                void openShipSheet(item.id, headers).catch((err: unknown) =>
                                  setHistoryError(err instanceof Error ? err.message : 'Ship sheet failed'),
                                );
                              }}
                              className="rounded-md border border-amber-800 bg-amber-950/50 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/50"
                            >
                              ⧉ Ship Sheet
                            </button>
                          </td>
                          <td className="py-2.5 pl-3">
                            {item.published_at ? (
                              <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                                {new Date(item.published_at).toLocaleDateString()}
                              </span>
                            ) : item.verified ? (
                              <button
                                type="button"
                                title="Record this run as published — only a verified run can be published"
                                disabled={publishingRunId === item.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void publishRun(item.id);
                                }}
                                className="rounded-md border border-sky-800 bg-sky-950/50 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-900/50 disabled:opacity-40"
                              >
                                {publishingRunId === item.id ? '…' : 'Mark published'}
                              </button>
                            ) : (
                              <span
                                className="text-[11px] text-zinc-600"
                                title="A run that failed the gate cannot be recorded as published"
                              >
                                —
                              </span>
                            )}
                          </td>
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
