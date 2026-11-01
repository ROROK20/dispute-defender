'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CustomCellRendererProps } from 'ag-grid-react';
import clsx from 'clsx';
import { useDisputeStream, type StepKind } from '../../hooks/useDisputeStream';
import type { GridRow } from './DisputeGrid';

const KIND_STYLES: Record<StepKind, { label: string; className: string }> = {
  info: { label: 'info', className: 'bg-stone-100 text-stone-600' },
  tool_call: { label: 'tool', className: 'bg-teal-50 text-teal-800' },
  tool_result: { label: 'result', className: 'bg-teal-50 text-teal-700' },
  check: { label: 'check', className: 'bg-stone-100 text-stone-800' },
  decision: { label: 'decision', className: 'bg-teal-700 text-white' },
  review: { label: 'review', className: 'bg-stone-100 text-stone-700' },
  error: { label: 'error', className: 'bg-red-50 text-red-700' },
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  draft_ready: 'Draft ready for approval',
  failed: 'Failed',
  submitted: 'Submitted to PayPal',
  conceded: 'Conceded',
};

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  disputeId?: string;
  runId?: string | null;
};

export default function TraceDetailRow(props: Props) {
  const disputeId = props.disputeId ?? props.data?.parentId ?? props.data?.id ?? null;
  const initialRunId = props.runId ?? props.data?.runId ?? null;
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const stream = useDisputeStream(disputeId, runId);

  async function startRun() {
    if (!disputeId) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(disputeId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as
        | { run_id?: string; error?: { code?: string; message?: string } }
        | null;
      if (!res.ok || !body?.run_id) {
        throw new Error(body?.error?.message ?? `Could not start a run (HTTP ${res.status}).`);
      }
      setRunId(body.run_id);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start a run.');
    } finally {
      setStarting(false);
    }
  }

  if (!disputeId) {
    return <div className="flex h-full items-center px-6 text-sm text-red-700">Missing dispute id for this row.</div>;
  }

  const status = stream.status ?? props.data?.latest_run?.status ?? null;

  return (
    <div className="flex h-full flex-col border-b border-stone-200 bg-stone-50/70 px-4 py-3 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-stone-900">Agent trace</span>
          {runId && <span className="font-mono text-xs text-stone-500">{runId}</span>}
          {status && (
            <span
              className={clsx(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                status === 'failed' && 'bg-red-50 text-red-700',
                (status === 'submitted' || status === 'draft_ready') && 'bg-green-50 text-green-700',
                (status === 'running' || status === 'queued') && 'bg-teal-50 text-teal-800',
                status === 'conceded' && 'bg-stone-100 text-stone-700',
              )}
            >
              {STATUS_LABEL[status] ?? status}
            </span>
          )}
          {stream.connected && (
            <span className="inline-flex items-center gap-1 text-xs text-teal-800">
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-700" /> live
            </span>
          )}
        </div>
        <Link
          href={`/disputes/${encodeURIComponent(disputeId)}`}
          className="text-xs font-semibold text-teal-700 hover:underline"
        >
          Open full dispute →
        </Link>
      </div>

      {!runId ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-2">
          <p className="text-sm text-stone-600">No agent run yet for this dispute.</p>
          <button
            type="button"
            onClick={startRun}
            disabled={starting}
            className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
          >
            {starting ? 'Starting…' : 'Start agent run'}
          </button>
          {startError && <p className="text-xs text-red-700">{startError}</p>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-stone-200 bg-white">
          {stream.steps.length === 0 ? (
            <div className="space-y-2 p-3" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-stone-100" style={{ width: `${80 - i * 15}%` }} />
              ))}
            </div>
          ) : (
            <ol className="divide-y divide-stone-100">
              {stream.steps.map((step) => {
                const style = KIND_STYLES[step.kind] ?? KIND_STYLES.info;
                return (
                  <li key={step.seq} className="flex items-start gap-3 px-3 py-1.5 text-xs">
                    <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-stone-400">{step.seq}</span>
                    <span
                      className={clsx('w-16 shrink-0 rounded px-1.5 py-0.5 text-center font-medium', style.className)}
                    >
                      {style.label}
                    </span>
                    <span
                      className={clsx('min-w-0 flex-1 break-words', step.kind === 'error' ? 'text-red-700' : 'text-stone-800')}
                    >
                      {step.label}
                    </span>
                    {step.duration_ms !== null && (
                      <span className="shrink-0 font-mono tabular-nums text-stone-400">
                        {step.duration_ms >= 1000 ? `${(step.duration_ms / 1000).toFixed(1)}s` : `${step.duration_ms}ms`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {stream.error && (
        <div className="mt-2 flex items-center gap-2 text-xs text-red-700">
          <span>{stream.error}</span>
          <button type="button" onClick={stream.reconnect} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

export { TraceDetailRow };