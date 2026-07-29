'use client';

import { useState, type ReactNode } from 'react';
import { utf8Bytes } from '@/lib/shared/utf8Bytes';

export { utf8Bytes };

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? '✓ copied' : `⧉ ${label ?? 'copy'}`}
    </button>
  );
}

export function Counter({
  value,
  limit,
  unit,
}: {
  value: number;
  limit: number;
  unit: 'chars' | 'bytes';
}) {
  const over = value > limit;
  return (
    <span
      className={`text-xs tabular-nums ${over ? 'text-red-400 font-semibold' : 'text-zinc-500'}`}
    >
      {value}/{limit} {unit}
      {over ? ' — OVER' : ''}
    </span>
  );
}

export function Field({
  label,
  text,
  limit,
  unit = 'chars',
  mono = false,
  gateFailed = false,
  copyLabel,
  actions,
  note,
}: {
  label: string;
  text: string;
  limit?: number;
  unit?: 'chars' | 'bytes';
  mono?: boolean;
  /** True when the verify gate flagged this field — highlights beyond the raw counter. */
  gateFailed?: boolean;
  /** Overrides the default copy-button label (e.g. 'Copy (plain)'). */
  copyLabel?: string;
  /** Extra copy actions rendered beside the default one (e.g. the Seller Central <br> variant). */
  actions?: ReactNode;
  /** Small helper line under the header explaining a format choice. */
  note?: string;
}) {
  const count = unit === 'bytes' ? utf8Bytes(text) : text.length;
  const over = limit !== undefined && count > limit;
  return (
    <div className={`rounded-lg border bg-zinc-900 p-4 ${gateFailed || over ? 'border-red-800' : 'border-zinc-800'}`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-medium text-zinc-200">{label}</h3>
          {limit !== undefined && <Counter value={count} limit={limit} unit={unit} />}
          {gateFailed && !over && (
            <span className="text-xs text-red-400 font-medium">gate failure</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CopyButton text={text} label={copyLabel} />
          {actions}
        </div>
      </div>
      {note && <p className="mb-2 text-xs text-zinc-500">{note}</p>}
      <p className={`text-sm text-zinc-300 whitespace-pre-wrap break-words ${mono ? 'font-mono text-xs' : ''}`}>
        {text}
      </p>
    </div>
  );
}

export type StepState = 'idle' | 'running' | 'done' | 'error';

export function Steps({ steps }: { steps: { name: string; state: StepState; detail?: string }[] }) {
  const icon: Record<StepState, string> = { idle: '○', running: '◐', done: '●', error: '✕' };
  const color: Record<StepState, string> = {
    idle: 'text-zinc-600',
    running: 'text-amber-400 animate-pulse',
    done: 'text-emerald-500',
    error: 'text-red-500',
  };
  return (
    <ol className="flex flex-wrap items-center gap-4">
      {steps.map((s) => (
        <li key={s.name} className={`flex items-center gap-2 text-sm ${color[s.state]}`}>
          <span>{icon[s.state]}</span>
          <span className="text-zinc-300">{s.name}</span>
          {s.detail && <span className="text-xs text-zinc-500">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

export function SeverityBadge({ s }: { s: 'P0' | 'P1' | 'P2' }) {
  const cls =
    s === 'P0'
      ? 'bg-red-950 text-red-300 border-red-800'
      : s === 'P1'
        ? 'bg-amber-950 text-amber-300 border-amber-800'
        : 'bg-zinc-800 text-zinc-300 border-zinc-700';
  return <span className={`rounded border px-1.5 py-0.5 text-xs font-semibold ${cls}`}>{s}</span>;
}
