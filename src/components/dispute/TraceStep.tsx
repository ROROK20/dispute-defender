'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { CitationChip } from './CitationChip';

export interface TraceStepData {
  seq: number;
  kind: string;
  label: string;
  payload?: unknown;
  payload_json?: string | null;
  duration_ms?: number | null;
  created_at: string;
}

const KIND_STYLE: Record<string, { dot: string; tag: string; text: string }> = {
  info: { dot: 'bg-slate-400', tag: 'info', text: 'text-slate-600' },
  tool_call: { dot: 'bg-teal-600', tag: 'tool', text: 'text-teal-800' },
  tool_result: { dot: 'bg-teal-300', tag: 'result', text: 'text-slate-700' },
  check: { dot: 'bg-amber-500', tag: 'check', text: 'text-slate-800' },
  decision: { dot: 'bg-green-600', tag: 'decision', text: 'text-green-800' },
  review: { dot: 'bg-slate-600', tag: 'review', text: 'text-slate-800' },
  error: { dot: 'bg-red-600', tag: 'error', text: 'text-red-700' },
};

function resolvePayload(step: TraceStepData): unknown {
  if (step.payload !== undefined && step.payload !== null) {
    if (typeof step.payload === 'string') {
      try {
        return JSON.parse(step.payload);
      } catch {
        return step.payload;
      }
    }
    return step.payload;
  }
  if (step.payload_json) {
    try {
      return JSON.parse(step.payload_json);
    } catch {
      return step.payload_json;
    }
  }
  return null;
}

function collectSourceKeys(payload: unknown): string[] {
  const keys = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((k === 'source_key' || k === 'source_keys' || k === 'source_ids') && val) {
          const list = Array.isArray(val) ? val : [val];
          list.forEach((s) => {
            if (typeof s === 'string' && /^S\d+$/.test(s)) keys.add(s);
          });
        } else {
          visit(val, depth + 1);
        }
      }
    }
  };
  visit(payload, 0);
  return [...keys].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface TraceStepProps {
  step: TraceStepData;
  onSourceClick?: (key: string) => void;
  activeSourceKey?: string | null;
}

export function TraceStep({ step, onSourceClick, activeSourceKey }: TraceStepProps) {
  const [open, setOpen] = useState(false);
  const payload = useMemo(() => resolvePayload(step), [step]);
  const sourceKeys = useMemo(() => collectSourceKeys(payload), [payload]);
  const style = KIND_STYLE[step.kind] ?? KIND_STYLE.info;
  const hasPayload = payload !== null && payload !== undefined && payload !== '';

  return (
    <li className="relative pl-6">
      <span aria-hidden className={clsx('absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white', style.dot)} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[11px] tabular-nums text-slate-400">#{step.seq}</span>
        <span className="rounded bg-slate-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {style.tag}
        </span>
        <span className={clsx('text-sm', style.text, step.kind === 'error' && 'font-semibold')}>{step.label}</span>
        {typeof step.duration_ms === 'number' ? (
          <span className="font-mono text-[11px] tabular-nums text-slate-400">{step.duration_ms} ms</span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-slate-400">{formatTime(step.created_at)}</span>
      </div>
      {sourceKeys.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-0.5">
          {sourceKeys.map((k) => (
            <CitationChip key={k} sourceKey={k} active={activeSourceKey === k} onClick={onSourceClick} />
          ))}
        </div>
      ) : null}
      {hasPayload ? (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="text-xs text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
          >
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open ? (
            <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              {typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default TraceStep;